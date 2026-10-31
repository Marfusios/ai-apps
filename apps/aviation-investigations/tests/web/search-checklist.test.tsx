/**
 * The search checklist (UI_DESIGN §4.10, Task 25): while `POST /api/evidence` runs, for a question
 * and for an edit, a cockpit checklist card where the visitor waits, read from `GET
 * /api/evidence/progress/:key` under the POST's own idempotency key about every 500 ms; each row
 * fills in its real result as its stage ends (a magenta ✓), the row under way is washed, rows not
 * reached are muted; unticked until the first good read, 404s polled through for the whole wait;
 * completions announced politely; gone, and no longer read, once the POST settles; never model text.
 * The rows are checked state by state, the reading schedule rule by rule, and the card in the app
 * against scripted progress and against the mock's own stage timing.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiStatusResponse } from '../../shared/contracts/ai';
import { EVIDENCE_HEADING, EvidenceProgressSchema, type EvidenceProgress } from '../../shared/contracts/evidence';
import { MOCK_EVIDENCE_QUESTIONS, MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence';
import { ApiError } from '../../web/src/api';
import { COPY } from '../../web/src/features/ai/AiNoticeBox';
import { busyLabel } from '../../web/src/features/ai/AskAiButton';
import type { TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { resetUnsettledForTests } from '../../web/src/features/ai/unsettled';
import {
  CHALLENGES,
  PROGRESS_LONGEST_RETRY_AFTER_MS,
  PROGRESS_MAX_BACKOFF_MS,
  PROGRESS_NOT_FOUND_BEFORE_SLOWING,
  PROGRESS_POLL_MS,
  PROGRESS_SLOW_POLL_MS,
  RESULTS,
  SEARCH_CHECKLIST_NOTE,
  SEARCH_CHECKLIST_TITLE,
  SPOKEN,
  checklistAnnouncement,
  checklistRows,
  elapsed,
  progressPollDelay,
  type ChecklistRow,
  type ProgressPollState,
} from '../../web/src/features/evidence/checklist';
import { createHandlers, type HandlerOptions } from '../../web/src/mocks/handlers';
import baseCss from '../../web/src/styles/base.css?raw';
import { evidenceAnswer } from './evidence-answer';
import { currentUrl, renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 8000 };
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** A trial that has started: the check runs invisibly, with no first-check panel. */
const STARTED: AiStatusResponse = { state: 'available', remaining: { kind: 'trial', left: 10, limit: 10, started: true } };

afterEach(() => {
  delete window.turnstile;
  resetUnsettledForTests();
  server.events.removeAllListeners();
});

function freshApi(options: HandlerOptions = {}): void {
  server.use(...createHandlers({ aiStatus: STARTED, ...options }));
}

/** Cloudflare's widget stood in for: the test token after a few milliseconds. */
function installTurnstile(): void {
  const api: TurnstileApi = {
    render(host, params) {
      host.appendChild(document.createElement('div'));
      setTimeout(() => params.callback(TOKEN), 5);
      return 'w1';
    },
    remove() {},
  };
  window.turnstile = api;
}

const at = (status: EvidenceProgress['question']['status']) => status;

/** A progress answer, checked against the contract. */
function progress(p: Partial<EvidenceProgress> & Pick<EvidenceProgress, 'state'>): EvidenceProgress {
  return EvidenceProgressSchema.parse({
    startedAt: '2026-10-31T12:00:00.000Z',
    question: { status: at('pending'), result: null },
    search: { status: 'pending', cases: null },
    order: { status: 'pending', result: null },
    ...p,
  });
}

const rowsOf = (input: Parameters<typeof checklistRows>[0]) => checklistRows(input).map((r) => [r.id, r.tone, r.result, r.tick] as const);
const question = (p: EvidenceProgress | null, cohort: number | null = 24_291) => checklistRows({ kind: 'question', progress: p, cohort });

