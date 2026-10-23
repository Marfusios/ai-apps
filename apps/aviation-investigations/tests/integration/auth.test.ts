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
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { AccountResponseSchema } from '../../shared/contracts/account.js';
import { TURNSTILE_ACTION } from '../../shared/contracts/ai.js';
import { StartBriefResponseSchema, type StartBriefResponse } from '../../shared/contracts/briefs.js';
import { createFakeProvider, type FakeProvider, type FakeScript } from '../../server/ai/fake.js';
import type { ScopeOutput } from '../../server/ai/provider.js';
import { createAiRuntime, type AiRuntime } from '../../server/ai/runtime.js';
import { buildApp } from '../../server/app.js';
import { AUTH_IP_HEADER, GOOGLE_ISSUER, createAuthService, type AuthLog, type AuthService } from '../../server/auth/better-auth.js';
import { pruneAuth } from '../../server/auth/deletion.js';
import { createBriefServices, type BriefServices } from '../../server/briefs/services.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { accountIdentityHash } from '../../server/quota/policy.js';
import { FakeRetriever } from '../support/fake-retriever.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';
import { CookieJar, MockGoogle, type GoogleUser } from '../support/mock-google.js';
import { sqlState } from './corpus-helpers.js';
import { resetControls, testDb } from './helpers.js';

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
    // The OAuth state was consumed.
    expect(await count('auth_verifications')).toBe(0);

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
const STATE = '__Host-aviation_auth_state';

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

describe('sign-in protections', () => {
  it('cookies: host-only, HttpOnly, SameSite=Lax, Secure with __Host- names over https; sign-out expires the session', async () => {
    const h = harness();
    const jar = new CookieJar();
    const start = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body: signInBody('/') });
    const state = cookieNamed(start.setCookies, STATE);
    expect(state).toBeDefined();
    for (const attr of [/;\s*Max-Age=300(;|$)/i, /;\s*Path=\/(;|$)/i, /;\s*HttpOnly(;|$)/i, /;\s*Secure(;|$)/i, /;\s*SameSite=Lax(;|$)/i]) expect(state).toMatch(attr);
    expect(state).not.toMatch(/;\s*Domain=/i);
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
    const state = cookieNamed(start.setCookies, 'aviation_auth_state');
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
    ];
    for (const body of offSite) {
      const r = await send(h, 'POST', '/api/auth/sign-in/social', { jar, body });
      expect([400, 403], JSON.stringify(body)).toContain(r.status);
    }
    expect(await count('auth_verifications')).toBe(0);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it('state: a callback without it, from another browser, twice, or after Google refused creates no session', async () => {
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
    expect(stranger.headers.location).toBe('/briefs-page?signin=failed&error=state_mismatch');
    expect(google.tokenRequests).toHaveLength(0);

    // The browser that started it completes it once; a replay of the same callback fails.
    const ok = await callback(h, jar, path);
    expect(ok.headers.location).toBe('/briefs-page?welcome=1');
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
    const before = { reservations: await count('reservations'), steps: await count('brief_steps'), siteverify: h.sv.calls.length };
    const trialUsed = await rows(sql`SELECT requests_used FROM trial_identities`);
    advance(MIN);
    expect(errorOf(await ask(h, browser, 'Write me a poem about the sea', { key: askKey }))).toEqual([403, 'moved']);
    expect(errorOf(await refine(h, browser, briefId, 'Only seaplanes', { key: refineKey }))).toEqual([403, 'moved']);
    // Never a replay and never a new run: nothing admitted, charged or checked.
    expect({ reservations: await count('reservations'), steps: await count('brief_steps'), siteverify: h.sv.calls.length }).toEqual(before);
    expect(await rows(sql`SELECT requests_used FROM trial_identities`)).toEqual(trialUsed);
    // The brief itself is not the trial's to read.
    expect((await send(h, 'GET', `/api/briefs/${briefId}`, { jar: browser })).status).toBe(404);

    // Signed in again, the same retry is redirected to the account: the brief, not a second run.
    await signIn(h, browser, user, '/');
    const replay = await ask(h, browser, 'Write me a poem about the sea', { key: askKey, token: false });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ kind: 'scope_reply', briefId, step: 1 });
    expect({ reservations: await count('reservations'), steps: await count('brief_steps'), siteverify: h.sv.calls.length }).toEqual(before);
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

    expect((await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } })).status).toBe(200);
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

    // Refused: signed out, cross-site, or without the confirmation.
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: trialOnly(browser), body: { confirm: true } }))).toEqual([403, 'sign_in_required']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true }, headers: { 'sec-fetch-site': 'cross-site' } }))).toEqual([403, 'forbidden']);
    expect(errorOf(await send(h, 'POST', '/api/account/delete', { jar: browser, body: {} }))).toEqual([400, 'bad_request']);
    expect(await count('auth_users')).toBe(1);

    const deleted = await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
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
    const deleted = await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
    expect(deleted.status).toBe(200);
    release();
    await h.svc.settled();
    expect(await count('briefs')).toBe(0);
    expect(await rows(sql`SELECT status FROM reservations`)).toEqual([{ status: 'settled' }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL`)).toEqual([{ n: 0 }]);
    const line = h.logs.map((l) => JSON.parse(l) as { msg?: string; accountDeleted?: { cancelledSteps: number } }).find((l) => l.msg === 'account deleted');
    expect(line?.accountDeleted?.cancelledSteps).toBe(1);
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
    await startSignIn(h, new CookieJar(), '/');
    const userId = (await rows<{ id: string }>(sql`SELECT id::text AS id FROM auth_users`))[0]!.id;
    await migrator.execute(sql`
      INSERT INTO auth_sessions (token, user_id, expires_at, created_at, updated_at)
      VALUES ('expired-session-token-0001', ${userId}::uuid, now() - interval '1 hour', now() - interval '8 days', now() - interval '8 days')`);
    await migrator.execute(sql`
      INSERT INTO auth_verifications (identifier, value, expires_at, created_at, updated_at)
      VALUES ('auth-state:old', '{}', now() - interval '1 hour', now() - interval '2 hours', now() - interval '2 hours')`);
    expect(await pruneAuth(appDb)).toEqual({ sessions: 1, verifications: 1 });
    expect(await count('auth_sessions')).toBe(1);
    expect(await count('auth_verifications')).toBe(1);
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
    await send(h, 'POST', '/api/account/delete', { jar: browser, body: { confirm: true } });
    const text = h.logs.join('\n');
    for (const secret of [user.email, user.sub, asked.state!, asked.nonce!, browser.get(TRIAL)!, AUTH_SECRET, CLIENT_SECRET]) {
      expect(text.includes(secret), secret).toBe(false);
    }
    const hashed = createHash('sha256').update(user.sub).digest('hex');
    expect(text.includes(hashed)).toBe(false);
  });
});
