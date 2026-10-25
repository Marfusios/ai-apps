import { Link, type To } from 'react-router';
import type { CaseRow } from '../../../../shared/contracts/search';
import { StatusBadge } from '../../components/StatusBadge';
import { cx } from '../../lib/cx';
import { formatDate } from '../../lib/format';
import { aircraftName, aircraftSummary, conditionsShort, injuryShort, letterOf, phaseEventShort, placeShort, rowMonoParts } from '../case/display';

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

export interface CaseFactsProps {
  row: Omit<CaseRow, 'snippet'>;
  /** Opens the drawer over the list (`?case=`). */
  caseTo: To;
  inCompare: boolean;
  onToggleCompare: () => void;
  /**
   * With an id, the case number and aircraft are a heading (`h3`) named by it: a card on the
   * evidence sheet. Explore's rows have none.
   */
  headingId?: string;
  /** False: the Compare box does not print (the evidence view's cards). Explore's rows keep it. */
  printCompare?: boolean;
}

/**
 * A case's facts as Explore's rows show them (UI_DESIGN §4.2): case number, date, aircraft,
 * place, status and the Compare box; then a mono line of phase, defining event, conditions
 * and injury, or one sub-row per aircraft in a multi-aircraft event (decision 18). Coded NTSB
 * data only. Explore's result rows and the evidence view's cards share it.
 */
export function CaseFacts({ row, caseTo, inCompare, onToggleCompare, headingId, printCompare = true }: CaseFactsProps) {
  const multi = row.aircraft.length > 1;
  const injury = injuryShort(row.highestInjury);
  const completed = row.completion.class === 'completed';
  const number = (
    <Link
      to={caseTo}
      state={{ drawerFromList: true }}
      preventScrollReset
      data-case-trigger={row.ntsbNo}
      className="touch-target font-mono font-bold tracking-mono text-blue hover:underline"
    >
      {row.ntsbNo}
    </Link>
  );
  const name = <span className="font-bold">{aircraftSummary(row)}</span>;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-[9px] gap-y-0.5 text-ui">
        {headingId ? (
          <>
            <h3 id={headingId} className="inline-flex flex-wrap items-baseline gap-x-[9px] text-ui font-normal">
              {number}
              <span className="sr-only">, </span>
              {name}
            </h3>
            <span className="text-muted">{formatDate(row.date)}</span>
          </>
        ) : (
          <>
            {number}
            <span className="text-muted">{formatDate(row.date)}</span>
            {name}
          </>
        )}
        <span className="text-muted">{placeShort(row.city, row.state, row.country)}</span>
        {!completed && <StatusBadge kind={row.completion.class} rawStatus={row.completion.rawStatus} />}
        {completed && !row.completion.hasProbableCause && (
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <StatusBadge kind="completed" />
            <span className="text-meta text-muted">Probable-cause text unavailable</span>
          </span>
        )}
        <label className="touch-target ml-auto flex cursor-pointer items-center gap-[5px] text-meta text-blue" data-print={printCompare ? undefined : 'hide'}>
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
    </>
  );
}
