/**
 * Interactive admission (DESIGN §7–§8). One short transaction:
 *
 * 0. The caller's precondition, if any, first (for a signed-in account: its lifecycle lock
 *    and a check that its session still exists, server/auth/lifecycle.ts), before any lock
 *    other accounts share: waiting for one account's lock never stalls another account's
 *    admission. A failure rolls everything back (`signed_out`).
 * 1. Kill switch, and the login-required emergency mode for trial principals.
 * 2. Lock the principal, network and global buckets in key order.
 * 3. Idempotency, scoped to the principal: the same key and request hash replays the
 *    original admission (no new attempt, quota or money); the same key with another
 *    request hash is a conflict (409).
 * 4. Rate limits on attempts (principal per minute, network per hour and day). An
 *    attempt that passes is counted, whatever the later outcome.
 * 5. Under the spend lock: the monthly and paced daily budgets; then `concurrency` if
 *    the principal already has a request in flight (so a running request never shows
 *    as an exhausted quota); then the principal's quota (trial searches, account
 *    daily/monthly searches), the anonymous share, and the total and anonymous
 *    in-flight limits (two in total, one anonymous).
 * 6. Reserve the request's maximum cost, take one unit of quota, and acquire a lease
 *    (90 s) with a fencing token. Commit before any provider call.
 *
 * Lock order: the account's lock (step 0), the bucket rows in key order, the spend lock.
 * Nothing takes buckets or the spend lock and then an account's lock.
 *
 * Lock waits are bounded (2 s); a timeout rolls back and returns `busy`.
 *
 * The quota unit is taken at admission so two concurrent requests can never both use
 * the last trial search. A reply that must not count (off-topic, operational, nothing
 * spent) gives it back with `releaseQuota`; its attempt still counts. Paths that make
 * no paid call count attempts with `recordAttempt`.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import type { ReservationStatus } from '../db/schema/index.js';
import {
  addToBuckets,
  bucketRef,
  countsOf,
  lockBuckets,
  nextUtcMidnight,
  utcDay,
  type BucketCounts,
  type BucketRef,
} from './buckets.js';
import { checkInteractiveBudget, microsToNumeric, microsToUsd, spendSnapshot, toMicros } from './pacing.js';
import {
  IDEMPOTENCY_TTL_MS,
  QuotaInputError,
  SPEND_LOCK_KEY,
  UnknownPrincipalError,
  networkHash,
  principalHash,
  type Principal,
  type QuotaPolicy,
} from './policy.js';
import { isLockTimeout, setLockTimeout } from './locks.js';
import { readAiSwitch } from './switch.js';

export type RejectionReason =
  | 'trial_exhausted'
  | 'daily_cap'
  | 'monthly_cap'
  | 'anonymous_share_exhausted'
  | 'global_paused'
  | 'rate_limited'
  | 'concurrency'
  | 'idempotency_conflict'
  /** The login-required emergency mode refuses trial principals (403); nothing is counted. */
  | 'login_required'
  /** The caller's `precondition` failed (a signed-in account's session ended): nothing is kept (403). */
  | 'signed_out'
  /** A lock wait timed out; nothing was admitted (fail closed, 503). */
  | 'busy';

/** Why AI is paused for everyone. */
export type PauseReason = 'daily_budget' | 'monthly_budget' | 'maintenance';

export interface AdmissionInput {
  policy: QuotaPolicy;
  principal: Principal;
  /** Validated client network identity (normalized IP or IPv6 /64) from the network adapter; hashed before storage. */
  networkId: string;
  /** Client idempotency key (8–128 of `A-Za-z0-9_-`), scoped to the principal. */
  idempotencyKey: string;
  /** `canonicalRequestHash` of the validated request body. */
  requestHash: string;
  /** Per-request reservation in USD (`startupAiCheck().reservationUsd`). */
  reservationUsd: number;
  /** Content-free id copied to the ledger lines. */
  requestId?: string;
  now?: Date;
  /**
   * Checked first in the admission's transaction, before any lock that other accounts
   * share (bucket rows, the spend lock). False refuses the request (`signed_out`) and
   * rolls the transaction back. For an account, the route passes its lifecycle lock and
   * session check (server/auth/lifecycle.ts): the lock is held to the commit, so a
   * request whose account was deleted before reserves nothing, and a deletion waits for an
   * admission under way (bounded by its lock wait).
   */
  precondition?: (tx: DbOrTx) => Promise<boolean>;
}

