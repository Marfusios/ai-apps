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
 * APP_URL (`authConfigProblem`).
 *
 * **What the callback accepts.** The ID token comes straight from Google's token endpoint
 * over TLS, in exchange for this flow's single-use code, PKCE verifier and the client
 * secret, so its signature is not checked again (OIDC Core 3.1.3.7, step 6). Its claims
 * are (`verifiedGoogleUser`): the issuer, the audience (and `azp`), the expiry, a
 * well-formed `sub`, an email Google reports as verified (`email_verified`), and the
 * nonce. Better Auth's Google provider sends no nonce in the redirect flow, so this
 * module adds one: a `before` hook on `/sign-in/social` puts a random nonce in the OAuth
 * state's server context (which only the server can write and which the callback consumes
 * once), an `after` hook adds it to Google's authorization URL, and the callback refuses
 * an ID token without that nonce. A refusal stores nothing: no user, no account link, no
 * session. Of the profile only the name and email are kept (no picture), and of the
 * provider response nothing else: no tokens, no scopes (database hooks clear them, and
 * CHECK constraints in migration 0017 refuse them).
 *
 * **Sessions.** Database sessions with a fixed 7-day lifetime: no refresh, and no cookie
 * cache, so sign-out, deletion and expiry take effect on the next request. Sessions keep
 * no IP address or user agent.
 *
 * **Cookies.** Host-only, HttpOnly, SameSite=Lax, Path=/; over https Secure with the
 * `__Host-` prefix (`__Host-aviation_session`, the OAuth state's
 * `__Host-aviation_auth_state`), plain names for local http. The session cookie is
 * signed by Better Auth with BETTER_AUTH_SECRET.
 *
 * **CSRF and origins.** Better Auth's checks stay on and are set explicitly (its own
 * default turns them off under NODE_ENV=test): the request `Origin` must be APP_URL's
 * whenever cookies are sent, and every return path must be on APP_URL. Before Better Auth
 * sees a POST, the route refuses cross-site requests (`Sec-Fetch-Site`, else `Origin`) and
 * non-JSON bodies. The OAuth state is bound to the browser by a signed cookie and stored
 * server-side for 10 minutes; a callback without it, with another browser's, or a second
 * time fails.
 *
 * **Rate limits.** Better Auth's limiter, per network identity: the route passes the
 * validated identity of server/http/network-identity.ts (never `request.ip` or a client
 * header; any client header of that name is dropped) as `AUTH_IP_HEADER`. On top of the
 * API's own limit per network identity.
 *
 * **Logging.** Better Auth's log lines go to the server log as their message only, with
 * any email address replaced; never the values it attaches (errors may quote a row).
 * Telemetry is off.
 */
import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, addOAuthServerContext, createAuthMiddleware, getOAuthState } from 'better-auth/api';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../shared/config.js';
import { SignInRequestSchema } from '../../shared/contracts/account.js';
import type { Db } from '../db/client.js';
import { AUTH_PROVIDER, AUTH_SCHEMA } from '../db/schema/auth.js';
import { isHttpsUrl } from '../http/security-headers.js';
import type { TrialIdentities } from '../identity/trial.js';
import { MIN_SECRET_LENGTH, principalHash, type Principal, type QuotaPolicy } from '../quota/policy.js';
import { HANDOVER_CONTEXT_KEY, completeHandover, handoverCandidate, parseHandoverCandidate, type HandoverDeps } from './handover.js';

export type AccountPrincipal = Extract<Principal, { kind: 'account' }>;

/** The issuer every Google account principal is keyed under (with its `sub`). */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
/** The issuers Google's ID tokens carry. */
export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];
/** Where Better Auth is served. */
export const AUTH_BASE_PATH = '/api/auth';
/** Request header carrying the validated network identity to Better Auth's limiter (set by the route only). */
export const AUTH_IP_HEADER = 'x-aviation-client-ip';
/** Sessions last this long and are never extended. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The OAuth-state key of the ID-token nonce. */
export const NONCE_CONTEXT_KEY = 'aviationNonce';
/** Allowed difference between our clock and Google's. */
const CLOCK_SKEW_MS = 60_000;

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
  iat?: number;
  nonce?: string;
}

/** The claims of a compact JWT, unverified (see the module comment), or null. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const SUBJECT = /^[!-~]{1,255}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/** At most `max` characters (whole code points), control characters removed. */
function clip(text: string, max: number): string {
  return Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, max).join('');
}

export type GoogleRefusal = 'malformed' | 'issuer' | 'audience' | 'expired' | 'subject' | 'email' | 'email_not_verified' | 'nonce';

