import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  BriefIdSchema,
  MAX_BRIEF_STEPS,
  type BriefFilters,
  type BriefResult,
  type BriefStepResponse,
  type RefinementChange,
} from '../../../shared/contracts/briefs';
import { pageTitle } from '../../../shared/page-titles';
import { ApiError, ReadTimeoutError, configQuery, isNotFound } from '../api';
import { documentTitle } from '../brand';
import { Button } from '../components/Button';
import { Placard } from '../components/Placard';
import { SearchBox } from '../components/SearchBox';
import { AiNoticeBox, COPY } from '../features/ai/AiNoticeBox';
import { busyLabel } from '../features/ai/AskAiButton';
import { arrived, departed } from '../features/ai/unsettled';
import { briefStepQuery, cancelBrief, isFinished } from '../features/brief/api';
import { useAskAi } from '../features/ai/useAskAi';
import { BriefChips } from '../features/brief/BriefChips';
import { BriefingSheet, sheetOrder } from '../features/brief/BriefingSheet';
import { Checklist } from '../features/brief/Checklist';
import { exploreHref, filtersInWords } from '../features/brief/filters';
import { rememberedAsk, rememberedChange, rememberedQuestion } from '../features/brief/memory';
import { REFINEMENTS_USED, RefineBox } from '../features/brief/RefineBox';
import { ScopeReply } from '../features/brief/ScopeReply';
import { StepSwitcher } from '../features/brief/StepSwitcher';
import { useRefine } from '../features/brief/useRefine';
import { CaseDrawer, type DrawerPosition } from '../features/case/CaseDrawer';
import { COMPARE_FULL_MESSAGE, CompareTray } from '../features/explore/CompareTray';
import { CASE_PARAM, readOpenCase, useCompareSelection } from '../features/explore/url-state';
import { cx } from '../lib/cx';

export const EXPIRED_TITLE = 'This AI search has expired.';
export const EXPIRED_TEXT = 'We delete questions and answers after 24 hours.';
export const NO_RESULTS_TITLE = 'No completed investigations match all of this.';
export const CANCELLED_TITLE = 'You cancelled this AI search.';
export const LOAD_FAILED = 'This AI search didn’t load.';
/** Builder copy (Task 22 review W-5, W-12), for the owner's review. */
export const CHANGE_NOT_KEPT = "The changed reading can't be tried again from here. Start a new search to keep going.";
export const RETRY_FAILED = "Trying again didn't finish either.";

const STEP_PARAM = 'step';

function readStep(params: URLSearchParams): number | null {
  const raw = params.get(STEP_PARAM);
  if (raw === null || !/^\d$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_BRIEF_STEPS ? n : null;
}

/**
 * Brief expired (UI_DESIGN §5): the server keeps nothing to restore. If this page still
 * holds the question in memory, [Ask again] refills the box; the question is never in
 * browser storage.
 */
function Expired({ id }: { id: string }) {
  const remembered = rememberedQuestion(id);
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const ai = useAskAi();
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
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
      <AiNoticeBox notice={ai.notice} keywordHref={exploreHref({}, value)} onRetry={() => void ai.ask(value)} className="mt-3" />
    </div>
  );
}

/**
 * What Try again does after a failed step (Task 22 review W-5): the same request again,
 * never a different one charged as a search.
 * - A failed first step is asked again as a new brief, with the filters the reader set:
 *   the ones this page asked with, or none if it asked without any, never the ones the
 *   scope stage inferred (the new scope run infers its own). Only a brief this page did
 *   not ask (a reload, a link) has no record of them, and then the filters its scope stage
 *   settled on stand in.
 * - A failed refinement is refined again with the same change: its text or filters from
 *   the step, an edited or picked reading from this page's memory (the step names the
 *   reading but not its value).
 * - No Try again when that is not possible: an earlier answer with later ones in the
 *   brief (`later`), no refinements left (`limit`), or a reading this page did not send
 *   (`change`: a reload or a link). Asking the question again would drop the change.
 */
