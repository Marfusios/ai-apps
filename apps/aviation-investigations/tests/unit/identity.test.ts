/**
 * The anonymous identity layer offline: trial cookie codec, derived keys, Turnstile
 * verification against a fake siteverify (Cloudflare's documented test-key behaviour
 * included), Turnstile configuration rules and the AI status contract.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../shared/config.js';
import { AI_STATUS_REASONS, AiStatusResponseSchema, TURNSTILE_ACTION } from '../../shared/contracts/ai.js';
import { turnstileConfigProblem } from '../../server/ai/runtime.js';
import { deriveIdentityKey, keyedHash } from '../../server/identity/keys.js';
import { TRIAL_COOKIE_PLAIN, TRIAL_COOKIE_SECURE, TrialCookieCodec, cookieValues } from '../../server/identity/trial.js';
import {
  TURNSTILE_DUMMY_TOKEN,
  TURNSTILE_TEST_SECRET_KEYS,
  TURNSTILE_TEST_SITE_KEYS,
  TurnstileVerifier,
  isWellFormedToken,
  type TurnstileVerifierOptions,
} from '../../server/identity/turnstile.js';
import { QuotaConfigError } from '../../server/quota/policy.js';
import { toStatusResponse } from '../../server/routes/ai-status.js';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';

const SECRET = 'unit-test-identity-hmac-secret-0123456789';
const OTHER_SECRET = 'another-identity-hmac-secret-0123456789ab';
const HOST = 'casebook.example';
const T0 = new Date('2026-11-01T10:00:00Z');

describe('derived identity keys', () => {
  it('differ per purpose and per secret, and refuse a short secret', () => {
    const a = deriveIdentityKey(SECRET, 'trial-cookie-signature');
    const b = deriveIdentityKey(SECRET, 'trial-cookie-lookup');
    const c = deriveIdentityKey(SECRET, 'turnstile-token');
    expect(new Set([a.toString('hex'), b.toString('hex'), c.toString('hex')]).size).toBe(3);
    expect(deriveIdentityKey(OTHER_SECRET, 'trial-cookie-lookup').equals(b)).toBe(false);
    expect(a.length).toBe(32);
    expect(keyedHash(a, 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(() => deriveIdentityKey('short', 'turnstile-token')).toThrow(QuotaConfigError);
    expect(() => deriveIdentityKey('', 'turnstile-token')).toThrow(QuotaConfigError);
  });
});

describe('trial cookie', () => {
  const codec = new TrialCookieCodec(SECRET, { secure: true });

  it('round-trips, and the stored hash is neither the value nor its random part', () => {
    const { value, cookieHash } = codec.issue();
    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(codec.verify(value)).toBe(cookieHash);
    expect(cookieHash).toMatch(/^[0-9a-f]{64}$/);
    const id = value.split('.')[1]!;
    expect(cookieHash).not.toContain(id);
    expect(Buffer.from(id, 'base64url').toString('hex')).not.toBe(cookieHash);
    expect(codec.issue().value).not.toBe(value);
  });

  it('ignores tampered, foreign and malformed values', () => {
    const { value } = codec.issue();
    const [v, id, mac] = value.split('.') as [string, string, string];
    const flip = (s: string) => `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`;
    expect(codec.verify(`${v}.${flip(id)}.${mac}`)).toBeNull();
    expect(codec.verify(`${v}.${id}.${flip(mac)}`)).toBeNull();
    expect(codec.verify(`v2.${id}.${mac}`)).toBeNull();
    expect(codec.verify(`${value}x`)).toBeNull();
    expect(codec.verify('')).toBeNull();
    expect(codec.verify(`${v}.${id}`)).toBeNull();
    expect(codec.verify(`${v}.${id}.${mac.slice(0, 42)}=`)).toBeNull();
    expect(new TrialCookieCodec(OTHER_SECRET, { secure: true }).verify(value)).toBeNull();
  });

  it('is HttpOnly, SameSite=Lax, host-only and Secure with the __Host- prefix over https', () => {
    const secure = codec.setCookie('v1.a.b', 30 * 86_400);
    expect(secure).toBe(`${TRIAL_COOKIE_SECURE}=v1.a.b; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(secure).not.toMatch(/domain=/i);
    const plain = new TrialCookieCodec(SECRET, { secure: false });
    expect(plain.name).toBe(TRIAL_COOKIE_PLAIN);
    expect(plain.setCookie('v1.a.b', 10.9)).toBe(`${TRIAL_COOKIE_PLAIN}=v1.a.b; Max-Age=10; Path=/; HttpOnly; SameSite=Lax`);
  });

  it('reads only cookies of its own name from the header', () => {
    expect(cookieValues(undefined, 'a')).toEqual([]);
    expect(cookieValues('a=1; b=2;a=3 ; ab=4; =5; a', 'a')).toEqual(['1', '3']);
    expect(cookieValues('x=1; aviation_trial=v; __Host-aviation_trial=w', TRIAL_COOKIE_SECURE)).toEqual(['w']);
    expect(cookieValues(Array.from({ length: 10 }, (_, i) => `a=${i}`).join('; '), 'a')).toHaveLength(4);
  });
});

describe('Turnstile verification', () => {
  const now = () => T0;
  const fake = () => new FakeSiteverify(now, { hostname: HOST, action: TURNSTILE_ACTION });
  const verifier = (sv: FakeSiteverify, opts: Partial<TurnstileVerifierOptions> = {}) =>
    new TurnstileVerifier({
      secretKey: REAL_SECRET,
      expectedHostname: HOST,
      expectedAction: TURNSTILE_ACTION,
      fetch: sv.fetch,
      retryDelayMs: 0,
      attemptTimeoutMs: 200,
      now,
      ...opts,
    });

  it('accepts a fresh token for this hostname and action, once', async () => {
    const sv = fake();
    const v = verifier(sv);
    const token = sv.issue();
    expect(await v.verify(token)).toEqual({ ok: true, testKey: false });
    expect(await v.verify(token)).toEqual({ ok: false, kind: 'rejected', reason: 'expired_or_used' });
    expect(sv.calls).toHaveLength(2);
    // A fresh idempotency key per verification; the visitor's address is not sent.
    expect(sv.calls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sv.calls[1]!.idempotencyKey).not.toBe(sv.calls[0]!.idempotencyKey);
    expect(sv.calls.every((c) => c.remoteip === null && c.secret === REAL_SECRET)).toBe(true);
  });

  it('rejects another hostname, another action, an old challenge and unknown tokens', async () => {
    const sv = fake();
    const v = verifier(sv);
    expect(await v.verify(sv.issue({ hostname: 'evil.example' }))).toMatchObject({ kind: 'rejected', reason: 'hostname_mismatch' });
    expect(await v.verify(sv.issue({ action: 'login' }))).toMatchObject({ kind: 'rejected', reason: 'action_mismatch' });
    expect(await v.verify(sv.issue({ hostname: HOST.toUpperCase() }))).toEqual({ ok: true, testKey: false });
    // Cloudflare reports an expired token as timeout-or-duplicate.
    expect(await v.verify(sv.issue({ solvedAt: new Date(T0.getTime() - 301_000) }))).toMatchObject({
      kind: 'rejected',
      reason: 'expired_or_used',
    });
    expect(await v.verify('0.never-issued')).toMatchObject({ kind: 'rejected', reason: 'invalid_token' });
    expect(await v.verify(TURNSTILE_DUMMY_TOKEN)).toMatchObject({ kind: 'rejected', reason: 'invalid_token' });
    // A success with a challenge older than 5 minutes (+ skew), or from the future, is not trusted either.
    const late = verifier(sv, { now: () => new Date(T0.getTime() + 361_000) });
    expect(await late.verify(sv.issue())).toMatchObject({ kind: 'rejected', reason: 'stale_challenge' });
  });

  it('checks the challenge time of a success itself', async () => {
    const answer = (challenge_ts: string | undefined) =>
      (async () => Response.json({ success: true, hostname: HOST, action: TURNSTILE_ACTION, ...(challenge_ts ? { challenge_ts } : {}) })) as typeof fetch;
    const at = (ts: string | undefined) => verifier(fake(), { fetch: answer(ts) }).verify('0.token');
    expect(await at(new Date(T0.getTime() - 300_000).toISOString())).toEqual({ ok: true, testKey: false });
    expect(await at(new Date(T0.getTime() - 361_000).toISOString())).toMatchObject({ reason: 'stale_challenge' });
    expect(await at(new Date(T0.getTime() + 61_000).toISOString())).toMatchObject({ reason: 'stale_challenge' });
    expect(await at('yesterday')).toMatchObject({ reason: 'stale_challenge' });
    expect(await at(undefined)).toMatchObject({ reason: 'stale_challenge' });
  });

  it("behaves as Cloudflare's documented test secret keys", async () => {
    const sv = fake();
    const pass = verifier(sv, { secretKey: TURNSTILE_TEST_SECRET_KEYS[0]! });
    expect(pass.testKey).toBe(true);
    // Always passes (hostname example.com, no action: those checks do not apply to test keys).
    expect(await pass.verify(TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: true, testKey: true });
    expect(await pass.verify(TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: true, testKey: true });
    const fail = verifier(sv, { secretKey: TURNSTILE_TEST_SECRET_KEYS[1]! });
    expect(await fail.verify(TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: false, kind: 'rejected', reason: 'invalid_token' });
    const spent = verifier(sv, { secretKey: TURNSTILE_TEST_SECRET_KEYS[2]! });
    expect(await spent.verify(TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: false, kind: 'rejected', reason: 'expired_or_used' });
  });

  it('refuses malformed tokens without calling Cloudflare', async () => {
    const sv = fake();
    const v = verifier(sv);
    for (const t of ['', 'a b', 'x'.repeat(2049), 'café', 'line\nbreak']) {
      expect(await v.verify(t)).toEqual({ ok: false, kind: 'rejected', reason: 'invalid_token' });
    }
    expect(sv.calls).toHaveLength(0);
    expect(isWellFormedToken('x'.repeat(2048))).toBe(true);
    expect(isWellFormedToken(42)).toBe(false);
  });

  it('retries a lost or failed call once with the same idempotency key, then fails closed', async () => {
    const sv = fake();
    const v = verifier(sv);
    // The first attempt ran at Cloudflare but its answer was lost: the retry gets the same answer.
    sv.fail('lost');
    expect(await v.verify(sv.issue())).toEqual({ ok: true, testKey: false });
    expect(sv.calls[0]!.idempotencyKey).toBe(sv.calls[1]!.idempotencyKey);

    for (const failure of ['network', 'timeout', 'http500', 'internal-error'] as const) {
      sv.calls.length = 0;
      sv.fail(failure, failure);
      expect(await v.verify(sv.issue()), failure).toMatchObject({ ok: false, kind: 'unavailable' });
      expect(sv.calls, failure).toHaveLength(2);
      expect(sv.calls[0]!.idempotencyKey).toBe(sv.calls[1]!.idempotencyKey);
    }
    sv.calls.length = 0;
    sv.fail('timeout');
    expect(await v.verify(sv.issue())).toEqual({ ok: true, testKey: false });

    sv.fail('malformed');
    expect(await v.verify(sv.issue())).toEqual({ ok: false, kind: 'unavailable', reason: 'malformed_response' });
    expect(await verifier(sv, { secretKey: 'wrong-secret' }).verify(sv.issue())).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'secret_rejected',
    });
  });

  it('times out a hanging call', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error)))) as typeof fetch;
    const started = Date.now();
    expect(await verifier(fake(), { fetch: hang, attemptTimeoutMs: 50, attempts: 2 }).verify('0.token')).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('Turnstile configuration', () => {
  const base = { appEnv: 'dev' as const, appUrl: 'http://localhost:3000', turnstile: { secretKey: REAL_SECRET, siteKey: REAL_SITE_KEY } };
  const test = { secretKey: TURNSTILE_TEST_SECRET_KEYS[0]!, siteKey: TURNSTILE_TEST_SITE_KEYS[0]! };

  it('needs both keys, of one kind', () => {
    expect(turnstileConfigProblem(base)).toBeNull();
    expect(turnstileConfigProblem({ ...base, turnstile: test })).toBeNull();
    expect(turnstileConfigProblem({ ...base, turnstile: { secretKey: REAL_SECRET } })).toMatch(/must be set/);
    expect(turnstileConfigProblem({ ...base, turnstile: { siteKey: REAL_SITE_KEY } })).toMatch(/must be set/);
    expect(turnstileConfigProblem({ ...base, turnstile: { ...test, siteKey: REAL_SITE_KEY } })).toMatch(/both/);
    expect(turnstileConfigProblem({ ...base, appUrl: 'http://[::1]:3000' })).toMatch(/host/);
  });

  it('refuses test keys and plain http in live', () => {
    const live = { ...base, appEnv: 'live' as const, appUrl: 'https://casebook.example' };
    expect(turnstileConfigProblem(live)).toBeNull();
    expect(turnstileConfigProblem({ ...live, turnstile: test })).toMatch(/not allowed/);
    expect(turnstileConfigProblem({ ...live, appUrl: 'http://casebook.example' })).toMatch(/https/);
  });

  it('config defaults leave Turnstile unset', () => {
    const c = loadConfig({ env: {}, files: [] });
    expect(turnstileConfigProblem(c)).toMatch(/must be set/);
  });
});

/** Every object key reachable in a Zod schema. */
function schemaKeys(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const keys: string[] = [];
  const visit = (child: unknown): void => {
    if (child && typeof child === 'object' && '_zod' in child) keys.push(...schemaKeys(child as z.ZodType, seen));
  };
  if (def.type === 'object') {
    for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
      keys.push(key);
      visit(child);
    }
  }
  for (const field of ['element', 'innerType', 'in', 'out', 'schema', 'catchall']) visit(def[field]);
  for (const option of (def.options as unknown[] | undefined) ?? []) visit(option);
  return keys;
}