/**
 * The user a Google ID token stands for, or why it is refused: the issuer, the audience
 * (and `azp` when present) must be this client, the token must not have expired, the
 * `sub` must be one printable token, the email must be one Google reports as verified,
 * and the nonce must be this flow's.
 */
export function verifiedGoogleUser(
  idToken: string | undefined,
  expect: { clientId: string; nonce: string | null; nowMs: number },
): { ok: true; claims: GoogleClaims; user: { name: string; email: string; emailVerified: true } } | { ok: false; reason: GoogleRefusal } {
  const c = idToken ? decodeJwtClaims(idToken) : null;
  if (!c) return { ok: false, reason: 'malformed' };
  if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.includes(c.iss)) return { ok: false, reason: 'issuer' };
  const aud = c.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every((a) => typeof a === 'string') ? (aud as string[]) : [];
  if (!audiences.includes(expect.clientId) || (c.azp !== undefined && c.azp !== expect.clientId)) return { ok: false, reason: 'audience' };
  if (typeof c.exp !== 'number' || c.exp * 1000 + CLOCK_SKEW_MS <= expect.nowMs) return { ok: false, reason: 'expired' };
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
export interface SignedIn {
  userId: string;
  name: string;
  email: string;
  principal: AccountPrincipal;
  /** HMAC(issuer, sub): the account's quota key, read owner and billing principal. */
  hash: string;
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
    appName: 'Aviation Casebook',
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
          return { user: verdict.user, data: verdict.claims as never };
        },
      },
    },
    user: { deleteUser: { enabled: false } },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      updateAccountOnSignIn: false,
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
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
        '/sign-in/social': { window: 60, max: limits.signIn },
        '/callback/*': { window: 60, max: limits.callback },
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
        const candidate = await handoverCandidate(handover, ctx.headers?.get('cookie') ?? null, body.data.callbackURL);
        await addOAuthServerContext({
          [NONCE_CONTEXT_KEY]: randomBytes(32).toString('base64url'),
          ...(candidate ? { [HANDOVER_CONTEXT_KEY]: candidate } : {}),
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/social') {
          // Bind the ID token to this flow: Google echoes the authorization request's nonce.
          const returned = ctx.context.returned as { url?: unknown } | null | undefined;
          if (!returned || typeof returned !== 'object' || typeof returned.url !== 'string') return;
          const nonce = (await getOAuthState())?.serverContext?.[NONCE_CONTEXT_KEY];
          if (typeof nonce !== 'string') throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Sign-in could not start.' });
          const url = new URL(returned.url);
          url.searchParams.set('nonce', nonce);
          return ctx.json({ ...returned, url: url.toString() });
        }
        if (ctx.path === '/callback/:id') {
          const created = ctx.context.newSession;
          if (!created) return;
          const candidate = parseHandoverCandidate((await getOAuthState())?.serverContext?.[HANDOVER_CONTEXT_KEY]);
          if (!candidate) return;
          try {
            const account = await accountPrincipal(deps.db, created.user.id);
            if (!account) return;
            const outcome = await completeHandover(handover, ctx.headers?.get('cookie') ?? null, candidate, principalHash(deps.policy, account));
            log.info({ handover: outcome }, 'sign-in handover');
          } catch (err) {
            // Signing in still succeeds; the brief stays with the trial.
            log.warn({ err: { name: (err as Error)?.name } }, 'sign-in handover failed');
          }
        }
      }),
    },
    onAPIError: {
      errorURL: '/account?signin=failed',
      // Instead of Better Auth's console output: the status and the message only.
      onError(error) {
        const e = error as { status?: unknown; message?: unknown; name?: unknown };
        const status = typeof e?.status === 'string' ? e.status : typeof e?.name === 'string' ? e.name : 'error';
        log.warn({ auth: 'better-auth', status }, sanitizeAuthLogMessage(e?.message));
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

  return {
    secure,
    handle: (request) => auth.handler(request),
    async signedIn(cookieHeader) {
      // No session cookie: nothing to look up.
      if (!cookieHeader || !cookieHeader.includes(`${names.session_token}=`)) return null;
      let found: { user: { id: string; name: string; email: string } } | null;
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
        name: found.user.name,
        email: found.user.email,
        principal,
        hash: principalHash(deps.policy, principal),
      };
    },
    expiredSessionCookies: () => [expire(names.session_token), expire(names.session_data), expire(names.dont_remember)],
    async checkSchema() {
      const context = (await auth.$context) as { checkSchema?: () => Promise<void> | undefined };
      await context.checkSchema?.();
    },
  };
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
