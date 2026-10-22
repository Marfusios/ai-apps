import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { CaseDetail, Caution } from '../../../shared/contracts/cases';
import { caseQuery, configQuery, isNotFound } from '../api';
import { Button } from '../components/Button';
import { DataCaution } from '../components/DataCaution';
import { FlightProfile } from '../components/FlightProfile';
import { StatusBadge } from '../components/StatusBadge';
import { cx } from '../lib/cx';
import { formatDate, numberWord } from '../lib/format';
import {
  aircraftName,
  conditionsLines,
  injuryShort,
  injurySummary,
  letterOf,
  lightWord,
  operationLine,
  phaseEventShort,
  placeShort,
  profileSteps,
} from '../features/case/display';
import { COMPARE_LIMIT, CASES_PARAM, readCompare, withCompare } from '../features/explore/url-state';
import { PrintHeader } from './CasePage';

type SortKey = 'added' | 'date';

const CAUTION_SHORT: Readonly<Record<Caution['kind'], string>> = {
  status_blank: 'status blank',
  status_conflict: 'status',
  injury_mismatch: 'injury codes',
  shared_narrative: 'shared narrative',
  defining_event_conflict: 'defining event',
};

const COLUMNS = ['Case', 'When · where', 'Flight', 'Conditions', 'Outcome'] as const;
const GRID = 'sm:grid-cols-[30px_1.1fr_1.15fr_1.3fr_0.95fr_1fr]';
const PC_PREVIEW = 300;

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 border-t border-strip-line px-2.5 py-2 first:border-t-0 sm:border-t-0 sm:border-l', className)}>
      <p className="mb-0.5 text-micro font-bold tracking-caps text-blue uppercase sm:hidden">{label}</p>
      {children}
    </div>
  );
}

