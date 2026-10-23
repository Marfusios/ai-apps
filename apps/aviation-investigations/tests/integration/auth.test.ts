/**
 * Google sign-in, the account, the brief handover and account deletion (Task 20) on the
 * HTTP server against aviation_test, with Google mocked offline (tests/support/
 * mock-google.ts: the authorization endpoint the browser visits and the token endpoint
 * the server calls) and Cloudflare's siteverify faked (tests/support/fake-siteverify.ts).
 * Nothing calls Google, Cloudflare or a model.
 *
 * Briefs here never reach retrieval: their steps end at the scope stage (a static reply,
 * which gives the search back, or a billed scope failure, which counts), so the tests
 * read no index. A step that must still be running waits on a scope call the test holds.
 */
import { createHash } from 'node:crypto';
import { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { AccountResponseSchema, DELETE_REAUTH_PATH, RETURN_PATH_MAX } from '../../shared/contracts/account.js';
import { TURNSTILE_ACTION } from '../../shared/contracts/ai.js';
import { StartBriefResponseSchema, type StartBriefResponse } from '../../shared/contracts/briefs.js';
import { createFakeProvider, type FakeProvider, type FakeScript } from '../../server/ai/fake.js';
import type { ScopeOutput } from '../../server/ai/provider.js';
import { createAiRuntime, type AiRuntime } from '../../server/ai/runtime.js';
import { buildApp } from '../../server/app.js';
import { AUTH_IP_HEADER, AUTH_REAUTH_HEADER, GOOGLE_ISSUER, createAuthService, type AuthLog, type AuthService } from '../../server/auth/better-auth.js';
import { pruneAuth } from '../../server/auth/deletion.js';
import { accountLockKey } from '../../server/auth/lifecycle.js';
import { createBriefServices, type BriefServices } from '../../server/briefs/services.js';
import { failOrphanedSteps } from '../../server/briefs/store.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { SPEND_LOCK_KEY, accountIdentityHash } from '../../server/quota/policy.js';
import { FakeRetriever } from '../support/fake-retriever.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';
import { CookieJar, MockGoogle, type GoogleUser } from '../support/mock-google.js';
import { sqlState } from './corpus-helpers.js';
import { resetControls, testDb, testPool } from './helpers.js';

const IDENTITY_SECRET = 'test-identity-hmac-secret-0123456789';
const NETWORK_SECRET = 'test-network-hmac-secret-0123456789';
const AUTH_SECRET = 'test-better-auth-secret-0123456789abcdef';
const CLIENT_ID = 'casebook-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-google-client-secret';
const HOST = 'casebook.example';
const APP = `https://${HOST}`;
const CALLBACK = `${APP}/api/auth/callback/google`;
/** A fresh 30-day month, as in the identity tests: the paced allowances are stable. */
const T0 = new Date('2026-11-01T10:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const VISITOR = '203.0.113.21';

let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

let appDb: Db;
let ingest: Db;
let migrator: Db;
const es = new Client({ node: 'http://localhost:9' }); // never used: these routes read no index
/** These tests read no index: AI evidence is taken as available (no step reaches retrieval). */
const EVIDENCE = async () => ({ generationId: 1, passagesIndex: 'aviation-test-auth' });
const harnesses: Harness[] = [];
let google: MockGoogle;

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
  google = new MockGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: CALLBACK });
  vi.stubGlobal('fetch', google.fetch);
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.svc.settled();
    await h.app.close();
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Harness

type ConfigOver = { google?: boolean; appUrl?: string; authSecret?: string };

function config(over: ConfigOver = {}): AppConfig {
  const base = loadConfig({ env: {}, files: [] });
  const google = over.google ?? true;
  return {
    ...base,
    nodeEnv: 'test',
    appEnv: 'dev',
    appUrl: over.appUrl ?? APP,
    ai: { ...base.ai, llmProvider: 'fake' },
    auth: {
      identityHmacSecret: IDENTITY_SECRET,
      ipHmacSecret: NETWORK_SECRET,
      secret: over.authSecret ?? AUTH_SECRET,
      ...(google ? { googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET } : {}),
    },
    turnstile: { secretKey: REAL_SECRET, siteKey: REAL_SITE_KEY },
  };
}

interface Harness {
  app: FastifyInstance;
  ai: AiRuntime;
  auth: AuthService | null;
  sv: FakeSiteverify;
  llm: FakeProvider;
  svc: BriefServices;
  /** The server's log lines (JSON). */
  logs: string[];
}

interface HarnessOptions {
  config?: ConfigOver;
  rateLimits?: { signIn?: number; callback?: number; signOut?: number };
  /** The served passages contract the fake retriever asks for (it can hold retrieval). */
  served?: () => Promise<{ chunkerVersion: string }>;
}

function harness(script: FakeScript = {}, opts: HarnessOptions = {}): Harness {
  const cfg = config(opts.config);
  const sv = new FakeSiteverify(now, { hostname: new URL(cfg.appUrl).hostname, action: TURNSTILE_ACTION });
  const llm = createFakeProvider(script);
  const ai = createAiRuntime(cfg, { db: appDb, turnstile: { fetch: sv.fetch, retryDelayMs: 0, attemptTimeoutMs: 200 }, llm, now });
  let log: AuthLog | null = null;
  const signIn = createAuthService(cfg, {
    db: appDb,
    policy: ai.policy,
    trials: ai.trials,
    now,
    rateLimits: { signIn: 10_000, callback: 10_000, signOut: 10_000, ...opts.rateLimits },
    log: { info: (o, m) => log?.info(o, m), warn: (o, m) => log?.warn(o, m), error: (o, m) => log?.error(o, m) },
  });
  const svc = createBriefServices(appDb, { retriever: new FakeRetriever(appDb, { cases: [], served: opts.served ?? (async () => ({ chunkerVersion: 'none' })) }) });
  const logs: string[] = [];
  const app = buildApp({
    config: { appUrl: cfg.appUrl, trustedProxyCidrs: [] },
    db: appDb,
    es,
    ai,
    auth: signIn.service,
    briefs: svc,
    aiEvidence: EVIDENCE,
    logger: { level: 'debug', stream: { write: (line: string) => void logs.push(line) } },
    rateLimit: { limit: 100_000, windowMs: 60_000 },
  });
  log = app.log;
  const h = { app, ai, auth: signIn.service, sv, llm, svc, logs };
  harnesses.push(h);
  return h;
}

const scopeOut = (over: Partial<ScopeOutput> = {}): ScopeOutput => ({
  intent: 'out_of_scope',
  mechanicalCause: false,
  filters: {},
  keywordText: '',
  ...over,
});
/** A step that ends at once with a static reply: paid for, the search given back. */
const OFF_TOPIC = { output: scopeOut() };
/** A step that fails after the scope call was paid: it counts as a search. */
const REFUSED = { fail: 'refusal' as const };

// Requests ---------------------------------------------------------------------

interface Sent {
  status: number;
  json: unknown;
  headers: LightMyRequestResponse['headers'];
  setCookies: string[];
}

function setCookiesOf(r: LightMyRequestResponse): string[] {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** What a browser adds: `fetch` from the page (POST) or a navigation from Google (the callback). */
const BROWSER_POST = { origin: APP, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const NAVIGATION_FROM_GOOGLE = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

async function send(
  h: Harness,
  method: 'GET' | 'POST',
  url: string,
  opts: { jar?: CookieJar; body?: unknown; from?: string; headers?: Record<string, string> } = {},
): Promise<Sent> {
  const cookie = opts.jar?.header();
  const r = await h.app.inject({
    method,
    url,
    remoteAddress: opts.from ?? VISITOR,
    headers: { ...(method === 'POST' ? BROWSER_POST : {}), ...(cookie ? { cookie } : {}), ...opts.headers },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  const setCookies = setCookiesOf(r);
  opts.jar?.store(setCookies);
  let json: unknown = null;
  try {
    json = r.body ? JSON.parse(r.body) : null;
  } catch {
    json = r.body;
  }
  return { status: r.statusCode, json, headers: r.headers, setCookies };
}

const errorOf = (s: Sent) => [s.status, (s.json as { error?: string } | null)?.error];

const signInBody = (returnTo = '/') => ({
  provider: 'google',
  callbackURL: returnTo,
  newUserCallbackURL: `${returnTo}${returnTo.includes('?') ? '&' : '?'}welcome=1`,
  errorCallbackURL: `${returnTo}${returnTo.includes('?') ? '&' : '?'}signin=failed`,
  disableRedirect: true,
});

/** Start sign-in in this browser: Google's authorization URL (the state cookie is in the jar). */
async function startSignIn(h: Harness, jar: CookieJar, returnTo = '/', opts: { from?: string } = {}): Promise<string> {
  const r = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body: signInBody(returnTo), ...opts });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const url = (r.json as { url: string }).url;
  expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
  return url;
}

/** Google redirects the browser back: the callback's response. */
async function callback(h: Harness, jar: CookieJar, path: string, opts: { from?: string } = {}): Promise<Sent> {
  return send(h, 'GET', path, { jar, headers: NAVIGATION_FROM_GOOGLE, ...opts });
}

let userSeq = 0;
const newUser = (over: Partial<GoogleUser> = {}): GoogleUser => {
  userSeq += 1;
  return { sub: `10${String(userSeq).padStart(18, '0')}`, email: `pilot${userSeq}@example.com`, name: `Pilot ${userSeq}`, ...over };
};

/** Sign this browser in as `user` (from `returnTo`); returns the callback response. */
async function signIn(h: Harness, jar: CookieJar, user: GoogleUser, returnTo = '/'): Promise<Sent> {
  const url = await startSignIn(h, jar, returnTo);
  const back = await callback(h, jar, google.authorize(url, user));
  expect(back.status, JSON.stringify(back.headers.location)).toBe(302);
  return back;
}

async function account(h: Harness, jar: CookieJar) {
  const r = await send(h, 'GET', '/api/account', { jar });
  expect(r.status).toBe(200);
  return AccountResponseSchema.parse(r.json);
}

/** Ask a question; anonymous visitors take a check (a fresh Turnstile token). */
async function ask(h: Harness, jar: CookieJar, question = 'Engine power loss after maintenance', opts: { key?: string; token?: boolean } = {}) {
  const r = await send(h, 'POST', '/api/briefs', {
    jar,
    body: { question, idempotencyKey: opts.key ?? key(), ...(opts.token === false ? {} : { turnstileToken: h.sv.issue() }) },
  });
  if (r.status < 300) StartBriefResponseSchema.parse(r.json);
  return r as Sent & { json: StartBriefResponse };
}

async function refine(h: Harness, jar: CookieJar, briefId: string, text: string, opts: { key?: string; token?: boolean } = {}) {
  const r = await send(h, 'POST', `/api/briefs/${briefId}/refine`, {
    jar,
    body: { kind: 'text', text, idempotencyKey: opts.key ?? key(), ...(opts.token === false ? {} : { turnstileToken: h.sv.issue() }) },
  });
  if (r.status < 300) StartBriefResponseSchema.parse(r.json);
  return r as Sent & { json: StartBriefResponse };
}

let keySeq = 0;
const key = () => `auth-test-key-${++keySeq}`;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await migrator.execute(query)).rows as T[];
}
const count = async (table: string): Promise<number> => (await rows<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]!.n;

const accountHash = (sub: string) => accountIdentityHash(IDENTITY_SECRET, GOOGLE_ISSUER, sub);

/** The anti-abuse records, `retain_until` as an ISO instant. */
const abuseRecords = async () =>
  (await rows<{ identity_hash: string; ms: string }>(sql`
    SELECT identity_hash, (extract(epoch FROM retain_until) * 1000)::bigint AS ms FROM abuse_records ORDER BY identity_hash`)).map((r) => ({
    identity_hash: r.identity_hash,
    retain_until: new Date(Number(r.ms)).toISOString(),
  }));

