import { Link, type To } from 'react-router';
import type { CaseRow } from '../../../../shared/contracts/search';
import { Highlighted } from '../../components/Highlighted';
import { StatusBadge } from '../../components/StatusBadge';
import { cx } from '../../lib/cx';
import { formatDate } from '../../lib/format';
import {
  aircraftName,
  aircraftSummary,
  conditionsShort,
  injuryShort,
  letterOf,
  phaseEventShort,
  placeShort,
  rowMonoParts,
} from '../case/display';

export interface ResultRowProps {
  row: CaseRow;
  /** Opens the drawer over the results (`?case=`). */
  caseTo: To;
  inCompare: boolean;
  onToggleCompare: () => void;
}

function MonoLine({ parts }: { parts: { text: string; strong?: boolean }[] }) {
  return (
    <p className="font-mono text-label tracking-[.02em] text-muted uppercase">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <span className={cx(p.strong && 'font-bold text-ink')}>{p.text}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * A result row in three lines (UI_DESIGN §4.2): case number, date, aircraft, place
 * and Compare; a mono line of phase, defining event, conditions and injury; then
 * the probable cause (or the best matching passage) with matched terms marked.
 * Multi-aircraft events get one sub-row per aircraft (decision 18).
 */
export function ResultRow({ row, caseTo, inCompare, onToggleCompare }: ResultRowProps) {
  const multi = row.aircraft.length > 1;
  const injury = injuryShort(row.highestInjury);
  const completed = row.completion.class === 'completed';
  const snippet = row.snippet;
  return (
    <li className="border-t border-hairline px-0.5 pt-[11px] pb-3" data-row={row.ntsbNo}>
      <div className="flex flex-wrap items-baseline gap-x-[9px] gap-y-0.5 text-ui">
        <Link
          to={caseTo}
          state={{ drawerFromList: true }}
          preventScrollReset
          data-case-trigger={row.ntsbNo}
          className="touch-target font-mono font-bold tracking-mono text-blue hover:underline"
        >
          {row.ntsbNo}
        </Link>
        <span className="text-muted">{formatDate(row.date)}</span>
        <span className="font-bold">{aircraftSummary(row)}</span>
        <span className="text-muted">{placeShort(row.city, row.state, row.country)}</span>
        {!completed && <StatusBadge kind={row.completion.class} rawStatus={row.completion.rawStatus} />}
        <label className="touch-target ml-auto flex cursor-pointer items-center gap-[5px] text-meta text-blue">
          <input type="checkbox" className="check" checked={inCompare} onChange={onToggleCompare} />
          Compare<span className="sr-only"> {row.ntsbNo}</span>
        </label>
      </div>

      {multi ? (
        <div className="mt-1 mb-1.5">
          <ul className="space-y-0.5">
            {row.aircraft.map((a, i) => (
              <li key={a.aircraftKey} className="grid grid-cols-[16px_minmax(0,auto)_1fr] items-baseline gap-x-2 text-meta">
                <span className="font-mono font-bold text-muted">{letterOf(row.ntsbNo, a, i)}</span>
                <span className="font-bold">{aircraftName(a)}</span>
                <span className="truncate font-mono text-label tracking-[.02em] text-muted uppercase">{phaseEventShort(a)}</span>
              </li>
            ))}
          </ul>
          <MonoLine parts={[{ text: conditionsShort(row.conditions, row.light) }, { text: injury.text, strong: injury.fatal }]} />
        </div>
      ) : (
        <div className="mt-[3px] mb-[5px]">
          <MonoLine parts={rowMonoParts(row)} />
        </div>
      )}

      {!row.completion.hasProbableCause && (
        <p className="text-meta text-muted">{completed ? 'Probable-cause text unavailable' : 'No probable cause on record'}</p>
      )}
      {snippet && (
        <p className="font-serif text-body leading-[1.45] text-ink">
          <span className="mr-1.5 font-sans text-[9px] tracking-caps text-muted uppercase">{snippet.label}</span>
          {snippet.truncatedStart && '…'}
          <Highlighted text={snippet.text} highlights={snippet.highlights} />
          {snippet.truncatedEnd && '…'}
        </p>
      )}
    </li>
  );
}
