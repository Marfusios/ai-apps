/**
 * Google sign-in with Better Auth (Task 20; DESIGN §1, §7, §8, §11; SECURITY_REVIEW F11).
 * Better Auth runs the OAuth authorization-code flow, its state and PKCE, and the database
 * sessions; this module configures it and serves it under `/api/auth`.
 *
 * **Google only.** Scopes `openid email profile` (the provider's defaults, nothing added
 * and no incremental grants), online access only (no refresh token), `prompt` to pick the
 * account. No password sign-up, no ID-token sign-in from the browser, no account linking:
 * an account is the Google subject (`sub`), never the mutable email, and a second Google
 * account with an email already in use is refused. Off (`googleEnabled: false`, every
 * `/api/auth` route 404) unless GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BETTER_AUTH_SECRET
 * (at least 32 characters) and the identity HMAC key are set, and in live an https
 * APP_URL and the final privacy notice (`authConfigProblem`).
 *
 * **What the callback accepts.** The only way to an ID token here is Google's token
 * endpoint, which Better Auth calls over TLS at a fixed address with this flow's
 * single-use code, PKCE verifier and the client secret: ID-token sign-in is off
 * (`disableIdTokenSignIn`) and the route serves no other endpoint that takes a token. So
 * the signature is not checked again (OIDC Core 3.1.3.7, step 6). Everything else is
 * (`verifiedGoogleUser`): the header must name RS256 and carry a signature (an unsigned or
 * `alg: none` token is refused before its claims are read); the issuer; the audience must
 * be this client and nothing else, and `azp`, when present, this client; finite numeric
 * `exp` (not passed) and `iat` (not in the future); a well-formed `sub`; an email Google
 * reports as verified (`email_verified`); and the nonce. Better Auth's Google provider
 * sends no nonce in the redirect flow, so this module adds one: a `before` hook on
 * `/sign-in/social` puts a random nonce in the OAuth state's server context (which only
 * the server can write), an `after` hook adds it to Google's authorization URL, and the
 * callback refuses an ID token without that nonce. A refusal stores nothing: no user, no
 * account link, no session. Of the profile only the name and email are kept (no picture),
 * and of the provider response nothing else: no tokens, no scopes (database hooks clear
 * them, and CHECK constraints in migration 0017 refuse them).
 *
 * **The OAuth state lives in an encrypted cookie** (Better Auth's `cookie` strategy):
 * starting a sign-in writes nothing to the database. The state (its random value, the
 * PKCE verifier, the return paths, an expiry 10 minutes out and the server context: the
 * nonce, the brief a sign-in may take over, a deletion's re-authentication) is encrypted
 * and authenticated with a key derived from BETTER_AUTH_SECRET into the HttpOnly
 * `__Host-aviation_oauth_state` cookie; the client cannot read or change it. Nobody can
 * fill a store of pending sign-ins, so no cap is needed and no flood can block anyone's
 * sign-in (the Task 20 review's N1).
 *
 * **One use per callback.** A callback is accepted only with this browser's state cookie
 * for the state Google returns (Better Auth decrypts and compares it, then expires the
 * cookie). The first callback to get through the code exchange and the ID-token checks
 * claims the state in `getUserInfo` (`claimState`: a SHA-256 of the state in
 * `auth_state_uses`, one row per state, until the state would have expired); any other
 * callback with the same state is refused there, before a user, a session or a handover
 * is made. Only a browser holding the cookie, with Google's code for it, can claim it, so
 * a stranger cannot spend someone's sign-in, and the rows grow only with sign-ins Google
 * completed. Google's authorization code is single-use as well, so a duplicate normally
 * fails at its code exchange already.
 *
 * **Sessions.** Database sessions with a fixed 7-day lifetime: no refresh, and no cookie
 * cache, so sign-out, deletion and expiry take effect on the next request. Sessions keep
 * no IP address or user agent.
 *
 * **Signing out** is reported done only once the session is gone (gate 22 finding 1).
 * Better Auth's sign-out logs a failed session deletion and answers success all the same,
 * so after it the route ends the session itself (`finishSignOut`: one `DELETE` by the
 * token of the signed session cookie, checked against BETTER_AUTH_SECRET without the
 * database) and answers success only when that statement succeeds. When it fails, the
 * answer is 503 `sign_out_pending` with `Retry-After: 5`, and this browser is signed out
 * all the same: the session cookie is expired, and the sign-out is kept for a retry in
 * `__Secure-aviation_signout` (`aviation_signout` over plain http): the session cookie
 * values, every one kept, sealed with AES-256-GCM under a key derived from
 * BETTER_AUTH_SECRET, so only this server can open it, the page cannot read a token out of
 * it and it never works as a session cookie; HttpOnly, Path=/api, for the 7 days a session
 * can live, and SameSite=Lax like the OAuth state cookie: Google's redirect back to the
 * callback is a top-level navigation from another site, which carries no Strict cookie, and
 * the callback must see a pending sign-out (gate t22 r2 finding 2). Lax adds only top-level
 * GET navigations from other sites, and there the cookie can do no more than finish this
 * browser's own sign-out or hold up its sign-in. The browser's next sign-out, or its next account read
 * (`GET /api/account`, on every page load), ends those sessions and drops the cookie; an
 * account read never ends the session the browser holds now. Until then a copy of the old
 * cookie still works, which is why the sign-out was not reported done (503
 * `sign_out_pending`; the page forgets everything private it held all the same). No new
 * session is issued while a sign-out is pending: a sign-in finishes the pending ones first,
 * at its start and again at Google's callback, and is refused (503 `sign_out_pending`, or the
 * sign-in error page from the callback) while they cannot be finished, so the cookie never
 * has to drop an unconfirmed revocation to make room (gate t22 finding 2).
 *
 * **Deleting the account needs a recent sign-in** (server/auth/deletion.ts). A sign-in
 * that returns to `DELETE_REAUTH_PATH` from a signed-in browser carries the deletion intent
 * (the user and session it started from) in the state's server context and asks Google for
 * that account (`login_hint` = its subject). At the callback, when Google signed in the
 * same account, the new session gets the deletion confirmation, and the session the
 * browser had before ends (the re-authentication rotates it).
 *
 * **Cookies.** Host-only, HttpOnly, SameSite=Lax, Path=/; over https Secure with the
 * `__Host-` prefix (`__Host-aviation_session`, the OAuth state's
 * `__Host-aviation_oauth_state`), plain names for local http. The session cookie is
 * signed by Better Auth with BETTER_AUTH_SECRET; the state cookie is encrypted with it.
 *
 * **CSRF and origins.** Better Auth's checks stay on and are set explicitly (its own
 * default turns them off under NODE_ENV=test): the request `Origin` must be APP_URL's
 * whenever cookies are sent, and every return path must be on APP_URL. Before Better Auth
 * sees a POST, the route refuses cross-site requests (`Sec-Fetch-Site`, else `Origin`) and
 * non-JSON bodies. The OAuth state rides only in this browser's encrypted cookie for 10
 * minutes; a callback without it, or with another browser's, fails.
 *
 * **Rate limits.** Better Auth's limiter, per network identity: the route passes the
 * validated identity of server/http/network-identity.ts (never `request.ip` or a client
 * header; any client header of that name is dropped) as `AUTH_IP_HEADER`. On top of the
 * API's own limit per network identity. A deletion's re-authentication is never held up
 * by other sign-in traffic on its network: the route counts its start and Google's callback
 * to the signed-in browser per account instead (server/auth/deletion.ts
 * `reauthStartAllowed`, `reauthCallbackAllowed`) and marks them with `AUTH_REAUTH_HEADER`,
 * which only the route can set, and Better Auth's per-network limit skips them.
 *
 * **Logging.** Better Auth's log lines go to the server log as their message only, with
 * any email address replaced; never the values it attaches (errors may quote a row). An
 * unexpected error is answered as a plain 500, so Better Auth's router never prints it to
 * the console; at Google's callback the route sends the browser to the sign-in error page
 * instead (`AUTH_ERROR_PATH`). Telemetry is off.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, addOAuthServerContext, createAuthMiddleware, getOAuthState, isAPIError } from 'better-auth/api';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../shared/config.js';
import { DELETE_REAUTH_PATH, SignInRequestSchema } from '../../shared/contracts/account.js';
import { PRIVACY_NOTICE } from '../../shared/privacy.js';
import type { Db } from '../db/client.js';
import { AUTH_PROVIDER, AUTH_SCHEMA } from '../db/schema/auth.js';
import { isHttpsUrl } from '../http/security-headers.js';
import { cookieValues, type TrialIdentities } from '../identity/trial.js';
import { MIN_SECRET_LENGTH, principalHash, type Principal, type QuotaPolicy } from '../quota/policy.js';
import { endSession, issueDeletionConfirmation } from './deletion.js';
import type { AccountSession } from './lifecycle.js';
import { HANDOVER_CONTEXT_KEY, completeHandover, handoverCandidate, parseHandoverCandidate, type HandoverDeps } from './handover.js';

export type AccountPrincipal = Extract<Principal, { kind: 'account' }>;

/** The issuer every Google account principal is keyed under (with its `sub`). */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
/** The issuers Google's ID tokens carry. */
export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];
/** Where Better Auth is served. */
export const AUTH_BASE_PATH = '/api/auth';
/** Where a sign-in that failed without a page to return to lands (Better Auth adds `error=<code>`). */
export const AUTH_ERROR_PATH = '/account?signin=failed';
/** Request header carrying the validated network identity to Better Auth's limiter (set by the route only). */
export const AUTH_IP_HEADER = 'x-aviation-client-ip';
/** Sessions last this long and are never extended. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The OAuth-state key of the ID-token nonce. */
export const NONCE_CONTEXT_KEY = 'aviationNonce';
/** The OAuth-state key of a deletion's re-authentication: the user and session it started from, and the subject to ask Google for. */
export const REAUTH_CONTEXT_KEY = 'aviationReauth';
/**
 * Request header the route sets on a deletion's re-authentication start, and on a callback
 * to a signed-in browser, it has counted per account (only the route sets it: client
 * headers of that name are never forwarded); Better Auth's per-network limit skips them.
 */