const cookieNamed = (setCookies: string[], name: string) => setCookies.find((c) => c.startsWith(`${name}=`));

// ---------------------------------------------------------------------------

describe('Google sign-in', () => {
  it('signs in with Google: scopes, PKCE, state, nonce; stores only the subject, name and verified email', async () => {
    const h = harness();
    const jar = new CookieJar();
    const url = await startSignIn(h, jar, '/explore?q=icing');
    const asked = MockGoogle.parse(url);
    expect(new Set(asked.scopes)).toEqual(new Set(['openid', 'email', 'profile']));
    expect(asked).toMatchObject({
      responseType: 'code',
      clientId: CLIENT_ID,
      redirectUri: CALLBACK,
      codeChallengeMethod: 'S256',
      prompt: 'select_account',
      accessType: 'online',
      includeGrantedScopes: null,
      loginHint: null,
    });
    expect(asked.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(asked.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const user = newUser({ picture: 'https://example.com/me.png' });
    const back = await callback(h, jar, google.authorize(url, user));
    expect(back.status).toBe(302);
    // A new account comes back to the page it started from, with the welcome.
    expect(back.headers.location).toBe('/explore?q=icing&welcome=1');
    expect(await account(h, jar)).toEqual({ signedIn: true, user: { name: user.name, email: user.email } });
    // The code exchange carried the PKCE verifier and the client secret.
    expect(google.tokenRequests).toMatchObject([{ grantType: 'authorization_code', hasSecret: true, redirectUri: CALLBACK, status: 200 }]);

    const users = await rows(sql`SELECT name, email, email_verified, image FROM auth_users`);
    expect(users).toEqual([{ name: user.name, email: user.email, email_verified: true, image: null }]);
    const accounts = await rows(sql`
      SELECT provider_id, account_id, access_token, refresh_token, id_token, scope, password,
        access_token_expires_at, refresh_token_expires_at FROM auth_accounts`);
    expect(accounts).toEqual([
      {
        provider_id: 'google',
        account_id: user.sub,
        access_token: null,
        refresh_token: null,
        id_token: null,
        scope: null,
        password: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
      },
    ]);
    const sessions = await rows<{ ip_address: string | null; user_agent: string | null; days: number }>(sql`
      SELECT ip_address, user_agent, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM auth_sessions`);
    expect(sessions).toEqual([{ ip_address: null, user_agent: null, days: 7 }]);
    // The OAuth state never reached the database; its use is recorded as a hash.
    expect(await count('auth_verifications')).toBe(0);
    expect(await count('auth_state_uses')).toBe(1);

    // Signing in again: the same account, no welcome; a second session.
    const again = await signIn(h, jar, user, '/dashboard');
    expect(again.headers.location).toBe('/dashboard');
    expect(await count('auth_users')).toBe(1);
    expect(await count('auth_accounts')).toBe(1);
    expect(await count('auth_sessions')).toBe(2);
  });
});

const TRIAL = '__Host-aviation_trial';
const SESSION = '__Host-aviation_session';
/** The OAuth state: encrypted in this cookie (Better Auth's cookie strategy), never stored in the database. */
const STATE = '__Host-aviation_oauth_state';

/** A browser holding only this browser's trial cookie (signed out, or another profile with the cookie copied). */
function trialOnly(jar: CookieJar): CookieJar {
  const only = new CookieJar();
  const value = jar.get(TRIAL);
  if (!value) throw new Error('no trial cookie');
  only.set(TRIAL, value);
  return only;
}

const ownerOf = async (briefId: string) =>
  (await rows<{ read_owner: string; read_owner_kind: string; moved: boolean }>(sql`
    SELECT read_owner, read_owner_kind, owner_moved_at IS NOT NULL AS moved FROM briefs WHERE id = ${briefId}::uuid`))[0];

const stepsOf = async (briefId: string) =>
  rows<{ n: number; billing_principal: string; billing_kind: string }>(sql`
    SELECT n, billing_principal, billing_kind FROM brief_steps WHERE brief_id = ${briefId}::uuid ORDER BY n`);

const handoverLogs = (h: Harness) =>
  h.logs.map((l) => JSON.parse(l) as { msg?: string; handover?: string }).filter((l) => l.msg === 'sign-in handover').map((l) => l.handover);

/** Ask as the trial (a static reply, the search given back) and wait for the step. */
async function trialBrief(h: Harness, jar: CookieJar, opts: { key?: string } = {}) {
  const asked = await ask(h, jar, 'Write me a poem about the sea', opts);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  await h.svc.settled();
  const briefId = asked.json.briefId;
  return { briefId, trialHash: (await ownerOf(briefId))!.read_owner };
}

async function aiStatus(h: Harness, jar: CookieJar) {
  const r = await send(h, 'GET', '/api/ai/status', { jar });
  expect(r.status).toBe(200);
  return r.json as { state: string; remaining: Record<string, unknown> | null };
}

/**
 * Delete the signed-in account as the page does: confirm first (right after a sign-in no
 * other Google prompt is needed), then delete.
 */
async function deleteAccount(h: Harness, jar: CookieJar): Promise<Sent> {
  const start = await send(h, 'POST', '/api/account/delete/start', { jar, body: {} });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  return send(h, 'POST', '/api/account/delete', { jar, body: { confirm: true } });
}

// Races ------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A migrator transaction holding locks (`statement`): the app's statements that need them
 * wait until it commits. Always end it (`rollback` in a `finally`), or the next reset waits.
 */
async function holdLocks(statement: string) {
  const pool = testPool('migrator');
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(statement);
  let open = true;
  const end = async (how: 'COMMIT' | 'ROLLBACK') => {
    if (!open) return;
    open = false;
    try {
      await client.query(how);
    } finally {
      client.release();
      await pool.end();
    }
  };
  return {
    query: (text: string, values?: unknown[]) => client.query(text, values),
    /** The same transaction for the app's own functions (the maintenance pass's steps). */
    db: drizzle(client) as unknown as Db,
    commit: () => end('COMMIT'),
    rollback: () => end('ROLLBACK'),
  };
}

/** Until `n` sessions wait for a lock (requests paused at a held lock). */
async function untilBlocked(n = 1): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const waiting = (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`))[0]!.n;
    if (waiting >= n) return;
    await sleep(10);
  }
  throw new Error(`fewer than ${n} sessions waited for a held lock`);
}

/** Until `check` holds (polling). */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Account deletion as it commits, done by hand in a session that holds the locks a paused request waits for. */
async function deleteInLocker(locker: Awaited<ReturnType<typeof holdLocks>>, sub: string): Promise<void> {
  await locker.query('SELECT delete_account_content($1)', [accountHash(sub)]);
  await locker.query(`DELETE FROM auth_users WHERE id IN (SELECT user_id FROM auth_accounts WHERE account_id = $1)`, [sub]);
}

/** The reservations, in order: status, whether the search still counts, and the charge. */
const reservationsNow = () =>
  rows<{ principal_kind: string; status: string; quota_counted: boolean; charged: string | null }>(sql`
    SELECT principal_kind, status, quota_counted, charged_usd::text AS charged FROM reservations ORDER BY id`);

describe('sign-in protections', () => {
  it('cookies: host-only, HttpOnly, SameSite=Lax, Secure with __Host- names over https; sign-out expires the session', async () => {
    const h = harness();
    const jar = new CookieJar();
    const start = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body: signInBody('/') });
    const state = cookieNamed(start.setCookies, STATE);
    expect(state).toBeDefined();
    for (const attr of [/;\s*Max-Age=600(;|$)/i, /;\s*Path=\/(;|$)/i, /;\s*HttpOnly(;|$)/i, /;\s*Secure(;|$)/i, /;\s*SameSite=Lax(;|$)/i]) expect(state).toMatch(attr);
    expect(state).not.toMatch(/;\s*Domain=/i);
    // Encrypted: neither the nonce nor the state value is readable in it.
    const asked = MockGoogle.parse((start.json as { url: string }).url);
    expect(state).not.toContain(asked.nonce!);
    expect(state).not.toContain(asked.state!);
    expect(await count('auth_verifications')).toBe(0);
    const back = await callback(h, jar, google.authorize((start.json as { url: string }).url, newUser()));
    const session = cookieNamed(back.setCookies, SESSION);
    expect(session).toBeDefined();
    for (const attr of [/;\s*Max-Age=604800(;|$)/i, /;\s*Path=\/(;|$)/i, /;\s*HttpOnly(;|$)/i, /;\s*Secure(;|$)/i, /;\s*SameSite=Lax(;|$)/i]) expect(session).toMatch(attr);
    expect(session).not.toMatch(/;\s*Domain=/i);
    // The state cookie is spent at the callback; no other Better Auth cookie exists.
    expect(cookieNamed(back.setCookies, STATE)).toMatch(/Max-Age=0/i);
    expect(back.setCookies.map((c) => c.split('=', 1)[0]).sort()).toEqual([STATE, SESSION].sort());
    expect(back.headers['cache-control']).toBe('private, no-store');

    const out = await send(h, 'POST', '/api/auth/sign-out', { jar, body: {} });
    expect(out.status).toBe(200);
    expect(cookieNamed(out.setCookies, SESSION)).toMatch(/Max-Age=0/i);
    expect(await count('auth_sessions')).toBe(0);
    expect(await account(h, jar)).toEqual({ signedIn: false });
  });

  it('over plain http (local development) the names have no prefix and the cookies no Secure', async () => {
    const h = harness({}, { config: { appUrl: 'http://localhost:3000' } });
    const jar = new CookieJar();
    const start = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body: signInBody('/'), headers: { origin: 'http://localhost:3000' } });
    expect(start.status).toBe(200);
    const state = cookieNamed(start.setCookies, 'aviation_oauth_state');
    expect(state).toBeDefined();
    expect(state).not.toMatch(/;\s*Secure/i);
  });

  it('CSRF: cross-site and non-JSON requests are refused before Better Auth; a cookie-bearing request needs the app origin', async () => {
    const h = harness();
    const jar = new CookieJar();
    await signIn(h, jar, newUser());
    const crossSite = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body: signInBody('/'), headers: { 'sec-fetch-site': 'cross-site' } });
    expect(errorOf(crossSite)).toEqual([403, 'forbidden']);
    // A browser without fetch metadata: judged by its Origin.
    const evil = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      remoteAddress: VISITOR,
      headers: { cookie: jar.header()!, origin: 'https://evil.example' },
      payload: {},
    });
    expect([evil.statusCode, JSON.parse(evil.body).error]).toEqual([403, 'forbidden']);
    const form = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      remoteAddress: VISITOR,
      headers: { cookie: jar.header()!, origin: APP, 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(form.statusCode).toBe(400);
    // A tool that sends the cookie but no Origin or fetch metadata: Better Auth's own check refuses it.
    const bare = await h.app.inject({ method: 'POST', url: '/api/auth/sign-out', remoteAddress: VISITOR, headers: { cookie: jar.header()! }, payload: {} });
    expect(bare.statusCode).toBe(403);
    expect(await account(h, jar)).toMatchObject({ signedIn: true });
  });

  it('serves only the three endpoints it uses', async () => {
    const h = harness();
    const jar = new CookieJar();
    await signIn(h, jar, newUser());
    for (const [method, url] of [
      ['GET', '/api/auth/get-session'],
      ['GET', '/api/auth/list-sessions'],
      ['GET', '/api/auth/error'],
      ['GET', '/api/auth/ok'],
      ['GET', '/api/auth/callback/github?code=x&state=y'],
      ['GET', '/api/auth/sign-in/social'],
      ['POST', '/api/auth/callback/google'],
      ['POST', '/api/auth/sign-up/email'],
      ['POST', '/api/auth/sign-in/email'],
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/delete-user'],
      ['POST', '/api/auth/link-social'],
      ['POST', '/api/auth/revoke-sessions'],
      ['GET', '/api/auth/%73ign-out'],
    ] as const) {
      const r = await send(h, method, url, { jar, ...(method === 'POST' ? { body: { name: 'x', email: 'x@example.com', password: 'x' } } : {}) });
      expect(errorOf(r), `${method} ${url}`).toEqual([404, 'not_found']);
    }
  });

  it('the sign-in request has exactly the expected fields; return paths stay on this site', async () => {
    const h = harness();
    const jar = new CookieJar();
    const extra = [
      { ...signInBody('/'), idToken: { token: 'x.y.z' } },
      { ...signInBody('/'), scopes: ['https://www.googleapis.com/auth/drive'] },
      { ...signInBody('/'), additionalData: { briefId: 'x' } },
      { ...signInBody('/'), additionalParams: { hd: 'example.com' } },
      { ...signInBody('/'), loginHint: 'someone@example.com' },
      { ...signInBody('/'), provider: 'github' },
      { ...signInBody('/'), disableRedirect: false },
    ];
    for (const body of extra) {
      const r = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // Return paths off this site: Better Auth's own origin check refuses them first (403), else ours (400).
    const offSite = [
      { ...signInBody('/'), callbackURL: 'https://evil.example/' },
      { ...signInBody('/'), callbackURL: '//evil.example/x' },
      { ...signInBody('/'), errorCallbackURL: 'javascript:alert(1)' },
      { ...signInBody('/'), newUserCallbackURL: '/\\evil.example' },
      // `/.//evil.example/x` would resolve to the same-origin path `//evil.example/x`.
      signInBody('/.//evil.example/x'),
    ];
    for (const body of offSite) {
      const r = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body });
      expect([400, 403], JSON.stringify(body)).toContain(r.status);
    }
    expect(await count('auth_verifications')).toBe(0);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it('state: a callback without it, from another browser, with a forged one, twice, or after Google refused creates no session', async () => {
    const h = harness();
    const jar = new CookieJar();
    const user = newUser();
    // No state at all.
    const none = await callback(h, jar, '/api/auth/callback/google?code=4%2Fabc');
    expect(none.status).toBe(302);
    expect(none.headers.location).toBe('/account?signin=failed&error=state_not_found');

    // Another browser (without this flow's state cookie) brings the code back.
    const url = await startSignIn(h, jar, '/briefs-page');
    const path = google.authorize(url, user);
    const stranger = await callback(h, new CookieJar(), path);
    expect(stranger.status).toBe(302);
    expect(stranger.headers.location).toBe('/account?signin=failed&error=state_mismatch');
    // A state cookie that is not this server's encryption fails too.
    const forged = new CookieJar();
    forged.set(STATE, 'not-an-encrypted-state');
    expect((await callback(h, forged, path)).headers.location).toBe('/account?signin=failed&error=state_invalid');
    expect(google.tokenRequests).toHaveLength(0);

    // The browser that started it completes it once; a replay of the same callback fails.
    const ok = await callback(h, jar, path);
    expect(ok.headers.location).toBe('/briefs-page?welcome=1');
    expect(jar.get(STATE)).toBeUndefined();
    const replay = await callback(h, jar, path);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toMatch(/[?&]signin=failed&error=state_mismatch$/);
    expect(await count('auth_sessions')).toBe(1);

    // Google refused (the user cancelled): back to the page, no session.
    const other = new CookieJar();
    const url2 = await startSignIn(h, other, '/dashboard');
    const denied = await callback(h, other, google.deny(url2));
    expect(denied.headers.location).toBe('/dashboard?signin=failed&error=access_denied');
    expect(await account(h, other)).toEqual({ signedIn: false });
    expect(await count('auth_sessions')).toBe(1);
  });

  it('the encrypted state cookie stays within a browser’s 4096 bytes for the longest return paths and a handover', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId } = await trialBrief(h, browser);
    // The longest return path the contract allows once sign-in adds its own parameter.
    const base = `/briefs/${briefId}?q=`;
    const longest = `${base}${'x'.repeat(RETURN_PATH_MAX - '&signin=failed'.length - base.length)}`;
    const r = await send(h, 'POST', '/api/auth/sign-in/social', { jar: browser, body: signInBody(longest) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const cookie = cookieNamed(r.setCookies, STATE)!;
    const pair = cookie.split(';', 1)[0]!;
    expect(pair.length).toBeLessThan(4000);
    // One character more is refused before anything is set.
    const tooLong = await send(h, 'POST', '/api/auth/sign-in/social', { jar: new CookieJar(), body: signInBody(`${longest}x`) });
    expect([400, 403]).toContain(tooLong.status);
  });

  it('no client can make the state cookie wider than 4 KB: return paths are capped in bytes (Task 20 review N8)', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId } = await trialBrief(h, browser);
    const body = (fill: string) => {
      const base = `/briefs/${briefId}?q=`;
      const path = `${base}${fill.repeat(RETURN_PATH_MAX - base.length)}`;
      return { provider: 'google', callbackURL: path, newUserCallbackURL: path, errorCallbackURL: path, disableRedirect: true };
    };
    // A hand-made request with all three paths at the cap, and a handover candidate.
    const widest = await send(h, 'POST', '/api/auth/sign-in/social', { jar: browser, body: body('x') });
    expect(widest.status, JSON.stringify(widest.json)).toBe(200);
    expect(cookieNamed(widest.setCookies, STATE)!.split(';', 1)[0]!.length).toBeLessThan(4000);
    // Characters wider in the cookie are refused (by this app's check or Better Auth's), and nothing is set.
    for (const fill of ['"', '\u20ac', '\\']) {
      const refused = await send(h, 'POST', '/api/auth/sign-in/social', { jar: new CookieJar(), body: body(fill) });
      expect([400, 403], JSON.stringify(fill)).toContain(refused.status);
      expect(cookieNamed(refused.setCookies, STATE), JSON.stringify(fill)).toBeUndefined();
    }
  });

  it('a callback is used once: a second one with the same state is refused before a user or a session, even if Google redeemed its code again', async () => {
    const h = harness();
    const jar = new CookieJar();
    const url = await startSignIn(h, jar, '/dashboard');
    const path = google.authorize(url, newUser());
    // A provider that would redeem the code twice: only the state's claim stops the second.
    google.singleUseCodes = false;
    const [a, b] = await Promise.all([callback(h, jar.clone(), path), callback(h, jar.clone(), path)]);
    expect([String(a.headers.location), String(b.headers.location)].sort()).toEqual([
      '/dashboard?signin=failed&error=unable_to_get_user_info',
      '/dashboard?welcome=1',
    ]);
    expect(google.tokenRequests.filter((t) => t.status === 200)).toHaveLength(2);
    expect(await count('auth_users')).toBe(1);
    expect(await count('auth_sessions')).toBe(1);
    expect(h.logs.some((l) => (JSON.parse(l) as { signIn?: string }).signIn === 'state_reused')).toBe(true);
    // A SHA-256 of the state is kept until the state would have expired; never the state.
    expect(await rows(sql`SELECT state_hash FROM auth_state_uses`)).toEqual([
      { state_hash: createHash('sha256').update(MockGoogle.parse(url).state!).digest('hex') },
    ]);
    // With Google's single-use codes, ten together: one session.
    google.singleUseCodes = true;
    const jar2 = new CookieJar();
    const path2 = google.authorize(await startSignIn(h, jar2, '/'), newUser());
    const all = await Promise.all(Array.from({ length: 10 }, () => callback(h, jar2.clone(), path2)));
    expect(all.filter((r) => r.headers.location === '/?welcome=1')).toHaveLength(1);
    expect(await count('auth_sessions')).toBe(2);
  });

  it('a flood of sign-in starts from one /48 writes nothing and holds up neither another network nor a deletion re-authentication', async () => {
    const h = harness({}, { rateLimits: { signIn: 10 } });
    // Better Auth's limiter keeps its counts per process: the owner signs in from an address no other test uses.
    const owner = new CookieJar();
    const ownerUrl = await startSignIn(h, owner, '/', { from: '192.0.2.201' });
    await callback(h, owner, google.authorize(ownerUrl, newUser()), { from: '192.0.2.201' });
    expect(await account(h, owner)).toMatchObject({ signedIn: true });
    // Deleting needs Google again: the owner's sign-in is older than 5 minutes.
    await ageSessions(10);
    const statuses: Record<number, number> = {};
    for (let n = 0; n < 50; n++) {
      for (let i = 0; i < 10; i++) {
        const r = await send(h, 'POST', '/api/auth/sign-in/social', { jar: new CookieJar(), body: signInBody('/'), from: `2001:db8:abcd:${n.toString(16)}::1` });
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      }
    }
    expect(statuses).toEqual({ 200: 500 });
    // Nothing was written for them: there is no store of pending sign-ins to fill.
    expect(await count('auth_verifications')).toBe(0);
    expect(await count('auth_state_uses')).toBe(1);
    // The flooding /64 is at its own limit; other networks are not.
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { jar: new CookieJar(), body: signInBody('/'), from: '2001:db8:abcd:0::99' })).status).toBe(429);
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { jar: new CookieJar(), body: signInBody('/'), from: '198.51.100.7' })).status).toBe(200);
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { jar: new CookieJar(), body: signInBody('/'), from: '2001:db8:beef::1' })).status).toBe(200);
    // A deletion's re-authentication from that same /64 still starts, counted for its account instead.
    const reauth = await send(h, 'POST', '/api/auth/sign-in/social', { jar: owner, body: signInBody(DELETE_REAUTH_PATH), from: '2001:db8:abcd:0::99' });
    expect(reauth.status, JSON.stringify(reauth.json)).toBe(200);
    expect(MockGoogle.parse((reauth.json as { url: string }).url).loginHint).toMatch(/^\d+$/);
    // A client cannot claim that exemption with its own header.
    const spoofed = await send(h, 'POST', '/api/auth/sign-in/social', {
      jar: new CookieJar(),
      body: signInBody('/'),
      from: '2001:db8:abcd:0::99',
      headers: { [AUTH_REAUTH_HEADER]: '1' },
    });
    expect(spoofed.status).toBe(429);
  });

  it('deletion re-authentication starts are counted per account: exactly 5 an hour, even sent together; other accounts are not affected', async () => {
    const h = harness();
    const owner = new CookieJar();
    await signIn(h, owner, newUser());
    const sent = await Promise.all(
      Array.from({ length: 8 }, () => send(h, 'POST', '/api/auth/sign-in/social', { jar: owner.clone(), body: signInBody(DELETE_REAUTH_PATH) })),
    );
    expect(sent.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    const refused = sent.find((r) => r.status === 429)!;
    expect(errorOf(refused)).toEqual([429, 'rate_limited']);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another account starts its own; an ordinary sign-in start of the same browser is not counted.
    const other = new CookieJar();
    await signIn(h, other, newUser());
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { jar: other, body: signInBody(DELETE_REAUTH_PATH) })).status).toBe(200);
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { jar: owner.clone(), body: signInBody('/') })).status).toBe(200);
    // The next hour, it may start again.
    advance(60 * MIN);
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { jar: owner.clone(), body: signInBody(DELETE_REAUTH_PATH) })).status).toBe(200);
  });

  it('a deletion’s re-authentication comes back even when its network has used up its callbacks (Task 20 review N7)', async () => {
    const h = harness({}, { rateLimits: { signIn: 2, callback: 2 } });
    // Better Auth's limiter keeps its counts per process: an address no other test uses.
    const from = '192.0.2.211';
    const owner = new CookieJar();
    const user = newUser();
    await callback(h, owner, google.authorize(await startSignIn(h, owner, '/', { from }), user), { from });
    expect(await account(h, owner)).toMatchObject({ signedIn: true });
    await ageSessions(10);
    // Someone else on the same network identity (a shared address) uses up its callbacks.
    for (let i = 0; i < 2; i++) await callback(h, new CookieJar(), `/api/auth/callback/google?state=x${i}&code=y`, { from });
    expect((await callback(h, new CookieJar(), '/api/auth/callback/google?state=x&code=y', { from })).status).toBe(429);
    // A client cannot claim the exemption with its own header.
    expect((await send(h, 'GET', '/api/auth/callback/google?state=x&code=y', { jar: new CookieJar(), headers: { ...NAVIGATION_FROM_GOOGLE, [AUTH_REAUTH_HEADER]: '1' }, from })).status).toBe(429);
    const start = await send(h, 'POST', '/api/auth/sign-in/social', { jar: owner, body: signInBody(DELETE_REAUTH_PATH), from });
    expect(start.status).toBe(200);
    const back = await callback(h, owner, google.authorize((start.json as { url: string }).url, user), { from });
    expect([back.status, back.headers.location]).toEqual([302, DELETE_REAUTH_PATH]);
    expect(await count('auth_deletion_confirmations')).toBe(1);
  });

  it('a signed-in browser’s callbacks skip the network’s limit only up to 5 an hour for its account', async () => {
    const h = harness({}, { rateLimits: { signIn: 2, callback: 2 } });
    const from = '192.0.2.212';
    const owner = new CookieJar();
    await callback(h, owner, google.authorize(await startSignIn(h, owner, '/', { from }), newUser()), { from });
    // The network has one callback left; another browser there takes it.
    await callback(h, new CookieJar(), '/api/auth/callback/google?state=x&code=y', { from });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await callback(h, owner.clone(), `/api/auth/callback/google?state=junk${i}&code=y`, { from })).status);
    // Five are counted for the account (each fails as a sign-in, but none is refused for the rate); the sixth meets the network's limit.
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
    // The next hour the account's own count starts again.
    advance(60 * MIN);
    expect((await callback(h, owner.clone(), '/api/auth/callback/google?state=later&code=y', { from })).status).not.toBe(429);
  });

  it('nonce and claims: an ID token without this flow’s nonce, for another client, expired, or with an unverified email stores nothing', async () => {
    const h = harness();
    const cases: [string, Record<string, unknown>][] = [
      ['no nonce', { nonce: undefined }],
      ['another nonce', { nonce: 'not-this-flows-nonce' }],
      ['another audience', { aud: 'someone-else.apps.googleusercontent.com' }],
      ['another azp', { azp: 'someone-else.apps.googleusercontent.com' }],
      ['another issuer', { iss: 'https://evil.example' }],
      ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
      ['unverified email', { email_verified: false }],
      ['email_verified as text', { email_verified: 'true' }],
      ['no email', { email: undefined }],
    ];
    for (const [label, claims] of cases) {
      const jar = new CookieJar();
      const url = await startSignIn(h, jar, '/');
      const back = await callback(h, jar, google.authorize(url, newUser(), { claims }));
      expect(back.status, label).toBe(302);
      expect(back.headers.location, label).toBe('/?signin=failed&error=unable_to_get_user_info');
      expect(await account(h, jar), label).toEqual({ signedIn: false });
    }
    expect(await count('auth_users')).toBe(0);
    expect(await count('auth_accounts')).toBe(0);
    expect(await count('auth_sessions')).toBe(0);
    const reasons = h.logs.map((l) => JSON.parse(l) as { msg?: string; reason?: string }).filter((l) => l.msg === 'Google sign-in refused').map((l) => l.reason);
    expect(reasons).toEqual(['nonce', 'nonce', 'audience', 'audience', 'issuer', 'expired', 'email_not_verified', 'email_not_verified', 'email']);
  });

  it('a code or PKCE verifier Google does not accept fails the sign-in', async () => {
    const h = harness();
    const jar = new CookieJar();
    const url = await startSignIn(h, jar, '/');
    const path = google.authorize(url, newUser());
    const forged = path.replace(/code=[^&]+/, 'code=4%2Fforged');
    const back = await callback(h, jar, forged);
    expect(back.headers.location).toBe('/?signin=failed&error=invalid_code');
    expect(await count('auth_users')).toBe(0);
  });

  it('identity is the Google subject: another subject with the same email is refused, never linked', async () => {
    const h = harness();
    const first = newUser();
    await signIn(h, new CookieJar(), first);
    const jar = new CookieJar();
    const url = await startSignIn(h, jar, '/');
    const back = await callback(h, jar, google.authorize(url, { ...newUser(), email: first.email }));
    expect(back.headers.location).toBe('/?signin=failed&error=account_not_linked');
    expect(await rows(sql`SELECT account_id FROM auth_accounts`)).toEqual([{ account_id: first.sub }]);
    expect(await account(h, jar)).toEqual({ signedIn: false });
  });

  it('Better Auth’s rate limit keys on the validated network identity, never a client header', async () => {
    const h = harness({}, { rateLimits: { signIn: 2 } });
    const a = '198.51.100.10';
    const b = '198.51.100.11';
    for (let i = 0; i < 2; i++) expect((await send(h, 'POST', '/api/auth/sign-in/social', { body: signInBody('/'), from: a })).status).toBe(200);
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { body: signInBody('/'), from: a })).status).toBe(429);
    // A client's own copy of the header changes nothing.
    const spoofed = await send(h, 'POST', '/api/auth/sign-in/social', { body: signInBody('/'), from: a, headers: { [AUTH_IP_HEADER]: '192.0.2.200' } });
    expect(spoofed.status).toBe(429);
    expect((await send(h, 'POST', '/api/auth/sign-in/social', { body: signInBody('/'), from: b })).status).toBe(200);
  });

  it('without the Google client ID or secret, sign-in is off and every auth endpoint refuses', async () => {
    const h = harness({}, { config: { google: false } });
    expect(h.auth).toBeNull();
    const jar = new CookieJar();
    expect(errorOf(await send(h, 'POST', '/api/auth/sign-in/social', { jar, body: signInBody('/') }))).toEqual([404, 'not_found']);
    expect(errorOf(await send(h, 'GET', '/api/auth/callback/google?code=a&state=b', { jar }))).toEqual([404, 'not_found']);
    expect(errorOf(await send(h, 'POST', '/api/auth/sign-out', { jar, body: {} }))).toEqual([404, 'not_found']);
    expect(await account(h, jar)).toEqual({ signedIn: false });
    expect(errorOf(await send(h, 'POST', '/api/account/delete/start', { jar, body: {} }))).toEqual([404, 'not_found']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar, body: { confirm: true } }))).toEqual([404, 'not_found']);
    // A short BETTER_AUTH_SECRET keeps it off too.
    expect(harness({}, { config: { authSecret: 'short' } }).auth).toBeNull();
  });
});

