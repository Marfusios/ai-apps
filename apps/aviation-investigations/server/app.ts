/**
 * The HTTP server: the public API and the built web client on one origin.
 *
 * - `GET /api/health`, `/api/config`, `/api/search`, `/api/cases/:ntsbNo` and
 *   `/api/dashboard`, each pinned to the active dataset manifest (server/dataset.ts),
 *   and `GET /api/ai/status` (server/routes/ai-status.ts). AI routes get the anonymous
 *   gate (server/identity/gate.ts) from `ApiContext.ai`.
 * - The web client from `dist/web` with an SPA fallback: any other GET that accepts
 *   HTML gets the page (`index.html` with a per-response style nonce). Hashed assets
 *   are cached for a year; the page is revalidated.
 * - Access is decided from the route the router matched (the decoded path), never from
 *   the raw request target, so `/%61pi/search` or an absolute-form `http://x/api/search`
 *   get exactly the checks of `/api/search`. Default deny: every matched route needs a
 *   network identity (server/http/network-identity.ts) and is rate limited, except
 *   - the web client's routes (`ASSET_ROUTES`: the page and the static files) and the
 *     not-found handler (the SPA page or a 404), which need no client address and are
 *     not limited, and
 *   - `GET /api/health` from loopback (the container's own health check).
 *   In tunnel mode only the trusted connector may connect at all (403 otherwise).
 * - Every response carries the security headers (server/http/security-headers.ts),
 *   including the router's own errors for malformed URLs (`frameworkErrors`, which
 *   applies the tunnel peer check first) and the HTTP parser's (`clientErrorHandler`).
 * - `Cache-Control` of per-visitor routes (AI, briefs, auth, account) is forced to
 *   `private, no-store` from the matched route (server/http/cache-headers.ts).
 *
 * Fastify runs with `trustProxy: false`; `request.ip` is never used.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../shared/config.js';
import type { FacetKey } from '../shared/contracts/search.js';
import type { AiRuntime } from './ai/runtime.js';
import { DatasetResolver, DatasetUnavailableError } from './dataset.js';
import type { Db } from './db/client.js';
import { CLIENT_IP_HEADER, compileTrustedProxies, isLoopback, resolveNetworkIdentity } from './http/network-identity.js';
import { isNoStoreRoute, PRIVATE_NO_STORE } from './http/cache-headers.js';
import { makeClientErrorHandler } from './http/client-error.js';
import { RateLimiter } from './http/rate-limit.js';
import { sendError } from './http/reply.js';
import { contentSecurityPolicy, isHttpsUrl, securityHeaders } from './http/security-headers.js';
import { SearchTimedOutError } from './search/timeout.js';
import { aiStatusRoutes } from './routes/ai-status.js';
import { caseRoutes } from './routes/cases.js';
import { configRoutes } from './routes/config.js';
import type { ApiContext } from './routes/context.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { healthRoutes } from './routes/health.js';
import { searchRoutes } from './routes/search.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Rate-limit key (server/http/network-identity.ts); null for static files without one. */
    networkIdentity: string | null;
  }
}

export interface AppDeps {
  config: Pick<AppConfig, 'appUrl' | 'trustedProxyCidrs'>;
  /** PostgreSQL as `aviation_app`. */
  db: Db;
  /** Elasticsearch with the read key only. */
  es: Client;
  /** AI runtime (server/ai/runtime.ts); absent: AI is reported unavailable. */
  ai?: AiRuntime | null;
  /** Built web client (`dist/web`); null or a missing directory serves the API only. */
  webRoot?: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Browsing rate limit per network identity (default 60 a minute). */
  rateLimit?: { limit: number; windowMs: number };
  /** How long the active manifest is reused (default 5 s). */
  manifestTtlMs?: number;
  /** How long a health probe result is shared (default `HEALTH_CACHE_MS`). */
  healthCacheMs?: number;
  now?: () => number;
}

/** Route patterns of the web client: the page and the static files (`@fastify/static`'s wildcard). */
export const ASSET_ROUTES: ReadonlySet<string> = new Set(['/', '/index.html', '/*']);
const HEALTH_ROUTE = '/api/health';

type Access = 'asset' | 'health' | 'api';

/** The access class of a request, from its matched route; an unmatched request is the not-found handler. */
function accessOf(route: string | undefined): Access {
  if (route === undefined || ASSET_ROUTES.has(route)) return 'asset';
  if (route === HEALTH_ROUTE) return 'health';
  return 'api';
}

