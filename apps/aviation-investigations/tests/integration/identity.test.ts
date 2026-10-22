/**
 * The anonymous AI gate (Turnstile + trial cookie → principal) and `GET /api/ai/status`
 * on the HTTP server, against aviation_test. Siteverify is the offline fake
 * (tests/support/fake-siteverify.ts); nothing calls Cloudflare or a model.
 *
 * The AI routes arrive with Task 16, so this file registers a test-only route that does
 * what they will do: the gate, then `admitPaidRequest`, then (here) an immediate
 * settlement so the next request is not held back by the in-flight limits.
 */
import { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config.js';
import { AiStatusResponseSchema, TURNSTILE_ACTION, type AiStatusResponse } from '../../shared/contracts/ai.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { createAiRuntime, type AiRuntime, type AiRuntimeConfig } from '../../server/ai/runtime.js';
import { buildApp } from '../../server/app.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { sendGateRefusal } from '../../server/identity/gate.js';
import { TRIAL_COOKIE_PLAIN, TRIAL_COOKIE_SECURE, type TrialCreationLimits } from '../../server/identity/trial.js';
import { TURNSTILE_DUMMY_TOKEN, TURNSTILE_TEST_SECRET_KEYS, TURNSTILE_TEST_SITE_KEYS, claimTurnstileToken } from '../../server/identity/turnstile.js';
import {
  admitPaidRequest,
  canonicalRequestHash,
  pruneControls,
  rejectionStatus,
  setAnonymousAi,
  settle,
} from '../../server/quota/index.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';
import { sqlState } from './corpus-helpers.js';
import { resetControls, testDb } from './helpers.js';

const IDENTITY_SECRET = 'test-identity-hmac-secret-0123456789';
const NETWORK_SECRET = 'test-network-hmac-secret-0123456789';
const HOST = 'casebook.example';
/** A fresh 30-day month: the paced allowance is $2.666666, the anonymous share $0.666666 (4 requests of $0.14). */
const T0 = new Date('2026-11-01T10:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const VISITOR = '203.0.113.7';

let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

let appDb: Db;
let ingest: Db;
let migrator: Db;
const es = new Client({ node: 'http://localhost:9' }); // never used: these routes read no index
const apps: FastifyInstance[] = [];

beforeAll(() => {
  appDb = testDb('app');
  ingest = testDb('ingest');
  migrator = testDb('migrator');
});

afterAll(async () => {
  await Promise.all([closeDb(appDb), closeDb(ingest), closeDb(migrator), es.close()]);
});

beforeEach(async () => {
  clock = T0;
  await resetControls();
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

function aiConfig(over: Partial<AiRuntimeConfig> = {}): AiRuntimeConfig {
  const base = loadConfig({ env: {}, files: [] });
  return {
    nodeEnv: 'test',
    appEnv: 'dev',
    appUrl: `https://${HOST}`,
    ai: { ...base.ai, llmProvider: 'fake' },
    auth: { identityHmacSecret: IDENTITY_SECRET, ipHmacSecret: NETWORK_SECRET },
    turnstile: { secretKey: REAL_SECRET, siteKey: REAL_SITE_KEY },
    ...over,
  };
}

interface Harness {
  app: FastifyInstance;
  ai: AiRuntime;
  sv: FakeSiteverify;
}

let keySeq = 0;

/** The server with its AI runtime, plus the test-only AI route `POST /api/test/ask`. */
function harness(opts: { config?: AiRuntimeConfig; trialLimits?: TrialCreationLimits } = {}): Harness {
  const config = opts.config ?? aiConfig();
  const sv = new FakeSiteverify(now, { hostname: HOST, action: TURNSTILE_ACTION });
  const ai = createAiRuntime(config, {
    db: appDb,
    turnstile: { fetch: sv.fetch, retryDelayMs: 0, attemptTimeoutMs: 200 },
    ...(opts.trialLimits ? { trialLimits: opts.trialLimits } : {}),
    now,
  });
  const app = buildApp({
    config: { appUrl: config.appUrl, trustedProxyCidrs: [] },
    db: appDb,
    es,
    ai,
    rateLimit: { limit: 100_000, windowMs: 60_000 },
  });
  // What Task 16's AI routes will do for an anonymous visitor.
  app.post('/api/test/ask', async (request, reply) => {
    const body = (request.body ?? {}) as { turnstileToken?: unknown; question?: string; gateOnly?: boolean };
    const pass = await ai.gate!.check(request, reply, body.turnstileToken);
    if (!pass.ok) return sendGateRefusal(reply, pass, now());
    if (body.gateOnly) return reply.send({ passed: true, trialStarted: pass.trialStarted });
    const admission = await admitPaidRequest(appDb, {
      policy: ai.policy!,
      principal: pass.principal,
      networkId: pass.networkId,
      idempotencyKey: `test-key-${++keySeq}`,
      requestHash: canonicalRequestHash({ question: body.question ?? 'carburetor icing in cruise' }),
      reservationUsd: ai.startup.reservationUsd!,
      now: now(),
    });
    if (!admission.ok) return reply.code(rejectionStatus(admission)).send({ rejected: admission.reason });
    if (admission.replay) return reply.send({ replay: true });
    await settle(appDb, admission, admission.reservationUsd, admission.fencingToken, now());
    return reply.send({ admitted: true, trialStarted: pass.trialStarted });
  });
  apps.push(app);
  return { app, ai, sv };
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
  body: string;
  setCookie: string | null;
  cacheControl: string | undefined;
}

async function ask(
  h: Harness,
  body: Record<string, unknown>,
  opts: { cookie?: string | null; from?: string } = {},
): Promise<Reply> {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/test/ask',
    payload: body,
    remoteAddress: opts.from ?? VISITOR,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });
  const setCookie = r.headers['set-cookie'];
  return {
    status: r.statusCode,
    json: JSON.parse(r.body) as Record<string, unknown>,
    body: r.body,
    setCookie: typeof setCookie === 'string' ? setCookie : null,
    cacheControl: r.headers['cache-control'] as string | undefined,
  };
}

async function status(h: Harness | FastifyInstance, cookie?: string | null): Promise<AiStatusResponse & { raw: string }> {
  const app = 'app' in h ? h.app : h;
  const r = await app.inject({ method: 'GET', url: '/api/ai/status', remoteAddress: VISITOR, headers: cookie ? { cookie } : {} });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.headers['set-cookie']).toBeUndefined();
  return { ...AiStatusResponseSchema.parse(JSON.parse(r.body)), raw: r.body };
}

/** `name=value` from a Set-Cookie header, as the browser would send it back. */
const cookieOf = (setCookie: string | null): string => {
  if (!setCookie) throw new Error('no Set-Cookie');
  return setCookie.split(';', 1)[0]!;
};

async function count(table: string): Promise<number> {
  const res = await migrator.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return (res.rows[0] as { n: number }).n;
}

async function nothingSpent(): Promise<void> {
  expect(await count('reservations')).toBe(0);
  expect(await count('leases')).toBe(0);
  expect(await count('cost_ledger')).toBe(0);
  expect(await count('trial_identities')).toBe(0);
}

const errorOf = (r: Reply) => ErrorResponseSchema.parse(r.json).error;

describe('anonymous gate', () => {
  it('missing token rejected before spend', async () => {
    const h = harness();
    for (const turnstileToken of [undefined, null, '']) {
      const r = await ask(h, { question: 'carburetor icing', ...(turnstileToken === undefined ? {} : { turnstileToken }) });
      expect(r.status).toBe(403);
      expect(errorOf(r)).toBe('challenge_required');
      expect(r.setCookie).toBeNull();
      expect(r.cacheControl).toBe('no-store');
    }
    // A malformed token is refused locally too.
    for (const turnstileToken of ['two words', 'x'.repeat(2049), 42, { token: 'x' }]) {
      const r = await ask(h, { turnstileToken });
      expect(r.status).toBe(403);
      expect(errorOf(r)).toBe('challenge_failed');
    }
    expect(h.sv.calls).toHaveLength(0);
    await nothingSpent();
    expect(await count('usage_buckets')).toBe(0);
    expect(await count('turnstile_redemptions')).toBe(0);
  });

  it('first Ask AI: a passed challenge creates the trial and a signed, host-only cookie', async () => {
    const h = harness();
    const first = await ask(h, { turnstileToken: h.sv.issue() });
    expect(first.json).toEqual({ admitted: true, trialStarted: true });
    expect(first.setCookie).toMatch(
      new RegExp(`^${TRIAL_COOKIE_SECURE}=v1\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure$`),
    );
    expect(first.cacheControl).toBe('no-store');
    const cookie = cookieOf(first.setCookie);
    const value = cookie.split('=', 2)[1]!;

    // Only a keyed HMAC of the cookie's random part is stored.
    const rows = (await migrator.execute(sql`SELECT id::text AS id, cookie_hash, requests_used FROM trial_identities`)).rows as {
      id: string;
      cookie_hash: string;
      requests_used: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cookie_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const part of value.split('.')) {
      expect(rows[0]!.cookie_hash).not.toContain(part);
      expect(value).not.toContain(rows[0]!.id);
    }
    expect(rows[0]!.requests_used).toBe(1);

    // The cookie brings the visitor back to the same trial; every request needs a fresh token.
    advance(MIN);
    const second = await ask(h, { turnstileToken: h.sv.issue() }, { cookie });
    expect(second.json).toEqual({ admitted: true, trialStarted: false });
    expect(second.setCookie).toBeNull();
    expect(await count('trial_identities')).toBe(1);
    expect(((await migrator.execute(sql`SELECT requests_used FROM trial_identities`)).rows[0] as { requests_used: number }).requests_used).toBe(2);
    expect(await count('reservations')).toBe(2);
  });

  it('reused token rejected', async () => {
    const h = harness();
    const token = h.sv.issue();
    const first = await ask(h, { turnstileToken: token });
    expect(first.json).toEqual({ admitted: true, trialStarted: true });
    const cookie = cookieOf(first.setCookie);
    advance(MIN);
    for (const c of [cookie, null]) {
      const again = await ask(h, { turnstileToken: token }, { cookie: c });
      expect(again.status).toBe(403);
      expect(errorOf(again)).toBe('challenge_failed');
      expect(again.setCookie).toBeNull();
    }
    // Refused from the local record, before Cloudflare is asked again.
    expect(h.sv.calls).toHaveLength(1);
    expect(await count('reservations')).toBe(1);
    expect(await count('trial_identities')).toBe(1);

    // Two concurrent requests with one fresh token: exactly one goes on.
    const shared = h.sv.issue();
    const both = await Promise.all([
      ask(h, { turnstileToken: shared, gateOnly: true }, { from: '198.51.100.1' }),
      ask(h, { turnstileToken: shared, gateOnly: true }, { from: '198.51.100.2' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(h.sv.calls).toHaveLength(2);
    expect(await count('trial_identities')).toBe(2);
  });

  it('a token Cloudflare reports as used or expired is rejected before spend', async () => {
    const h = harness();
    // Reused elsewhere: Cloudflare already redeemed it (timeout-or-duplicate).
    const token = h.sv.issue();
    await h.sv.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: REAL_SECRET, response: token }).toString(),
    });
    const used = await ask(h, { turnstileToken: token });
    expect([used.status, errorOf(used)]).toEqual([403, 'challenge_failed']);
    const expired = await ask(h, { turnstileToken: h.sv.issue({ solvedAt: new Date(T0.getTime() - 5 * MIN - 1_000) }) });
    expect([expired.status, errorOf(expired)]).toEqual([403, 'challenge_failed']);
    await nothingSpent();
  });

  it('trial cookie not created on failed challenge', async () => {
    const h = harness();
    const failing = [
      h.sv.issue({ hostname: 'attacker.example' }),
      h.sv.issue({ action: 'signup' }),
      '0.never-issued-by-turnstile',
      TURNSTILE_DUMMY_TOKEN, // a real secret rejects the test widget's dummy token
    ];
    for (const turnstileToken of failing) {
      const r = await ask(h, { turnstileToken });
      expect(r.status).toBe(403);
      expect(errorOf(r)).toBe('challenge_failed');
      expect(r.setCookie).toBeNull();
    }
    // Cloudflare's always-failing and token-spent test secrets.
    for (const secretKey of TURNSTILE_TEST_SECRET_KEYS.slice(1)) {
      const t = harness({ config: aiConfig({ turnstile: { secretKey, siteKey: TURNSTILE_TEST_SITE_KEYS[1]! } }) });
      const r = await ask(t, { turnstileToken: TURNSTILE_DUMMY_TOKEN });
      expect([r.status, errorOf(r), r.setCookie]).toEqual([403, 'challenge_failed', null]);
    }
    await nothingSpent();
    expect(await count('usage_buckets')).toBe(0);
  });

  it("Cloudflare's always-passing test keys: the dummy token passes repeatedly, other tokens stay single-use", async () => {
    const h = harness({
      config: aiConfig({ appUrl: 'http://localhost:3000', turnstile: { secretKey: TURNSTILE_TEST_SECRET_KEYS[0]!, siteKey: TURNSTILE_TEST_SITE_KEYS[0]! } }),
    });
    expect(h.ai.gate?.testKeys).toBe(true);
    const first = await ask(h, { turnstileToken: TURNSTILE_DUMMY_TOKEN });
    expect(first.json).toEqual({ admitted: true, trialStarted: true });
    // Plain http (local development): no Secure attribute, no __Host- prefix.
    expect(first.setCookie).toMatch(new RegExp(`^${TRIAL_COOKIE_PLAIN}=v1\\.[^;]+; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax$`));
    advance(MIN);
    const second = await ask(h, { turnstileToken: TURNSTILE_DUMMY_TOKEN }, { cookie: cookieOf(first.setCookie) });
    expect(second.json).toEqual({ admitted: true, trialStarted: false });
    const other = 'test-widget-token';
    expect((await ask(h, { turnstileToken: other, gateOnly: true })).status).toBe(200);
    expect(errorOf(await ask(h, { turnstileToken: other, gateOnly: true }))).toBe('challenge_failed');
  });

  it('siteverify unreachable or failing fails closed with 503 and nothing spent', async () => {
    const h = harness();
    for (const failure of ['network', 'timeout', 'http500', 'internal-error'] as const) {
      h.sv.fail(failure, failure);
      const r = await ask(h, { turnstileToken: h.sv.issue() });
      expect(r.status, failure).toBe(503);
      expect(errorOf(r)).toBe('unavailable');
      expect(r.setCookie).toBeNull();
    }
    h.sv.fail('malformed');
    expect((await ask(h, { turnstileToken: h.sv.issue() })).status).toBe(503);
    await nothingSpent();

    // A visitor with a trial is refused the same way; the trial keeps its searches.
    const ok = await ask(h, { turnstileToken: h.sv.issue() });
    const cookie = cookieOf(ok.setCookie);
    advance(MIN);
    h.sv.fail('network', 'network');
    expect((await ask(h, { turnstileToken: h.sv.issue() }, { cookie })).status).toBe(503);
    expect(await count('reservations')).toBe(1);

    // A Turnstile secret Cloudflare does not accept is our fault: 503, not 403.
    const wrong = harness({ config: aiConfig({ turnstile: { secretKey: 'not-the-secret', siteKey: REAL_SITE_KEY } }) });
    expect((await ask(wrong, { turnstileToken: wrong.sv.issue() })).status).toBe(503);
  });

  it('tampered, foreign and expired cookies are ignored, never trusted', async () => {
    const h = harness();
    const first = await ask(h, { turnstileToken: h.sv.issue() });
    const cookie = cookieOf(first.setCookie);
    const [name, value] = cookie.split('=') as [string, string];
    const tampered = `${name}=${value.slice(0, -2)}${value.endsWith('A') ? 'BB' : 'AA'}`;
    // A genuine cookie of another deployment (another IDENTITY_HMAC_SECRET).
    const other = harness({ config: aiConfig({ auth: { identityHmacSecret: 'another-identity-secret-0123456789', ipHmacSecret: NETWORK_SECRET } }) });
    const foreign = cookieOf((await ask(other, { turnstileToken: other.sv.issue() }, { from: '198.51.100.9' })).setCookie);
    for (const bad of [tampered, foreign, `${name}=garbage`, `${TRIAL_COOKIE_PLAIN}=${value}`]) {
      expect((await status(h, bad)).remaining).toEqual({ kind: 'trial', left: 3, limit: 3, started: false });
      advance(MIN);
      const r = await ask(h, { turnstileToken: h.sv.issue(), gateOnly: true }, { cookie: bad });
      expect(r.json).toEqual({ passed: true, trialStarted: true });
      expect(cookieOf(r.setCookie)).not.toBe(cookie);
    }
    // After 30 days the trial is gone for the cookie as well.
    expect((await status(h, cookie)).remaining).toEqual({ kind: 'trial', left: 2, limit: 3, started: true });
    advance(30 * DAY);
    expect((await status(h, cookie)).remaining).toEqual({ kind: 'trial', left: 3, limit: 3, started: false });
    const renewed = await ask(h, { turnstileToken: h.sv.issue(), gateOnly: true }, { cookie });
    expect(renewed.json).toEqual({ passed: true, trialStarted: true });
  });

  it('trial creation is capped per network and per day', async () => {
    const h = harness({ trialLimits: { perNetworkHour: 2, perNetworkDay: 3, globalDay: 4 } });
    const start = (from: string) => ask(h, { turnstileToken: h.sv.issue(), gateOnly: true }, { from });
    expect((await start('198.51.100.1')).json).toEqual({ passed: true, trialStarted: true });
    expect((await start('198.51.100.1')).json).toEqual({ passed: true, trialStarted: true });
    const capped = await start('198.51.100.1');
    expect(capped.status).toBe(429);
    // Until the hour ends (T0 is 10:00 UTC).
    expect(capped.json).toMatchObject({ error: 'rate_limited', retryAfter: 3_600 });
    expect(capped.setCookie).toBeNull();
    expect(await count('trial_identities')).toBe(2);
    // IPv6 visitors are counted per /64.
    expect((await start('2001:db8:1:2::1')).status).toBe(200);
    expect((await start('2001:db8:1:2::ffff')).status).toBe(200);
    // The daily total: 4 trials exist.
    expect((await start('2001:db8:9::1')).status).toBe(429);
    advance(14 * 60 * MIN);
    expect((await start('198.51.100.1')).status).toBe(200);
    expect(await count('trial_identities')).toBe(5);
    // Only network HMACs are stored.
    const subjects = (await migrator.execute(sql`SELECT subject FROM usage_buckets`)).rows.map((r) => (r as { subject: string }).subject);
    expect(subjects.join(' ')).not.toMatch(/198\.51|2001:db8/);
  });

  it('login-required mode refuses anonymous AI before the challenge', async () => {
    const h = harness();
    const ok = await ask(h, { turnstileToken: h.sv.issue() });
    const cookie = cookieOf(ok.setCookie);
    const calls = h.sv.calls.length;
    // Only the operator role switches it.
    expect(await sqlState(setAnonymousAi(appDb, false))).toBe('42501');
    await setAnonymousAi(ingest, false, 'abuse wave');

    const refused = await ask(h, { turnstileToken: h.sv.issue() }, { cookie });
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toBe('sign_in_required');
    expect(h.sv.calls).toHaveLength(calls);
    for (const c of [cookie, null]) {
      const s = await status(h, c);
      expect([s.state, 'reason' in s ? s.reason : null, 'retryAt' in s]).toEqual(['signed_in_only', 'login_required', false]);
    }
    // Admission refuses trial principals too, counting nothing.
    const trial = (await migrator.execute(sql`SELECT id::text AS id FROM trial_identities`)).rows[0] as { id: string };
    const admission = await admitPaidRequest(appDb, {
      policy: h.ai.policy!,
      principal: { kind: 'trial', id: trial.id },
      networkId: VISITOR,
      idempotencyKey: 'login-required-1',
      requestHash: canonicalRequestHash({ question: 'q' }),
      reservationUsd: 0.14,
      now: now(),
    });
    expect(admission).toEqual({ ok: false, reason: 'login_required' });
    expect(rejectionStatus(admission as { ok: false; reason: 'login_required' })).toBe(403);
    expect(await count('reservations')).toBe(1);

    await setAnonymousAi(ingest, true);
    advance(MIN);
    expect((await ask(h, { turnstileToken: h.sv.issue() }, { cookie })).json).toEqual({ admitted: true, trialStarted: false });
  });
});

describe('GET /api/ai/status', () => {
  it('status returns signed_in_only when anonymous share exhausted', async () => {
    const h = harness();
    expect(await status(h)).toMatchObject({ state: 'available', remaining: { kind: 'trial', left: 3, limit: 3, started: false } });

    // Four visitors use the anonymous share of today's paced allowance ($0.56 of $0.67).
    const cookies: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await ask(h, { turnstileToken: h.sv.issue() }, { from: `198.51.100.${i}` });
      expect(r.json, `visitor ${i}`).toEqual({ admitted: true, trialStarted: true });
      cookies.push(cookieOf(r.setCookie));
    }
    const fresh = await status(h);
    expect(fresh).toEqual({
      state: 'signed_in_only',
      reason: 'anonymous_share',
      retryAt: '2026-11-02T00:00:00.000Z',
      remaining: { kind: 'trial', left: 3, limit: 3, started: false },
      raw: fresh.raw,
    });
    const returning = await status(h, cookies[0]);
    expect(returning).toMatchObject({ state: 'signed_in_only', reason: 'anonymous_share', remaining: { left: 2, started: true } });
    // No amounts, ever.
    for (const body of [fresh.raw, returning.raw]) expect(body).not.toMatch(/usd|budget|spend|amount|cost|0\.14|0\.5|0\.6|2\.6/i);

    // Admission agrees: the next anonymous request is refused before any reservation.
    advance(MIN);
    const refused = await ask(h, { turnstileToken: h.sv.issue() }, { cookie: cookies[0], from: '198.51.100.1' });
    expect([refused.status, refused.json]).toEqual([429, { rejected: 'anonymous_share_exhausted' }]);
    expect(await count('reservations')).toBe(4);

    // A new day brings the free searches back.
    advance(DAY);
    expect(await status(h)).toMatchObject({ state: 'available' });
  });

  it('reports the trial: searches left, then trial used', async () => {
    const h = harness();
    let cookie: string | null = null;
    for (let i = 1; i <= 3; i++) {
      const r = await ask(h, { turnstileToken: h.sv.issue() }, { cookie });
      expect(r.json).toMatchObject({ admitted: true });
      cookie ??= cookieOf(r.setCookie);
      const s = await status(h, cookie);
      if (i < 3) expect(s).toMatchObject({ state: 'available', remaining: { kind: 'trial', left: 3 - i, limit: 3, started: true } });
      else expect(s).toMatchObject({ state: 'signed_in_only', reason: 'trial_used', remaining: { left: 0, started: true } });
      advance(MIN);
    }
    expect((await status(h, cookie)).raw).not.toMatch(/retryAt/);
    // A fourth request passes the gate (a fresh token) and is refused at admission.
    const fourth = await ask(h, { turnstileToken: h.sv.issue() }, { cookie });
    expect([fourth.status, fourth.json]).toEqual([429, { rejected: 'trial_exhausted' }]);
  });

  it('is paused with reason dependency when AI cannot run', async () => {
    const plain = buildApp({ config: { appUrl: `https://${HOST}`, trustedProxyCidrs: [] }, db: appDb, es });
    apps.push(plain);
    expect(await status(plain)).toMatchObject({ state: 'paused', reason: 'dependency', remaining: null });

    const noTurnstile = harness({ config: aiConfig({ turnstile: {} }) });
    expect(noTurnstile.ai.gate).toBeNull();
    expect(noTurnstile.ai.problems.join(' ')).toMatch(/TURNSTILE_SECRET_KEY/);
    expect(await status(noTurnstile)).toEqual(expect.objectContaining({ state: 'paused', reason: 'dependency', remaining: { kind: 'trial', left: 3, limit: 3, started: false } }));

    const noSecrets = harness({ config: aiConfig({ auth: {} }) });
    expect(noSecrets.ai.policy).toBeNull();
    expect(await status(noSecrets)).toMatchObject({ state: 'paused', reason: 'dependency', remaining: null });

    const noProvider = harness({ config: aiConfig({ ai: { ...aiConfig().ai, llmProvider: 'anthropic' } }) });
    expect(noProvider.ai.startup.enabled).toBe(false);
    expect(await status(noProvider)).toMatchObject({ state: 'paused', reason: 'dependency' });

    // The live environment refuses test keys and plain http.
    const live = harness({ config: aiConfig({ appEnv: 'live', turnstile: { secretKey: TURNSTILE_TEST_SECRET_KEYS[0]!, siteKey: TURNSTILE_TEST_SITE_KEYS[0]! } }) });
    expect(live.ai.gate).toBeNull();
    expect(harness({ config: aiConfig({ appEnv: 'live', appUrl: `http://${HOST}` }) }).ai.gate).toBeNull();
    expect(harness({ config: aiConfig({ appEnv: 'live' }) }).ai.gate).not.toBeNull();
  });

  it('is rate limited and needs a client address like every API route', async () => {
    const h = harness();
    const r = await h.app.inject({ method: 'GET', url: '/api/%61i/status', remoteAddress: VISITOR });
    expect(r.statusCode).toBe(200);
    const sv = new FakeSiteverify(now, { hostname: HOST, action: TURNSTILE_ACTION });
    const limitedAi = createAiRuntime(aiConfig(), { db: appDb, turnstile: { fetch: sv.fetch }, now });
    const limited = buildApp({ config: { appUrl: `https://${HOST}`, trustedProxyCidrs: [] }, db: appDb, es, ai: limitedAi, rateLimit: { limit: 1, windowMs: 60_000 } });
    apps.push(limited);
    expect((await limited.inject({ method: 'GET', url: '/api/ai/status', remoteAddress: VISITOR })).statusCode).toBe(200);
    expect((await limited.inject({ method: 'GET', url: '/api/ai/status', remoteAddress: VISITOR })).statusCode).toBe(429);
  });
});

