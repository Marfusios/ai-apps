/**
 * The page template (`dist/web/index.html`) and one response's page made from it: the server's
 * head (server/seo/head.ts) in place of the template's `<title>` and description, and the style
 * nonce. The head is put in by concatenation, never through `String.replace`, whose
 * replacement patterns (`$&`, `$'`) would read NTSB text as instructions. The template's theme
 * script is kept as it is (its hash is in the CSP).
 */

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