describe('signing in mid-brief (the handover)', () => {
  it('handover moves read owner once; concurrent callback no-op', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    // Two tabs of the browser sign in from the brief (each with its own OAuth state), as two Google accounts.
    const tab1 = browser.clone();
    const tab2 = browser.clone();
    const url1 = await startSignIn(h, tab1, `/briefs/${briefId}`);
    const url2 = await startSignIn(h, tab2, `/briefs/${briefId}`);
    const [a1, a2] = [newUser(), newUser()];
    const [path1, path2] = [google.authorize(url1, a1), google.authorize(url2, a2)];
    const [b1, b2] = await Promise.all([callback(h, tab1, path1), callback(h, tab2, path2)]);
    expect([b1.headers.location, b2.headers.location]).toEqual([`/briefs/${briefId}?welcome=1`, `/briefs/${briefId}?welcome=1`]);
    expect(await account(h, tab1)).toMatchObject({ signedIn: true });
    expect(await account(h, tab2)).toMatchObject({ signedIn: true });

    // The read owner moved exactly once, to one of the two accounts; the other callback changed nothing.
    const owner = (await ownerOf(briefId))!;
    expect(owner).toMatchObject({ read_owner_kind: 'account', moved: true });
    expect([accountHash(a1.sub), accountHash(a2.sub)]).toContain(owner.read_owner);
    expect(handoverLogs(h).sort()).toEqual(['moved', 'not_moved']);
    const [winner, winnerPath, loser] = owner.read_owner === accountHash(a1.sub) ? [tab1, path1, tab2] : [tab2, path2, tab1];
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: winner })).status).toBe(200);
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: loser })).status).toBe(404);
    // The trial cannot read it any more; its step stays billed to the trial.
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: trialOnly(browser) })).status).toBe(404);
    expect(await stepsOf(briefId)).toEqual([{ n: 1, billing_principal: trialHash, billing_kind: 'trial' }]);

    // A second callback with the same code and state fails before any handover.
    const replay = await callback(h, winner, winnerPath);
    expect(replay.headers.location).toMatch(/[?&]signin=failed&error=state_mismatch$/);
    expect(await ownerOf(briefId)).toEqual(owner);
    expect(handoverLogs(h)).toHaveLength(2);
  });

  it('only the browser whose trial owns the brief hands it over', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const owner = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, owner);
    // Someone else signs in from a link to that brief: nothing moves.
    const someone = new CookieJar();
    await signIn(h, someone, newUser(), `/briefs/${briefId}`);
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial' });
    // The owner starts signing in, then loses the trial cookie before Google sends it back.
    const url = await startSignIn(h, owner, `/briefs/${briefId}`);
    owner.delete(TRIAL);
    await callback(h, owner, google.authorize(url, newUser()));
    expect(handoverLogs(h)).toEqual(['trial_changed']);
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial' });
  });

  it('a step still running at handover completes normally; only the account reads it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The step searches; retrieval waits until the test lets it go, then finds nothing.
    const h = harness({ scope: { output: scopeOut({ intent: 'case_search', mechanicalCause: true, keywordText: 'engine power loss maintenance' }) } }, { served: async () => {
      await held;
      return { chunkerVersion: 'none' };
    } });
    const browser = new CookieJar();
    const started = await ask(h, browser, 'Engine power loss after maintenance');
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ kind: 'started', stage: 'retrieve' });
    const briefId = started.json.briefId;
    const user = newUser();
    const url = await startSignIn(h, browser, `/briefs/${briefId}`);
    await callback(h, browser, google.authorize(url, user));
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: accountHash(user.sub), read_owner_kind: 'account' });
    const running = await send(h, 'GET', `/api/briefs/${briefId}`, { jar: browser });
    expect(running.json).toMatchObject({ stage: 'retrieve' });

    release();
    await h.svc.settled();
    const done = await send(h, 'GET', `/api/briefs/${briefId}`, { jar: browser });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ stage: 'done', result: { kind: 'no_results' } });
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: trialOnly(browser) })).status).toBe(404);
    // Its charge stayed with the trial that asked.
    expect(await rows(sql`SELECT principal_kind, status FROM reservations`)).toEqual([{ principal_kind: 'trial', status: 'settled' }]);
  });

  it('a signed-in visitor’s refinement of a brief its trial still owns moves it to the account first', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    const user = newUser();
    // Signed in from elsewhere: no handover; the browser still reads the brief through its trial.
    await signIn(h, browser, user, '/');
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial' });
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: browser })).status).toBe(200);
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial' });
    advance(MIN);
    const r = await refine(h, browser, briefId, 'Only seaplanes', { token: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await h.svc.settled();
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: accountHash(user.sub), read_owner_kind: 'account', moved: true });
    expect(await stepsOf(briefId)).toEqual([
      { n: 1, billing_principal: trialHash, billing_kind: 'trial' },
      { n: 2, billing_principal: accountHash(user.sub), billing_kind: 'account' },
    ]);
  });
});

