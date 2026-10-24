import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiStatusResponse } from '../../shared/contracts/ai';
import { BRIEF_FILTER_FACETS, BriefStepResponseSchema, CRITERIA, type BriefStepResponse, type CaseReading, type SummarySegment } from '../../shared/contracts/briefs';
import { CRITERION_LINE } from '../../server/briefs/context';
import { NO_MATCH_LINES } from '../../server/briefs/static-replies';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status';
import { MOCK_MIDAIR_QUESTION, MOCK_SEED_QUESTION, RESULT_SAMPLES } from '../../web/mock/briefs';
import mockConfig from '../../web/mock/config.json';
import { AiCounter } from '../../web/src/features/ai/AiCounter';
import { SignInProvider } from '../../web/src/features/auth/SignInDialog';
import { AiNoticeBox } from '../../web/src/features/ai/AiNoticeBox';
import { AskAiButton } from '../../web/src/features/ai/AskAiButton';
import {
  FIRST_CHECK_TEXT,
  FIRST_CHECK_TITLE,
  LATER_CHECK_TITLE,
  TurnstileGate,
  useAiCheck,
  type AiCheck,
  type TurnstileApi,
} from '../../web/src/features/ai/TurnstileGate';
import { BRIEF_POLL_MS, MAX_POLL_BACKOFF_MS, briefPollDelay, briefStepQuery, type PollState } from '../../web/src/features/brief/api';
import { BriefingSheet, citationJoiner, sheetOrder } from '../../web/src/features/brief/BriefingSheet';
import { attributionAmbiguous, evidenceAttribution, quoteAttribution, unconfirmedLines } from '../../web/src/features/brief/display';
import { exploreHref } from '../../web/src/features/brief/filters';
import {
  FILTER_FACETS,
  UNSETTLED_TTL_MS,
  canonicalFilters,
  forgetUnsettled,
  forgetUnsettledMemoryForTests,
  rememberUnsettled,
  resetUnsettledForTests,
  unsettledId,
  unsettledKey,
} from '../../web/src/features/ai/unsettled';
import { canonicalFilters as serverCanonicalFilters } from '../../server/briefs/intent';
import { IDEMPOTENCY_TTL_MS, PIPELINE_DEADLINE_MS } from '../../server/quota/policy';
import { AI_STATUS_RETRY_MS, ApiError, CONFIG_RETRY_MAX_MS, CONFIG_RETRY_MS, READ_TIMEOUT_MS, ReadTimeoutError, aiStatusQuery, configQuery } from '../../web/src/api';
import { CHANGE_NOT_KEPT, RETRY_FAILED, chipsContext } from '../../web/src/pages/Brief';
import { REFINEMENTS_USED } from '../../web/src/features/brief/RefineBox';
import { Checklist, CHECKLIST_NOTE, POLL_TROUBLE } from '../../web/src/features/brief/Checklist';
import { WithheldNotice, withheldText } from '../../web/src/features/brief/WithheldNotice';
import { PassageText, cleanSpans, paragraphRanges } from '../../web/src/features/case/BriefContext';
import { TURNSTILE_TEST_SITE_KEY, createHandlers } from '../../web/src/mocks/handlers';
import { currentUrl, renderApp, setupMockApi } from './render-app';
import { routes } from '../../web/src/routes';
import printCss from '../../web/src/styles/print.css?raw';

const server = setupMockApi({ briefPolls: 1 });

interface FakeTurnstile {
  renders: { sitekey: string; action: string; appearance: string }[];
  removed: number;
  /** Gives the widgets held by `hold` their tokens now; widgets rendered later answer after the delay. */
  release(): void;
}

/**
 * A stand-in for Cloudflare's widget: answers with the test keys' dummy token after `delay` ms.
 * With `hold`, the widgets rendered before `release()` give no token until then, so a test can
 * read what the reader sees while a check is open without racing the delay.
 */
function installTurnstile(delay = 20, { hold = false }: { hold?: boolean } = {}): FakeTurnstile {
  let holding = hold;
  const held: (() => void)[] = [];
  const state: FakeTurnstile = {
    renders: [],
    removed: 0,
    release() {
      holding = false;
      act(() => {
        for (const answer of held.splice(0)) answer();
      });
    },
  };
  const widgets = new Map<string, HTMLElement>();
  let n = 0;
  const api: TurnstileApi = {
    render(host, params) {
      n += 1;
      const id = `w${n}`;
      state.renders.push({ sitekey: params.sitekey, action: params.action, appearance: params.appearance });
      const box = document.createElement('div');
      box.textContent = 'Verifying…';
      host.appendChild(box);
      widgets.set(id, box);
      const answer = (): void => {
        if (widgets.has(id)) params.callback('XXXX.DUMMY.TOKEN.XXXX');
      };
      if (holding) held.push(answer);
      else setTimeout(answer, delay);
      return id;
    },
    remove(id) {
      widgets.get(id)?.remove();
      widgets.delete(id);
      state.removed += 1;
    },
  };
  window.turnstile = api;
  return state;
}

afterEach(() => {
  delete window.turnstile;
  resetUnsettledForTests();
  vi.useRealTimers();
});

/** A fresh mock API (trial, briefs) for one test. */
function freshApi(options: Parameters<typeof createHandlers>[0] = {}): void {
  server.use(...createHandlers({ briefPolls: 1, ...options }));
}

async function askFromHome(question: string) {
  const app = renderApp('/');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: question } });
  fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
  await waitFor(() => expect(currentUrl(app.router)).toMatch(/^\/briefs\/[0-9a-f-]{36}$/), { timeout: 3000 });
  return app;
}

const SLOW = { timeout: 5000 };

/** `ui` with this AI status; `signIn`: Google sign-in is offered (the sign-in dialog's provider around it). */
function withStatus(status: AiStatusResponse, ui: ReactNode, { signIn = false }: { signIn?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['ai-status'], status);
  client.setQueryData(['config'], { ...mockConfig, googleEnabled: signIn });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{signIn ? <SignInProvider>{ui}</SignInProvider> : ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AI availability labels (UI_DESIGN §5)', () => {
  it.each([
    ['fresh', /^Ask AI\s*·\s*3 free$/, null],
    ['signedIn', /^Ask AI\s*·\s*18 left today$/, null],
    ['pausedDaily', /^Ask AI$/, 'AI back tomorrow'],
    ['pausedMonthly', /^Ask AI$/, 'AI back on 1 Nov'],
    ['unavailable', /^Ask AI$/, 'AI temporarily unavailable'],
    // Signed-in AI only, and sign-in is not offered: nothing says "sign in" (review W-10).
    ['trialUsed', /^Ask AI$/, 'Free AI searches used'],
    ['anonymousShare', /^Ask AI$/, 'Free AI searches paused for today'],
    ['loginRequired', /^Ask AI$/, 'AI temporarily unavailable'],
  ] as const)('%s', (sample, name, note) => {
    const { container } = withStatus(AI_STATUS_SAMPLES[sample], <AskAiButton onAsk={() => {}} />);
    const button = screen.getByRole('button', { name });
    expect(button.getAttribute('aria-disabled')).toBe(note ? 'true' : 'false');
    if (note) expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(note);
    expect(container.textContent).not.toMatch(/sign in/i);
  });

  it('until it is known whether sign-in is offered, a signed-in-only state says neither "sign in" nor the words for no sign-in', async () => {
    let answer: (() => void) | null = null;
    server.use(
      http.get('*/api/config', async () => {
        await new Promise<void>((resolve) => (answer = resolve));
        return HttpResponse.json({ ...mockConfig, googleEnabled: true });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['ai-status'], AI_STATUS_SAMPLES.trialUsed);
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SignInProvider>
            <AiCounter />
            <AskAiButton onAsk={() => {}} />
          </SignInProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(answer).not.toBeNull());
    expect(container.textContent).not.toMatch(/sign in|Free AI searches/i);
    expect(screen.getByRole('button', { name: /^Ask AI$/ }).getAttribute('aria-disabled')).toBe('true');
    act(() => answer?.());
    expect(await screen.findByRole('button', { name: 'Sign in to keep asking' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ask AI\s*·\s*sign in$/ }).getAttribute('aria-disabled')).toBe('false');
  });

  it('a failed configuration read leaves no silent state: a neutral note, and the configuration is read again until it answers (re-review N-3)', { timeout: 15_000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failing = true;
    let reads = 0;
    server.use(
      http.get('*/api/config', () => {
        reads += 1;
        return failing ? HttpResponse.json({ error: 'internal', message: 'Oops.' }, { status: 500 }) : HttpResponse.json({ ...mockConfig, googleEnabled: true });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['ai-status'], AI_STATUS_SAMPLES.trialUsed);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SignInProvider>
            <header>
              <AiCounter />
            </header>
            <AskAiButton onAsk={() => {}} />
          </SignInProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The read and its one retry fail: the controls say what is true either way, never "sign in".
    const header = screen.getByRole('banner');
    await waitFor(() => expect(header.textContent).toBe('Free AI searches used'), SLOW);
    const ask = screen.getByRole('button', { name: /^Ask AI$/ });
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(ask.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Free AI searches used');
    // It is read again (with a growing pause), and once it answers the controls follow it.
    const before = reads;
    failing = false;
    await act(() => vi.advanceTimersByTimeAsync(CONFIG_RETRY_MS));
    await waitFor(() => expect(reads).toBeGreaterThan(before), SLOW);
    expect(await screen.findByRole('button', { name: 'Sign in to keep asking' }, SLOW)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ask AI\s*·\s*sign in$/ }).getAttribute('aria-disabled')).toBe('false');
  });

  it('the configuration is read again with a growing pause while it fails, and not at all once read (re-review N-3)', () => {
    const interval = configQuery().refetchInterval as (q: never) => number | false;
    const at = (state: { status: 'error' | 'success' | 'pending'; data?: unknown; errorUpdateCount: number }) => ({ state }) as never;
    expect(interval(at({ status: 'error', errorUpdateCount: 1 }))).toBe(CONFIG_RETRY_MS);
    expect(interval(at({ status: 'error', errorUpdateCount: 2 }))).toBe(2 * CONFIG_RETRY_MS);
    expect(interval(at({ status: 'error', errorUpdateCount: 20 }))).toBe(CONFIG_RETRY_MAX_MS);
    expect(interval(at({ status: 'success', data: mockConfig, errorUpdateCount: 3 }))).toBe(false);
    // Read once: a later failed refresh keeps what was read, and nothing changes for the controls.
    expect(interval(at({ status: 'error', data: mockConfig, errorUpdateCount: 4 }))).toBe(false);
  });

  it('a notice raised before the configuration arrives says only what is true either way, then adds the right lines (re-review N-4)', async () => {
    let answer: (() => void) | null = null;
    server.use(
      http.get('*/api/config', async () => {
        await new Promise<void>((resolve) => (answer = resolve));
        return HttpResponse.json({ ...mockConfig, googleEnabled: true });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['ai-status'], AI_STATUS_SAMPLES.trialUsed);
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SignInProvider>
            <AiNoticeBox notice={{ kind: 'trial_used' }} keywordHref="/explore?q=x" />
          </SignInProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(answer).not.toBeNull());
    // While it is unknown whether sign-in is offered: only the title, which both versions share.
    expect(container.textContent).toBe('That was your third free AI search.');
    act(() => answer?.());
    await waitFor(() => expect(container.textContent).toContain('Sign in with Google to keep asking.'), SLOW);
    expect(container.textContent).not.toContain('Everything else works');
  });

  it.each(['trialUsed', 'anonymousShare', 'loginRequired'] as const)('%s, with sign-in offered: "Ask AI · sign in"', (sample) => {
    withStatus(AI_STATUS_SAMPLES[sample], <AskAiButton onAsk={() => {}} />, { signIn: true });
    expect(screen.getByRole('button', { name: /^Ask AI\s*·\s*sign in$/ }).getAttribute('aria-disabled')).toBe('false');
  });

  it('brief controls say "· uses 1" before the click, and "Checking…" during the check', () => {
    const { rerender } = withStatus(AI_STATUS_SAMPLES.oneLeft, <AskAiButton label="Refine" usesOne onAsk={() => {}} />);
    expect(screen.getByRole('button', { name: /^Refine\s*·\s*uses 1$/ })).toBeTruthy();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AskAiButton label="Refine" usesOne onAsk={() => {}} phase="checking" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Checking…' }).getAttribute('aria-busy')).toBe('true');
  });

  it.each([
    ['fresh', 'AI searches left: 3 of 3'],
    ['oneLeft', 'AI searches left: 1 of 3'],
    ['signedIn', 'AI left today: 18 of 20'],
    ['pausedDaily', 'AI back tomorrow'],
    ['pausedMonthly', 'AI back on 1 Nov'],
    ['unavailable', 'AI temporarily unavailable'],
    // Sign-in is not offered: the counter never tells the visitor to sign in (review W-10).
    ['trialUsed', 'Free AI searches used'],
    ['anonymousShare', 'Free AI searches paused for today'],
    ['loginRequired', 'AI temporarily unavailable'],
  ] as const)('header counter: %s reads "%s"', (sample, text) => {
    const { container } = withStatus(AI_STATUS_SAMPLES[sample], <AiCounter />);
    expect(container.textContent).toContain(text);
    expect(container.textContent).not.toMatch(/sign in/i);
  });

  it.each([
    ['trialUsed', 'Sign in to keep asking'],
    ['anonymousShare', 'Sign in to ask the AI'],
    ['loginRequired', 'Sign in to ask the AI'],
  ] as const)('header counter with sign-in offered: %s is the pill "%s"', (sample, text) => {
    withStatus(AI_STATUS_SAMPLES[sample], <AiCounter />, { signIn: true });
    expect(screen.getByRole('button', { name: text })).toBeTruthy();
  });
});

describe('A failed AI status read is read again (review W-9)', { timeout: 20_000 }, () => {
  it('the status query re-reads on a timer while it is in error, and when the tab gets focus', () => {
    const options = aiStatusQuery();
    const at = (status: 'error' | 'success') => ({ state: { status } }) as never;
    const interval = options.refetchInterval as (q: never) => number | false;
    const onFocus = options.refetchOnWindowFocus as (q: never) => boolean;
    expect(interval(at('error'))).toBe(AI_STATUS_RETRY_MS);
    expect(interval(at('success'))).toBe(false);
    expect(onFocus(at('error'))).toBe(true);
    expect(onFocus(at('success'))).toBe(false);
  });

  it('after a failed read, the Ask AI button comes back by itself once the status can be read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failures = 2;
    server.use(
      http.get('*/api/ai/status', () => (failures-- > 0 ? HttpResponse.json({ error: 'internal', message: 'Oops.' }, { status: 500 }) : undefined)),
    );
    renderApp('/');
    // The first read and its one retry fail: nothing is promised and nothing runs ...
    expect(await screen.findByText('AI temporarily unavailable', {}, SLOW)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ask AI$/ }).getAttribute('aria-disabled')).toBe('true');
    // ... until the status is read again, without a reload.
    await act(() => vi.advanceTimersByTimeAsync(AI_STATUS_RETRY_MS));
    const ask = await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }, SLOW);
    expect(ask.getAttribute('aria-disabled')).toBe('false');
    expect(screen.queryByText('AI temporarily unavailable')).toBeNull();
  });
});

