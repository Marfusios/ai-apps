import { useId, useState, type ReactNode } from 'react';
import {
  DEFAULT_COMPLETION,
  FACET_TITLE,
  isUnknownFacetValue,
  type FacetBucket,
  type FacetKey,
  type SearchRequest,
  type SearchResponse,
} from '../../../../shared/contracts/search';
import { cx } from '../../lib/cx';
import { formatCount, plural } from '../../lib/format';

export interface FacetsProps {
  response: SearchResponse | undefined;
  request: SearchRequest;
  onChange: (change: Partial<SearchRequest>) => void;
  /** Phone and tablet sheet: no "More filters" fold, everything open. */
  expanded?: boolean;
}

const MORE_FACETS: readonly FacetKey[] = ['light', 'category', 'engine', 'far_part', 'purpose', 'state'];
const LIST_LIMIT = 8;

/** "Initial climb, 58 investigations, selected" for the facet button's accessible name. */
function bucketName(bucket: FacetBucket, selected: boolean): string {
  return `${bucket.label}, ${plural(bucket.count, 'investigation')}${selected ? ', selected' : ''}`;
}

function FacetTitle({ id, children, onClear }: { id: string; children: ReactNode; onClear?: () => void }) {
  return (
    <div className="mb-1.5 flex items-baseline">
      <h3 id={id} className="text-micro font-bold tracking-caps text-ink uppercase">
        {children}
      </h3>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="ml-auto cursor-pointer text-label text-blue hover:underline pointer-coarse:min-h-11"
        >
          clear<span className="sr-only"> {children}</span>
        </button>
      )}
    </div>
  );
}

/**
 * One value: a thin `blue-wash` bar behind the label in proportion to its count,
 * the count right-aligned in mono; selected is a filled blue bar with on-blue
 * bold text (UI_DESIGN §4.2). A real button with a full accessible name (§8).
 */
export function FacetValue({
  bucket,
  max,
  selected,
  onToggle,
}: {
  bucket: FacetBucket;
  max: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const width = max > 0 ? Math.max(3, Math.round((bucket.count / max) * 100)) : 0;
  const unknown = isUnknownFacetValue(bucket.value);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={bucketName(bucket, selected)}
        onClick={onToggle}
        className="group grid w-full cursor-pointer grid-cols-[1fr_34px] items-center gap-x-2 py-0.5 text-left pointer-coarse:min-h-11"
      >
        <span className="relative min-w-0">
          <span
            aria-hidden="true"
            className={cx(
              'absolute inset-y-px left-0 rounded-[2px]',
              selected ? 'w-full bg-blue' : 'bg-blue-wash group-hover:bg-hairline',
            )}
            style={selected ? undefined : { width: `${width}%` }}
          />
          <span
            className={cx(
              'relative block truncate px-1.5 text-meta pointer-coarse:py-[7px]',
              selected ? 'font-bold text-on-blue' : unknown ? 'text-muted' : 'text-ink',
            )}
          >
            {bucket.label}
          </span>
        </span>
        <span className="text-right font-mono text-label text-muted">{formatCount(bucket.count)}</span>
      </button>
    </li>
  );
}

function FacetList({
  facet,
  buckets,
  selected,
  onChange,
  title,
  note,
}: {
  facet: FacetKey;
  buckets: readonly FacetBucket[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  title?: string;
  note?: ReactNode;
}) {
  const id = useId();
  const [all, setAll] = useState(false);
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.count));
  const shown = all ? buckets : buckets.slice(0, LIST_LIMIT);
  const toggle = (value: string): void =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <section aria-labelledby={id} data-facet={facet} className="mt-4 first:mt-0">
      <FacetTitle id={id} onClear={selected.length > 0 ? () => onChange([]) : undefined}>
        {title ?? FACET_TITLE[facet]}
      </FacetTitle>
      <ul>
        {shown.map((bucket) => (
          <FacetValue
            key={bucket.value}
            bucket={bucket}
            max={max}
            selected={selected.includes(bucket.value)}
            onToggle={() => toggle(bucket.value)}
          />
        ))}
      </ul>
      {buckets.length > LIST_LIMIT && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 cursor-pointer text-label text-blue hover:underline">
          {all ? 'Show fewer' : `Show all ${buckets.length}`}
        </button>
      )}
      {note}
    </section>
  );
}

/**
 * The multi-aircraft overlap statement (A14): the aircraft facets (`AIRCRAFT_FACETS`: phase,
 * aircraft, engine, operation, purpose) count an event once per value any of its aircraft
 * has, so their counts can add up to more than the total. Said under Phase, and once above
 * the aircraft facets in More filters (G0 #14).
 */
