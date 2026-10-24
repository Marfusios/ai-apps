import { Fragment, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { CaseContextResponse } from '../../../../shared/contracts/briefs';
import { SECTION_LABEL, type AircraftBrief, type SectionKind } from '../../../../shared/contracts/search';
import { DataCaution } from '../../components/DataCaution';
import { EvidenceGlyph } from '../../components/EvidenceGlyph';
import { SectionHead } from '../../components/SectionHead';
import { EVENT_SCOPE_CAUTION, attributionAmbiguous, evidenceAttribution, ntsbSectionTag, quoteAttribution } from '../brief/display';

/**
 * The AI context of a case (UI_DESIGN §4.5 items 4, 8 and 9), read from the brief's
 * private endpoint (`GET /api/briefs/:id/steps/:n/cases/:ntsbNo`) and never merged into
 * the public case data: the verdict pill, WHY IT'S IN YOUR RESULTS with a jump to each
 * line's own passages, and the cited NTSB passages with the quoted spans highlighted
 * from their UTF-16 offsets. All text is rendered as text.
 */
export type AiCaseContext =
  | { state: 'loading'; briefId: string; step: number }
  /** The brief is expired, not the viewer's, or never had this case (404, or a malformed link). */
  | { state: 'gone'; briefId: string; step: number }
  /** The read failed for another reason (rate limit, server or network): worth retrying. */
  | { state: 'error'; briefId: string; step: number; retry: () => void }
  | { state: 'ready'; briefId: string; step: number; context: CaseContextResponse };

export const AI_NOTES_GONE = "The AI notes for this case have expired or aren't yours.";
export const AI_NOTES_FAILED = "The AI notes for this case didn't load.";

interface Span {
  start: number;
  end: number;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** True when `at` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));
}

/**
 * Valid, sorted, merged spans of `text` (offsets are UTF-16 code units, as JS strings
 * index). An edge inside a surrogate pair is widened to the whole character, so a mark
 * never cuts an astral character in half.
 */
export function cleanSpans(spans: readonly Span[], text: string): Span[] {
  const valid = spans
    .filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end <= text.length && s.start < s.end)
    .map((s) => ({ start: splitsPair(text, s.start) ? s.start - 1 : s.start, end: splitsPair(text, s.end) ? s.end + 1 : s.end }));
  valid.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of valid) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Paragraph ranges of a text (blank lines separate paragraphs), offsets into the text. */
export function paragraphRanges(text: string): Span[] {
  const out: Span[] = [];
  const gap = /\n\s*\n/g;
  let at = 0;
  for (let m = gap.exec(text); m; m = gap.exec(text)) {
    if (m.index > at) out.push({ start: at, end: m.index });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ start: at, end: text.length });
  return out;
}

