/**
 * The head of every page the server sends (README, "Search engines and link previews"): per
 * route its status, robots and canonical URL (`pagePolicy`), its title (the shared one the
 * client renders, shared/page-titles.ts), its description, Open Graph and Twitter tags with the
 * share image, and JSON-LD: a `WebSite` for the home page and a `BreadcrumbList` for a case.
 * Pure: the page routes (server/routes/pages.ts) resolve the route and read its data.
 *
 * NTSB text is untrusted. Every value is escaped for its HTML context; JSON-LD is serialized
 * with `<`, `>`, `&`, U+2028 and U+2029 escaped, so no text can end its script element. The
 * head goes into the template by concatenation, never through `String.replace`, whose
 * replacement patterns (`$&`, `$'`) would read the text as instructions.
 *
 * Descriptions are plain text built by fixed rules, never by AI: the pages without data of
 * their own have fixed ones (shared/brand.ts); a case's is built from its record
 * (`caseDescription`).
 */
import { PAGE_DESCRIPTIONS, PRODUCT_NAME, PRODUCT_TAGLINE, SHARE_IMAGE, SITE_DESCRIPTION } from '../../shared/brand.js';
import { aircraftName } from '../../shared/case-view.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import type { Coded } from '../../shared/contracts/common.js';
import { formatDate } from '../../shared/format.js';
import { readCompare, readSearchRequest } from '../../shared/page-params.js';
import { pageTitle, type TitledPage } from '../../shared/page-titles.js';
import { EVENT_TYPE } from '../../shared/vocab.js';

/** A page the server sends, with what its head is built from. */
export type PageRoute =
  | { kind: 'home' | 'dashboard' | 'about' | 'privacy' | 'account' | 'not_found' }
  /** `query`: the page's query string (Explore's title and robots, Compare's title). */
  | { kind: 'explore' | 'compare'; query: URLSearchParams }
  | { kind: 'brief'; id: string }
  /** A case that `GET /api/cases/:ntsbNo` serves. */
  | { kind: 'case'; detail: CaseDetail }
  /** `/cases/:ntsbNo` with a number no case has: `requested` as the path gave it. */
  | { kind: 'missing_case'; requested: string };

export interface PagePolicy {
  status: 200 | 404;
  robots: string;
  /** Path of the canonical URL on APP_URL's origin; null for a page that is not found. */
  canonicalPath: string | null;
}

const INDEX = 'index, follow';

/** Status, robots and canonical URL per route (README, "Search engines and link previews"). */
export function pagePolicy(route: PageRoute): PagePolicy {
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

// ---------------------------------------------------------------------------
// A case's description

export const MAX_CASE_DESCRIPTION = 200;

/** Plain text on one line: control characters dropped, whitespace runs as one space. */
function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}

/** "accident", "incident", "occurrence"; nothing for an unknown or unreported type. */
function eventTypeWord(type: Coded): string {
  const code = type.code ?? '';
  return code !== 'UNK' && Object.hasOwn(EVENT_TYPE, code) ? type.label.toLowerCase() : '';
}

/** "N66372 (Hughes OH-6)"; the aircraft name alone when no registration is recorded. */
function aircraftWords(a: CaseDetail['aircraft'][number]): string {
  const registration = (a.registration ?? '').trim();
  return registration ? `${registration} (${aircraftName(a)})` : aircraftName(a);
}

/**
 * The most serious injury: "3 fatal", "serious injuries", "minor injuries", "no injuries".
 * "No injuries" only when every count is recorded as zero; with a count missing it says what
 * the case page says (web/src/features/case/display.ts `injurySummary`): the coded highest
 * injury, or that injuries are not reported.
 */
export function injuryPhrase(detail: Pick<CaseDetail, 'injuries' | 'highestInjury'>): string {
  const { fatal, serious, minor } = detail.injuries;
  if (fatal !== null && fatal > 0) return `${fatal} fatal`;
  if (serious !== null && serious > 0) return 'serious injuries';
  if (minor !== null && minor > 0) return 'minor injuries';
  if (fatal === 0 && serious === 0 && minor === 0) return 'no injuries';
  return detail.highestInjury.code ? `highest injury: ${detail.highestInjury.label.toLowerCase()}` : 'injuries not reported';
}

