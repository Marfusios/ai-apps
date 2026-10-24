/**
 * The HTTP server: the public API and the built web client on one origin.
 *
 * - `GET /api/health`, `/api/config`, `/api/search`, `/api/cases/:ntsbNo` and
 *   `/api/dashboard`, each pinned to the active dataset manifest (server/dataset.ts),
 *   and `GET /api/ai/status` (server/routes/ai-status.ts). AI routes get the anonymous
 *   gate (server/identity/gate.ts) from `ApiContext.ai`.
 * - Google sign-in under `/api/auth` and the account under `/api/account`
 *   (server/routes/account.ts) when `AppDeps.auth` is set (server/auth/better-auth.ts);
 *   AI routes read the signed-in account from it too.
 * - AI briefs under `/api/briefs` (server/routes/briefs.ts) when `AppDeps.briefs` binds
 *   an evidence retriever and the dataset reports its passages index servable. Polling
 *   a brief (`GET /api/briefs/:id`, about once a second while a step runs) has its own
 *   network-identity limit (`pollRateLimit`) so a running brief cannot use up the
 *   browsing limit; every other route shares `rateLimit`.
 * - The web client from `dist/web`: its pages, each with a head and a status built for its
 *   route, robots.txt and the sitemaps (server/routes/pages.ts); any other path without a
 *   file extension that takes HTML gets the 404 page (`index.html` with a per-response
 *   style nonce). Hashed assets are cached for a year; pages are revalidated.
 * - Access is decided from the route the router matched (the decoded path), never from
 *   the raw request target, so `/%61pi/search` or an absolute-form `http://x/api/search`
 *   get exactly the checks of `/api/search`. Default deny: every matched route needs a
 *   network identity (server/http/network-identity.ts) and is rate limited, except
 *   - the web client's routes (`ASSET_ROUTES`: the pages, robots.txt and the static files)
 *     and the not-found handler (the 404 page or a plain 404), which need no client address
 *     and are not limited; a case page (`/cases/:ntsbNo`) and the sitemaps read the database
 *     and are limited like the API, and
 *   - `GET /api/health` from loopback (the container's own health check).
 *   In tunnel mode only the trusted connector may connect at all (403 otherwise).
 * - Every response carries the security headers (server/http/security-headers.ts),
 *   including the router's own errors for malformed URLs (`frameworkErrors`, which
 *   applies the tunnel peer check first) and the HTTP parser's (`clientErrorHandler`).
 *   Outside live (`APP_ENV`) every response also says `X-Robots-Tag: noindex, nofollow`;
 *   on live, API responses say `X-Robots-Tag: noindex`.
 * - `Cache-Control` of per-visitor routes (AI, briefs, auth, account) is forced to
 *   `private, no-store` from the matched route (server/http/cache-headers.ts).
 * - Closing (server/main.ts calls it at once on SIGTERM and exits by force at 10 s) runs
 *   within one deadline, `SHUTDOWN_GRACE_MS` from its start. First (`preClose`, before
 *   the HTTP drain, so it works under live traffic) brief services begin shutdown:
 *   running steps are aborted, paid requests still in the gate, admission or step
 *   creation are refused or stop before any provider call, and closing waits for steps
 *   and paid requests to settle. Requests that arrive meanwhile get 503 `unavailable`.
 *   Then the HTTP drain: Node's own `server.close()` closes idle keep-alive connections,
 *   every response sent while closing carries `Connection: close`, and connections still
 *   open at the deadline are closed.
 *
 * Fastify runs with `trustProxy: false`; `request.ip` is never used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../shared/config.js';
import type { FacetKey } from '../shared/contracts/search.js';
import type { AiRuntime } from './ai/runtime.js';
import { AuthUnavailableError, type AuthService } from './auth/better-auth.js';
import type { EvidenceDataset } from './briefs/evidence.js';
import { servableEvidence, type BriefServices } from './briefs/services.js';
import { DatasetResolver, DatasetUnavailableError } from './dataset.js';
import { isDatabaseUnavailable, type Db } from './db/client.js';
import { CLIENT_IP_HEADER, compileTrustedProxies, isLoopback, resolveNetworkIdentity } from './http/network-identity.js';
import { isNoStoreRoute, PRIVATE_NO_STORE } from './http/cache-headers.js';
import { makeClientErrorHandler } from './http/client-error.js';
import { RateLimiter } from './http/rate-limit.js';
import { sendError } from './http/reply.js';
import { routerPath } from './http/request-target.js';
import { isHttpsUrl, securityHeaders } from './http/security-headers.js';
import { SearchIncompleteError, SearchTimedOutError } from './search/timeout.js';
import { accountRoutes } from './routes/account.js';
import { aiStatusRoutes } from './routes/ai-status.js';
import { briefRoutes } from './routes/briefs.js';
import { caseRoutes } from './routes/cases.js';
import { configRoutes } from './routes/config.js';
import type { ApiContext } from './routes/context.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { healthRoutes } from './routes/health.js';
import { PUBLIC_PAGE_ROUTES, ROBOTS_ROUTE, pageRoutes } from './routes/pages.js';
import { searchRoutes } from './routes/search.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Rate-limit key (server/http/network-identity.ts); null for static files without one. */
    networkIdentity: string | null;
  }
}

