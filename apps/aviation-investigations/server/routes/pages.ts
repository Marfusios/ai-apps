/**
 * The web client's pages and what crawlers read about them (README, "Search engines and link
 * previews"). Every page is the SPA's `index.html` with a head built for its route
 * (server/seo/head.ts), a fresh style nonce and the status its route has; the client renders
 * the page itself.
 *
 * - `/`, `/explore`, `/dashboard`, `/about`, `/privacy`, `/compare`, `/account` and
 *   `/briefs/:id` are 200. `/cases/:ntsbNo` is 200 for a case `GET /api/cases/:ntsbNo` serves
 *   (the same lookup, `findCase`) and 404 otherwise, a number too long for the router included.
 *   Any other path without a file extension is the 404 page: the client router shows its
 *   not-found page.
 * - Redirects (301) drop the query string and go to a path built from the route, never taken
 *   from the request: a served case number not in its canonical form to the canonical case
 *   path, a page path with a trailing slash to the path without it, a page path in the wrong
 *   letter case to its own (`/About` to `/about`), and `/index.html` to `/`.
 * - A page goes to GET and HEAD requests whose `Accept` is absent or takes `text/html` or
 *   `*\/*`; anything else, and a path with a file extension no route serves, gets the plain
 *   text 404.
 * - `/cases/:ntsbNo` and the sitemaps read the database, so they are not asset routes
 *   (server/app.ts): they need a network identity and count against the API's rate limit.
 *   A page request that is refused (429) or fails (500, 503) gets the page with that status,
 *   noindex and without a canonical URL (`Pages.failed`), with the `Retry-After` the API would
 *   send; the API and the sitemaps keep the API's `ErrorResponse`.
 * - `/robots.txt` (server/seo/robots.ts) and `/sitemap.xml` with `/sitemaps/{name}`
 *   (server/seo/sitemaps.ts), cached publicly for an hour.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatasetUnavailableError } from '../dataset.js';
import { routerPath, targetQuery } from '../http/request-target.js';
import { contentSecurityPolicy } from '../http/security-headers.js';
import { pageHead, pagePolicy, type PageFailure, type PageRoute } from '../seo/head.js';
import { renderPage, splitTemplate } from '../seo/page-template.js';
import { robotsTxt } from '../seo/robots.js';
import { SitemapStore, readSitemapCases, sitemapFile, type Sitemaps } from '../seo/sitemaps.js';
import { findCase } from './cases.js';
import type { ApiContext } from './context.js';

const paramOf = (request: FastifyRequest, name: string): string => String((request.params as Record<string, string | undefined>)[name] ?? '');
const queryOf = (request: FastifyRequest): URLSearchParams => new URLSearchParams(targetQuery(request.url));

/** The pages whose head needs no database read, by route pattern. */
const STATIC_PAGES: ReadonlyMap<string, (request: FastifyRequest) => PageRoute> = new Map<string, (request: FastifyRequest) => PageRoute>([
  ['/', () => ({ kind: 'home' })],
  ['/explore', (request) => ({ kind: 'explore', query: queryOf(request) })],
  ['/dashboard', () => ({ kind: 'dashboard' })],
  ['/about', () => ({ kind: 'about' })],
  ['/privacy', () => ({ kind: 'privacy' })],
  ['/compare', (request) => ({ kind: 'compare', query: queryOf(request) })],
  ['/account', () => ({ kind: 'account' })],
  ['/briefs/:id', (request) => ({ kind: 'brief', id: paramOf(request, 'id') })],
]);

/** Read from the database: rate limited like the API. */
export const CASE_PAGE_ROUTE = '/cases/:ntsbNo';
/** The template file is never served as it is (it has no style nonce): it redirects to `/`. */
export const INDEX_FILE_ROUTE = '/index.html';
export const ROBOTS_ROUTE = '/robots.txt';
/** Pages anyone may load without a network identity or the rate limit (server/app.ts `ASSET_ROUTES`). */
export const PUBLIC_PAGE_ROUTES: readonly string[] = [...STATIC_PAGES.keys(), INDEX_FILE_ROUTE];

/** Page paths of one segment (`/about`), and the pages with one parameter (`/cases/X`, `/briefs/X`). */
const ONE_SEGMENT_PAGES: ReadonlySet<string> = new Set(['explore', 'dashboard', 'about', 'privacy', 'compare', 'account']);
const PARAMETER_PAGES: ReadonlySet<string> = new Set(['cases', 'briefs']);

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