/**
 * The path the router sees: the request target without an absolute-form scheme and
 * authority or the query, percent-decoded (left as is when malformed). Used only to
 * choose a JSON or a page 404; access control uses the matched route.
 */
export function routerPath(target: string): string {
  let path = target.replace(/^https?:\/\/[^/?#]*/i, '');
  path = path.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/')) path = `/${path}`;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

/**
 * The service, not the request, is at fault: Elasticsearch transport failures, an
 * index that is missing or overloaded, a search that timed out, PostgreSQL connection
 * failures, or no servable dataset.
 */
function isUnavailable(err: unknown): boolean {
  if (err instanceof DatasetUnavailableError || err instanceof SearchTimedOutError) return true;
  const e = err as { name?: string; code?: string; meta?: { statusCode?: number } };
  if (['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError'].includes(e.name ?? '')) return true;
  if (e.name === 'ResponseError' && [404, 429, 502, 503, 504].includes(e.meta?.statusCode ?? 0)) return true;
  const code = e.code ?? (err as { cause?: { code?: string } }).cause?.code ?? '';
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', '53300'].includes(code) || code.startsWith('08');
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
  const headers = securityHeaders({ hsts: isHttpsUrl(deps.config.appUrl) });
  const withHeaders = (reply: FastifyReply): FastifyReply => {
    for (const [name, value] of Object.entries(headers)) {
      // A page sets its own CSP (with its style nonce).
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return reply;
  };

  const identityOf = (peer: string | undefined, clientIp: string | string[] | undefined) => resolveNetworkIdentity(peer, clientIp, trusted);

  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: false,
    // Request logs would hold client addresses and search text; responses are logged below without either.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
    return503OnClosing: true,
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
  const datasets = new DatasetResolver(deps.db, deps.es, {
    ...(deps.manifestTtlMs !== undefined ? { manifestTtlMs: deps.manifestTtlMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const ctx: ApiContext = {
    db: deps.db,
    es: deps.es,
    datasets,
    log: app.log,
    ai: deps.ai ?? null,
    onUnknownFacetValue: (facet: FacetKey, value: string) =>
      app.log.warn({ facet, value: value.slice(0, 16) }, 'facet value outside the vocabulary left out of the buckets'),
  };

  app.decorateRequest('networkIdentity', null);

  app.addHook('onRequest', async (request, reply) => {
    // The route the router matched on the decoded path; the raw target is never consulted.
    const access = accessOf(request.routeOptions.url);
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
    const decision = limiter.take(identity.identity);
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
  for (const problem of deps.ai?.problems ?? ['AI is not configured']) app.log.warn({ problem }, 'AI feature off');
  if (deps.ai?.gate?.testKeys) app.log.warn('Turnstile test keys in use: every challenge passes (development only)');

  const webRoot = deps.webRoot ?? null;
  const indexFile = webRoot ? join(webRoot, 'index.html') : null;
  const template = indexFile && existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
  if (webRoot !== null && template === null) app.log.warn('no built web client found; serving the API only (run pnpm build:web)');

  /**
   * The SPA page, with a fresh style nonce in its CSP and as the `nonce` attribute of
   * `<meta property="csp-nonce">` (security-headers.ts). Browsers hide that attribute
   * from the DOM; the client reads the element's `nonce` property (web/src/csp-nonce.ts).
   */
  const sendPage = (reply: FastifyReply, page: string) => {
    // Base64 of random bytes: no character that could leave the attribute value.
    const nonce = randomBytes(18).toString('base64');
    const html = page.replace('</head>', `<meta property="csp-nonce" nonce="${nonce}"></head>`);
    return reply
      .code(200)
      .header('content-security-policy', contentSecurityPolicy({ styleNonce: nonce }))
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(html);
  };

  if (webRoot !== null && template !== null) {
    const page = template;
    app.get('/', async (_request, reply) => sendPage(reply, page));
    app.get('/index.html', async (_request, reply) => sendPage(reply, page));
    void app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: true,
      index: false,
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
    const wantsPage =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !/\.[A-Za-z0-9]{1,8}$/.test(path) &&
      (request.headers.accept ?? '').includes('text/html');
    if (template !== null && wantsPage) return sendPage(reply, template);
    return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found');
  });

  return app;
}