describe('retries and billing after sign-in', () => {
  it('old trial identity retry gets moved', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const askKey = key();
    const { briefId } = await trialBrief(h, browser, { key: askKey });
    advance(MIN);
    const refineKey = key();
    const refined = await refine(h, browser, briefId, 'Only seaplanes', { key: refineKey });
    expect(refined.status).toBe(200);
    await h.svc.settled();
    const user = newUser();
    await signIn(h, browser, user, `/briefs/${briefId}`);
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: accountHash(user.sub) });

    // Signed out again: the browser is its trial alone, and retries both earlier requests.
    expect((await send(h, 'POST', '/api/auth/sign-out', { jar: browser, body: {} })).status).toBe(200);
    expect(browser.get(SESSION)).toBeUndefined();
    const before = { reservations: await count('reservations'), steps: await count('brief_steps') };
    const checks = h.sv.calls.length;
    const trialUsed = await rows(sql`SELECT requests_used FROM trial_identities`);
    advance(MIN);
    // Like every anonymous AI request, a retry takes a fresh Turnstile check (UI_DESIGN §5).
    expect(errorOf(await ask(h, browser, 'Write me a poem about the sea', { key: askKey, token: false }))).toEqual([403, 'challenge_required']);
    expect(errorOf(await ask(h, browser, 'Write me a poem about the sea', { key: askKey }))).toEqual([403, 'moved']);
    expect(errorOf(await refine(h, browser, briefId, 'Only seaplanes', { key: refineKey }))).toEqual([403, 'moved']);
    expect(h.sv.calls).toHaveLength(checks + 2);
    // Never a replay and never a new run: nothing admitted or charged.
    expect({ reservations: await count('reservations'), steps: await count('brief_steps') }).toEqual(before);
    expect(await rows(sql`SELECT requests_used FROM trial_identities`)).toEqual(trialUsed);
    // The brief itself is not the trial's to read.
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: browser })).status).toBe(404);

    // Signed in again, the same retry is redirected to the account: the brief, not a second run, and no check.
    await signIn(h, browser, user, '/');
    const replay = await ask(h, browser, 'Write me a poem about the sea', { key: askKey, token: false });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ kind: 'scope_reply', briefId, step: 1 });
    expect({ reservations: await count('reservations'), steps: await count('brief_steps') }).toEqual(before);
    expect(h.sv.calls).toHaveLength(checks + 2);
  });

  it('a signed-in retry of a request the trial made, sign-in having started elsewhere, takes the brief over and is never billed twice', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const askKey = key();
    const { briefId, trialHash } = await trialBrief(h, browser, { key: askKey });
    const user = newUser();
    await signIn(h, browser, user, '/');
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash });
    const reservations = await count('reservations');
    const replay = await ask(h, browser, 'Write me a poem about the sea', { key: askKey, token: false });
    expect(replay.json).toMatchObject({ kind: 'scope_reply', briefId, step: 1 });
    expect(await count('reservations')).toBe(reservations);
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: accountHash(user.sub), read_owner_kind: 'account' });
  });

  it('post-signin refinement billed to account', async () => {
    const h = harness({ scope: [OFF_TOPIC, REFUSED] });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    const user = newUser();
    await signIn(h, browser, user, `/briefs/${briefId}`);
    const accountKey = accountHash(user.sub);
    expect(await aiStatus(h, browser)).toMatchObject({ state: 'available', remaining: { kind: 'account', leftToday: 5, limitToday: 5, leftThisMonth: 150 } });
    const siteverify = h.sv.calls.length;

    advance(MIN);
    // Signed in: no Turnstile token is needed or claimed.
    const r = await refine(h, browser, briefId, 'Only seaplanes', { token: false });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    await h.svc.settled();
    expect(h.sv.calls).toHaveLength(siteverify);
    expect(await stepsOf(briefId)).toEqual([
      { n: 1, billing_principal: trialHash, billing_kind: 'trial' },
      { n: 2, billing_principal: accountKey, billing_kind: 'account' },
    ]);
    // Each step's charge stays with its billing principal: the refusal counted for the account.
    expect(await rows(sql`SELECT principal_kind, principal_hash, quota_counted, status FROM reservations ORDER BY id`)).toEqual([
      { principal_kind: 'trial', principal_hash: trialHash, quota_counted: false, status: 'settled' },
      { principal_kind: 'account', principal_hash: accountKey, quota_counted: true, status: 'settled' },
    ]);
    const ledger = await rows<{ principal_hash: string }>(sql`SELECT DISTINCT c.principal_hash FROM cost_ledger c JOIN reservations r ON r.id = c.reservation_id WHERE r.id = (SELECT max(id) FROM reservations)`);
    expect(ledger).toEqual([{ principal_hash: accountKey }]);
    expect(await rows(sql`SELECT requests_used FROM trial_identities`)).toEqual([{ requests_used: 0 }]);
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', leftToday: 4, leftThisMonth: 149 } });
    // The trial alone still sees its own (untouched) trial.
    expect(await aiStatus(h, trialOnly(browser))).toMatchObject({ remaining: { kind: 'trial', left: 3 } });
  });

  it('a signed-in question is the account’s brief and the account’s charge', async () => {
    const h = harness({ scope: REFUSED });
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    const asked = await ask(h, browser, 'Engine power loss after maintenance', { token: false });
    expect(asked.status).toBe(202);
    await h.svc.settled();
    expect(await ownerOf(asked.json.briefId)).toMatchObject({ read_owner: accountHash(user.sub), read_owner_kind: 'account', moved: false });
    expect(await stepsOf(asked.json.briefId)).toEqual([{ n: 1, billing_principal: accountHash(user.sub), billing_kind: 'account' }]);
    expect(await count('trial_identities')).toBe(0);
    expect(h.sv.calls).toHaveLength(0);
  });

  it('re-registration reattaches usage', async () => {
    const h = harness({ scope: REFUSED });
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    for (let i = 0; i < 2; i++) {
      advance(MIN);
      expect((await ask(h, browser, `Engine power loss ${i}`, { token: false })).status).toBe(202);
      await h.svc.settled();
    }
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', leftToday: 3, limitToday: 5, leftThisMonth: 148 } });
    const firstUser = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;

    expect((await deleteAccount(h, browser)).status).toBe(200);
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'trial' } });
    // The anti-abuse record: HMAC(issuer, sub) only, kept through the month's window plus 7 days.
    expect(await abuseRecords()).toEqual([{ identity_hash: accountHash(user.sub), retain_until: '2026-12-08T00:00:00.000Z' }]);

    // The same Google account signs up again: a new user, the same counts.
    const again = await signIn(h, browser, user);
    expect(again.headers.location).toBe('/?welcome=1');
    const secondUser = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;
    expect(secondUser).not.toBe(firstUser);
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', leftToday: 3, limitToday: 5, leftThisMonth: 148 } });
    advance(MIN);
    expect((await ask(h, browser, 'Engine power loss again', { token: false })).status).toBe(202);
    await h.svc.settled();
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', leftToday: 2, leftThisMonth: 147 } });
  });
});