export interface AppDeps {
  /** `appEnv` (default `dev`): only `live` lets search engines index the site. */
  config: Pick<AppConfig, 'appUrl' | 'trustedProxyCidrs'> & Partial<Pick<AppConfig, 'appEnv'>>;
  /** The configured embedding model and dimensions: a published passages index must match them. */
  embedding?: { model: string; dims: number };
  /** PostgreSQL as `aviation_app`. */
  db: Db;
  /** Elasticsearch with the read key only. */
  es: Client;
  /** AI runtime (server/ai/runtime.ts); absent: AI is reported unavailable. */
  ai?: AiRuntime | null;
  /** Google sign-in (`createAuthService`, server/auth/better-auth.ts); absent: sign-in is off. */
  auth?: AuthService | null;
  /** Evidence retrieval for AI briefs (`createBriefServices`, server/briefs/services.ts); absent: AI briefs are unavailable. */
  briefs?: BriefServices | null;
  /**
   * Test seam: which evidence index AI would use. Default: the active manifest's passages
   * index when the dataset resolver reports it servable and the briefs' retriever accepts
   * it (`servableEvidence`).
   */
  aiEvidence?: () => Promise<EvidenceDataset | null>;
  /** Built web client (`dist/web`); null or a missing directory serves the API only. */
  webRoot?: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Browsing rate limit per network identity (default 60 a minute). */
  rateLimit?: { limit: number; windowMs: number };
  /** Brief polling limit per network identity (default 150 a minute). */
  pollRateLimit?: { limit: number; windowMs: number };
  /** How long the active manifest is reused (default 5 s). */
  manifestTtlMs?: number;
  /** The closing deadline (default `SHUTDOWN_GRACE_MS`). */
  shutdownGraceMs?: number;
  /** How long a health probe result is shared (default `HEALTH_CACHE_MS`). */
  healthCacheMs?: number;
  /** The whole-request bound (default `REQUEST_TIMEOUT_MS`; tests shorten it). */
  requestTimeoutMs?: number;
  /** URLs per case sitemap (default 10,000; tests lower it). */
  sitemapUrlLimit?: number;
  now?: () => number;
}

/**
 * The closing deadline, from the start of `close()`: within the 10 s the process allows
 * itself on SIGTERM (server/main.ts), leaving time to close the database and tracing.
 * Steps and paid requests settle first; responses still in flight get what is left.
 */