function OverlapNote({ count, total, counts, className }: { count: number; total: number; counts: string; className?: string }) {
  if (count === 0) return null;
  return (
    <p className={cx('text-label text-muted', className)}>
      {`${count === 1 ? '1 investigation' : `${formatCount(count)} investigations`} here involved more than one aircraft, so ${counts} counts can add up to more than ${formatCount(total)}.`}
    </p>
  );
}

/** Year histogram: completed solid, records outside the completed set hatched (§4.2). */
function Years({
  response,
  request,
  onChange,
}: {
  response: SearchResponse;
  request: SearchRequest;
  onChange: (change: Partial<SearchRequest>) => void;
}) {
  const id = useId();
  const years = response.years;
  if (years.length === 0) return null;
  const max = Math.max(1, ...years.map((y) => y.completed + y.other));
  const from = request.yearFrom;
  const to = request.yearTo;
  const ranged = from !== undefined || to !== undefined;
  const inRange = (year: number): boolean => (from === undefined || year >= from) && (to === undefined || year <= to);
  const pick = (year: number): void =>
    from === year && to === year ? onChange({ yearFrom: undefined, yearTo: undefined }) : onChange({ yearFrom: year, yearTo: year });
  const first = years[0]?.year;
  const last = years[years.length - 1]?.year;
  return (
    <section aria-labelledby={id} className="mt-4">
      <FacetTitle id={id} onClear={ranged ? () => onChange({ yearFrom: undefined, yearTo: undefined }) : undefined}>
        Year
      </FacetTitle>
      <div className="flex h-11 items-end gap-[2px]">
        {years.map((y) => {
          const total = y.completed + y.other;
          const on = inRange(y.year);
          return (
            <button
              key={y.year}
              type="button"
              aria-pressed={ranged && from === y.year && to === y.year}
              aria-label={`${y.year}: ${plural(y.completed, 'completed investigation')}, ${plural(y.other, 'other record')}. Show ${y.year} only.`}
              onClick={() => pick(y.year)}
              className={cx('flex h-full flex-1 cursor-pointer flex-col justify-end', !on && 'opacity-35')}
            >
              {total === 0 ? (
                <span className="block h-px bg-hairline" />
              ) : (
                <>
                  {y.other > 0 && (
                    <span
                      className="block rounded-t-[1px] bg-[repeating-linear-gradient(135deg,var(--blue)_0_1.5px,transparent_1.5px_4px)] opacity-70"
                      style={{ height: `${(y.other / max) * 100}%` }}
                    />
                  )}
                  {y.completed > 0 && (
                    <span
                      className={cx('block bg-blue opacity-55', y.other === 0 && 'rounded-t-[1px]')}
                      style={{ height: `${(y.completed / max) * 100}%` }}
                    />
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-micro text-muted" aria-hidden="true">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-micro text-muted">
        <span
          aria-hidden="true"
          className="inline-block size-2.5 bg-[repeating-linear-gradient(135deg,var(--blue)_0_1.5px,transparent_1.5px_4px)] opacity-70"
        />
        Outside the completed set
      </p>
    </section>
  );
}

function YearRange({ request, onChange, years }: { request: SearchRequest; onChange: FacetsProps['onChange']; years: number[] }) {
  const id = useId();
  if (years.length === 0) return null;
  const select = (label: string, value: number | undefined, set: (v: number | undefined) => void) => (
    <label className="flex items-center gap-1.5 text-meta">
      <span className="text-muted">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
        className="cursor-pointer rounded-badge border border-hairline bg-raised px-1 py-0.5 font-mono text-label text-ink pointer-coarse:min-h-11"
      >
        <option value="">any</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );
  const ranged = request.yearFrom !== undefined || request.yearTo !== undefined;
  return (
    <section aria-labelledby={id} className="mt-4">
      <FacetTitle id={id} onClear={ranged ? () => onChange({ yearFrom: undefined, yearTo: undefined }) : undefined}>
        Date
      </FacetTitle>
      <div className="flex flex-wrap gap-3">
        {select('From', request.yearFrom, (v) =>
          onChange({ yearFrom: v, ...(v !== undefined && request.yearTo !== undefined && v > request.yearTo ? { yearTo: v } : {}) }),
        )}
        {select('to', request.yearTo, (v) =>
          onChange({ yearTo: v, ...(v !== undefined && request.yearFrom !== undefined && v < request.yearFrom ? { yearFrom: v } : {}) }),
        )}
      </div>
    </section>
  );
}

/**
 * The facet column (UI_DESIGN §4.2): Completion first, Mentioned in, Phase,
 * Highest injury, Conditions, Year, then "More filters". Counts are distinct
 * investigations and ignore their own facet's selection.
 */
export function Facets({ response, request, onChange, expanded = false }: FacetsProps) {
  const anyMore = MORE_FACETS.some((f) => (request[f] as readonly string[]).length > 0);
  const [moreOpen, setMoreOpen] = useState(anyMore);
  const mentionedId = useId();
  const moreId = useId();
  if (!response) return <FacetsSkeleton />;
  const set = (facet: FacetKey) => (values: string[]) => onChange({ [facet]: values } as Partial<SearchRequest>);
  const list = (facet: FacetKey, extra?: { title?: string; note?: ReactNode }) => (
    <FacetList
      key={facet}
      facet={facet}
      buckets={response.facets[facet]}
      selected={request[facet] as readonly string[]}
      onChange={set(facet)}
      {...extra}
    />
  );
  const overlap = (counts: string, className: string) => (
    <OverlapNote count={response.multiAircraft} total={response.total} counts={counts} className={className} />
  );
  const completionDefault =
    request.completion.length === DEFAULT_COMPLETION.length && request.completion.every((v) => DEFAULT_COMPLETION.includes(v));
  const showMore = expanded || moreOpen || anyMore;
  const years = response.years.map((y) => y.year);

  return (
    <div className="text-meta">
      <FacetList
        facet="completion"
        buckets={response.facets.completion}
        selected={request.completion}
        onChange={(values) => onChange({ completion: values as SearchRequest['completion'] })}
        note={
          !completionDefault && (
            <button
              type="button"
              onClick={() => onChange({ completion: [...DEFAULT_COMPLETION] })}
              className="mt-1 cursor-pointer text-label text-blue hover:underline"
            >
              Back to completed investigations
            </button>
          )
        }
      />
      {request.q.trim() !== '' && (
        <section aria-labelledby={mentionedId} className="mt-4">
          <FacetTitle
            id={mentionedId}
            onClear={request.mentionedIn !== 'anywhere' ? () => onChange({ mentionedIn: 'anywhere' }) : undefined}
          >
            Mentioned in
          </FacetTitle>
          <ul>
            {(
              [
                ['anywhere', 'Anywhere in the report'],
                ['probable_cause', 'Probable cause'],
              ] as const
            ).map(([value, label]) => (
              <FacetValue
                key={value}
                bucket={{ value, label, count: response.mentionedIn[value] }}
                max={response.mentionedIn.anywhere}
                selected={request.mentionedIn === value}
                onToggle={() => onChange({ mentionedIn: value })}
              />
            ))}
          </ul>
        </section>
      )}
      {list('phase', { note: overlap('phase', 'mt-1.5') })}
      {list('injury')}
      {list('conditions')}
      <Years response={response} request={request} onChange={onChange} />
      {/* While a More filter is active the fold stays open, so there is no toggle to offer. */}
      {!expanded && !anyMore && (
        <button
          type="button"
          aria-expanded={showMore}
          aria-controls={moreId}
          onClick={() => setMoreOpen(!showMore)}
          className="mt-3.5 cursor-pointer text-left text-meta text-blue hover:underline"
        >
          {showMore ? 'Fewer filters' : 'More filters: aircraft, engine, operation, purpose, light, location, date…'}
        </button>
      )}
      <div id={moreId} hidden={!showMore}>
        {overlap('aircraft, engine, operation and purpose', 'mt-4')}
        {list('category')}
        {list('engine')}
        {list('far_part')}
        {list('purpose')}
        {list('light')}
        {list('state')}
        <YearRange request={request} onChange={onChange} years={years} />
      </div>
    </div>
  );
}

function FacetsSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      {[5, 4, 3].map((rows, i) => (
        <div key={i}>
          <div className="mb-2 h-2.5 w-20 rounded-[2px] bg-tint" />
          {Array.from({ length: rows }, (_, j) => (
            <div key={j} className="my-1.5 h-3.5 rounded-[2px] bg-tint opacity-70" style={{ width: `${90 - j * 15}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Number of active filters for the "Filters (n)" chip: a changed cohort counts once. */
export function activeFilterCount(request: SearchRequest): number {
  let n = 0;
  for (const facet of ['phase', 'injury', 'conditions', ...MORE_FACETS] as FacetKey[]) n += (request[facet] as readonly string[]).length;
  const defaultCohort =
    request.completion.length === DEFAULT_COMPLETION.length && request.completion.every((v) => DEFAULT_COMPLETION.includes(v));
  if (!defaultCohort) n += 1;
  if (request.yearFrom !== undefined || request.yearTo !== undefined) n += 1;
  if (request.mentionedIn !== 'anywhere') n += 1;
  return n;
}

