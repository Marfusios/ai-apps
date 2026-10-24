/**
 * The head of every page the server sends (README, "Search engines and link previews"): per
 * route its status, robots and canonical URL (`pagePolicy`), its title (the shared one the
 * client renders, shared/page-titles.ts), its description, Open Graph and Twitter tags with the
 * share image, and JSON-LD: a `WebSite` for the home page and a `BreadcrumbList` for a case.
 * Pure: the page routes (server/routes/pages.ts) resolve the route and read its data, and
 * server/seo/page-template.ts puts the head into the page.
 *
 * NTSB text is untrusted. Every value is escaped for its HTML context; JSON-LD is serialized
 * with `<`, `>`, `&`, U+2028 and U+2029 escaped, so no text can end its script element.
 *
 * Descriptions are plain text by fixed rules, never by AI: fixed ones for the pages without
 * data of their own (shared/brand.ts), one built from its record for a case
 * (server/seo/case-description.ts), and the API's own message for a page that could not be
 * served (a refusal or a failure: 429, 500, 503), which is never indexed.
 */
import { PAGE_DESCRIPTIONS, PRODUCT_NAME, PRODUCT_TAGLINE, SHARE_IMAGE, SITE_DESCRIPTION } from '../../shared/brand.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { readCompare, readSearchRequest } from '../../shared/page-params.js';
import { pageTitle, type TitledPage } from '../../shared/page-titles.js';
import { ERROR_MESSAGES } from '../http/reply.js';
import { caseDescription } from './case-description.js';

/** A page the server sends, with what its head is built from. */
export type PageRoute =
  | { kind: 'home' | 'dashboard' | 'about' | 'privacy' | 'account' | 'not_found' }
  /** `query`: the page's query string (Explore's title and robots, Compare's title). */
  | { kind: 'explore' | 'compare'; query: URLSearchParams }
  | { kind: 'brief'; id: string }
  /** A case that `GET /api/cases/:ntsbNo` serves. */
  | { kind: 'case'; detail: CaseDetail }
  /**
   * A case page without its record, `requested` as the path gave it: a number no case has
   * (404), or, with a failure, one that could not be read.
   */
  | { kind: 'missing_case'; requested: string };

/** A page request that was refused (429) or failed (500, 503): the page goes out with that status. */
export type PageFailure = 429 | 500 | 503;

export interface PagePolicy {
  status: 200 | 404 | PageFailure;
  robots: string;
  /** Path of the canonical URL on APP_URL's origin; null for a page that is not found or not served. */
  canonicalPath: string | null;
}

const INDEX = 'index, follow';

/** Status, robots and canonical URL per route (README, "Search engines and link previews"). */
export function pagePolicy(route: PageRoute, failure?: PageFailure): PagePolicy {
  if (failure !== undefined) return { status: failure, robots: 'noindex', canonicalPath: null };
  switch (route.kind) {
    case 'home':
      return { status: 200, robots: INDEX, canonicalPath: '/' };
    case 'explore':
      // A search, a filter or an open case is a view of Explore, not a page of its own.
      return { status: 200, robots: route.query.size > 0 ? 'noindex, follow' : INDEX, canonicalPath: '/explore' };
    case 'dashboard':
    case 'about':
    case 'privacy':
      return { status: 200, robots: INDEX, canonicalPath: `/${route.kind}` };
    case 'compare':
    case 'account':
      return { status: 200, robots: 'noindex, nofollow', canonicalPath: `/${route.kind}` };
    case 'brief':
      return { status: 200, robots: 'noindex, nofollow', canonicalPath: `/briefs/${encodeURIComponent(route.id)}` };
    case 'case':
      return { status: 200, robots: INDEX, canonicalPath: `/cases/${route.detail.ntsbNo}` };
    case 'missing_case':
    case 'not_found':
      return { status: 404, robots: 'noindex', canonicalPath: null };
  }
}

