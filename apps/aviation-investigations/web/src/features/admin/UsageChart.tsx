import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AdminUsageDay } from '../../../../shared/contracts/admin';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { niceTicks } from '../dashboard/YearChart';
import { formatUsd, formatUtcDay } from './format';

type Measure = 'trialSearches' | 'accountSearches' | 'freeUndos' | 'failedSearches';

/**
 * The rows of the chart (small multiples, one series each, so no row needs a colour of its own):
 * trial and account searches on one shared scale, so they compare; free undos and failed searches
 * each on their own, as they are a few a day at most.
 */
export const USAGE_ROWS: readonly { key: Measure; label: string; unit: [string, string]; shared: boolean; height: number }[] = [
  { key: 'trialSearches', label: 'Trials', unit: ['trial search', 'trial searches'], shared: true, height: 46 },
  { key: 'accountSearches', label: 'Accounts', unit: ['account search', 'account searches'], shared: true, height: 46 },
  { key: 'freeUndos', label: 'Free undos', unit: ['free undo', 'free undos'], shared: false, height: 24 },
  { key: 'failedSearches', label: 'Failed searches', unit: ['failed search', 'failed searches'], shared: false, height: 24 },
];

export const USAGE_CHART_TITLE = 'AI searches per UTC day, last 30 days';
export const USAGE_CHART_NOTE = 'Trials and accounts share a scale; free undos and failed searches have their own. Today, still under way, is hatched.';

const LABEL_H = 18;
const ROW_GAP = 10;
const AXIS_H = 18;
const PAD = { left: 28, right: 2 };
const MAX_BAR = 24;

const count = (n: number, [one, many]: [string, string]): string => `${formatCount(n)} ${n === 1 ? one : many}`;

/** A column's path: square at the baseline, 4px rounded at its data end (never more than half its width or its height). */
function columnPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  const r = Math.max(0, Math.min(4, w / 2, h));
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/** One day's figures in words, as the tooltip and the live line give them. */
export function dayInWords(day: AdminUsageDay): string {
  return `${formatUtcDay(day.day)}: ${USAGE_ROWS.map((row) => count(day[row.key], row.unit)).join(', ')}; ${formatUsd(day.usd)} spent.`;
}

/**
 * AI searches per UTC day over the last 30 (UI_DESIGN §4.12; the dataviz method with Sectional
 * tokens): four small multiples in chart blue, each named by its row label with its 30-day total,
 * thin columns from one baseline, rounded at the data end, a 2px gap between neighbours, a hairline
 * baseline and scale line, and today, still under way, hatched as incomplete data is everywhere.
 * Hovering or the arrow keys (once the chart has focus) pick a day: a band marks it across the rows
 * and a tooltip gives every figure of that day (the live line says it too); "Show the figures"
 * opens the same as a table. Sized to its container, like the dashboard's year chart.
 */
