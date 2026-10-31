import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { EVIDENCE_CANDIDATE_CEILING, EVIDENCE_PAGE_SIZE, EvidenceSearchIdSchema, type EvidenceCase, type EvidencePage } from '../../../shared/contracts/evidence';
import { pageTitle } from '../../../shared/page-titles';
import { ApiError, configQuery, isNotFound } from '../api';
import { documentTitle } from '../brand';
import { Button } from '../components/Button';
import { Placard } from '../components/Placard';
import { SearchBox } from '../components/SearchBox';
import { arrived, departed } from '../features/ai/unsettled';
import { rememberedQuestion } from '../features/brief/memory';
import { CaseDrawer, type DrawerPosition } from '../features/case/CaseDrawer';
import { evidencePageQuery } from '../features/evidence/api';
import { AiNoticeBox } from '../features/ai/AiNoticeBox';
import {
  EMPTY_TITLE,
  EVIDENCE_HEADING,
  EXPIRED_TEXT,
  EXPIRED_TITLE,
  LOAD_FAILED,
  PAGE_FAILED,
  TINY_RESULTS,
  UNDO_CHARGED,
  allShownLine,
  arrivalLine,
  countLine,
  expiryLine,
  filtersInWords,
  queryWords,
  relevanceContext,
  searchedInWords,
  showMoreLabel,
  showingLine,
  tinyTitle,
  withoutFiltersLabel,
} from '../features/evidence/display';
import { EvidenceCard } from '../features/evidence/EvidenceCard';
import { EvidenceHint } from '../features/evidence/Hint';
import { SearchPanel } from '../features/evidence/SearchPanel';
import { SearchRating } from '../features/evidence/SearchRating';
import { SearchWait } from '../features/evidence/SearchWait';
import { takeArrival } from '../features/evidence/arrival';
import { PAGES_PARAM, evidencePath } from '../features/evidence/keys';
import { undoWasCharged } from '../features/evidence/undo';
import { MatchLegend } from '../features/evidence/MatchedText';
import { CapabilityNote, EvidenceNotice } from '../features/evidence/Notice';
import { useEvidenceSearch } from '../features/evidence/useEvidenceSearch';
import { COMPARE_FULL_MESSAGE, CompareTray } from '../features/explore/CompareTray';
import { CASE_PARAM, readOpenCase, useCompareSelection } from '../features/explore/url-state';
import { cx } from '../lib/cx';
import { PrintHeader } from './CasePage';

const MAX_PAGES = EVIDENCE_CANDIDATE_CEILING / EVIDENCE_PAGE_SIZE;

/** `?pages=n`: how many pages of the pinned ranking are shown (1 to 10; anything else is 1). */
export function readPages(params: URLSearchParams): number {
  const raw = params.get(PAGES_PARAM) ?? '';
  const n = /^\d{1,2}$/.test(raw) ? Number(raw) : 1;
  return n >= 1 && n <= MAX_PAGES ? n : 1;
}

const pill = 'inline-flex items-center rounded-full border-[1.5px] border-blue px-3.5 py-[5px] text-ui font-bold text-blue hover:bg-blue-wash pointer-coarse:min-h-11';

/**
 * An expired or unknown search (UI_DESIGN §4.9, §5): the server keeps nothing to restore. If
 * this page still holds the question in memory, [Ask again] refills the box; the question is
 * never in browser storage. Ask AI here starts a new evidence search.
 */
function Expired({ id }: { id: string }) {
  const remembered = rememberedQuestion(id);
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const ai = useEvidenceSearch();
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const keyword = value.trim() ? `/explore?${new URLSearchParams({ q: value.trim() }).toString()}` : '/explore';
  return (
    <div className="mx-auto w-full max-w-reading px-4 pt-8 pb-12 sm:pt-12">
      <title>{documentTitle('AI search expired')}</title>
      <div className="card px-5 py-4">
        <h1 className="font-serif text-[19px] leading-snug font-semibold">{EXPIRED_TITLE}</h1>
        <p className="mt-1 text-ui text-muted">{EXPIRED_TEXT}</p>
        {remembered && (
          <Button
            variant="search"
            size="sm"
            className="mt-2.5"
            onClick={() => {
              setValue(remembered);
              input.current?.focus();
            }}
          >
            Ask again
          </Button>
        )}
      </div>
      <SearchBox
        variant="home"
        value={value}
        onChange={setValue}
        inputRef={input}
        onSearch={(q) => navigate(q.trim() ? `/explore?${new URLSearchParams({ q: q.trim() }).toString()}` : '/explore')}
        onAsk={(q) => void ai.ask(q)}
        askPhase={ai.phase}
        className="mt-4"
      />
      <SearchWait pending={ai.pending} className="mt-3" />
      <AiNoticeBox notice={ai.notice} keywordHref={keyword} onRetry={() => void ai.ask(value)} className="mt-3" />
    </div>
  );
}