describe('account deletion', () => {
  it('ends every session and removes saved content; keeps only the anti-abuse record and content-free charges', async () => {
    const h = harness({ scope: [OFF_TOPIC, REFUSED, OFF_TOPIC] });
    const browser = new CookieJar();
    const { briefId: handedOver, trialHash } = await trialBrief(h, browser);
    const user = newUser();
    await signIn(h, browser, user, `/briefs/${handedOver}`);
    advance(MIN);
    const own = await ask(h, browser, 'Engine power loss after maintenance', { token: false });
    await h.svc.settled();
    advance(MIN);
    expect((await refine(h, browser, handedOver, 'Only seaplanes', { token: false })).status).toBe(200);
    await h.svc.settled();
    // Signed in on a second browser too.
    const laptop = new CookieJar();
    await signIn(h, laptop, user);
    expect(await count('auth_sessions')).toBe(2);
    const accountKey = accountHash(user.sub);
    const kept = { reservations: await count('reservations'), ledger: await count('cost_ledger'), buckets: await count('usage_buckets') };

    // Refused: signed out, cross-site, without the explicit confirmation, or without a recent sign-in's confirmation.
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: trialOnly(browser), body: { confirm: true } }))).toEqual([403, 'sign_in_required']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true }, headers: { 'sec-fetch-site': 'cross-site' } }))).toEqual([403, 'forbidden']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: {} }))).toEqual([400, 'bad_request']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } }))).toEqual([403, 'reauth_required']);
    expect(await count('auth_users')).toBe(1);

    const deleted = await deleteAccount(h, browser);
    expect(deleted.status).toBe(200);
    expect(deleted.json).toEqual({ deleted: true });
    expect(deleted.headers['cache-control']).toBe('private, no-store');
    const expired = cookieNamed(deleted.setCookies, SESSION);
    expect(expired).toMatch(/Max-Age=0/i);
    expect(expired).toMatch(/;\s*Secure/i);
    // Every session ended: the other browser, still holding its cookie, is signed out too.
    expect(await account(h, laptop)).toEqual({ signedIn: false });
    expect(await account(h, browser)).toEqual({ signedIn: false });
    for (const table of ['auth_users', 'auth_accounts', 'auth_sessions']) expect(await count(table), table).toBe(0);
    // Saved content went: both briefs (the handed-over one with its trial-billed step) and the account's request hashes.
    expect(await count('briefs')).toBe(0);
    expect(await count('brief_steps')).toBe(0);
    expect(await rows(sql`SELECT count(*)::int AS n FROM idempotency WHERE principal_hash = ${accountKey}`)).toEqual([{ n: 0 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM idempotency WHERE principal_hash = ${trialHash}`)).toEqual([{ n: 1 }]);
    // Kept: the anti-abuse record (HMAC only) through the month's window plus 7 days, and the charges.
    expect(await abuseRecords()).toEqual([{ identity_hash: accountKey, retain_until: '2026-12-08T00:00:00.000Z' }]);
    expect({ reservations: await count('reservations'), ledger: await count('cost_ledger'), buckets: await count('usage_buckets') }).toEqual(kept);
    expect(await count('trial_identities')).toBe(1);
    // The account's brief is gone for good; nothing is left to read.
    expect((await send(h, 'GET', `/api/briefs/${own.json.briefId}`, { jar: browser })).status).toBe(404);
    // Deleting again: there is no account.
    expect(errorOf(await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} }))).toEqual([403, 'sign_in_required']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } }))).toEqual([403, 'sign_in_required']);
    // The server log names counts only.
    const line = h.logs.map((l) => JSON.parse(l) as { msg?: string; accountDeleted?: unknown }).find((l) => l.msg === 'account deleted');
    expect(line?.accountDeleted).toEqual({ briefs: 2, briefSteps: 3, idempotency: 2, cancelledSteps: 0 });
  });

  it('a running step of the account is cancelled first and still settles', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ scope: { output: scopeOut({ intent: 'case_search', mechanicalCause: true, keywordText: 'engine power loss maintenance' }) } }, { served: async () => {
      await held;
      return { chunkerVersion: 'none' };
    } });
    const browser = new CookieJar();
    await signIn(h, browser, newUser());
    const started = await ask(h, browser, 'Engine power loss after maintenance', { token: false });
    expect(started.json).toMatchObject({ kind: 'started', stage: 'retrieve' });
    try {
      expect((await deleteAccount(h, browser)).status).toBe(200);
    } finally {
      release();
    }
    await h.svc.settled();
    expect(await count('briefs')).toBe(0);
    expect(await rows(sql`SELECT status FROM reservations`)).toEqual([{ status: 'settled' }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL`)).toEqual([{ n: 0 }]);
    const line = h.logs.map((l) => JSON.parse(l) as { msg?: string; accountDeleted?: { cancelledSteps: number } }).find((l) => l.msg === 'account deleted');
    expect(line?.accountDeleted?.cancelledSteps).toBe(1);
  });
});

/** Make every session's Google sign-in `minutes` older (as if it signed in that long ago). */
async function ageSessions(minutes: number): Promise<void> {
  await migrator.execute(sql`UPDATE auth_sessions SET created_at = created_at - make_interval(mins => ${minutes})`);
}

const reauthLogs = (h: Harness) =>
  h.logs.map((l) => JSON.parse(l) as { msg?: string; reauthentication?: string }).filter((l) => l.msg === 'sign-in re-authentication').map((l) => l.reauthentication);