export function UsageChart({ days }: { days: readonly AdminUsageDay[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [said, setSaid] = useState('');
  const [table, setTable] = useState(false);
  const ids = useId();
  const patternId = `usage-today-${ids.replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = days.length;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(1, Math.min(MAX_BAR, slot - 2));
  const xOf = (i: number): number => PAD.left + i * slot + (slot - barW) / 2;
  const sharedMax = Math.max(1, ...days.flatMap((d) => [d.trialSearches, d.accountSearches]));
  const scaleOf = (shared: boolean, key: Measure): number => {
    const max = shared ? sharedMax : Math.max(1, ...days.map((d) => d[key]));
    return niceTicks(max).at(-1) ?? max;
  };
  let top = 0;
  const rows = USAGE_ROWS.map((row) => {
    const y = top + LABEL_H;
    top = y + row.height + ROW_GAP;
    return { ...row, y, scale: scaleOf(row.shared, row.key), total: days.reduce((sum, d) => sum + d[row.key], 0) };
  });
  const height = top - ROW_GAP + AXIS_H;
  // The last day is today, still under way.
  const today = n - 1;
  // Day labels every seven days back from today.
  const labelled = days.map((_, i) => i).filter((i) => (today - i) % 7 === 0);

  const pick = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const i = Math.floor((event.clientX - rect.left - PAD.left) / slot);
    setActive(i >= 0 && i < n ? i : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (n === 0) return;
    const moves: Record<string, (i: number) => number> = {
      ArrowLeft: (i) => Math.max(0, i - 1),
      ArrowRight: (i) => Math.min(n - 1, i + 1),
      Home: () => 0,
      End: () => n - 1,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(active ?? n);
    setActive(next);
    setSaid(dayInWords(days[next] as AdminUsageDay));
  };
  const shown = active !== null ? days[active] : undefined;
  const tipLeft = active !== null ? Math.min(Math.max(PAD.left + (active + 0.5) * slot, 90), width - 90) : 0;

  return (
    <figure className="m-0">
      <figcaption className="sr-only">
        {USAGE_CHART_TITLE}: {rows.map((r) => count(r.total, r.unit)).join(', ')}. {USAGE_CHART_NOTE}
      </figcaption>
      <div ref={box} className="relative" style={{ height }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="absolute inset-0 block overflow-visible">
          <defs>
            <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="1.6" height="4" fill="var(--blue)" />
            </pattern>
          </defs>
          {active !== null && (
            <rect x={PAD.left + active * slot} y={0} width={slot} height={height - AXIS_H} fill="var(--blue-wash)" data-usage-band="" />
          )}
          {rows.map((row) => {
            const base = row.y + row.height;
            return (
              <g key={row.key} data-usage-row={row.key}>
                <text x={0} y={row.y - 6} fontSize="10" fontWeight="700" letterSpacing=".08em" fill="var(--ink)" style={{ textTransform: 'uppercase' }}>
                  {row.label}
                </text>
                <text x={width} y={row.y - 6} fontSize="10" textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">
                  {formatCount(row.total)} in 30 days
                </text>
                <line x1={PAD.left} x2={width - PAD.right} y1={row.y + 0.5} y2={row.y + 0.5} stroke="var(--hairline)" strokeWidth="1" />
                <text x={PAD.left - 5} y={row.y + 7} fontSize="9.5" textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">
                  {formatCount(row.scale)}
                </text>
                {days.map((d, i) => {
                  const v = d[row.key];
                  if (v <= 0) return null;
                  const h = Math.max(2, (v / row.scale) * row.height);
                  return <path key={d.day} d={columnPath(xOf(i), base - h, barW, base)} fill={i === today ? `url(#${patternId})` : 'var(--blue)'} opacity={i === today ? 1 : 0.8} />;
                })}
                <line x1={PAD.left} x2={width - PAD.right} y1={base + 0.5} y2={base + 0.5} stroke="var(--rule)" strokeWidth="1" />
              </g>
            );
          })}
          {labelled.map((i) => {
            const cx = PAD.left + (i + 0.5) * slot;
            const anchor = i === today ? 'end' : cx - 24 < PAD.left ? 'start' : 'middle';
            const x = i === today ? PAD.left + (i + 1) * slot : anchor === 'start' ? PAD.left + i * slot : cx;
            return (
              <text key={i} x={x} y={height - 4} fontSize="9.5" textAnchor={anchor} fill="var(--muted)" fontFamily="var(--font-mono)">
                {i === today ? 'Today' : formatUtcDay((days[i] as AdminUsageDay).day, { weekday: false })}
              </text>
            );
          })}
        </svg>
        <div
          tabIndex={0}
          role="group"
          aria-label={`${USAGE_CHART_TITLE}. The arrow keys read one day at a time; the figures are also in the table.`}
          aria-describedby={`${ids}-said`}
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          className="absolute inset-0 cursor-crosshair rounded-[2px] outline-offset-4"
          data-usage-plot=""
        />
        {shown && (
          <div
            role="presentation"
            className="pointer-events-none absolute top-0 z-10 w-[180px] -translate-x-1/2 rounded-chip border border-hairline bg-raised px-2.5 py-1.5 text-meta shadow-[var(--bezel)]"
            style={{ left: tipLeft }}
            data-usage-tooltip=""
          >
            <p className="font-bold text-ink">
              {formatUtcDay(shown.day)}
              {active === today && <span className="font-normal text-muted"> · so far</span>}
            </p>
            <ul className="mt-0.5">
              {USAGE_ROWS.map((row) => (
                <li key={row.key} className="flex items-baseline gap-1.5">
                  <b className="font-mono text-ink">{formatCount(shown[row.key])}</b>
                  <span className="text-muted">{row.label.toLowerCase()}</span>
                </li>
              ))}
              <li className="flex items-baseline gap-1.5">
                <b className="font-mono text-ink">{formatUsd(shown.usd)}</b>
                <span className="text-muted">spent</span>
              </li>
            </ul>
          </div>
        )}
      </div>
      <p id={`${ids}-said`} aria-live="polite" className="sr-only">
        {said}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 basis-64 text-label text-muted">{USAGE_CHART_NOTE}</p>
        <Button variant="ghost" size="sm" aria-expanded={table} aria-controls={`${ids}-table`} onClick={() => setTable(!table)}>
          {table ? 'Hide the figures' : 'Show the figures'}
        </Button>
      </div>
      <div id={`${ids}-table`} hidden={!table} className="mt-2 overflow-x-auto">
        <table className={cx('w-full text-meta', 'min-w-[480px]')}>
          <caption className="sr-only">{USAGE_CHART_TITLE}</caption>
          <thead>
            <tr className="border-b border-hairline text-left text-micro font-bold tracking-caps text-muted uppercase">
              <th scope="col" className="py-1 pr-3 font-bold">
                Day (UTC)
              </th>
              {USAGE_ROWS.map((row) => (
                <th key={row.key} scope="col" className="py-1 pr-3 text-right font-bold">
                  {row.label}
                </th>
              ))}
              <th scope="col" className="py-1 text-right font-bold">
                Spent
              </th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {[...days].reverse().map((d) => (
              <tr key={d.day} className="border-b border-hairline last:border-b-0">
                <th scope="row" className="py-1 pr-3 text-left font-sans font-normal text-ink">
                  {formatUtcDay(d.day)}
                  {d === days[today] && <span className="text-muted"> (today, so far)</span>}
                </th>
                {USAGE_ROWS.map((row) => (
                  <td key={row.key} className="py-1 pr-3 text-right text-ink">
                    {formatCount(d[row.key])}
                  </td>
                ))}
                <td className="py-1 text-right text-ink">{formatUsd(d.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