describe('the rows, state by state', () => {
  it('until the first good read the card is unticked: no row under way, and an edit’s question row says it is skipped', () => {
    expect(rowsOf({ kind: 'question', progress: null, cohort: 24_291 })).toEqual([
      ['question', 'todo', RESULTS.notYet, false],
      ['search', 'todo', RESULTS.notYet, false],
      ['order', 'todo', RESULTS.notYet, false],
    ]);
    expect(rowsOf({ kind: 'edited', progress: null, cohort: 24_291 })).toEqual([
      ['question', 'skipped', 'SKIPPED · YOUR EDIT', false],
      ['search', 'todo', RESULTS.notYet, false],
      ['order', 'todo', RESULTS.notYet, false],
    ]);
  });

  it('the challenges: the question, the search of the default cohort from the configuration, the order', () => {
    expect(question(null).map((r) => r.challenge)).toEqual(['Question', 'Search 24,291 investigations', 'Order the leading results']);
    expect(question(null, null)[1]?.challenge).toBe('Search investigations');
    expect(CHALLENGES.search(24_291)).toBe('Search 24,291 investigations');
  });

  it('the stage under way is the current row; while the search runs with none under way, the first not reached is', () => {
    expect(question(progress({ state: 'running', question: { status: 'running', result: null } })).map((r) => r.tone)).toEqual(['current', 'todo', 'todo']);
    expect(question(progress({ state: 'running', question: { status: 'running', result: null } }))[0]?.result).toBe('IN PROGRESS');
    const between = progress({ state: 'running', question: { status: 'done', result: 'suggestions' } });
    expect(question(between).map((r) => r.tone)).toEqual(['done', 'current', 'todo']);
    const ended = progress({ state: 'done', question: { status: 'done', result: 'note' }, search: { status: 'done', cases: 4 }, order: { status: 'skipped', result: null } });
    expect(question(ended).some((r) => r.tone === 'current')).toBe(false);
  });

  it.each([
    [{ status: 'done', result: 'suggestions' }, 'READ · SUGGESTIONS READY', 'done', true, SPOKEN.suggestions],
    [{ status: 'done', result: 'nothing_to_suggest' }, 'READ · NOTHING TO SUGGEST', 'done', true, SPOKEN.nothingToSuggest],
    [{ status: 'done', result: 'note' }, 'NOTE ADDED', 'done', true, SPOKEN.note],
    [{ status: 'done', result: 'unavailable' }, 'NOT AVAILABLE', 'skipped', false, SPOKEN.unavailable],
    [{ status: 'failed', result: 'unavailable' }, 'NOT AVAILABLE', 'skipped', false, SPOKEN.unavailable],
    [{ status: 'failed', result: null }, 'NOT AVAILABLE', 'skipped', false, SPOKEN.unavailable],
    [{ status: 'skipped', result: null }, 'SKIPPED', 'skipped', false, null],
  ] as const)('the question row: %j reads %s', (q, result, tone, tick, spoken) => {
    const row = question(progress({ state: 'running', question: q }))[0] as ChecklistRow;
    expect([row.result, row.tone, row.tick, row.spoken]).toEqual([result, tone, tick, spoken]);
  });

  it('an edit’s question row is skipped whatever the progress says', () => {
    const rows = checklistRows({ kind: 'edited', progress: progress({ state: 'running', question: { status: 'skipped', result: null }, search: { status: 'running', cases: null } }), cohort: 21 });
    expect(rows.map((r) => [r.result, r.tone])).toEqual([
      ['SKIPPED · YOUR EDIT', 'skipped'],
      ['IN PROGRESS', 'current'],
      ['—', 'todo'],
    ]);
  });

  it.each([
    [{ status: 'done', cases: 21 }, '21 CASES', 'done', true, 'Search done: 21 cases.'],
    [{ status: 'done', cases: 1 }, '1 CASE', 'done', true, 'Search done: 1 case.'],
    [{ status: 'done', cases: 0 }, '0 CASES', 'done', true, 'Search done: 0 cases.'],
    [{ status: 'done', cases: null }, 'DONE', 'done', true, null],
    [{ status: 'failed', cases: null }, 'DIDN’T FINISH', 'skipped', false, SPOKEN.failed],
  ] as const)('the search row: %j reads %s', (s, result, tone, tick, spoken) => {
    const row = question(progress({ state: 'running', question: { status: 'done', result: 'suggestions' }, search: s }))[1] as ChecklistRow;
    expect([row.result, row.tone, row.tick, row.spoken]).toEqual([result, tone, tick, spoken]);
  });

  it.each([
    [{ status: 'done', result: 'ai_relevance' }, 'ORDERED BY AI', 'done', true, SPOKEN.aiOrder],
    [{ status: 'done', result: 'match' }, 'MATCH ORDER', 'done', true, SPOKEN.matchOrder],
    [{ status: 'skipped', result: null }, 'NOT USED', 'skipped', false, null],
    [{ status: 'failed', result: 'match' }, 'MATCH ORDER', 'skipped', false, null],
    [{ status: 'failed', result: null }, 'DIDN’T FINISH', 'skipped', false, null],
  ] as const)('the order row: %j reads %s', (o, result, tone, tick, spoken) => {
    const row = question(progress({ state: 'done', question: { status: 'done', result: 'suggestions' }, search: { status: 'done', cases: 21 }, order: o }))[2] as ChecklistRow;
    expect([row.result, row.tone, row.tick, row.spoken]).toEqual([result, tone, tick, spoken]);
  });

  it('the live line says the latest completion; skipped rows are not announced; the timer reads minutes and seconds', () => {
    expect(checklistAnnouncement(question(null))).toBe('');
    expect(checklistAnnouncement(question(progress({ state: 'running', question: { status: 'done', result: 'note' }, search: { status: 'running', cases: null } })))).toBe(SPOKEN.note);
    const done = progress({ state: 'done', question: { status: 'done', result: 'suggestions' }, search: { status: 'done', cases: 21 }, order: { status: 'skipped', result: null } });
    expect(checklistAnnouncement(question(done))).toBe('Search done: 21 cases.');
    expect([elapsed(0, 4_999), elapsed(0, 65_000), elapsed(10, 0)]).toEqual(['0:04', '1:05', '0:00']);
  });
});