/**
 * An empty or tiny result (UI_DESIGN §4.9): the filters and words the search ran with (a state
 * AirCase applied on its own tagged "from your question", and the terms it added), and the free
 * way out.
 */
function FewResults({ search }: { search: EvidencePage }) {
  const terms = queryWords(search);
  const words = filtersInWords(search.appliedFilters, search.automaticFilters);
  return (
    <div className="card mt-3 px-4 py-3.5" data-few-results="">
      <p className="font-serif text-[18px] leading-tight font-semibold">{search.total === 0 ? EMPTY_TITLE : tinyTitle(search.total)}</p>
      <p className="mt-1 text-ui text-muted" data-few-results-search="">
        {[words.length > 0 ? `Filters: ${words.join(' · ')}` : 'No filters', ...searchedInWords(search)].join(' · ')}
      </p>
      <div className="mt-2.5">
        <Link to={`/explore?${new URLSearchParams({ q: terms }).toString()}`} className={pill}>
          {withoutFiltersLabel(terms)}
          <span className="sr-only"> (free)</span>
        </Link>
      </div>
    </div>
  );
}

/**
 * The AI evidence view (UI_DESIGN §4.9; contract `evidence.v3`): the question as asked, what the
 * search ran with (the question, or the reader's own words and filters, editable, and what AirCase
 * added on its own, said as such and free to undo) and the AI's suggestion beside it, never applied
 * unless the reader chooses it, a hint for an explicit counting or comparison request, a fixed
 * capability note when the question's intent selects one (nothing blocks a search), then the
 * investigations retrieved under the fixed heading and notice, as cards of NTSB text and coded
 * data, highest-ranked first or with the leading ones in AI's order (the count line says which),
 * ten at a time ("Show more" is free and reads the pinned ranking), and under them "Was this search
 * useful?" (§4.11). While a search the page asks for runs, its checklist shows where the reader
 * waits (§4.10). The drawer, Compare and print show the same projection and the notice. Every read
 * is the viewer's own; a search that is gone, or not theirs, shows the expired state.
 */