describe('AI notices (UI_DESIGN §5 copy)', () => {
  const notice = (n: Parameters<typeof AiNoticeBox>[0]['notice'], status: AiStatusResponse = AI_STATUS_SAMPLES.fresh) =>
    withStatus(status, <AiNoticeBox notice={n} keywordHref="/explore?q=x" onRetry={() => {}} />).container.textContent;

  it('paused for today, this month and with no time promised', () => {
    expect(notice({ kind: 'paused', status: AI_STATUS_SAMPLES.pausedDaily })).toBe(
      "AI search is done for today.This beta runs on a small daily AI budget, and today's is used up. It resets at 00:00 UTC.Everything else works: keyword search, every case, comparisons and printing.Search by keyword instead",
    );
    expect(notice({ kind: 'paused', status: AI_STATUS_SAMPLES.pausedMonthly })).toContain('AI search is done for this month.It returns on 1 Nov.');
    expect(notice({ kind: 'paused', status: AI_STATUS_SAMPLES.unavailable })).toContain('AI search is temporarily unavailable.Everything else works');
  });

  it('trial used, free searches paused (and the login-required variant), rate limit and failure', () => {
    const offered = (n: Parameters<typeof AiNoticeBox>[0]['notice']) =>
      withStatus(AI_STATUS_SAMPLES.trialUsed, <AiNoticeBox notice={n} keywordHref="/explore?q=x" onRetry={() => {}} />, { signIn: true }).container
        .textContent;
    expect(offered({ kind: 'trial_used' })).toBe(
      'That was your third free AI search.Sign in with Google to keep asking. New accounts start with 5 AI searches a day, rising to 20 after three days.Continue with GoogleSearch, case pages, compare and the dashboard stay open without an account.',
    );
    expect(offered({ kind: 'free_paused', loginRequired: false })).toBe(
      'Free AI searches are used up for today.Signed-in AI search is still open today. Sign in with Google to ask.Continue with GoogleFree searches return tomorrow; keyword search and every case work now.',
    );
    expect(offered({ kind: 'free_paused', loginRequired: true })).toBe(
      'Free AI searches are used up for today.Signed-in AI search is still open today. Sign in with Google to ask.Continue with Google',
    );
    // Sign-in is not offered: the same moments, without telling the visitor to sign in (review W-10).
    expect(notice({ kind: 'trial_used' })).toBe(
      'That was your third free AI search.Everything else works: keyword search, every case, comparisons and printing.Search by keyword instead',
    );
    expect(notice({ kind: 'free_paused', loginRequired: false })).toBe(
      'Free AI searches are used up for today.Free searches return tomorrow; keyword search and every case work now.',
    );
    expect(notice({ kind: 'free_paused', loginRequired: true })).toBe(
      'AI search is temporarily unavailable.Everything else works: keyword search, every case, comparisons and printing.Search by keyword instead',
    );
    expect(notice({ kind: 'rate', seconds: 12 })).toBe('Slow down a moment. Try again in 12 seconds.');
    expect(notice({ kind: 'failure', spent: 'no' })).toBe(
      "The AI search didn't finish.Something went wrong before an answer was ready.Try again · uses 1Search by keyword insteadThis didn't use one of your searches.",
    );
    // No answer came back: whether it counted is unknown, so the free claim is not made.
    const unknown = notice({ kind: 'failure', spent: 'unknown' });
    expect(unknown).not.toContain("This didn't use one of your searches.");
    expect(unknown).toContain('If it went through, Try again opens it without using another search.');
  });

  it('a long rate-limit wait (a per-network limit) reads in minutes or as a UTC time, never thousands of seconds (review W-4)', () => {
    // Per-minute limits: the approved copy, in seconds.
    expect(notice({ kind: 'rate', seconds: 119 })).toBe('Slow down a moment. Try again in 119 seconds.');
    // Hourly and daily limits are per network (the trial-creation cap is one): minutes, then the time.
    const tail = 'Everything else works: keyword search, every case, comparisons and printing.Search by keyword instead';
    expect(notice({ kind: 'rate', seconds: 120 })).toBe(`AI searches from this network are limited for now.Try again in 2 minutes.${tail}`);
    expect(notice({ kind: 'rate', seconds: 3480 })).toBe(`AI searches from this network are limited for now.Try again in 58 minutes.${tail}`);
    const at = Date.UTC(2026, 9, 23, 13, 0, 30);
    expect(notice({ kind: 'rate', seconds: 7200, at })).toBe(`AI searches from this network are limited for now.Try again after 15:01 UTC.${tail}`);
    expect(notice({ kind: 'rate', seconds: 39_570, at })).toBe(`AI searches from this network are limited for now.Try again after 00:00 UTC.${tail}`);
    expect(notice({ kind: 'rate', seconds: 3480 })).not.toMatch(/\d{3,} seconds/);
  });

  it('a 429 with a long Retry-After from the server reads as minutes (review W-4)', { timeout: 15_000 }, async () => {
    freshApi();
    installTurnstile();
    server.use(http.post('*/api/briefs', () => HttpResponse.json({ error: 'rate_limited', message: 'Too many requests.', retryAfter: 3480 }, { status: 429 })));
    renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByText('AI searches from this network are limited for now.', {}, SLOW)).toBeTruthy();
    expect(screen.getByText('Try again in 58 minutes.')).toBeTruthy();
    expect(screen.queryByText(/3480/)).toBeNull();
  });

  it('a notice appears inside a live region that was there before it', () => {
    const client = new QueryClient();
    client.setQueryData(['ai-status'], AI_STATUS_SAMPLES.fresh);
    const ui = (n: Parameters<typeof AiNoticeBox>[0]['notice']) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AiNoticeBox notice={n} keywordHref="/explore" />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { container, rerender } = render(ui(null));
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toBe('');
    rerender(ui({ kind: 'rate', seconds: 9 }));
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toBe('Slow down a moment. Try again in 9 seconds.');
  });
});