export const AUTH_REAUTH_HEADER = 'x-aviation-reauth';
/** Allowed difference between our clock and Google's. */
const CLOCK_SKEW_MS = 60_000;

/**
 * A sign-out the database could not confirm is kept in this cookie for a retry (see the
 * module comment, "Signing out"): `__Secure-aviation_signout` over https, sent only under
 * `/api` (the sign-out request, the account read, a sign-in's start and Google's callback).
 */
export function pendingSignOutCookieName(secure: boolean): string {
  return `${secure ? '__Secure-' : ''}aviation_signout`;
}
const PENDING_SIGN_OUT_PATH = '/api';
/** What a sign-out the database could not confirm asks the browser to wait before trying again. */
export const SIGN_OUT_RETRY_SECONDS = 5;

/** Better Auth's limits: requests per network identity and minute, by endpoint. */
export interface AuthRateLimits {
  signIn: number;
  callback: number;
  signOut: number;
}
export const AUTH_RATE_LIMITS: AuthRateLimits = { signIn: 10, callback: 10, signOut: 20 };

/** The cookie names Better Auth uses here: `__Host-` (Secure, Path=/, no Domain) over https. */
export function authCookieNames(secure: boolean) {
  const prefix = secure ? '__Host-' : '';
  return {
    session_token: `${prefix}aviation_session`,
    session_data: `${prefix}aviation_session_data`,
    dont_remember: `${prefix}aviation_dont_remember`,
    state: `${prefix}aviation_auth_state`,
    oauth_state: `${prefix}aviation_oauth_state`,
    account_data: `${prefix}aviation_account_data`,
  } as const;
}

