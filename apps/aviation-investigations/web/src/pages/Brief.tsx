import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { BriefIdSchema, MAX_BRIEF_STEPS, type BriefResult, type BriefStepResponse } from '../../../shared/contracts/briefs';
import { ApiError, configQuery, isNotFound } from '../api';
import { Button } from '../components/Button';
import { Placard } from '../components/Placard';
import { SearchBox } from '../components/SearchBox';
import { AiNoticeBox, COPY } from '../features/ai/AiNoticeBox';
import { briefStepQuery, cancelBrief, isFinished } from '../features/brief/api';
import { useAskAi } from '../features/ai/useAskAi';
import { BriefChips } from '../features/brief/BriefChips';
import { BriefingSheet } from '../features/brief/BriefingSheet';
import { Checklist } from '../features/brief/Checklist';
import { exploreHref, filtersInWords } from '../features/brief/filters';
import { rememberedQuestion } from '../features/brief/memory';
import { RefineBox } from '../features/brief/RefineBox';
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

const STEP_PARAM = 'step';

function readStep(params: URLSearchParams): number | null {
  const raw = params.get(STEP_PARAM);
  if (raw === null || !/^\d$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_BRIEF_STEPS ? n : null;
}

/**
 * Brief expired (UI_DESIGN §5): the server keeps nothing to restore. If this page still
 * holds the question in memory, [Ask again] refills the box; nothing is in browser storage.
 */
function Expired({ id }: { id: string }) {
  const remembered = rememberedQuestion(id);
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const ai = useAskAi();
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  return (
    <div className="mx-auto w-full max-w-reading px-4 pt-8 pb-12 sm:pt-12">
      <title>AI search expired · Aviation Casebook</title>
      <div role="status" className="card px-5 py-4">
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
      {ai.notice && <AiNoticeBox notice={ai.notice} keywordHref={exploreHref({}, value)} onRetry={() => void ai.ask(value)} className="mt-3" />}
    </div>
  );
}

/** "The AI search didn't finish." with what it cost, and Try again (a new paid step). */
function Failed({ step, countedAsSearch }: { step: BriefStepResponse; countedAsSearch: boolean }) {
  const ask = useAskAi();
  const refine = useRefine(step.briefId);
  const origin = step.origin;
  const retry = (): void => {
    if (step.refinementsLeft > 0 && origin.kind === 'text') void refine.refine({ kind: 'text', text: origin.text });
    else if (step.refinementsLeft > 0 && origin.kind === 'filters') void refine.refine({ kind: 'filters', filters: origin.filters });
    else void ask.ask(step.question);
  };
  const notice = refine.notice ?? ask.notice;
  return (
    <>
      <div role="alert" className="card mt-4 px-4 py-3.5">
        <p className="font-serif text-[18px] leading-tight font-semibold">{COPY.failure[0]}</p>
        <p className="mt-1 text-ui">{COPY.failure[1]}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <Button variant="ai" counter={refine.phase === 'idle' && ask.phase === 'idle' ? 'uses 1' : undefined} onClick={retry}>
            {refine.phase === 'checking' || ask.phase === 'checking' ? 'Checking…' : 'Try again'}
          </Button>
          <Link to={exploreHref({}, step.question)} className="text-ui text-blue hover:underline">
            {COPY.keyword}
          </Link>
        </div>
        <p className="mt-1.5 text-meta text-muted">{countedAsSearch ? COPY.spent : COPY.notSpent}</p>
      </div>
      {notice && <AiNoticeBox notice={notice} keywordHref={exploreHref({}, step.question)} className="mt-2.5" />}
    </>
  );
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
  const config = useQuery(configQuery()).data;
  const openCase = readOpenCase(params);
  const compare = useCompareSelection();
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerNotice, setDrawerNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const step = query.data;
  const finished = step ? isFinished(step) : false;
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

  if (!valid || isNotFound(query.error)) return <Expired id={id} />;
  if (!step) {
    return (
      <div className="mx-auto w-full max-w-reading px-4 pt-6 pb-12">
        <title>AI brief · Aviation Casebook</title>
        {query.isError ? (
          <div role="alert" className="card px-5 py-4">
            <p className="font-serif text-[19px] font-semibold">This AI search didn’t load.</p>
            <p className="mt-1 text-ui text-muted">
              {query.error instanceof ApiError && query.error.status === 429 ? 'Too many requests; wait a moment.' : 'Check your connection and try again.'}
            </p>
            <button type="button" onClick={() => query.refetch()} className="mt-2 cursor-pointer text-ui text-blue hover:underline">
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
    );
  }

  const result = step.result;
  const latest = step.step === step.steps;
  const sheet = result && (result.kind === 'answer' || result.kind === 'withheld' || result.kind === 'no_match') ? result : null;
  const context = result && 'interpretations' in result ? result : null;
  const cases = sheet?.cases.map((c) => c.case.ntsbNo) ?? [];

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
    <div className={cx('mx-auto w-full max-w-reading px-4 pt-6 pb-12 sm:pt-[26px]', compare.selected.length > 0 && 'pb-24')}>
      <title>AI brief · Aviation Casebook</title>
      <Placard as="p">Your question</Placard>
      <h1 className="mt-1 font-serif text-[17px] leading-[1.3] sm:text-[19px]">{step.question}</h1>
      <StepSwitcher briefId={id} step={step.step} steps={step.steps} origin={step.origin} />
      {context && <BriefChips briefId={id} interpretations={context.interpretations} filters={context.filters} editable={canRefine && step.refinementsLeft > 0} />}

      {!finished ? (
        <Checklist
          checklist={step.checklist}
          stage={step.stage}
          startedAt={step.startedAt}
          cohort={config?.coverage.defaultCohort ?? null}
          onCancel={() => void cancel()}
          cancelling={cancelling}
        />
      ) : (
        <section aria-labelledby="result-heading" className="mt-1">
          <h2 id="result-heading" ref={resultHeading} tabIndex={-1} className="sr-only">
            {step.steps > 1 ? `Answer ${step.step}` : 'Answer'}
          </h2>
          {sheet && <BriefingSheet result={sheet} caseTo={caseTo} inCompare={(n) => compare.selected.includes(n)} onToggleCompare={toggle} />}
          {result?.kind === 'scope_reply' && <ScopeReply briefId={id} question={step.question} reply={result.reply} refinementsLeft={latest ? step.refinementsLeft : 0} />}
          {result?.kind === 'no_results' && (
            <div role="status" className="card mt-4 px-4 py-3.5">
              <p className="font-serif text-[18px] leading-tight font-semibold">{NO_RESULTS_TITLE}</p>
              <p className="mt-1 text-ui text-muted">{[`“${step.question}”`, ...filtersInWords(result.filters)].join(' · ')}</p>
              <Link to={exploreHref(result.filters)} className="mt-2 inline-block text-ui text-blue hover:underline">
                Show keyword results with these filters<span className="sr-only"> (free)</span>
              </Link>
            </div>
          )}
          {result?.kind === 'failed' && <Failed step={step} countedAsSearch={result.countedAsSearch} />}
          {result?.kind === 'cancelled' && (
            <div role="status" className="card mt-4 px-4 py-3.5">
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
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

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
  );
}
