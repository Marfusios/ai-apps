import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CaseDetail } from '../../../../shared/contracts/cases';
import type { EvidenceExcerpt } from '../../../../shared/contracts/evidence';
import type { AircraftBrief } from '../../../../shared/contracts/search';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { evidenceCaseQuery } from './api';
import {
  EXCERPT_END,
  EXCERPT_START,
  FULL_SECTION_CHANGED,
  FULL_SECTION_FAILED,
  FULL_SECTION_GONE,
  excerptLabel,
  fullSectionLabel,
  fullSectionShown,
} from './display';
import { MatchedText } from './MatchedText';

interface Span {
  start: number;
  end: number;
}

/** Where an excerpt's paragraph is in the case's current section text. */
export type Located =
  /** The section, with the excerpt's paragraph at `span` (its stored offsets, or found again verbatim once). */
  | { kind: 'marked'; text: string; span: Span }
  /** The section's text changed and the paragraph is not in it once, verbatim: shown unmarked. */
  | { kind: 'changed'; text: string }
  /** The case no longer has that section. */
  | { kind: 'gone' };

/**
 * The excerpt in the case's canonical section, as the search's own generation has it
 * (`GET /api/evidence/:id/cases/:ntsbNo`): at its `paragraph` offsets when the section is the
 * revision the excerpt names and the slice is the excerpt; otherwise where the same text occurs
 * exactly once; otherwise not marked.
 */
export function locateExcerpt(detail: Pick<CaseDetail, 'sections'>, excerpt: Pick<EvidenceExcerpt, 'sectionKey' | 'revision' | 'paragraph' | 'text'>): Located {
  const section = detail.sections.find((s) => s.key === excerpt.sectionKey);
  if (!section) return { kind: 'gone' };
  const { start, end } = excerpt.paragraph;
  if (section.revision === excerpt.revision && section.text.slice(start, end) === excerpt.text) return { kind: 'marked', text: section.text, span: { start, end } };
  const at = section.text.indexOf(excerpt.text);
  if (at >= 0 && section.text.indexOf(excerpt.text, at + 1) < 0) return { kind: 'marked', text: section.text, span: { start: at, end: at + excerpt.text.length } };
  return { kind: 'changed', text: section.text };
}

const HEADING_LINE = /^[A-Z0-9 ,.'’&/()-]{4,60}$/;

/** Section text outside the excerpt: one paragraph per line, all-caps lines as small headings; text only. */
function Context({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p, i) =>
          HEADING_LINE.test(p) && /[A-Z]{3}/.test(p) ? (
            <p key={i} className="pt-1 font-sans text-micro font-bold tracking-caps text-muted">
              {p}
            </p>
          ) : (
            <p key={i}>{p}</p>
          ),
        )}
    </>
  );
}

/** How a full section ended up once read: marked at the excerpt, changed, gone, or not loaded. */
export type FullSectionState = Located['kind'] | 'failed';

/**
 * "Show the full section" (UI_DESIGN §4.9; Astra's condition 2): the canonical section text at
 * the search's own generation (never the public case, which may be newer), opened at the
 * excerpt's paragraph, which is marked (ink on a blue rule, the context muted) and keeps the
 * search's highlights. Opened by the reader (`focus`), it scrolls the paragraph into view and
 * gives it focus once, so the reader is where the excerpt was, now with the text around it;
 * focus never moves otherwise. `onSettled` says how it ended, for the announcement.
 */
function FullSection({
  searchId,
  ntsbNo,
  excerpt,
  id,
  focus,
  onSettled,
}: {
  searchId: string;
  ntsbNo: string;
  excerpt: EvidenceExcerpt;
  id: string;
  focus: boolean;
  onSettled: (state: FullSectionState) => void;
}) {
  const query = useQuery(evidenceCaseQuery(searchId, ntsbNo));
  const marked = useRef<HTMLParagraphElement>(null);
  const located = query.data ? locateExcerpt(query.data, excerpt) : null;
  const settled: FullSectionState | null = located ? located.kind : query.isError ? 'failed' : null;
  // Focus moves once, and only because the reader opened this section.
  const wantFocus = useRef(focus);
  useEffect(() => {
    if (settled) onSettled(settled);
    if (settled !== 'marked' || !wantFocus.current) return;
    wantFocus.current = false;
    marked.current?.scrollIntoView?.({ block: 'center' });
    marked.current?.focus({ preventScroll: true });
  }, [settled, onSettled]);

  let body: ReactNode;
  if (!located) {
    body = query.isError ? (
      <p className="text-meta text-muted">
        {FULL_SECTION_FAILED}{' '}
        <button type="button" onClick={() => void query.refetch()} className="cursor-pointer text-blue hover:underline pointer-coarse:min-h-11">
          Try again
        </button>
      </p>
    ) : (
      <div aria-hidden="true" className="space-y-2">
        <div className="h-3 w-11/12 rounded-[2px] bg-tint" />
        <div className="h-3 w-4/5 rounded-[2px] bg-tint opacity-70" />
      </div>
    );
  } else if (located.kind === 'gone') {
    body = <p className="text-meta text-muted">{FULL_SECTION_GONE}</p>;
  } else if (located.kind === 'changed') {
    body = (
      <>
        <p className="font-sans text-meta text-muted">{FULL_SECTION_CHANGED}</p>
        <Context text={located.text} />
      </>
    );
  } else {
    // The search's highlights are offsets into the excerpt, which is exactly this paragraph.
    const same = located.text.slice(located.span.start, located.span.end) === excerpt.text;
    body = (
      <>
        <Context text={located.text.slice(0, located.span.start)} />
        <p
          ref={marked}
          tabIndex={-1}
          data-excerpt-paragraph=""
          className="scroll-mt-16 border-l-2 border-blue pl-[11px] whitespace-pre-line text-ink outline-none focus-visible:outline-2"
        >
          <span className="sr-only select-none">{EXCERPT_START} </span>
          {same ? <MatchedText text={excerpt.text} highlights={excerpt.highlights} /> : located.text.slice(located.span.start, located.span.end)}
          <span className="sr-only select-none"> {EXCERPT_END}</span>
        </p>
        <Context text={located.text.slice(located.span.end)} />
      </>
    );
  }
  return (
    <div id={id} data-full-section={excerpt.sectionKey} className="space-y-2 font-serif text-body leading-[1.55] text-muted">
      {body}
    </div>
  );
}

