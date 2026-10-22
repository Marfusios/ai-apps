import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  DEFAULT_COMPLETION,
  FACET_KEYS,
  FACET_TITLE,
  MAX_PAGE,
  defaultSearchRequest,
  facetValueLabel,
  type FacetKey,
  type RelaxationDrop,
  type SearchRequest,
  type SearchResponse,
} from '../../../shared/contracts/search';
import { searchQuery } from '../api';
import { Chip } from '../components/Chip';
import { SearchBox } from '../components/SearchBox';
import { cx } from '../lib/cx';
import { formatCount, plural } from '../lib/format';
import { AiNoticeBox } from '../features/ai/AiNoticeBox';
import { AskAiButton } from '../features/ai/AskAiButton';
import { useAskAi } from '../features/ai/useAskAi';
import { briefFiltersOf } from '../features/brief/filters';
import { CaseDrawer, type DrawerPosition } from '../features/case/CaseDrawer';
import { COMPARE_FULL_MESSAGE, CompareTray } from '../features/explore/CompareTray';
import { Facets, activeFilterCount } from '../features/explore/Facets';
import { FiltersSheet } from '../features/explore/FiltersSheet';
import { ResultRow } from '../features/explore/ResultRow';
import {
  CASE_PARAM,
  readOpenCase,
  useCompareSelection,
  useExploreRequest,
  withSearchRequest,
  type ToggleResult,
} from '../features/explore/url-state';

interface ExploreLocationState {
  /** The drawer was opened from this list, so closing it can go back one entry. */
  drawerFromList?: boolean;
}

function isDefaultCohort(request: SearchRequest): boolean {
  return request.completion.length === DEFAULT_COMPLETION.length && request.completion.every((v) => DEFAULT_COMPLETION.includes(v));
}

function valuesInWords(facet: FacetKey, values: readonly string[]): string {
  return values.map((v) => facetValueLabel(facet, v)).join(', ');
}

/** The query and filters in words, for the no-results state (UI_DESIGN §5). */
function describeSearch(request: SearchRequest): string[] {
  const words: string[] = [];
  if (request.q.trim()) {
    words.push(`“${request.q.trim()}”${request.mentionedIn === 'probable_cause' ? ' in the probable cause' : ''}`);
  }
  for (const facet of FACET_KEYS) {
    if (facet === 'completion') continue;
    const values = request[facet] as readonly string[];
    if (values.length > 0) words.push(`${FACET_TITLE[facet]}: ${valuesInWords(facet, values)}`);
  }
  if (request.yearFrom !== undefined || request.yearTo !== undefined) {
    words.push(request.yearFrom === request.yearTo ? `in ${request.yearFrom}` : `${request.yearFrom ?? 'any year'} to ${request.yearTo ?? 'now'}`);
  }
  if (!isDefaultCohort(request)) {
    words.push(request.completion.length === 0 ? 'all records' : `records: ${valuesInWords('completion', request.completion).toLowerCase()}`);
  }
  return words;
}

function relaxationLabel(drop: RelaxationDrop, request: SearchRequest): string {
  if (drop === 'completion') return 'include other records';
  if (drop === 'years') return 'any year';
  if (drop === 'mentionedIn') return 'anywhere in the report';
  return `without ${FACET_TITLE[drop]}: ${valuesInWords(drop, request[drop] as readonly string[])}`;
}

function relax(drop: RelaxationDrop): Partial<SearchRequest> {
  if (drop === 'completion') return { completion: [] };
  if (drop === 'years') return { yearFrom: undefined, yearTo: undefined };
  if (drop === 'mentionedIn') return { mentionedIn: 'anywhere' };
  return { [drop]: [] } as Partial<SearchRequest>;
}

