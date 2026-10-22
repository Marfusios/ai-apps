/**
 * Result-row snippets (UI_DESIGN §4.2): an excerpt of one narrative section with the
 * matched terms as UTF-16 offsets, never markup. The API builds them from
 * Elasticsearch highlights and the mock API from its stand-in matcher; both use these
 * functions, so windows, ellipses and merged marks are the same.
 */
import { SECTION_LABEL, type SectionKind, type Snippet } from './contracts/search.js';

export interface Span {
  start: number;
  end: number;
}

/** A whole section up to this length is shown as is (probable cause). */
const SNIPPET_FULL = 600;
/** Otherwise a window of about this length around the first mark. */
const SNIPPET_WINDOW = 360;
/** Context kept before the first mark. */
const SNIPPET_LEAD = 110;
/** Preview of the probable cause when there is no query. */
const PLAIN_PREVIEW = 320;
/** Contract limits (SnippetSchema). */
const MAX_TEXT = 1200;
const MAX_HIGHLIGHTS = 60;

/** Newlines and tabs become spaces one for one, so offsets stay valid. */
export function flatten(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ');
}

function wordStart(text: string, i: number): number {
  if (i <= 0) return 0;
  const space = text.lastIndexOf(' ', i);
  return space === -1 ? 0 : space + 1;
}

function wordEnd(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const space = text.indexOf(' ', i);
  return space === -1 ? text.length : space;
}

/**
 * Sorted, non-overlapping spans: overlapping spans and spans separated only by spaces
 * or tabs in `text` merge, so "carburetor icing" is one mark.
 */
export function mergeSpans(spans: readonly Span[], text: string): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && (span.start <= last.end || /^[ \t]+$/.test(text.slice(last.end, span.start)))) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * An excerpt of `sectionText` around its first mark. `full`: show the whole section
 * when it is short (the probable cause). Marks outside the window are dropped.
 */
export function excerptSnippet(kind: SectionKind, sectionText: string, spans: readonly Span[], full: boolean): Snippet {
  const text = flatten(sectionText);
  let start = 0;
  let end = text.length;
  if (!full || text.length > SNIPPET_FULL) {
    const anchor = spans[0]?.start ?? 0;
    start = wordStart(text, Math.max(0, anchor - SNIPPET_LEAD));
    end = wordEnd(text, Math.min(text.length, start + SNIPPET_WINDOW));
  }
  // A window without spaces (a long token) is cut at the contract limit.
  if (end - start > MAX_TEXT) end = start + MAX_TEXT;
  if (end > start && end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  // Trim surrounding spaces inside the window without moving the offsets' base.
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  const first = text.length - text.trimStart().length;
  const last = text.trimEnd().length;
  const highlights = spans
    .filter((s) => s.start >= start && s.end <= end)
    .slice(0, MAX_HIGHLIGHTS)
    .map((s) => ({ start: s.start - start, end: s.end - start }));
  return {
    section: kind,
    label: SECTION_LABEL[kind],
    text: text.slice(start, end),
    highlights,
    truncatedStart: start > first,
    truncatedEnd: end < last,
  };
}

/** The probable-cause preview shown when there is no query: no marks. */
export function previewSnippet(probableCause: string): Snippet | null {
  const text = flatten(probableCause).trim();
  if (text === '') return null;
  let cut = text.length > PLAIN_PREVIEW ? wordEnd(text, PLAIN_PREVIEW) : text.length;
  if (cut > MAX_TEXT) cut = MAX_TEXT;
  if (cut < text.length && /[\uD800-\uDBFF]/.test(text.charAt(cut - 1))) cut--;
  return {
    section: 'probable_cause',
    label: SECTION_LABEL.probable_cause,
    text: text.slice(0, cut),
    highlights: [],
    truncatedStart: false,
    truncatedEnd: cut < text.length,
  };
}