export const SHUTDOWN_GRACE_MS = 9_000;
/**
 * Idle keep-alive timeout. Above the Cloudflare Tunnel connector's 90 s idle keep-alive
 * to the origin, so the origin never closes a connection the connector may still reuse
 * (a request sent on it would fail at the edge). Closing does not wait for it: Node's
 * `server.close()` closes idle connections at once and responses sent while closing end
 * their connection.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 95_000;
/**
 * The longest a client may take to send one whole request, headers and body (platform
 * review P1). Fastify's default is none (0), and Node's own header timeout does not
 * cover the body, so a client that sent headers and then stalled or trickled its body
 * held a socket and a request for ever. Every legitimate body here is at most 16 KB.
 * Node refuses a header timeout above the request timeout, so the header timeout is kept
 * within it; stalled connections are checked every `CONNECTION_CHECK_MS` (Node's default
 * is 30 s), so one is answered 408 (`clientErrorHandler`) and closed within about 65 s.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
export const CONNECTION_CHECK_MS = 5_000;

/**
 * Route patterns of the web client that need no network identity and are not rate limited:
 * the pages whose head needs no database read, robots.txt and the static files
 * (`@fastify/static`'s wildcard). A case page and the sitemaps read the database: they are not here.
 */
export const ASSET_ROUTES: ReadonlySet<string> = new Set([...PUBLIC_PAGE_ROUTES, ROBOTS_ROUTE, '/*']);
const HEALTH_ROUTE = '/api/health';
/** Read by the brief page about once a second while a step runs. */
export const POLL_ROUTES: ReadonlySet<string> = new Set(['/api/briefs/:id']);

type Access = 'asset' | 'health' | 'api' | 'poll';

/** The access class of a request, from its matched route; an unmatched request is the not-found handler. */
function accessOf(route: string | undefined, method = 'GET'): Access {
  if (route === undefined || ASSET_ROUTES.has(route)) return 'asset';
  if (route === HEALTH_ROUTE) return 'health';
  if (POLL_ROUTES.has(route) && method === 'GET') return 'poll';
  return 'api';
}

/**
 * An API path, as the router sees it (`routerPath`, server/http/request-target.ts). Used to
 * choose a JSON or a page 404 and which responses are API responses; access control uses the
 * matched route.
 */
const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

/**
 * The service, not the request, is at fault: Elasticsearch transport failures, an
 * index that is missing or overloaded, a search that timed out, PostgreSQL connection
 * failures (no connection free in time, a connection that broke or stalled, a statement
 * the server ended at its timeout: `isDatabaseUnavailable`), a bounded lock wait that
 * timed out or a deadlock (fail closed), or no servable dataset.
 */
export function isUnavailable(err: unknown): boolean {
  if (err instanceof DatasetUnavailableError || err instanceof SearchTimedOutError || err instanceof SearchIncompleteError || err instanceof AuthUnavailableError) return true;
  if (isDatabaseUnavailable(err)) return true;
  const e = err as { name?: string; code?: string; meta?: { statusCode?: number } };
  if (['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError'].includes(e.name ?? '')) return true;
  if (e.name === 'ResponseError' && [404, 429, 502, 503, 504].includes(e.meta?.statusCode ?? 0)) return true;
  const code = e.code ?? (err as { cause?: { code?: string } }).cause?.code ?? '';
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', '53300', '55P03', '40P01'].includes(code) || code.startsWith('08');
}

const logToken = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(v);

/**
 * How an `err` is logged: its name, code and (an Elasticsearch error's) type, never its
 * message or stack (platform review P7). A message can hold the request URL with its
 * search text (Fastify's own warning about a reply sent twice), a query or an address.
 * The app's own log lines already pass only these fields.
 */
export function serializeLoggedError(e: unknown): Record<string, string> {
  const x = (e ?? {}) as { name?: unknown; code?: unknown; type?: unknown };
  return {
    ...(logToken(x.name) ? { name: x.name } : {}),
    ...(logToken(x.code) ? { code: x.code } : {}),
    ...(logToken(x.type) ? { type: x.type } : {}),
  };
}