describe('what the control says', () => {
  it('“Checking…” for the check, “Starting…” on the way, “Searching…” once the checklist shows', () => {
    expect([busyLabel('idle'), busyLabel('checking'), busyLabel('sending'), busyLabel('searching')]).toEqual([null, 'Checking…', 'Starting…', 'Searching…']);
  });
});

describe('motion', () => {
  it('a row’s ✓ ticks in as its stage finishes, and with reduced motion appears at once', () => {
    expect(baseCss).toMatch(/\.checklist-tick \{[^}]*animation: casebook-tick-in 180ms ease-out;/);
    const reduced = baseCss.slice(baseCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after \{[^}]*animation-duration: 0\.01ms !important;/);
  });
});

describe('when the progress is read again', () => {
  const poll = (state: Partial<ProgressPollState['state']>): ProgressPollState => ({ state: { data: undefined, status: 'pending', error: null, dataUpdatedAt: 0, errorUpdateCount: 0, ...state } });
  const notFound = new ApiError(404, { error: 'not_found', message: 'Not found.' });

  it('every 500 ms while the search runs; never once it has ended', () => {
    expect(progressPollDelay(poll({}))).toBe(PROGRESS_POLL_MS);
    expect(progressPollDelay(poll({ status: 'success', data: progress({ state: 'running' }), dataUpdatedAt: 1 }))).toBe(PROGRESS_POLL_MS);
    expect(progressPollDelay(poll({ status: 'success', data: progress({ state: 'done' }), dataUpdatedAt: 1 }))).toBe(false);
    expect(progressPollDelay(poll({ status: 'success', data: progress({ state: 'failed' }), dataUpdatedAt: 1 }))).toBe(false);
  });

  it('through 404s for the whole wait: every 500 ms, then every second after ten in a row; a good read starts the count again', () => {
    for (let n = 1; n <= 30; n++) {
      const expected = n < PROGRESS_NOT_FOUND_BEFORE_SLOWING ? PROGRESS_POLL_MS : PROGRESS_SLOW_POLL_MS;
      expect(progressPollDelay(poll({ status: 'error', error: notFound, errorUpdateCount: n })), `404 number ${n}`).toBe(expected);
    }
    // After a good read the 404s count from it (the same query object, as TanStack keeps it).
    const query = poll({ status: 'success', data: progress({ state: 'running' }), dataUpdatedAt: 5, errorUpdateCount: 20 });
    expect(progressPollDelay(query)).toBe(PROGRESS_POLL_MS);
    query.state = { ...query.state, status: 'error', error: notFound, errorUpdateCount: 21 };
    expect(progressPollDelay(query)).toBe(PROGRESS_POLL_MS);
  });

  it('a 429 waits as the server says; another refusal stops; a network or server failure backs off', () => {
    expect(progressPollDelay(poll({ status: 'error', error: new ApiError(429, null, 3), errorUpdateCount: 1 }))).toBe(3000);
    expect(progressPollDelay(poll({ status: 'error', error: new ApiError(429, null), errorUpdateCount: 1 }))).toBe(PROGRESS_MAX_BACKOFF_MS);
    expect(progressPollDelay(poll({ status: 'error', error: new ApiError(403, null), errorUpdateCount: 1 }))).toBe(false);
    expect(progressPollDelay(poll({ status: 'error', error: new TypeError('Failed to fetch'), errorUpdateCount: 1 }))).toBe(1000);
    expect(progressPollDelay(poll({ status: 'error', error: new ApiError(503, null), errorUpdateCount: 9 }))).toBe(PROGRESS_MAX_BACKOFF_MS);
  });

  it('a Retry-After is never shortened: the whole of it up to 30 s, and past that no more reading (security review C3)', () => {
    const after = (seconds: number) => progressPollDelay(poll({ status: 'error', error: new ApiError(429, null, seconds), errorUpdateCount: 1 }));
    expect(after(30)).toBe(30_000);
    expect(PROGRESS_LONGEST_RETRY_AFTER_MS).toBe(30_000);
    for (const seconds of [31, 60, 3_600]) expect(after(seconds), `${seconds} s`).toBe(false);
  });
});

