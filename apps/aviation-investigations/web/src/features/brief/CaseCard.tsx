import { useQuery } from '@tanstack/react-query';
import { Link, type To } from 'react-router';
import type { CaseCard as CaseCardData } from '../../../../shared/contracts/briefs';
import { caseQuery } from '../../api';
import { DataCaution } from '../../components/DataCaution';
import { EvidenceGlyph } from '../../components/EvidenceGlyph';
import { FlightProfile } from '../../components/FlightProfile';
import { TimingChip } from '../../components/TimingChip';
import { cx } from '../../lib/cx';
import { formatDate } from '../../lib/format';
import { CAUTION_SHORT, aircraftName, aircraftSummary, letterOf, phaseEventShort, placeShort, profileSteps } from '../case/display';
import {
  EVENT_SCOPE_CAUTION,
  attributionAmbiguous,
  evidenceAttribution,
  ntsbSectionTag,
  quoteAttribution,
  speakerTag,
  unconfirmedLines,
} from './display';

export const CASE_DETAIL_FAILED = "Couldn't load the flight profile and data cautions.";

export interface CaseCardProps {
  card: CaseCardData;
  /** Opens the drawer over the brief (`?case=`), at the cited passage. */
  caseTo: To;
  inCompare: boolean;
  onToggleCompare: () => void;
  /** Show the evidence glyph on the card (the "Examples found" list: only classified cases). */
  showGlyph?: boolean;
}

/** The UNCONFIRMED label: the passages do not settle one of the reader's criteria. */
export function UnconfirmedTag({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block rounded-badge border border-magenta-soft px-1 align-[1px] text-[9px] font-bold tracking-[.12em] whitespace-nowrap text-magenta uppercase',
        className,
      )}
    >
      Unconfirmed
    </span>
  );
}

function SourceLink({ card }: { card: CaseCardData }) {
  const report = card.report;
  if (report.kind === 'report') {
    return (
      <a href={report.url} target="_blank" rel="noopener noreferrer" className="text-blue hover:underline">
        NTSB report ↗
      </a>
    );
  }
  return (
    <span className="text-muted">
      {report.note} ·{' '}
      <a href={report.url} target="_blank" rel="noopener noreferrer" className="border-b border-dashed border-blue text-blue">
        Search NTSB ↗<span className="sr-only"> (a search page, not the report; look up {card.case.ntsbNo})</span>
      </a>
    </span>
  );
}

/**
 * A case on the briefing sheet (UI_DESIGN §4.3): the NTSB header row and Compare box;
 * WHY IT MATCHED and timing chips in magenta (AI); UNCONFIRMED when the passages do not
 * settle a criterion; the quoted NTSB passages in serif with their deterministic section
 * label; the mini flight profile, cautions and source link. A plain card (no AI reading:
 * withheld, no match) shows the case's best NTSB excerpt instead.
 */