/** The shared title's input for a route: Explore and Compare read their query strings as the client does. */
function titledPage(route: PageRoute): TitledPage {
  switch (route.kind) {
    case 'explore':
      return { kind: 'explore', q: readSearchRequest(route.query).q };
    case 'compare':
      return { kind: 'compare', count: readCompare(route.query).length };
    case 'case':
      return { kind: 'case', ntsbNo: route.detail.ntsbNo, detail: route.detail };
    case 'missing_case':
      // The case page titles the number from its path while nothing is shown (web/src/pages/CasePage.tsx).
      return { kind: 'case', ntsbNo: route.requested.toUpperCase(), detail: null };
    default:
      return { kind: route.kind };
  }
}

function descriptionOf(route: PageRoute): string {
  switch (route.kind) {
    case 'home':
      return SITE_DESCRIPTION;
    case 'case':
      return caseDescription(route.detail);
    case 'missing_case':
      return PAGE_DESCRIPTIONS.missingCase;
    case 'not_found':
      return PAGE_DESCRIPTIONS.notFound;
    default:
      return PAGE_DESCRIPTIONS[route.kind];
  }
}

/** What a page that could not be served says: the API's message for the same refusal or failure. */
const FAILURE_DESCRIPTIONS: Readonly<Record<PageFailure, string>> = {
  429: ERROR_MESSAGES.rate_limited,
  500: ERROR_MESSAGES.internal,
  503: ERROR_MESSAGES.unavailable,
};

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/** JSON for a `<script type="application/ld+json">` element: no `<`, `>`, `&`, U+2028 or U+2029 left as is. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function structuredData(route: PageRoute, origin: string): Record<string, unknown> | null {
  if (route.kind === 'home') {
    return { '@context': 'https://schema.org', '@type': 'WebSite', name: PRODUCT_NAME, alternateName: PRODUCT_TAGLINE, url: `${origin}/` };
  }
  if (route.kind === 'case') {
    const crumbs: ReadonlyArray<readonly [string, string]> = [
      [PRODUCT_NAME, `${origin}/`],
      ['Explore', `${origin}/explore`],
      [route.detail.ntsbNo, `${origin}/cases/${route.detail.ntsbNo}`],
    ];
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
    };
  }
  return null;
}

const meta = (attribute: 'name' | 'property', key: string, content: string): string =>
  `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;

/** " · AirCase": what a shared title drops (the home page's long name has no such ending). */
const PRODUCT_SUFFIX = ` · ${PRODUCT_NAME}`;

/**
 * The head elements of a page on `origin` (APP_URL's origin), one per line. With a `failure`
 * the page keeps its title, says the failure's message, is noindex and has no canonical URL
 * and no JSON-LD.
 */
export function pageHead(route: PageRoute, origin: string, failure?: PageFailure): string {
  const policy = pagePolicy(route, failure);
  const title = pageTitle(titledPage(route));
  const shareTitle = title.endsWith(PRODUCT_SUFFIX) ? title.slice(0, -PRODUCT_SUFFIX.length) : title;
  const description = failure === undefined ? descriptionOf(route) : FAILURE_DESCRIPTIONS[failure];
  const canonical = policy.canonicalPath === null ? null : `${origin}${policy.canonicalPath}`;
  const image = `${origin}${SHARE_IMAGE.path}`;
  const data = failure === undefined ? structuredData(route, origin) : null;
  return [
    `<title>${escapeHtml(title)}</title>`,
    meta('name', 'description', description),
    meta('name', 'robots', policy.robots),
    ...(canonical === null ? [] : [`<link rel="canonical" href="${escapeHtml(canonical)}" />`]),
    meta('property', 'og:site_name', PRODUCT_NAME),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', shareTitle),
    meta('property', 'og:description', description),
    ...(canonical === null ? [] : [meta('property', 'og:url', canonical)]),
    meta('property', 'og:locale', 'en_US'),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', String(SHARE_IMAGE.width)),
    meta('property', 'og:image:height', String(SHARE_IMAGE.height)),
    meta('property', 'og:image:alt', SHARE_IMAGE.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', shareTitle),
    meta('name', 'twitter:description', description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', SHARE_IMAGE.alt),
    ...(data === null ? [] : [`<script type="application/ld+json">${jsonLd(data)}</script>`]),
  ].join('\n    ');
}