describe('deleting needs a recent Google sign-in (OWASP re-authentication)', () => {
  it('an older session, a stolen copy included, cannot delete; signing in with Google again as the same account confirms it and ends the old session', async () => {
    const h = harness();
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    await ageSessions(10);
    const thief = browser.clone();
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: thief, body: { confirm: true } }))).toEqual([403, 'reauth_required']);
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: thief, body: {} })).json).toEqual({ next: 'reauthenticate' });
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: thief, body: { confirm: true } }))).toEqual([403, 'reauth_required']);
    expect(await count('auth_deletion_confirmations')).toBe(0);
    expect(await account(h, browser)).toEqual({ signedIn: true, user: { name: user.name, email: user.email } });

    // The owner signs in with Google again from the account page; Google is asked for this account.
    const url = await startSignIn(h, browser, DELETE_REAUTH_PATH);
    expect(MockGoogle.parse(url).loginHint).toBe(user.sub);
    const back = await callback(h, browser, google.authorize(url, user));
    expect(back.headers.location).toBe(DELETE_REAUTH_PATH);
    expect(reauthLogs(h)).toEqual(['confirmed']);
    // The session the browser had (and the thief's copy of it) ended; the new one is confirmed for 5 minutes.
    expect(await account(h, thief)).toEqual({ signedIn: false });
    const confirmed = await account(h, browser);
    expect(confirmed).toMatchObject({ signedIn: true, user: { email: user.email } });
    const until = Date.parse((confirmed as { deletionConfirmedUntil?: string }).deletionConfirmedUntil ?? '');
    expect(until - Date.now()).toBeGreaterThan(4 * MIN);
    expect(until - Date.now()).toBeLessThanOrEqual(5 * MIN);
    expect(await count('auth_sessions')).toBe(1);
    const deleted = await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
    expect(deleted.status).toBe(200);
    expect(await count('auth_users')).toBe(0);
  });

  it('signing in again as another Google account confirms nothing', async () => {
    const h = harness();
    const owner = newUser();
    const other = newUser();
    await signIn(h, new CookieJar(), other);
    const browser = new CookieJar();
    await signIn(h, browser, owner);
    await ageSessions(10);
    const url = await startSignIn(h, browser, DELETE_REAUTH_PATH);
    await callback(h, browser, google.authorize(url, other));
    expect(reauthLogs(h)).toEqual(['other_account']);
    expect(await account(h, browser)).toEqual({ signedIn: true, user: { name: other.name, email: other.email } });
    expect(await count('auth_deletion_confirmations')).toBe(0);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } }))).toEqual([403, 'reauth_required']);
    expect(await count('auth_users')).toBe(2);
  });

  it('right after signing in no other prompt is needed; the confirmation is the session’s own, lasts 5 minutes and is used once', async () => {
    const h = harness();
    const browser = new CookieJar();
    const laptop = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    await signIn(h, laptop, user);
    expect(errorOf(await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {}, headers: { 'sec-fetch-site': 'cross-site' } }))).toEqual([403, 'forbidden']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: { confirm: true } }))).toEqual([400, 'bad_request']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete/start', { jar: new CookieJar(), body: {} }))).toEqual([403, 'sign_in_required']);
    const start = await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} });
    expect(start.json).toMatchObject({ next: 'confirm' });
    // Asking again keeps it: one per session.
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} })).json).toMatchObject({ next: 'confirm', until: (start.json as { until: string }).until });
    expect(await count('auth_deletion_confirmations')).toBe(1);
    // Another session of the same account cannot use it.
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: laptop, body: { confirm: true } }))).toEqual([403, 'reauth_required']);
    // Once expired it is refused.
    await migrator.execute(sql`UPDATE auth_deletion_confirmations SET created_at = created_at - interval '6 minutes', expires_at = expires_at - interval '6 minutes'`);
    expect(await account(h, browser)).not.toHaveProperty('deletionConfirmedUntil');
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } }))).toEqual([403, 'reauth_required']);
    // A fresh one deletes once: of two deletions sent together, one deletes and the other finds nothing to delete.
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} })).json).toMatchObject({ next: 'confirm' });
    const [a, b] = await Promise.all([
      send(h, 'POST', '/api/account/delete', { jar: browser.clone(), body: { confirm: true } }),
      send(h, 'POST', '/api/account/delete', { jar: browser.clone(), body: { confirm: true } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(await count('auth_users')).toBe(0);
  });

  it('after deletion, the old trial’s retry of a request whose brief moved to the account finds nothing: 404, never “ask again”', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const askKey = key();
    const { briefId } = await trialBrief(h, browser, { key: askKey });
    await signIn(h, browser, newUser(), `/briefs/${briefId}`);
    expect((await deleteAccount(h, browser)).status).toBe(200);
    const reservations = await count('reservations');
    advance(MIN);
    const retry = await ask(h, browser, 'Write me a poem about the sea', { key: askKey });
    expect(errorOf(retry)).toEqual([404, 'not_found']);
    expect(await count('reservations')).toBe(reservations);
  });
});

describe('extra checks for signed-in AI (DESIGN §8: suspicious authenticated activity)', () => {
  const asked = (h: Harness, jar: CookieJar, question: string, token?: string) =>
    send(h, 'POST', '/api/briefs', { jar, body: { question, idempotencyKey: key(), ...(token ? { turnstileToken: token } : {}) } });

  it('ordinary use takes no check; past half of today’s allowance the status asks for one and requests need it', async () => {
    const h = harness({ scope: REFUSED });
    const browser = new CookieJar();
    await signIn(h, browser, newUser());
    // A new account has 5 a day: the first 3 take no check.
    for (let i = 0; i < 3; i++) {
      expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', leftToday: 5 - i } });
      expect((await aiStatus(h, browser)).remaining).not.toHaveProperty('check');
      advance(MIN);
      expect((await asked(h, browser, `Engine power loss ${i}`)).status).toBe(202);
      await h.svc.settled();
    }
    expect(h.sv.calls).toHaveLength(0);
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', leftToday: 2, check: true } });
    advance(MIN);
    const reservations = await count('reservations');
    expect(errorOf(await asked(h, browser, 'Engine power loss 3'))).toEqual([403, 'challenge_required']);
    expect(errorOf(await asked(h, browser, 'Engine power loss 3', '0.not-a-token-from-the-widget'))).toEqual([403, 'challenge_failed']);
    // Nothing was admitted for the refused requests.
    expect(await count('reservations')).toBe(reservations);
    const passed = await asked(h, browser, 'Engine power loss 3', h.sv.issue());
    expect(passed.status).toBe(202);
    await h.svc.settled();
    const lines = h.logs.map((l) => JSON.parse(l) as { msg?: string; accountCheck?: string[]; passed?: boolean }).filter((l) => l.msg === 'signed-in AI request checked');
    expect(lines.map((l) => [l.accountCheck, l.passed])).toEqual([
      [['daily_share'], false],
      [['daily_share'], false],
      [['daily_share'], true],
    ]);
  });

  it('a burst within one minute needs a check', async () => {
    const h = harness({ scope: [OFF_TOPIC, OFF_TOPIC, OFF_TOPIC, OFF_TOPIC] });
    const browser = new CookieJar();
    await signIn(h, browser, newUser());
    for (let i = 0; i < 3; i++) {
      expect((await asked(h, browser, `Write me a poem ${i}`)).status).toBe(200);
      await h.svc.settled();
    }
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { check: true } });
    expect(errorOf(await asked(h, browser, 'Write me a poem 3'))).toEqual([403, 'challenge_required']);
    // The next minute is ordinary again (off-topic replies gave their searches back).
    advance(MIN);
    expect((await aiStatus(h, browser)).remaining).not.toHaveProperty('check');
    expect((await asked(h, browser, 'Write me a poem 3')).status).toBe(200);
  });

  it('many signed-in attempts from one network need a check from every account there', async () => {
    const h = harness({ scope: Array.from({ length: 12 }, () => OFF_TOPIC) });
    const accounts = Array.from({ length: 5 }, () => new CookieJar());
    for (const jar of accounts) await signIn(h, jar, newUser());
    // Ten attempts in this hour from one address, two per account.
    for (let i = 0; i < 10; i++) {
      advance(MIN);
      expect((await asked(h, accounts[i % 4]!, `Write me a poem ${i}`)).status).toBe(200);
      await h.svc.settled();
    }
    expect(await aiStatus(h, accounts[4]!)).toMatchObject({ remaining: { check: true } });
    expect(errorOf(await asked(h, accounts[4]!, 'Write me a poem 10'))).toEqual([403, 'challenge_required']);
    // Another network is not affected.
    const elsewhere = await send(h, 'POST', '/api/briefs', { jar: accounts[4]!, from: '198.51.100.77', body: { question: 'Write me a poem 11', idempotencyKey: key() } });
    expect(elsewhere.status).toBe(200);
  });

  it('an operator can check every signed-in request (aviation_ingest sets it; the app cannot)', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    await signIn(h, browser, newUser());
    expect(await sqlState(appDb.execute(sql`UPDATE ai_switch SET account_check = 'always' WHERE id = 1`))).toBe('42501');
    await ingest.execute(sql`UPDATE ai_switch SET account_check = 'always' WHERE id = 1`);
    expect(await aiStatus(h, browser)).toMatchObject({ remaining: { kind: 'account', check: true } });
    expect(errorOf(await asked(h, browser, 'Write me a poem'))).toEqual([403, 'challenge_required']);
    expect((await asked(h, browser, 'Write me a poem', h.sv.issue())).status).toBe(200);
    expect(await sqlState(ingest.execute(sql`UPDATE ai_switch SET account_check = 'sometimes' WHERE id = 1`))).toBe('23514');
  });
});