/** A log message without the query string of any path in it (`/api/search?q=…` → `/api/search?…`). */
export function withoutQueries(message: string): string {
  return message.replace(/(\/[^\s"'?]*)\?[^\s"']*/g, '$1?…');
}

/**
 * The logger options with `serializeLoggedError` in force, and no request target in a
 * message: pino makes an error's message the line's message when a call gives none
 * (`log.warn({ err })`, `log.error(err)`), so such a call gets a fixed one; and a message
 * string loses the query string of any path in it (Fastify's warning about a handler that
 * answered twice quotes the request URL; platform review P7).
 */
function withErrorSerializer(logger: AppDeps['logger']): FastifyServerOptions['logger'] {
  if (logger === undefined || logger === false) return false;
  const base = (logger === true ? {} : logger) as { serializers?: Record<string, unknown> };
  return {
    ...base,
    serializers: { ...base.serializers, err: serializeLoggedError },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        const [first, second, ...rest] = args;
        if (typeof first === 'string') return method.apply(this, [withoutQueries(first), ...args.slice(1)]);
        const message = typeof second === 'string' ? withoutQueries(second) : 'error logged';
        if (first instanceof Error) return method.apply(this, [{ err: first }, message, ...rest]);
        if (typeof first === 'object' && first !== null && ('err' in first || typeof second === 'string')) return method.apply(this, [first, message, ...rest]);
        return method.apply(this, args);
      },
    },
  } as unknown as FastifyServerOptions['logger'];
}

/** Fastify's own request errors (body too large, unsupported media type, ...). */
const isRequestError = (err: unknown): boolean => {
  const e = err as { code?: string; statusCode?: number };
  return typeof e.code === 'string' && e.code.startsWith('FST_') && typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500;
};

/** A 4xx status carried by an error (`@fastify/static` and `send` use `status`/`statusCode`). */
function clientStatus(err: unknown): number | null {
  const e = err as { statusCode?: unknown; status?: unknown };
  const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : null;
  return status !== null && status >= 400 && status < 500 ? status : null;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const trusted = compileTrustedProxies(deps.config.trustedProxyCidrs);
  // The page loads Turnstile when anonymous AI is configured (`/api/config` sends the site key).
  const turnstile = Boolean(deps.ai?.gate);
  // Only live is indexed: elsewhere every response, the HTTP parser's refusals included, says so.
  const live = deps.config.appEnv === 'live';
  const headers: Readonly<Record<string, string>> = {
    ...securityHeaders({ hsts: isHttpsUrl(deps.config.appUrl), turnstile }),
    ...(live ? {} : { 'x-robots-tag': 'noindex, nofollow' }),
  };
  const withHeaders = (reply: FastifyReply): FastifyReply => {
    for (const [name, value] of Object.entries(headers)) {
      // A page sets its own CSP (with its style nonce).
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    // On live, API responses stay out of search results; pages carry their own robots meta.
    if (live && isApiPath(routerPath(reply.request.url))) reply.header('x-robots-tag', 'noindex');
    return reply;
  };

  const identityOf = (peer: string | undefined, clientIp: string | string[] | undefined) => resolveNetworkIdentity(peer, clientIp, trusted);
  const requestTimeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const app = Fastify({
    logger: withErrorSerializer(deps.logger),
    trustProxy: false,
    // Request logs would hold client addresses and search text; responses are logged below without either.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
    // A request must arrive whole within this bound (REQUEST_TIMEOUT_MS); the header timeout
    // stays within it (Node requires that), and stalled connections are checked often.
    requestTimeout,
    http: {
      headersTimeout: Math.min(60_000, requestTimeout),
      connectionsCheckingInterval: Math.min(CONNECTION_CHECK_MS, Math.max(100, Math.floor(requestTimeout / 2))),
    },
    // While closing, `onRequest` refuses new requests itself (503 `unavailable`, with the
    // security headers), instead of Fastify's own bare 503.
    return503OnClosing: false,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    // The HTTP parser's own refusals (before routing) carry the security headers too.
    clientErrorHandler: makeClientErrorHandler(headers, { trusted }),
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 64 },
    // The router's own refusals (a malformed URL) get the security headers and an ErrorResponse.
    // `onRequest` never runs for them, so the tunnel's peer check applies here too: a peer
    // that is not the connector gets 403, not a 400 that tells it how we parse URLs.
    frameworkErrors: (error, request, reply) => {
      withHeaders(reply);
      const peer = identityOf(request.raw.socket.remoteAddress, undefined);
      if (!peer.ok && peer.status === 403) {
        request.log.warn({ reason: peer.reason }, 'request refused');
        void sendError(reply, 403, 'forbidden');
        return;
      }
      if (clientStatus(error) !== null) void sendError(reply, 400, 'bad_request', { message: 'The request URL is not valid.' });
      else void sendError(reply, 500, 'internal');
    },
  });

  const limiter = new RateLimiter({ ...(deps.rateLimit ?? { limit: 60, windowMs: 60_000 }), ...(deps.now ? { now: deps.now } : {}) });
  const pollLimiter = new RateLimiter({ ...(deps.pollRateLimit ?? { limit: 150, windowMs: 60_000 }), ...(deps.now ? { now: deps.now } : {}) });
  const datasets = new DatasetResolver(deps.db, deps.es, {
    ...(deps.embedding ? { embedding: deps.embedding } : {}),
    // `reason` is a fixed category (never upstream text).
    onPassagesUnservable: (index: string, code: string, reason: string) =>
      app.log.warn({ index, code, reason }, 'passages index not servable: AI evidence stays off'),
    ...(deps.manifestTtlMs !== undefined ? { manifestTtlMs: deps.manifestTtlMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const briefs = deps.briefs ?? null;
  const ctx: ApiContext = {
    db: deps.db,
    es: deps.es,
    datasets,
    log: app.log,
    ai: deps.ai ?? null,
    auth: deps.auth ?? null,
    briefs,
    aiEvidence: deps.aiEvidence ?? (() => servableEvidence(briefs, () => datasets.current())),
    onUnknownFacetValue: (facet: FacetKey, value: string) =>
      app.log.warn({ facet, value: value.slice(0, 16) }, 'facet value outside the vocabulary left out of the buckets'),
  };

  app.decorateRequest('networkIdentity', null);

  // Shutdown, before the HTTP drain (which would otherwise wait for requests that wait
  // for the steps), within one deadline: brief services begin shutdown (running steps are
  // aborted; paid requests still in the gate, admission or step creation are refused or
  // stop before any provider call) and closing waits for steps and paid requests to
  // settle. Responses sent from now on end their connection; whatever is still open at
  // the deadline is closed.
  let closing = false;
  let drain: NodeJS.Timeout | undefined;
  app.addHook('preClose', async () => {
    closing = true;
    const deadline = performance.now() + (deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    const left = () => Math.max(0, deadline - performance.now());
    if (briefs) {
      briefs.beginShutdown();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        briefs.settled(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left());
        }),
      ]);
      clearTimeout(timer);
    }
    drain = setTimeout(() => app.server.closeAllConnections(), left());
    drain.unref();
  });
  app.addHook('onClose', async () => clearTimeout(drain));
  app.addHook('onSend', async (_request, reply) => {
    if (closing) reply.header('connection', 'close');
  });

  app.addHook('onRequest', async (request, reply) => {
    // Closing: nothing new starts (onSend closes the connection).
    if (closing) return sendError(reply, 503, 'unavailable');
    // The route the router matched on the decoded path; the raw target is never consulted.
    const access = accessOf(request.routeOptions.url, request.method);
    const peer = request.raw.socket.remoteAddress;
    // The container's own health check connects over loopback, never through the tunnel.
    if (access === 'health' && isLoopback(peer)) return;
    const identity = resolveNetworkIdentity(peer, request.headers[CLIENT_IP_HEADER], trusted);
    if (!identity.ok) {
      if (identity.status === 403) {
        request.log.warn({ reason: identity.reason }, 'request refused');
        return sendError(reply, 403, 'forbidden');
      }
      // The page and static files need no client address; everything else does.
      if (access === 'asset') return;
      return sendError(reply, 400, 'bad_request', { message: 'The client address is missing or invalid.' });
    }
    request.networkIdentity = identity.identity;
    if (access === 'asset') return;
    const decision = (access === 'poll' ? pollLimiter : limiter).take(identity.identity);
    if (!decision.ok) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      return sendError(reply, 429, 'rate_limited', { retryAfter: decision.retryAfterSeconds });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    withHeaders(reply);
    // Per-visitor routes (AI, auth, account, briefs) are never stored, whatever their handler set.
    if (isNoStoreRoute(request.routeOptions.url)) reply.header('cache-control', PRIVATE_NO_STORE);
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const matched = request.routeOptions.url;
    let route = matched;
    if (accessOf(matched) === 'asset') {
      // An unmatched /api path reaches the not-found handler: still one line per API request,
      // with the class of path only (never the raw target, which may hold search text).
      if (!isApiPath(routerPath(request.url))) return;
      route = 'unmatched';
    }
    request.log.info(
      { method: request.method, route, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'api request',
    );
  });

  app.setErrorHandler(async (err, request, reply) => {
    if (isUnavailable(err)) {
      request.log.warn({ err: { name: (err as Error).name } }, 'dependency unavailable');
      return sendError(reply, 503, 'unavailable');
    }
    if (isRequestError(err)) {
      const status = (err as { statusCode: number }).statusCode;
      return status === 404 ? sendError(reply, 404, 'not_found') : sendError(reply, status, 'bad_request');
    }
    // The static files' refusals (a path outside the root, a NUL byte, ...) are the request's fault.
    const status = clientStatus(err);
    if (status !== null && accessOf(request.routeOptions.url) === 'asset' && (err as Error).name !== 'ResponseError') {
      if (status === 412 || status === 416) {
        // Conditional and range refusals are the client's protocol, not a bad request: pass the status
        // through, with the Content-Range a 416 carries.
        const contentRange = (err as { headers?: Record<string, unknown> }).headers?.['Content-Range'];
        if (status === 416 && typeof contentRange === 'string' && /^bytes \*\/\d+$/.test(contentRange)) reply.header('content-range', contentRange);
        return sendError(reply, status, 'bad_request');
      }
      return [403, 404, 410].includes(status) ? sendError(reply, 404, 'not_found') : sendError(reply, 400, 'bad_request');
    }
    request.log.error({ err: { name: (err as Error).name, type: (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type } }, 'request failed');
    return sendError(reply, 500, 'internal');
  });

  healthRoutes(app, ctx, deps.healthCacheMs);
  configRoutes(app, ctx);
  searchRoutes(app, ctx);
  caseRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  aiStatusRoutes(app, ctx);
  briefRoutes(app, ctx, { appUrl: deps.config.appUrl });
  accountRoutes(app, ctx, { appUrl: deps.config.appUrl });
  for (const problem of deps.ai?.problems ?? ['AI is not configured']) app.log.warn({ problem }, 'AI feature off');
  if (deps.ai?.gate?.testKeys) app.log.warn('Turnstile test keys in use: every challenge passes (development only)');

  const webRoot = deps.webRoot ?? null;
  const indexFile = webRoot ? join(webRoot, 'index.html') : null;
  const template = indexFile && existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
  if (webRoot !== null && template === null) app.log.warn('no built web client found; serving the API only (run pnpm build:web)');

  /**
   * The pages, each with a head built for its route and a fresh style nonce in its CSP and as
   * the `nonce` attribute of `<meta property="csp-nonce">` (security-headers.ts; browsers hide
   * that attribute from the DOM, so the client reads the element's `nonce` property,
   * web/src/csp-nonce.ts), plus robots.txt and the sitemaps.
   */
  const pageNotFound = pageRoutes(app, ctx, {
    origin: new URL(deps.config.appUrl).origin,
    live,
    template,
    turnstile,
    ...(deps.sitemapUrlLimit ? { sitemapUrlLimit: deps.sitemapUrlLimit } : {}),
  });

  if (webRoot !== null && template !== null) {
    void app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: true,
      index: false,
      // Never a dotfile or a dot directory (a stray `.env` or a build manifest): 404 (platform review P6).
      dotfiles: 'ignore',
      cacheControl: false,
      etag: true,
      lastModified: true,
      setHeaders(reply, filePath) {
        // Vite's hashed bundles never change; other files (favicon, licences) are revalidated hourly.
        reply.header('cache-control', filePath.startsWith(join(webRoot, 'assets')) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    // Decide on the path the router saw: `/%61pi/nope` is an API 404, not the page.
    const path = routerPath(request.url);
    if (isApiPath(path)) return sendError(reply, 404, 'not_found');
    return pageNotFound(request, reply, path);
  });

  return app;
}