/** Why Google sign-in is off (setting names only), or null when it can run. */
export function authConfigProblem(config: Pick<AppConfig, 'appEnv' | 'appUrl' | 'auth'>): string | null {
  const { googleClientId, googleClientSecret, secret, identityHmacSecret } = config.auth;
  if (!googleClientId || !googleClientSecret) return 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set: Google sign-in is off';
  if (!secret || secret.length < MIN_SECRET_LENGTH) return `BETTER_AUTH_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters) for Google sign-in`;
  if (!identityHmacSecret || identityHmacSecret.length < MIN_SECRET_LENGTH) {
    return `IDENTITY_HMAC_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters) for Google sign-in`;
  }
  if (config.appEnv === 'live' && !isHttpsUrl(config.appUrl)) return 'APP_ENV=live requires an https APP_URL for Google sign-in';
  // DESIGN §7: publish the privacy notice before collecting real users (RUNBOOK, "Google sign-in").
  if (config.appEnv === 'live' && !PRIVACY_NOTICE.final) return 'APP_ENV=live keeps Google sign-in off until the final privacy notice is published (shared/privacy.ts)';
  return null;
}

/**
 * Better Auth's limiter keys clients by an IP address. The network identity is an IPv4
 * address or an IPv6 /64 (`2001:db8:1:2::/64`); the /64 is given as its network address,
 * which the limiter keeps as that /64.
 */
