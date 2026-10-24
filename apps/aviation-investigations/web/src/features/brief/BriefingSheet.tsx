import { Fragment, type ReactNode } from 'react';
import { Link, type To } from 'react-router';
import { GLYPH_KINDS, type BriefResult, type CaseCard as CaseCardData, type GROUP_KINDS, type Gap, type SummarySegment } from '../../../../shared/contracts/briefs';
import { AiBlock } from '../../components/AiBlock';
import { CaseCard, UnconfirmedTag } from './CaseCard';
import { checkStatusLine, resultsLabel, ungroupedTitle } from './display';
import { EvidenceGroup } from './EvidenceGroup';
import { WithheldNotice } from './WithheldNotice';

export const SUMMARY_LABEL = 'AI summary · check the cited passages';

type SheetResult = Extract<BriefResult, { kind: 'answer' | 'withheld' | 'no_match' }>;

export interface SheetLayout {
  /** An answer's evidence groups in display order, each with its cards (empty groups included). */
  groups: { kind: (typeof GROUP_KINDS)[number]; cards: CaseCardData[] }[];
  /** The cards shown after them: an answer's cases in no group, or every card of a withheld or no-match sheet. */
  rest: CaseCardData[];
}

/**
 * Where each card goes on the sheet: mechanical groups in the fixed order (causal, defect,
 * no fault, insufficient), or the one "examples" group, then the cases in no group
 * (unclassified, or without a reading) in the result's order. The sheet renders from it,
 * and the drawer steps through the cards in the same order (`sheetOrder`).
 */
export function sheetLayout(result: SheetResult): SheetLayout {
  if (result.kind !== 'answer') return { groups: [], rest: result.cases };
  const byNumber = new Map(result.cases.map((c) => [c.case.ntsbNo, c] as const));
  const listed =
    result.grouping === 'mechanical'
      ? GLYPH_KINDS.map((kind) => ({ kind, caseNumbers: result.groups.find((g) => g.kind === kind)?.caseNumbers ?? [] }))
      : result.groups;
  // Every case is on the sheet: those in no group (unclassified, or without a reading) after the groups.
  const grouped = new Set(listed.flatMap((g) => g.caseNumbers));
  return {
    groups: listed.map((g) => ({ kind: g.kind, cards: g.caseNumbers.map((n) => byNumber.get(n)).filter((c): c is CaseCardData => c !== undefined) })),
    rest: result.cases.filter((c) => !grouped.has(c.case.ntsbNo)),
  };
}

/** The case numbers in the order the sheet shows their cards, each once: the drawer's "‹ n of N ›" (Task 22 review W-11). */
export function sheetOrder(result: SheetResult): string[] {
  const { groups, rest } = sheetLayout(result);
  return [...new Set([...groups.flatMap((g) => g.cards), ...rest].map((c) => c.case.ntsbNo))];
}

export interface BriefingSheetProps {
  result: SheetResult;
  /** The drawer link for a case, opened at its cited passage. */
  caseTo: (ntsbNo: string) => To;
  inCompare: (ntsbNo: string) => boolean;
  onToggleCompare: (ntsbNo: string) => void;
}

const citeClass = 'touch-target font-mono text-[11px] tracking-mono whitespace-nowrap text-blue border-b border-blue hover:border-b-2';

/** A case-number citation: blue mono, server-owned number; opens the drawer at the cited passage. */
function Citation({ ntsbNo, unconfirmed, to }: { ntsbNo: string; unconfirmed: boolean; to: To }) {
  return (
    <>
      <Link to={to} state={{ drawerFromList: true }} preventScrollReset data-case-trigger={ntsbNo} className={citeClass}>
        {ntsbNo}
      </Link>
      {unconfirmed && <UnconfirmedTag className="ml-1" />}
    </>
  );
}

/**
 * What goes before segment `i`: a comma and a thin space between two citations in a row
 * ("DFW08TA066, MIA08LA156": the server drops the blank text between their markers), and
 * a space where a citation would otherwise touch a word.
 */
