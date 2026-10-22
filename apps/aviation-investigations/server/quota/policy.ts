/**
 * Quota policy (DESIGN §7–§9): budgets, per-identity limits, lease timing, and the
 * keyed hashes that stand in for principals and network identities. Only HMACs ever
 * reach the database; raw trial ids, Google subjects and network ids stay in memory.
 */
import { createHash, createHmac } from 'node:crypto';
import type { AppConfig } from '../../shared/config.js';

export interface QuotaBudgets {
  /** All AI spend in a calendar month (UTC). */
  monthlyUsd: number;
  interactiveMonthlyUsd: number;
  /** Upper bound of the paced daily interactive allowance. */
  interactiveDailyUsd: number;
  /** Indexing and evaluation together (amendment A7). */
  ingestionMonthlyUsd: number;
  /** Fraction of the paced daily allowance anonymous trials may use. */
  anonymousShare: number;
}

export interface QuotaLimits {
  trialRequests: number;
  trialDays: number;
  accountDailyRequests: number;
  accountMonthlyRequests: number;
  newAccountDailyRequests: number;
  newAccountDays: number;
  /** Attempts per minute per principal. */
  anonymousPerMinute: number;
  accountPerMinute: number;
  /** Network backstop per normalized IP or IPv6 /64, per class of principal. */
  anonymousNetworkPerHour: number;
  anonymousNetworkPerDay: number;
  accountNetworkPerHour: number;
  accountNetworkPerDay: number;
  /** Requests in flight: per principal, in total, and anonymous in total. */
  principalInFlight: number;
  globalInFlight: number;
  anonymousInFlight: number;
}

/** Typed defaults (DESIGN §7) for the limits that are not runtime configuration. */
export const DEFAULT_RATE_LIMITS = {
  trialDays: 30,
  anonymousPerMinute: 2,
  accountPerMinute: 5,
  anonymousNetworkPerHour: 10,
  anonymousNetworkPerDay: 20,
  accountNetworkPerHour: 30,
  accountNetworkPerDay: 100,
  principalInFlight: 1,
  anonymousInFlight: 1,
} as const satisfies Partial<QuotaLimits>;

/** Total application pipeline deadline (DESIGN §8). */
export const PIPELINE_DEADLINE_MS = 60_000;
/** Lease TTL, longer than the pipeline deadline. */
export const LEASE_TTL_MS = 90_000;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** Quota buckets and the anti-abuse record outlive their window by 7 days. */
export const WINDOW_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Advisory lock serializing every money reservation (interactive, indexing, evaluation). */
export const SPEND_LOCK_KEY = 7_311_905_023;

export interface QuotaPolicy {
  budgets: QuotaBudgets;
  limits: QuotaLimits;
  leaseTtlMs: number;
  /** HMAC keys: `identity` for trial ids and Google identities, `network` for network ids. */
  secrets: { identity: string; network: string };
}

/** Configuration that would let paid requests run without a sound gate. */
export class QuotaConfigError extends Error {
  override readonly name = 'QuotaConfigError';
}

/** A malformed call: bad key, hash, amount or principal. Not a quota decision. */
export class QuotaInputError extends Error {
  override readonly name = 'QuotaInputError';
}

/** The trial identity does not exist or has expired; the caller must start a new trial. */
export class UnknownPrincipalError extends Error {
  override readonly name = 'UnknownPrincipalError';
}

const MIN_SECRET_LENGTH = 32;