describe('races with the handover: reads and changes check the read owner atomically', () => {
  const ACCOUNT_ONLY = { origin: 'text', question: 'Write me a poem about the sea', refinement: 'ACCOUNT-ONLY refinement', readings: {} };

  it('a read racing a handover never shows the old trial a step only the account reads', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    const user = newUser();
    await signIn(h, new CookieJar(), user);
    const accountKey = accountHash(user.sub);
    // The read waits for the steps table while the brief moves and the account adds a step.
    const locker = await holdLocks('LOCK TABLE brief_steps IN ACCESS EXCLUSIVE MODE');
    let read: Promise<Sent> | null = null;
    try {
      read = send(h, 'GET', `/api/briefs/${briefId}`, { jar: trialOnly(browser) });
      await untilBlocked();
      await locker.query('SELECT move_brief_read_owner($1::uuid, $2, $3)', [briefId, trialHash, accountKey]);
      await locker.query(
        `INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, created_at, updated_at)
         VALUES ($1::uuid, 2, $2, 'account', 1, $3::jsonb, $4, $4)`,
        [briefId, accountKey, JSON.stringify(ACCOUNT_ONLY), clock],
      );
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    const r = await read!;
    expect(errorOf(r)).toEqual([404, 'not_found']);
    expect(JSON.stringify(r.json)).not.toContain('ACCOUNT-ONLY');
  });

  it('an anonymous refinement racing the handover adds no step to the account’s brief, calls no model and gives its search back', async () => {
    const h = harness({ scope: [OFF_TOPIC, OFF_TOPIC] });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    advance(MIN);
    const checks = h.sv.calls.length;
    const release = h.sv.hold();
    let pending: Promise<Sent> | null = null;
    try {
      // Another tab refines as the trial; its check waits at Cloudflare.
      pending = refine(h, browser.clone(), briefId, 'Only seaplanes');
      await until(() => h.sv.calls.length > checks, 'the refinement’s check');
      // Meanwhile this tab signs in from the brief, which moves to the account.
      const user = newUser();
      await signIn(h, browser, user, `/briefs/${briefId}`);
      expect(await ownerOf(briefId)).toMatchObject({ read_owner: accountHash(user.sub), read_owner_kind: 'account' });
    } finally {
      release();
    }
    expect(errorOf(await pending!)).toEqual([404, 'not_found']);
    await h.svc.settled();
    expect(await stepsOf(briefId)).toEqual([{ n: 1, billing_principal: trialHash, billing_kind: 'trial' }]);
    expect(h.llm.calls).toHaveLength(1);
    // Admitted, then given back before any step: settled at zero, the search returned.
    const [, second] = await reservationsNow();
    expect(second).toEqual({ principal_kind: 'trial', status: 'settled', quota_counted: false, charged: '0.000000' });
    expect(await rows(sql`SELECT requests_used FROM trial_identities`)).toEqual([{ requests_used: 0 }]);
  });

  it('a cancel racing the handover never stops the account’s step', async () => {
    let releaseRetrieval!: () => void;
    const held = new Promise<void>((resolve) => (releaseRetrieval = resolve));
    const h = harness({ scope: { output: scopeOut({ intent: 'case_search', mechanicalCause: true, keywordText: 'engine power loss maintenance' }) } }, { served: async () => {
      await held;
      return { chunkerVersion: 'none' };
    } });
    const browser = new CookieJar();
    const started = await ask(h, browser, 'Engine power loss after maintenance');
    expect(started.status).toBe(202);
    const briefId = started.json.briefId;
    const trialHash = (await ownerOf(briefId))!.read_owner;
    const user = newUser();
    await signIn(h, new CookieJar(), user);
    // The cancel waits for the brief while it moves to the account.
    const locker = await holdLocks('LOCK TABLE briefs, brief_steps IN EXCLUSIVE MODE');
    let cancel: Promise<Sent> | null = null;
    try {
      cancel = send(h, 'POST', `/api/briefs/${briefId}/cancel`, { jar: trialOnly(browser), body: {} });
      await untilBlocked();
      await locker.query('SELECT move_brief_read_owner($1::uuid, $2, $3)', [briefId, trialHash, accountHash(user.sub)]);
      await locker.commit();
      expect(errorOf(await cancel!)).toEqual([404, 'not_found']);
    } finally {
      await locker.rollback();
      releaseRetrieval();
    }
    await h.svc.settled();
    // The step ran to its end for the account.
    expect(await rows(sql`SELECT status, cancel_requested_at FROM brief_steps WHERE brief_id = ${briefId}::uuid`)).toEqual([
      { status: 'no_results', cancel_requested_at: null },
    ]);
  });
});

describe('races with account deletion: nothing is created or taken over for a deleted account', () => {
  it('a signed-in question paused in admission while the account is deleted creates nothing and calls no model', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    const locker = await holdLocks(`SELECT pg_advisory_xact_lock(${SPEND_LOCK_KEY})`);
    let pending: Promise<Sent> | null = null;
    let deletion: Promise<Sent> | null = null;
    try {
      advance(MIN);
      // Admission holds the account's lock and waits for the spend lock.
      pending = ask(h, browser, 'PRIVATE question asked during deletion', { token: false });
      await untilBlocked();
      // The deletion waits for that admission, then runs before the question's step can be written.
      deletion = deleteAccount(h, browser.clone());
      await untilBlocked(2);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect((await deletion!).status).toBe(200);
    expect(errorOf(await pending!)).toEqual([403, 'signed_out']);
    await h.svc.settled();
    expect(await count('briefs')).toBe(0);
    expect(await count('idempotency')).toBe(0);
    expect(h.llm.calls).toHaveLength(0);
    // Admitted, then given back before any step: settled at zero, the search returned.
    expect(await reservationsNow()).toEqual([{ principal_kind: 'account', status: 'settled', quota_counted: false, charged: '0.000000' }]);
    // The same Google account signs up again: nothing from before is there.
    const again = new CookieJar();
    await signIn(h, again, user);
    expect(await count('briefs')).toBe(0);
  });

  it('a signed-in question waiting for the account’s lock while the account is deleted is refused; nothing is kept', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    const [classId, objectId] = accountLockKey(accountHash(user.sub));
    const locker = await holdLocks(`SELECT pg_advisory_xact_lock(${classId}, ${objectId})`);
    let pending: Promise<Sent> | null = null;
    try {
      advance(MIN);
      pending = ask(h, browser, 'PRIVATE question asked during deletion', { token: false });
      await untilBlocked();
      await deleteInLocker(locker, user.sub);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect(errorOf(await pending!)).toEqual([403, 'signed_out']);
    await h.svc.settled();
    for (const table of ['briefs', 'reservations', 'idempotency']) expect(await count(table), table).toBe(0);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('a signed-in question whose account is deleted after its admission gives the admission back and calls no model', async () => {
    const h = harness({ scope: [OFF_TOPIC, OFF_TOPIC] });
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    // A first question gives the account its anti-abuse record.
    expect((await ask(h, browser, 'Write me a poem about the sea', { token: false })).status).toBe(200);
    await h.svc.settled();
    advance(MIN);
    // The next admission passes its account check, then waits on that record; the account is deleted meanwhile.
    const locker = await holdLocks(`SELECT 1 FROM abuse_records WHERE identity_hash = '${accountHash(user.sub)}' FOR UPDATE`);
    let pending: Promise<Sent> | null = null;
    try {
      pending = ask(h, browser, 'PRIVATE question asked during deletion', { token: false });
      await untilBlocked();
      await deleteInLocker(locker, user.sub);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect(errorOf(await pending!)).toEqual([403, 'signed_out']);
    await h.svc.settled();
    // Admitted, then given back before any step: no brief, no model call, settled at zero, the search returned.
    expect(await count('briefs')).toBe(0);
    expect(h.llm.calls).toHaveLength(1);
    const [, second] = await reservationsNow();
    expect(second).toEqual({ principal_kind: 'account', status: 'settled', quota_counted: false, charged: '0.000000' });
  });

  it('a signed-in refinement paused while the account is deleted takes nothing over and spends nothing', async () => {
    const h = harness({ scope: [OFF_TOPIC, OFF_TOPIC] });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    const user = newUser();
    // Signed in from elsewhere: the trial still owns the brief.
    await signIn(h, browser, user, '/');
    advance(MIN);
    const locker = await holdLocks('LOCK TABLE ai_switch IN ACCESS EXCLUSIVE MODE');
    let pending: Promise<Sent> | null = null;
    try {
      pending = refine(h, browser, briefId, 'Only seaplanes', { token: false });
      await untilBlocked();
      await deleteInLocker(locker, user.sub);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect(errorOf(await pending!)).toEqual([403, 'signed_out']);
    await h.svc.settled();
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial', moved: false });
    expect(await stepsOf(briefId)).toEqual([{ n: 1, billing_principal: trialHash, billing_kind: 'trial' }]);
    expect(h.llm.calls).toHaveLength(1);
    expect(await count('reservations')).toBe(1);
  });

  it('a signed-in retry paused while the account is deleted takes nothing over', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const askKey = key();
    const { briefId, trialHash } = await trialBrief(h, browser, { key: askKey });
    const user = newUser();
    await signIn(h, browser, user, '/');
    const locker = await holdLocks('LOCK TABLE idempotency IN ACCESS EXCLUSIVE MODE');
    let pending: Promise<Sent> | null = null;
    try {
      pending = ask(h, browser, 'Write me a poem about the sea', { key: askKey, token: false });
      await untilBlocked();
      await deleteInLocker(locker, user.sub);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    const r = await pending!;
    // The browser's trial still owns the brief: the retry replays it, and nothing moved.
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ kind: 'scope_reply', briefId, step: 1 });
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial', moved: false });
    expect(await count('reservations')).toBe(1);
  });

  it('a sign-in callback paused while the account is deleted hands nothing over', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId, trialHash } = await trialBrief(h, browser);
    const user = newUser();
    const url = await startSignIn(h, browser, `/briefs/${briefId}`);
    // The callback's handover waits for the trial's row while the new account is deleted.
    const locker = await holdLocks('LOCK TABLE trial_identities IN ACCESS EXCLUSIVE MODE');
    let back: Promise<Sent> | null = null;
    try {
      back = callback(h, browser, google.authorize(url, user));
      await untilBlocked();
      await deleteInLocker(locker, user.sub);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect((await back!).status).toBe(302);
    expect(await ownerOf(briefId)).toMatchObject({ read_owner: trialHash, read_owner_kind: 'trial', moved: false });
    expect(handoverLogs(h)).toEqual(['account_gone']);
    expect(await account(h, browser)).toEqual({ signedIn: false });
  });
});

/** The spend lock (a single-key advisory lock) as pg_locks shows it: held by any session? */
async function spendLockHeld(): Promise<boolean> {
  const high = Math.floor(SPEND_LOCK_KEY / 2 ** 32);
  const low = SPEND_LOCK_KEY % 2 ** 32;
  const held = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND classid = ${high} AND objid = ${low} AND objsubid = 1 AND granted`);
  return held[0]!.n > 0;
}

describe('lock order: no deadlock and no stall across accounts', () => {
  it('account deletion and retention take a brief before its steps: deleting during a maintenance pass does not deadlock', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    // The account's brief is created 25 hours before the database's clock: retention sees it expired.
    const dbNow = Number((await rows<{ ms: string }>(sql`SELECT (extract(epoch FROM now()) * 1000)::bigint AS ms`))[0]!.ms);
    clock = new Date(dbNow - 25 * 3_600_000);
    await signIn(h, browser, newUser());
    expect((await ask(h, browser, 'Write me a poem about the sea', { token: false })).status).toBe(200);
    await h.svc.settled();
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} })).json).toMatchObject({ next: 'confirm' });
    // Retention's brief statements, in the order prune_controls() runs them (read from the function itself).
    const source = (await rows<{ src: string }>(sql`SELECT pg_get_functiondef('prune_controls()'::regprocedure) AS src`))[0]!.src;
    const statements = [/PERFORM 1 FROM briefs[^;]*;/, /DELETE FROM brief_steps[^;]*;/, /DELETE FROM briefs[^;]*;/]
      .map((re) => re.exec(source))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => a.index - b.index)
      .map((m) => m[0].replace(/^PERFORM/, 'SELECT'));
    expect(statements.length).toBeGreaterThanOrEqual(2);
    const locker = await holdLocks(`SELECT set_config('aviation.pruning_controls', 'on', true)`);
    let deletion: Promise<Sent> | null = null;
    try {
      await locker.query(statements[0]!);
      // The deletion starts while retention is under way, and waits for it.
      deletion = send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
      await untilBlocked();
      for (const statement of statements.slice(1)) await locker.query(statement);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect((await deletion!).status).toBe(200);
    expect(await count('auth_users')).toBe(0);
    expect(await count('briefs')).toBe(0);
  });

  it('an account’s admission waits for its own lock before taking anything shared: another account is not stalled', async () => {
    const h = harness({ scope: [OFF_TOPIC, OFF_TOPIC] });
    const waiting = new CookieJar();
    const waitingUser = newUser();
    await signIn(h, waiting, waitingUser);
    const other = new CookieJar();
    await signIn(h, other, newUser());
    advance(MIN);
    // A stand-in for a deletion of the first account, holding its lifecycle lock.
    const [classId, objectId] = accountLockKey(accountHash(waitingUser.sub));
    const locker = await holdLocks(`SELECT pg_advisory_xact_lock(${classId}, ${objectId})`);
    let pending: Promise<Sent> | null = null;
    let settledFirst = false;
    try {
      pending = ask(h, waiting, 'Write me a poem about the sea', { token: false }).finally(() => {
        settledFirst = true;
      });
      await untilBlocked();
      // It waits holding nothing other accounts need: not the spend lock (nor the shared buckets before it).
      expect(await spendLockHeld()).toBe(false);
      // Another account on another network is admitted and answered while it still waits.
      const answered = await send(h, 'POST', '/api/briefs', { jar: other, from: '198.51.100.77', body: { question: 'Write me a poem about the moon', idempotencyKey: key() } });
      expect(answered.status).toBe(200);
      expect(settledFirst).toBe(false);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect((await pending!).status).toBe(200);
  });
});

describe('lock order: account deletion against the maintenance pass (Task 20 review N6)', () => {
  /** A signed-in account with an expired session as well, not pruned yet. */
  async function signedInWithExpiredSession(h: Harness) {
    const browser = new CookieJar();
    const user = newUser();
    await signIn(h, browser, user);
    const userId = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;
    await migrator.execute(sql`
      INSERT INTO auth_sessions (token, user_id, expires_at, created_at, updated_at)
      VALUES ('expired-session-token', ${userId}::uuid, now() - interval '1 hour', now() - interval '8 days', now() - interval '8 days')`);
    return { browser, user };
  }

  /** The account's anti-abuse record has expired and is not pruned yet: retention will take it. */
  async function expireAbuseRecord(user: GoogleUser): Promise<void> {
    await migrator.execute(sql`
      INSERT INTO abuse_records (identity_hash, first_seen_at, last_seen_at, retain_until)
      VALUES (${accountHash(user.sub)}, now() - interval '40 days', now() - interval '40 days', now() - interval '1 hour')
      ON CONFLICT (identity_hash) DO UPDATE
        SET first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at, retain_until = EXCLUDED.retain_until`);
  }

  /**
   * The maintenance pass as it runs, in one transaction: retention (which deletes the
   * expired anti-abuse record), then, once the deletion waits for it, the orphaned steps
   * and the sign-in rows. Returns the deletion's answer and what each later step did.
   */
  async function deleteDuringMaintenance(h: Harness, browser: CookieJar) {
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} })).json).toMatchObject({ next: 'confirm' });
    const locker = await holdLocks(`SELECT prune_controls()`);
    let deletion: Promise<Sent> | null = null;
    const steps: Record<string, string> = {};
    try {
      deletion = send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
      await untilBlocked();
      for (const [name, step] of [
        ['orphanedSteps', () => failOrphanedSteps(locker.db, clock)],
        ['pruneAuth', () => pruneAuth(locker.db)],
      ] as const) {
        try {
          await step();
          steps[name] = 'ok';
        } catch (err) {
          steps[name] = `error ${(err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? 'unknown'}`;
          break;
        }
      }
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    return { deletion: await deletion!, steps };
  }

  it('deleting while the pass prunes an expired anti-abuse record and an expired session: no deadlock', async () => {
    const h = harness();
    const { browser, user } = await signedInWithExpiredSession(h);
    await expireAbuseRecord(user);
    const { deletion, steps } = await deleteDuringMaintenance(h, browser);
    expect(steps).toEqual({ orphanedSteps: 'ok', pruneAuth: 'ok' });
    expect([deletion.status, deletion.json]).toMatchObject([200, { deleted: true }]);
    expect(h.logs.filter((l) => /40P01|deadlock/i.test(l))).toEqual([]);
    expect(await count('auth_users')).toBe(0);
    expect(await count('auth_sessions')).toBe(0);
    // The deletion's anti-abuse record is the one kept.
    expect((await abuseRecords()).map((r) => r.identity_hash)).toEqual([accountHash(user.sub)]);
  });

  it('deleting while the pass also finds one of the account’s steps orphaned: no deadlock', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const { browser, user } = await signedInWithExpiredSession(h);
    advance(MIN);
    const asked = await ask(h, browser, 'Write me a poem about the sea', { token: false });
    expect(asked.status).toBe(200);
    await h.svc.settled();
    // A step whose process died: still running, its reservation already closed.
    const first = (
      await rows<{ brief_id: string; billing_principal: string; billing_kind: string; reservation_id: number }>(sql`
        SELECT brief_id::text AS brief_id, billing_principal, billing_kind, reservation_id::int AS reservation_id FROM brief_steps WHERE n = 1`)
    )[0]!;
    await migrator.execute(sql`
      INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, created_at, updated_at)
      VALUES (${first.brief_id}::uuid, 2, ${first.billing_principal}, ${first.billing_kind}, ${first.reservation_id},
        ${JSON.stringify({ origin: 'text', question: 'q', refinement: 'r', readings: {} })}::jsonb, ${new Date(clock.getTime() - 10 * MIN)}, ${new Date(clock.getTime() - 10 * MIN)})`);
    await expireAbuseRecord(user);
    const { deletion, steps } = await deleteDuringMaintenance(h, browser);
    expect(steps).toEqual({ orphanedSteps: 'ok', pruneAuth: 'ok' });
    expect([deletion.status, deletion.json]).toMatchObject([200, { deleted: true }]);
    expect(h.logs.filter((l) => /40P01|deadlock/i.test(l))).toEqual([]);
    expect(await count('briefs')).toBe(0);
    expect(await count('brief_steps')).toBe(0);
  });

  it('a confirmation asked for again while the account is deleted: nothing holds a confirmation while it waits for the session, no deadlock', async () => {
    const h = harness();
    const browser = new CookieJar();
    await signIn(h, browser, newUser());
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} })).json).toMatchObject({ next: 'confirm' });
    const sessionId = (await rows<{ id: string }>(sql`SELECT session_id::text AS id FROM auth_deletion_confirmations`))[0]!.id;
    // Something holds the confirmation row a moment. A second start must not wait there while
    // the deletion, holding the session, waits for the same row (an earlier version did:
    // it then asked for the session and deadlocked).
    const locker = await holdLocks(`SELECT 1 FROM auth_deletion_confirmations WHERE session_id = '${sessionId}'::uuid FOR UPDATE`);
    let again: Promise<Sent> | null = null;
    let deletion: Promise<Sent> | null = null;
    try {
      let againDone = false;
      again = send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} }).finally(() => {
        againDone = true;
      });
      const waiting = async () => (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`))[0]!.n;
      await until(async () => againDone || (await waiting()) >= 1, 'the second start to finish or wait');
      deletion = send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
      await untilBlocked(againDone ? 1 : 2);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    const [restarted, deleted] = await Promise.all([again!, deletion!]);
    expect(restarted.status).toBe(200);
    expect([deleted.status, deleted.json]).toMatchObject([200, { deleted: true }]);
    expect(h.logs.filter((l) => /40P01|deadlock/i.test(l))).toEqual([]);
    expect(await count('auth_users')).toBe(0);
    expect(await count('auth_deletion_confirmations')).toBe(0);
  });

  it('another browser of the account asking for a confirmation while the account is deleted gets none, not an error', async () => {
    const h = harness();
    const user = newUser();
    const browser = new CookieJar();
    await signIn(h, browser, user);
    const laptop = new CookieJar();
    await signIn(h, laptop, user);
    expect((await send(h, 'POST', '/api/account/delete/start', { jar: browser, body: {} })).json).toMatchObject({ next: 'confirm' });
    // The deletion pauses after the sessions, at the user row.
    const userId = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;
    const locker = await holdLocks(`SELECT 1 FROM auth_users WHERE id = '${userId}'::uuid FOR KEY SHARE`);
    let deletion: Promise<Sent> | null = null;
    let other: Promise<Sent> | null = null;
    try {
      deletion = send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
      await untilBlocked(1);
      // The laptop's confirmation would belong to a session the deletion is removing.
      other = send(h, 'POST', '/api/account/delete/start', { jar: laptop, body: {} });
      await untilBlocked(2);
      await locker.commit();
    } finally {
      await locker.rollback();
    }
    expect([(await deletion!).status, (await deletion!).json]).toMatchObject([200, { deleted: true }]);
    expect([(await other!).status, (await other!).json]).toEqual([200, { next: 'reauthenticate' }]);
    expect(await count('auth_deletion_confirmations')).toBe(0);
  });
});

