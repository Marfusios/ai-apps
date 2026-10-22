import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { YearBucket } from '../../../../shared/contracts/search';
import { formatCount, plural } from '../../lib/format';
import { exploreHref } from './links';

const HEIGHT = 150;
const PAD = { top: 8, right: 4, bottom: 20, left: 38 };

/** Gridline values: about four, at 1, 2 or 5 times a power of ten. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10] as const).map((m) => m * pow).find((s) => s >= rough) ?? pow * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

/**
 * Completed vs other records per year, as SVG sized to its container (so the
 * hatching and text keep their proportions). Other records are hatched. A button
 * per year opens Explore for that year; a visually hidden table gives the figures.
 */
export function YearChart({ years, cohort }: { years: readonly YearBucket[]; cohort: 'default' | 'all' }) {
  const navigate = useNavigate();
  const patternId = `hatch-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = years.length;
  const max = Math.max(1, ...years.map((y) => y.completed + y.other));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? max;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, slot * 0.74);
  const y = (v: number): number => PAD.top + plotH - (v / top) * plotH;
  const labelStep = Math.max(1, Math.ceil(30 / slot));
  const fullYear = slot * labelStep >= 40;

  return (
    <div>
      <div ref={box} className="relative" style={{ height: HEIGHT }}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          aria-hidden="true"
          className="absolute inset-0 block overflow-visible"
        >
          <defs>
            <pattern id={patternId} width="4.5" height="4.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="1.6" height="4.5" fill="var(--blue)" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--hairline)"
                strokeWidth="1"
                strokeDasharray={t === 0 ? undefined : '2 3'}
              />
              <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--muted)" fontFamily="var(--font-mono)">
                {formatCount(t)}
              </text>
            </g>
          ))}
          {years.map((b, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const yc = y(b.completed);
            const yo = y(b.completed + b.other);
            return (
              <g key={b.year}>
                {b.completed > 0 && <rect x={x} y={yc} width={barW} height={y(0) - yc} fill="var(--blue)" opacity=".8" />}
                {b.other > 0 && (
                  <>
                    <rect x={x} y={yo} width={barW} height={yc - yo} fill={`url(#${patternId})`} opacity=".75" />
                    <line x1={x} x2={x + barW} y1={yo + 0.5} y2={yo + 0.5} stroke="var(--blue)" strokeWidth="1" opacity=".75" />
                  </>
                )}
                {i % labelStep === 0 && (
                  <text x={x + barW / 2} y={HEIGHT - 5} textAnchor="middle" fontSize="9" fill="var(--muted)" fontFamily="var(--font-mono)">
                    {fullYear ? b.year : `'${String(b.year).slice(2)}`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {years.map((b, i) => (
          <button
            key={b.year}
            type="button"
            aria-label={`${b.year}: ${plural(b.completed, 'completed investigation')}, ${plural(b.other, 'other record')}. Open ${b.year} in Explore, which shows ${plural(cohort === 'all' ? b.completed + b.other : b.completed, 'investigation')}.`}
            title={`${b.year}: ${formatCount(b.completed)} completed, ${formatCount(b.other)} other`}
            onClick={() => void navigate(exploreHref(cohort, { year: b.year }))}
            className="absolute cursor-pointer rounded-[2px] hover:bg-blue-wash focus-visible:bg-blue-wash"
            style={{
              left: PAD.left + i * slot,
              width: slot,
              top: PAD.top,
              height: plotH,
            }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <i aria-hidden="true" className="inline-block size-2.5 bg-blue opacity-80" />
          Completed
        </li>
        <li className="flex items-center gap-1.5">
          <i
            aria-hidden="true"
            className="inline-block size-2.5 border-t border-blue bg-[repeating-linear-gradient(135deg,var(--blue)_0_1.5px,transparent_1.5px_4px)] opacity-75"
          />
          Other records (in progress or status unknown)
        </li>
      </ul>
      <div className="sr-only">
        <table>
          <caption>Investigations by event year: completed and other records</caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">Completed</th>
              <th scope="col">Other records</th>
            </tr>
          </thead>
          <tbody>
            {years.map((b) => (
              <tr key={b.year}>
                <th scope="row">{b.year}</th>
                <td>{b.completed}</td>
                <td>{b.other}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