describe('storage', () => {
  it('redeemed tokens: the app only inserts, ingest cannot read them, retention prunes them', async () => {
    const hash = 'a'.repeat(64);
    const old = new Date(Date.now() - 2 * DAY);
    expect(await claimTurnstileToken(appDb, hash, old)).toBe(true);
    expect(await claimTurnstileToken(appDb, hash, new Date())).toBe(false);
    expect(await sqlState(appDb.execute(sql`UPDATE turnstile_redemptions SET expires_at = now()`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`DELETE FROM turnstile_redemptions`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM turnstile_redemptions`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`INSERT INTO turnstile_redemptions VALUES ('not-a-hash', now(), now() + interval '1 minute')`))).toBe('23514');
    expect(await claimTurnstileToken(appDb, 'b'.repeat(64), new Date())).toBe(true);
    const report = await pruneControls(appDb);
    expect(report.turnstileRedemptions).toBe(1);
    expect(await count('turnstile_redemptions')).toBe(1);
  });

  it('trial rows need a cookie hash; aviation_ingest cannot read them', async () => {
    expect(
      await sqlState(appDb.execute(sql`INSERT INTO trial_identities (cookie_hash, created_at, expires_at) VALUES ('raw-cookie', now(), now() + interval '1 day')`)),
    ).toBe('23514');
    expect(
      await sqlState(appDb.execute(sql`INSERT INTO trial_identities (created_at, expires_at) VALUES (now(), now() + interval '1 day')`)),
    ).toBe('23502');
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM trial_identities`))).toBe('42501');
  });
});