/** The card where the visitor waits, if it is there. */
const card = (): HTMLElement | null => screen.queryByRole('region', { name: SEARCH_CHECKLIST_TITLE });
/** A row as it reads: "Question · READ · SUGGESTIONS READY ✓" (the tick when there is one). */
const rowText = (el: HTMLElement, id: string): string => {
  const row = el.querySelector(`[data-row="${id}"]`);
  const tick = row?.querySelector('[data-tick]') ? ' ✓' : '';
  return `${row?.querySelector('[data-challenge]')?.textContent ?? ''} · ${row?.querySelector('[data-result]')?.textContent ?? ''}${tick}`;
};
const rowState = (el: HTMLElement, id: string): string | null => el.querySelector(`[data-row="${id}"]`)?.getAttribute('data-state') ?? null;

/**
 * The POST held until `release()`, answered with a search page; the progress read from `script`
 * one answer per read (the last one repeats); every read's key and every POST's key recorded.
 */
function scripted(script: (EvidenceProgress | 404)[], { fail = false }: { fail?: boolean } = {}) {
  const reads: string[] = [];
  const keys: string[] = [];
  let release = (): void => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  server.use(
    http.post('*/api/evidence', async ({ request }) => {
      const body = (await request.clone().json()) as { idempotencyKey: string };
      keys.push(body.idempotencyKey);
      await released;
      if (fail) return HttpResponse.json({ error: 'unavailable', message: 'AI search is temporarily unavailable.' }, { status: 503 });
      return HttpResponse.json(evidenceAnswer('00000000-0000-4000-8000-0000000000aa'), { status: 201 });
    }),
    http.get('*/api/evidence/progress/:key', ({ params }) => {
      reads.push(String(params.key));
      const next = script[Math.min(reads.length - 1, script.length - 1)] as EvidenceProgress | 404;
      return next === 404 ? HttpResponse.json({ error: 'not_found', message: 'Not found.' }, { status: 404 }) : HttpResponse.json(next);
    }),
  );
  return { reads, keys, release: () => act(() => release()) };
}

