/**
 * Google sign-in without a database or network: the ID-token claim checks, the
 * configuration rules, cookie names, the network identity Better Auth's limiter keys on,
 * the handover's return-path and state parsing, log sanitizing, the account contracts,
 * Better Auth's own schema check against our Drizzle tables, and what `GET /api/config`
 * says about sign-in.
 */
import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import {
  AccountResponseSchema,
  DELETE_REAUTH_PATH,
  DeleteStartResponseSchema,
  RETURN_PATH_MAX,
  ReturnPathSchema,
  SignInRequestSchema,
} from '../../shared/contracts/account.js';
import { PRIVACY_NOTICE } from '../../shared/privacy.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import {
  AUTH_IP_HEADER,
  GOOGLE_ISSUER,
  authClientIp,
  authConfigProblem,
  authCookieNames,
  createAuthService,
  decodeJwtClaims,
  pendingSignOutCookieName,
  sanitizeAuthLogMessage,
  signedSessionToken,
  verifiedGoogleUser,
  type AuthService,
} from '../../server/auth/better-auth.js';
import { briefOfReturnPath, parseHandoverCandidate } from '../../server/auth/handover.js';
import { ACCOUNT_LOCK_CLASS, accountLockKey } from '../../server/auth/lifecycle.js';
import type { Db } from '../../server/db/client.js';
import { isNoStoreRoute } from '../../server/http/cache-headers.js';
import { ERROR_MESSAGES } from '../../server/http/reply.js';
import { TrialIdentities } from '../../server/identity/trial.js';
import { quotaPolicy } from '../../server/quota/policy.js';
import { configRoutes } from '../../server/routes/config.js';
import type { ApiContext } from '../../server/routes/context.js';

const CLIENT_ID = 'casebook-test.apps.googleusercontent.com';
const NOW = Date.parse('2026-11-01T10:00:00Z');
const NONCE = 'n'.repeat(43);

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }, signature = 'c2lnbmF0dXJl') =>
  `${b64(header)}.${b64(claims)}.${signature}`;
const claims = (over: Record<string, unknown> = {}) => {
  const c: Record<string, unknown> = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '109876543210987654321',
    email: 'Pilot@Example.com',
    email_verified: true,
    name: 'Test Pilot',
    picture: 'https://example.com/p.png',
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
    nonce: NONCE,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete c[k];
    else c[k] = v;
  }
  return c;
};
const verify = (over: Record<string, unknown> = {}, nonce: string | null = NONCE) =>
  verifiedGoogleUser(jwt(claims(over)), { clientId: CLIENT_ID, nonce, nowMs: NOW });

