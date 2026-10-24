import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { CaseCard, CaseContextResponse } from '../../../shared/contracts/briefs';
import type { CaseDetail } from '../../../shared/contracts/cases';
import { compareHeading, pageTitle } from '../../../shared/page-titles';
import { caseQuery, configQuery, isNotFound } from '../api';
import { Button } from '../components/Button';
import { DataCaution } from '../components/DataCaution';
import { EVIDENCE_WORDS, GlyphMark } from '../components/EvidenceGlyph';
import { FlightProfile } from '../components/FlightProfile';
import { StatusBadge } from '../components/StatusBadge';
import { cx } from '../lib/cx';
import { formatDate, numberWord } from '../lib/format';
import {
  CAUTION_SHORT,
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
import { briefStepQuery, caseContextQuery } from '../features/brief/api';
import { UnconfirmedTag } from '../features/brief/CaseCard';
import { evidenceAttribution } from '../features/brief/display';
import { COMPARE_LIMIT, CASES_PARAM, readCompare, withCompare } from '../features/explore/url-state';
import { PrintHeader, readBriefRef } from './CasePage';

type SortKey = 'added' | 'date' | 'hours';

const COLUMNS = ['Case', 'When · where', 'Flight', 'Conditions', 'Outcome'] as const;
const AI_COLUMNS = ['Since maint. · AI', 'Established · AI'] as const;
const GRID = 'sm:grid-cols-[30px_1.1fr_1.15fr_1.3fr_0.95fr_1fr]';
const GRID_AI = 'sm:grid-cols-[30px_1.05fr_1fr_1.1fr_0.85fr_0.9fr_0.95fr_1.2fr]';
const PC_PREVIEW = 300;

export const AI_NOTES_GONE_PLURAL = "The AI notes for these cases have expired or aren't yours.";
export const AI_NOTES_FAILED_PLURAL = "The AI notes for these cases didn't load.";
export const AI_READING_FAILED = "The AI reading didn't load.";
/** A case of the brief whose AI reading the evidence check removed (Task 16e, partial display). */
export const AI_READING_NOT_SHOWN = 'AI reading not shown: the check could not confirm it';
/** A timing or classification the check removed, where the strip would otherwise say it was never there. */
export const TIMING_NOT_VERIFIED = 'Timing not verified by the check';
export const CLASSIFICATION_NOT_VERIFIED = 'Classification not verified by the check';

function Cell({ label, children, className, ai = false }: { label: string; children: ReactNode; className?: string; ai?: boolean }) {
  return (
    <div className={cx('min-w-0 border-t border-strip-line px-2.5 py-2 first:border-t-0 sm:border-t-0 sm:border-l', className)}>
      <p className={cx('mb-0.5 text-micro font-bold tracking-caps uppercase sm:hidden', ai ? 'text-magenta' : 'text-blue')}>{label}</p>
      {children}
    </div>
  );
}

/** Flight hours since maintenance as the brief's reading states them, for the hours sort. */
function flightHours(context: CaseContextResponse | undefined): number | null {
  const chip = context?.reading?.timing.find((t) => t.basis === 'flight_hours');
  return chip?.value ?? null;
}

/**
 * The AI columns (UI_DESIGN §4.6): SINCE MAINT. (the big timing value plus the server's
 * timing line) and ESTABLISHED (the classification plus the maintenance line), from the
 * brief's private context. Magenta and labelled, because the AI extracted them.
 */
function AiCells({ ai, detail }: { ai: StripAi; detail: CaseDetail }) {
  const { context, inBrief, failed, retry, card } = ai;
  const reading = context?.reading ?? null;
  if (!reading) {
    const removed = card !== undefined && card.reading === null;
    const note = !inBrief && !removed ? 'Not in this brief' : removed ? AI_READING_NOT_SHOWN : failed ? AI_READING_FAILED : context ? 'No AI reading for this case' : 'Loading the AI reading…';
    const cell = (
      <span className="text-meta text-muted">
        {note}
        {inBrief && failed && (
          <>
            {' '}
            <button type="button" onClick={retry} className="cursor-pointer text-blue hover:underline pointer-coarse:min-h-11">
              Try again
            </button>
          </>
        )}
      </span>
    );
    return (
      <>
        <Cell label={AI_COLUMNS[0]} ai>
          {cell}
        </Cell>
        <Cell label={AI_COLUMNS[1]} ai>
          <span className="text-meta text-muted">{note}</span>
        </Cell>
      </>
    );
  }
  // In a multi-aircraft event, say whose evidence it is: never one aircraft by implication.
  const attribution = evidenceAttribution(detail.ntsbNo, detail.aircraft, reading.evidence);
  const [first, ...rest] = reading.timing;
  const timingLine = context?.lines.find((l) => l.label === 'TIMING')?.text;
  const maintenance = context?.lines.find((l) => l.label === 'MAINTENANCE')?.text;
  const unconfirmed = reading.criteria.some((c) => c.decision === 'unconfirmed');
  return (
    <>
      <Cell label={AI_COLUMNS[0]} ai>
        {first ? (
          <>
            <span className="block font-mono text-[15px] font-bold tracking-mono text-magenta">{first.label}</span>
            {rest.length > 0 && <span className="block font-mono text-label tracking-mono text-magenta">{rest.map((t) => t.label).join(' · ')}</span>}
            {timingLine && <span className="block text-magenta">{timingLine}</span>}
          </>
        ) : card?.notVerified?.includes('timing') ? (
          <span className="block text-muted">{TIMING_NOT_VERIFIED}</span>
        ) : (
          <span className="block text-magenta">Timing not established by this analysis</span>
        )}
        {unconfirmed && <UnconfirmedTag className="mt-1" />}
      </Cell>
      <Cell label={AI_COLUMNS[1]} ai>
        <span className="block font-bold text-magenta">{reading.glyph ? EVIDENCE_WORDS[reading.glyph] : 'Not classified'}</span>
        {!reading.glyph && card?.notVerified?.includes('classification') && <span className="block text-meta text-muted">{CLASSIFICATION_NOT_VERIFIED}</span>}
        {maintenance && <span className="block text-magenta">{maintenance}</span>}
        {attribution && <span className="mt-1 block text-meta text-muted">{attribution}</span>}
      </Cell>
    </>
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

interface StripAi {
  context: CaseContextResponse | undefined;
  inBrief: boolean;
  /** The case's card on the brief's answer: what the check removed (`notVerified`, a removed reading). */
  card?: CaseCard;
  /** The private read failed (not a 404): show it, and offer a retry. */
  failed: boolean;
  retry: () => void;
}

function Strip({ detail, order, onRemove, ai }: { detail: CaseDetail; order: number; onRemove: () => void; ai: StripAi | null }) {
  const multi = detail.aircraft.length > 1;
  const injury = injuryShort(detail.highestInjury);
  const causes = detail.sections.filter((s) => s.kind === 'probable_cause');
  const cause = causes.map((s) => s.text.trim()).join(' ');
  const preview = cause.length > PC_PREVIEW ? `${cause.slice(0, cause.lastIndexOf(' ', PC_PREVIEW))}…` : cause;
  const damage = [...new Set(detail.aircraft.map((a) => (a.damage.code ? a.damage.label : '')).filter(Boolean))];
  const completed = detail.completion.class === 'completed';
  const glyph = ai?.context?.reading?.glyph ?? null;
  return (
    <article
      data-print="keep"
      aria-label={`${detail.ntsbNo}, strip ${order}`}
      className={cx('mb-[9px] grid grid-cols-1 overflow-hidden rounded-[3px] border border-strip-edge bg-raised text-[12px] leading-[1.4] shadow-[0_1px_0_var(--strip-line)]', ai ? GRID_AI : GRID)}
    >
      <div
        aria-hidden="true"
        className="hidden flex-col items-center justify-center gap-1 bg-tint font-mono text-meta font-bold text-muted sm:row-span-2 sm:flex"
      >
        {glyph && <GlyphMark kind={glyph} />}
        {order}
      </div>
      <Cell label="Case">
        <button
          type="button"
          onClick={onRemove}
          data-print="hide"
          className="float-right -mt-1 -mr-1.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-blue-wash hover:text-ink pointer-coarse:size-11"
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
        {completed && !detail.completion.hasProbableCause && (
          <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <StatusBadge kind="completed" />
            <span className="text-meta text-muted">Probable-cause text unavailable</span>
          </span>
        )}
      </Cell>
      {ai && <AiCells ai={ai} detail={detail} />}
      <div className="flex flex-col gap-1 border-t border-dashed border-strip-line px-2.5 pt-1.5 pb-2 sm:col-start-2 sm:col-end-[-1] sm:flex-row sm:items-baseline sm:gap-2.5">
        <span className="flex-none text-micro tracking-caps text-muted uppercase">Probable cause</span>
        <p className={cx('min-w-0 flex-1 font-serif text-[13px] leading-[1.45]', !cause && 'text-muted')}>
          {cause ? preview : 'No probable cause on record.'}
        </p>
        <span className="flex-none text-meta whitespace-nowrap">{sourceLink(detail)}</span>
      </div>
    </article>
  );
}

function PendingStrip({ ntsbNo, order, query, onRemove, ai }: { ntsbNo: string; order: number; query: UseQueryResult<CaseDetail>; onRemove: () => void; ai: boolean }) {
  return (
    <article aria-label={`${ntsbNo}, strip ${order}`} className={cx('mb-[9px] grid grid-cols-1 rounded-[3px] border border-strip-edge bg-raised', ai ? GRID_AI : GRID)}>
      <div aria-hidden="true" className="hidden items-center justify-center bg-tint font-mono text-meta font-bold text-muted sm:flex">
        {order}
      </div>
      <div className="flex items-center gap-3 px-2.5 py-3 text-ui sm:col-start-2 sm:col-end-[-1]">
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
 * Compare (UI_DESIGN §4.6): up to four cases as flight strips. Fields line up down the
 * page; values identical in all collapse into one line. NTSB columns only, unless the
 * page is opened from the viewer's own live brief (`brief`, `step`): then the cases that
 * brief read get the magenta SINCE MAINT. and ESTABLISHED columns from its private context.
 */
export function Compare() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const list = readCompare(params);
  const requested = (params.get(CASES_PARAM) ?? '').split(',').filter((s) => s.trim() !== '').length;
  const queries = useQueries({ queries: list.map((n) => caseQuery(n)) });
  const config = useQuery(configQuery());
  const ref = readBriefRef(params);
  const brief = ref !== null && ref !== 'invalid' ? ref : null;
  // Read once: Compare never polls a brief (a gone one is a 404 and stays gone).
  const briefStep = useQuery({ ...briefStepQuery(brief?.id ?? '', brief?.step ?? 1), enabled: brief !== null, refetchInterval: false });
  const answer = briefStep.data?.result?.kind === 'answer' ? briefStep.data.result : null;
  const briefCases = new Set(answer?.cases.filter((c) => c.reading !== null).map((c) => c.case.ntsbNo) ?? []);
  // Cases of the answer whose AI reading the evidence check removed (partial display): in the brief, without a reading.
  const removedCases = new Set(answer?.cases.filter((c) => c.reading === null).map((c) => c.case.ntsbNo) ?? []);
  const contexts = useQueries({
    queries: list.map((n) => ({ ...caseContextQuery(brief?.id ?? '', brief?.step ?? 1, n), enabled: brief !== null && briefCases.has(n) })),
  });
  const aiOn = list.some((n) => briefCases.has(n) || removedCases.has(n));
  const aiGone = ref === 'invalid' || (brief !== null && isNotFound(briefStep.error));
  const aiFailed = brief !== null && briefStep.isError && !isNotFound(briefStep.error);
  const aiFor = (ntsbNo: string): StripAi | null => {
    if (!aiOn) return null;
    const read = contexts[list.indexOf(ntsbNo)];
    const card = answer?.cases.find((c) => c.case.ntsbNo === ntsbNo);
    return {
      context: read?.data,
      inBrief: briefCases.has(ntsbNo),
      ...(card ? { card } : {}),
      failed: read?.isError === true,
      retry: () => void read?.refetch(),
    };
  };
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
  const hoursOf = (ntsbNo: string): number | null => flightHours(aiFor(ntsbNo)?.context);
  const hasHours = aiOn && list.some((n) => hoursOf(n) !== null);
  if (sort === 'hours' && hasHours) {
    // Cases without flight hours go last; days are never converted into hours.
    strips.sort((a, b) => {
      const ha = hoursOf(a.ntsbNo);
      const hb = hoursOf(b.ntsbNo);
      if (ha === null || hb === null) return (ha === null ? 1 : 0) - (hb === null ? 1 : 0) || a.order - b.order;
      return ha - hb || a.order - b.order;
    });
  }
  const loaded = strips.map((s) => s.query.data).filter((d): d is CaseDetail => d !== undefined);
  const same = loaded.length === list.length ? sameInAll(loaded) : [];
  const title = compareHeading(list.length);
  const back = from ?? `/explore${list.length ? `?${CASES_PARAM}=${list.join(',')}` : ''}`;

  return (
    <div className="mx-auto w-full max-w-page px-4 pt-5 pb-12 sm:px-[26px] sm:pt-[22px]">
      <title>{pageTitle({ kind: 'compare', count: list.length })}</title>
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
                {hasHours && <option value="hours">flight hours since maintenance</option>}
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

      {brief && briefStep.data && (
        <p className="-mt-2 mb-4 text-ui text-muted">
          From your search <span className="font-serif text-ink">“{briefStep.data.question}”</span>
        </p>
      )}
      {/* Rendered before any note, so a gone or failed brief read is announced when it appears. */}
      <div aria-live="polite">
        {aiGone && <p className="-mt-2 mb-4 text-meta text-muted">{AI_NOTES_GONE_PLURAL}</p>}
        {aiFailed && (
          <p className="-mt-2 mb-4 text-meta text-muted">
            {AI_NOTES_FAILED_PLURAL}{' '}
            <button type="button" onClick={() => void briefStep.refetch()} className="cursor-pointer text-blue hover:underline pointer-coarse:min-h-11">
              Try again
            </button>
          </p>
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
          <div aria-hidden="true" className={cx('hidden sm:grid', aiOn ? GRID_AI : GRID)}>
            <span />
            {COLUMNS.map((c) => (
              <span key={c} className="px-2.5 pb-[5px] text-micro font-bold tracking-caps text-blue uppercase">
                {c}
              </span>
            ))}
            {aiOn &&
              AI_COLUMNS.map((c) => (
                <span key={c} className="px-2.5 pb-[5px] text-micro font-bold tracking-caps text-magenta uppercase">
                  {c}
                </span>
              ))}
          </div>
          <div>
            {strips.map((s) =>
              s.query.data ? (
                <Strip key={s.ntsbNo} detail={s.query.data} order={s.order} onRemove={() => remove(s.ntsbNo)} ai={aiFor(s.ntsbNo)} />
              ) : (
                <PendingStrip key={s.ntsbNo} ntsbNo={s.ntsbNo} order={s.order} query={s.query} onRemove={() => remove(s.ntsbNo)} ai={aiOn} />
              ),
            )}
          </div>
          {same.length > 0 && (
            <p className="mt-3.5 border-t border-dashed border-hairline pt-2 text-ui text-muted">
              {list.length === 2 ? 'Same in both' : `Same in all ${numberWord(list.length)}`}:{' '}
              {same.map((v, i) => (
                <Fragment key={v}>
                  {i > 0 && ' · '}
                  <span className="text-ink">{v}</span>
                </Fragment>
              ))}
            </p>
          )}
          <p className="mt-1.5 text-meta text-muted">
            Strip tab = the order the cases were added{aiOn ? ', with the AI’s evidence glyph' : ''}.{' '}
            {sort === 'added'
              ? 'Sorted as added.'
              : sort === 'hours' && hasHours
                ? 'Sorted by flight hours since maintenance; cases without hours go last, and days are never converted into hours.'
                : 'Sorted by date, oldest first; cases without a date go last.'}{' '}
            {aiOn ? (
              <>
                <span className="text-magenta">Magenta columns are the AI’s reading from your brief</span>; check the cited passages in each case.
              </>
            ) : (
              'NTSB data only.'
            )}
          </p>
        </>
      )}
    </div>
  );
}
