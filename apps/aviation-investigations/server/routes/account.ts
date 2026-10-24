/**
 * Google sign-in and the account (shared/contracts/account.ts), under the route-based
 * default deny of server/app.ts: every route needs a network identity and is rate
 * limited, and the cache-headers rule makes everything under `/api/auth` and
 * `/api/account` `private, no-store`.
 *
 * `/api/auth/*` passes three requests to Better Auth (server/auth/better-auth.ts) and
 * answers 404 to anything else, and to everything while sign-in is off:
 *
 * - `POST /api/auth/sign-in/social` and `POST /api/auth/sign-out`: refused when
 *   cross-site (403) or not JSON (400) before Better Auth sees them. A sign-in that
 *   re-authenticates a deletion (`DELETE_REAUTH_PATH`, from a signed-in browser) is counted
 *   per account here (at most 5 an hour, 429 past that) and marked for Better Auth
 *   (`AUTH_REAUTH_HEADER`), whose per-network limit then skips it;
 * - `GET /api/auth/callback/google`: Google's redirect back; one that fails unexpectedly
 *   (Better Auth's 500) is sent to the sign-in error page (`AUTH_ERROR_PATH`). A callback
 *   to a browser signed in to an account (a deletion's re-authentication returning; the
 *   page offers no other sign-in while signed in) is counted per account as well, 5 an
 *   hour, and marked the same way; past that account's limit the network's limit applies
 *   to it. Sign-in traffic from others on the same network therefore never holds up a
 *   re-authentication, neither its start nor its return.
 *
 * Better Auth gets a request rebuilt from an allowlist: the APP_URL origin with the
 * matched path and the raw query, the headers it needs (cookies, origin and fetch
 * metadata, content type), the JSON body as parsed, and the validated network identity
 * as `AUTH_IP_HEADER` for its rate limiter. Nothing else the client sent reaches it: no
 * Host, no forwarding headers, no client copy of that header. Its answer is passed back
 * as it is (status, headers, every `Set-Cookie`, body), except a sign-out's success: that
 * stands only once the session is gone (`finishSignOut`); otherwise the answer is 503
 * `sign_out_pending` (`Retry-After: 5`) with this browser signed out all the same and the
 * sign-out kept for a retry (server/auth/better-auth.ts, "Signing out"). A sign-in (its
 * start and Google's callback) first finishes a sign-out this browser has pending, and is
 * refused while it cannot (503 `sign_out_pending`; the callback goes to the sign-in error
 * page).
 *
 * `GET /api/account` says who is signed in (and whether this session may delete the
 * account now). It first finishes a sign-out this browser has pending, if the database
 * now allows it (never the session the browser holds). Deleting needs a recent Google sign-in (server/auth/deletion.ts):
 * `POST /api/account/delete/start` confirms a session that signed in within the last 5
 * minutes, or answers that the page must sign in with Google again first;
 * `POST /api/account/delete` then deletes the signed-in account with that single-use
 * confirmation (403 `reauth_required` without one) and expires this browser's session
 * cookie. Both are refused cross-site and need a JSON body.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountResponseSchema,
  DELETE_REAUTH_PATH,
  DeleteAccountRequestSchema,
  DeleteAccountResponseSchema,
  DeleteStartRequestSchema,
  DeleteStartResponseSchema,
  SignInRequestSchema,
} from '../../shared/contracts/account.js';
import { AUTH_ERROR_PATH, AUTH_IP_HEADER, AUTH_REAUTH_HEADER, SIGN_OUT_RETRY_SECONDS, authClientIp } from '../auth/better-auth.js';
import { deleteAccount, deletionConfirmedUntil, issueDeletionConfirmation, reauthCallbackAllowed, reauthStartAllowed } from '../auth/deletion.js';
import { retryAfterSeconds } from '../identity/gate.js';
import { crossSite, isJsonRequest } from '../http/origin.js';
import { issuesOf, JSON_TYPE, sendError } from '../http/reply.js';
import type { ApiContext } from './context.js';

/** The Better Auth endpoints this site uses, by path, with their method. */
export const AUTH_ENDPOINTS: Readonly<Record<string, 'GET' | 'POST'>> = {
  '/api/auth/sign-in/social': 'POST',
  '/api/auth/callback/google': 'GET',
  '/api/auth/sign-out': 'POST',
};

