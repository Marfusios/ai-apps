import { Link, type To } from 'react-router';
import type { BriefFilters } from '../../../../shared/contracts/briefs';
import type { EvidenceCase } from '../../../../shared/contracts/evidence';
import { cx } from '../../lib/cx';
import { CaseFacts } from '../explore/CaseFacts';
import { NO_EXCERPT, probableCauseLabel, relevanceParts } from './display';
import { Excerpt, LongText } from './Excerpt';

/** The report link, or the labelled search fallback (DESIGN §4). */
export function ReportLink({ item }: { item: Pick<EvidenceCase, 'report' | 'case'> }) {
  const report = item.report;
  if (report.kind === 'report') {
    return (
      <a href={report.url} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-blue hover:underline">
        NTSB report ↗
      </a>
    );
  }
  return (
    <span className="text-muted">
      {report.note} ·{' '}
      <a href={report.url} target="_blank" rel="noopener noreferrer" className="border-b border-dashed border-blue whitespace-nowrap text-blue">
        Search NTSB ↗<span className="sr-only"> (a search page, not the report; look up {item.case.ntsbNo})</span>
      </a>
    </span>
  );
}

/**
 * Why a case is listed, in checkable facts (contract `EvidenceRelevance`): "Phase: Approach ·
 * “icing” 6 times · found by keyword and similarity search". Interface text, never NTSB's.
 */
export function RelevanceLine({ item, filters, className }: { item: Pick<EvidenceCase, 'relevance' | 'excerpts'>; filters: BriefFilters; className?: string }) {
  return (
    <p className={cx('text-meta text-muted', className)} data-relevance="">
      <span className="sr-only">How it was found: </span>
      {relevanceParts(item.relevance, filters, item.excerpts.length > 0).join(' · ')}
    </p>
  );
}

/**
 * Every probable-cause statement of the case, verbatim, with its scope (several in some
 * multi-aircraft events); the report link sits on the first label line, with the NTSB's own
 * conclusion.
 */
export function ProbableCauses({ item, className }: { item: Pick<EvidenceCase, 'case' | 'probableCauses' | 'report'>; className?: string }) {
  const { case: row, probableCauses } = item;
  const link = (
    <span className="ml-auto text-meta tracking-normal">
      <ReportLink item={item} />
    </span>
  );
  if (probableCauses.length === 0) {
    return (
      <p className={cx('flex flex-wrap items-baseline gap-x-3 text-meta text-muted', className)}>
        No probable cause on record.
        {link}
      </p>
    );
  }
  return (
    <div className={cx('space-y-2', className)}>
      {probableCauses.map((p, i) => (
        <div key={p.sectionKey} data-probable-cause={p.sectionKey}>
          <p className="mb-px flex flex-wrap items-baseline gap-x-3 text-[10px] tracking-[.12em] text-muted">
            {probableCauseLabel(row.ntsbNo, row.aircraft, p, i, probableCauses.length)}
            {i === 0 && link}
          </p>
          <LongText text={p.text}>
            <p className="font-serif text-quote leading-[1.5] whitespace-pre-line text-ink">{p.text.trim()}</p>
          </LongText>
        </div>
      ))}
    </div>
  );
}

export interface EvidenceCardProps {
  /** The search the case was retrieved for (its full sections come from it). */
  searchId: string;
  item: EvidenceCase;
  /** The search's filters, for the relevance facts. */
  filters: BriefFilters;
  /** Opens the drawer over the sheet (`?case=`). */
  caseTo: To;
  inCompare: boolean;
  onToggleCompare: () => void;
}

/**
 * A retrieved investigation (UI_DESIGN §4.9): its facts as Explore's rows show them, every
 * probable-cause statement verbatim, up to three whole-paragraph excerpts with their section
 * label and scope and the matches marked, the relevance facts, and the report link. NTSB text
 * and coded data only.
 */
export function EvidenceCard({ searchId, item, filters, caseTo, inCompare, onToggleCompare }: EvidenceCardProps) {
  const { case: row } = item;
  return (
    <article aria-labelledby={`evidence-case-${row.ntsbNo}`} className="card mb-2.5 px-3.5 pt-[11px] pb-2.5 sm:px-4" data-card={row.ntsbNo} data-rank={item.rank}>
      <div data-print="keep">
        <CaseFacts row={row} caseTo={caseTo} inCompare={inCompare} onToggleCompare={onToggleCompare} headingId={`evidence-case-${row.ntsbNo}`} />
        <ProbableCauses item={item} className="mt-2" />
      </div>
      {item.excerpts.length > 0 ? (
        <div className="mt-3.5 space-y-4">
          {item.excerpts.map((e) => (
            <Excerpt key={`${e.sectionKey}:${e.paragraph.start}`} searchId={searchId} ntsbNo={row.ntsbNo} aircraft={row.aircraft} excerpt={e} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-meta text-muted" data-no-excerpt="">
          {NO_EXCERPT}{' '}
          <Link to={`/cases/${row.ntsbNo}`} className="text-blue hover:underline">
            Open {row.ntsbNo}
          </Link>
        </p>
      )}
      <RelevanceLine item={item} filters={filters} className="mt-2.5 border-t border-dashed border-hairline pt-2" />
    </article>
  );
}