/** Build the policy from configuration. Throws (AI stays off) when a secret is missing. */
export function quotaPolicy(config: Pick<AppConfig, 'ai' | 'auth'>): QuotaPolicy {
  const identity = config.auth.identityHmacSecret;
  const network = config.auth.ipHmacSecret;
  if (!identity || identity.length < MIN_SECRET_LENGTH) {
    throw new QuotaConfigError(`IDENTITY_HMAC_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`);
  }
  if (!network || network.length < MIN_SECRET_LENGTH) {
    throw new QuotaConfigError(`IP_HMAC_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`);
  }
  const l = config.ai.limits;
  const policy: QuotaPolicy = {
    budgets: { ...config.ai.budgets },
    limits: {
      ...DEFAULT_RATE_LIMITS,
      trialRequests: l.anonymousTrialRequests,
      accountDailyRequests: l.userDailyRequests,
      accountMonthlyRequests: l.userMonthlyRequests,
      newAccountDailyRequests: l.newAccountDailyRequests,
      newAccountDays: l.newAccountDays,
      globalInFlight: l.globalConcurrency,
    },
    leaseTtlMs: LEASE_TTL_MS,
    secrets: { identity, network },
  };
  assertPolicy(policy);
  return policy;
}

/** Throws when budgets or limits are inconsistent. */
export function assertPolicy(p: QuotaPolicy): void {
  const b = p.budgets;
  for (const [name, v] of Object.entries(b)) {
    if (!Number.isFinite(v) || v < 0) throw new QuotaConfigError(`Budget ${name} must be a non-negative number`);
  }
  if (b.anonymousShare > 1) throw new QuotaConfigError('anonymousShare must be at most 1');
  for (const [name, v] of Object.entries(p.limits)) {
    if (!Number.isInteger(v) || v < 0) throw new QuotaConfigError(`Limit ${name} must be a non-negative integer`);
  }
  if (p.limits.anonymousInFlight > p.limits.globalInFlight) {
    throw new QuotaConfigError('anonymousInFlight cannot exceed globalInFlight');
  }
  if (!(p.leaseTtlMs > PIPELINE_DEADLINE_MS)) {
    throw new QuotaConfigError('The lease TTL must be longer than the pipeline deadline');
  }
}

// ---------------------------------------------------------------------------
// Principals and keyed hashes

/**
 * Who a paid request is billed to. A trial is the random id in its signed cookie. An
 * account is identified by its Google issuer and `sub` (never the mutable email): its
 * quota key is the §7 anti-abuse HMAC, so usage survives deletion and re-registration.
 */
export type Principal =
  | { readonly kind: 'trial'; readonly id: string }
  | { readonly kind: 'account'; readonly issuer: string; readonly subject: string; readonly createdAt: Date };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_LABEL = /^[\x21-\x7e]{1,255}$/;

function hmac(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** HMAC(issuer, sub) under the identity secret: the anti-abuse key of a Google account. */
export function accountIdentityHash(secret: string, issuer: string, subject: string): string {
  if (!SAFE_LABEL.test(issuer) || !SAFE_LABEL.test(subject)) throw new QuotaInputError('Invalid account identity');
  return hmac(secret, `account\n${issuer}\n${subject}`);
}

export function principalHash(policy: QuotaPolicy, p: Principal): string {
  if (p.kind === 'trial') {
    if (!UUID.test(p.id)) throw new QuotaInputError('Invalid trial id');
    return hmac(policy.secrets.identity, `trial\n${p.id}`);
  }
  if (!(p.createdAt instanceof Date) || Number.isNaN(p.createdAt.getTime())) {
    throw new QuotaInputError('Invalid account creation time');
  }
  return accountIdentityHash(policy.secrets.identity, p.issuer, p.subject);
}

/** HMAC of the validated network identity (normalized IP or IPv6 /64) from the network adapter. */
export function networkHash(policy: QuotaPolicy, networkId: string): string {
  if (typeof networkId !== 'string' || networkId.length === 0 || networkId.length > 200) {
    throw new QuotaInputError('Invalid network identity');
  }
  return hmac(policy.secrets.network, `network\n${networkId}`);
}

// ---------------------------------------------------------------------------
// Canonical request hash

/**
 * Deterministic JSON: object keys sorted, no whitespace. Rejects values JSON cannot
 * represent exactly (undefined, functions, non-finite numbers, bigint).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new QuotaInputError('Non-finite number in request');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) throw new QuotaInputError('Only plain objects can be hashed');
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new QuotaInputError(`Cannot hash a ${typeof value}`);
}

/** sha256 (hex) of the canonical JSON of a validated request body. */
export function canonicalRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