describe('Checklist (UI_DESIGN §4.4)', () => {
  const props = { startedAt: new Date().toISOString(), cohort: 24291, onCancel: () => {}, cancelling: false };

  it('fills each row with its real result and announces completions only', () => {
    const { rerender } = render(<Checklist {...props} stage="retrieve" checklist={{ question: 'in_scope' }} />);
    const rows = () => screen.getAllByRole('listitem').map((li) => [li.getAttribute('data-state'), li.textContent]);
    expect(rows()).toEqual([
      ['done', 'QuestionIN SCOPE✓ done'],
      ['current', 'Search 24,291 investigationsIN PROGRESS'],
      ['todo', 'Write answer—'],
      ['todo', 'Verify every quote—'],
    ]);
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toBe('Question: in scope.');
    // A poll that brings nothing new says nothing new.
    rerender(<Checklist {...props} stage="retrieve" checklist={{ question: 'in_scope' }} />);
    expect(live.textContent).toBe('Question: in scope.');
    rerender(<Checklist {...props} stage="validate" checklist={{ question: 'in_scope', searched: { cases: 6, passages: 12 }, written: true }} />);
    expect(rows()[1]).toEqual(['done', 'Search 24,291 investigations6 CASES · 12 PASSAGES✓ done']);
    expect(rows()[3]).toEqual(['current', 'Verify every quoteIN PROGRESS']);
    expect(live.textContent).toBe('Answer written.');
    expect(screen.getByText(/0:0\d/).getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(new RegExp(CHECKLIST_NOTE.replace('.', '\\.')))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('the note says how long it usually takes, as measured, and its bound (review W-13)', () => {
    // Measured: scope 2–4 s, retrieve 1–2 s, compose 19–23 s, check 20–38 s (p50–p95); deadline 100 s.
    expect(CHECKLIST_NOTE).toBe('Nothing is shown until each quote matches the report text word for word. Usually about a minute; up to two.');
    expect(PIPELINE_DEADLINE_MS).toBeLessThanOrEqual(2 * 60_000);
    render(<Checklist {...props} stage="scope" checklist={{}} />);
    expect(screen.getByText(/Usually about a minute; up to two\./)).toBeTruthy();
  });

  it('says what the evidence check did, from the actual count; never a blanket status (Task 16e)', () => {
    const done = { question: 'in_scope' as const, searched: { cases: 6, passages: 12 }, written: true as const };
    const { rerender } = render(<Checklist {...props} stage="validate" checklist={{ ...done, verified: 'partially_checked', removedStatements: 0 }} />);
    const rows = () => screen.getAllByRole('listitem').map((li) => li.textContent);
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(rows()[3]).toBe('Verify every quoteCOMPLETED · 0 STATEMENTS REMOVED✓ done');
    expect(live.textContent).toBe('Evidence check completed: 0 statements removed.');
    rerender(<Checklist {...props} stage="validate" checklist={{ ...done, verified: 'partially_checked', removedStatements: 1 }} />);
    expect(rows()[3]).toBe('Verify every quoteCOMPLETED · 1 STATEMENT REMOVED✓ done');
    // A step written before the count existed, and an abstention with nothing of its own to check.
    rerender(<Checklist {...props} stage="validate" checklist={{ ...done, verified: 'partially_checked' }} />);
    expect(rows()[3]).toBe('Verify every quoteCOMPLETED✓ done');
    rerender(<Checklist {...props} stage="validate" checklist={{ ...done, verified: 'nothing_to_check' }} />);
    expect(rows()[3]).toBe('Verify every quoteNOTHING TO CHECK✓ done');
    expect(screen.queryByText(/PARTLY CHECKED|PASSED/)).toBeNull();
  });
});

describe('Withheld notice (UI_DESIGN §4.3 "Validation failed")', () => {
  it('is a hatched box labelled SUMMARY WITHHELD with the exact copy', () => {
    render(<WithheldNotice count={6} />);
    const note = screen.getByRole('note');
    expect(note.className).toContain('hatch');
    expect(note.textContent).toBe(
      "Summary withheldThe AI's summary didn't pass the citation check, so it isn't shown. Below are the 6 cases it found, with their NTSB text. You can still open, compare and print them.",
    );
    expect(withheldText(1)).toBe(
      "The AI's summary didn't pass the citation check, so it isn't shown. Below is the 1 case it found, with its NTSB text. You can still open, compare and print it.",
    );
  });
});

describe('Cited passages', () => {
  it('highlights come from UTF-16 offsets: invalid spans are dropped and overlaps merged', () => {
    const text = 'Engine ✈︎ 🛩 lost power.\n\nSecond paragraph <b>not markup</b>.';
    const start = text.indexOf('lost');
    expect(cleanSpans([{ start, end: start + 10 }, { start: start + 5, end: start + 15 }, { start: 40, end: 999 }, { start: 5, end: 5 }], text)).toEqual([
      { start, end: start + 15 },
    ]);
    // An edge inside a surrogate pair widens to the whole astral character.
    const plane = text.indexOf('🛩');
    expect(cleanSpans([{ start: plane + 1, end: start }], text)).toEqual([{ start: plane, end: start }]);
    expect(cleanSpans([{ start: 0, end: plane + 1 }], text)).toEqual([{ start: 0, end: plane + 2 }]);
    expect(paragraphRanges(text).map((r) => text.slice(r.start, r.end))).toEqual(['Engine ✈︎ 🛩 lost power.', 'Second paragraph <b>not markup</b>.']);
    const { container } = render(<PassageText text={text} highlights={[{ start: text.indexOf('🛩'), end: text.indexOf('🛩') + 2 }]} />);
    expect(container.querySelector('mark')?.textContent).toBe('🛩');
    // The cited paragraph shows; the rest is one click away, and nothing is parsed as HTML.
    expect(container.querySelector('b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole passage' }));
    expect(container.textContent).toContain('Second paragraph <b>not markup</b>.');
  });
});

describe('Ask AI end to end over the mock API', { timeout: 20_000 }, () => {
  it('first check once per trial identity, checklist then briefing sheet; the widget is reset after each request', async () => {
    freshApi();
    // The first widget holds its token until the panel has been read: once the token is taken
    // the panel closes and its text changes, so a timer could win the race on a slow run.
    const turnstile = installTurnstile(20, { hold: true });
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    const panel = await screen.findByRole('dialog', { name: FIRST_CHECK_TITLE });
    expect(panel.textContent).toContain(FIRST_CHECK_TEXT);
    turnstile.release();
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(await screen.findByRole('region', { name: /answer checklist/i })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /AI summary · check the cited passages/i }, SLOW)).toBeTruthy();
    expect(turnstile.renders).toEqual([{ sitekey: TURNSTILE_TEST_SITE_KEY, action: 'ask-ai', appearance: 'always' }]);
    expect(turnstile.removed).toBe(1);
    expect(screen.queryByRole('dialog', { name: FIRST_CHECK_TITLE })).toBeNull();

    // The trial has started: a refinement takes a fresh, invisible check and says "· uses 1".
    fireEvent.change(screen.getByRole('textbox', { name: /^refine$/i }), { target: { value: 'only helicopters' } });
    fireEvent.click(screen.getByRole('button', { name: /^Refine\s*·\s*uses 1$/ }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /quick check/i })).toBeNull();
    const switcher = await screen.findByRole('navigation', { name: 'Answers in this brief' }, SLOW);
    expect(within(switcher).getByRole('link', { name: 'Answer 2, latest' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('heading', { name: /AI summary/i }, SLOW)).toBeTruthy();
    expect(turnstile.renders.map((r) => r.appearance)).toEqual(['always', 'interaction-only']);
    expect(turnstile.removed).toBe(2);
  });

  it('a refused token takes one more, visible check; any refusal resets the widget', async () => {
    // A trial that has started, with searches left.
    freshApi({ aiStatus: { state: 'available', remaining: { kind: 'trial', left: 3, limit: 3, started: true } } });
    const turnstile = installTurnstile(30);
    let posts = 0;
    server.use(
      http.post('*/api/briefs', () => {
        posts += 1;
        if (posts === 1) return HttpResponse.json({ error: 'challenge_failed', message: 'Take a new check.' }, { status: 403 });
        if (posts === 3) return HttpResponse.json({ error: 'rate_limited', message: 'Slow down.', retryAfter: 12 }, { status: 429 });
        return undefined;
      }),
    );
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByRole('dialog', { name: LATER_CHECK_TITLE })).toBeTruthy();
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(turnstile.renders.map((r) => r.appearance)).toEqual(['interaction-only', 'always']);
    expect(turnstile.removed).toBe(2);

    // A refusal that is not about the token resets the widget too.
    await act(() => router.navigate('/'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI/ }));
    expect(await screen.findByText('Slow down a moment. Try again in 12 seconds.', {}, SLOW)).toBeTruthy();
    expect(turnstile.removed).toBe(3);
    expect(posts).toBe(3);
  });

  it('a citation opens the drawer at the cited passage, with AI context from the private endpoint only', async () => {
    freshApi();
    installTurnstile();
    const fetches: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      fetches.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      return real(input, init);
    });
    const { router } = await askFromHome(MOCK_SEED_QUESTION);
    const label = await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const id = currentUrl(router).split('/')[2] as string;
    fireEvent.click(within(label.parentElement as HTMLElement).getByRole('link', { name: 'DFW08TA066' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(currentUrl(router)).toContain('case=DFW08TA066'));
    const cited = await within(dialog).findByText(/castellated nut used to secure the governor lever control rod/, { selector: 'mark' }, SLOW);
    expect(cited.closest('[data-cited]')).toBeTruthy();
    expect(within(dialog).getByText('AI classified').parentElement?.textContent).toBe('Causal fault established · AI classified');
    expect(fetches).toContain(`/api/briefs/${id}/steps/1/cases/DFW08TA066`);
    // The public case read carries NTSB data only; AI context never rides along with it.
    expect(fetches.filter((p) => p.startsWith('/api/cases/'))).toEqual(expect.arrayContaining(['/api/cases/DFW08TA066']));
  });

  it('a clarification offers AI suggested readings, each saying "· uses 1"', async () => {
    freshApi();
    installTurnstile();
    await askFromHome('Engine failure soon after maintenance');
    expect(await screen.findByText('AI SUGGESTED READINGS', {}, SLOW)).toBeTruthy();
    expect(screen.getByText('Which did you mean? Pick one to ask the AI.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /\s*·\s*uses 1$/ }).map((b) => b.textContent)).toEqual([
      'Within 30 days or 10 flight hours· uses 1',
      'Within 7 days· uses 1',
      'First flight after maintenance only· uses 1',
    ]);
  });

  it('out of scope is static copy with a free keyword search', async () => {
    freshApi();
    installTurnstile();
    await askFromHome('Write a poem about clouds');
    expect(await screen.findByText('This tool only searches NTSB aviation investigations.', {}, SLOW)).toBeTruthy();
    expect(screen.getByText('Try a question about what happened in past accidents or incidents.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search by keyword instead' })).toBeTruthy();
  });

  it('editing the AI reading or the filters is a refinement that says "· uses 1"; keyword results stay free', async () => {
    freshApi();
    installTurnstile();
    await askFromHome(MOCK_SEED_QUESTION);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Within 30 days or 10 flight hours.*edit/ }));
    const editor = screen.getByRole('group', { name: "Change the AI's reading" });
    expect(document.activeElement).toBe(editor);
    fireEvent.change(within(editor).getByLabelText('Flight hours'), { target: { value: '5' } });
    fireEvent.click(within(editor).getByRole('button', { name: /^Re-run AI\s*·\s*uses 1$/ }));
    expect(await screen.findByText('Reading changed: Within 30 days or 5 flight hours', {}, SLOW)).toBeTruthy();
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);

    const plus = screen.getByRole('button', { name: '+ Filter' });
    act(() => plus.focus());
    fireEvent.click(plus);
    const add = screen.getByRole('group', { name: 'Add a filter' });
    fireEvent.change(within(add).getByLabelText('Filter'), { target: { value: 'category' } });
    fireEvent.change(within(add).getByLabelText('Value'), { target: { value: 'HELI' } });
    expect(within(add).getByRole('button', { name: /^Re-run AI\s*·\s*uses 1$/ })).toBeTruthy();
    expect(within(add).getByRole('link', { name: /Show keyword results/ }).getAttribute('href')).toBe('/explore?category=HELI');
    fireEvent.keyDown(add, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Add a filter' })).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it('no supported match shows the server lines and plain cards', async () => {
    freshApi();
    installTurnstile();
    await askFromHome('Engine power loss after maintenance, no match');
    expect(await screen.findByText(NO_MATCH_LINES[0], {}, SLOW)).toBeTruthy();
    for (const line of NO_MATCH_LINES.slice(1)) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /AI summary/i })).toBeNull();
    expect(document.querySelectorAll('article[data-card]')).toHaveLength(4);
    expect(screen.queryByText(/why it matched/i)).toBeNull();
  });

  it('cancel ends the step, which still counts', async () => {
    freshApi({ briefPolls: 50 });
    installTurnstile();
    await askFromHome(MOCK_SEED_QUESTION);
    fireEvent.click(await within(await screen.findByRole('region', { name: /answer checklist/i })).findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('You cancelled this AI search.', {}, SLOW)).toBeTruthy();
    expect(screen.getByText('This counted as a search, because the AI work was already under way.')).toBeTruthy();
  });

  it('an expired brief offers an empty search, and Ask again only from this page’s memory', async () => {
    freshApi();
    installTurnstile();
    server.use(http.get('*/api/briefs/:id', () => HttpResponse.json({ error: 'not_found', message: 'Gone.' }, { status: 404 })));
    await askFromHome(MOCK_SEED_QUESTION);
    expect(await screen.findByRole('heading', { name: 'This AI search has expired.' })).toBeTruthy();
    expect(screen.getByText('We delete questions and answers after 24 hours.')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Search NTSB investigations' }) as HTMLTextAreaElement;
    expect(box.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(box.value).toBe(MOCK_SEED_QUESTION);
  });
});

describe('Brief outcomes read from the server', { timeout: 15_000 }, () => {
  const step = (id: string, result: unknown) =>
    BriefStepResponseSchema.parse({
      briefId: id,
      step: 1,
      steps: 1,
      refinementsLeft: 3,
      question: 'Engine failure after an oil change',
      origin: { kind: 'question' },
      stage: 'failed',
      checklist: { question: 'in_scope' },
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:00:30.000Z',
      expiresAt: '2026-10-23T10:00:00.000Z',
      result,
    });

  it('a failure says whether it counted', async () => {
    server.use(http.get('*/api/briefs/:id', ({ params }) => HttpResponse.json(step(String(params.id), { kind: 'failed', countedAsSearch: true }))));
    renderApp('/briefs/00000000-0000-4000-8000-00000000abcd');
    const title = await screen.findByText("The AI search didn't finish.");
    expect(title.parentElement?.textContent).toBe(
      "The AI search didn't finish.Something went wrong before an answer was ready.Try again · uses 1Search by keyword insteadThis counted as a search, because the AI work was already under way.",
    );
    // Shown as page content: the page announces a failure it saw happen, once.
    expect(title.closest('[role="alert"]')).toBeNull();
  });

  it('Try again on a failed first step asks again with the brief\'s filters', async () => {
    const posted: unknown[] = [];
    freshApi();
    installTurnstile();
    server.use(
      http.get('*/api/briefs/:id', ({ params }) =>
        String(params.id).endsWith('abcd')
          ? HttpResponse.json({
              ...step(String(params.id), { kind: 'failed', countedAsSearch: true }),
              checklist: { question: 'in_scope', interpretation: { interpretations: [], filters: { category: ['HELI'] } } },
            })
          : undefined,
      ),
      http.post('*/api/briefs', async ({ request }) => {
        posted.push(await request.clone().json());
        return undefined;
      }),
    );
    renderApp('/briefs/00000000-0000-4000-8000-00000000abcd');
    fireEvent.click(await screen.findByRole('button', { name: /^Try again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(posted).toHaveLength(1), SLOW);
    expect(posted[0]).toMatchObject({ question: 'Engine failure after an oil change', filters: { category: ['HELI'] } });
  });

  describe('Try again on a failed first step that this page asked', () => {
    // The scope stage settled on more than the reader set: Helicopters and Fatal were inferred.
    const failedAfterScope = (id: string) => ({
      ...step(id, { kind: 'failed', countedAsSearch: true }),
      checklist: { question: 'in_scope', interpretation: { interpretations: [], filters: { category: ['HELI'], injury: ['FATL'] } } },
    });

    /** Fails every brief read the way the scope stage left it, and records each brief POST body. */
    function failAndRecordPosts(): Record<string, unknown>[] {
      const posted: Record<string, unknown>[] = [];
      server.use(
        http.get('*/api/briefs/:id', ({ params }) => HttpResponse.json(failedAfterScope(String(params.id)))),
        http.post('*/api/briefs', async ({ request }) => {
          posted.push((await request.clone().json()) as Record<string, unknown>);
          return undefined;
        }),
      );
      return posted;
    }

    it('asked with no filters, it sends none: what the scope stage inferred is not pinned', async () => {
      freshApi();
      installTurnstile();
      const posted = failAndRecordPosts();
      await askFromHome(MOCK_SEED_QUESTION);
      expect(posted).toHaveLength(1);
      expect(posted[0]).not.toHaveProperty('filters');
      fireEvent.click(await screen.findByRole('button', { name: /^Try again\s*·\s*uses 1$/ }));
      await waitFor(() => expect(posted).toHaveLength(2), SLOW);
      expect(posted[1]).toMatchObject({ question: 'Engine failure after an oil change' });
      expect(posted[1]).not.toHaveProperty('filters');
    });

    it('asked with filters, it sends exactly those, not the ones the scope stage added', async () => {
      freshApi();
      installTurnstile();
      const posted = failAndRecordPosts();
      const { router } = renderApp(exploreHref({ category: ['HELI'] }, MOCK_SEED_QUESTION));
      const bar = await screen.findByRole('search');
      fireEvent.click(await within(bar).findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }, SLOW));
      await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
      expect(posted[0]).toMatchObject({ filters: { category: ['HELI'] } });
      fireEvent.click(await screen.findByRole('button', { name: /^Try again\s*·\s*uses 1$/ }, SLOW));
      await waitFor(() => expect(posted).toHaveLength(2), SLOW);
      expect(posted[1]?.filters).toEqual({ category: ['HELI'] });
    });
  });

  it('a case or compare link to a brief that is gone shows NTSB data with a muted note', async () => {
    renderApp('/cases/DFW08TA066?brief=not-a-brief&step=1');
    expect(await screen.findByText("The AI notes for this case have expired or aren't yours.")).toBeTruthy();
    renderApp('/compare?cases=DFW08TA066,MIA08LA156&brief=00000000-0000-4000-8000-00000000dead&step=1');
    expect(await screen.findByText("The AI notes for these cases have expired or aren't yours.")).toBeTruthy();
    expect(screen.queryByText(/Since maint/i)).toBeNull();
  });
});

