/**
 * The web client's pages and what crawlers read about them (README, "Search engines and link
 * previews"). Every page is the SPA's `index.html` with a head built for its route
 * (server/seo/head.ts: title, description, robots, canonical, Open Graph, Twitter, JSON-LD), a
 * fresh style nonce, and the status its route has; the client renders the page itself.
 *
 * - `/`, `/explore`, `/dashboard`, `/about`, `/privacy`, `/compare`, `/account` and
 *   `/briefs/:id` are 200. `/cases/:ntsbNo` is 200 for a case `GET /api/cases/:ntsbNo`
 *   serves (the same lookup, `findCase`) and 404 otherwise; any other path without a file
 *   extension (and `/index.html`) is the 404 page: the client router shows its not-found page.
 * - A served case number not in its canonical form (lower case, padded) is redirected (301) to
 *   the canonical case path, and a page path with a trailing slash to the path without it; the
 *   query string is dropped. Redirect targets are built from the route, never from the request.
 * - A page goes to GET and HEAD requests whose `Accept` is absent or takes `text/html` or
 *   `*\/*`; anything else, and a path with a file extension no route serves, gets the plain
 *   text 404.
 * - `/cases/:ntsbNo` reads the database, so it is not an asset route (server/app.ts): it needs a
 *   network identity and counts against the API's rate limit; a refusal, or a dataset or
 *   database that is unavailable, keeps the API's error contract (`ErrorResponse`). So do the
 *   sitemaps. The other pages and `/robots.txt` are asset routes.
 * - `/robots.txt` (server/seo/robots.ts) and `/sitemap.xml` with `/sitemaps/{name}`
 *   (server/seo/sitemaps.ts), cached publicly for an hour.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatasetUnavailableError } from '../dataset.js';
import { sendError } from '../http/reply.js';
import { routerPath, targetQuery } from '../http/request-target.js';
import { contentSecurityPolicy } from '../http/security-headers.js';
import { pageHead, pagePolicy, type PageRoute } from '../seo/head.js';
import { renderPage, splitTemplate } from '../seo/page-template.js';
import { robotsTxt } from '../seo/robots.js';
import { SitemapStore, readSitemapCases, sitemapFile, type Sitemaps } from '../seo/sitemaps.js';
import { findCase } from './cases.js';
import type { ApiContext } from './context.js';

/** Pages anyone may load without a network identity or the rate limit (server/app.ts `ASSET_ROUTES`). */
export const PUBLIC_PAGE_ROUTES: readonly string[] = ['/', '/index.html', '/explore', '/dashboard', '/about', '/privacy', '/compare', '/account', '/briefs/:id'];
export const ROBOTS_ROUTE = '/robots.txt';
/** Read from the database: rate limited like the API. */
export const CASE_PAGE_ROUTE = '/cases/:ntsbNo';

/** How crawlers may cache robots.txt and the sitemaps. */
const CRAWL_CACHE = 'public, max-age=3600';

export interface PageOptions {
  /** APP_URL's origin: canonical URLs, the share image and the sitemaps. */
  origin: string;
  /** APP_ENV is live: robots.txt lets crawlers in. */
  live: boolean;
  /** The built `index.html`; null when there is no web client (then there are no pages). */
  template: string | null;
  /** Anonymous AI is configured: the page's CSP allows Turnstile. */
  turnstile: boolean;
  /** URLs per case sitemap (tests lower it; default `MAX_SITEMAP_URLS`). */
  sitemapUrlLimit?: number;
}

/** The plain-text 404 of a request that does not take a page. */
export function notFoundText(reply: FastifyReply): FastifyReply {
  return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found');
}

/** `Accept` absent, or taking HTML or anything (`*\/*`). */
export function acceptsPage(accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') return true;
  const types = accept.toLowerCase();
  return types.includes('text/html') || types.includes('*/*');
}

/** A request target whose path (as the router sees it, server/http/request-target.ts) ends in a slash. */
const hasTrailingSlash = (target: string): boolean => {
  const path = routerPath(target);
  return path.length > 1 && path.endsWith('/');
};

const queryOf = (target: string): URLSearchParams => new URLSearchParams(targetQuery(target));

