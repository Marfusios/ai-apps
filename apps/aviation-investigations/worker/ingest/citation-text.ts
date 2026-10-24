import { decodeHTMLStrict } from 'entities';
import { Parser } from 'htmlparser2';

/**
 * Canonical citation text (amendment A9). Version both constants together with any
 * change to the rules below: stored hashes, passages and quote offsets depend on them.
 *
 * Plain text: unchanged except line ends: CRLF -> LF, then any remaining CR -> LF.
 * The source has `\r\r\n` and lone `\r` cell separators besides CRLF, and a single
 * CRLF pass would turn `\r\r\n` back into a CRLF.
 * Text that looks like HTML (see `looksLikeHtml`): converted by `htmlToText`.
 */
export const CITATION_TEXT_VERSION = 'v1';
/** The brief's name for the same rule set; recorded on ingestion runs. */
export const TEXT_NORMALIZATION_VERSION = CITATION_TEXT_VERSION;

export interface CitationText {
  text: string;
  transformedFromHtml: boolean;
}

/**
 * Conservative detection: an opening or closing p/span/br/div tag, or a
 * semicolon-terminated character reference that decodes to something else. Plain
 * narratives contain `<unintelligible>`, `<insert ...>`, `<http://...>`, `<15 dBZ`,
 * `AT&T` and similar, which must not trigger conversion.
 *
 * Known false positive, kept in v1: `<p` or `<div` followed by whitespace counts as a tag
 * even without a closing `>` ("pressure <p 30.12 in"); such a text is then only trimmed
 * and marked converted. No field of the 2026-10-16 snapshot is flagged by that alone
 * (Task 22 data review D-M8). Requiring the `>` changes the rules: do it in the next
 * citation text version, never within v1.
 */
const HTML_TAG = /<\/?(?:p|span|br|div)(?=[\s/>])/i;
const CHARACTER_REFERENCE = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

export function looksLikeHtml(source: string): boolean {
  if (HTML_TAG.test(source)) return true;
  for (const m of source.matchAll(CHARACTER_REFERENCE)) {
    if (decodeHTMLStrict(m[0]) !== m[0]) return true;
  }
  return false;
}

export function toCitationText(source: string): CitationText {
  if (looksLikeHtml(source)) return { text: htmlToText(source), transformedFromHtml: true };
  return { text: normalizeLineEnds(source), transformedFromHtml: false };
}

/** CRLF and lone CR to LF (`\r\r\n` -> `\n\n`). */
export function normalizeLineEnds(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** Elements whose start or end is a line boundary. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Formatting elements that only wrap text; removing them keeps words joined (`o<span>ne</span>`). */
const INLINE = new Set([
  'abbr', 'b', 'big', 'cite', 'code', 'del', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'o:p', 'q', 's', 'samp',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'tt', 'u', 'var', 'wbr',
]);
const STRAY_CLOSE = /^<\/([A-Za-z][^\s/>]*)\s*>/;

/**
 * Deterministic HTML-to-text with htmlparser2 (v1):
 * - text is kept verbatim (whitespace is not collapsed: mixed narratives carry
 *   plain-text paragraphs around stray markup); semicolon-terminated character
 *   references are decoded, so `&nbsp;` becomes U+00A0;
 * - inline formatting tags are removed without inserting anything;
 * - `<br>` becomes `\n`; a block start or end becomes a single `\n` boundary, and
 *   whitespace-only text between blocks is dropped;
 * - a tag the parser does not treat as known markup (unknown element, a known
 *   element with value-less attributes such as `<a few miles>`, an unmatched
 *   closing tag of an unknown element) stays as literal source text, so no words are
 *   lost; comments, doctype and processing instructions are removed;
 * - line ends are normalized like plain text and leading/trailing ASCII whitespace is trimmed.
 */
export function htmlToText(source: string): string {
  let out = '';
  let pendingBlock = false;
  let textBuffer = '';
  let cursor = 0;
  let valuelessAttribute = false;

  const emit = (content: string): void => {
    if (content === '') return;
    if (pendingBlock) {
      if (/^[ \t\r\n]*$/.test(content)) return;
      if (out !== '' && !out.endsWith('\n')) out += '\n';
      pendingBlock = false;
    }
    out += content;
  };
  const flushText = (): void => {
    if (textBuffer === '') return;
    const text = decodeHTMLStrict(textBuffer);
    textBuffer = '';
    emit(text);
  };
  /** Source kept as written: not entity-decoded. */
  const literal = (raw: string): void => {
    flushText();
    emit(raw);
  };
  const block = (): void => {
    flushText();
    pendingBlock = true;
  };
  const lineBreak = (): void => {
    flushText();
    out += '\n';
    pendingBlock = false;
  };
  /** Source the parser skipped without an event: unmatched closing tags, handled one by one. */
  const gapTo = (start: number): void => {
    if (start <= cursor) return;
    let rest = source.slice(cursor, start);
    cursor = start;
    while (rest !== '') {
      const m = STRAY_CLOSE.exec(rest);
      const name = m?.[1]?.toLowerCase();
      if (!m || name === undefined) {
        literal(rest);
        return;
      }
      if (BLOCK.has(name)) block();
      else if (INLINE.has(name)) flushText();
      else literal(m[0]);
      rest = rest.slice(m[0].length);
    }
  };
  const consume = (start: number, end: number): void => {
    gapTo(start);
    cursor = Math.max(cursor, end + 1);
  };

  const parser: Parser = new Parser(
    {
      onopentagname() {
        valuelessAttribute = false;
      },
      onattribute(_name, _value, quote) {
        if (quote === undefined) valuelessAttribute = true;
      },
      onopentag(name, _attribs, isImplied) {
        if (isImplied) {
          // Implied by an end tag such as `</p>` or `</br>`; that end tag's event consumes the source range.
          gapTo(parser.startIndex);
          if (name === 'br') lineBreak();
          else if (BLOCK.has(name)) block();
          return;
        }
        const start = parser.startIndex;
        const end = parser.endIndex;
        gapTo(start);
        const known = name === 'br' || BLOCK.has(name) || INLINE.has(name);
        if (!known || valuelessAttribute) literal(source.slice(start, end + 1));
        else if (name === 'br') lineBreak();
        else if (BLOCK.has(name)) block();
        else flushText();
        cursor = Math.max(cursor, end + 1);
      },
      onclosetag(name, isImplied) {
        if (isImplied) return;
        const start = parser.startIndex;
        const end = parser.endIndex;
        gapTo(start);
        if (start >= cursor) {
          if (name === 'br') {
            // `</br>`: the implied open already produced the break.
          } else if (BLOCK.has(name)) block();
          else if (INLINE.has(name)) flushText();
          else literal(source.slice(start, end + 1));
        }
        cursor = Math.max(cursor, end + 1);
      },
      ontext(data) {
        gapTo(parser.startIndex);
        textBuffer += data;
        cursor = Math.max(cursor, parser.endIndex + 1);
      },
      oncomment() {
        consume(parser.startIndex, parser.endIndex);
      },
      onprocessinginstruction() {
        consume(parser.startIndex, parser.endIndex);
      },
    },
    { decodeEntities: false, lowerCaseTags: true, recognizeSelfClosing: false },
  );
  parser.write(source);
  parser.end();
  gapTo(source.length);
  flushText();
  return normalizeLineEnds(out).replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}