export function authClientIp(networkIdentity: string): string {
  return networkIdentity.endsWith('/64') ? networkIdentity.slice(0, -3) : networkIdentity;
}

// ---------------------------------------------------------------------------
// The ID token

export interface GoogleClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  exp: number;
  iat: number;
  nonce?: string;
}

/** One base64url JSON object of a compact JWT (its header or claims), unverified, or null. */
function decodeJwtPart(token: string, index: 0 | 1): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[index]) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[index], 'base64url').toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The claims of a compact JWT, unverified (see the module comment), or null. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  return decodeJwtPart(token, 1);
}

/** The algorithm Google signs ID tokens with. */
const GOOGLE_ID_TOKEN_ALG = 'RS256';
const SUBJECT = /^[!-~]{1,255}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/** At most `max` characters (whole code points), control characters removed. */
function clip(text: string, max: number): string {
  return Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, max).join('');
}

const finiteSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type GoogleRefusal =
  | 'malformed'
  | 'algorithm'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'issued_at'
  | 'subject'
  | 'email'
  | 'email_not_verified'
  | 'nonce';

/**
 * The user a Google ID token stands for, or why it is refused (OIDC Core 3.1.3.7; the
 * signature is not verified, see the module comment): an RS256 header and a signature
 * part (never an unsigned token); the issuer; the audience must be this client and only
 * this client (a token with any other audience is refused), and `azp`, when present, this
 * client; `exp` and `iat` finite numbers, the token not expired and not issued in the
 * future; the `sub` one printable token; the email one Google reports as verified; and
 * the nonce this flow's.
 */
export function verifiedGoogleUser(
  idToken: string | undefined,
  expect: { clientId: string; nonce: string | null; nowMs: number },
): { ok: true; claims: GoogleClaims; user: { name: string; email: string; emailVerified: true } } | { ok: false; reason: GoogleRefusal } {
  const header = idToken ? decodeJwtPart(idToken, 0) : null;
  const c = idToken ? decodeJwtClaims(idToken) : null;
  if (!idToken || !header || !c) return { ok: false, reason: 'malformed' };
  if (header.alg !== GOOGLE_ID_TOKEN_ALG || !idToken.split('.')[2]) return { ok: false, reason: 'algorithm' };
  if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.includes(c.iss)) return { ok: false, reason: 'issuer' };
  const aud = c.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every((a) => typeof a === 'string') ? (aud as string[]) : [];
  if (audiences.length === 0 || audiences.some((a) => a !== expect.clientId)) return { ok: false, reason: 'audience' };
  if (c.azp !== undefined && c.azp !== expect.clientId) return { ok: false, reason: 'audience' };
  if (!finiteSeconds(c.exp) || c.exp * 1000 + CLOCK_SKEW_MS <= expect.nowMs) return { ok: false, reason: 'expired' };
  if (!finiteSeconds(c.iat) || c.iat * 1000 - CLOCK_SKEW_MS > expect.nowMs || c.iat > c.exp) return { ok: false, reason: 'issued_at' };
  if (typeof c.sub !== 'string' || !SUBJECT.test(c.sub)) return { ok: false, reason: 'subject' };
  if (typeof c.email !== 'string' || c.email.length > 320 || !EMAIL.test(c.email)) return { ok: false, reason: 'email' };
  if (c.email_verified !== true) return { ok: false, reason: 'email_not_verified' };
  if (!expect.nonce || c.nonce !== expect.nonce) return { ok: false, reason: 'nonce' };
  const name = typeof c.name === 'string' ? clip(c.name, 200) : '';
  return {
    ok: true,
    claims: c as unknown as GoogleClaims,
    user: { name, email: c.email.toLowerCase(), emailVerified: true },
  };
}

// ---------------------------------------------------------------------------
// Signing out

/**
 * The session token in a session cookie's value as the browser sends it, when its
 * signature is Better Auth's (better-call's signed cookie: the token, a dot and the
 * base64 HMAC-SHA256 of the token under BETTER_AUTH_SECRET, URL-encoded); null otherwise.
 * Needs no database, so a sign-out can name its session while the database is failing.
 */
export function signedSessionToken(cookieValue: string, secret: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(cookieValue);
  } catch {
    return null;
  }
  const at = value.lastIndexOf('.');
  if (at < 1 || value.length > 512) return null;
  const token = value.slice(0, at);
  const signature = value.slice(at + 1);
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  const expected = createHmac('sha256', secret).update(token, 'utf8').digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}