describe('the Google ID token', () => {
  it('a token for this client, with this flow’s nonce and a verified email, is the user: name and lower-case email only', () => {
    const v = verify();
    expect(v).toMatchObject({ ok: true, user: { name: 'Test Pilot', email: 'pilot@example.com', emailVerified: true } });
    if (v.ok) {
      expect(Object.keys(v.user).sort()).toEqual(['email', 'emailVerified', 'name']);
      expect(v.claims.sub).toBe('109876543210987654321');
    }
    expect(verify({ iss: 'accounts.google.com' }).ok).toBe(true);
    // An audience list naming only this client, with or without azp.
    expect(verify({ aud: [CLIENT_ID] }).ok).toBe(true);
    expect(verify({ aud: [CLIENT_ID], azp: undefined }).ok).toBe(true);
  });

  it.each([
    ['malformed', 'not a jwt'],
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'someone-else' }],
    ['audience', { azp: 'someone-else' }],
    // OIDC Core 3.1.3.7 step 3: an additional audience the client does not trust refuses the token.
    ['audience', { aud: ['other', CLIENT_ID], azp: undefined }],
    ['audience', { aud: [CLIENT_ID, 'other'] }],
    ['audience', { aud: [] }],
    ['audience', { aud: 42 }],
    ['expired', { exp: NOW / 1000 - 61 }],
    ['expired', { exp: undefined }],
    ['expired', { exp: String(NOW / 1000 + 3600) }],
    ['expired', { exp: 1e400 }],
    ['issued_at', { iat: undefined }],
    ['issued_at', { iat: String(NOW / 1000) }],
    ['issued_at', { iat: NOW / 1000 + 120 }],
    ['issued_at', { iat: NOW / 1000 + 4000, exp: NOW / 1000 + 3600 }],
    ['subject', { sub: '' }],
    ['subject', { sub: 'has space' }],
    ['subject', { sub: 'x'.repeat(256) }],
    ['email', { email: undefined }],
    ['email', { email: 'not-an-email' }],
    ['email_not_verified', { email_verified: false }],
    ['email_not_verified', { email_verified: 'true' }],
    ['nonce', { nonce: undefined }],
    ['nonce', { nonce: 'another' }],
  ] as const)('refuses: %s %j', (reason, over) => {
    const v = typeof over === 'string' ? verifiedGoogleUser(over, { clientId: CLIENT_ID, nonce: NONCE, nowMs: NOW }) : verify(over);
    expect(v).toEqual({ ok: false, reason });
  });

  it('only an RS256-signed form is read: an unsigned, alg none or other-algorithm token is refused before its claims', () => {
    const good = claims();
    const read = (token: string) => verifiedGoogleUser(token, { clientId: CLIENT_ID, nonce: NONCE, nowMs: NOW });
    expect(read(jwt(good)).ok).toBe(true);
    expect(read(jwt(good, { alg: 'none' }, ''))).toEqual({ ok: false, reason: 'algorithm' });
    expect(read(jwt(good, { alg: 'none' }))).toEqual({ ok: false, reason: 'algorithm' });
    expect(read(jwt(good, { alg: 'RS256' }, ''))).toEqual({ ok: false, reason: 'algorithm' });
    expect(read(jwt(good, { alg: 'HS256' }))).toEqual({ ok: false, reason: 'algorithm' });
    expect(read(jwt(good, { typ: 'JWT' }))).toEqual({ ok: false, reason: 'algorithm' });
    expect(read(`${Buffer.from('not json').toString('base64url')}.${b64(good)}.c2ln`)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('no expected nonce (lost OAuth state) refuses every token; a long name is cut, control characters dropped', () => {
    expect(verify({}, null)).toEqual({ ok: false, reason: 'nonce' });
    const v = verify({ name: `A\u0000B${'x'.repeat(300)}` });
    expect(v.ok && v.user.name).toBe(`AB${'x'.repeat(198)}`);
    expect(verifiedGoogleUser(undefined, { clientId: CLIENT_ID, nonce: NONCE, nowMs: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('decodes only compact JWT claims objects', () => {
    expect(decodeJwtClaims(jwt({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwtClaims('a.b')).toBeNull();
    expect(decodeJwtClaims(`${b64({})}.${Buffer.from('[1]').toString('base64url')}.x`)).toBeNull();
    expect(decodeJwtClaims(`${b64({})}.!!!.x`)).toBeNull();
  });
});

describe('configuration', () => {
  const base = (auth: Partial<AppConfig['auth']>, over: Partial<Pick<AppConfig, 'appEnv' | 'appUrl'>> = {}) => ({
    appEnv: over.appEnv ?? ('dev' as const),
    appUrl: over.appUrl ?? 'https://casebook.example',
    auth: { identityHmacSecret: 'i'.repeat(32), secret: 's'.repeat(32), googleClientId: CLIENT_ID, googleClientSecret: 'secret', ...auth },
  });

  it('Google sign-in needs the client ID and secret, a 32-character BETTER_AUTH_SECRET and the identity key; live needs https', () => {
    expect(authConfigProblem(base({}))).toBeNull();
    expect(authConfigProblem(base({ googleClientId: undefined }))).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
    expect(authConfigProblem(base({ googleClientSecret: undefined }))).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
    expect(authConfigProblem(base({ secret: 'short' }))).toMatch(/BETTER_AUTH_SECRET/);
    expect(authConfigProblem(base({ identityHmacSecret: undefined }))).toMatch(/IDENTITY_HMAC_SECRET/);
    expect(authConfigProblem(base({}, { appEnv: 'live', appUrl: 'http://casebook.example' }))).toMatch(/https/);
    expect(authConfigProblem(base({}, { appEnv: 'dev', appUrl: 'http://localhost:3000' }))).toBeNull();
  });

  it('the final privacy notice is published, so live may turn Google sign-in on (owner approval, 2026-10-24)', () => {
    expect(PRIVACY_NOTICE.final).toBe(true);
    expect(authConfigProblem(base({}, { appEnv: 'live' }))).toBeNull();
  });

  it('a draft privacy notice keeps live Google sign-in off, and only live (DESIGN §7)', () => {
    const draft = { final: false } as const;
    expect(authConfigProblem(base({}, { appEnv: 'live' }), draft)).toMatch(/final privacy notice/);
    expect(authConfigProblem(base({}, { appEnv: 'dev' }), draft)).toBeNull();
  });

  it('problems name settings, never values', () => {
    const problem = authConfigProblem(base({ secret: 'a-short-secret' }));
    expect(problem).not.toContain('a-short-secret');
  });

  it('cookie names carry __Host- over https only', () => {
    expect(authCookieNames(true)).toMatchObject({ session_token: '__Host-aviation_session', oauth_state: '__Host-aviation_oauth_state' });
    expect(authCookieNames(false)).toMatchObject({ session_token: 'aviation_session', oauth_state: 'aviation_oauth_state' });
  });

  it('Better Auth’s limiter gets the network identity as an address; an IPv6 /64 as its network address', () => {
    expect(authClientIp('203.0.113.9')).toBe('203.0.113.9');
    expect(authClientIp('2001:db8:1:2::/64')).toBe('2001:db8:1:2::');
    expect(AUTH_IP_HEADER).toBe('x-aviation-client-ip');
  });

  it('every auth and account route is per visitor and never stored', () => {
    for (const route of ['/api/auth/*', '/api/account', '/api/account/delete/start', '/api/account/delete']) expect(isNoStoreRoute(route), route).toBe(true);
  });
});

describe('the handover state', () => {
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';

  it('only a brief path names a brief', () => {
    expect(briefOfReturnPath(`/briefs/${id}`)).toBe(id);
    expect(briefOfReturnPath(`/briefs/${id}?step=2&case=DFW08TA066`)).toBe(id);
    for (const path of ['/', `/briefs/${id}/x`, `/briefs/${id.toUpperCase()}`, '/briefs/not-a-uuid', `/cases/${id}`, `//briefs/${id}`]) {
      expect(briefOfReturnPath(path), path).toBeNull();
    }
  });

  it('one lifecycle lock per account: the class and the first 32 bits of its HMAC (a re-registered account has the same)', () => {
    expect(accountLockKey('8'.repeat(64))).toEqual([ACCOUNT_LOCK_CLASS, 0x88888888 | 0]);
    expect(accountLockKey(`0000000a${'f'.repeat(56)}`)).toEqual([ACCOUNT_LOCK_CLASS, 10]);
    for (const bad of ['', 'x'.repeat(64), 'A'.repeat(64), '8'.repeat(63)]) expect(() => accountLockKey(bad), bad).toThrow();
  });

  it('reads back only a well-formed candidate', () => {
    expect(parseHandoverCandidate({ briefId: id, from: 'a'.repeat(64) })).toEqual({ briefId: id, from: 'a'.repeat(64) });
    for (const bad of [null, 'x', { briefId: id }, { briefId: 'x', from: 'a'.repeat(64) }, { briefId: id, from: 'A'.repeat(64) }]) {
      expect(parseHandoverCandidate(bad)).toBeNull();
    }
  });
});

describe('contracts and copy', () => {
  it('return paths stay on this site', () => {
    for (const ok of ['/', '/briefs/x?step=2', '/account?signin=failed', DELETE_REAUTH_PATH, '/files/a.b', '/x?next=//y', '/.well']) {
      expect(ReturnPathSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', 'https://evil.example/', '//evil.example', '/\\evil', '/a#b', 'javascript:alert(1)', `/${'x'.repeat(RETURN_PATH_MAX)}`, '/a\nb']) {
      expect(ReturnPathSchema.safeParse(bad).success, bad).toBe(false);
    }
    // Dot segments and encoded separators: `/.//evil.example/x` resolves to `//evil.example/x`.
    for (const bad of ['/.//evil.example/x', '/./x', '/../x', '/a/..', '/a/.', '/%2e%2e/x', '/%2E/x', '/a%2fb', '/a%5Cb', '/a//b']) {
      expect(ReturnPathSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('return paths are capped in bytes: visible ASCII without a quote, one byte each in the state cookie (Task 20 review N8)', () => {
    // What the page sends: percent-encoded, with the URL and query punctuation browsers leave as is.
    const ok = `/explore?q=caf%C3%A9+%22icing%22&phase=landing,takeoff&x=(a)*[b]~!$'@:;`;
    expect(ReturnPathSchema.safeParse(ok).success).toBe(true);
    expect(ReturnPathSchema.safeParse(`/${'~'.repeat(RETURN_PATH_MAX - 1)}`).success).toBe(true);
    // Characters that would be wider in the cookie's JSON, and spaces and controls.
    for (const bad of ['/a"b', '/caf\u00e9', '/\u20ac', '/a b', '/a\tb', '/a\u007fb', '/a\u0085b', '/\ud83d\ude00']) {
      expect(ReturnPathSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // The review's widest cases: paths of quotes or euro signs within the character cap.
    expect(ReturnPathSchema.safeParse(`/${'"'.repeat(RETURN_PATH_MAX - 1)}`).success).toBe(false);
    expect(ReturnPathSchema.safeParse(`/${'\u20ac'.repeat(RETURN_PATH_MAX - 1)}`).success).toBe(false);
  });

  it('the sign-in request is exactly the expected fields', () => {
    const body = { provider: 'google', callbackURL: '/', newUserCallbackURL: '/?welcome=1', errorCallbackURL: '/?signin=failed', disableRedirect: true };
    expect(SignInRequestSchema.safeParse(body).success).toBe(true);
    expect(SignInRequestSchema.safeParse({ ...body, idToken: { token: 'x' } }).success).toBe(false);
    expect(SignInRequestSchema.safeParse({ ...body, scopes: ['x'] }).success).toBe(false);
  });

  it('the account says who is signed in and nothing more', () => {
    const id = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
    expect(AccountResponseSchema.safeParse({ signedIn: true, user: { id, name: 'A', email: 'a@example.com', sub: 'x' } }).success).toBe(false);
    expect(AccountResponseSchema.safeParse({ signedIn: false, user: { id, name: 'A', email: 'a@example.com' } }).success).toBe(false);
    expect(AccountResponseSchema.safeParse({ signedIn: false, deletionConfirmedUntil: '2026-11-01T10:05:00.000Z' }).success).toBe(false);
    const until = '2026-11-01T10:05:00.000Z';
    expect(AccountResponseSchema.parse({ signedIn: true, user: { id, name: 'A', email: 'a@example.com' }, deletionConfirmedUntil: until })).toMatchObject({ deletionConfirmedUntil: until });
  });

  it('a signed-in account always carries its application id, a UUID: the browser tells one account from another by it, not by e-mail', () => {
    const user = { name: 'A', email: 'a@example.com' };
    expect(AccountResponseSchema.safeParse({ signedIn: true, user }).success).toBe(false);
    for (const id of ['x', '', 'google-subject-1234567890', '6f1c2d3e4b5a4c6d8e7f0a1b2c3d4e5f']) {
      expect(AccountResponseSchema.safeParse({ signedIn: true, user: { id, ...user } }).success, id).toBe(false);
    }
    expect(AccountResponseSchema.parse({ signedIn: true, user: { id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', ...user } })).toEqual({
      signedIn: true,
      user: { id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', ...user },
    });
  });

  it('deleting starts with a confirmation, or a Google sign-in first', () => {
    expect(DeleteStartResponseSchema.parse({ next: 'confirm', until: '2026-11-01T10:05:00.000Z' })).toEqual({ next: 'confirm', until: '2026-11-01T10:05:00.000Z' });
    expect(DeleteStartResponseSchema.parse({ next: 'reauthenticate' })).toEqual({ next: 'reauthenticate' });
    expect(DeleteStartResponseSchema.safeParse({ next: 'confirm' }).success).toBe(false);
    expect(DELETE_REAUTH_PATH).toBe('/account?delete=confirm');
    for (const code of ['signed_out', 'reauth_required'] as const) expect(ErrorResponseSchema.parse({ error: code, message: ERROR_MESSAGES[code] }).error).toBe(code);
  });

  it('a retry from the trial a brief moved away from is told to sign in', () => {
    expect(ErrorResponseSchema.parse({ error: 'moved', message: ERROR_MESSAGES.moved }).error).toBe('moved');
    expect(ERROR_MESSAGES.moved).toBe('This AI search moved to the account that signed in. Sign in to view it.');
  });

  it('sanitized log lines keep the message, never an email address or what was attached', () => {
    expect(sanitizeAuthLogMessage('Invalid origin: https://evil.example')).toBe('Invalid origin: https://evil.example');
    expect(sanitizeAuthLogMessage('duplicate key (email)=(someone@example.com) exists')).toBe('duplicate key (email)=(<email>) exists');
    expect(sanitizeAuthLogMessage({ message: 'x' })).toBe('auth message');
    expect(sanitizeAuthLogMessage('x'.repeat(500))).toHaveLength(160);
  });
});

describe('the service', () => {
  /** A database the schema check never touches (Drizzle's check reads the schema objects only). */
  const noDb = new Proxy({}, { get: () => { throw new Error('no database in unit tests'); } }) as unknown as Db;

  const SECRET = 's'.repeat(40);

  function service(db: Db = noDb, log: { warn: (o: object, m: string) => void } = { warn() {} }): AuthService {
    const config = loadConfig({ env: {}, files: [] });
    const cfg = {
      appEnv: 'dev' as const,
      appUrl: 'https://casebook.example',
      auth: { ...config.auth, identityHmacSecret: 'i'.repeat(32), ipHmacSecret: 'p'.repeat(32), secret: SECRET, googleClientId: CLIENT_ID, googleClientSecret: 'secret' },
    };
    const policy = quotaPolicy({ ai: config.ai, auth: cfg.auth });
    const trials = new TrialIdentities({ db: noDb, policy, secure: true });
    const made = createAuthService(cfg, { db, policy, trials, log: { info() {}, warn: log.warn, error() {} } });
    if (!made.service) throw new Error(made.problem);
    return made.service;
  }

  it('Better Auth’s schema check finds our Drizzle tables complete', async () => {
    await expect(service().checkSchema()).resolves.toBeUndefined();
  });

  it('without a session cookie nothing is looked up', async () => {
    const s = service();
    await expect(s.signedIn(undefined)).resolves.toBeNull();
    await expect(s.signedIn('__Host-aviation_trial=v1.x.y')).resolves.toBeNull();
  });

  it('expires the session cookies with the same attributes', () => {
    expect(service().expiredSessionCookies()).toEqual([
      '__Host-aviation_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
      '__Host-aviation_session_data=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
      '__Host-aviation_dont_remember=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
    ]);
  });

  it('accounts are keyed by Google’s issuer', () => {
    expect(GOOGLE_ISSUER).toBe('https://accounts.google.com');
  });

  /** A session cookie value as Better Auth sets it (better-call: token, dot, base64 HMAC-SHA256, URL-encoded). */
  const sessionCookie = (token: string, secret = SECRET) =>
    encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`);
  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

  it('a sign-out names its session by Better Auth’s signed cookie alone, without the database', () => {
    expect(signedSessionToken(sessionCookie(TOKEN), SECRET)).toBe(TOKEN);
    expect(signedSessionToken(decodeURIComponent(sessionCookie(TOKEN)), SECRET)).toBe(TOKEN);
    // Another secret, a changed token, no signature, a cut signature or a malformed encoding: none.
    expect(signedSessionToken(sessionCookie(TOKEN, 'x'.repeat(40)), SECRET)).toBeNull();
    expect(signedSessionToken(sessionCookie(TOKEN).replace('AbC', 'XbC'), SECRET)).toBeNull();
    expect(signedSessionToken(TOKEN, SECRET)).toBeNull();
    expect(signedSessionToken(`${TOKEN}.c2ln`, SECRET)).toBeNull();
    expect(signedSessionToken('%E0%A4%A', SECRET)).toBeNull();
    expect(signedSessionToken(`${'a'.repeat(600)}.${'b'.repeat(43)}=`, SECRET)).toBeNull();
  });

  it('a pending sign-out is sealed, sent only under /api, and finished without the session the browser holds now', async () => {
    const deleted: string[][] = [];
    let failing = false;
    const dialect = new PgDialect();
    const db = {
      async execute(query: SQL) {
        if (failing) throw Object.assign(new Error('Connection terminated unexpectedly'), { name: 'Error' });
        const { sql: text, params } = dialect.sqlToQuery(query);
        expect(text).toMatch(/^DELETE FROM auth_sessions WHERE token = ANY\(\$1::text\[\]\)$/);
        deleted.push(params[0] as string[]);
        return { rows: [] };
      },
    } as unknown as Db;
    const warnings: object[] = [];
    const s = service(db, { warn: (o) => void warnings.push(o) });
    const name = pendingSignOutCookieName(true);
    expect(name).toBe('__Secure-aviation_signout');
    const session = `__Host-aviation_session=${sessionCookie(TOKEN)}`;
    // The database fails: not finished, and logged without the token.
    failing = true;
    await expect(s.finishSignOut(session, { session: true })).resolves.toBe(false);
    expect(JSON.stringify(warnings)).not.toContain(TOKEN);
    expect(warnings).toEqual([{ signOut: 'unconfirmed', err: { name: 'Error' } }]);
    const kept = s.pendingSignOutCookie(session);
    expect(kept).toMatch(/^__Secure-aviation_signout=v1\.[A-Za-z0-9_-]+; Max-Age=604800; Path=\/api; HttpOnly; SameSite=Lax; Secure$/);
    expect(kept).not.toContain(TOKEN);
    const pending = kept.split(';', 1)[0]!;
    expect(s.hasPendingSignOut(pending)).toBe(true);
    expect(s.hasPendingSignOut(session)).toBe(false);
    // Signed in again (another session): the account read ends only the pending one.
    failing = false;
    const OTHER = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
    await expect(s.finishSignOut(`__Host-aviation_session=${sessionCookie(OTHER)}; ${pending}`, { session: false })).resolves.toBe(true);
    expect(deleted).toEqual([[TOKEN]]);
    // A sign-out ends both.
    await expect(s.finishSignOut(`__Host-aviation_session=${sessionCookie(OTHER)}; ${pending}`, { session: true })).resolves.toBe(true);
    expect(deleted[1]!.sort()).toEqual([OTHER, TOKEN].sort());
    // Only this server's seal opens: a forged or altered pending cookie names nothing.
    deleted.length = 0;
    const altered = pending.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(s.finishSignOut(altered, { session: false })).resolves.toBe(true);
    await expect(s.finishSignOut(`${name}=${encodeURIComponent(JSON.stringify([sessionCookie(TOKEN)]))}`, { session: false })).resolves.toBe(true);
    expect(deleted).toEqual([]);
    // Pending sign-outs are never evicted (gate t22 finding 2): every one is kept and ended.
    const tokens = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((t) => t.padEnd(32, 'x'));
    let jar = '';
    for (const t of tokens) jar = s.pendingSignOutCookie(`__Host-aviation_session=${sessionCookie(t)}${jar ? `; ${jar}` : ''}`).split(';', 1)[0]!;
    await expect(s.finishSignOut(jar, { session: false })).resolves.toBe(true);
    expect(deleted).toEqual([tokens]);
    expect(s.donePendingSignOutCookie()).toBe('__Secure-aviation_signout=; Max-Age=0; Path=/api; HttpOnly; SameSite=Lax; Secure');
  });
});

describe('GET /api/config', () => {
  async function config(auth: AuthService | null) {
    const app = Fastify();
    const pinned = {
      dataset: { snapshotDate: '2026-10-16', revision: 'g1-test' },
      coverage: { defaultCohort: 1, otherRecords: 0, yearFrom: 2008, yearTo: 2026, provisional: true },
    };
    configRoutes(app, { datasets: { current: async () => pinned }, ai: null, auth } as unknown as ApiContext);
    const r = await app.inject({ method: 'GET', url: '/api/config' });
    await app.close();
    return ConfigResponseSchema.parse(JSON.parse(r.body));
  }

  it('offers Google sign-in only while it is configured', async () => {
    expect((await config(null)).googleEnabled).toBe(false);
    expect((await config({} as AuthService)).googleEnabled).toBe(true);
  });
});
