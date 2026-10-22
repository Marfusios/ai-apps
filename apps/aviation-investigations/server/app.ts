/**
 * The HTTP server: the public API and the built web client on one origin.
 *
 * - `GET /api/health`, `/api/config`, `/api/search`, `/api/cases/:ntsbNo` and
 *   `/api/dashboard`, each pinned to the active dataset manifest (server/dataset.ts).
 * - The web client from `dist/web` with an SPA fallback: any other GET that accepts
 *   HTML gets the page (`index.html` with a per-response style nonce). Hashed assets
 *   are cached for a year; the page is revalidated.
 * - Every request is checked first by network identity (server/http/network-identity.ts):
 *   in tunnel mode only the trusted connector may connect (403 otherwise), and the API
 *   requires a valid `CF-Connecting-IP` (400). The API (but not the health check or the
 *   static files) is rate limited per network identity.
 * - Every response carries the security headers (server/http/security-headers.ts).
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
import { DatasetResolver, DatasetUnavailableError } from './dataset.js';
import type { Db } from './db/client.js';
import { CLIENT_IP_HEADER, compileTrustedProxies, isLoopback, resolveNetworkIdentity } from './http/network-identity.js';
import { RateLimiter } from './http/rate-limit.js';
import { sendError } from './http/reply.js';
import { contentSecurityPolicy, securityHeaders } from './http/security-headers.js';
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
  /** Built web client (`dist/web`); null or a missing directory serves the API only. */
  webRoot?: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Browsing rate limit per network identity (default 60 a minute). */
  rateLimit?: { limit: number; windowMs: number };
  /** How long the active manifest is reused (default 5 s). */
  manifestTtlMs?: number;
  now?: () => number;
}

const API_PREFIX = '/api/';
const HEALTH = '/api/health';

const isApi = (url: string): boolean => url === '/api' || url.startsWith(API_PREFIX);
const pathOf = (url: string): string => url.split('?', 1)[0] ?? url;

/**
 * The service, not the request, is at fault: Elasticsearch transport failures, an
 * index that is missing or overloaded, PostgreSQL connection failures, or no
 * servable dataset.
 */
function isUnavailable(err: unknown): boolean {
  if (err instanceof DatasetUnavailableError) return true;
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

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: false,
    // Request logs would hold client addresses and search text; responses are logged below without either.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 64 },
  });

  const trusted = compileTrustedProxies(deps.config.trustedProxyCidrs);
  const headers = securityHeaders({ hsts: deps.config.appUrl.startsWith('https://') });
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
    onUnknownFacetValue: (facet: FacetKey, value: string) =>
      app.log.warn({ facet, value: value.slice(0, 16) }, 'facet value outside the vocabulary left out of the buckets'),
  };

  app.decorateRequest('networkIdentity', null);

  app.addHook('onRequest', async (request, reply) => {
    const path = pathOf(request.url);
    const peer = request.raw.socket.remoteAddress;
    // The container's own health check connects over loopback, never through the tunnel.
    if (path === HEALTH && isLoopback(peer)) return;
    const header = request.headers[CLIENT_IP_HEADER];
    const identity = resolveNetworkIdentity(peer, header, trusted);
    if (!identity.ok) {
      if (identity.status === 403) {
        request.log.warn({ reason: identity.reason }, 'request refused');
        return sendError(reply, 403, 'bad_request', { message: 'Forbidden.' });
      }
      // A missing or invalid client address is refused on the API; static files need none.
      if (isApi(path)) return sendError(reply, 400, 'bad_request', { message: 'The client address is missing or invalid.' });
      return;
    }
    request.networkIdentity = identity.identity;
    if (isApi(path) && path !== HEALTH) {
      const decision = limiter.take(identity.identity);
      if (!decision.ok) {
        reply.header('retry-after', String(decision.retryAfterSeconds));
        return sendError(reply, 429, 'rate_limited', { retryAfter: decision.retryAfterSeconds });
      }
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(headers)) {
      // A page sets its own CSP (with its style nonce).
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const path = pathOf(request.url);
    if (!isApi(path)) return;
    request.log.info(
      { method: request.method, route: request.routeOptions.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
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
    request.log.error({ err: { name: (err as Error).name, type: (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type } }, 'request failed');
    return sendError(reply, 500, 'internal');
  });

  healthRoutes(app, ctx);
  configRoutes(app, ctx);
  searchRoutes(app, ctx);
  caseRoutes(app, ctx);
  dashboardRoutes(app, ctx);

  const webRoot = deps.webRoot ?? null;
  const indexFile = webRoot ? join(webRoot, 'index.html') : null;
  const template = indexFile && existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
  if (webRoot !== null && template === null) app.log.warn('no built web client found; serving the API only (run pnpm build:web)');

  /** The SPA page, with a fresh style nonce in its CSP and in a meta tag (security-headers.ts). */
  const sendPage = (reply: FastifyReply, page: string) => {
    const nonce = randomBytes(18).toString('base64');
    const html = page.replace('</head>', `<meta name="csp-nonce" content="${nonce}"></head>`);
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
    const path = pathOf(request.url);
    if (isApi(path)) return sendError(reply, 404, 'not_found');
    const wantsPage =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !/\.[A-Za-z0-9]{1,8}$/.test(path) &&
      (request.headers.accept ?? '').includes('text/html');
    if (template !== null && wantsPage) return sendPage(reply, template);
    return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found');
  });

  return app;
}