describe('Try again after a failed step (review W-5, W-12)', { timeout: 20_000 }, () => {
  const ID = '00000000-0000-4000-8000-00000000f001';
  /** Step `n` of `steps`, failed before anything was spent, started by `origin`. */
  const failed = (n: number, steps: number, origin: BriefStepResponse['origin'], refinementsLeft: number) =>
    BriefStepResponseSchema.parse({
      briefId: ID,
      step: n,
      steps,
      refinementsLeft,
      question: MOCK_SEED_QUESTION,
      origin,
      stage: 'failed',
      checklist: {},
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:00:30.000Z',
      expiresAt: '2026-10-23T10:00:00.000Z',
      result: { kind: 'failed', countedAsSearch: false },
    });

  /** Records every brief POST (`create` or `refine`) with its body, then lets the mock answer. */
  function recordBriefPosts(): { path: 'create' | 'refine'; body: Record<string, unknown> }[] {
    const posts: { path: 'create' | 'refine'; body: Record<string, unknown> }[] = [];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        posts.push({ path: 'create', body: (await request.clone().json()) as Record<string, unknown> });
        return undefined;
      }),
      http.post('*/api/briefs/:id/refine', async ({ request }) => {
        posts.push({ path: 'refine', body: (await request.clone().json()) as Record<string, unknown> });
        return undefined;
      }),
    );
    return posts;
  }

  it('a failed edited reading is tried again as that reading, never as a new search with the question (W-5)', async () => {
    freshApi();
    installTurnstile();
    const { router } = await askFromHome(MOCK_SEED_QUESTION);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const id = currentUrl(router).split('/')[2] as string;
    let failNext = false;
    server.use(
      http.get('*/api/briefs/:id', ({ request }) =>
        failNext && new URL(request.url).searchParams.get('step') !== '1'
          ? HttpResponse.json({ ...failed(2, 2, { kind: 'interpretation', label: 'Within 14 days or 5 flight hours' }, 2), briefId: id })
          : undefined,
      ),
    );
    const posts = recordBriefPosts();
    fireEvent.click(screen.getByRole('button', { name: /Within 30 days or 10 flight hours.*edit/ }));
    const editor = screen.getByRole('group', { name: "Change the AI's reading" });
    fireEvent.change(within(editor).getByLabelText('Calendar days'), { target: { value: '14' } });
    fireEvent.change(within(editor).getByLabelText('Flight hours'), { target: { value: '5' } });
    failNext = true;
    fireEvent.click(within(editor).getByRole('button', { name: /^Re-run AI\s*·\s*uses 1$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Try again\s*·\s*uses 1$/ }, SLOW));
    await waitFor(() => expect(posts).toHaveLength(2), SLOW);
    expect(posts.map((p) => p.path)).toEqual(['refine', 'refine']);
    expect(posts[1]?.body).toMatchObject({ kind: 'interpretation', field: 'timing_window', value: { days: 14, flightHours: 5 } });
  });

  it('after a reload, a failed edited reading offers no Try again that would drop it (W-5)', async () => {
    const posts = recordBriefPosts();
    server.use(http.get('*/api/briefs/:id', () => HttpResponse.json(failed(2, 2, { kind: 'interpretation', label: 'Within 14 days or 5 flight hours' }, 2))));
    renderApp(`/briefs/${ID}`);
    const title = await screen.findByText("The AI search didn't finish.", {}, SLOW);
    const card = title.parentElement as HTMLElement;
    expect(within(card).queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(card.textContent).toContain(CHANGE_NOT_KEPT);
    expect(within(card).getByRole('link', { name: 'New search' }).getAttribute('href')).toBe('/');
    expect(posts).toHaveLength(0);
  });

  it('with no refinements left, a failed refinement offers no Try again that would start over with the question (W-5)', async () => {
    server.use(http.get('*/api/briefs/:id', () => HttpResponse.json(failed(4, 4, { kind: 'text', text: 'only helicopters' }, 0))));
    renderApp(`/briefs/${ID}`);
    const title = await screen.findByText("The AI search didn't finish.", {}, SLOW);
    const card = title.parentElement as HTMLElement;
    expect(within(card).queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(card.textContent).toContain(REFINEMENTS_USED);
    expect(within(card).getByRole('link', { name: 'New search' }).getAttribute('href')).toBe('/');
  });

  it('an earlier failed answer, with later ones in the brief, is not tried again from there (W-5)', async () => {
    server.use(
      http.get('*/api/briefs/:id', ({ request }) =>
        new URL(request.url).searchParams.get('step') === '2' ? HttpResponse.json(failed(2, 3, { kind: 'text', text: 'only helicopters' }, 1)) : undefined,
      ),
    );
    renderApp(`/briefs/${ID}?step=2`);
    const title = await screen.findByText("The AI search didn't finish.", {}, SLOW);
    expect(within(title.parentElement as HTMLElement).queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to the latest answer' }).getAttribute('href')).toBe(`/briefs/${ID}`);
  });

  it('a Try again that fails too is said in the same card: one failure box, one Try again (W-12)', async () => {
    freshApi();
    installTurnstile();
    server.use(
      http.get('*/api/briefs/:id', () => HttpResponse.json(failed(2, 2, { kind: 'text', text: 'only helicopters' }, 2))),
      // No answer comes back: whether it counted is unknown.
      http.post('*/api/briefs/:id/refine', () => HttpResponse.error()),
    );
    renderApp(`/briefs/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: /^Try again\s*·\s*uses 1$/ }, SLOW));
    expect(await screen.findByText(new RegExp(`^${RETRY_FAILED}`), {}, SLOW)).toBeTruthy();
    expect(screen.getAllByText("The AI search didn't finish.")).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Try again/ })).toHaveLength(1);
    const line = screen.getByText(new RegExp(`^${RETRY_FAILED}`));
    expect(line.textContent).toBe(`${RETRY_FAILED} If it went through, Try again opens it without using another search.`);
    // Said politely, from a region that was there before it.
    expect(line.getAttribute('aria-live')).toBe('polite');
  });
});

describe('The drawer steps through the cards in the order they are shown (review W-11)', { timeout: 20_000 }, () => {
  const ID = '00000000-0000-4000-8000-00000000d011';
  // Grouped: DEN08LA103 (causal), then DFW08TA066 (defect); MIA08LA156 in no group, so it is
  // shown last. The result lists them DFW, MIA, DEN.
  const answer = {
    ...RESULT_SAMPLES.answer,
    groups: [
      { kind: 'causal', caseNumbers: ['DEN08LA103'] },
      { kind: 'defect_not_causal', caseNumbers: ['DFW08TA066'] },
      { kind: 'no_fault', caseNumbers: [] },
      { kind: 'insufficient', caseNumbers: [] },
    ],
  };
  const step = BriefStepResponseSchema.parse({
    briefId: ID,
    step: 1,
    steps: 1,
    refinementsLeft: 3,
    question: MOCK_SEED_QUESTION,
    origin: { kind: 'question' },
    stage: 'done',
    checklist: { question: 'in_scope', searched: { cases: 3, passages: 9 }, written: true, verified: 'partially_checked', removedStatements: 0 },
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: '2026-10-22T10:00:40.000Z',
    expiresAt: '2026-10-23T10:00:00.000Z',
    result: answer,
  });

  it('‹ n of N › and the steps follow the sheet, groups first, then the cases in no group', async () => {
    expect(sheetOrder(step.result as Parameters<typeof sheetOrder>[0])).toEqual(['DEN08LA103', 'DFW08TA066', 'MIA08LA156']);
    server.use(
      http.get('*/api/briefs/:id', () => HttpResponse.json(step)),
      http.get('*/api/briefs/:id/steps/:n/cases/:ntsbNo', () => HttpResponse.json({ error: 'not_found', message: 'Gone.' }, { status: 404 })),
    );
    const { router } = renderApp(`/briefs/${ID}?case=DFW08TA066`);
    // The open drawer hides the sheet from the accessibility tree; its cards are still there.
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const shown = [...document.querySelectorAll('article[data-card]')].map((a) => a.getAttribute('data-card'));
    expect(shown).toEqual(['DEN08LA103', 'DFW08TA066', 'MIA08LA156']);
    expect(await within(dialog).findByText('2 of 3')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous case' }));
    await waitFor(() => expect(currentUrl(router)).toContain('case=DEN08LA103'));
    expect(await within(dialog).findByText('1 of 3')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next case' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Next case' }));
    await waitFor(() => expect(currentUrl(router)).toContain('case=MIA08LA156'));
    expect(await within(dialog).findByText('3 of 3')).toBeTruthy();
  });
});

describe('Polling (stops, honours Retry-After, backs off)', () => {
  const running = BriefStepResponseSchema.parse({
    briefId: '00000000-0000-4000-8000-000000000001',
    step: 1,
    steps: 1,
    refinementsLeft: 3,
    question: 'Q',
    origin: { kind: 'question' },
    stage: 'compose',
    checklist: { question: 'in_scope' },
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: null,
    expiresAt: '2026-10-23T10:00:00.000Z',
  });
  const query = (state: Partial<PollState['state']>): PollState => ({
    state: { data: undefined, status: 'success', error: null, dataUpdatedAt: 0, errorUpdateCount: 0, ...state },
  });

  it('polls a running step every second and stops once it is finished', () => {
    expect(briefPollDelay(query({ data: running, dataUpdatedAt: 1 }))).toBe(BRIEF_POLL_MS);
    expect(briefPollDelay(query({ data: { ...running, stage: 'done' }, dataUpdatedAt: 1 }))).toBe(false);
  });

  it('stops on a 404 or another refusal; a 429 waits for Retry-After', () => {
    expect(briefPollDelay(query({ status: 'error', error: new ApiError(404, null), errorUpdateCount: 1 }))).toBe(false);
    expect(briefPollDelay(query({ status: 'error', error: new ApiError(403, null), errorUpdateCount: 1 }))).toBe(false);
    expect(briefPollDelay(query({ status: 'error', error: new ApiError(429, null, 7), errorUpdateCount: 1 }))).toBe(7_000);
  });

  it('backs off exponentially after failures, up to 30 s, and resets after a good read', () => {
    const q = query({ data: running, dataUpdatedAt: 100 });
    expect(briefPollDelay(q)).toBe(BRIEF_POLL_MS);
    const delays: (number | false)[] = [];
    for (let n = 1; n <= 7; n++) {
      q.state = { ...q.state, status: 'error', error: new ApiError(503, null), errorUpdateCount: n };
      // The schedule is read many times per update; it must not count by itself.
      briefPollDelay(q);
      delays.push(briefPollDelay(q));
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, MAX_POLL_BACKOFF_MS, MAX_POLL_BACKOFF_MS, MAX_POLL_BACKOFF_MS]);
    q.state = { ...q.state, status: 'success', error: null, dataUpdatedAt: 200 };
    expect(briefPollDelay(q)).toBe(BRIEF_POLL_MS);
    q.state = { ...q.state, status: 'error', error: new TypeError('network'), errorUpdateCount: 8 };
    expect(briefPollDelay(q)).toBe(2_000);
  });

  it('a read that gets no answer gives up after READ_TIMEOUT_MS and counts as a failed read (review W-3)', async () => {
    // Stalled, not failed: the connection stays open and nothing comes back.
    server.use(
      http.get('*/api/briefs/:id', () => new Promise<Response>(() => {})),
      http.get('*/api/ai/status', () => new Promise<Response>(() => {})),
      http.get('*/api/config', () => new Promise<Response>(() => {})),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const context = { signal: new AbortController().signal } as Parameters<NonNullable<ReturnType<typeof briefStepQuery>['queryFn']>>[0];
      const poll = (briefStepQuery(running.briefId, null).queryFn as (c: typeof context) => Promise<unknown>)(context).then(
        () => 'answered',
        (err: unknown) => err,
      );
      const status = (aiStatusQuery().queryFn as (c: typeof context) => Promise<unknown>)(context).then(
        () => 'answered',
        (err: unknown) => err,
      );
      // The configuration too (re-review F-3): a hung read ends, and its re-read and neutral note take over.
      const config = (configQuery().queryFn as (c: typeof context) => Promise<unknown>)(context).then(
        () => 'answered',
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 100);
      let settled = false;
      void poll.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const [pollErr, statusErr, configErr] = await Promise.all([poll, status, config]);
      expect(pollErr).toBeInstanceOf(ReadTimeoutError);
      expect(statusErr).toBeInstanceOf(ReadTimeoutError);
      expect(configErr).toBeInstanceOf(ReadTimeoutError);
      // Not an ApiError: polling backs off and tries again, as after any failed read.
      expect(briefPollDelay(query({ data: running, dataUpdatedAt: 1, status: 'error', error: pollErr, errorUpdateCount: 1 }))).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('while polls of a running step fail, a muted line says so; the next good read clears it (review W-3)', { timeout: 20_000 }, async () => {
    let fail = false;
    server.use(
      http.get('*/api/briefs/:id', () =>
        fail ? HttpResponse.json({ error: 'internal', message: 'Oops.' }, { status: 500 }) : HttpResponse.json({ ...running, startedAt: new Date().toISOString() }),
      ),
    );
    renderApp(`/briefs/${running.briefId}`);
    const checklist = await screen.findByRole('region', { name: /answer checklist/i });
    const line = within(checklist).getByText((_, el) => el?.getAttribute('data-poll-trouble') !== null && el?.tagName === 'P');
    expect(line.textContent).toBe('');
    expect(line.getAttribute('aria-live')).toBe('polite');
    fail = true;
    await waitFor(() => expect(line.textContent).toBe(POLL_TROUBLE), { timeout: 8_000 });
    // The checklist stays as it was: nothing else changes while the page keeps trying.
    expect(within(checklist).getAllByRole('listitem')).toHaveLength(4);
    fail = false;
    await waitFor(() => expect(line.textContent).toBe(''), { timeout: 10_000 });
  });

  it('a stalled poll is said as soon as the read gives up after READ_TIMEOUT_MS, not after its retry gives up too (re-review N-5)', { timeout: 20_000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stall = false;
    server.use(
      http.get('*/api/briefs/:id', () =>
        stall ? new Promise<Response>(() => {}) : HttpResponse.json({ ...running, startedAt: new Date().toISOString() }),
      ),
    );
    renderApp(`/briefs/${running.briefId}`);
    const checklist = await screen.findByRole('region', { name: /answer checklist/i }, SLOW);
    const line = checklist.querySelector('[data-poll-trouble]') as HTMLElement;
    stall = true;
    // The next poll (within a second) gets no answer: nothing is said before it gives up ...
    await act(() => vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1_000));
    expect(line.textContent).toBe('');
    // ... and the line appears once it has, while its one retry is still waiting.
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    await waitFor(() => expect(line.textContent).toBe(POLL_TROUBLE), SLOW);
  });

  it('an expired brief is read once, then left alone', { timeout: 10_000 }, async () => {
    let reads = 0;
    server.use(
      http.get('*/api/briefs/:id', () => {
        reads += 1;
        return HttpResponse.json({ error: 'not_found', message: 'Gone.' }, { status: 404 });
      }),
    );
    renderApp('/briefs/00000000-0000-4000-8000-000000000404');
    expect(await screen.findByRole('heading', { name: 'This AI search has expired.' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2_500));
    expect(reads).toBe(1);
  });
});

describe('Chips while a step runs (UI_DESIGN §4.4)', () => {
  const base = BriefStepResponseSchema.parse({
    briefId: '00000000-0000-4000-8000-000000000001',
    step: 2,
    steps: 2,
    refinementsLeft: 2,
    question: 'Q',
    origin: { kind: 'text', text: 'only helicopters' },
    stage: 'retrieve',
    checklist: {},
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: null,
    expiresAt: '2026-10-23T10:00:00.000Z',
  });
  const previous = { ...base, step: 1, stage: 'done' as const, result: RESULT_SAMPLES.answer };
  const scoped = { interpretations: [], filters: { category: ['HELI'] } };

  it('a refinement shows the previous step\'s chips until its scope row sends its own', () => {
    expect(chipsContext(base, previous)).toBe(previous.result);
    expect(chipsContext({ ...base, checklist: { question: 'in_scope', interpretation: scoped } }, previous)).toBe(scoped);
    expect(chipsContext({ ...base, step: 1 }, undefined)).toBeNull();
    expect(chipsContext({ ...base, stage: 'done', result: RESULT_SAMPLES.midair }, previous)).toBe(RESULT_SAMPLES.midair);
  });

  it('a first step shows its chips as soon as the scope row is done', { timeout: 15_000 }, async () => {
    freshApi({ briefPolls: 3 });
    installTurnstile();
    await askFromHome(MOCK_SEED_QUESTION);
    const checklist = await screen.findByRole('region', { name: /answer checklist/i });
    expect(checklist).toBeTruthy();
    expect(await screen.findByText('Within 30 days or 10 flight hours')).toBeTruthy();
    // Read-only while the step runs: no ✎ edit control yet.
    expect(screen.queryByRole('button', { name: /Within 30 days.*edit/ })).toBeNull();
    expect(screen.getByRole('region', { name: /answer checklist/i })).toBeTruthy();
  });
});

describe('Two-aircraft events and adjacent citations', { timeout: 20_000 }, () => {
  it('two citations in a row are separated', () => {
    const segs = RESULT_SAMPLES.midair.summary;
    expect(segs.slice(0, 3).map((x) => x.kind)).toEqual(['text', 'case', 'case']);
    expect(citationJoiner(segs, 2)).toBe(',\u2009');
    expect(citationJoiner([{ kind: 'text', text: 'the power loss' }, { kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false }], 1)).toBe(' ');
    expect(citationJoiner([{ kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false }, { kind: 'text', text: 'Then' }], 1)).toBe(' ');
    expect(citationJoiner([{ kind: 'text', text: 'loss (' }, { kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false }, { kind: 'text', text: ').' }], 2)).toBe('');
  });

  it('a removed-statements marker (Task 16d) stands apart between whole sentences and never shows their text', () => {
    const segs: SummarySegment[] = [
      { kind: 'text', text: 'In the first case the pump failed.' },
      { kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false },
      { kind: 'removed', count: 2 },
      { kind: 'text', text: 'In the last case the seal leaked.' },
    ];
    expect(citationJoiner(segs, 2)).toBe(' ');
    expect(citationJoiner(segs, 3)).toBe(' ');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BriefingSheet result={{ ...RESULT_SAMPLES.midair, summary: segs }} caseTo={(n) => `/briefs/x?case=${n}`} inCompare={() => false} onToggleCompare={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('[2 statements not shown: the check could not confirm them]')).toBeTruthy();
  });

  it('cards and the sheet say the evidence is the event narrative, never one aircraft', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BriefingSheet result={RESULT_SAMPLES.midair} caseTo={(n) => `/briefs/x?case=${n}`} inCompare={() => false} onToggleCompare={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const summary = screen.getByRole('heading', { name: /AI summary/i }).parentElement as HTMLElement;
    expect(summary.textContent).toContain('the airplanes collided SEA08LA057,\u2009WPR15FA010. In one,');
    const card = document.querySelector('article[data-card="SEA08LA057"]') as HTMLElement;
    expect(card.textContent).toContain('2 aircraft');
    expect(card.textContent).toContain('A Piper PA 28-180 · B Barnard/Stancil Glastar');
    expect(card.textContent).toContain('Applies to the event; aircraft not stated');
    expect(card.textContent).toContain('Event narrative, both aircraft — not attributed to one aircraft');
    expect(within(card).getAllByText(/NTSB · ANALYSIS · EVENT NARRATIVE, BOTH AIRCRAFT/)).toHaveLength(2);
    expect(card.textContent).not.toMatch(/Aircraft A\b|AIRCRAFT A\b/);
    // Examples found: one list, and no glyph for an event-scoped reading.
    expect(screen.getByRole('region', { name: 'Examples found, 2 cases' })).toBeTruthy();
    expect(card.querySelector('[data-glyph]')).toBeNull();
  });

  it('Compare\'s AI columns name the event narrative for a two-aircraft event', async () => {
    freshApi();
    installTurnstile();
    const { router } = await askFromHome(MOCK_MIDAIR_QUESTION);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const id = currentUrl(router).split('/')[2] as string;
    await act(() => router.navigate(`/compare?cases=SEA08LA057,WPR15FA010&brief=${id}&step=1`));
    const strip = await screen.findByRole('article', { name: 'SEA08LA057, strip 1' }, SLOW);
    expect(await within(strip).findByText('Event narrative, both aircraft — not attributed to one aircraft', {}, SLOW)).toBeTruthy();
    expect(within(strip).getByText('Not classified')).toBeTruthy();
  });
});

describe('Failures are not expiry', { timeout: 20_000 }, () => {
  it('a rate-limited AI context read offers a retry instead of "expired"', async () => {
    freshApi();
    installTurnstile();
    let contextReads = 0;
    server.use(
      http.get('*/api/briefs/:id/steps/:n/cases/:ntsbNo', () => {
        contextReads += 1;
        return contextReads === 1 ? HttpResponse.json({ error: 'rate_limited', message: 'Slow down.', retryAfter: 2 }, { status: 429 }) : undefined;
      }),
    );
    await askFromHome(MOCK_SEED_QUESTION);
    const label = await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    fireEvent.click(within(label.parentElement as HTMLElement).getByRole('link', { name: 'DFW08TA066' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/The AI notes for this case didn't load\./, {}, SLOW)).toBeTruthy();
    expect(within(dialog).queryByText(/expired or aren't yours/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText(/Why it.s in your results/i, {}, SLOW)).toBeTruthy();
  });

  it('a failed public case read says so on the card; a failed AI read says so in Compare', async () => {
    freshApi();
    installTurnstile();
    server.use(
      http.get('*/api/cases/DFW08TA066', () => HttpResponse.json({ error: 'internal', message: 'Oops.' }, { status: 500 })),
      http.get('*/api/briefs/:id/steps/:n/cases/MIA08LA156', () => HttpResponse.json({ error: 'internal', message: 'Oops.' }, { status: 500 })),
    );
    const { router } = await askFromHome(MOCK_SEED_QUESTION);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const card = document.querySelector('article[data-card="DFW08TA066"]') as HTMLElement;
    expect(await within(card).findByText(/Couldn't load the flight profile and data cautions\./, {}, SLOW)).toBeTruthy();
    const id = currentUrl(router).split('/')[2] as string;
    await act(() => router.navigate(`/compare?cases=MIA08LA156,DEN08LA103&brief=${id}&step=1`));
    const strip = await screen.findByRole('article', { name: 'MIA08LA156, strip 1' }, SLOW);
    expect((await within(strip).findAllByText(/The AI reading didn't load\./, {}, SLOW)).length).toBeGreaterThan(0);
    expect(within(strip).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /** Records each brief POST's idempotency key, then lets the mock answer. */
  const recordKeys = (): string[] => {
    const keys: string[] = [];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return undefined;
      }),
    );
    return keys;
  };
  const askOnHome = async (question: string) => {
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: question } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    return app;
  };

  it('a lost response: the notice does not claim it was free, and Try again replays the same key (no second charge)', async () => {
    freshApi();
    installTurnstile();
    const keys = recordKeys();
    // The mock starts the brief, then the answer is lost on the way back.
    const { router } = await askOnHome('Engine power loss after maintenance, lost response');
    expect(await screen.findByText('If it went through, Try again opens it without using another search.', {}, SLOW)).toBeTruthy();
    expect(screen.queryByText("This didn't use one of your searches.")).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Try again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    // The replay returned the brief the lost request had started: one search used, not two.
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 2 of 3'), SLOW);
  });

  it('a lost response whose replay is a 409 conflict is asked once more under a new key', async () => {
    freshApi();
    installTurnstile();
    const keys = recordKeys();
    // The request never made a step: the server keeps its key with no result.
    const { router } = await askOnHome('Engine power loss after maintenance, lost before start');
    expect(await screen.findByText('If it went through, Try again opens it without using another search.', {}, SLOW)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Try again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    // The same key first (a replay), then, after its 409, a new one.
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(screen.queryByText(/accepted earlier but did not start/)).toBeNull();
  });

  it('a 503 "unavailable" shows the paused copy, and the next ask uses a new key', async () => {
    freshApi();
    installTurnstile();
    const keys = recordKeys();
    const { router } = await askOnHome('Engine power loss after maintenance, unavailable');
    expect(await screen.findByText('AI search is temporarily unavailable.', {}, SLOW)).toBeTruthy();
    // Known outcome: nothing was spent, so the free-search claim is not withheld here.
    expect(screen.queryByText('If it went through, Try again opens it without using another search.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    // A same-key retry would be a 409 (the server keeps the released key); a new key starts the brief.
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('?step past the last answer shows the latest, with a note', async () => {
    freshApi();
    installTurnstile();
    const { router } = await askFromHome(MOCK_SEED_QUESTION);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    await act(() => router.navigate(`${currentUrl(router)}?step=3`));
    expect(await screen.findByText('There is no answer 3 in this brief; this is the latest.', { selector: 'p:not(.sr-only)' }, SLOW)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /AI summary/i })).toBeTruthy();
    expect(screen.queryByText('This AI search has expired.')).toBeNull();
  });

  it('a paused Ask AI button is described by its note', () => {
    withStatus(AI_STATUS_SAMPLES.pausedDaily, <AskAiButton onAsk={() => {}} />);
    const button = screen.getByRole('button', { name: /^Ask AI/ });
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('AI back tomorrow');
  });
});

describe('Two AI controls at once (TurnstileGate sessions)', () => {
  it('a second check waits its turn; ending one session never cancels another', async () => {
    const solves = new Map<string, (t: string) => void>();
    const removed: string[] = [];
    let n = 0;
    window.turnstile = {
      render(_host, params) {
        n += 1;
        solves.set(`w${n}`, params.callback);
        return `w${n}`;
      },
      remove(id) {
        removed.push(id);
      },
    };
    let gate: AiCheck | null = null;
    function Probe() {
      gate = useAiCheck();
      return null;
    }
    const client = new QueryClient();
    client.setQueryData(['config'], { turnstileSiteKey: TURNSTILE_TEST_SITE_KEY });
    render(
      <QueryClientProvider client={client}>
        <TurnstileGate>
          <Probe />
        </TurnstileGate>
      </QueryClientProvider>,
    );
    const check = gate as unknown as AiCheck;
    const a = check.session();
    const b = check.session();
    const c = check.session();
    const ta = a.token({ first: false });
    const tb = b.token({ first: false });
    const tc = c.token({ first: false }).catch((e: Error) => e.message);
    await waitFor(() => expect(solves.size).toBe(1));
    act(() => solves.get('w1')?.('token-a'));
    expect(await ta).toBe('token-a');
    // B waits until A's request is over, even though A's token is taken.
    await new Promise((r) => setTimeout(r, 20));
    expect(solves.size).toBe(1);
    // C gives up while waiting: that must not let anyone jump the queue or cancel B.
    c.release();
    expect(await tc).toBe('AI check cancelled');
    a.release();
    await waitFor(() => expect(solves.size).toBe(2));
    act(() => solves.get('w2')?.('token-b'));
    expect(await tb).toBe('token-b');
    b.release();
    expect(solves.size).toBe(2);
    expect(removed).toEqual(['w1', 'w2']);
  });
});

describe('Unknown outcomes stay unknown until a 2xx or a 409 settles them', { timeout: 20_000 }, () => {
  type Check = 'ok' | 'fail' | 'interactive' | 'broken';
  /** A widget whose next checks pass, fail, ask for interaction (and never finish) or will not render. */
  function controllableTurnstile(): { mode: Check } {
    const ctl: { mode: Check } = { mode: 'ok' };
    const live = new Map<string, HTMLElement>();
    let n = 0;
    window.turnstile = {
      render(host, params) {
        if (ctl.mode === 'broken') return undefined;
        n += 1;
        const id = `w${n}`;
        const box = document.createElement('div');
        host.appendChild(box);
        live.set(id, box);
        const mode = ctl.mode;
        setTimeout(() => {
          if (!live.has(id)) return;
          if (mode === 'fail') params['error-callback']();
          else if (mode === 'interactive') params['before-interactive-callback']();
          else params.callback(`TOKEN-${id}`);
        }, 10);
        return id;
      },
      remove(id) {
        live.get(id)?.remove();
        live.delete(id);
      },
    };
    return ctl;
  }

  const UNKNOWN_LINE = 'If it went through, Try again opens it without using another search.';
  const FREE_CLAIM = "This didn't use one of your searches.";

  interface Arrange {
    /** Before Try again: how the retry is refused. */
    before(ctl: { mode: Check }, set: (s: AiStatusResponse | null) => void): void;
    /** What the reader sees after the refused retry. */
    seen(): Promise<void>;
    /** Brief POSTs the refused retry sent (0: refused before sending). */
    sent: number;
  }

  const paused = AI_STATUS_SAMPLES.pausedDaily;
  const trialUsed = AI_STATUS_SAMPLES.trialUsed;
  const cases: [string, Arrange][] = [
    [
      'a failed check',
      {
        before: (ctl) => (ctl.mode = 'fail'),
        seen: async () => {
          expect(await screen.findByText("The quick check didn't finish.", {}, SLOW)).toBeTruthy();
          // The check sent nothing, but the lost request may have counted.
          expect(screen.getByText(UNKNOWN_LINE)).toBeTruthy();
          expect(screen.queryByText(FREE_CLAIM)).toBeNull();
        },
        sent: 0,
      },
    ],
    [
      'a check that cannot load',
      {
        before: (ctl) => (ctl.mode = 'broken'),
        seen: async () => {
          expect(await screen.findByText("The quick check couldn't load, so the AI can't run right now.", {}, SLOW)).toBeTruthy();
          expect(screen.getByText(UNKNOWN_LINE)).toBeTruthy();
          expect(screen.queryByText(FREE_CLAIM)).toBeNull();
        },
        sent: 0,
      },
    ],
    [
      'a cancelled check',
      {
        before: (ctl) => (ctl.mode = 'interactive'),
        seen: async () => {
          const panel = await screen.findByRole('dialog', { name: LATER_CHECK_TITLE }, SLOW);
          fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
          // Back where the reader was: the unknown outcome is still said.
          expect(await screen.findByText(UNKNOWN_LINE, {}, SLOW)).toBeTruthy();
        },
        sent: 0,
      },
    ],
    [
      'a paused AI status',
      {
        before: (_ctl, set) => set(paused),
        seen: async () => {
          expect(await screen.findByText('AI search is done for today.', {}, SLOW)).toBeTruthy();
        },
        sent: 0,
      },
    ],
    [
      'a used-up trial',
      {
        before: (_ctl, set) => set(trialUsed),
        seen: async () => {
          expect(await screen.findByText('That was your third free AI search.', {}, SLOW)).toBeTruthy();
        },
        sent: 0,
      },
    ],
  ];

  it.each(cases)('after a lost response, a retry refused by %s keeps the first key for the next ask', async (_name, arrange) => {
    freshApi();
    const ctl = controllableTurnstile();
    let status: AiStatusResponse | null = null;
    const keys: string[] = [];
    server.use(
      http.get('*/api/ai/status', () => (status ? HttpResponse.json(status) : undefined)),
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return undefined;
      }),
    );
    const { router, client } = renderApp('/');
    const question = 'Engine power loss after maintenance, lost response';
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: question } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByText(UNKNOWN_LINE, {}, SLOW)).toBeTruthy();
    expect(keys).toHaveLength(1);

    let changed: AiStatusResponse | null = null;
    arrange.before(ctl, (next) => {
      changed = next;
      status = next;
    });
    if (changed) {
      await act(() => client.invalidateQueries({ queryKey: ['ai-status'] }));
      // The header shows the new status before the retry, so the retry reads it too.
      const counter = changed === paused ? 'AI back tomorrow' : 'Free AI searches used';
      await waitFor(() => expect(screen.getByRole('banner').textContent).toContain(counter), SLOW);
    }
    fireEvent.click(screen.getByRole('button', { name: /^Try again/ }));
    await arrange.seen();
    expect(keys).toHaveLength(1 + arrange.sent);

    // Everything back to normal: asking again replays the first key, so it is paid once.
    ctl.mode = 'ok';
    status = null;
    await act(() => client.invalidateQueries({ queryKey: ['ai-status'] }));
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*2 free$/ }, SLOW));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(keys.at(-1)).toBe(keys[0]);
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 2 of 3'), SLOW);
  });

  it('after a lost response, a known refusal of the replay (503, 429) keeps the first key too', async () => {
    freshApi();
    controllableTurnstile();
    const keys: string[] = [];
    const answers: (() => Response | undefined)[] = [
      () => undefined,
      () => HttpResponse.json({ error: 'unavailable', message: 'Not now.' }, { status: 503 }),
      () => HttpResponse.json({ error: 'rate_limited', message: 'Slow down.', retryAfter: 3 }, { status: 429 }),
    ];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return answers[keys.length - 1]?.();
      }),
    );
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), {
      target: { value: 'Engine power loss after maintenance, lost response' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByText(UNKNOWN_LINE, {}, SLOW)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Try again/ }));
    expect(await screen.findByText('AI search is temporarily unavailable.', {}, SLOW)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*2 free$/ }, SLOW));
    expect(await screen.findByText('Slow down a moment. Try again in 3 seconds.', {}, SLOW)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*2 free$/ }, SLOW));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 2 of 3'), SLOW);
  });
});

describe('Round-2 minors', { timeout: 20_000 }, () => {
  it('?step past the last answer still announces the latest step finishing, after the note (Task 17 parked item)', async () => {
    const id = '00000000-0000-4000-8000-0000000000ce';
    const base = {
      briefId: id,
      step: 1,
      steps: 1,
      refinementsLeft: 3,
      question: 'Q',
      origin: { kind: 'question' },
      startedAt: new Date().toISOString(),
      expiresAt: '2099-10-23T10:00:00.000Z',
    };
    let reads = 0;
    server.use(
      http.get('*/api/briefs/:id', ({ request }) => {
        if (new URL(request.url).searchParams.get('step') === '3') return HttpResponse.json({ error: 'not_found', message: 'x' }, { status: 404 });
        reads += 1;
        return HttpResponse.json(
          reads === 1
            ? { ...base, stage: 'compose', checklist: { question: 'in_scope', searched: { cases: 3, passages: 9 } }, finishedAt: null }
            : {
                ...base,
                stage: 'done',
                checklist: { question: 'in_scope', searched: { cases: 3, passages: 9 }, written: true, verified: 'partially_checked', removedStatements: 0 },
                finishedAt: new Date().toISOString(),
                result: RESULT_SAMPLES.answer,
              },
        );
      }),
    );
    const page = renderApp(`/briefs/${id}?step=3`);
    await screen.findByRole('region', { name: /answer checklist/i }, SLOW);
    const region = page.container.querySelector('p[aria-live="polite"]') as HTMLElement;
    expect(region.textContent).toBe('There is no answer 3 in this brief; this is the latest.');
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    expect(page.container.querySelector('p[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe('There is no answer 3 in this brief; this is the latest. The answer is ready.');
  });

  it('?step past the last answer shows no load error while the latest step is read', async () => {
    const id = '00000000-0000-4000-8000-0000000000cc';
    const latest = {
      briefId: id,
      step: 2,
      steps: 2,
      refinementsLeft: 1,
      question: 'Q',
      origin: { kind: 'text', text: 'x' },
      stage: 'done',
      checklist: { question: 'in_scope', searched: { cases: 4, passages: 9 }, written: true, verified: 'passed' },
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:00:20.000Z',
      expiresAt: '2026-10-23T10:00:00.000Z',
      result: RESULT_SAMPLES.answer,
    };
    server.use(
      http.get('*/api/briefs/:id', async ({ request }) => {
        if (new URL(request.url).searchParams.get('step') === '3') return HttpResponse.json({ error: 'not_found', message: 'x' }, { status: 404 });
        await new Promise((r) => setTimeout(r, 400));
        return HttpResponse.json(latest);
      }),
    );
    renderApp(`/briefs/${id}?step=3`);
    const seen: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(Boolean(screen.queryByText('This AI search didn’t load.', { ignore: '.sr-only' })) || document.querySelector('[role="alert"]') !== null);
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(seen.every((v) => !v)).toBe(true);
    expect(await screen.findByText('There is no answer 3 in this brief; this is the latest.', { selector: 'p:not(.sr-only)' }, SLOW)).toBeTruthy();
  });

  it('the brief page and Compare announce notes from a live region that was there first', async () => {
    server.use(
      http.get('*/api/briefs/:id', async ({ params }) => {
        await new Promise((r) => setTimeout(r, 300));
        return String(params.id).endsWith('404')
          ? HttpResponse.json({ error: 'not_found', message: 'Gone.' }, { status: 404 })
          : HttpResponse.json({ error: 'internal', message: 'Oops.' }, { status: 500 });
      }),
    );
    const page = renderApp('/briefs/00000000-0000-4000-8000-000000000404');
    // The page (loaded lazily) renders its live region empty while it reads the brief.
    const region = await waitFor(() => {
      const el = page.container.querySelector('p[aria-live="polite"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(region.textContent).toBe('');
    await screen.findByRole('heading', { name: 'This AI search has expired.' }, SLOW);
    expect(page.container.querySelector('p[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe('This AI search has expired.');
    page.unmount();

    const compare = renderApp('/compare?cases=DFW08TA066,MIA08LA156&brief=00000000-0000-4000-8000-000000000500&step=1');
    const notes = await waitFor(() => {
      const el = compare.container.querySelector('div[aria-live="polite"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(notes.textContent).toBe('');
    await waitFor(() => expect(notes.textContent).toContain("The AI notes for these cases didn't load."), { timeout: 8_000 });
    expect(within(notes).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a refinement key is tied to its brief and change', async () => {
    const change = { kind: 'text', text: 'only helicopters' } as const;
    const a = await unsettledId({ kind: 'refine', briefId: '00000000-0000-4000-8000-00000000000a', change });
    const b = await unsettledId({ kind: 'refine', briefId: '00000000-0000-4000-8000-00000000000b', change });
    const other = await unsettledId({ kind: 'refine', briefId: '00000000-0000-4000-8000-00000000000a', change: { kind: 'text', text: 'only airplanes' } });
    expect(new Set([a, b, other]).size).toBe(3);
  });

  it('an aircraft-scoped key the record does not list is never shown as both aircraft', () => {
    const aircraft = [
      { aircraftKey: 1, aircraftNtsbNo: 'SEA08LA057A', make: 'PIPER', model: 'PA 28-180' },
      { aircraftKey: 2, aircraftNtsbNo: 'SEA08LA057B', make: 'Barnard/Stancil', model: 'Glastar' },
    ];
    const unknown = { scope: 'aircraft', aircraftKey: 7 } as const;
    expect(evidenceAttribution('SEA08LA057', aircraft, unknown)).toBe('Aircraft not identified in this record — not attributed to one aircraft');
    expect(attributionAmbiguous(aircraft, unknown)).toBe(true);
    expect(quoteAttribution('SEA08LA057', aircraft, { scope: 'aircraft', aircraftKey: 7 })).toBe('AIRCRAFT NOT STATED');
    // A known aircraft is named; event evidence is the event narrative.
    expect(evidenceAttribution('SEA08LA057', aircraft, { scope: 'aircraft', aircraftKey: 2 })).toBe('Aircraft B · Barnard/Stancil Glastar');
    expect(attributionAmbiguous(aircraft, { scope: 'aircraft', aircraftKey: 2 })).toBe(false);
    expect(attributionAmbiguous(aircraft, { scope: 'event', multiAircraft: true })).toBe(true);
    expect(attributionAmbiguous(aircraft.slice(0, 1), { scope: 'aircraft', aircraftKey: 7 })).toBe(false);
  });
});

describe('Unknown-outcome keys for the tab (web/src/features/ai/unsettled.ts)', { timeout: 20_000 }, () => {
  const LOST = 'Engine power loss after maintenance, lost response';

  /** Records each brief POST's idempotency key, then lets the mock answer. */
  function recordPosts(): string[] {
    const keys: string[] = [];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return undefined;
      }),
    );
    return keys;
  }

  async function loseOnHome() {
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: LOST } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByText('If it went through, Try again opens it without using another search.', {}, SLOW)).toBeTruthy();
    return app;
  }

  it('a lost response on Home, then the same question from Explore, reuses the key (paid once)', async () => {
    freshApi();
    installTurnstile();
    const keys = recordPosts();
    const { router } = await loseOnHome();
    // Another page, another control: Explore's search bar, with no filters set.
    await act(() => router.navigate(`/explore?${new URLSearchParams({ q: LOST }).toString()}`));
    const bar = await screen.findByRole('search');
    fireEvent.click(await within(bar).findByRole('button', { name: /^Ask AI\s*·\s*2 free$/ }, SLOW));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 2 of 3'), SLOW);
    // Settled once the brief page shows the step the replay returned: nothing is left for the tab.
    const id = await unsettledId({ kind: 'create', question: LOST, filters: {} });
    await waitFor(() => expect(unsettledKey(id)).toBeNull(), SLOW);
  });

  it('a different question gets a new key', async () => {
    freshApi();
    installTurnstile();
    const keys = recordPosts();
    const { router } = await loseOnHome();
    await act(() => router.navigate(`/explore?${new URLSearchParams({ q: 'Rotor failure after an oil change' }).toString()}`));
    const bar = await screen.findByRole('search');
    fireEvent.click(await within(bar).findByRole('button', { name: /^Ask AI\s*·\s*2 free$/ }, SLOW));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    // The lost question's key is still there for when it is asked again.
    expect(unsettledKey(await unsettledId({ kind: 'create', question: LOST }))).toBe(keys[0]);
  });

  it('stores a hash of the normalised request, never the question', async () => {
    freshApi();
    installTurnstile();
    await loseOnHome();
    const names = Object.keys(window.sessionStorage);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^casebook-ai-unsettled:[0-9a-f]{64}$/);
    const stored = window.sessionStorage.getItem(names[0] as string) ?? '';
    expect(Object.keys(JSON.parse(stored))).toEqual(['key', 'at']);
    expect(`${names[0]}${stored}`.toLowerCase()).not.toContain('engine');
    expect(`${names[0]}${stored}`.toLowerCase()).not.toContain('maintenance');
  });

  it('the same request is the same however its filters are ordered', async () => {
    const a = await unsettledId({ kind: 'create', question: 'Q', filters: { phase: ['landing', 'takeoff'], category: ['HELI'] } });
    const b = await unsettledId({ kind: 'create', question: 'Q', filters: { category: ['HELI'], phase: ['takeoff', 'landing'], injury: [] } });
    expect(a).toBe(b);
    expect(await unsettledId({ kind: 'create', question: 'Q' })).toBe(await unsettledId({ kind: 'create', question: 'Q', filters: {} }));
    // The server hashes the same canonical filters, and keeps its record as long.
    const f = { phase: ['landing', 'takeoff'], category: ['HELI', 'AIR'], yearTo: 2020 } as Parameters<typeof canonicalFilters>[0];
    expect(canonicalFilters(f)).toEqual(serverCanonicalFilters(f));
    expect(FILTER_FACETS).toEqual(BRIEF_FILTER_FACETS);
    expect(UNSETTLED_TTL_MS).toBe(IDEMPOTENCY_TTL_MS);
  });

  it('an entry expires with the server\'s idempotency record', async () => {
    const id = await unsettledId({ kind: 'create', question: 'Q' });
    const t0 = Date.UTC(2026, 9, 22, 10, 0, 0);
    rememberUnsettled(id, 'key-00000001', t0);
    expect(unsettledKey(id, t0 + UNSETTLED_TTL_MS - 1)).toBe('key-00000001');
    // Remembered again under the same key, it keeps its first time.
    rememberUnsettled(id, 'key-00000001', t0 + 60_000);
    expect(unsettledKey(id, t0 + UNSETTLED_TTL_MS)).toBeNull();
    expect(Object.keys(window.sessionStorage)).toHaveLength(0);
    // Remembering another request prunes expired entries too.
    const other = await unsettledId({ kind: 'create', question: 'R' });
    rememberUnsettled(id, 'key-00000002', t0);
    rememberUnsettled(other, 'key-00000003', t0 + UNSETTLED_TTL_MS + 1);
    expect(Object.keys(window.sessionStorage)).toHaveLength(1);
    forgetUnsettled(other);
    expect(unsettledKey(other)).toBeNull();
  });

  it('storage that throws falls back to memory', async () => {
    const id = await unsettledId({ kind: 'create', question: 'Q' });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      rememberUnsettled(id, 'key-00000004');
      expect(unsettledKey(id)).toBe('key-00000004');
      forgetUnsettled(id);
      expect(unsettledKey(id)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }
    // A store that refuses writes (quota) keeps the entry in memory too.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    rememberUnsettled(id, 'key-00000005');
    expect(unsettledKey(id)).toBe('key-00000005');
    setItem.mockRestore();
  });
});

describe('Write-ahead keys: a reload while the request is in flight pays once (review W-2)', { timeout: 20_000 }, () => {
  const ENTRY = 'casebook-ai-unsettled:';
  const stored = (): Record<string, { key: string; at: number }> =>
    Object.fromEntries(
      Object.keys(window.sessionStorage)
        .filter((name) => name.startsWith(ENTRY))
        .map((name) => [name.slice(ENTRY.length), JSON.parse(window.sessionStorage.getItem(name) ?? 'null') as { key: string; at: number }]),
    );

  /** Holds every POST to `path` (recording its key) until `release`, then lets the mock answer it. */
  function holdPosts(path: string): { keys: string[]; release(): void } {
    const keys: string[] = [];
    const held: (() => void)[] = [];
    server.use(
      http.post(path, async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        await new Promise<void>((resolve) => held.push(resolve));
        return undefined;
      }),
    );
    return { keys, release: () => held.splice(0).forEach((go) => go()) };
  }

  it('Ask AI keeps its key for the tab before the request leaves; the same question after a reload replays it', async () => {
    freshApi();
    installTurnstile();
    const posts = holdPosts('*/api/briefs');
    const first = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    await waitFor(() => expect(posts.keys).toHaveLength(1), SLOW);
    // In flight (the server waits for its scope stage): the button says so ...
    expect(screen.getByRole('button', { name: 'Starting…' }).getAttribute('aria-busy')).toBe('true');
    // ... and the key is already kept for this tab, under the request's hash.
    const id = await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION });
    expect(stored()).toEqual({ [id]: { key: posts.keys[0], at: expect.any(Number) } });

    // The reader reloads: the page and its memory go, this tab's session storage stays.
    first.unmount();
    forgetUnsettledMemoryForTests();
    const second = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    await waitFor(() => expect(posts.keys).toHaveLength(2), SLOW);
    // The same question goes out under the same key: the server replays the request it admitted.
    expect(posts.keys[1]).toBe(posts.keys[0]);
    posts.release();
    await waitFor(() => expect(currentUrl(second.router)).toMatch(/^\/briefs\//), SLOW);
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 2 of 3'), SLOW);
    // Settled once the brief page shows the step the 2xx started: nothing is left for the tab.
    await waitFor(() => expect(stored()).toEqual({}), SLOW);
  });

  it('Refine keeps its key for the tab before the request leaves; the same change after a reload replays it', async () => {
    freshApi();
    installTurnstile();
    const { router, unmount } = await askFromHome(MOCK_SEED_QUESTION);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const briefPath = currentUrl(router);
    const briefId = briefPath.split('/')[2] as string;
    const posts = holdPosts('*/api/briefs/:id/refine');
    fireEvent.change(screen.getByRole('textbox', { name: /^refine$/i }), { target: { value: 'only helicopters' } });
    fireEvent.click(screen.getByRole('button', { name: /^Refine\s*·\s*uses 1$/ }));
    await waitFor(() => expect(posts.keys).toHaveLength(1), SLOW);
    expect(screen.getByRole('button', { name: 'Starting…' }).getAttribute('aria-busy')).toBe('true');
    const id = await unsettledId({ kind: 'refine', briefId, change: { kind: 'text', text: 'only helicopters' } });
    expect(stored()).toEqual({ [id]: { key: posts.keys[0], at: expect.any(Number) } });

    unmount();
    forgetUnsettledMemoryForTests();
    const again = renderApp(briefPath);
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    fireEvent.change(screen.getByRole('textbox', { name: /^refine$/i }), { target: { value: 'only helicopters' } });
    fireEvent.click(screen.getByRole('button', { name: /^Refine\s*·\s*uses 1$/ }));
    await waitFor(() => expect(posts.keys).toHaveLength(2), SLOW);
    expect(posts.keys[1]).toBe(posts.keys[0]);
    posts.release();
    const switcher = await screen.findByRole('navigation', { name: 'Answers in this brief' }, SLOW);
    expect(within(switcher).getAllByRole('link')).toHaveLength(2);
    expect(currentUrl(again.router)).toBe(briefPath);
    await waitFor(() => expect(stored()).toEqual({}), SLOW);
  });

  it('a known refusal of a first send (nothing admitted) takes its key back: the next ask uses a new one', async () => {
    freshApi();
    installTurnstile();
    const keys: string[] = [];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return keys.length === 1 ? HttpResponse.json({ error: 'rate_limited', message: 'Slow down.', retryAfter: 2 }, { status: 429 }) : undefined;
      }),
    );
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByText('Slow down a moment. Try again in 2 seconds.', {}, SLOW)).toBeTruthy();
    expect(stored()).toEqual({});
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }, SLOW));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a 2xx settles the key only once the brief page has taken over: a second ask while that page loads replays it (re-review N-2)', async () => {
    freshApi();
    installTurnstile();
    const keys: string[] = [];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return undefined;
      }),
    );
    // The brief page is a lazy route: hold its code back, as a slow network would.
    type Route = { path?: string; lazy?: () => Promise<unknown>; children?: Route[] };
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const undo: (() => void)[] = [];
    const hold = (list: Route[]): void => {
      for (const route of list) {
        if (route.path === 'briefs/:id' && route.lazy) {
          const lazy = route.lazy;
          route.lazy = async () => {
            await gate;
            return lazy();
          };
          undo.push(() => (route.lazy = lazy));
        }
        if (route.children) hold(route.children);
      }
    };
    hold(routes as unknown as Route[]);
    try {
      const { router } = renderApp('/');
      fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
      fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
      await waitFor(() => expect(keys).toHaveLength(1), SLOW);
      // Answered 2xx; the brief page is still loading, so the key is still kept ...
      await waitFor(() => expect(router.state.navigation.state).toBe('loading'), SLOW);
      const id = await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION });
      expect(stored()).toEqual({ [id]: { key: keys[0], at: expect.any(Number) } });
      // ... and a second ask in that gap replays it rather than starting (and paying for) another.
      fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*2 free$/ }, SLOW));
      await waitFor(() => expect(keys).toHaveLength(2), SLOW);
      expect(keys[1]).toBe(keys[0]);
      open();
      // The brief page is on screen for it: now it is settled.
      await waitFor(() => expect(currentUrl(router)).toMatch(/^\/briefs\//), SLOW);
      await waitFor(() => expect(stored()).toEqual({}), SLOW);
      await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
      await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 2 of 3'), SLOW);
    } finally {
      undo.forEach((u) => u());
    }
  });

  it('a check refused before anything is sent writes nothing for the tab', async () => {
    freshApi();
    window.turnstile = {
      render(_host, params) {
        setTimeout(() => params['error-callback'](), 10);
        return 'w1';
      },
      remove() {},
    };
    const keys: string[] = [];
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        keys.push(((await request.clone().json()) as { idempotencyKey: string }).idempotencyKey);
        return undefined;
      }),
    );
    renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    expect(await screen.findByText("The quick check didn't finish.", {}, SLOW)).toBeTruthy();
    expect(keys).toHaveLength(0);
    expect(stored()).toEqual({});
  });
});

describe('Unconfirmed criteria on the case card', () => {
  it('say what the drawer line says: this analysis could not establish it from the supplied passages', () => {
    for (const criterion of CRITERIA) {
      const reading = { glyph: null, why: 'w', timing: [], quotes: [], evidence: { scope: 'event', multiAircraft: false }, criteria: [{ criterion, decision: 'unconfirmed' }] } as CaseReading;
      const lead = CRITERION_LINE[criterion].unconfirmed.replace(/^Unconfirmed: /, '');
      expect(unconfirmedLines(reading), criterion).toEqual([`${lead.charAt(0).toUpperCase()}${lead.slice(1)}.`]);
      expect(unconfirmedLines(reading)[0], criterion).not.toMatch(/investigation|no timing|Within/);
    }
    // A criterion the case matches has no line.
    expect(unconfirmedLines({ glyph: null, why: 'w', timing: [], quotes: [], evidence: { scope: 'event', multiAircraft: false }, criteria: [{ criterion: 'timing_window', decision: 'matches' }] } as CaseReading)).toEqual([]);
  });
});

describe('Partial display: every state the projection can produce (Task 16e; review I2, gate 16d finding 3)', { timeout: 20_000 }, () => {
  const sheet = (result: Parameters<typeof BriefingSheet>[0]['result']) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BriefingSheet result={result} caseTo={(n) => `/briefs/x?case=${n}`} inCompare={() => false} onToggleCompare={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };
  const cardOf = (n: string) => document.querySelector(`article[data-card="${n}"]`) as HTMLElement;

  it('partial display off (whole mode): the answer says the check completed with nothing removed, and nothing else changes', () => {
    sheet(RESULT_SAMPLES.answer);
    expect(screen.getByText('Evidence check completed · 0 statements removed')).toBeTruthy();
    expect(document.querySelector('[data-ungrouped]')).toBeNull();
    expect(document.querySelector('[data-check-notes]')).toBeNull();
    expect(document.querySelectorAll('article[data-card]')).toHaveLength(RESULT_SAMPLES.answer.cases.length);
    expect(screen.queryByText(/PARTLY CHECKED|partly checked/i)).toBeNull();
  });

  it('partial display on: every counted case is on the sheet, unclassified or without its reading, with its markers', () => {
    const r = RESULT_SAMPLES.partial;
    sheet(r);
    // The results label counts every case, and every case is rendered: none silently dropped.
    expect(screen.getByText(`${r.cases.length} examples found · not every matching investigation`)).toBeTruthy();
    expect(document.querySelectorAll('article[data-card]')).toHaveLength(r.cases.length);
    // The factual status line, from the actual count (13 statements).
    expect(screen.getByText('Evidence check completed · 13 statements removed')).toBeTruthy();
    // The removed summary sentence: a count marker, never its text.
    expect(screen.getByText('[one statement not shown: the check could not confirm it]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('a fuel-system check valve was installed backwards');
    // The cases outside every group: MIA08LA156 (reading kept, unclassified) and DEN08LA103 (reading removed).
    const ungrouped = screen.getByRole('region', { name: 'Not classified, 2 cases' });
    expect(within(ungrouped).getByText('The evidence check could not confirm a classification for these cases.')).toBeTruthy();
    expect(within(ungrouped).getAllByRole('article').map((a) => a.getAttribute('data-card'))).toEqual(['MIA08LA156', 'DEN08LA103']);
    // A grouped card with a timing fact and its criterion not verified.
    expect(cardOf('DFW08TA066').textContent).toContain('Not verified The check could not confirm the timing and your criteria against the cited passages, so they are not shown.');
    // The unclassified card: its classification not verified, and a quote left out by the excerpt rule.
    const mia = cardOf('MIA08LA156');
    expect(mia.textContent).toContain('The check could not confirm the classification against the cited passages, so it is not shown.');
    expect(mia.textContent).toContain('One quote left out: it needs the report’s surrounding text to keep its meaning.');
    expect(mia.textContent).not.toContain('During both test phases, the engine accelerated normally');
    expect(within(mia).getByText(/Why it matched/i)).toBeTruthy();
    // The card whose reading was removed: it says so, and shows its NTSB text with no AI lines.
    const den = cardOf('DEN08LA103');
    expect(den.textContent).toContain('AI reading not shown');
    expect(den.textContent).toContain('The check could not confirm this case’s AI reading against the cited passages. Its NTSB text is below.');
    expect(within(den).queryByText(/Why it matched/i)).toBeNull();
    expect(den.textContent).not.toContain('The reason for the loss of engine power was not determined.');
  });

  it('print: the markers, notes and the cases outside every group all print (none is hidden from print)', () => {
    sheet(RESULT_SAMPLES.partial);
    const printed = [
      ...document.querySelectorAll('[data-check-status], [data-ungrouped], [data-check-notes], article[data-card]'),
      screen.getByText('[one statement not shown: the check could not confirm it]'),
    ];
    expect(printed.length).toBeGreaterThan(6);
    for (const el of printed) expect(el.closest('[data-print="hide"]'), el.textContent ?? '').toBeNull();
    for (const card of document.querySelectorAll('article[data-card]')) expect(card.getAttribute('data-print')).toBe('keep');
    // The print stylesheet hides only what is marked to hide.
    expect(printCssHides()).toEqual(['[data-print="hide"]']);
  });

  it('the drawer says what was not shown for a case without its reading, and for a quote left out', async () => {
    freshApi();
    installTurnstile();
    const { router } = await askFromHome('Engine power loss after maintenance (partial)');
    const label = await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const id = currentUrl(router).split('/')[2] as string;
    fireEvent.click(within(label.parentElement as HTMLElement).getByRole('link', { name: 'DEN08LA103' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('AI reading not shown: the check could not confirm it against the cited passages', {}, SLOW)).toBeTruthy();
    expect(within(dialog).queryByText(/Why it matched/i)).toBeNull();
    // MIA08LA156 (in the ungrouped section): its drawer names the quote left out and the classification not verified.
    await act(() => router.navigate(`/briefs/${id}?case=MIA08LA156`));
    const mia = await screen.findByRole('dialog');
    expect(await within(mia).findByText('One quote left out: it needs the report’s surrounding text to keep its meaning', {}, SLOW)).toBeTruthy();
    expect(within(mia).getAllByText('Not verified: the check could not confirm this against the cited passages').length).toBeGreaterThan(0);
  });

  it('Compare cells say what the check did not confirm, never "not in this brief" for a case of the answer', async () => {
    freshApi();
    installTurnstile();
    const { router } = await askFromHome('Engine power loss after maintenance (partial)');
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const id = currentUrl(router).split('/')[2] as string;
    await act(() => router.navigate(`/compare?cases=DFW08TA066,MIA08LA156,DEN08LA103&brief=${id}&step=1`));
    const den = await screen.findByRole('article', { name: 'DEN08LA103, strip 3' }, SLOW);
    expect(within(den).getAllByText('AI reading not shown: the check could not confirm it').length).toBe(2);
    expect(within(den).queryByText('Not in this brief')).toBeNull();
    const dfw = await screen.findByRole('article', { name: 'DFW08TA066, strip 1' }, SLOW);
    expect(await within(dfw).findByText('Timing not verified by the check', {}, SLOW)).toBeTruthy();
    const mia = await screen.findByRole('article', { name: 'MIA08LA156, strip 2' }, SLOW);
    expect(await within(mia).findByText('Classification not verified by the check', {}, SLOW)).toBeTruthy();
  });

  it('partial display off over the mock API: the checklist\'s last state and the sheet say the check completed with 0 removed', async () => {
    freshApi();
    installTurnstile();
    await askFromHome(MOCK_SEED_QUESTION);
    expect(await screen.findByText('Evidence check completed · 0 statements removed', {}, SLOW)).toBeTruthy();
    expect(document.querySelector('[data-ungrouped]')).toBeNull();
  });
});

/** The selectors the print stylesheet sets `display: none` on. */
function printCssHides(): string[] {
  const block = printCss.slice(printCss.indexOf('@media print'));
  return [...block.matchAll(/([^{}]+)\{[^}]*display:\s*none/g)].map((m) => m[1]!.trim());
}
