/**
 * Server-side Cloudflare Turnstile verification (DESIGN §8, SECURITY_REVIEW: replay,
 * hostname and action checks).
 *
 * - Every token goes to siteverify with the secret key and a fresh UUID
 *   `idempotency_key`. A network error, a timeout, an HTTP 429/5xx or Cloudflare's
 *   `internal-error` is retried (two attempts by default) with the same key, so a retry
 *   of a verification Cloudflare already ran gets that result instead of
 *   `timeout-or-duplicate`. When every attempt fails the verdict is `unavailable`: the
 *   caller refuses the request (503) and nothing is spent (fail closed).
 * - A successful verdict needs the expected hostname (APP_URL's), the expected action
 *   (`TURNSTILE_ACTION`) and a `challenge_ts` at most 5 minutes old (plus clock skew).
 *   `timeout-or-duplicate` (expired or already used), `invalid-input-response` and
 *   anything else about the token are `rejected` (403).
 * - Cloudflare's documented test secret keys answer without a real challenge: `1x…`
 *   always passes (with a fixed hostname and no action), `2x…` always fails and `3x…`
 *   reports a spent token. With a test key the hostname and action checks are skipped,
 *   because those answers carry no real values; the app refuses test keys when
 *   `APP_ENV=live` (server/ai/runtime.ts).
 * - Single use is also enforced locally: `claimTurnstileToken` records a keyed HMAC of
 *   the token before it is verified, so a replay is refused without a call, also with
 *   the test keys, which would accept it again (except their fixed dummy token:
 *   server/identity/gate.ts).
 *
 * No token, secret or Cloudflare message is ever logged or returned; verdicts carry
 * fixed reason codes only. The visitor's IP address is not sent (`remoteip` is
 * optional and the network identity is a /64 for IPv6).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's public test site keys (always pass, always fail, interactive challenge). */
export const TURNSTILE_TEST_SITE_KEYS: readonly string[] = [
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '1x00000000000000000000BB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
];
/** Cloudflare's public test secret keys: always passes, always fails, token already spent. */
export const TURNSTILE_TEST_SECRET_KEYS: readonly string[] = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];
/** The token the widget produces with a test site key. */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export const isTurnstileTestKey = (key: string): boolean =>
  TURNSTILE_TEST_SITE_KEYS.includes(key) || TURNSTILE_TEST_SECRET_KEYS.includes(key);

/** Cloudflare's limit on a token's length. */
export const TOKEN_MAX_LENGTH = 2048;
/** A token is valid for 5 minutes after the challenge. */
export const TOKEN_LIFETIME_MS = 300_000;
/** Allowed difference between our clock and Cloudflare's. */
export const CLOCK_SKEW_MS = 60_000;
/** A claimed token is remembered well past its lifetime, then pruned. */
export const REDEMPTION_TTL_MS = 15 * 60_000;
/** Responses larger than this are not parsed. */
const MAX_RESPONSE_CHARS = 16_384;

/** A token as the widget produces it: 1–2048 printable ASCII characters without spaces. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/** The visitor's token is not acceptable (403): get a fresh one. */
export type TurnstileRejection = 'invalid_token' | 'expired_or_used' | 'hostname_mismatch' | 'action_mismatch' | 'stale_challenge';
/** The check could not be made (503): siteverify unreachable or misbehaving, or our secret refused. */
export type TurnstileFailure = 'network' | 'timeout' | 'http_status' | 'malformed_response' | 'secret_rejected' | 'internal_error';

export type TurnstileVerdict =
  | { ok: true; testKey: boolean }
  | { ok: false; kind: 'rejected'; reason: TurnstileRejection }
  | { ok: false; kind: 'unavailable'; reason: TurnstileFailure };

export interface TurnstileVerifierOptions {
  secretKey: string;
  /** Hostname the challenge must have been solved on (APP_URL's hostname). */
  expectedHostname: string;
  /** Widget action the challenge must carry (`TURNSTILE_ACTION`). */
  expectedAction: string;
  /** Injected in tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  /** Per attempt, including reading the response (default 4 s). */
  attemptTimeoutMs?: number;
  /** Attempts per verification (default 2). */
  attempts?: number;
  /** Pause before a retry (default 250 ms). */
  retryDelayMs?: number;
  now?: () => Date;
}

const SiteverifyResponseSchema = z.looseObject({
  success: z.boolean(),
  'error-codes': z.array(z.string().max(100)).max(50).optional(),
  challenge_ts: z.string().max(64).optional(),
  hostname: z.string().max(253).optional(),
  action: z.string().max(64).optional(),
});