export interface Pages {
  /** The not-found handler's answer to a path outside the API (`path` as the router sees it). */
  notFound(request: FastifyRequest, reply: FastifyReply, path: string): FastifyReply;
  /**
   * A page request that was refused (429) or failed (500, 503), as the page with that status;
   * null for any other request, which gets the API's `ErrorResponse`.
   */
  failed(request: FastifyRequest, reply: FastifyReply, failure: PageFailure): FastifyReply | null;
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

const wantsPage = (request: FastifyRequest): boolean =>
  (request.method === 'GET' || request.method === 'HEAD') && acceptsPage(request.headers.accept);

const hasTrailingSlash = (path: string): boolean => path.length > 1 && path.endsWith('/');

/**
 * `path` without its trailing slashes, in linear time: a regex such as `/\/+$/` backtracks
 * quadratically over a long run of slashes followed by another character.
 */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/**
 * What a page path the router did not match is (`path` as the router sees it): a page path in
 * the wrong letter case redirects to its own; a case or brief whose parameter is too long for
 * the router is that page (a case with such a number is not served); null for anything else.
 */
export function unmatchedPage(path: string): { redirect: string } | { route: PageRoute } | null {
  const segments = withoutTrailingSlashes(path).split('/').slice(1);
  const [first = '', param = ''] = segments;
  const page = first.toLowerCase();
  if (segments.length === 1 && ONE_SEGMENT_PAGES.has(page) && first !== page) return { redirect: `/${page}` };
  if (segments.length !== 2 || !PARAMETER_PAGES.has(page) || param === '') return null;
  if (first !== page) return { redirect: `/${page}/${encodeURIComponent(param)}` };
  return { route: page === 'cases' ? { kind: 'missing_case', requested: param } : { kind: 'brief', id: param } };
}

/** The page a request's matched route serves (a case page without its record), or null. */
function pageRouteOf(request: FastifyRequest): PageRoute | null {
  const pattern = request.routeOptions.url;
  if (pattern === CASE_PAGE_ROUTE) return { kind: 'missing_case', requested: paramOf(request, 'ntsbNo') };
  const routeOf = pattern === undefined ? undefined : STATIC_PAGES.get(pattern);
  return routeOf ? routeOf(request) : null;
}

/** Registers the pages, robots.txt and the sitemaps when there is a web client. */
export function pageRoutes(app: FastifyInstance, ctx: ApiContext, opts: PageOptions): Pages {
  if (opts.template === null) return { notFound: (_request, reply) => notFoundText(reply), failed: () => null };
  const template = splitTemplate(opts.template);

  const send = (reply: FastifyReply, route: PageRoute, failure?: PageFailure): FastifyReply => {
    // Base64 of random bytes: no character that could leave the attribute value.
    const nonce = randomBytes(18).toString('base64');
    const html = renderPage(template, pageHead(route, opts.origin, failure), nonce);
    return reply
      .code(pagePolicy(route, failure).status)
      .header('content-security-policy', contentSecurityPolicy({ styleNonce: nonce, turnstile: opts.turnstile }))
      .header('cache-control', failure === undefined ? 'no-cache' : 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);
  };

  for (const [pattern, routeOf] of STATIC_PAGES) {
    app.get(pattern, async (request, reply) => {
      if (!acceptsPage(request.headers.accept)) return notFoundText(reply);
      const route = routeOf(request);
      const canonical = pagePolicy(route).canonicalPath;
      if (canonical !== null && hasTrailingSlash(routerPath(request.url))) return reply.redirect(canonical, 301);
      return send(reply, route);
    });
  }

  app.get(INDEX_FILE_ROUTE, async (request, reply) => (acceptsPage(request.headers.accept) ? reply.redirect('/', 301) : notFoundText(reply)));

  app.get<{ Params: { ntsbNo: string } }>(CASE_PAGE_ROUTE, async (request, reply) => {
    if (!acceptsPage(request.headers.accept)) return notFoundText(reply);
    const requested = String(request.params.ntsbNo ?? '');
    // A dataset or database that is unavailable throws: the error handler sends `failed` (503).
    const found = await findCase(ctx, requested, request.log);
    if (found === 'invalid') return send(reply, { kind: 'missing_case', requested }, 500);
    if (found === null) return send(reply, { kind: 'missing_case', requested });
    if (requested !== found.detail.ntsbNo || hasTrailingSlash(routerPath(request.url))) return reply.redirect(`/cases/${found.detail.ntsbNo}`, 301);
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

  return {
    notFound(request, reply, path) {
      if (!wantsPage(request) || /\.[A-Za-z0-9]{1,8}$/.test(path)) return notFoundText(reply);
      const page = unmatchedPage(path);
      if (page === null) return send(reply, { kind: 'not_found' });
      if ('redirect' in page) return reply.redirect(page.redirect, 301);
      const canonical = pagePolicy(page.route).canonicalPath;
      if (canonical !== null && hasTrailingSlash(path)) return reply.redirect(canonical, 301);
      return send(reply, page.route);
    },
    failed(request, reply, failure) {
      if (!wantsPage(request)) return null;
      const route = pageRouteOf(request);
      if (route === null) return null;
      try {
        return send(reply, route, failure);
      } catch {
        // Building the page failed too (`send` changes the reply only once it has the page).
        return null;
      }
    },
  };
}
