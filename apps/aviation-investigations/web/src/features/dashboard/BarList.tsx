import { useNavigate } from 'react-router';
import type { DashboardBar } from '../../../../shared/contracts/dashboard';
import { isUnknownFacetValue } from '../../../../shared/contracts/search';
import { cx } from '../../lib/cx';
import { formatCount, plural } from '../../lib/format';
import { exploreHref } from './links';
import { formatPercent } from './sentences';

/**
 * Facet-style bars (UI_DESIGN §4.7): a thin `blue-wash` bar behind the label, the
 * count and the percentage of the cohort. Every bar is a button that opens Explore
 * with the same cohort and the value applied, so the count reproduces there.
 */
export function BarList({
  bars,
  total,
  cohort,
  label,
}: {
  bars: readonly DashboardBar[];
  total: number;
  cohort: 'default' | 'all';
  label: string;
}) {
  const navigate = useNavigate();
  const max = Math.max(1, ...bars.map((bar) => bar.count));
  if (bars.length === 0) return <p className="text-meta text-muted">No cases in this cohort.</p>;
  return (
    <ul aria-label={label}>
      {bars.map((bar) => {
        const percent = formatPercent(bar.count, total);
        const unknown = isUnknownFacetValue(bar.value);
        return (
          <li key={bar.value}>
            <button
              type="button"
              aria-label={`${bar.label}, ${plural(bar.count, 'investigation')}, ${percent}. Open in Explore.`}
              onClick={() => void navigate(exploreHref(cohort, { facet: bar.facet, value: bar.value }))}
              className="group grid w-full cursor-pointer grid-cols-[1fr_46px_44px] items-center gap-x-1.5 py-[1.5px] text-left pointer-coarse:min-h-11"
            >
              <span className="relative min-w-0">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-px left-0 rounded-[2px] bg-blue-wash group-hover:bg-hairline group-focus-visible:bg-hairline"
                  style={{ width: `${Math.max(2, (bar.count / max) * 100)}%` }}
                />
                <span className={cx('relative block truncate px-1.5 py-px text-meta', unknown ? 'text-muted italic' : 'text-ink')}>
                  {bar.label}
                </span>
              </span>
              <span className="text-right font-mono text-label text-ink">{formatCount(bar.count)}</span>
              <span className="text-right font-mono text-micro text-muted">{percent}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
