import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiStatusResponse } from '../../shared/contracts/ai';
import { BriefStepResponseSchema } from '../../shared/contracts/briefs';
import { NO_MATCH_LINES } from '../../server/briefs/static-replies';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status';
import { MOCK_SEED_QUESTION } from '../../web/mock/briefs';
import { AiCounter } from '../../web/src/features/ai/AiCounter';
import { AiNoticeBox } from '../../web/src/features/ai/AiNoticeBox';
import { AskAiButton } from '../../web/src/features/ai/AskAiButton';
import { FIRST_CHECK_TEXT, FIRST_CHECK_TITLE, LATER_CHECK_TITLE, type TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { Checklist, CHECKLIST_NOTE } from '../../web/src/features/brief/Checklist';
import { WithheldNotice, withheldText } from '../../web/src/features/brief/WithheldNotice';
import { PassageText, cleanSpans, paragraphRanges } from '../../web/src/features/case/BriefContext';
import { TURNSTILE_TEST_SITE_KEY, createHandlers } from '../../web/src/mocks/handlers';
import { currentUrl, renderApp, setupMockApi } from './render-app';

const server = setupMockApi({ briefPolls: 1 });

interface FakeTurnstile {
  renders: { sitekey: string; action: string; appearance: string }[];
  removed: number;
}

/** A stand-in for Cloudflare's widget: answers with the test keys' dummy token after `delay` ms. */
function installTurnstile(delay = 20): FakeTurnstile {
  const state: FakeTurnstile = { renders: [], removed: 0 };
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
      setTimeout(() => {
        if (widgets.has(id)) params.callback('XXXX.DUMMY.TOKEN.XXXX');
      }, delay);
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

function withStatus(status: AiStatusResponse, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['ai-status'], status);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AI availability labels (UI_DESIGN §5)', () => {
  it.each([
    ['fresh', /^Ask AI\s*·\s*3 free$/, null],
    ['signedIn', /^Ask AI\s*·\s*18 left today$/, null],
    ['trialUsed', /^Ask AI\s*·\s*sign in$/, null],
    ['pausedDaily', /^Ask AI$/, 'AI back tomorrow'],
    ['pausedMonthly', /^Ask AI$/, 'AI back on 1 Nov'],
    ['unavailable', /^Ask AI$/, 'AI temporarily unavailable'],
  ] as const)('%s', (sample, name, note) => {
    withStatus(AI_STATUS_SAMPLES[sample], <AskAiButton onAsk={() => {}} />);
    const button = screen.getByRole('button', { name });
    expect(button.getAttribute('aria-disabled')).toBe(note ? 'true' : 'false');
    if (note) expect(screen.getByText(note)).toBeTruthy();
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
    ['trialUsed', 'Sign in to keep asking'],
    ['anonymousShare', 'Sign in to ask the AI'],
    ['signedIn', 'AI left today: 18 of 20'],
    ['pausedDaily', 'AI back tomorrow'],
    ['pausedMonthly', 'AI back on 1 Nov'],
    ['unavailable', 'AI temporarily unavailable'],
  ] as const)('header counter: %s reads "%s"', (sample, text) => {
    const { container } = withStatus(AI_STATUS_SAMPLES[sample], <AiCounter />);
    expect(container.textContent).toContain(text);
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
    expect(notice({ kind: 'trial_used' })).toBe(
      'That was your third free AI search.Sign in with Google to keep asking. New accounts start with 5 AI searches a day, rising to 20 after three days.Search, case pages, compare and the dashboard stay open without an account.',
    );
    expect(notice({ kind: 'free_paused', loginRequired: false })).toBe(
      'Free AI searches are used up for today.Signed-in AI search is still open today. Sign in with Google to ask.Free searches return tomorrow; keyword search and every case work now.',
    );
    expect(notice({ kind: 'free_paused', loginRequired: true })).toBe(
      'Free AI searches are used up for today.Signed-in AI search is still open today. Sign in with Google to ask.',
    );
    expect(notice({ kind: 'rate', seconds: 12 })).toBe('Slow down a moment. Try again in 12 seconds.');
    expect(notice({ kind: 'failure', spent: false })).toBe(
      "The AI search didn't finish.Something went wrong before an answer was ready.Try again · uses 1Search by keyword insteadThis didn't use one of your searches.",
    );
    expect(notice({ kind: 'failure', spent: true })).toContain('This counted as a search, because the AI work was already under way.');
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
    expect(cleanSpans([{ start, end: start + 10 }, { start: start + 5, end: start + 15 }, { start: 40, end: 999 }, { start: 5, end: 5 }], text.length)).toEqual([
      { start, end: start + 15 },
    ]);
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
    const turnstile = installTurnstile();
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*3 free$/ }));
    const panel = await screen.findByRole('dialog', { name: FIRST_CHECK_TITLE });
    expect(panel.textContent).toContain(FIRST_CHECK_TEXT);
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
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "The AI search didn't finish.Something went wrong before an answer was ready.Try again · uses 1Search by keyword insteadThis counted as a search, because the AI work was already under way.",
    );
  });

  it('a case or compare link to a brief that is gone shows NTSB data with a muted note', async () => {
    renderApp('/cases/DFW08TA066?brief=not-a-brief&step=1');
    expect(await screen.findByText("The AI notes for this case have expired or aren't yours.")).toBeTruthy();
    renderApp('/compare?cases=DFW08TA066,MIA08LA156&brief=00000000-0000-4000-8000-00000000dead&step=1');
    expect(await screen.findByText("The AI notes for these cases have expired or aren't yours.")).toBeTruthy();
    expect(screen.queryByText(/Since maint/i)).toBeNull();
  });
});