describe('AI status contract', () => {
  it('carries counts and coarse reasons only, never amounts', () => {
    const keys = schemaKeys(AiStatusResponseSchema);
    expect(new Set(keys)).toEqual(
      new Set(['state', 'reason', 'retryAt', 'remaining', 'kind', 'left', 'limit', 'started', 'leftToday', 'limitToday', 'leftThisMonth', 'limitThisMonth']),
    );
    expect(keys.join(' ')).not.toMatch(/usd|amount|budget|spend|cost|dollar|allowance/i);
    expect(AI_STATUS_REASONS).toHaveLength(9);
  });

  it('is strict, and each reason belongs to its state', () => {
    const fresh = AI_STATUS_SAMPLES.fresh;
    expect(AiStatusResponseSchema.safeParse(fresh).success).toBe(true);
    expect(AiStatusResponseSchema.safeParse({ ...fresh, budgetUsd: 3 }).success).toBe(false);
    expect(AiStatusResponseSchema.safeParse({ ...fresh, reason: 'trial_used' }).success).toBe(false);
    expect(AiStatusResponseSchema.safeParse({ state: 'paused', reason: 'trial_used', remaining: null }).success).toBe(false);
    expect(AiStatusResponseSchema.safeParse({ state: 'signed_in_only', reason: 'daily_budget', remaining: null }).success).toBe(false);
    expect(AiStatusResponseSchema.safeParse({ state: 'paused', remaining: null }).success).toBe(false);
    expect(AiStatusResponseSchema.safeParse({ state: 'paused', reason: 'daily_budget', retryAt: 'tomorrow', remaining: null }).success).toBe(false);
  });

  it('every mock sample satisfies it', () => {
    for (const [name, sample] of Object.entries(AI_STATUS_SAMPLES)) {
      const parsed = AiStatusResponseSchema.safeParse(sample);
      expect(parsed.success, `${name}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('maps aiStatus to the public form', () => {
    const trial = { kind: 'trial', left: 3, limit: 3 } as const;
    expect(toStatusResponse({ state: 'available', remaining: trial }, false)).toEqual({
      state: 'available',
      remaining: { ...trial, started: false },
    });
    expect(
      toStatusResponse({ state: 'signed_in_only', reason: 'anonymous_share', retryAt: new Date('2026-11-02T00:00:00Z'), remaining: trial }, true),
    ).toEqual({ state: 'signed_in_only', reason: 'anonymous_share', retryAt: '2026-11-02T00:00:00.000Z', remaining: { ...trial, started: true } });
    const account = { kind: 'account', leftToday: 0, limitToday: 5, leftThisMonth: 140, limitThisMonth: 150 } as const;
    expect(toStatusResponse({ state: 'paused', reason: 'daily_cap', retryAt: new Date('2026-11-02T00:00:00Z'), remaining: account }, false)).toEqual({
      state: 'paused',
      reason: 'daily_cap',
      retryAt: '2026-11-02T00:00:00.000Z',
      remaining: account,
    });
    expect(() => toStatusResponse({ state: 'paused', reason: 'trial_used', remaining: trial }, true)).toThrow();
  });
});