export function CaseCard({ card, caseTo, inCompare, onToggleCompare, showGlyph = false }: CaseCardProps) {
  const { case: row, reading } = card;
  // Public, cacheable NTSB data: the flight profile and data cautions (and the drawer's first paint).
  const caseRead = useQuery(caseQuery(row.ntsbNo));
  const detail = caseRead.data;
  const multi = row.aircraft.length > 1;
  const attribution = reading ? evidenceAttribution(row.ntsbNo, row.aircraft, reading.evidence) : null;
  const ambiguous = reading ? attributionAmbiguous(row.aircraft, reading.evidence) : false;
  const unconfirmed = unconfirmedLines(reading);
  const headingId = `card-${row.ntsbNo}`;
  const single = row.aircraft.length === 1 ? row.aircraft[0] : undefined;

  return (
    <article aria-labelledby={headingId} className="card mb-2 px-3.5 pt-[11px] pb-2.5" data-card={row.ntsbNo} data-print="keep">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-ui">
        <h4 id={headingId} className="inline-flex flex-wrap items-baseline gap-x-2.5 text-ui font-normal">
          <Link
            to={caseTo}
            state={{ drawerFromList: true }}
            preventScrollReset
            data-case-trigger={row.ntsbNo}
            className="touch-target font-mono font-bold tracking-mono text-blue hover:underline"
          >
            {row.ntsbNo}
          </Link>
          <span className="font-bold">{multi ? `${row.aircraft.length} aircraft` : aircraftSummary(row)}</span>
        </h4>
        <span className="text-meta text-muted">
          {placeShort(row.city, row.state, row.country)} · {formatDate(row.date)}
        </span>
        {unconfirmed.length > 0 && <UnconfirmedTag />}
        <label className="touch-target ml-auto flex cursor-pointer items-center gap-[5px] text-meta text-blue" data-print="hide">
          <input type="checkbox" className="check" checked={inCompare} onChange={onToggleCompare} />
          Compare<span className="sr-only"> {row.ntsbNo}</span>
        </label>
      </div>
      {multi && (
        <p className="mt-0.5 text-meta text-muted">
          {row.aircraft.map((a, i) => `${letterOf(row.ntsbNo, a, i)} ${aircraftName(a)}`).join(' · ')}
        </p>
      )}

      {reading ? (
        <>
          <p className="mt-[5px] mb-1.5 text-ui text-magenta">
            <b className="mr-1.5 text-micro font-bold tracking-caps uppercase">Why it matched</b>{' '}
            {showGlyph && reading.glyph && <EvidenceGlyph kind={reading.glyph} className="mr-1.5 align-[-1px] text-meta font-bold" />}
            {reading.why}
            {reading.timing.map((t) => (
              <TimingChip key={`${t.basis}-${t.label}`} labelled={false} className="ml-1.5">
                {t.label}
              </TimingChip>
            ))}
          </p>
          {unconfirmed.length > 0 && (
            <p className="mb-1.5 text-meta text-magenta">
              <span className="mr-1.5 text-micro font-bold tracking-caps uppercase">AI reading</span>{' '}
              {unconfirmed.join(' ')}
            </p>
          )}
          {(attribution || ambiguous) && (
            <p className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-meta">
              {ambiguous && <DataCaution variant="chip">{EVENT_SCOPE_CAUTION}</DataCaution>}
              {attribution && (
                <span className="text-muted">
                  <span className="mr-1.5 text-micro font-bold tracking-caps uppercase">Evidence</span> {attribution}
                </span>
              )}
            </p>
          )}
          <div className="space-y-2">
            {reading.quotes.map((q) => {
              const who = speakerTag(q.speaker);
              const part = quoteAttribution(row.ntsbNo, row.aircraft, q);
              return (
                <blockquote key={`${q.passageId}-${q.span.start}`} className="border-l-2 border-rule py-px pl-[11px]">
                  <p className="font-serif text-body leading-[1.45]">“{q.text}”</p>
                  <footer className="mt-[3px] flex flex-wrap gap-x-2 text-[10px] tracking-[.12em] text-muted">
                    <cite className="not-italic">
                      {ntsbSectionTag(q.section)}
                      {part && ` · ${part}`}
                    </cite>
                    {who && <span className="font-bold text-magenta">{who}</span>}
                  </footer>
                </blockquote>
              );
            })}
          </div>
        </>
      ) : (
        <blockquote className="mt-1.5 border-l-2 border-rule py-px pl-[11px]">
          <p className="font-serif text-body leading-[1.45]">
            {card.excerpt.truncatedStart && '…'}
            {card.excerpt.text}
            {card.excerpt.truncatedEnd && '…'}
          </p>
          <footer className="mt-[3px] text-[10px] tracking-[.12em] text-muted">
            <cite className="not-italic">{ntsbSectionTag(card.excerpt.section)}</cite>
          </footer>
        </blockquote>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta">
        {single && detail && <FlightProfile steps={profileSteps(detail, single.aircraftKey)} size="mini" caption={false} />}
        <span className="font-mono text-label tracking-mono text-muted uppercase">{single ? phaseEventShort(single) : `${row.aircraft.length} aircraft`}</span>
        {detail?.cautions.map((c) => (
          <DataCaution key={c.kind} variant="chip">
            {CAUTION_SHORT[c.kind]}
          </DataCaution>
        ))}
        {caseRead.isError && (
          <span className="text-muted">
            {CASE_DETAIL_FAILED}{' '}
            <button type="button" onClick={() => void caseRead.refetch()} className="cursor-pointer text-blue hover:underline pointer-coarse:min-h-11">
              Try again
            </button>
          </span>
        )}
        <span className="ml-auto">
          <SourceLink card={card} />
        </span>
      </div>
    </article>
  );
}