export function Evidence() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const valid = EvidenceSearchIdSchema.safeParse(id).success;
  const wantedPages = readPages(params);
  const first = useQuery({ ...evidencePageQuery(id, 1), enabled: valid });
  const lastPage = first.data ? Math.max(1, Math.min(wantedPages, first.data.pages)) : 1;
  const later = useQueries({
    queries: Array.from({ length: lastPage - 1 }, (_, i) => ({ ...evidencePageQuery(id, i + 2), enabled: valid })),
  });
  const config = useQuery(configQuery()).data;
  const openCase = readOpenCase(params);
  const compare = useCompareSelection();
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerNotice, setDrawerNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // The first card a "Show more" brought, to give it focus once it is on screen.
  const focusRank = useRef<number | null>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  // Alternates a trailing space, so the same words said twice in a row are announced twice.
  const said = useRef(false);
  const announce = (text: string): void => {
    said.current = !said.current;
    setAnnouncement(said.current ? text : `${text}\u00a0`);
  };

  // An AI search answered 2xx is settled once this page is on screen for it (web/src/features/ai/unsettled.ts).
  useLayoutEffect(() => {
    if (!valid) return;
    arrived(id, null);
    return () => departed(id, null);
  }, [id, valid]);

  const search = first.data;
  const pages = [search, ...later.map((q) => q.data)];
  // Pages read so far, in order; a page still on its way ends the list.
  const loaded: EvidencePage[] = [];
  for (const p of pages) {
    if (!p) break;
    loaded.push(p);
  }
  const cases: EvidenceCase[] = loaded.flatMap((p) => p.cases);
  const gone = !valid || isNotFound(first.error) || later.some((q) => isNotFound(q.error));
  const loadingMore = later.some((q) => q.isPending && q.fetchStatus !== 'idle');
  const moreFailed = later.find((q) => q.isError && !isNotFound(q.error));

  useEffect(() => {
    const rank = focusRank.current;
    if (rank === null || !cases.some((c) => c.rank === rank)) return;
    focusRank.current = null;
    document.querySelector<HTMLElement>(`article[data-rank="${rank}"] [data-case-trigger]`)?.focus();
    announce(`${showingLine(cases.length, search?.total ?? cases.length)}.`);
  }, [cases, search?.total]);

  // A search this tab just asked for (Ask AI, Search again, Apply) is announced on arrival, and
  // takes focus to its results heading if focus was lost on the way (as a brief's finished step).
  useEffect(() => {
    if (!search || !takeArrival(search.id)) return;
    // A free-looking undo the server counted after all says so (its page says it too).
    announce(undoWasCharged(search.id) ? `${arrivalLine(search.total)} ${UNDO_CHARGED}` : arrivalLine(search.total));
    if (document.activeElement === document.body || document.activeElement === null) resultsHeading.current?.focus({ preventScroll: true });
  }, [search]);

  const liveText = gone ? EXPIRED_TITLE : !search && first.isError ? LOAD_FAILED : announcement;
  const live = (
    <p aria-live="polite" className="sr-only" data-evidence-live="">
      {liveText}
    </p>
  );

  if (gone) {
    return (
      <>
        {live}
        <Expired id={id} />
      </>
    );
  }
  if (!search) {
    return (
      <>
        {live}
        <div className="mx-auto w-full max-w-reading px-4 pt-6 pb-12">
          <title>{pageTitle({ kind: 'evidence' })}</title>
          {first.isError ? (
            <div className="card px-5 py-4">
              <p className="font-serif text-[19px] font-semibold">{LOAD_FAILED}</p>
              <p className="mt-1 text-ui text-muted">
                {first.error instanceof ApiError && first.error.status === 429 ? 'Too many requests; wait a moment.' : 'Check your connection and try again.'}
              </p>
              <button type="button" onClick={() => void first.refetch()} className="mt-2 cursor-pointer text-ui text-blue hover:underline">
                Try again
              </button>
            </div>
          ) : (
            <div aria-hidden="true" className="space-y-3">
              <div className="h-3 w-24 rounded-[2px] bg-tint" />
              <div className="h-6 w-4/5 rounded-[3px] bg-tint" />
              <div className="mt-6 h-32 rounded-card bg-tint opacity-60" />
              <div className="h-40 rounded-card bg-tint opacity-40" />
            </div>
          )}
        </div>
      </>
    );
  }

  const here = `${location.pathname}${location.search}`;
  const shown = cases.length;
  const allShown = shown >= search.total || loaded.length >= search.pages;
  const showMore = (): void => {
    focusRank.current = shown + 1;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(PAGES_PARAM, String(loaded.length + 1));
        return next;
      },
      { replace: true, preventScrollReset: true, state: location.state },
    );
  };

  // The drawer steps through the cards in rank order; past the last card shown it shows more.
  const caseTo = (ntsbNo: string) => {
    const next = new URLSearchParams(params);
    next.set(CASE_PARAM, ntsbNo);
    return { pathname: evidencePath(id), search: `?${next.toString()}` };
  };
  const setCase = (ntsbNo: string, pagesShown?: number): void =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(CASE_PARAM, ntsbNo);
        if (pagesShown !== undefined) next.set(PAGES_PARAM, String(pagesShown));
        return next;
      },
      { replace: true, preventScrollReset: true, state: location.state },
    );
  const closeCase = (): void => {
    setDrawerNotice(null);
    if ((location.state as { drawerFromList?: boolean } | null)?.drawerFromList) {
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
  const at = openCase ? cases.findIndex((c) => c.case.ntsbNo === openCase) : -1;
  const nextPage = async (): Promise<void> => {
    const n = loaded.length + 1;
    const page = await queryClient.fetchQuery(evidencePageQuery(id, n)).catch(() => null);
    const firstOfPage = page?.cases[0];
    if (firstOfPage) setCase(firstOfPage.case.ntsbNo, n);
  };
  const position: DrawerPosition | null =
    at >= 0
      ? {
          index: (cases[at] as EvidenceCase).rank,
          total: search.total,
          onPrevious: at > 0 ? () => setCase((cases[at - 1] as EvidenceCase).case.ntsbNo) : null,
          onNext: at < shown - 1 ? () => setCase((cases[at + 1] as EvidenceCase).case.ntsbNo) : !allShown ? () => void nextPage() : null,
        }
      : null;
  const toggle = (ntsbNo: string): 'added' | 'removed' | 'full' => {
    const r = compare.toggle(ntsbNo);
    setNotice(r === 'full' ? COMPARE_FULL_MESSAGE : null);
    return r;
  };
  const context = relevanceContext(search);

  return (
    <>
      {live}
      <div className={cx('mx-auto w-full max-w-reading px-4 pt-6 pb-12 sm:pt-[26px]', compare.selected.length > 0 && 'pb-24')}>
        <title>{pageTitle({ kind: 'evidence' })}</title>
        <PrintHeader title={EVIDENCE_HEADING} cases={cases.map((c) => c.case.ntsbNo)} snapshotDate={config?.snapshotDate ?? null} />
        <Placard as="p">Your question</Placard>
        <h1 className="mt-1 mb-3 font-serif text-[17px] leading-[1.3] break-words sm:text-[19px]">{search.question}</h1>
        <SearchPanel key={search.id} search={search} />
        <EvidenceHint hint={search.hint} className="mt-3" />
        <CapabilityNote note={search.note} className="mt-3" />

        <section aria-labelledby="evidence-heading" className="mt-5">
          <h2 ref={resultsHeading} tabIndex={-1} id="evidence-heading" className="font-serif text-[19px] leading-tight font-semibold tracking-headline outline-none sm:text-[21px]">
            {EVIDENCE_HEADING}
          </h2>
          <EvidenceNotice className="mt-2" />
          {search.total > 0 && (
            <p className="mt-2.5 text-meta text-muted" data-count-line="">
              {countLine(search.total, search.order)}
            </p>
          )}
          {search.total > 0 && <MatchLegend marked={context.marked} className="mt-0.5 mb-2" />}
          {search.total === 0 ? (
            <FewResults search={search} />
          ) : (
            <ol aria-label="Investigations retrieved" className="mt-1">
              {cases.map((c) => (
                <li key={c.case.ntsbNo}>
                  <EvidenceCard
                    searchId={search.id}
                    item={c}
                    context={context}
                    caseTo={caseTo(c.case.ntsbNo)}
                    inCompare={compare.selected.includes(c.case.ntsbNo)}
                    onToggleCompare={() => toggle(c.case.ntsbNo)}
                  />
                </li>
              ))}
            </ol>
          )}
          {search.total >= TINY_RESULTS && (
            <nav aria-label="More investigations" className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-2.5 text-meta text-muted" data-print="hide">
              {!allShown && <span>{showingLine(shown, search.total)}</span>}
              {!allShown && (
                <Button variant="search" size="sm" className="ml-auto" aria-busy={loadingMore} disabled={loadingMore} onClick={showMore}>
                  {loadingMore ? 'Loading…' : showMoreLabel(shown, search.total, EVIDENCE_PAGE_SIZE)}
                  <span className="sr-only"> (free)</span>
                </Button>
              )}
              {allShown && <span>{allShownLine(search.total)}</span>}
            </nav>
          )}
          {moreFailed && (
            <p className="mt-2 text-meta text-muted">
              {PAGE_FAILED}{' '}
              <button type="button" onClick={() => void moreFailed.refetch()} className="cursor-pointer text-blue hover:underline pointer-coarse:min-h-11">
                Try again
              </button>
            </p>
          )}
          {search.total > 0 && search.total < TINY_RESULTS && <FewResults search={search} />}
          <p className="mt-4 text-meta text-muted">{expiryLine(search.expiresAt)}</p>
        </section>
        {/* The reader's rating of the search: fixed copy of the page's own, apart from the results. */}
        <SearchRating key={`rating:${search.id}`} searchId={search.id} className="mt-5 border-t border-hairline pt-3" />

        <CompareTray
          selected={compare.selected}
          onRemove={compare.remove}
          notice={notice}
          from={here}
          extra={{ evidence: id, [PAGES_PARAM]: String(loaded.length) }}
        />
        <CaseDrawer
          ntsbNo={openCase}
          onClose={closeCase}
          position={position}
          inCompare={openCase ? compare.selected.includes(openCase) : false}
          onToggleCompare={() => {
            if (!openCase) return;
            setDrawerNotice(toggle(openCase) === 'full' ? COMPARE_FULL_MESSAGE : null);
          }}
          compareNotice={drawerNotice}
          fullPage={openCase ? `/cases/${openCase}` : '/'}
          fullPageState={{ from: here }}
          matched={null}
          evidence={at >= 0 ? { searchId: search.id, item: cases[at] as EvidenceCase, context } : null}
        />
      </div>
    </>
  );
}