/** Request headers Better Auth is given (lower case). */
const FORWARDED_HEADERS = ['cookie', 'origin', 'referer', 'content-type', 'accept', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'] as const;
/** Response headers that belong to Fastify's own framing. */
const FRAMING_HEADERS = new Set(['set-cookie', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** The request path without scheme, authority or query, percent-decoded (left as is when malformed). */
function pathOf(target: string): string {
  const path = (target.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] ?? '') || '/';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The raw query of a request target (`?…`), or ''. */
function queryOf(target: string): string {
  const at = target.indexOf('?');
  return at < 0 ? '' : target.slice(at).split('#', 1)[0]!;
}

export function accountRoutes(app: FastifyInstance, ctx: ApiContext, opts: { appUrl: string }): void {
  const appOrigin = new URL(opts.appUrl).origin;
  const now = () => (ctx.ai ? ctx.ai.now() : new Date());

  async function betterAuth(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const auth = ctx.auth;
    const path = pathOf(request.url);
    if (!auth || AUTH_ENDPOINTS[path] !== request.method) return sendError(reply, 404, 'not_found');
    if (request.method === 'POST') {
      if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
      if (!isJsonRequest(request)) return sendError(reply, 400, 'bad_request', { message: 'The request body must be JSON.' });
    }
    const networkId = request.networkIdentity;
    // The access hook resolves it for every API route; a route without one is a wiring bug.
    if (!networkId) throw new Error('the auth route needs the request network identity');
    // No new session while this browser has a sign-out pending: finish it first, at the
    // sign-in's start and at Google's callback, and refuse while it cannot be finished, so a
    // pending revocation never has to make room for another (gate t22 finding 2).
    const issuesSession = path === '/api/auth/sign-in/social' || path === '/api/auth/callback/google';
    let drained = false;
    if (issuesSession && auth.hasPendingSignOut(request.headers.cookie)) {
      if (!(await auth.finishSignOut(request.headers.cookie, { session: false }))) {
        request.log.warn({ signIn: 'sign_out_pending' }, 'sign-in refused: a pending sign-out could not be finished');
        if (path === '/api/auth/callback/google') return reply.redirect(`${AUTH_ERROR_PATH}&error=sign_out_pending`, 302);
        reply.header('retry-after', String(SIGN_OUT_RETRY_SECONDS));
        return sendError(reply, 503, 'sign_out_pending', { retryAfter: SIGN_OUT_RETRY_SECONDS });
      }
      drained = true;
    }
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    headers.set(AUTH_IP_HEADER, authClientIp(networkId));
    // A deletion's re-authentication: counted per account, never per network.
    if (path === '/api/auth/sign-in/social') {
      const body = SignInRequestSchema.safeParse(request.body);
      const signedIn = body.success && body.data.callbackURL === DELETE_REAUTH_PATH ? await auth.signedIn(request.headers.cookie) : null;
      if (signedIn) {
        const allowed = await reauthStartAllowed(ctx.db, signedIn.hash, now());
        if (!allowed.ok) {
          const seconds = retryAfterSeconds(allowed.retryAt, now());
          reply.header('retry-after', String(seconds));
          return sendError(reply, 429, 'rate_limited', { retryAfter: seconds });
        }
        headers.set(AUTH_REAUTH_HEADER, '1');
      }
    }
    // Google's callback to a signed-in browser (a deletion's re-authentication coming back):
    // counted per account too; past that account's limit, the network's applies.
    if (path === '/api/auth/callback/google') {
      const signedIn = await auth.signedIn(request.headers.cookie);
      if (signedIn && (await reauthCallbackAllowed(ctx.db, signedIn.hash, now())).ok) headers.set(AUTH_REAUTH_HEADER, '1');
    }
    const response = await auth.handle(
      new Request(`${appOrigin}${path}${queryOf(request.url)}`, {
        method: request.method,
        headers,
        ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
      }),
    );
    const cookies = response.headers.getSetCookie();
    if (drained) cookies.push(auth.donePendingSignOutCookie());
    // The browser is back from Google: an unexpected failure (such as its account being deleted
    // while this sign-in completes) lands on the sign-in error page, as Better Auth's own
    // failures do, not on a bare 500.
    if (path === '/api/auth/callback/google' && response.status >= 500) {
      request.log.warn({ authCallback: response.status }, 'sign-in callback failed');
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.redirect(`${AUTH_ERROR_PATH}&error=internal_server_error`, 302);
    }
    // Better Auth's sign-out answers success even when it could not delete the session (it
    // logs the failure and expires the cookie): success only once the session is gone.
    if (path === '/api/auth/sign-out' && response.ok) {
      if (!(await auth.finishSignOut(request.headers.cookie, { session: true }))) {
        // This browser is signed out all the same (Better Auth's cookies), and keeps the
        // sign-out for a retry: its next sign-out or account read.
        reply.header('set-cookie', [...cookies, auth.pendingSignOutCookie(request.headers.cookie)]);
        reply.header('retry-after', String(SIGN_OUT_RETRY_SECONDS));
        return sendError(reply, 503, 'sign_out_pending', { retryAfter: SIGN_OUT_RETRY_SECONDS });
      }
      if (auth.hasPendingSignOut(request.headers.cookie)) cookies.push(auth.donePendingSignOutCookie());
    }
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      if (!FRAMING_HEADERS.has(name)) reply.header(name, value);
    });
    if (cookies.length > 0) reply.header('set-cookie', cookies);
    const body = await response.text();
    return reply.send(body.length > 0 ? body : undefined);
  }
  app.route({ method: ['GET', 'POST'], url: '/api/auth/*', handler: betterAuth });

  app.get('/api/account', async (request, reply) => {
    // A sign-out the database could not confirm earlier: this browser's next account read
    // finishes it (never the session the browser holds now).
    if (ctx.auth?.hasPendingSignOut(request.headers.cookie) && (await ctx.auth.finishSignOut(request.headers.cookie, { session: false }))) {
      reply.header('set-cookie', ctx.auth.donePendingSignOutCookie());
    }
    const signedIn = ctx.auth ? await ctx.auth.signedIn(request.headers.cookie) : null;
    const until = signedIn ? await deletionConfirmedUntil(ctx.db, signedIn.sessionId) : null;
    const body = AccountResponseSchema.parse(
      signedIn
        ? { signedIn: true, user: { name: signedIn.name, email: signedIn.email }, ...(until ? { deletionConfirmedUntil: until.toISOString() } : {}) }
        : { signedIn: false },
    );
    return reply.code(200).type(JSON_TYPE).send(JSON.stringify(body));
  });

  app.post('/api/account/delete/start', async (request, reply) => {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const auth = ctx.auth;
    if (!auth) return sendError(reply, 404, 'not_found');
    const parsed = DeleteStartRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const signedIn = await auth.signedIn(request.headers.cookie);
    if (!signedIn) return sendError(reply, 403, 'sign_in_required', { message: 'Sign in to delete your account.' });
    const until = await issueDeletionConfirmation(ctx.db, signedIn);
    const body = DeleteStartResponseSchema.parse(until ? { next: 'confirm', until: until.toISOString() } : { next: 'reauthenticate' });
    return reply.code(200).type(JSON_TYPE).send(JSON.stringify(body));
  });

  app.post('/api/account/delete', async (request, reply) => {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const auth = ctx.auth;
    if (!auth) return sendError(reply, 404, 'not_found');
    const parsed = DeleteAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const signedIn = await auth.signedIn(request.headers.cookie);
    if (!signedIn) return sendError(reply, 403, 'sign_in_required', { message: 'Sign in to delete your account.' });
    const report = await deleteAccount({ db: ctx.db, runs: new Map([...(ctx.briefs?.runs ?? []), ...(ctx.evidence?.runs ?? [])]), now }, signedIn);
    if (report === 'not_confirmed') return sendError(reply, 403, 'reauth_required');
    if (report === 'signed_out') return sendError(reply, 403, 'sign_in_required', { message: 'Sign in to delete your account.' });
    // Counts only: nothing that identifies the person.
    request.log.info({ accountDeleted: report }, 'account deleted');
    reply.header('set-cookie', auth.expiredSessionCookies());
    const body = DeleteAccountResponseSchema.parse({ deleted: true });
    return reply.code(200).type(JSON_TYPE).send(JSON.stringify(body));
  });
}