/** The pages whose head needs no database read, by route pattern. */
const STATIC_PAGES: ReadonlyArray<readonly [string, (request: FastifyRequest) => PageRoute]> = [
  ['/', () => ({ kind: 'home' })],
  ['/explore', (request) => ({ kind: 'explore', query: queryOf(request.url) })],
  ['/dashboard', () => ({ kind: 'dashboard' })],
  ['/about', () => ({ kind: 'about' })],
  ['/privacy', () => ({ kind: 'privacy' })],
  ['/compare', (request) => ({ kind: 'compare', query: queryOf(request.url) })],
  ['/account', () => ({ kind: 'account' })],
  ['/briefs/:id', (request) => ({ kind: 'brief', id: String((request.params as { id?: string }).id ?? '') })],
  // The file itself is never served (it has no style nonce); the client has no page there.
  ['/index.html', () => ({ kind: 'not_found' })],
];

/**
 * Registers the pages, robots.txt and the sitemaps when there is a web client, and returns how
 * the not-found handler answers a path outside the API: the 404 page, or the plain-text 404.
 */
export function pageRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  opts: PageOptions,
): (request: FastifyRequest, reply: FastifyReply, path: string) => FastifyReply {
  if (opts.template === null) return (_request, reply) => notFoundText(reply);
  const template = splitTemplate(opts.template);

  const send = (reply: FastifyReply, route: PageRoute): FastifyReply => {
    // Base64 of random bytes: no character that could leave the attribute value.
    const nonce = randomBytes(18).toString('base64');
    return reply
      .code(pagePolicy(route).status)
      .header('content-security-policy', contentSecurityPolicy({ styleNonce: nonce, turnstile: opts.turnstile }))
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(renderPage(template, pageHead(route, opts.origin), nonce));
  };

  for (const [pattern, routeOf] of STATIC_PAGES) {
    app.get(pattern, async (request, reply) => {
      if (!acceptsPage(request.headers.accept)) return notFoundText(reply);
      const route = routeOf(request);
      const canonical = pagePolicy(route).canonicalPath;
      if (canonical !== null && hasTrailingSlash(request.url)) return reply.redirect(canonical, 301);
      return send(reply, route);
    });
  }

  app.get<{ Params: { ntsbNo: string } }>(CASE_PAGE_ROUTE, async (request, reply) => {
    if (!acceptsPage(request.headers.accept)) return notFoundText(reply);
    const requested = String(request.params.ntsbNo ?? '');
    const found = await findCase(ctx, requested, request.log);
    if (found === 'invalid') return sendError(reply, 500, 'internal');
    if (found === null) return send(reply, { kind: 'missing_case', requested });
    if (requested !== found.detail.ntsbNo || hasTrailingSlash(request.url)) return reply.redirect(`/cases/${found.detail.ntsbNo}`, 301);
    return send(reply, { kind: 'case', detail: found.detail });
  });

  app.get(ROBOTS_ROUTE, async (_request, reply) =>
    reply.header('cache-control', CRAWL_CACHE).type('text/plain; charset=utf-8').send(robotsTxt({ live: opts.live, origin: opts.origin })),
  );

  const sitemaps = new SitemapStore({
    origin: opts.origin,
    readCases: (generationId) => readSitemapCases(ctx.db, generationId),
    ...(opts.sitemapUrlLimit ? { urlLimit: opts.sitemapUrlLimit } : {}),
  });
  /** The active dataset's sitemaps; the pages only while no dataset can be served. */
  const currentSitemaps = async (): Promise<Sitemaps> => {
    try {
      const pinned = await ctx.datasets.current();
      return await sitemaps.of({ revision: pinned.dataset.revision, generationId: pinned.manifest.generationId, snapshotDate: pinned.dataset.snapshotDate });
    } catch (err) {
      if (err instanceof DatasetUnavailableError) return sitemaps.withoutCases;
      throw err;
    }
  };
  const sendXml = (reply: FastifyReply, xml: string): FastifyReply =>
    reply.header('cache-control', CRAWL_CACHE).type('application/xml; charset=utf-8').send(xml);
  app.get('/sitemap.xml', async (_request, reply) => sendXml(reply, (await currentSitemaps()).index));
  app.get<{ Params: { name: string } }>('/sitemaps/:name', async (request, reply) => {
    const xml = sitemapFile(await currentSitemaps(), String(request.params.name ?? ''));
    return xml === null ? notFoundText(reply) : sendXml(reply, xml);
  });

  return (request, reply, path) => {
    const page =
      (request.method === 'GET' || request.method === 'HEAD') && !/\.[A-Za-z0-9]{1,8}$/.test(path) && acceptsPage(request.headers.accept);
    return page ? send(reply, { kind: 'not_found' }) : notFoundText(reply);
  };
}
