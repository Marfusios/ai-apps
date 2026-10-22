/**
 * Anonymous trial identities and their cookie (DESIGN §7, SECURITY_REVIEW F11).
 *
 * - **Cookie.** `v1.<id>.<mac>`: `id` is 32 random bytes and `mac` an HMAC-SHA256 of
 *   `v1.<id>` under a key derived from IDENTITY_HMAC_SECRET (server/identity/keys.ts),
 *   both base64url. HttpOnly, SameSite=Lax, Path=/, no Domain (host-only), and Secure
 *   with the `__Host-` name prefix whenever APP_URL is https (always in live; plain
 *   http is only for local development). Max-Age is the trial's remaining life.
 * - **Storage.** Only `cookie_hash`, an HMAC of `id` under a second derived key, is
 *   stored; the cookie itself never is. A trial is found by that hash, and only while
 *   it has not expired. The row's own `id` is the quota principal and never leaves the
 *   server.
 * - **Untrusted input.** A cookie that is malformed, carries a wrong MAC (tampered,
 *   another key) or names no live trial is ignored, exactly as if it were absent. It
 *   is never trusted and never an error.
 * - **Creation** happens only through the anonymous gate after a successful Turnstile
 *   check, and is capped (`TRIAL_CREATION_LIMITS`) per network identity (its HMAC) and
 *   in total per UTC day, in one short transaction with the usage buckets.
 */
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { createTrialIdentity } from '../quota/admit.js';
import { addToBuckets, bucketRef, countsOf, lockBuckets, type BucketRef } from '../quota/buckets.js';
import { isLockTimeout, setLockTimeout } from '../quota/locks.js';
import { networkHash, type Principal, type QuotaPolicy } from '../quota/policy.js';
import { deriveIdentityKey, keyedHash } from './keys.js';

export type TrialPrincipal = Extract<Principal, { kind: 'trial' }>;

/** Cookie names: with the `__Host-` prefix (Secure, Path=/, no Domain enforced by browsers) over https. */
export const TRIAL_COOKIE_SECURE = '__Host-aviation_trial';
export const TRIAL_COOKIE_PLAIN = 'aviation_trial';

const VERSION = 'v1';
const ID_BYTES = 32;
const COOKIE_VALUE = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
/** At most this many cookies of our name are examined per request. */
const MAX_CANDIDATES = 4;

export interface TrialCreationLimits {
  /** New trials per network identity (normalized IP or IPv6 /64) per hour and per UTC day. */
  perNetworkHour: number;
  perNetworkDay: number;
  /** New trials in total per UTC day: bounds the rows a challenge-solving farm can create. */
  globalDay: number;
}

/**
 * Typed defaults. A trial is 3 searches and the anonymous share pays for about 7 a day
 * (DESIGN §7), so these leave room for shared networks (a school) while bounding the
 * rows a stream of solved challenges can create (at most 15,000 live trials).
 */
export const TRIAL_CREATION_LIMITS: TrialCreationLimits = { perNetworkHour: 5, perNetworkDay: 10, globalDay: 500 };

/** The values of every cookie called `name` in a Cookie header (at most a few). */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    out.push(part.slice(eq + 1).trim());
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** The trial cookie's format, MAC and stored hash. */
export class TrialCookieCodec {
  readonly name: string;
  readonly secure: boolean;
  private readonly signKey: Buffer;
  private readonly lookupKey: Buffer;

  constructor(identitySecret: string, opts: { secure: boolean }) {
    this.secure = opts.secure;
    this.name = opts.secure ? TRIAL_COOKIE_SECURE : TRIAL_COOKIE_PLAIN;
    this.signKey = deriveIdentityKey(identitySecret, 'trial-cookie-signature');
    this.lookupKey = deriveIdentityKey(identitySecret, 'trial-cookie-lookup');
  }

  private mac(id: string): Buffer {
    return createHmac('sha256', this.signKey).update(`${VERSION}.${id}`, 'utf8').digest();
  }

  /** A new cookie value and the hash under which its trial is stored. */
  issue(): { value: string; cookieHash: string } {
    const id = randomBytes(ID_BYTES).toString('base64url');
    return { value: `${VERSION}.${id}.${this.mac(id).toString('base64url')}`, cookieHash: keyedHash(this.lookupKey, id) };
  }

  /** The stored hash for a genuine cookie value, or null (malformed or wrong MAC). */
  verify(value: string): string | null {
    const m = COOKIE_VALUE.exec(value);
    if (!m) return null;
    const id = m[1] as string;
    const given = Buffer.from(m[2] as string, 'base64url');
    const expected = this.mac(id);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return keyedHash(this.lookupKey, id);
  }