function sourceLink(detail: CaseDetail) {
  const report = detail.report;
  return report.kind === 'report' ? (
    <a href={report.url} target="_blank" rel="noopener noreferrer" className="text-blue hover:underline">
      NTSB report ↗
    </a>
  ) : (
    <a
      href={report.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${report.note}. Opens NTSB aviation search; look up ${detail.ntsbNo}.`}
      className="text-blue hover:underline"
    >
      Search NTSB ↗<span className="sr-only"> (direct report link unavailable)</span>
    </a>
  );
}

function Strip({ detail, order, onRemove }: { detail: CaseDetail; order: number; onRemove: () => void }) {
  const multi = detail.aircraft.length > 1;
  const injury = injuryShort(detail.highestInjury);
  const causes = detail.sections.filter((s) => s.kind === 'probable_cause');
  const cause = causes.map((s) => s.text.trim()).join(' ');
  const preview = cause.length > PC_PREVIEW ? `${cause.slice(0, cause.lastIndexOf(' ', PC_PREVIEW))}…` : cause;
  const damage = [...new Set(detail.aircraft.map((a) => (a.damage.code ? a.damage.label : '')).filter(Boolean))];
  const completed = detail.completion.class === 'completed';
  return (
    <article
      data-print="keep"
      aria-label={`${detail.ntsbNo}, strip ${order}`}
      className={cx('mb-[9px] grid grid-cols-1 overflow-hidden rounded-[3px] border border-strip-edge bg-raised text-[12px] leading-[1.4] shadow-[0_1px_0_var(--strip-line)]', GRID)}
    >
      <div
        aria-hidden="true"
        className="hidden items-center justify-center bg-tint font-mono text-meta font-bold text-muted sm:row-span-2 sm:flex"
      >
        {order}
      </div>
      <Cell label="Case">
        <button
          type="button"
          onClick={onRemove}
          data-print="hide"
          className="float-right -mt-0.5 -mr-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-blue-wash hover:text-ink pointer-coarse:size-11"
        >
          <X size={12} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">Remove {detail.ntsbNo} from compare</span>
        </button>
        <Link to={`/cases/${detail.ntsbNo}`} className="font-mono font-bold tracking-mono text-blue hover:underline">
          {detail.ntsbNo}
        </Link>
        {detail.aircraft.map((a, i) => (
          <div key={a.aircraftKey}>
            <span className="block font-bold">
              {multi && <span className="mr-1 font-mono text-muted">{letterOf(detail.ntsbNo, a, i)}</span>}
              {aircraftName(a)}
            </span>
            <span className="block font-mono text-label tracking-mono text-muted uppercase">
              {[a.registration, a.category.code && a.category.code !== 'AIR' ? a.category.code : null].filter(Boolean).join(' · ')}
            </span>
          </div>
        ))}
      </Cell>
      <Cell label="When · where">
        <span className="block">{formatDate(detail.date)}</span>
        <span className="block">{placeShort(detail.city, detail.state, detail.country)}</span>
        <span className="block text-muted">{[...new Set(detail.aircraft.map(operationLine))].join(' / ')}</span>
        {detail.cautions.map((c) => (
          <DataCaution key={c.kind} variant="chip" className="mt-1">
            {CAUTION_SHORT[c.kind]}
          </DataCaution>
        ))}
      </Cell>
      <Cell label="Flight">
        {detail.aircraft.map((a, i) => (
          <div key={a.aircraftKey} className={cx(i > 0 && 'mt-1.5')}>
            <FlightProfile steps={profileSteps(detail, a.aircraftKey)} size="mini" caption={false} />
            <span className="block font-mono text-label tracking-mono text-muted uppercase">
              {multi && `${letterOf(detail.ntsbNo, a, i)} · `}
              {phaseEventShort(a)}
            </span>
          </div>
        ))}
      </Cell>
      <Cell label="Conditions">
        {conditionsLines(detail.weather).map((line) => (
          <span key={line} className="block font-mono tracking-mono uppercase">
            {line}
          </span>
        ))}
      </Cell>
      <Cell label="Outcome">
        <span className={cx('block', injury.fatal && 'font-bold')}>{injurySummary(detail)}</span>
        <span className="block text-muted">{damage.join(' / ') || 'Damage not reported'}</span>
        {!completed && <StatusBadge kind={detail.completion.class} rawStatus={detail.completion.rawStatus} className="mt-1" />}
      </Cell>
      <div className="flex flex-col gap-1 border-t border-dashed border-strip-line px-2.5 pt-1.5 pb-2 sm:col-start-2 sm:col-end-[-1] sm:flex-row sm:items-baseline sm:gap-2.5">
        <span className="flex-none text-[9px] tracking-caps text-muted uppercase">Probable cause</span>
        <p className={cx('min-w-0 flex-1 font-serif text-[13px] leading-[1.45]', !cause && 'text-muted')}>
          {cause ? preview : completed ? 'Probable-cause text unavailable.' : 'No probable cause on record.'}
        </p>
        <span className="flex-none text-meta whitespace-nowrap">{sourceLink(detail)}</span>
      </div>
    </article>
  );
}

function PendingStrip({ ntsbNo, order, query, onRemove }: { ntsbNo: string; order: number; query: UseQueryResult<CaseDetail>; onRemove: () => void }) {
  return (
    <article aria-label={`${ntsbNo}, strip ${order}`} className={cx('mb-[9px] grid grid-cols-1 rounded-[3px] border border-strip-edge bg-raised', GRID)}>
      <div aria-hidden="true" className="hidden items-center justify-center bg-tint font-mono text-meta font-bold text-muted sm:flex">
        {order}
      </div>
      <div className="flex items-center gap-3 px-2.5 py-3 text-ui sm:col-span-5">
        <span className="font-mono font-bold tracking-mono text-blue">{ntsbNo}</span>
        {query.isError ? (
          <span className="text-muted">
            {isNotFound(query.error) ? 'No investigation has that number.' : 'This case didn’t load.'}{' '}
            {!isNotFound(query.error) && (
              <button type="button" onClick={() => query.refetch()} className="cursor-pointer text-blue hover:underline">
                Try again
              </button>
            )}
          </span>
        ) : (
          <span className="h-3 flex-1 rounded-[2px] bg-tint" aria-hidden="true" />
        )}
        <button type="button" onClick={onRemove} className="ml-auto cursor-pointer text-meta text-blue hover:underline">
          Remove<span className="sr-only"> {ntsbNo}</span>
        </button>
      </div>
    </article>
  );
}

/** Values identical in every case, in words: "VMC · daylight · substantial damage · no fatalities". */
export function sameInAll(details: readonly CaseDetail[]): string[] {
  if (details.length < 2) return [];
  const same = (pick: (d: CaseDetail) => string | null): string | null => {
    const values = details.map(pick);
    const first = values[0] ?? null;
    return first !== null && values.every((v) => v === first) ? first : null;
  };
  const single = (values: readonly string[]): string | null => {
    const set = [...new Set(values.filter(Boolean))];
    return set.length === 1 ? (set[0] as string) : null;
  };
  return [
    same((d) => (d.weather.basic.code && d.weather.basic.code !== 'UNK' ? d.weather.basic.code : null)),
    same((d) => lightWord(d.weather.light)),
    same((d) => single(d.aircraft.map((a) => (a.damage.code ? a.damage.label.toLowerCase() : '')))),
    same((d) => (d.highestInjury.code === null || d.highestInjury.code === 'UNK' ? null : d.highestInjury.code === 'FATL' ? 'fatal' : 'no fatalities')),
    same((d) => single(d.aircraft.map((a) => (a.category.code ? `${a.category.label.toLowerCase()}s` : '')))),
    same((d) => single(d.aircraft.map((a) => (a.farPart.code ? a.farPart.label : '')))),
    same((d) => (d.completion.class === 'completed' ? 'completed investigations' : null)),
  ].filter((v): v is string => v !== null);
}

/**
 * Compare (UI_DESIGN §4.6): up to four cases as flight strips, NTSB columns only.
 * Fields line up down the page; values identical in all collapse into one line.
 */
export function Compare() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const list = readCompare(params);
  const requested = (params.get(CASES_PARAM) ?? '').split(',').filter((s) => s.trim() !== '').length;
  const queries = useQueries({ queries: list.map((n) => caseQuery(n)) });
  const config = useQuery(configQuery());
  const [sort, setSort] = useState<SortKey>('added');
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const from = (location.state as { from?: string } | null)?.from;

  const remove = (ntsbNo: string): void =>
    setParams((current) => withCompare(current, readCompare(current).filter((n) => n !== ntsbNo)), {
      replace: true,
      state: location.state,
    });
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), 2500);
  };

  const strips = list.map((ntsbNo, i) => ({ ntsbNo, order: i + 1, query: queries[i] as UseQueryResult<CaseDetail> }));
  if (sort === 'date') {
    strips.sort((a, b) => {
      const da = a.query.data?.date ?? '9999';
      const db = b.query.data?.date ?? '9999';
      return da.localeCompare(db) || a.order - b.order;
    });
  }
  const loaded = strips.map((s) => s.query.data).filter((d): d is CaseDetail => d !== undefined);
  const same = loaded.length === list.length ? sameInAll(loaded) : [];
  const title = `Comparing ${list.length} ${list.length === 1 ? 'case' : 'cases'}`;
  const back = from ?? `/explore${list.length ? `?${CASES_PARAM}=${list.join(',')}` : ''}`;

  return (
    <div className="mx-auto w-full max-w-page px-4 pt-5 pb-12 sm:px-[26px] sm:pt-[22px]">
      <title>{`${title} · Aviation Casebook`}</title>
      <PrintHeader title={title} cases={list} snapshotDate={config.data?.snapshotDate ?? null} />
      <nav data-print="hide" className="text-ui">
        <Link to={back} className="text-blue hover:underline">
          ← Back to results
        </Link>
      </nav>
      <div className="mt-1.5 mb-4 flex flex-wrap items-end gap-x-4 gap-y-2">
        <h1 className="font-serif text-headline font-semibold tracking-headline">{title}</h1>
        {list.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2" data-print="hide">
            <label className="relative inline-flex items-center rounded-full border-[1.5px] border-blue text-meta text-blue hover:bg-blue-wash">
              <span className="pl-[11px]">Sort:</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="cursor-pointer appearance-none bg-transparent py-[3px] pr-6 pl-1 text-meta text-blue [field-sizing:content] pointer-coarse:min-h-11"
              >
                <option value="added">as added</option>
                <option value="date">date, oldest first</option>
              </select>
              <span aria-hidden="true" className="pointer-events-none absolute right-2.5 text-label">
                ▾
              </span>
            </label>
            <Button variant="search" size="sm" onClick={() => window.print()}>
              Print for class
            </Button>
            <Button variant="search" size="sm" onClick={copy}>
              {copied === 'copied' ? 'Link copied' : 'Copy link'}
            </Button>
            <span role="status" className="sr-only">
              {copied === 'copied' ? 'Link copied' : copied === 'failed' ? 'Copy failed; use the address bar.' : ''}
            </span>
          </div>
        )}
      </div>

      {requested > COMPARE_LIMIT && (
        <p className="mb-3 text-meta text-muted">Compare holds four cases; the first four in the link are shown.</p>
      )}

      {list.length === 0 ? (
        <div className="card px-6 py-6">
          <p className="font-serif text-[19px] font-semibold">Nothing to compare yet.</p>
          <p className="mt-1 text-ui text-muted">
            Tick Compare on up to four cases in{' '}
            <Link to="/explore" className="link">
              Explore
            </Link>
            , then open them here as flight strips.
          </p>
        </div>
      ) : (
        <>
          <div aria-hidden="true" className={cx('hidden sm:grid', GRID)}>
            <span />
            {COLUMNS.map((c) => (
              <span key={c} className="px-2.5 pb-[5px] text-micro font-bold tracking-caps text-blue uppercase">
                {c}
              </span>
            ))}
          </div>
          <div>
            {strips.map((s) =>
              s.query.data ? (
                <Strip key={s.ntsbNo} detail={s.query.data} order={s.order} onRemove={() => remove(s.ntsbNo)} />
              ) : (
                <PendingStrip key={s.ntsbNo} ntsbNo={s.ntsbNo} order={s.order} query={s.query} onRemove={() => remove(s.ntsbNo)} />
              ),
            )}
          </div>
          {same.length > 0 && (
            <p className="mt-3.5 border-t border-dashed border-hairline pt-2 text-ui text-muted">
              Same in all {numberWord(list.length)}:{' '}
              {same.map((v, i) => (
                <Fragment key={v}>
                  {i > 0 && ' · '}
                  <span className="text-ink">{v}</span>
                </Fragment>
              ))}
            </p>
          )}
          <p className="mt-1.5 text-meta text-muted">
            Strip tab = the order the cases were added.{' '}
            {sort === 'added' ? 'Sorted as added.' : 'Sorted by date, oldest first; cases without a date go last.'} NTSB data only.
          </p>
        </>
      )}
    </div>
  );
}
