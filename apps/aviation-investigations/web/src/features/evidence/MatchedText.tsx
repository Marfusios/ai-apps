import { Fragment, type ReactNode } from 'react';
import type { EvidenceExcerpt } from '../../../../shared/contracts/evidence';
import { cx } from '../../lib/cx';
import { LEGEND, type MarkedWords } from './display';

type Highlight = EvidenceExcerpt['highlights'][number];

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** True when `at` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));
}

/**
 * The marks of `highlights` in `text`: offsets are UTF-16 code units, as JavaScript strings
 * index, sorted and non-overlapping (the contract refuses anything else). An edge inside a
 * surrogate pair is widened to the whole character, so a mark never cuts an astral character
 * in half; a mark that would then overlap the previous one is left out.
 */
export function markRanges(text: string, highlights: readonly Highlight[]): Highlight[] {
  const out: Highlight[] = [];
  let at = 0;
  for (const h of highlights) {
    const start = splitsPair(text, h.start) ? h.start - 1 : h.start;
    const end = splitsPair(text, h.end) ? h.end + 1 : Math.min(h.end, text.length);
    if (start < at || start >= end) continue;
    out.push({ start, end, match: h.match });
    at = end;
  }
  return out;
}

/**
 * NTSB text with the search's matches marked (UI_DESIGN §4.9), rendered as text, never as
 * markup: a literal occurrence of a search word as `hit` (wash and solid underline), a synonym
 * match as `hit-synonym` (dotted underline, no wash, and " (synonym)" for screen readers), so
 * the two never differ by colour alone.
 */
export function MatchedText({ text, highlights }: { text: string; highlights: readonly Highlight[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  markRanges(text, highlights).forEach((h, i) => {
    if (h.start > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, h.start)}</Fragment>);
    parts.push(
      h.match === 'synonym' ? (
        <mark key={`m${i}`} className="hit-synonym" data-match="synonym">
          {text.slice(h.start, h.end)}
          {/* Heard, never copied with a selection of the text. */}
          <span className="sr-only select-none"> (synonym)</span>
        </mark>
      ) : (
        <mark key={`m${i}`} className="hit" data-match="literal">
          {text.slice(h.start, h.end)}
        </mark>
      ),
    );
    at = h.end;
  });
  if (at < text.length) parts.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

/**
 * The key to the marks: "Marked in the excerpts: the suggested terms · their synonyms" (or "your
 * words"), the synonyms dotted. The suggestion's terms when the search has one (contract
 * `evidence.v2`), never said as the reader's.
 */
export function MatchLegend({ marked, className }: { marked: MarkedWords; className?: string }) {
  return (
    <p className={cx('text-meta text-muted', className)} data-legend={marked}>
      Marked in the excerpts: <mark className="hit">{marked === 'suggested' ? LEGEND.suggested : LEGEND.yours}</mark>
      <span aria-hidden="true"> · </span>
      <span className="sr-only">; dotted: </span>
      <mark className="hit-synonym">{LEGEND.synonym}</mark>
    </p>
  );
}