export type RetryPlan =
  | { kind: 'ask'; filters: BriefFilters | undefined }
  | { kind: 'refine'; change: RefinementChange }
  | { kind: 'none'; why: 'later' | 'limit' | 'change' };

export function retryPlan(step: BriefStepResponse): RetryPlan {
  const origin = step.origin;
  if (step.step !== step.steps) return { kind: 'none', why: 'later' };
  if (origin.kind === 'question') {
    const asked = rememberedAsk(step.briefId);
    return { kind: 'ask', filters: asked ? asked.filters : step.checklist.interpretation?.filters };
  }
  if (step.refinementsLeft <= 0) return { kind: 'none', why: 'limit' };
  if (origin.kind === 'text') return { kind: 'refine', change: { kind: 'text', text: origin.text } };
  if (origin.kind === 'filters') return { kind: 'refine', change: { kind: 'filters', filters: origin.filters } };
  const change = rememberedChange(step.briefId, step.step);
  return change ? { kind: 'refine', change } : { kind: 'none', why: 'change' };
}

/**
 * "The AI search didn't finish." with what it cost, and Try again (a new paid step, as
 * `retryPlan` says). The page's live region announces the failure once, so this box is
 * not a live region itself; a Try again that fails too is said in this box (one failure
 * box, Task 22 review W-12), from a polite region of its own. Other notices about the
 * retry (a check, a pause, a limit) show under it, without a second Try again.
 */
function Failed({ step, countedAsSearch }: { step: BriefStepResponse; countedAsSearch: boolean }) {
  const ask = useAskAi();
  const refine = useRefine(step.briefId);
  const plan = retryPlan(step);
  const retry =
    plan.kind === 'none'
      ? null
      : (): void => {
          if (plan.kind === 'refine') void refine.refine(plan.change);
          else void ask.ask(step.question, plan.filters);
        };
  const notice = refine.notice ?? ask.notice;
  const retryFailed = notice?.kind === 'failure' ? notice : null;
  return (
    <>
      <div className="card mt-4 px-4 py-3.5">
        <p className="font-serif text-[18px] leading-tight font-semibold">{COPY.failure[0]}</p>
        <p className="mt-1 text-ui">{COPY.failure[1]}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          {retry && (
            <Button variant="ai" counter={refine.phase === 'idle' && ask.phase === 'idle' ? 'uses 1' : undefined} onClick={retry}>
              {busyLabel(refine.phase) ?? busyLabel(ask.phase) ?? 'Try again'}
            </Button>
          )}
          <Link to={exploreHref({}, step.question)} className="text-ui text-blue hover:underline">
            {COPY.keyword}
          </Link>
        </div>
        <p className="mt-1.5 text-meta text-muted">{countedAsSearch ? COPY.spent : COPY.notSpent}</p>
        {plan.kind === 'none' && plan.why !== 'later' && (
          <p className="mt-1.5 text-meta text-muted" data-print="hide">
            {plan.why === 'limit' ? REFINEMENTS_USED : CHANGE_NOT_KEPT}{' '}
            <Link to="/" className="text-blue hover:underline">
              New search
            </Link>
          </p>
        )}
        <p aria-live="polite" className={cx('text-meta text-muted', retryFailed && 'mt-1.5')}>
          {retryFailed ? `${RETRY_FAILED} ${retryFailed.spent === 'no' ? COPY.notSpent : COPY.unknownSpent}` : ''}
        </p>
      </div>
      <AiNoticeBox notice={retryFailed ? null : notice} keywordHref={exploreHref({}, step.question)} className="mt-2.5" />
    </>
  );
}

/**
 * The chips' readings and filters (UI_DESIGN §4.4: the question and chips stay on top):
 * the finished step's own; while it runs, what the scope stage sent, else the previous
 * step's (a refinement before its scope row is done).
 */
export function chipsContext(
  step: BriefStepResponse,
  previous: BriefStepResponse | undefined,
): Pick<NonNullable<BriefStepResponse['checklist']['interpretation']>, 'interpretations' | 'filters'> | null {
  const result = step.result;
  if (result && 'interpretations' in result) return result;
  if (isFinished(step)) return null;
  if (step.checklist.interpretation) return step.checklist.interpretation;
  const before = previous?.result;
  return before && 'interpretations' in before ? before : null;
}