type Attempt = { retry: boolean; verdict: TurnstileVerdict };

const unavailable = (reason: TurnstileFailure, retry = false): Attempt => ({
  retry,
  verdict: { ok: false, kind: 'unavailable', reason },
});
const rejected = (reason: TurnstileRejection): Attempt => ({ retry: false, verdict: { ok: false, kind: 'rejected', reason } });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TurnstileVerifier {
  /** True for a Cloudflare test secret key (development only). */
  readonly testKey: boolean;
  private readonly secretKey: string;
  private readonly hostname: string;
  private readonly action: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;

  constructor(opts: TurnstileVerifierOptions) {
    if (!opts.secretKey) throw new Error('TURNSTILE_SECRET_KEY is not set');
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(opts.expectedHostname)) throw new Error('The expected Turnstile hostname is not valid');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.expectedAction)) throw new Error('The Turnstile action is not valid');
    this.secretKey = opts.secretKey;
    this.testKey = TURNSTILE_TEST_SECRET_KEYS.includes(opts.secretKey);
    this.hostname = opts.expectedHostname.toLowerCase();
    this.action = opts.expectedAction;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.attemptTimeoutMs ?? 4_000;
    this.attempts = Math.max(1, opts.attempts ?? 2);
    this.retryDelayMs = opts.retryDelayMs ?? 250;
    this.now = opts.now ?? (() => new Date());
  }

  /** Verify one token with Cloudflare. Never throws for network or response problems. */
  async verify(token: string): Promise<TurnstileVerdict> {
    if (!isWellFormedToken(token)) return { ok: false, kind: 'rejected', reason: 'invalid_token' };
    const idempotencyKey = randomUUID();
    let last: Attempt = unavailable('network');
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (attempt > 1 && this.retryDelayMs > 0) await sleep(this.retryDelayMs);
      last = await this.attempt(token, idempotencyKey);
      if (!last.retry) return last.verdict;
    }
    return last.verdict;
  }

  private async attempt(token: string, idempotencyKey: string): Promise<Attempt> {
    let status: number;
    let text: string;
    try {
      const res = await this.fetchFn(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ secret: this.secretKey, response: token, idempotency_key: idempotencyKey }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const name = (err as { name?: string }).name;
      return unavailable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', true);
    }
    if (status === 429 || status >= 500) return unavailable('http_status', true);
    if (text.length > MAX_RESPONSE_CHARS) return unavailable('malformed_response');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return unavailable(status === 200 ? 'malformed_response' : 'http_status');
    }
    const parsed = SiteverifyResponseSchema.safeParse(json);
    if (!parsed.success) return unavailable('malformed_response');
    const body = parsed.data;

    if (!body.success) {
      const codes = body['error-codes'] ?? [];
      if (codes.includes('internal-error')) return unavailable('internal_error', true);
      if (codes.includes('missing-input-secret') || codes.includes('invalid-input-secret')) return unavailable('secret_rejected');
      if (codes.includes('timeout-or-duplicate')) return rejected('expired_or_used');
      return rejected('invalid_token');
    }
    if (status !== 200) return unavailable('http_status');
    if (this.testKey) return { retry: false, verdict: { ok: true, testKey: true } };

    if ((body.hostname ?? '').toLowerCase() !== this.hostname) return rejected('hostname_mismatch');
    if (body.action !== this.action) return rejected('action_mismatch');
    const solved = body.challenge_ts === undefined ? Number.NaN : Date.parse(body.challenge_ts);
    const age = this.now().getTime() - solved;
    if (!Number.isFinite(solved) || age > TOKEN_LIFETIME_MS + CLOCK_SKEW_MS || age < -CLOCK_SKEW_MS) {
      return rejected('stale_challenge');
    }
    return { retry: false, verdict: { ok: true, testKey: false } };
  }
}

/**
 * Claim a token for a single verification, under the keyed HMAC of the token. False when
 * the same token was presented before (it is refused without calling Cloudflare). Two
 * concurrent requests with one token: exactly one claims it.
 */
export async function claimTurnstileToken(db: DbOrTx, tokenHash: string, now: Date): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('Invalid token hash');
  const res = await db.execute(sql`
    INSERT INTO turnstile_redemptions (token_hash, redeemed_at, expires_at)
    VALUES (${tokenHash}, ${now}, ${new Date(now.getTime() + REDEMPTION_TTL_MS)})
    ON CONFLICT (token_hash) DO NOTHING`);
  return res.rowCount === 1;
}
