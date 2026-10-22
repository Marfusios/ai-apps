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
  // A count that has not loaded (or failed to load) is left out rather than shown as a placeholder.
  const withCount = (label: string, count: number | undefined): string =>
    count === undefined ? label : `${label} · ${formatCount(count)}`;
  const all = cohort === 'all';
  return (
    <div className="mt-2 mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Cohort">
      <Chip variant="filled">
        {all
          ? withCount('All US records', completed !== undefined && other !== undefined ? completed + other : undefined)
          : withCount('Completed investigations', completed)}
      </Chip>
      {all ? (
        <Chip variant="add" onClick={() => onCohort('default')}>
          Only completed investigations
        </Chip>
      ) : (
        <Chip variant="add" onClick={() => onCohort('all')}>
          {other === undefined ? '+ Include other records' : `+ Include ${formatCount(other)} other records`}
        </Chip>
      )}
      <Chip>United States</Chip>
      {yearFrom !== undefined && yearTo !== undefined && (
        <Chip>
          {yearFrom} – {yearTo}
        </Chip>
      )}
      <Chip>All aircraft</Chip>
    </div>
  );
}