export function citationJoiner(segments: readonly SummarySegment[], i: number): string {
  const s = segments[i];
  const prev = segments[i - 1];
  if (!s || !prev) return '';
  if (s.kind === 'case' && prev.kind === 'case') return ',\u2009';
  if (s.kind === 'case' && prev.kind === 'text' && !/[\s(\[“"'‘]$/.test(prev.text)) return ' ';
  if (s.kind === 'text' && prev.kind === 'case' && /^[\p{L}\p{N}]/u.test(s.text)) return ' ';
  // A removed-statements marker (Task 16d) stands between whole sentences.
  if (s.kind === 'removed' && !(prev.kind === 'text' && /\s$/.test(prev.text))) return ' ';
  if (s.kind === 'text' && prev.kind === 'removed' && !/^\s/.test(s.text)) return ' ';
  return '';
}

/** Where the evidence check removed whole sentences (Task 16d, partial display): the count, never their text. */
function RemovedMarker({ count }: { count: number }) {
  return <span className="text-muted">[{count === 1 ? 'one statement' : `${count} statements`} not shown: the check could not confirm {count === 1 ? 'it' : 'them'}]</span>;
}

/** Summary text, rendered as text; citations are links built from server-owned case numbers. */
function Summary({ segments, caseTo }: { segments: readonly SummarySegment[]; caseTo: (n: string) => To }) {
  return (
    <AiBlock label={SUMMARY_LABEL} className="mb-[18px]">
      <p>
        {segments.map((s, i) => (
          <Fragment key={i}>
            {citationJoiner(segments, i)}
            {s.kind === 'text' ? s.text : s.kind === 'removed' ? <RemovedMarker count={s.count} /> : <Citation ntsbNo={s.ntsbNo} unconfirmed={s.unconfirmed} to={caseTo(s.ntsbNo)} />}
          </Fragment>
        ))}
      </p>
    </AiBlock>
  );
}

/** What the evidence check did, from the server's counts (Task 16e): never a blanket status. */
function CheckStatus({ check }: { check: NonNullable<Extract<SheetResult, { kind: 'answer' }>['check']> }) {
  return (
    <p className="mb-2 text-meta text-muted" data-check-status="">
      {checkStatusLine(check)}
    </p>
  );
}

/**
 * The answer's cards outside every group (Task 16e; partial display): a case whose group
 * placement the check removed keeps its reading here, unclassified; a case whose reading
 * was removed shows here with its NTSB text. Never dropped from the sheet while counted in
 * the results label.
 */
function Ungrouped({ grouping, children, count }: { grouping: 'mechanical' | 'examples'; children: ReactNode; count: number }) {
  const { title, note } = ungroupedTitle(grouping);
  return (
    <section aria-label={`${title}, ${count} ${count === 1 ? 'case' : 'cases'}`} className="mt-4" data-ungrouped="">
      <h3 className="mb-[3px] flex flex-wrap items-center gap-x-[7px] gap-y-0.5 text-ui font-bold after:ml-1 after:h-px after:min-w-6 after:flex-1 after:bg-hairline">
        <span>{title}</span>
        <span className="font-normal whitespace-nowrap text-muted">{`${count} ${count === 1 ? 'case' : 'cases'}`}</span>
      </h3>
      <p className="mb-[7px] text-meta text-muted">{note}</p>
      {children}
    </section>
  );
}

/** Gap notes (model-written, evidence-checked): muted, with an AI label and blue actions. */
function Gaps({ gaps, caseTo }: { gaps: readonly Gap[]; caseTo: (n: string) => To }) {
  if (gaps.length === 0) return null;
  return (
    <div className="mt-3.5 space-y-1 border-t border-dashed border-hairline pt-2.5 text-ui text-muted">
      {gaps.map((g) => (
        <p key={`${g.ntsbNo}-${g.text}`}>
          <span className="mr-1.5 text-micro font-bold tracking-caps text-magenta uppercase">AI note</span>{' '}
          {g.text} <Citation ntsbNo={g.ntsbNo} unconfirmed={false} to={caseTo(g.ntsbNo)} />{' '}
          <span aria-hidden="true">·</span>{' '}
          <Link to={`/explore?case=${g.ntsbNo}`} className="text-blue underline decoration-1 underline-offset-[3px]">
            Include it<span className="sr-only"> (opens {g.ntsbNo} in Explore; free)</span>
          </Link>
        </p>
      ))}
    </div>
  );
}

/**
 * AI results, "Briefing sheet" (UI_DESIGN §4.3): the summary on a magenta rule with
 * blue case citations, the results label, the evidence groups (or one "Examples found"
 * list) with their cards, and gap notes. A withheld summary shows the hatched notice
 * and plain cards; an explicit abstention shows the server's lines and plain cards.
 */
export function BriefingSheet({ result, caseTo, inCompare, onToggleCompare }: BriefingSheetProps) {
  const card = (c: CaseCardData, showGlyph = false) => (
    <CaseCard
      key={c.case.ntsbNo}
      card={c}
      caseTo={caseTo(c.case.ntsbNo)}
      inCompare={inCompare(c.case.ntsbNo)}
      onToggleCompare={() => onToggleCompare(c.case.ntsbNo)}
      showGlyph={showGlyph}
    />
  );
  const label = <p className="mb-1 text-meta text-muted">{resultsLabel(result.cases.length)}</p>;

  if (result.kind === 'withheld') {
    return (
      <>
        <WithheldNotice count={result.cases.length} />
        <div className="mt-4">
          {label}
          {result.cases.map((c) => card(c))}
        </div>
      </>
    );
  }

  if (result.kind === 'no_match') {
    return (
      <>
        <div className="card mt-4 px-4 py-3.5">
          <p className="font-serif text-[18px] leading-tight font-semibold">{result.lines[0]}</p>
          {result.lines.slice(1).map((line) => (
            <p key={line} className="mt-1 text-ui">
              {line}
            </p>
          ))}
        </div>
        <div className="mt-4">
          <p className="mb-1 text-meta text-muted">Cases this search retrieved</p>
          {result.cases.map((c) => card(c))}
        </div>
        <Gaps gaps={result.gaps} caseTo={caseTo} />
        {result.check && <div className="mt-2">{<CheckStatus check={result.check} />}</div>}
      </>
    );
  }

  const { groups, rest: ungrouped } = sheetLayout(result);
  return (
    <>
      <Summary segments={result.summary} caseTo={caseTo} />
      {result.check && <CheckStatus check={result.check} />}
      {label}
      {groups.map((g) => (
        <EvidenceGroup key={g.kind} kind={g.kind} count={g.cards.length}>
          {g.cards.map((c) => card(c, g.kind === 'examples'))}
        </EvidenceGroup>
      ))}
      {ungrouped.length > 0 && (
        <Ungrouped grouping={result.grouping} count={ungrouped.length}>
          {ungrouped.map((c) => card(c))}
        </Ungrouped>
      )}
      <Gaps gaps={result.gaps} caseTo={caseTo} />
    </>
  );
}