/** The raw NTSB status as the case page shows it ("NTSB status: P"), "blank" when there is none. */
function rawStatusLabel(rawStatus: string | null): string {
  const raw = (rawStatus ?? '').trim();
  return raw === '' ? 'blank' : raw;
}

/**
 * `text` within `max` characters (code points): when it is longer, cut after the last whole
 * word that leaves room for "…", without the punctuation before the cut, and "…" added.
 */
export function truncateAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const room = max - 1;
  let end = room;
  // Unless the text breaks between words exactly there, go back to the last space.
  if (chars[room] !== ' ') {
    const space = chars.lastIndexOf(' ', room - 1);
    if (space > 0) end = space;
  }
  return `${chars.slice(0, end).join('').replace(/[\s,;:.!?–—-]+$/u, '')}…`;
}

/**
 * "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries.
 * Probable cause: …", or "Status: P" (the raw NTSB status) for a record without
 * probable-cause text; cut at a word to 200 characters. An unknown event type, a missing date
 * and a missing registration are left out.
 */
export function caseDescription(detail: CaseDetail): string {
  const opening = ['NTSB', eventTypeWord(detail.eventType), 'investigation', detail.ntsbNo].filter((w) => w !== '').join(' ');
  const when = detail.date ? `, ${formatDate(detail.date)}` : '';
  const aircraft = detail.aircraft.length === 0 ? 'Unidentified aircraft' : detail.aircraft.map(aircraftWords).join(' and ');
  const cause = plain(
    detail.sections
      .filter((s) => s.kind === 'probable_cause')
      .map((s) => s.text)
      .join(' '),
  );
  const ending = cause ? `Probable cause: ${cause}` : `Status: ${rawStatusLabel(detail.completion.rawStatus)}`;
  return truncateAtWord(plain(`${opening}${when}: ${aircraft}, ${injuryPhrase(detail)}. ${ending}`), MAX_CASE_DESCRIPTION);
}

// ---------------------------------------------------------------------------
// The head

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

/** The head elements of a page on `origin` (APP_URL's origin), one per line. */
export function pageHead(route: PageRoute, origin: string): string {
  const policy = pagePolicy(route);
  const title = pageTitle(titledPage(route));
  const shareTitle = title.endsWith(PRODUCT_SUFFIX) ? title.slice(0, -PRODUCT_SUFFIX.length) : title;
  const description = descriptionOf(route);
  const canonical = policy.canonicalPath === null ? null : `${origin}${policy.canonicalPath}`;
  const image = `${origin}${SHARE_IMAGE.path}`;
  const data = structuredData(route, origin);
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

// ---------------------------------------------------------------------------
// The page template (`dist/web/index.html`)

/** The template cut where the server's head goes: in place of its `<title>`, without its description. */
export interface PageTemplate {
  /** Up to the template's `<title>` (or its `</head>` when it has none). */
  before: string;
  /** From after the `<title>` up to `</head>`. */
  middle: string;
  /** From `</head>` on (empty when the template has none). */
  after: string;
}

const DESCRIPTION_META = /[ \t]*<meta\s[^>]*\bname=["']description["'][^>]*>[ \t]*(?:\r?\n)?/i;
const TITLE_ELEMENT = /<title\b[^>]*>[\s\S]*?<\/title>/i;

/** Splits the template once, at startup. */
export function splitTemplate(template: string): PageTemplate {
  const page = template.replace(DESCRIPTION_META, '');
  const headEnd = page.indexOf('</head>');
  const close = headEnd < 0 ? page.length : headEnd;
  const title = TITLE_ELEMENT.exec(page);
  const inHead = title !== null && title.index < close;
  const start = inHead ? title.index : close;
  const resume = inHead ? title.index + title[0].length : close;
  return { before: page.slice(0, start), middle: page.slice(resume, close), after: page.slice(close) };
}

/**
 * One response's page: the template with `head` in place of its title and description, and
 * the style nonce as `<meta property="csp-nonce">` before `</head>` (server/http/security-headers.ts).
 */
export function renderPage(template: PageTemplate, head: string, nonce: string): string {
  const nonceMeta = template.after.startsWith('</head>') ? `<meta property="csp-nonce" nonce="${nonce}">` : '';
  return template.before + head + template.middle + nonceMeta + template.after;
}