/** Thrown inside the admission's transaction when its precondition fails: rolls everything back. */
class PreconditionFailed extends Error {
  override readonly name = 'PreconditionFailed';
}

/** A fresh admission. Keep the fencing token server-side; it settles or releases the request. */
export interface Admission {
  ok: true;
  replay: false;
  reservationId: number;
  fencingToken: string;
  leaseExpiresAt: Date;
  reservationUsd: number;
  principal: Principal;
  principalHash: string;
  accountingDay: string;
}

/** A retry of an admitted request (same principal, key and body): its state, never a new run. */
export interface ReplayedAdmission {
  ok: true;
  replay: true;
  reservationId: number;
  status: ReservationStatus;
  resultRef: string | null;
  leaseExpiresAt: Date;
}

export interface Rejection {
  ok: false;
  reason: RejectionReason;
  /** For `global_paused`. */
  pause?: PauseReason;
  /** When retrying can succeed, if known (rate limits, caps, budget resets). */
  retryAt?: Date;
}

export type AdmissionResult = Admission | ReplayedAdmission | Rejection;

/**
 * HTTP status for a rejection: 409 for a reused idempotency key, 403 in the login-required
 * mode, 503 while paused or busy, otherwise 429.
 */
export function rejectionStatus(r: Rejection): 403 | 409 | 429 | 503 {
  if (r.reason === 'idempotency_conflict') return 409;
  if (r.reason === 'login_required' || r.reason === 'signed_out') return 403;
  if (r.reason === 'global_paused' || r.reason === 'busy') return 503;
  return 429;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Sanity bound on one interactive reservation. */
const MAX_RESERVATION_USD = 5;
const DAY_MS = 86_400_000;

interface LimitedBucket {
  ref: BucketRef;
  limit: number;
}

function isAnonymous(p: Principal | null): boolean {
  return p === null || p.kind === 'trial';
}

/** Attempt counters: the principal per minute, its network class per hour and per day. */
export function attemptBuckets(
  policy: QuotaPolicy,
  principal: Principal | null,
  pHash: string | null,
  networkId: string,
  now: Date,
): LimitedBucket[] {
  const l = policy.limits;
  const anonymous = isAnonymous(principal);
  const network = `${anonymous ? 'anonymous' : 'account'}:${networkHash(policy, networkId)}`;
  const out: LimitedBucket[] = [];
  if (pHash !== null) {
    out.push({
      ref: bucketRef('principal', pHash, 'minute', now),
      limit: anonymous ? l.anonymousPerMinute : l.accountPerMinute,
    });
  }
  out.push({
    ref: bucketRef('network', network, 'hour', now),
    limit: anonymous ? l.anonymousNetworkPerHour : l.accountNetworkPerHour,
  });
  out.push({
    ref: bucketRef('network', network, 'day', now),
    limit: anonymous ? l.anonymousNetworkPerDay : l.accountNetworkPerDay,
  });
  return out;
}

/** An account's request counters for the day and month of `at`. */
export function accountRequestBuckets(pHash: string, at: Date): { day: BucketRef; month: BucketRef } {
  return { day: bucketRef('principal', pHash, 'day', at), month: bucketRef('principal', pHash, 'month', at) };
}

function globalRequestBuckets(at: Date): BucketRef[] {
  return [bucketRef('global', 'interactive', 'day', at), bucketRef('global', 'interactive', 'month', at)];
}

/** The account's daily limit now: the new-account allowance during its first days. */
export function accountDailyLimit(
  policy: QuotaPolicy,
  createdAt: Date,
  now: Date,
): { limit: number; newAccountUntil: Date | null } {
  const until = new Date(createdAt.getTime() + policy.limits.newAccountDays * DAY_MS);
  return now < until
    ? { limit: policy.limits.newAccountDailyRequests, newAccountUntil: until }
    : { limit: policy.limits.accountDailyRequests, newAccountUntil: null };
}

/** The latest window end among exceeded attempt limits, or null. */
function rateLimitedUntil(counts: Map<string, BucketCounts>, buckets: readonly LimitedBucket[]): Date | null {
  let until: Date | null = null;
  for (const { ref, limit } of buckets) {
    if (countsOf(counts, ref).attempts >= limit && (until === null || ref.end > until)) until = ref.end;
  }
  return until;
}

function validateAdmission(a: AdmissionInput, now: Date): void {
  if (!IDEMPOTENCY_KEY.test(a.idempotencyKey)) throw new QuotaInputError('Invalid idempotency key');
  if (!HEX64.test(a.requestHash)) throw new QuotaInputError('Invalid request hash');
  if (!Number.isFinite(a.reservationUsd) || a.reservationUsd <= 0 || a.reservationUsd > MAX_RESERVATION_USD) {
    throw new QuotaInputError('Invalid reservation amount');
  }
  if (a.requestId !== undefined && (a.requestId.length === 0 || a.requestId.length > 200)) {
    throw new QuotaInputError('Invalid request id');
  }
  if (Number.isNaN(now.getTime())) throw new QuotaInputError('Invalid time');
}

interface IdempotencyRow {
  request_hash: string;
  reservation_id: string;
  result_ref: string | null;
  status: ReservationStatus;
  /** Epoch milliseconds (raw queries return timestamps as text). */
  lease_expires_ms: string;
}

async function findIdempotency(tx: DbOrTx, pHash: string, key: string, now: Date): Promise<IdempotencyRow | null> {
  const res = await tx.execute(sql`
    SELECT i.request_hash, i.reservation_id, i.result_ref, r.status,
      (extract(epoch FROM r.lease_expires_at) * 1000)::bigint AS lease_expires_ms
    FROM idempotency i JOIN reservations r ON r.id = i.reservation_id
    WHERE i.principal_hash = ${pHash} AND i.idempotency_key = ${key} AND i.expires_at > ${now}`);
  return (res.rows[0] as IdempotencyRow | undefined) ?? null;
}

async function trialQuota(
  tx: DbOrTx,
  policy: QuotaPolicy,
  principal: Extract<Principal, { kind: 'trial' }>,
  now: Date,
): Promise<Rejection | null> {
  const res = await tx.execute(
    sql`SELECT requests_used, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms FROM trial_identities
        WHERE id = ${principal.id}::uuid`,
  );
  const row = res.rows[0] as { requests_used: number; expires_ms: string } | undefined;
  if (!row || Number(row.expires_ms) <= now.getTime()) {
    throw new UnknownPrincipalError('The trial identity does not exist or has expired');
  }
  return row.requests_used >= policy.limits.trialRequests ? { ok: false, reason: 'trial_exhausted' } : null;
}

function accountQuota(
  policy: QuotaPolicy,
  principal: Extract<Principal, { kind: 'account' }>,
  counts: Map<string, BucketCounts>,
  buckets: { day: BucketRef; month: BucketRef },
  now: Date,
): Rejection | null {
  const l = policy.limits;
  if (countsOf(counts, buckets.month).requests >= l.accountMonthlyRequests) {
    return { ok: false, reason: 'monthly_cap', retryAt: buckets.month.end };
  }
  const usedToday = countsOf(counts, buckets.day).requests;
  const { limit, newAccountUntil } = accountDailyLimit(policy, principal.createdAt, now);
  if (usedToday >= limit) {
    // A new account's allowance can rise before midnight.
    const rises = newAccountUntil !== null && newAccountUntil < buckets.day.end && usedToday < l.accountDailyRequests;
    return { ok: false, reason: 'daily_cap', retryAt: rises ? newAccountUntil : buckets.day.end };
  }
  return null;
}

async function inFlight(tx: DbOrTx, pHash: string, now: Date): Promise<{ mine: number; total: number; anonymous: number }> {
  const res = await tx.execute(sql`
    SELECT count(*) FILTER (WHERE principal_hash = ${pHash})::int AS mine, count(*)::int AS total,
      count(*) FILTER (WHERE anonymous)::int AS anonymous
    FROM leases WHERE released_at IS NULL AND expires_at > ${now}`);
  return res.rows[0] as { mine: number; total: number; anonymous: number };
}

/** Admit one paid interactive request, or say why not. Throws when quota storage fails (fail closed). */
export async function admitPaidRequest(db: Db, a: AdmissionInput): Promise<AdmissionResult> {
  const now = a.now ?? new Date();
  validateAdmission(a, now);
  const { policy, principal } = a;
  const l = policy.limits;
  const pHash = principalHash(policy, principal);
  const anonymous = isAnonymous(principal);
  const reservation = toMicros(a.reservationUsd);
  const attempts = attemptBuckets(policy, principal, pHash, a.networkId, now);
  const account = principal.kind === 'account' ? accountRequestBuckets(pHash, now) : null;
  const global = globalRequestBuckets(now);
  const requestBuckets = [...(account ? [account.day, account.month] : []), ...global];

  try {
    return await db.transaction(async (tx): Promise<AdmissionResult> => {
      await setLockTimeout(tx);
      // The account's own lock before anything shared (see the module comment).
      if (a.precondition && !(await a.precondition(tx))) throw new PreconditionFailed('admission precondition failed');
      const aiSwitch = await readAiSwitch(tx);
      if (!aiSwitch.enabled) return { ok: false, reason: 'global_paused', pause: 'maintenance' };
      if (principal.kind === 'trial' && !aiSwitch.anonymousEnabled) return { ok: false, reason: 'login_required' };

      const counts = await lockBuckets(tx, [...attempts.map((b) => b.ref), ...requestBuckets]);

      const prior = await findIdempotency(tx, pHash, a.idempotencyKey, now);
      if (prior) {
        if (prior.request_hash !== a.requestHash) return { ok: false, reason: 'idempotency_conflict' };
        return {
          ok: true,
          replay: true,
          reservationId: Number(prior.reservation_id),
          status: prior.status,
          resultRef: prior.result_ref,
          leaseExpiresAt: new Date(Number(prior.lease_expires_ms)),
        };
      }

      const limitedUntil = rateLimitedUntil(counts, attempts);
      if (limitedUntil) return { ok: false, reason: 'rate_limited', retryAt: limitedUntil };
      await addToBuckets(
        tx,
        attempts.map((b) => b.ref),
        'attempts',
        1,
      );

      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPEND_LOCK_KEY})`);
      const budget = checkInteractiveBudget(await spendSnapshot(tx, now), reservation, policy.budgets, now);
      if (!budget.ok) return { ok: false, reason: 'global_paused', pause: budget.pause, retryAt: budget.retryAt };

      // A request of this principal still running: report that, not the quota it holds.
      const flight = await inFlight(tx, pHash, now);
      if (flight.mine >= l.principalInFlight) return { ok: false, reason: 'concurrency' };

      const quota =
        principal.kind === 'trial'
          ? await trialQuota(tx, policy, principal, now)
          : accountQuota(policy, principal, counts, account!, now);
      if (quota) return quota;
      if (anonymous && !budget.anonymousOk) {
        return { ok: false, reason: 'anonymous_share_exhausted', retryAt: nextUtcMidnight(now) };
      }

      if (flight.total >= l.globalInFlight || (anonymous && flight.anonymous >= l.anonymousInFlight)) {
        return { ok: false, reason: 'concurrency' };
      }

      const leaseExpiresAt = new Date(now.getTime() + policy.leaseTtlMs);
      const accountingDay = utcDay(now);
      const inserted = await tx.execute(sql`
        INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day,
          quota_counted, request_id, created_at)
        VALUES ('interactive', ${principal.kind}, ${pHash}, ${microsToNumeric(reservation)}::numeric, 'open',
          ${leaseExpiresAt}, ${accountingDay}::date, true, ${a.requestId ?? null}, ${now})
        RETURNING id, fencing_token::text AS fencing_token`);
      const row = inserted.rows[0] as { id: string; fencing_token: string };
      const reservationId = Number(row.id);

      await tx.execute(sql`
        INSERT INTO leases (reservation_id, principal_hash, anonymous, acquired_at, expires_at)
        VALUES (${reservationId}, ${pHash}, ${anonymous}, ${now}, ${leaseExpiresAt})`);

      // An expired record with the same key is replaced; a live one cannot exist (checked above under the lock).
      const idem = await tx.execute(sql`
        INSERT INTO idempotency (principal_hash, idempotency_key, request_hash, reservation_id, result_ref, created_at, expires_at)
        VALUES (${pHash}, ${a.idempotencyKey}, ${a.requestHash}, ${reservationId}, NULL, ${now},
          ${new Date(now.getTime() + IDEMPOTENCY_TTL_MS)})
        ON CONFLICT (principal_hash, idempotency_key) DO UPDATE SET request_hash = EXCLUDED.request_hash,
          reservation_id = EXCLUDED.reservation_id, result_ref = NULL, created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
        WHERE idempotency.expires_at <= ${now}`);
      if (idem.rowCount !== 1) throw new Error('idempotency record changed during admission');

      if (principal.kind === 'trial') {
        const used = await tx.execute(sql`
          UPDATE trial_identities SET requests_used = requests_used + 1
          WHERE id = ${principal.id}::uuid AND requests_used < ${l.trialRequests}`);
        if (used.rowCount !== 1) throw new Error('trial identity changed during admission');
      } else {
        await tx.execute(sql`
          INSERT INTO abuse_records (identity_hash, first_seen_at, last_seen_at, retain_until)
          VALUES (${pHash}, ${now}, ${now}, ${account!.month.expiresAt})
          ON CONFLICT (identity_hash) DO UPDATE
            SET last_seen_at = greatest(abuse_records.last_seen_at, EXCLUDED.last_seen_at),
                retain_until = greatest(abuse_records.retain_until, EXCLUDED.retain_until)`);
      }
      await addToBuckets(tx, requestBuckets, 'requests', 1);

      return {
        ok: true,
        replay: false,
        reservationId,
        fencingToken: row.fencing_token,
        leaseExpiresAt,
        reservationUsd: microsToUsd(reservation),
        principal,
        principalHash: pHash,
        accountingDay,
      };
    });
  } catch (err) {
    if (err instanceof PreconditionFailed) return { ok: false, reason: 'signed_out' };
    if (isLockTimeout(err)) return { ok: false, reason: 'busy' };
    throw err;
  }
}

export interface AttemptInput {
  policy: QuotaPolicy;
  /** Null for a visitor without a trial identity yet (network counters only). */
  principal: Principal | null;
  networkId: string;
  now?: Date;
}

export type AttemptResult = { ok: true } | { ok: false; reason: 'rate_limited'; retryAt: Date };

/**
 * Count one AI attempt that makes no paid call (for example a request refused before
 * admission) against the abuse rate limits. It never touches the trial or account quota.
 */
export async function recordAttempt(db: Db, a: AttemptInput): Promise<AttemptResult> {
  const now = a.now ?? new Date();
  const pHash = a.principal ? principalHash(a.policy, a.principal) : null;
  const attempts = attemptBuckets(a.policy, a.principal, pHash, a.networkId, now);
  return db.transaction(async (tx): Promise<AttemptResult> => {
    const counts = await lockBuckets(
      tx,
      attempts.map((b) => b.ref),
    );
    const until = rateLimitedUntil(counts, attempts);
    if (until) return { ok: false, reason: 'rate_limited', retryAt: until };
    await addToBuckets(
      tx,
      attempts.map((b) => b.ref),
      'attempts',
      1,
    );
    return { ok: true };
  });
}

export type ReleaseResult =
  | { released: true }
  | { released: false; reason: 'stale_token' | 'not_open' | 'already_released' | 'lease_expired' };

/**
 * Give back the quota unit an admission took, for a reply that must not count: an
 * off-topic or operational question, or a failure before anything was spent. Needs
 * the fencing token and a live lease, and the admission must match its reservation
 * (principal kind and the HMAC recomputed from the principal). The attempt and the
 * money stay charged; settle the reservation as usual. Cancellations and withheld
 * summaries keep their unit.
 */
export async function releaseQuota(
  db: Db,
  admission: Admission,
  fencingToken: string,
  opts: { policy: QuotaPolicy; now?: Date },
): Promise<ReleaseResult> {
  const now = opts.now ?? new Date();
  const pHash = principalHash(opts.policy, admission.principal);
  return db.transaction(async (tx): Promise<ReleaseResult> => {
    const res = await tx.execute(sql`
      SELECT principal_kind, principal_hash, status, fencing_token::text AS fencing_token, quota_counted,
        (extract(epoch FROM lease_expires_at) * 1000)::bigint AS lease_expires_ms,
        (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
      FROM reservations WHERE id = ${admission.reservationId} AND category = 'interactive' FOR UPDATE`);
    const row = res.rows[0] as
      | {
          principal_kind: string;
          principal_hash: string;
          status: ReservationStatus;
          fencing_token: string;
          quota_counted: boolean;
          lease_expires_ms: string;
          created_ms: string;
        }
      | undefined;
    if (!row) throw new QuotaInputError(`Unknown reservation ${admission.reservationId}`);
    if (
      row.principal_kind !== admission.principal.kind ||
      row.principal_hash !== pHash ||
      admission.principalHash !== pHash
    ) {
      throw new QuotaInputError('The admission does not match its reservation');
    }
    if (row.fencing_token !== fencingToken) return { released: false, reason: 'stale_token' };
    if (row.status !== 'open') return { released: false, reason: 'not_open' };
    if (!row.quota_counted) return { released: false, reason: 'already_released' };
    if (now.getTime() >= Number(row.lease_expires_ms)) return { released: false, reason: 'lease_expired' };

    // Lock order: this reservation row (admission never locks existing reservations),
    // then the buckets in key order, then the trial row. Admission also takes buckets
    // before the trial row, so the two cannot wait on each other in a cycle.
    const at = new Date(Number(row.created_ms));
    const principalBuckets = admission.principal.kind === 'account' ? Object.values(accountRequestBuckets(pHash, at)) : [];
    const buckets = [...principalBuckets, ...globalRequestBuckets(at)];
    await lockBuckets(tx, buckets);
    if (admission.principal.kind === 'trial') {
      await tx.execute(sql`
        UPDATE trial_identities SET requests_used = greatest(0, requests_used - 1)
        WHERE id = ${admission.principal.id}::uuid`);
    }
    await addToBuckets(tx, buckets, 'requests', -1);
    await tx.execute(sql`UPDATE reservations SET quota_counted = false WHERE id = ${admission.reservationId}`);
    return { released: true };
  });
}

/** Point the admission's idempotency record at its stored result (e.g. the brief step). */
export async function setResultRef(db: DbOrTx, admission: Admission, resultRef: string): Promise<void> {
  if (resultRef.length === 0 || resultRef.length > 200) throw new QuotaInputError('Invalid result reference');
  await db.execute(sql`
    UPDATE idempotency SET result_ref = ${resultRef}
    WHERE principal_hash = ${admission.principalHash} AND reservation_id = ${admission.reservationId}`);
}

/**
 * Create a trial identity (after a successful challenge, server/identity/trial.ts); it
 * expires after `trialDays`. `cookieHash` is the keyed HMAC of the random value in the
 * visitor's signed cookie (64 hex), the only form in which the cookie is stored.
 */
export async function createTrialIdentity(
  db: DbOrTx,
  policy: QuotaPolicy,
  cookieHash: string,
  now: Date = new Date(),
): Promise<{ id: string; expiresAt: Date }> {
  if (!HEX64.test(cookieHash)) throw new QuotaInputError('Invalid trial cookie hash');
  const expiresAt = new Date(now.getTime() + policy.limits.trialDays * DAY_MS);
  const res = await db.execute(sql`
    INSERT INTO trial_identities (cookie_hash, created_at, requests_used, expires_at)
    VALUES (${cookieHash}, ${now}, 0, ${expiresAt})
    RETURNING id::text AS id`);
  return { id: (res.rows[0] as { id: string }).id, expiresAt };
}