describe('storage', () => {
  it('aviation_ingest sees nothing; aviation_app updates nothing and cannot keep tokens, pictures or addresses', async () => {
    const h = harness();
    await signIn(h, new CookieJar(), newUser());
    for (const table of ['auth_users', 'auth_sessions', 'auth_accounts', 'auth_verifications']) {
      expect(await sqlState(ingest.execute(sql.raw(`SELECT count(*) FROM ${table}`))), table).toBe('42501');
    }
    expect(await sqlState(appDb.execute(sql`UPDATE auth_users SET name = 'x'`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`UPDATE auth_sessions SET expires_at = now() + interval '1 year'`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`UPDATE auth_accounts SET account_id = 'x'`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`DELETE FROM auth_accounts`))).toBe('42501');
    const userId = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;
    expect(await sqlState(appDb.execute(sql`
      INSERT INTO auth_accounts (account_id, provider_id, user_id, access_token, created_at, updated_at)
      VALUES ('1234', 'google', ${userId}::uuid, 'ya29.secret', now(), now())`))).toBe('23514');
    expect(await sqlState(appDb.execute(sql`
      INSERT INTO auth_sessions (token, user_id, expires_at, created_at, updated_at, ip_address)
      VALUES ('0123456789abcdefghij', ${userId}::uuid, now() + interval '1 day', now(), now(), '203.0.113.5')`))).toBe('23514');
    expect(await sqlState(appDb.execute(sql`
      INSERT INTO auth_users (name, email, email_verified, image, created_at, updated_at)
      VALUES ('x', 'x@example.com', true, 'https://example.com/x.png', now(), now())`))).toBe('23514');
    expect(await sqlState(appDb.execute(sql`
      INSERT INTO auth_users (name, email, email_verified, created_at, updated_at)
      VALUES ('x', 'unverified@example.com', false, now(), now())`))).toBe('23514');
    expect(await sqlState(appDb.execute(sql`SELECT delete_account_content('not-an-hmac')`))).toBe('22023');
  });

  it('retention deletes expired sessions and OAuth state and keeps live ones', async () => {
    const h = harness();
    const jar = new CookieJar();
    await signIn(h, jar, newUser());
    const userId = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;
    await migrator.execute(sql`
      INSERT INTO auth_sessions (token, user_id, expires_at, created_at, updated_at)
      VALUES ('expired-session-token-0001', ${userId}::uuid, now() - interval '1 hour', now() - interval '8 days', now() - interval '8 days')`);
    await migrator.execute(sql`
      INSERT INTO auth_verifications (identifier, value, expires_at, created_at, updated_at)
      VALUES ('auth-state:old', '{}', now() - interval '1 hour', now() - interval '2 hours', now() - interval '2 hours')`);
    await migrator.execute(sql`
      INSERT INTO auth_state_uses (state_hash, used_at, expires_at)
      VALUES (${'e'.repeat(64)}, now() - interval '2 hours', now() - interval '1 hour')`);
    expect(await pruneAuth(appDb)).toEqual({ sessions: 1, verifications: 1, stateUses: 1, confirmations: 0 });
    expect(await count('auth_sessions')).toBe(1);
    expect(await count('auth_verifications')).toBe(0);
    // The live use of the sign-in above stays until its state would have expired.
    expect(await count('auth_state_uses')).toBe(1);
    expect(await account(h, jar)).toMatchObject({ signedIn: true });
  });

  it('logs and responses carry no email, subject, token, state or nonce', async () => {
    const h = harness({ scope: OFF_TOPIC });
    const browser = new CookieJar();
    const { briefId } = await trialBrief(h, browser);
    const user = newUser({ email: 'private.person@example.com' });
    const url = await startSignIn(h, browser, `/briefs/${briefId}`);
    const asked = MockGoogle.parse(url);
    await callback(h, browser, google.authorize(url, user));
    expect((await deleteAccount(h, browser)).status).toBe(200);
    const text = h.logs.join('\n');
    for (const secret of [user.email, user.sub, asked.state!, asked.nonce!, browser.get(TRIAL)!, AUTH_SECRET, CLIENT_SECRET]) {
      expect(text.includes(secret), secret).toBe(false);
    }
    const hashed = createHash('sha256').update(user.sub).digest('hex');
    expect(text.includes(hashed)).toBe(false);
  });
});