function Paragraph({ text, range, marks }: { text: string; range: Span; marks: readonly Span[] }) {
  const parts: ReactNode[] = [];
  let at = range.start;
  marks.forEach((m, i) => {
    const start = Math.max(m.start, range.start);
    const end = Math.min(m.end, range.end);
    if (start >= end) return;
    if (start > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, start)}</Fragment>);
    parts.push(
      <mark key={`m${i}`} className="hit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < range.end) parts.push(<Fragment key="tail">{text.slice(at, range.end)}</Fragment>);
  return <p className="whitespace-pre-line">{parts}</p>;
}

/**
 * NTSB passage text in muted serif with the cited spans in ink on blue-wash. With
 * highlights, the paragraphs holding them are shown and the rest is one click away.
 */
export function PassageText({ text, highlights }: { text: string; highlights: readonly Span[] }) {
  const [whole, setWhole] = useState(false);
  const marks = cleanSpans(highlights, text);
  const ranges = paragraphRanges(text);
  const cited = ranges.map((r) => marks.some((m) => m.start < r.end && m.end > r.start));
  const trimmed = !whole && marks.length > 0 && cited.some((c) => !c);
  const shown = ranges.filter((_, i) => !trimmed || cited[i]);
  return (
    <div className="space-y-2 font-serif text-quote leading-[1.6] text-muted">
      {trimmed && !cited[0] && <p aria-hidden="true">…</p>}
      {shown.map((r) => (
        <Paragraph key={r.start} text={text} range={r} marks={marks} />
      ))}
      {trimmed && !cited[cited.length - 1] && <p aria-hidden="true">…</p>}
      {(trimmed || whole) && (
        <button type="button" onClick={() => setWhole(!whole)} className="cursor-pointer font-sans text-ui text-blue hover:underline">
          {whole ? 'Show the cited paragraphs only' : 'Show the whole passage'}
        </button>
      )}
    </div>
  );
}

export const passageAnchor = (passageId: string): string => `passage-${passageId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** Scrolls to a passage and moves focus to it (the "passage ↓" jumps). */
export function jumpToPassage(passageId: string): void {
  const el = document.getElementById(passageAnchor(passageId));
  if (!el) return;
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  el.focus({ preventScroll: true });
}

/** The passages a reader should see: cited (highlighted) ones and any a line or gap note rests on, in context order. */
export function shownPassages(context: CaseContextResponse): CaseContextResponse['passages'] {
  const referenced = new Set([...context.lines.flatMap((l) => l.passageIds), ...context.gaps.flatMap((g) => g.passageIds), ...(context.reading?.quotes ?? []).map((q) => q.passageId)]);
  return context.passages.filter((p) => p.highlights.length > 0 || referenced.has(p.passageId));
}

/** Where the drawer opens: the first cited passage, else the first a gap note rests on. */
export function citedTarget(context: CaseContextResponse): string | null {
  const cited = context.passages.find((p) => p.highlights.length > 0);
  return cited?.passageId ?? context.gaps[0]?.passageIds[0] ?? null;
}

function Jumps({ ids, passages }: { ids: readonly string[]; passages: CaseContextResponse['passages'] }) {
  const targets = [...new Set(ids)]
    .map((id) => passages.find((p) => p.passageId === id))
    .filter((p): p is CaseContextResponse['passages'][number] => p !== undefined);
  if (targets.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-x-2">
      {targets.map((p, i) => (
        <button
          key={p.passageId}
          type="button"
          onClick={() => jumpToPassage(p.passageId)}
          className="cursor-pointer text-meta whitespace-nowrap text-blue hover:underline pointer-coarse:min-h-11"
        >
          <span aria-hidden="true">{targets.length === 1 ? 'passage' : SECTION_LABEL[p.section].toLowerCase()} ↓</span>
          <span className="sr-only">
            Go to the {SECTION_LABEL[p.section].toLowerCase()} passage{targets.length > 1 ? ` ${i + 1}` : ''}
          </span>
        </button>
      ))}
    </span>
  );
}

function Line({ label, children, ids, passages }: { label: string; children: ReactNode; ids: readonly string[]; passages: CaseContextResponse['passages'] }) {
  return (
    <div data-line={label} className="border-t border-magenta-soft py-[7px] text-[13px] leading-[1.4] first:border-t-0">
      <span className="mb-px block text-micro font-bold tracking-caps text-magenta uppercase">{label}</span>
      {children}
      <Jumps ids={ids} passages={passages} />
    </div>
  );
}

export interface BriefVerdictProps {
  ai: AiCaseContext;
  ntsbNo: string;
  aircraft: readonly Pick<AircraftBrief, 'aircraftKey' | 'aircraftNtsbNo' | 'make' | 'model'>[];
}

/** Verdict pill, the evidence's aircraft in a multi-aircraft event, or why the AI notes are missing. */
export function BriefVerdict({ ai, ntsbNo, aircraft }: BriefVerdictProps) {
  const reading = ai.state === 'ready' ? ai.context.reading : null;
  const attribution = reading ? evidenceAttribution(ntsbNo, aircraft, reading.evidence) : null;
  return (
    <>
      {/* A polite live region rendered while the context loads, so a missing or failed read is announced. */}
      <div aria-live="polite">
        {ai.state === 'gone' && <p className="mt-3 text-meta text-muted">{AI_NOTES_GONE}</p>}
        {ai.state === 'error' && (
          <p className="mt-3 text-meta text-muted">
            {AI_NOTES_FAILED}{' '}
            <button type="button" onClick={ai.retry} className="cursor-pointer text-blue hover:underline pointer-coarse:min-h-11">
              Try again
            </button>
          </p>
        )}
      </div>
      {reading?.glyph && <EvidenceGlyph kind={reading.glyph} variant="pill" className="mt-3" />}
      {reading && attributionAmbiguous(aircraft, reading.evidence) && <DataCaution className="mt-3">{EVENT_SCOPE_CAUTION}.</DataCaution>}
      {attribution && (
        <p className="mt-2 text-meta text-muted">
          <span className="mr-1.5 text-micro font-bold tracking-caps uppercase">Evidence</span> {attribution}
        </p>
      )}
    </>
  );
}

export interface BriefSectionsProps {
  ai: AiCaseContext;
  ntsbNo: string;
  aircraft: BriefVerdictProps['aircraft'];
  mode: 'drawer' | 'page';
}

/** WHY IT'S IN YOUR RESULTS and the CITED PASSAGE(S), after what investigators established. */
export function BriefSections({ ai, ntsbNo, aircraft, mode }: BriefSectionsProps) {
  const location = useLocation();
  if (ai.state === 'loading') {
    return (
      <div aria-hidden="true" className="mt-6 space-y-2">
        <div className="h-3 w-1/3 rounded-[3px] bg-tint" />
        <div className="h-16 rounded-card bg-tint opacity-60" />
      </div>
    );
  }
  if (ai.state !== 'ready') return null;
  const { context } = ai;
  const passages = shownPassages(context);
  const reading = context.reading;
  // A reading the check removed still has lines that say so (Task 16e), never an empty section.
  const hasWhy = reading !== null || context.gaps.length > 0 || context.lines.length > 0;
  const sectionHref = (kind: SectionKind) => {
    const id = kind === 'probable_cause' ? 'probable-cause' : kind;
    return mode === 'page'
      ? `${location.pathname}${location.search}#${id}`
      : `/cases/${ntsbNo}?brief=${ai.briefId}&step=${ai.step}#${id}`;
  };
  const single = passages.length === 1 ? passages[0] : undefined;

  return (
    <>
      {hasWhy && (
        <section className="mt-6" aria-label="Why it's in your results" data-print="keep">
          <SectionHead tag={<span className="text-magenta">AI reading · check the passage</span>}>Why it&apos;s in your results</SectionHead>
          <div className="rounded-card border border-magenta-soft bg-magenta-wash px-3.5 py-1">
            {reading && (
              <Line label="Why it matched" ids={[...new Set(reading.quotes.map((q) => q.passageId))]} passages={passages}>
                {reading.why}
              </Line>
            )}
            {context.lines.map((l, i) => (
              <Line key={`${l.label}-${i}`} label={l.label} ids={l.passageIds} passages={passages}>
                {l.text}
              </Line>
            ))}
            {context.gaps.map((g) => (
              <Line key={g.text} label="AI note" ids={g.passageIds} passages={passages}>
                {g.text}
              </Line>
            ))}
          </div>
        </section>
      )}
      {passages.length > 0 && (
        <section className="mt-6" aria-label={single ? 'Cited passage' : 'Cited passages'}>
          <SectionHead tag={single ? ntsbSectionTag(single.section) : 'NTSB'}>{single ? 'Cited passage' : 'Cited passages'}</SectionHead>
          <div className="space-y-5">
            {passages.map((p) => (
              <div
                key={p.passageId}
                id={passageAnchor(p.passageId)}
                tabIndex={-1}
                aria-label={`NTSB ${SECTION_LABEL[p.section].toLowerCase()} passage${p.highlights.length > 0 ? ', cited' : ''}`}
                data-cited={p.highlights.length > 0 ? '' : undefined}
                className="scroll-mt-10 outline-none focus-visible:outline-2"
              >
                {(!single || aircraft.length > 1) && (
                  <p className="mb-1 text-micro tracking-[.12em] text-muted uppercase">
                    {ntsbSectionTag(p.section)}
                    {aircraft.length > 1 && ` · ${quoteAttribution(ntsbNo, aircraft, p)}`}
                  </p>
                )}
                <PassageText text={p.text} highlights={p.highlights} />
                <Link to={sectionHref(p.section)} className="link mt-1.5 inline-block text-ui">
                  Read the full {SECTION_LABEL[p.section].toLowerCase()}
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
