/**
 * The first AI request of a page loads the brief client (web/src/features/brief/api.ts)
 * before it sends (Task 20 gate, fix round 3). If the visitor signs out or deletes the
 * account while it loads, nothing is sent: no POST with the previous visitor's question
 * (possibly under another account's cookies, signed in from another tab), and nothing of
 * the request is kept (question, retry key) or opened.
 *
 * Its own file: the brief client loads once per module registry, and every test here needs
 * that first load. Each test holds it from the start (`holdBriefClient`).
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SEED_QUESTION } from '../../web/mock/briefs';
import { resetUnsettledForTests, unsettledId, unsettledKey } from '../../web/src/features/ai/unsettled';
import { VISITOR_CHANNEL, visitorGeneration } from '../../web/src/features/auth/visitor';
import { rememberedQuestion } from '../../web/src/features/brief/memory';
import { createHandlers } from '../../web/src/mocks/handlers';
import { ACCOUNT_COPY } from '../../web/src/pages/Account';
import { currentUrl, renderApp, setupMockApi } from './render-app';

/** How far the brief client's load got: `started` loads, held until `open()`. */
const load = vi.hoisted(() => ({ started: 0, gate: Promise.resolve(), open: (): void => {} }));

async function briefClient(importOriginal: () => Promise<unknown>): Promise<unknown> {
  load.started += 1;
  await load.gate;
  return importOriginal();
}

vi.mock('../../web/src/features/brief/api', (importOriginal) => briefClient(importOriginal));

/** The next load of the brief client waits until `load.open()`; registered again, so the module loads anew. */
function holdBriefClient(): void {
  load.started = 0;
  load.gate = new Promise<void>((resolve) => (load.open = resolve));
  vi.doMock('../../web/src/features/brief/api', (importOriginal) => briefClient(importOriginal));
}

const server = setupMockApi();
const ANSWERED_ID = '00000000-0000-4000-8000-0000000000ff';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  load.open();
  resetUnsettledForTests();
  window.sessionStorage.clear();
});

/** Signed in, asks from the home page, and waits until the brief client is loading (held). */
async function askWhileTheClientLoads() {
  window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
  let posts = 0;
  server.use(...createHandlers({ googleEnabled: true, briefPolls: 1 }));
  // Ahead of the mock's own handler (each `use` goes first).
  server.use(
    http.post('*/api/briefs', () => {
      posts += 1;
      return HttpResponse.json({ kind: 'started', briefId: ANSWERED_ID, step: 1, stage: 'retrieve' }, { status: 202 });
    }),
  );
  holdBriefClient();
  const app = renderApp('/');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
  fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
  await waitFor(() => expect(load.started).toBe(1));
  return { ...app, posts: () => posts };
}

/** Nothing of the ask went out or stayed: no POST, no question, no retry key, no move from `url`. */
async function nothingOfTheAsk(app: Awaited<ReturnType<typeof askWhileTheClientLoads>>, url: string): Promise<void> {
  // Still loading: nothing has gone out yet.
  expect(app.posts()).toBe(0);
  load.open();
  await act(() => sleep(150));
  expect(app.posts()).toBe(0);
  expect(currentUrl(app.router)).toBe(url);
  expect(rememberedQuestion(ANSWERED_ID)).toBeNull();
  expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
}

describe('a visitor change while the first AI request loads sends nothing (Task 20 gate, fix round 3)', () => {
  it('signed out while the brief client loads: no POST, no question, no retry key, no navigation', async () => {
    const app = await askWhileTheClientLoads();
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
    await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle });
    await nothingOfTheAsk(app, '/account');
  });

  it('the account deleted while the brief client loads: no POST, no question, no retry key, no navigation', async () => {
    const app = await askWhileTheClientLoads();
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleteAsk);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleted);
    await nothingOfTheAsk(app, '/account');
  });

  it('another tab signs out (and could sign in as someone else) while the brief client loads: nothing is sent either', async () => {
    const app = await askWhileTheClientLoads();
    const before = visitorGeneration();
    await fetch(new URL('/api/auth/sign-out', window.location.href), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const other = new BroadcastChannel(VISITOR_CHANNEL);
    other.postMessage({ type: 'visitor-changed' });
    other.close();
    await waitFor(() => expect(visitorGeneration()).toBe(before + 1));
    await nothingOfTheAsk(app, '/');
  });
});