function NoResults({ request, response, onChange }: { request: SearchRequest; response: SearchResponse; onChange: (c: Partial<SearchRequest>) => void }) {
  const words = describeSearch(request);
  const suggestions = response.relaxations.filter((r) => r.count > 0);
  return (
    <div className="mt-3 rounded-card border border-hairline bg-raised px-5 py-4 shadow-[var(--bezel)]" role="status">
      <p className="font-serif text-[19px] leading-snug font-semibold">
        {isDefaultCohort(request) ? 'No completed investigations match all of this.' : 'No investigations match all of this.'}
      </p>
      {words.length > 0 && <p className="mt-1 text-ui text-muted">{words.join(' · ')}</p>}
      {suggestions.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-meta text-muted">Try</span>
          {suggestions.map((s) => (
            <Chip key={s.drop} onClick={() => onChange(relax(s.drop))}>
              {relaxationLabel(s.drop, request)} · {plural(s.count, 'case')}
            </Chip>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-ui">Try fewer or different words{words.length > 1 ? ', or remove a filter' : ''}.</p>
      )}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <ul aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="space-y-2 border-t border-hairline py-3">
          <div className="h-3 w-2/5 rounded-[2px] bg-tint" />
          <div className="h-2.5 w-3/5 rounded-[2px] bg-tint opacity-70" />
          <div className="h-3 w-11/12 rounded-[2px] bg-tint opacity-60" />
        </li>
      ))}
    </ul>
  );
}

function ActiveChips({ request, onChange }: { request: SearchRequest; onChange: (c: Partial<SearchRequest>) => void }) {
  const chips: { key: string; label: string; change: Partial<SearchRequest> }[] = [];
  if (request.mentionedIn === 'probable_cause') chips.push({ key: 'm', label: 'Mentioned in: probable cause', change: { mentionedIn: 'anywhere' } });
  if (!isDefaultCohort(request)) {
    chips.push({
      key: 'c',
      label: request.completion.length === 0 ? 'All records' : `Records: ${valuesInWords('completion', request.completion)}`,
      change: { completion: [...DEFAULT_COMPLETION] },
    });
  }
  for (const facet of FACET_KEYS) {
    if (facet === 'completion') continue;
    for (const value of request[facet] as readonly string[]) {
      chips.push({
        key: `${facet}:${value}`,
        label: `${FACET_TITLE[facet]}: ${facetValueLabel(facet, value)}`,
        change: { [facet]: (request[facet] as readonly string[]).filter((v) => v !== value) } as Partial<SearchRequest>,
      });
    }
  }
  if (request.yearFrom !== undefined || request.yearTo !== undefined) {
    chips.push({
      key: 'y',
      label: request.yearFrom === request.yearTo ? `Year: ${request.yearFrom}` : `Years: ${request.yearFrom ?? '…'}–${request.yearTo ?? '…'}`,
      change: { yearFrom: undefined, yearTo: undefined },
    });
  }
  return (
    <>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.change)}
          className="touch-target inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-chip border border-blue bg-raised px-2 py-0.5 text-meta whitespace-nowrap text-blue hover:bg-blue-wash"
        >
          {c.label}
          <X size={11} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">, remove</span>
        </button>
      ))}
    </>
  );
}

function Pager({ response, onPage }: { response: SearchResponse; onPage: (page: number) => void }) {
  const { page, pageSize, total } = response;
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const lastPage = Math.min(MAX_PAGE, Math.ceil(total / pageSize));
  const link = 'cursor-pointer text-blue hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline pointer-coarse:min-h-11';
  return (
    <nav aria-label="Result pages" className="flex items-center gap-4 border-t border-hairline pt-2.5 text-meta text-muted">
      <span>
        {formatCount(first)}–{formatCount(last)} of {formatCount(total)}
      </span>
      <span className="ml-auto" />
      <button type="button" className={link} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <button type="button" className={link} disabled={page >= lastPage} onClick={() => onPage(page + 1)}>
        Next →
      </button>
      {page >= lastPage && total > lastPage * pageSize && <span>Refine the search to see more.</span>}
    </nav>
  );
}

/**
 * Explore: keyword search with facets (UI_DESIGN §4.2). NTSB data only. The query,
 * filters, page, open case and compare selection are all in the URL.
 */