/**
 * Seals the session cookies of pending sign-outs (AES-256-GCM under a key derived from
 * BETTER_AUTH_SECRET): the cookie that keeps them can only be opened by this server, so it
 * never works as a session cookie, and the page cannot read a token out of it.
 */
function pendingSignOutSeal(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'aviation-casebook', 'pending sign-out v1', 32));
  return {
    seal(values: readonly string[]): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url')}`;
    },
    /** The sealed values, or [] for anything this server did not seal. */
    open(cookieValue: string): string[] {
      const m = /^v1\.([A-Za-z0-9_-]{40,4000})$/.exec(cookieValue);
      if (!m) return [];
      const raw = Buffer.from(m[1]!, 'base64url');
      if (raw.length < 12 + 16 + 2) return [];
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
        const values = JSON.parse(text) as unknown;
        return Array.isArray(values) && values.every((v) => typeof v === 'string' && v.length <= 512) ? (values as string[]) : [];
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The service

export interface AuthLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** A Better Auth log line without anything it attached, any email address replaced. */
export function sanitizeAuthLogMessage(message: unknown): string {
  if (typeof message !== 'string') return 'auth message';
  return clip(message.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '<email>'), 160);
}

/** The signed-in account behind a request's session cookie. */
export interface SignedIn extends AccountSession {
  name: string;
  email: string;
  principal: AccountPrincipal;
  /** HMAC(issuer, sub): the account's quota key, read owner, billing principal and lifecycle lock. */
  hash: string;
}

/** The deletion intent a re-authentication carries in the OAuth state (server context). */
interface ReauthIntent {
  userId: string;
  sessionId: string;
}

function parseReauthIntent(value: unknown): ReauthIntent | null {
  if (typeof value !== 'object' || value === null) return null;
  const { userId, sessionId } = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return typeof userId === 'string' && uuid.test(userId) && typeof sessionId === 'string' && uuid.test(sessionId) ? { userId, sessionId } : null;
}

/** Session storage failed: the request is refused (503), never treated as signed out. */
export class AuthUnavailableError extends Error {
  override readonly name = 'AuthUnavailableError';
}

export interface AuthService {
  /** True over https: `__Host-` cookie names and the Secure attribute. */
  readonly secure: boolean;
  /** Better Auth's handler, for the `/api/auth` requests the route lets through. */
  handle(request: Request): Promise<Response>;
  /** The signed-in account behind this `Cookie` header, or null. Throws `AuthUnavailableError`. */
  signedIn(cookieHeader: string | undefined): Promise<SignedIn | null>;
  /** `Set-Cookie` values that end this browser's session cookies. */
  expiredSessionCookies(): string[];
  /**
   * End the sessions a sign-out names and confirm they are gone (module comment, "Signing
   * out"): with `session`, the session of this `Cookie` header's session cookie; always,
   * every sign-out this browser has pending. True once none of them is left (or there was
   * nothing to end); false when the database could not confirm it. Never throws.
   */
  finishSignOut(cookieHeader: string | undefined, opts: { session: boolean }): Promise<boolean>;
  /** Whether this `Cookie` header carries a pending sign-out. */
  hasPendingSignOut(cookieHeader: string | undefined): boolean;
  /** The `Set-Cookie` value that keeps this request's sign-out, with those already pending, for a retry. */
  pendingSignOutCookie(cookieHeader: string | undefined): string;
  /** The `Set-Cookie` value that drops this browser's pending sign-outs (all confirmed). */
  donePendingSignOutCookie(): string;
  /** Better Auth's runtime check of the tables it writes against the Drizzle schema (tests). */
  checkSchema(): Promise<void>;
}

export interface AuthServiceDeps {
  /** PostgreSQL as aviation_app. */
  db: Db;
  /** From the AI runtime: the quota policy (account HMACs) and trial cookies (the handover). */
  policy: QuotaPolicy | null;
  trials: TrialIdentities | null;
  log: AuthLog;
  now?: () => Date;
  rateLimits?: Partial<AuthRateLimits>;
}

export type AuthServiceConfig = Pick<AppConfig, 'appEnv' | 'appUrl' | 'auth'>;

/** The service, or why Google sign-in is off. */
export function createAuthService(config: AuthServiceConfig, deps: AuthServiceDeps): { service: AuthService; problem: null } | { service: null; problem: string } {
  const problem = authConfigProblem(config);
  if (problem) return { service: null, problem };
  if (!deps.policy || !deps.trials) return { service: null, problem: 'the quota policy is missing (IP_HMAC_SECRET and IDENTITY_HMAC_SECRET): Google sign-in is off' };
  return { service: buildAuthService(config, { ...deps, policy: deps.policy, trials: deps.trials }), problem: null };
}