/** Text longer than this is collapsed on a card until opened (never cut: it is all there, and all of it prints). */
export const LONG_TEXT_CHARS = 3_000;

/**
 * A whole paragraph that is too long for a card (the contract allows up to 200,000 characters):
 * collapsed under a fade, one click from all of it, with its length in words. The text is all
 * in the page, so a screen reader reads it whole, and print shows it whole.
 */
export function LongText({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (text.length <= LONG_TEXT_CHARS) return <>{children}</>;
  const words = text.trim().split(/\s+/).length;
  return (
    <>
      <div id={id} data-long-text={open ? 'open' : 'closed'} className={cx('relative', !open && 'max-h-[19rem] overflow-hidden')}>
        {children}
        {!open && <div aria-hidden="true" data-print="hide" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-raised" />}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        data-print="hide"
        onClick={() => setOpen(!open)}
        className="mt-1 block cursor-pointer text-meta text-blue hover:underline pointer-coarse:min-h-11"
      >
        {open ? 'Show less of this paragraph' : `Show the whole paragraph (${formatCount(words)} words)`}
      </button>
    </>
  );
}

export interface ExcerptProps {
  /** The search the excerpt belongs to: its full sections come from it. */
  searchId: string;
  ntsbNo: string;
  aircraft: readonly Pick<AircraftBrief, 'aircraftKey' | 'aircraftNtsbNo' | 'make' | 'model'>[];
  excerpt: EvidenceExcerpt;
  /** The case shows more than one section of this kind: say which ("TEXT 2"). */
  numbered?: boolean;
  /** Its place among the case's excerpts shown, so each "Show the full … section" has a name of its own. */
  position?: { index: number; count: number };
}

/**
 * One excerpt (UI_DESIGN §4.9): a whole paragraph of NTSB text, never cut, its line breaks kept
 * (a paragraph can carry the heading line above it), under its section label and scope, with the
 * search's matches marked; "Show the full section" opens the section around it in place, says
 * how that went in a polite live region, and "Show the excerpt only" closes it again. State is
 * this excerpt's own: keyed by case, section and offset wherever it is listed.
 */
export function Excerpt({ searchId, ntsbNo, aircraft, excerpt, numbered = false, position }: ExcerptProps) {
  // Open, and whether the reader just opened it (only then does it take focus).
  const [full, setFull] = useState<{ focus: boolean } | null>(null);
  const [said, setSaid] = useState('');
  const regionId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  useEffect(() => {
    if (full || !closing.current) return;
    closing.current = false;
    // Closing shortens the page above the button: keep it in view.
    toggle.current?.scrollIntoView?.({ block: 'nearest' });
  }, [full]);
  const settled = useCallback((state: FullSectionState) => setSaid(fullSectionShown(excerpt, state)), [excerpt]);
  const where = position && position.count > 1 ? `, excerpt ${position.index + 1} of ${position.count}` : '';
  return (
    <figure data-excerpt={excerpt.sectionKey}>
      <figcaption className="mb-[3px] text-[10px] tracking-[.12em] text-muted">{excerptLabel(ntsbNo, aircraft, excerpt, numbered)}</figcaption>
      {full ? (
        <FullSection searchId={searchId} ntsbNo={ntsbNo} excerpt={excerpt} id={regionId} focus={full.focus} onSettled={settled} />
      ) : (
        <blockquote id={regionId} className="border-l-2 border-rule py-px pl-[11px]">
          <LongText text={excerpt.text}>
            <p className="font-serif text-body leading-[1.55] whitespace-pre-line text-ink">
              <MatchedText text={excerpt.text} highlights={excerpt.highlights} />
            </p>
          </LongText>
        </blockquote>
      )}
      <button
        ref={toggle}
        type="button"
        aria-expanded={full !== null}
        aria-controls={regionId}
        data-print="hide"
        onClick={() => {
          closing.current = full !== null;
          setSaid('');
          setFull(full ? null : { focus: true });
        }}
        className={cx('mt-1.5 cursor-pointer text-meta text-blue hover:underline pointer-coarse:min-h-11', full && 'mt-2')}
      >
        {full ? 'Show the excerpt only' : fullSectionLabel(excerpt)}
        {where && <span className="sr-only">{where}</span>}
      </button>
      <span aria-live="polite" className="sr-only" data-full-section-status="">
        {said}
      </span>
    </figure>
  );
}