  /** The Set-Cookie value for a trial that lives `maxAgeSeconds` more. */
  setCookie(value: string, maxAgeSeconds: number): string {
    const age = Math.max(0, Math.floor(maxAgeSeconds));
    return `${this.name}=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`;
  }
}

export type StartTrialResult =
  | { ok: true; principal: TrialPrincipal; expiresAt: Date }
  | { ok: false; reason: 'trial_limit'; retryAt: Date }
  /** A lock wait timed out; nothing was created (fail closed). */
  | { ok: false; reason: 'busy' };

export interface TrialIdentitiesOptions {
  db: Db;
  policy: QuotaPolicy;
  /** Secure cookie (and the `__Host-` name): APP_URL is https. */
  secure: boolean;
  limits?: TrialCreationLimits;
}

/** Trial identities behind the cookie: read on any request, created only by the gate. */
export class TrialIdentities {
  readonly codec: TrialCookieCodec;
  private readonly db: Db;
  private readonly policy: QuotaPolicy;
  private readonly limits: TrialCreationLimits;

  constructor(opts: TrialIdentitiesOptions) {
    this.db = opts.db;
    this.policy = opts.policy;
    this.limits = opts.limits ?? TRIAL_CREATION_LIMITS;
    this.codec = new TrialCookieCodec(opts.policy.secrets.identity, { secure: opts.secure });
  }

  /** The live trial proven by the request's cookie, or null. Reads only; never sets a cookie. */
  async fromRequest(request: FastifyRequest, now: Date): Promise<TrialPrincipal | null> {
    const hashes = cookieValues(request.headers.cookie, this.codec.name)
      .map((v) => this.codec.verify(v))
      .filter((h): h is string => h !== null);
    return hashes.length === 0 ? null : findTrial(this.db, hashes, now);
  }

  /**
   * Create a trial for a visitor who has just passed the challenge, within the creation
   * limits, and put its cookie on the reply (with `no-store`). Counts toward the limits
   * only when a trial is created.
   */
  async start(reply: FastifyReply, networkId: string, now: Date): Promise<StartTrialResult> {
    const net = `trial-create:${networkHash(this.policy, networkId)}`;
    const limited: { ref: BucketRef; limit: number }[] = [
      { ref: bucketRef('network', net, 'hour', now), limit: this.limits.perNetworkHour },
      { ref: bucketRef('network', net, 'day', now), limit: this.limits.perNetworkDay },
      { ref: bucketRef('global', 'trial-create', 'day', now), limit: this.limits.globalDay },
    ];
    const cookie = this.codec.issue();
    let result: StartTrialResult;
    try {
      result = await this.db.transaction(async (tx): Promise<StartTrialResult> => {
        await setLockTimeout(tx);
        const counts = await lockBuckets(
          tx,
          limited.map((b) => b.ref),
        );
        let retryAt: Date | null = null;
        for (const { ref, limit } of limited) {
          if (countsOf(counts, ref).attempts >= limit && (retryAt === null || ref.end > retryAt)) retryAt = ref.end;
        }
        if (retryAt) return { ok: false, reason: 'trial_limit', retryAt };
        const trial = await createTrialIdentity(tx, this.policy, cookie.cookieHash, now);
        await addToBuckets(
          tx,
          limited.map((b) => b.ref),
          'attempts',
          1,
        );
        return { ok: true, principal: { kind: 'trial', id: trial.id }, expiresAt: trial.expiresAt };
      });
    } catch (err) {
      if (isLockTimeout(err)) return { ok: false, reason: 'busy' };
      throw err;
    }
    if (result.ok) {
      reply
        .header('set-cookie', this.codec.setCookie(cookie.value, (result.expiresAt.getTime() - now.getTime()) / 1000))
        .header('cache-control', 'no-store');
    }
    return result;
  }
}

/** The live trial stored under one of these cookie hashes (the first one found), or null. */
export async function findTrial(db: DbOrTx, cookieHashes: readonly string[], now: Date): Promise<TrialPrincipal | null> {
  for (const hash of cookieHashes) {
    const res = await db.execute(
      sql`SELECT id::text AS id FROM trial_identities WHERE cookie_hash = ${hash} AND expires_at > ${now}`,
    );
    const row = res.rows[0] as { id: string } | undefined;
    if (row) return { kind: 'trial', id: row.id };
  }
  return null;
}