function buildAuthService(config: AuthServiceConfig, deps: AuthServiceDeps & { policy: QuotaPolicy; trials: TrialIdentities }): AuthService {
  const appOrigin = new URL(config.appUrl).origin;
  const secure = isHttpsUrl(config.appUrl);
  const names = authCookieNames(secure);
  const clientId = config.auth.googleClientId!;
  const now = deps.now ?? (() => new Date());
  const limits = { ...AUTH_RATE_LIMITS, ...deps.rateLimits };
  const handover: HandoverDeps = { db: deps.db, policy: deps.policy, trials: deps.trials, now };
  const { log } = deps;

  const auth = betterAuth({
    appName: 'AirCase',
    baseURL: appOrigin,
    basePath: AUTH_BASE_PATH,
    secret: config.auth.secret!,
    trustedOrigins: [appOrigin],
    database: drizzleAdapter(deps.db, { provider: 'pg', schema: AUTH_SCHEMA, transaction: true }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId,
        clientSecret: config.auth.googleClientSecret!,
        prompt: 'select_account',
        accessType: 'online',
        includeGrantedScopes: false,
        disableIdTokenSignIn: true,
        requireEmailVerification: true,
        async getUserInfo(tokens) {
          const state = await getOAuthState();
          const nonce = state?.serverContext?.[NONCE_CONTEXT_KEY];
          const verdict = verifiedGoogleUser(tokens.idToken, { clientId, nonce: typeof nonce === 'string' ? nonce : null, nowMs: Date.now() });
          if (!verdict.ok) {
            log.warn({ signIn: 'refused', reason: verdict.reason }, 'Google sign-in refused');
            return null;
          }
          // One use per state (see the module comment): only the first callback gets past here.
          if (!(await claimState(state))) {
            log.warn({ signIn: 'state_reused' }, 'Google sign-in refused: the callback was already used');
            return null;
          }
          return { user: verdict.user, data: verdict.claims as never };
        },
      },
    },
    user: { deleteUser: { enabled: false } },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      updateAccountOnSignIn: false,
      encryptOAuthTokens: true,
      // The OAuth state in an encrypted cookie: a sign-in start writes nothing to the database.
      storeStateStrategy: 'cookie',
      skipStateCookieCheck: false,
      storeAccountCookie: false,
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 60,
      customRules: {
        // A deletion's re-authentication, its start and Google's callback to the signed-in
        // browser, already counted per account by the route, is not held up by other sign-ins
        // from its network.
        '/sign-in/social': (request) => (request.headers.get(AUTH_REAUTH_HEADER) === '1' ? false : { window: 60, max: limits.signIn }),
        '/callback/*': (request) => (request.headers.get(AUTH_REAUTH_HEADER) === '1' ? false : { window: 60, max: limits.callback }),
        '/sign-out': { window: 60, max: limits.signOut },
      },
    },
    advanced: {
      // The prefix is part of the names below (`__Host-` over https).
      useSecureCookies: false,
      cookies: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, { name }])),
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: 'lax', path: '/' },
      crossSubDomainCookies: { enabled: false },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [AUTH_IP_HEADER], ipv6Subnet: 64 },
      database: { generateId: 'uuid' },
    },
    databaseHooks: {
      // The server's clock dates the user: the new-account allowance counts from it (server/quota/admit.ts).
      user: { create: { before: async () => ({ data: { image: null, createdAt: now(), updatedAt: now() } }) } },
      account: {
        create: {
          before: async () => ({
            data: {
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
              scope: null,
              password: null,
            },
          }),
        },
      },
      session: { create: { before: async () => ({ data: { ipAddress: null, userAgent: null } }) } },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/social') return;
        const body = SignInRequestSchema.safeParse(ctx.body);
        if (!body.success) throw new APIError('BAD_REQUEST', { message: 'This sign-in request is not valid.' });
        const cookie = ctx.headers?.get('cookie') ?? null;
        const candidate = await handoverCandidate(handover, cookie, body.data.callbackURL);
        // Deleting the account: Google again, for the account this browser is signed in to.
        const signedIn = body.data.callbackURL === DELETE_REAUTH_PATH ? await service.signedIn(cookie ?? undefined) : null;
        await addOAuthServerContext({
          [NONCE_CONTEXT_KEY]: randomBytes(32).toString('base64url'),
          ...(candidate ? { [HANDOVER_CONTEXT_KEY]: candidate } : {}),
          ...(signedIn ? { [REAUTH_CONTEXT_KEY]: { userId: signedIn.userId, sessionId: signedIn.sessionId, subject: signedIn.principal.subject } } : {}),
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/social') {
          // Bind the ID token to this flow: Google echoes the authorization request's nonce.
          const returned = ctx.context.returned as { url?: unknown } | null | undefined;
          if (!returned || typeof returned !== 'object' || typeof returned.url !== 'string') return;
          const context = (await getOAuthState())?.serverContext;
          const nonce = context?.[NONCE_CONTEXT_KEY];
          if (typeof nonce !== 'string') throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Sign-in could not start.' });
          const url = new URL(returned.url);
          url.searchParams.set('nonce', nonce);
          const subject = (context?.[REAUTH_CONTEXT_KEY] as { subject?: unknown } | undefined)?.subject;
          if (typeof subject === 'string') url.searchParams.set('login_hint', subject);
          return ctx.json({ ...returned, url: url.toString() });
        }
        if (ctx.path === '/callback/:id') {
          const created = ctx.context.newSession;
          if (!created) return;
          const context = (await getOAuthState())?.serverContext;
          const candidate = parseHandoverCandidate(context?.[HANDOVER_CONTEXT_KEY]);
          const reauth = parseReauthIntent(context?.[REAUTH_CONTEXT_KEY]);
          if (!candidate && !reauth) return;
          try {
            const account = await accountPrincipal(deps.db, created.user.id);
            if (!account) return;
            const session: AccountSession = { hash: principalHash(deps.policy, account), userId: created.user.id, sessionId: created.session.id };
            if (candidate) {
              const outcome = await completeHandover(handover, ctx.headers?.get('cookie') ?? null, candidate, session);
              log.info({ handover: outcome }, 'sign-in handover');
            }
            if (reauth) {
              // A re-authentication replaces the session the browser had (OWASP: rotate after re-authenticating).
              if (reauth.sessionId !== session.sessionId) await endSession(deps.db, reauth.sessionId);
              const same = reauth.userId === session.userId;
              const until = same ? await issueDeletionConfirmation(deps.db, session) : null;
              log.info({ reauthentication: same ? (until ? 'confirmed' : 'not_confirmed') : 'other_account' }, 'sign-in re-authentication');
            }
          } catch (err) {
            // Signing in still succeeds; the brief stays with the trial and nothing is confirmed.
            log.warn({ err: { name: (err as Error)?.name } }, 'sign-in follow-up failed');
          }
        }
      }),
    },
    onAPIError: {
      errorURL: AUTH_ERROR_PATH,
      // Instead of Better Auth's console output: the status and the message only.
      onError(error) {
        const e = error as { status?: unknown; message?: unknown; name?: unknown };
        const status = typeof e?.status === 'string' ? e.status : typeof e?.name === 'string' ? e.name : 'error';
        log.warn({ auth: 'better-auth', status }, sanitizeAuthLogMessage(e?.message));
        // An unexpected failure (a database error, say) becomes a plain 500 here: Better Auth's
        // router would otherwise print the whole error, with a failed query's values, to the
        // console. The route turns a callback's 500 into the sign-in error page.
        if (!isAPIError(error)) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Sign-in could not complete. Try again.' });
      },
    },
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      log(level, message) {
        const text = sanitizeAuthLogMessage(message);
        if (level === 'error') log.error({ auth: 'better-auth' }, text);
        else if (level === 'warn') log.warn({ auth: 'better-auth' }, text);
        else log.info({ auth: 'better-auth' }, text);
      },
    },
  });

  const expire = (name: string) => `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  // Signing out (module comment): a sign-out names its sessions by their signed cookies.
  const secret = config.auth.secret!;
  const pendingName = pendingSignOutCookieName(secure);
  const sealer = pendingSignOutSeal(secret);
  const pendingCookie = (value: string, maxAge: number) =>
    // Lax, not Strict: Google's callback, a navigation from another site, must carry it (module comment).
    `${pendingName}=${value}; Max-Age=${maxAge}; Path=${PENDING_SIGN_OUT_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  /** The session cookie values (as sent) of this browser's pending sign-outs. */
  const pendingOf = (cookieHeader: string | undefined): string[] => cookieValues(cookieHeader, pendingName).flatMap((v) => sealer.open(v));
  const sessionCookieOf = (cookieHeader: string | undefined): string[] => cookieValues(cookieHeader, names.session_token).slice(0, 1);

  /**
   * Claim the callback's OAuth state for this callback (see the module comment): true for
   * the first claim of a state, false for any later one or a state without its value or
   * expiry. Rows live until the state would have expired.
   */
  async function claimState(state: Awaited<ReturnType<typeof getOAuthState>>): Promise<boolean> {
    const value = (state as { oauthState?: unknown } | null | undefined)?.oauthState;
    const expiresAt = (state as { expiresAt?: unknown } | null | undefined)?.expiresAt;
    if (typeof value !== 'string' || value.length === 0 || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
    const res = await deps.db.execute(sql`
      INSERT INTO auth_state_uses (state_hash, used_at, expires_at)
      VALUES (${createHash('sha256').update(value).digest('hex')}, now(), greatest(to_timestamp(${expiresAt / 1000}), now() + interval '1 second'))
      ON CONFLICT (state_hash) DO NOTHING
      RETURNING 1`);
    return res.rows.length === 1;
  }

  const service: AuthService = {
    secure,
    handle: (request) => auth.handler(request),
    async signedIn(cookieHeader) {
      // No session cookie: nothing to look up.
      if (!cookieHeader || !cookieHeader.includes(`${names.session_token}=`)) return null;
      let found: { session: { id: string }; user: { id: string; name: string; email: string } } | null;
      try {
        found = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) });
      } catch {
        throw new AuthUnavailableError('the session could not be read');
      }
      if (!found) return null;
      const principal = await accountPrincipal(deps.db, found.user.id).catch(() => {
        throw new AuthUnavailableError('the account could not be read');
      });
      if (!principal) return null;
      return {
        userId: found.user.id,
        sessionId: found.session.id,
        name: found.user.name,
        email: found.user.email,
        principal,
        hash: principalHash(deps.policy, principal),
      };
    },
    expiredSessionCookies: () => [expire(names.session_token), expire(names.session_data), expire(names.dont_remember)],
    async finishSignOut(cookieHeader, opts) {
      const values = [...(opts.session ? sessionCookieOf(cookieHeader) : []), ...pendingOf(cookieHeader)];
      const tokens = [...new Set(values.map((v) => signedSessionToken(v, secret)).filter((t): t is string => t !== null))];
      if (tokens.length === 0) return true;
      try {
        // Better Auth's own sign-out may have deleted it already; this one's outcome is the answer.
        await deps.db.execute(sql`DELETE FROM auth_sessions WHERE token = ANY(${sql.param(tokens)}::text[])`);
        return true;
      } catch (err) {
        log.warn({ signOut: 'unconfirmed', err: { name: (err as Error)?.name } }, 'sign-out: the session could not be ended');
        return false;
      }
    },
    hasPendingSignOut: (cookieHeader) => cookieValues(cookieHeader, pendingName).length > 0,
    pendingSignOutCookie(cookieHeader) {
      // Never evicts one (gate t22 finding 2): a sign-in finishes the pending ones before any
      // new session (the route), so this holds the session being signed out and those this
      // browser's own earlier failed sign-out left, a handful at most.
      const values = [...new Set([...pendingOf(cookieHeader), ...sessionCookieOf(cookieHeader)])];
      return pendingCookie(sealer.seal(values), SESSION_TTL_SECONDS);
    },
    donePendingSignOutCookie: () => pendingCookie('', 0),
    async checkSchema() {
      const context = (await auth.$context) as { checkSchema?: () => Promise<void> | undefined };
      await context.checkSchema?.();
    },
  };
  return service;
}

/** The quota principal of a user: Google's issuer and the account's `sub`, and when the user was created. */
export async function accountPrincipal(db: Db, userId: string): Promise<AccountPrincipal | null> {
  const res = await db.execute(sql`
    SELECT a.account_id, (extract(epoch FROM u.created_at) * 1000)::bigint AS created_ms
    FROM auth_users u JOIN auth_accounts a ON a.user_id = u.id AND a.provider_id = ${AUTH_PROVIDER}
    WHERE u.id = ${userId}::uuid`);
  const row = res.rows[0] as { account_id: string; created_ms: string } | undefined;
  if (!row) return null;
  return { kind: 'account', issuer: GOOGLE_ISSUER, subject: row.account_id, createdAt: new Date(Number(row.created_ms)) };
}
