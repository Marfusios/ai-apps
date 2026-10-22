import type { DashboardRequest } from '../../../../shared/contracts/dashboard';
import { Chip } from '../../components/Chip';
import { formatCount } from '../../lib/format';

type Cohort = DashboardRequest['cohort'];

/**
 * The cohort row (UI_DESIGN §4.7), which always shows the denominator. The dashed
 * chip adds the other records to the cohort; when they are in, it takes them out.
 */
export function CohortChips({
  cohort,
  completed,
  other,
  yearFrom,
  yearTo,
  onCohort,
}: {
  cohort: Cohort;
  completed: number | undefined;
  other: number | undefined;
  yearFrom: number | undefined;
  yearTo: number | undefined;
  onCohort: (cohort: Cohort) => void;
}) {
  const n = (v: number | undefined): string => (v === undefined ? '…' : formatCount(v));
  const all = cohort === 'all';
  return (
    <div className="mt-2 mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Cohort">
      <Chip variant="filled">
        {all ? `All US records · ${completed !== undefined && other !== undefined ? formatCount(completed + other) : '…'}` : `Completed investigations · ${n(completed)}`}
      </Chip>
      {all ? (
        <Chip variant="add" onClick={() => onCohort('default')}>
          Only completed investigations
        </Chip>
      ) : (
        <Chip variant="add" onClick={() => onCohort('all')}>
          + Include {n(other)} other records
        </Chip>
      )}
      <Chip>United States</Chip>
      {yearFrom !== undefined && yearTo !== undefined && <Chip>{yearFrom} – {yearTo}</Chip>}
      <Chip>All aircraft</Chip>
    </div>
  );
}