async function askFromHome(question: string) {
  installTurnstile();
  const app = renderApp('/');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: question } });
  fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*10 free$/ }));
  return app;
}

describe('the card where the visitor waits', { timeout: 30_000 }, () => {
  it('ticks each row from the progress read under the POST’s own key, announces each completion, and goes once the results open', async () => {
    freshApi();
    const running = progress({ state: 'running', question: { status: 'running', result: null } });
    const scoped = progress({ state: 'running', question: { status: 'done', result: 'suggestions' }, search: { status: 'running', cases: null } });
    const searched = progress({ state: 'running', question: { status: 'done', result: 'suggestions' }, search: { status: 'done', cases: 21 }, order: { status: 'running', result: null } });
    const done = progress({ state: 'done', question: { status: 'done', result: 'suggestions' }, search: { status: 'done', cases: 21 }, order: { status: 'done', result: 'ai_relevance' } });
    const s = scripted([404, 404, running, scoped, searched, done]);
    const app = await askFromHome(MOCK_EVIDENCE_QUESTIONS.carb);
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    // The cockpit card: the title bar, three rows, the note; unticked while the server has not registered the search.
    expect(el.querySelector('h2')?.textContent).toBe(SEARCH_CHECKLIST_TITLE);
    expect(el.textContent).toContain(SEARCH_CHECKLIST_NOTE);
    expect(el.closest('[data-print="hide"]')).toBe(el);
    expect(within(el).getAllByRole('listitem')).toHaveLength(3);
    expect(rowText(el, 'search')).toBe('Search 21 investigations · —');
    expect(el.querySelector('[aria-current]')).toBeNull();
    // The control that asked says "Searching…" while the card shows, busy and off.
    const asking = within(screen.getByRole('search')).getByRole('button', { name: 'Searching…' });
    expect(asking.getAttribute('aria-busy')).toBe('true');
    expect(asking.getAttribute('aria-disabled')).toBe('true');
    // Then the question under way, washed and in magenta.
    await waitFor(() => expect(rowState(el, 'question')).toBe('current'), SLOW);
    expect(el.querySelector('[data-row="question"]')?.getAttribute('aria-current')).toBe('step');
    expect(el.querySelector('[data-row="question"]')?.className).toContain('bg-magenta-wash');
    expect(el.querySelector('[data-row="order"]')?.className).toContain('text-muted');
    await waitFor(() => expect(rowText(el, 'question')).toBe('Question · READ · SUGGESTIONS READY ✓'), SLOW);
    // The tick says "done" to screen readers too.
    expect(el.querySelector('[data-row="question"] [data-tick]')?.textContent).toBe('✓ done');
    expect(el.querySelector('[data-checklist-live]')?.textContent).toBe(SPOKEN.suggestions);
    await waitFor(() => expect(rowText(el, 'search')).toBe('Search 21 investigations · 21 CASES ✓'), SLOW);
    expect(el.querySelector('[data-checklist-live]')?.textContent).toBe('Search done: 21 cases.');
    await waitFor(() => expect(rowText(el, 'order')).toBe('Order the leading results · ORDERED BY AI ✓'), SLOW);
    expect(el.querySelector('[data-checklist-live]')?.getAttribute('aria-live')).toBe('polite');
    // Every read used the key the POST was sent under, and none came after the search ended.
    expect(s.keys).toHaveLength(1);
    expect(new Set(s.reads)).toEqual(new Set(s.keys));
    const readsWhenDone = s.reads.length;
    await act(() => delay(1_200));
    expect(s.reads.length).toBe(readsWhenDone);
    s.release();
    await waitFor(() => expect(currentUrl(app.router)).toMatch(/^\/ai\/0{8}-0{4}-4000-8000-0{10}aa$/), SLOW);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    expect(card()).toBeNull();
  });

  it('404s throughout leave the card unticked, read through the whole wait; reading stops when the POST settles', async () => {
    freshApi();
    const s = scripted([404]);
    await askFromHome(MOCK_EVIDENCE_QUESTIONS.seed);
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    await waitFor(() => expect(s.reads.length).toBeGreaterThanOrEqual(5), SLOW);
    expect(el.querySelectorAll('[data-state="todo"]')).toHaveLength(3);
    expect(el.textContent).not.toContain('✓');
    expect(el.querySelector('[data-checklist-live]')?.textContent).toBe('');
    s.release();
    await waitFor(() => expect(card()).toBeNull(), SLOW);
    const after = s.reads.length;
    await act(() => delay(1_200));
    expect(s.reads.length).toBe(after);
  });

  it('a search the server could not finish: the card goes and the notice says so', async () => {
    freshApi();
    const s = scripted([progress({ state: 'failed', question: { status: 'done', result: 'nothing_to_suggest' }, search: { status: 'failed', cases: null } })], { fail: true });
    await askFromHome(MOCK_EVIDENCE_QUESTIONS.seed);
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    await waitFor(() => expect(rowText(el, 'search')).toBe('Search 21 investigations · DIDN’T FINISH'), SLOW);
    s.release();
    expect(await screen.findByText(COPY.unfinished[0], {}, SLOW)).toBeTruthy();
    expect(card()).toBeNull();
  });

  it('an edit (Search again) shows its card under the search box, the question row skipped from the start', async () => {
    freshApi();
    // A search to edit, made through the mock, then the POST of its edit held.
    const response = await fetch(new URL('/api/evidence', window.location.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'question', question: MOCK_EVIDENCE_QUESTIONS.carb, idempotencyKey: crypto.randomUUID(), turnstileToken: TOKEN }),
    });
    const { search } = (await response.json()) as { search: { id: string } };
    installTurnstile();
    renderApp(`/ai/${search.id}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    const s = scripted([404, progress({ state: 'running', question: { status: 'skipped', result: null }, search: { status: 'running', cases: null } })]);
    const yours = screen.getByRole('region', { name: 'Your search' });
    fireEvent.click(within(yours).getByRole('button', { name: '+ Filter' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Add a filter' })).getByRole('button', { name: 'Add' }));
    fireEvent.click(await within(yours).findByRole('button', { name: /^Search again\s*·\s*uses 1$/ }));
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    expect(rowText(el, 'question')).toBe('Question · SKIPPED · YOUR EDIT');
    expect(within(yours).getByRole('button', { name: 'Searching…' }).getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(rowState(el, 'search')).toBe('current'), SLOW);
    // Under the box the edit was made in, before the notice box.
    expect(yours.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(new Set(s.reads)).toEqual(new Set(s.keys));
    s.release();
    await waitFor(() => expect(card()).toBeNull(), SLOW);
  });

  it('a Retry-After over 30 s ends the reading until the POST settles, the card as it was; a shorter one is not cut short by focus, reconnect or a reset (security review C3)', async () => {
    freshApi();
    const running = progress({ state: 'running', question: { status: 'running', result: null } });
    let reads = 0;
    let retryAfter = 60;
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('*/api/evidence', async () => {
        await released;
        return HttpResponse.json(evidenceAnswer('00000000-0000-4000-8000-0000000000aa'), { status: 201 });
      }),
      http.get('*/api/evidence/progress/:key', () => {
        reads += 1;
        // The first read finds the search under way; every later one is told to wait.
        if (reads === 1) return HttpResponse.json(running);
        return HttpResponse.json({ error: 'rate_limited', message: 'Slow down.', retryAfter }, { status: 429, headers: { 'retry-after': String(retryAfter) } });
      }),
    );
    const first = await askFromHome(MOCK_EVIDENCE_QUESTIONS.seed);
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    await waitFor(() => expect(rowState(el, 'question')).toBe('current'), SLOW);
    await waitFor(() => expect(reads).toBe(2), SLOW);
    // Asked to wait a minute: nothing more is read, and the card stays as it was.
    await act(() => delay(1_600));
    expect(reads).toBe(2);
    expect(rowState(el, 'question')).toBe('current');
    // Focus and a reconnect re-read nothing either.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(() => delay(600));
    expect(reads).toBe(2);
    // Nor does a reset of its query, as when the visitor changes: the refusal stands, nothing is sent.
    await act(() => first.client.resetQueries({ queryKey: ['evidence-progress'] }));
    await act(() => delay(600));
    expect(reads).toBe(2);
    act(() => release());
    await waitFor(() => expect(card()).toBeNull(), SLOW);

    // A wait of 20 s is kept to the full: focus and a reconnect within it read nothing.
    focusManager.setFocused(undefined);
    retryAfter = 20;
    reads = 0;
    let release2 = (): void => {};
    const released2 = new Promise<void>((resolve) => (release2 = resolve));
    server.use(
      http.post('*/api/evidence', async () => {
        await released2;
        return HttpResponse.json(evidenceAnswer('00000000-0000-4000-8000-0000000000ab'), { status: 201 });
      }),
    );
    const second = renderApp('/');
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Search NTSB investigations' }).at(-1) as HTMLElement, { target: { value: MOCK_EVIDENCE_QUESTIONS.carb } });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Ask AI\s*·/ })).at(-1) as HTMLElement);
    await waitFor(() => expect(reads).toBe(2), SLOW);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(() => second.client.resetQueries({ queryKey: ['evidence-progress'] }));
    await act(() => delay(1_200));
    expect(reads).toBe(2);
    focusManager.setFocused(undefined);
    act(() => release2());
    await waitFor(() => expect(card()).toBeNull(), SLOW);
  });

  it('from Explore’s nudge the card shows under the nudge, not under the search bar', async () => {
    freshApi();
    const s = scripted([404]);
    installTurnstile();
    renderApp('/explore?q=carb+icing');
    const nudge = (await screen.findByText(/Ask in plain English/, {}, SLOW)).closest('div') as HTMLElement;
    fireEvent.click(within(nudge).getByRole('button', { name: /^Ask AI/ }));
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    expect(nudge.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('region', { name: SEARCH_CHECKLIST_TITLE })).toHaveLength(1);
    s.release();
    await waitFor(() => expect(card()).toBeNull(), SLOW);
  });

  it('against the mock’s own stages, timed as live’s and shortened: the rows tick in order, then the results open', async () => {
    freshApi({ evidence: MOCK_EVIDENCE_RELEASE, evidenceTiming: 0.6 });
    const seen: string[] = [];
    const app = await askFromHome(MOCK_EVIDENCE_QUESTIONS.carb);
    const el = await waitFor(() => card() ?? Promise.reject(new Error('no card yet')), SLOW);
    const watch = setInterval(() => {
      const ticked = ['question', 'search', 'order'].filter((id) => el.querySelector(`[data-row="${id}"]`)?.textContent?.includes('✓')).join(',');
      if (seen.at(-1) !== ticked) seen.push(ticked);
    }, 50);
    try {
      await waitFor(() => expect(currentUrl(app.router)).toMatch(/^\/ai\//), { timeout: 15_000 });
    } finally {
      clearInterval(watch);
    }
    expect(seen).toEqual(expect.arrayContaining(['question', 'question,search']));
    expect(seen.indexOf('question')).toBeLessThan(seen.indexOf('question,search'));
  });
});
