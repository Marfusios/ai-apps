import { Fragment } from 'react';
import { Link, type To } from 'react-router';
import { GLYPH_KINDS, type BriefResult, type CaseCard as CaseCardData, type Gap, type SummarySegment } from '../../../../shared/contracts/briefs';
import { AiBlock } from '../../components/AiBlock';
import { CaseCard, UnconfirmedTag } from './CaseCard';
import { resultsLabel } from './display';
import { EvidenceGroup } from './EvidenceGroup';
import { WithheldNotice } from './WithheldNotice';

export const SUMMARY_LABEL = 'AI summary · check the cited passages';

type SheetResult = Extract<BriefResult, { kind: 'answer' | 'withheld' | 'no_match' }>;

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

/** Summary text, rendered as text; citations are links built from server-owned case numbers. */
function Summary({ segments, caseTo }: { segments: readonly SummarySegment[]; caseTo: (n: string) => To }) {
  return (
    <AiBlock label={SUMMARY_LABEL} className="mb-[18px]">
      <p>
        {segments.map((s, i) => (
          <Fragment key={i}>{s.kind === 'text' ? s.text : <Citation ntsbNo={s.ntsbNo} unconfirmed={s.unconfirmed} to={caseTo(s.ntsbNo)} />}</Fragment>
        ))}
      </p>
    </AiBlock>
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
        <div role="status" className="card mt-4 px-4 py-3.5">
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
      </>
    );
  }

  const byNumber = new Map(result.cases.map((c) => [c.case.ntsbNo, c] as const));
  const groups =
    result.grouping === 'mechanical'
      ? GLYPH_KINDS.map((kind) => ({ kind, caseNumbers: result.groups.find((g) => g.kind === kind)?.caseNumbers ?? [] }))
      : result.groups;
  return (
    <>
      <Summary segments={result.summary} caseTo={caseTo} />
      {label}
      {groups.map((g) => {
        const cards = g.caseNumbers.map((n) => byNumber.get(n)).filter((c): c is CaseCardData => c !== undefined);
        return (
          <EvidenceGroup key={g.kind} kind={g.kind} count={cards.length}>
            {cards.map((c) => card(c, g.kind === 'examples'))}
          </EvidenceGroup>
        );
      })}
      <Gaps gaps={result.gaps} caseTo={caseTo} />
    </>
  );
}