export function Explore() {
  const { request, params, setParams, update } = useExploreRequest();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useQuery(searchQuery(request));
  const response = search.data;
  const openCase = readOpenCase(params);
  const compare = useCompareSelection();
  const [draft, setDraft] = useState(request.q);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerNotice, setDrawerNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const state = (location.state ?? {}) as ExploreLocationState;
  const ai = useAskAi();
  const [askedFrom, setAskedFrom] = useState<'box' | 'nudge'>('box');
  const askAi = (question: string, from: 'box' | 'nudge'): void => {
    setAskedFrom(from);
    void ai.ask(question, briefFiltersOf(request));
  };

  useEffect(() => setDraft(request.q), [request.q]);
  useEffect(() => setDrawerNotice(null), [openCase]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const showNotice = useCallback((text: string | null) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    if (text) noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);

  const toggleCompare = (ntsbNo: string): ToggleResult => {
    const result = compare.toggle(ntsbNo);
    showNotice(result === 'full' ? COMPARE_FULL_MESSAGE : null);
    return result;
  };

  const caseTo = (ntsbNo: string) => {
    const next = new URLSearchParams(params);
    next.set(CASE_PARAM, ntsbNo);
    return { pathname: '/explore', search: `?${next.toString()}` };
  };

  const setCase = (ntsbNo: string, page?: number): void => {
    setParams(
      (current) => {
        const next = page === undefined ? new URLSearchParams(current) : withSearchRequest(current, { ...request, page });
        next.set(CASE_PARAM, ntsbNo);
        return next;
      },
      { replace: true, preventScrollReset: true, state: location.state },
    );
  };

  const closeCase = (): void => {
    if (state.drawerFromList) {
      navigate(-1);
      return;
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(CASE_PARAM);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const stepToPage = async (page: number, pick: 'first' | 'last'): Promise<void> => {
    const next = await queryClient.fetchQuery(searchQuery({ ...request, page }));
    const target = pick === 'first' ? next.rows[0] : next.rows[next.rows.length - 1];
    if (target) setCase(target.ntsbNo, page);
  };

  const rows = response?.rows ?? [];
  const at = openCase ? rows.findIndex((r) => r.ntsbNo === openCase) : -1;
  let position: DrawerPosition | null = null;
  if (response && at >= 0) {
    const lastPage = Math.min(MAX_PAGE, Math.ceil(response.total / response.pageSize));
    position = {
      index: (response.page - 1) * response.pageSize + at + 1,
      total: response.total,
      onPrevious:
        at > 0
          ? () => setCase((rows[at - 1] as (typeof rows)[number]).ntsbNo)
          : response.page > 1
            ? () => void stepToPage(response.page - 1, 'last')
            : null,
      onNext:
        at < rows.length - 1
          ? () => setCase((rows[at + 1] as (typeof rows)[number]).ntsbNo)
          : response.page < lastPage
            ? () => void stepToPage(response.page + 1, 'first')
            : null,
    };
  }

  const filters = activeFilterCount(request);
  const clearAll = (): void => {
    const base = defaultSearchRequest();
    update({ ...base, q: request.q, sort: request.sort });
  };
  const fullPage = openCase
    ? { pathname: `/cases/${openCase}`, search: compare.selected.length ? `?cases=${compare.selected.join(',')}` : '' }
    : '/';
  const listParams = new URLSearchParams(params);
  listParams.delete(CASE_PARAM);
  const listHref = `/explore${listParams.size > 0 ? `?${listParams.toString()}` : ''}`;
  const listHrefFor = (q: string): string => {
    const next = new URLSearchParams(listParams);
    if (q.trim()) next.set('q', q.trim());
    return `/explore${next.size > 0 ? `?${next.toString()}` : ''}`;
  };
  const total = response?.total ?? 0;
  const noun = isDefaultCohort(request)
    ? total === 1
      ? 'completed investigation'
      : 'completed investigations'
    : total === 1
      ? 'investigation'
      : 'investigations';
  const q = request.q.trim();

  return (
    <div className={cx('mx-auto w-full max-w-page px-4 pt-4 pb-10 sm:px-[26px] sm:pt-[22px]', compare.selected.length > 0 && 'pb-24')}>
      <title>{q ? `“${q}” · Explore · Aviation Casebook` : 'Explore · Aviation Casebook'}</title>
      <h1 className="sr-only">Explore NTSB investigations</h1>
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-7">
        <aside aria-label="Filters" className="hidden lg:block">
          <Facets response={response} request={request} onChange={update} />
        </aside>
        <div className="min-w-0">
          <SearchBox
            variant="bar"
            value={draft}
            onChange={setDraft}
            onSearch={(value) => update({ q: value.trim() })}
            onAsk={(value) => askAi(value, 'box')}
            askPhase={askedFrom === 'box' ? ai.phase : 'idle'}
          />
          {ai.notice && askedFrom === 'box' && (
            <AiNoticeBox notice={ai.notice} keywordHref={listHrefFor(draft)} onRetry={() => askAi(draft, 'box')} className="mt-3" />
          )}

          <div className="-mx-4 mt-0.5 flex items-center gap-1.5 overflow-x-auto px-4 py-3 lg:hidden">
            <FiltersSheet
              open={sheetOpen}
              onOpenChange={setSheetOpen}
              response={response}
              request={request}
              onChange={update}
              onClearAll={clearAll}
              trigger={
                <button
                  type="button"
                  className="touch-target inline-flex shrink-0 cursor-pointer items-center rounded-chip border border-blue bg-blue px-2 py-0.5 text-meta font-bold whitespace-nowrap text-on-blue"
                >
                  Filters ({filters})
                </button>
              }
            />
            <ActiveChips request={request} onChange={update} />
          </div>

          <div className="mt-1 mb-1 flex flex-wrap items-baseline gap-x-2.5 text-ui text-muted lg:mt-3.5">
            {response ? (
              <p aria-live="polite">
                <b className="font-serif text-[20px] font-semibold text-ink">{formatCount(total)}</b> {noun}
              </p>
            ) : (
              <p>Searching…</p>
            )}
            <label className="ml-auto flex items-baseline gap-1 text-blue">
              <span className="sr-only">Sort</span>
              <select
                value={request.sort}
                onChange={(e) => update({ sort: e.target.value as SearchRequest['sort'] })}
                className="cursor-pointer appearance-none bg-transparent pr-3 text-right text-ui text-blue pointer-coarse:min-h-11"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                {(q || request.sort === 'relevance') && <option value="relevance">Best match</option>}
              </select>
              <span aria-hidden="true" className="-ml-3 text-label">
                ▾
              </span>
            </label>
          </div>

          {!response && search.isPending && <RowsSkeleton />}
          {!response && search.isError && (
            <div role="alert" className="mt-3 rounded-card border border-hairline bg-raised px-5 py-4">
              <p className="font-serif text-[19px] font-semibold">The search didn’t finish.</p>
              <p className="mt-1 text-ui text-muted">Something went wrong before results were ready.</p>
              <button type="button" onClick={() => search.refetch()} className="mt-2 cursor-pointer text-ui text-blue hover:underline">
                Try again
              </button>
            </div>
          )}
          {response && response.total === 0 && <NoResults request={request} response={response} onChange={update} />}
          {response && rows.length > 0 && (
            <>
              <ol aria-label="Results" aria-busy={search.isFetching} className={cx('transition-opacity', search.isPlaceholderData && 'opacity-60')}>
                {rows.map((row) => (
                  <ResultRow
                    key={row.ntsbNo}
                    row={row}
                    caseTo={caseTo(row.ntsbNo)}
                    inCompare={compare.selected.includes(row.ntsbNo)}
                    onToggleCompare={() => toggleCompare(row.ntsbNo)}
                  />
                ))}
              </ol>
              <Pager response={response} onPage={(page) => update({ page })} />
              <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-card border border-magenta-soft bg-magenta-wash px-3 py-2 text-ui">
                <span>Want these grouped and explained? Ask the AI with these filters.</span>
                <AskAiButton size="sm" className="ml-auto" onAsk={() => askAi(draft, 'nudge')} phase={askedFrom === 'nudge' ? ai.phase : 'idle'} />
              </div>
              {ai.notice && askedFrom === 'nudge' && (
                <AiNoticeBox notice={ai.notice} keywordHref={listHrefFor(draft)} onRetry={() => askAi(draft, 'nudge')} className="mt-3" />
              )}
            </>
          )}
        </div>
      </div>

      <CompareTray selected={compare.selected} onRemove={compare.remove} notice={notice} from={listHref} />
      <CaseDrawer
        ntsbNo={openCase}
        onClose={closeCase}
        position={position}
        inCompare={openCase ? compare.selected.includes(openCase) : false}
        onToggleCompare={() => {
          if (!openCase) return;
          const result = toggleCompare(openCase);
          setDrawerNotice(result === 'full' ? COMPARE_FULL_MESSAGE : null);
        }}
        compareNotice={drawerNotice}
        fullPage={fullPage}
        fullPageState={{ from: listHref }}
        matched={q && at >= 0 ? (rows[at]?.snippet ?? null) : null}
      />
    </div>
  );
}
