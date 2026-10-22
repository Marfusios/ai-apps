import type { ReactNode } from 'react';
import type { DashboardResponse } from '../../../../shared/contracts/dashboard';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { formatPercent } from './sentences';

function Row({ label, value, ai = false }: { label: string; value: ReactNode; ai?: boolean }) {
  return (
    <li className={cx('flex gap-x-3 border-t border-hairline py-1.5 text-[12px] first:border-t-0', ai && 'text-magenta')}>
      <span>{label}</span>
      <span className="sr-only">: </span>
      <b className="ml-auto text-right font-mono text-[11px] font-normal">{value}</b>
    </li>
  );
}

/** "What can this data tell you?" (UI_DESIGN §4.7): what is in the data, and what is not. */
export function CoveragePanel({ coverage }: { coverage: DashboardResponse['coverage'] }) {
  const share = (s: { count: number; of: number }): string => `${formatCount(s.count)} · ${formatPercent(s.count, s.of)}`;
  return (
    <ul aria-label="What is in the data">
      <Row label="Probable cause text available" value={share(coverage.probableCause)} />
      <Row label="Raw METAR weather text" value={share(coverage.metar)} />
      <Row label="How many flights or hours were flown (needed for any risk rate)" value="not in this data" />
      <Row label="AI evidence classification" value="not used in these charts" ai />
    </ul>
  );
}