function resultAnnouncement(result: BriefResult | undefined): string {
  switch (result?.kind) {
    case 'answer':
      return 'The answer is ready.';
    case 'withheld':
      return 'The summary was withheld; the cases are shown with their NTSB text.';
    case 'no_match':
      return 'No retrieved case supports the question as asked.';
    case 'no_results':
      return NO_RESULTS_TITLE;
    case 'scope_reply':
      return 'The question got a fixed reply.';
    case 'failed':
      return COPY.failure[0];
    case 'cancelled':
      return CANCELLED_TITLE;
    default:
      return '';
  }
}

/**
 * An AI brief (UI_DESIGN §3, §4.3, §4.4): YOUR QUESTION, the answer switcher and chips,
 * then the checklist while the step runs (polled once a second) and the briefing sheet
 * once it is done. Every read is the viewer's own and private; when the brief is gone or
 * not theirs, the expired state shows. The drawer, compare tray and refine box work on
 * the step shown.
 */
export function Brief() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const valid = BriefIdSchema.safeParse(id).success;
  const stepParam = readStep(params);
  const query = useQuery({ ...briefStepQuery(id, stepParam), enabled: valid });
  // `?step=n` past the last step: show the latest one with a note, not the expired page.
  const stepMissing = stepParam !== null && isNotFound(query.error);
  const fallback = useQuery({ ...briefStepQuery(id, null), enabled: valid && stepMissing });
  const config = useQuery(configQuery()).data;
  const openCase = readOpenCase(params);
  const compare = useCompareSelection();
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerNotice, setDrawerNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const step = query.data ?? (stepMissing ? fallback.data : undefined);
  const finished = step ? isFinished(step) : false;
  const gone = !valid || (stepMissing ? isNotFound(fallback.error) : isNotFound(query.error));
  // While a refinement runs, its chips are the previous step's (already read, so cached)
  // until the scope stage sends the step's own.
  const previous = useQuery({
    ...briefStepQuery(id, (step?.step ?? 1) - 1),
    enabled: Boolean(step && !finished && step.step > 1 && !step.checklist.interpretation),
  });

  // An AI request answered 2xx is settled once this page has taken over: a new brief as soon
  // as the page is on screen for it, a refinement when the step it started is shown
  // (web/src/features/ai/unsettled.ts `settleOnArrival`). A layout effect, so it runs as the
  // page commits.
  const shownStep = step?.briefId === id ? step.step : null;
  useLayoutEffect(() => {
    if (!valid) return;
    arrived(id, shownStep);
    return () => departed(id, shownStep);
  }, [id, valid, shownStep]);

  // A finished step never changes: keep it under its number too, so the step switcher and
  // the next refinement's chips read it from memory.
  const readAsLatest = stepParam === null || stepMissing;
  useEffect(() => {
    if (step && finished && readAsLatest) queryClient.setQueryData(briefStepQuery(id, step.step).queryKey, step);
  }, [queryClient, id, step, finished, readAsLatest]);
  // The step seen running on this page, so only its own finish is announced.
  const running = useRef<string | null>(null);

  // When a running step finishes: announce it, and move focus to the result if it was lost.
  useEffect(() => {
    if (!step) return;
    const key = `${step.briefId}:${step.step}`;
    if (!finished) {
      running.current = key;
      return;
    }
    if (running.current !== key) return;
    running.current = null;
    setCancelling(false);
    setAnnouncement(resultAnnouncement(step.result));
    if (document.activeElement === document.body || document.activeElement === null) resultHeading.current?.focus({ preventScroll: true });
  }, [step, finished]);

  // Reads of the running step on screen fail (a network or server error; not a refusal such
  // as a 404 or a 429, which stop or wait): the page keeps trying, and the checklist says so
  // until a read gets through. Said once a read and its automatic retry have failed, so one
  // transient error the retry repairs says nothing (re-review F-2); a read that gets no
  // answer within READ_TIMEOUT_MS is said at once (re-review N-5).
  const polling = stepMissing ? fallback : query;
  const pollFailure = polling.error ?? (polling.failureReason instanceof ReadTimeoutError ? polling.failureReason : null);
  const pollTrouble = step !== undefined && !finished && pollFailure !== null && !(pollFailure instanceof ApiError && pollFailure.status < 500);

  // A failed read that is not a 404. While `?step=n` past the last step falls back to the
  // latest step, only the fallback's own failure counts (the first 404 is expected).
  const loadError = stepMissing
    ? fallback.isError && !isNotFound(fallback.error)
      ? fallback.error
      : null
    : query.isError && !isNotFound(query.error)
      ? query.error
      : null;
  // One polite live region for the whole page, rendered first in every state, so whatever
  // appears later (expiry, a load failure, the fallback note, a finished step) is announced;
  // the fallback note keeps the latest step's own finish after it.
  const liveText = gone
    ? EXPIRED_TITLE
    : !step && loadError
      ? LOAD_FAILED
      : stepMissing && step
        ? `There is no answer ${stepParam} in this brief; this is the latest.${announcement ? ` ${announcement}` : ''}`
        : announcement;
  const live = (
    <p aria-live="polite" className="sr-only">
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
  if (!step) {
    return (
      <>
        {live}
        <div className="mx-auto w-full max-w-reading px-4 pt-6 pb-12">
          <title>{pageTitle({ kind: 'brief' })}</title>
          {loadError ? (
            <div className="card px-5 py-4">
              <p className="font-serif text-[19px] font-semibold">{LOAD_FAILED}</p>
              <p className="mt-1 text-ui text-muted">
                {loadError instanceof ApiError && loadError.status === 429 ? 'Too many requests; wait a moment.' : 'Check your connection and try again.'}
              </p>
              <button
                type="button"
                onClick={() => void (stepMissing ? fallback.refetch() : query.refetch())}
                className="mt-2 cursor-pointer text-ui text-blue hover:underline"
              >
                Try again
              </button>
            </div>
          ) : (
            <div aria-hidden="true" className="space-y-3">
              <div className="h-3 w-24 rounded-[2px] bg-tint" />
              <div className="h-6 w-4/5 rounded-[3px] bg-tint" />
              <div className="mt-6 h-40 rounded-chip bg-tint opacity-60" />
            </div>
          )}
        </div>
      </>
    );
  }

  const result = step.result;
  const latest = step.step === step.steps;
  const sheet = result && (result.kind === 'answer' || result.kind === 'withheld' || result.kind === 'no_match') ? result : null;
  const context = chipsContext(step, previous.data);
  // The drawer's "‹ n of N ›" steps through the cards in the order the sheet shows them.
  const cases = sheet ? sheetOrder(sheet) : [];

  // The drawer keeps the step in view (`step` stays as it is: absent means the latest).
  const caseTo = (ntsbNo: string) => {
    const next = new URLSearchParams(params);
    next.set(CASE_PARAM, ntsbNo);
    return { pathname: `/briefs/${id}`, search: `?${next.toString()}` };
  };
  const setCase = (ntsbNo: string): void =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(CASE_PARAM, ntsbNo);
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
  const at = openCase ? cases.indexOf(openCase) : -1;
  const position: DrawerPosition | null =
    at >= 0
      ? {
          index: at + 1,
          total: cases.length,
          onPrevious: at > 0 ? () => setCase(cases[at - 1] as string) : null,
          onNext: at < cases.length - 1 ? () => setCase(cases[at + 1] as string) : null,
        }
      : null;

  const toggle = (ntsbNo: string): 'added' | 'removed' | 'full' => {
    const r = compare.toggle(ntsbNo);
    setNotice(r === 'full' ? COMPARE_FULL_MESSAGE : null);
    return r;
  };
  const cancel = async (): Promise<void> => {
    setCancelling(true);
    try {
      await cancelBrief(id, step.step);
    } catch {
      // The step may have just finished; the next poll shows where it is.
    }
    await queryClient.invalidateQueries({ queryKey: ['brief', id] });
  };
  const here = `${location.pathname}${location.search}`;
  const canRefine = finished && latest && result !== undefined && result.kind !== 'scope_reply' && result.kind !== 'failed';

  return (
    <>
      {live}
      <div className={cx('mx-auto w-full max-w-reading px-4 pt-6 pb-12 sm:pt-[26px]', compare.selected.length > 0 && 'pb-24')}>
        <title>{pageTitle({ kind: 'brief' })}</title>
        <Placard as="p">Your question</Placard>
        <h1 className="mt-1 font-serif text-[17px] leading-[1.3] sm:text-[19px]">{step.question}</h1>
        <StepSwitcher briefId={id} step={step.step} steps={step.steps} origin={step.origin} />
        {stepMissing && (
          <p className="mb-2.5 text-meta text-muted">There is no answer {stepParam} in this brief; this is the latest.</p>
        )}
        {context && <BriefChips briefId={id} interpretations={context.interpretations} filters={context.filters} editable={canRefine && step.refinementsLeft > 0} />}

        {!finished ? (
          <Checklist
            checklist={step.checklist}
            stage={step.stage}
            startedAt={step.startedAt}
            cohort={config?.coverage.defaultCohort ?? null}
            onCancel={() => void cancel()}
            cancelling={cancelling}
            trouble={pollTrouble}
          />
        ) : (
          <section aria-labelledby="result-heading" className="mt-1">
            <h2 id="result-heading" ref={resultHeading} tabIndex={-1} className="sr-only">
              {step.steps > 1 ? `Answer ${step.step}` : 'Answer'}
            </h2>
            {sheet && <BriefingSheet result={sheet} caseTo={caseTo} inCompare={(n) => compare.selected.includes(n)} onToggleCompare={toggle} />}
            {result?.kind === 'scope_reply' && <ScopeReply briefId={id} question={step.question} reply={result.reply} refinementsLeft={latest ? step.refinementsLeft : 0} />}
            {result?.kind === 'no_results' && (
              <div className="card mt-4 px-4 py-3.5">
                <p className="font-serif text-[18px] leading-tight font-semibold">{NO_RESULTS_TITLE}</p>
                <p className="mt-1 text-ui text-muted">{[`“${step.question}”`, ...filtersInWords(result.filters)].join(' · ')}</p>
                <Link to={exploreHref(result.filters)} className="mt-2 inline-block text-ui text-blue hover:underline">
                  Show keyword results with these filters<span className="sr-only"> (free)</span>
                </Link>
              </div>
            )}
            {result?.kind === 'failed' && <Failed step={step} countedAsSearch={result.countedAsSearch} />}
            {result?.kind === 'cancelled' && (
              <div className="card mt-4 px-4 py-3.5">
                <p className="font-serif text-[18px] leading-tight font-semibold">{CANCELLED_TITLE}</p>
                <p className="mt-1 text-meta text-muted">{COPY.spent}</p>
              </div>
            )}
          </section>
        )}

        {canRefine && <RefineBox briefId={id} refinementsLeft={step.refinementsLeft} question={step.question} />}
        {finished && !latest && (
          <p className="mt-5 border-t border-dashed border-hairline pt-2.5 text-ui text-muted" data-print="hide">
            You are reading answer {step.step} of {step.steps}.{' '}
            <Link to={`/briefs/${id}`} className="text-blue hover:underline">
              Go to the latest answer
            </Link>
          </p>
        )}
        <CompareTray
          selected={compare.selected}
          onRemove={compare.remove}
          notice={notice}
          from={here}
          extra={{ brief: id, step: String(step.step) }}
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
          fullPage={openCase ? `/cases/${openCase}?brief=${id}&step=${step.step}` : '/'}
          fullPageState={{ from: here }}
          matched={null}
          brief={finished && openCase ? { id, step: step.step } : null}
        />
      </div>
    </>
  );
}
