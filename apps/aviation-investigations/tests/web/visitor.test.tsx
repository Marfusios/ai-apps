/**
 * Whose data the page holds (Task 20 review): signing out or deleting the account forgets
 * every private query (the brief, its case context, the AI counts, the account), the
 * questions held in memory and the retry keys, and an answer still on its way cannot put
 * any of it back. Also how the page meets the server's extra check for signed-in AI, and a
 * request refused because the session ended.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status';
import { MOCK_SEED_QUESTION } from '../../web/mock/briefs';
import { askAvailability } from '../../web/src/features/ai/status';
import { LATER_CHECK_TITLE, type TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { rememberUnsettled, resetUnsettledForTests, unsettledId, unsettledKey } from '../../web/src/features/ai/unsettled';
import {
  PRIVATE_QUERY_ROOTS,
  PUBLIC_QUERY_ROOTS,
  VISITOR_CHANNEL,
  VISITOR_STORAGE_KEY,
  VisitorChangedError,
  forgetVisitor,
  privateRead,
  visitorGeneration,
} from '../../web/src/features/auth/visitor';
import { DeletionUnconfirmedError, SignOutUnconfirmedError, deleteAccount, signOut } from '../../web/src/features/auth/api';
import { rememberQuestion, rememberedQuestion } from '../../web/src/features/brief/memory';
import { postJson } from '../../web/src/api';
import { createHandlers, type HandlerOptions } from '../../web/src/mocks/handlers';
import { ACCOUNT_COPY } from '../../web/src/pages/Account';
import { EXPIRED_TITLE } from '../../web/src/pages/Brief';
import { currentUrl, renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const CITED = /castellated nut used to secure the governor lever control rod/;

/** This tab starts signed in (the mock keeps it in session storage), with fresh handlers. */
function signedInApi(options: HandlerOptions = {}): void {
  window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
  server.use(...createHandlers({ googleEnabled: true, briefPolls: 1, ...options }));
}

/**
 * A Turnstile stand-in: every widget answers with the test token (after `release()` when
 * held), unless it was removed first; records how it was shown and how many are open.
 */
function installTurnstile({ hold = false }: { hold?: boolean } = {}): { appearances: string[]; release: () => void; open: () => number } {
  const appearances: string[] = [];
  const live = new Set<string>();
  const waiting: (() => void)[] = [];
  let n = 0;
  const api: TurnstileApi = {
    render(host, params) {
      n += 1;
      const id = `w${n}`;
      live.add(id);
      appearances.push(params.appearance);
      host.appendChild(document.createElement('div'));
      const answer = () => {
        if (live.has(id)) params.callback('XXXX.DUMMY.TOKEN.XXXX');
      };
      if (hold) waiting.push(answer);
      else setTimeout(answer, 20);
      return id;
    },
    remove(id) {
      live.delete(id);
    },
  };
  window.turnstile = api;
  return { appearances, release: () => waiting.splice(0).forEach((answer) => answer()), open: () => live.size };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A POST to `pattern` that waits until `release()`, then answers with `answer()`; counts its calls. */
function holdPost(pattern: string, answer: () => Response) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  server.use(
    http.post(pattern, async () => {
      calls += 1;
      await released;
      return answer();
    }),
  );
  return { release, calls: () => calls };
}

/** Another tab's message on the channel: the change and whether that tab recorded it in local storage. */
async function messageFromOtherTab(change: string, { recorded }: { recorded: boolean }): Promise<void> {
  const other = new BroadcastChannel(VISITOR_CHANNEL);
  other.postMessage({ type: 'visitor-changed', change, recorded });
  other.close();
  await act(() => sleep(50));
}

/** Another tab of the site changes the visitor: it records the change, then announces it. */
async function otherTabChangesVisitor(change: string = crypto.randomUUID()): Promise<void> {
  window.localStorage.setItem(VISITOR_STORAGE_KEY, change);
  await messageFromOtherTab(change, { recorded: true });
}

/** Another tab records a visitor change in local storage; `event`: the browser tells this tab (it does not while a page is away). */
async function otherTabRecordsChange({ event }: { event: boolean }, change: string = crypto.randomUUID()): Promise<string> {
  window.localStorage.setItem(VISITOR_STORAGE_KEY, change);
  if (event) window.dispatchEvent(new StorageEvent('storage', { key: VISITOR_STORAGE_KEY, newValue: change, storageArea: window.localStorage }));
  await act(() => sleep(50));
  return change;
}

/**
 * How a sign-out can end without the server's confirmation (gate t22 findings 1 and r2 1):
 * - `pending`: 503 `sign_out_pending`, read in full (the server expired the session cookie
 *   and keeps the sign-out for a retry);
 * - `interrupted`: the same 503's headers arrive (the cookie is expired) and the connection
 *   breaks in its body;
 * - `network`: no answer at all; the request may never have reached the server, which
 *   still holds the session.
 */
type SignOutFailure = 'pending' | 'interrupted' | 'network';
const SIGN_OUT_FAILURES: SignOutFailure[] = ['pending', 'interrupted', 'network'];

/**
 * The next sign-out ends as `failure`. Where the server ended this browser's session, the
 * account and the AI counts then read as the signed-out visitor's, as they would there.
 */
function signOutFails(failure: SignOutFailure): void {
  let signedOut = false;
  const headers = { 'retry-after': '5', 'cache-control': 'no-store', 'content-type': 'application/json' };
  server.use(
    http.post('*/api/auth/sign-out', () => {
      if (failure === 'network') return HttpResponse.error();
      signedOut = true;
      if (failure === 'pending') return HttpResponse.json({ error: 'sign_out_pending', message: 'Signed out here; not confirmed yet.', retryAfter: 5 }, { status: 503, headers });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"sign_out_pen'));
          controller.error(new TypeError('network error'));
        },
      });
      return new HttpResponse(body, { status: 503, headers });
    }),
    http.get('*/api/account', () => (signedOut ? HttpResponse.json({ signedIn: false }, { headers: { 'cache-control': 'no-store' } }) : undefined)),
    http.get('*/api/ai/status', () => (signedOut ? HttpResponse.json(AI_STATUS_SAMPLES.fresh, { headers: { 'cache-control': 'no-store' } }) : undefined)),
  );
}

/**
 * How a deletion can end without the server's confirmation:
 * - `readable`: an error read in full (503 `unavailable`), the account not deleted;
 * - `interrupted`: the success's headers arrive (the account deleted, the session cookie
 *   expired) and the connection breaks in its body;
 * - `network`: no answer at all; the request may never have reached the server.
 */
type DeletionFailure = 'readable' | 'interrupted' | 'network';
const DELETION_FAILURES: DeletionFailure[] = ['readable', 'interrupted', 'network'];

/** The next deletion ends as `failure`; where the account is gone, the account and AI counts read signed out. */
function deletionFails(failure: DeletionFailure): void {
  let deleted = false;
  const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' };
  server.use(
    http.post('*/api/account/delete', () => {
      if (failure === 'network') return HttpResponse.error();
      if (failure === 'readable') return HttpResponse.json({ error: 'unavailable', message: 'Try again shortly.', retryAfter: 5 }, { status: 503, headers });
      deleted = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"dele'));
          controller.error(new TypeError('network error'));
        },
      });
      return new HttpResponse(body, { status: 200, headers });
    }),
    http.get('*/api/account', () => (deleted ? HttpResponse.json({ signedIn: false }, { headers }) : undefined)),
    http.get('*/api/ai/status', () => (deleted ? HttpResponse.json(AI_STATUS_SAMPLES.fresh, { headers }) : undefined)),
  );
}

/**
 * `action` (a sign-out or a deletion the server does not confirm) forgets at once: a private
 * answer still on its way is dropped, the held questions and retry keys go, an AI request of
 * the previous visitor sends nothing more, and the other tabs are told.
 */
async function expectForgottenWhatever(action: (client: QueryClient) => Promise<void>, unconfirmed: new (...args: never[]) => Error): Promise<void> {
  const client = new QueryClient();
  let answer!: (value: { secret: string }) => void;
  const late = privateRead(() => new Promise<{ secret: string }>((resolve) => (answer = resolve)));
  const pending = client.fetchQuery({ queryKey: ['brief-case', 'b', 1, 'N1'], queryFn: () => late });
  rememberQuestion('b1', 'A question of the previous visitor');
  rememberUnsettled('id1', 'retry-key-0001');
  const generation = visitorGeneration();
  const marker = window.localStorage.getItem(VISITOR_STORAGE_KEY);
  const otherTab = new BroadcastChannel(VISITOR_CHANNEL);
  const heard: unknown[] = [];
  otherTab.onmessage = (event: MessageEvent) => heard.push(event.data);
  let briefPosts = 0;
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/briefs') briefPosts += 1;
  });
  try {
    await expect(action(client)).rejects.toBeInstanceOf(unconfirmed);
    expect(visitorGeneration()).toBeGreaterThan(generation);
    // A private answer still on its way is dropped, never cached.
    answer({ secret: 'the previous visitor’s case context' });
    await expect(late).rejects.toBeInstanceOf(VisitorChangedError);
    await expect(pending).rejects.toBeTruthy();
    expect(client.getQueryData(['brief-case', 'b', 1, 'N1'])).toBeUndefined();
    expect(rememberedQuestion('b1')).toBeNull();
    expect(unsettledKey('id1')).toBeNull();
    // An AI request of the previous visitor sends nothing more.
    await expect(postJson('/api/briefs', { question: MOCK_SEED_QUESTION }, null, generation)).rejects.toBeInstanceOf(VisitorChangedError);
    expect(briefPosts).toBe(0);
    // The other tabs are told.
    const change = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    expect(change).not.toBe(marker);
    await waitFor(() => expect(heard).toEqual([{ type: 'visitor-changed', change, recorded: true }]));
  } finally {
    otherTab.close();
    server.events.removeAllListeners();
  }
}

/** The other tab's sign-out on the server (the session ends there). */
const signOutOnServer = () => fetch(new URL('/api/auth/sign-out', window.location.href), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

afterEach(() => {
  delete window.turnstile;
  resetUnsettledForTests();
  window.sessionStorage.clear();
});

/** Ask from the home page and open the drawer of the cited case: the brief's private context is on screen. */
async function briefWithDrawer() {
  const app = renderApp('/');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
  fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
  await waitFor(() => expect(currentUrl(app.router)).toMatch(/^\/briefs\/[0-9a-f-]{36}$/), SLOW);
  const label = await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
  fireEvent.click(within(label.parentElement as HTMLElement).getByRole('link', { name: 'DFW08TA066' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(CITED, { selector: 'mark' }, SLOW);
  return { ...app, drawerUrl: currentUrl(app.router) };
}

/**
 * Nothing of the previous visitor is left in the cache: no brief or case context, the
 * account signed out, and AI counts only as read again for the new (anonymous) visitor.
 */
function previousVisitorGone(client: QueryClient): boolean {
  const empty = (root: string) => client.getQueriesData({ queryKey: [root] }).every(([, data]) => data === undefined);
  const counts = client.getQueryData<{ remaining?: { kind?: string } | null }>(['ai-status']);
  return empty('brief') && empty('brief-case') && counts?.remaining?.kind !== 'account' && client.getQueryData<{ signedIn: boolean }>(['account'])?.signedIn === false;
}

describe('a new visitor sees nothing of the previous one (Task 20 review)', () => {
  it('signing out forgets the brief and its case context: back at the evidence drawer, nothing private shows', async () => {
    signedInApi();
    const app = await briefWithDrawer();
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
    await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle });
    expect(previousVisitorGone(app.client)).toBe(true);
    // Back to the drawer: the brief is read again as the new visitor and is not theirs; no AI context shows.
    await act(() => app.router.navigate(app.drawerUrl));
    expect((await screen.findAllByText(EXPIRED_TITLE, {}, SLOW)).length).toBeGreaterThan(0);
    expect(screen.queryByText(CITED, { selector: 'mark' })).toBeNull();
    expect(screen.queryByText('AI classified')).toBeNull();
  }, 20_000);

  it.each(['pending', 'interrupted'] as const)('a sign-out the server could not confirm (%s) forgets them all the same, in every tab, and says so (gate t22 finding 1, r2 finding 1)', async (failure) => {
    signedInApi();
    const app = await briefWithDrawer();
    signOutFails(failure);
    const generation = visitorGeneration();
    const marker = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    const otherTab = new BroadcastChannel(VISITOR_CHANNEL);
    const heard: unknown[] = [];
    otherTab.onmessage = (event: MessageEvent) => heard.push(event.data);
    try {
      await act(() => app.router.navigate('/account'));
      fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
      expect(await screen.findByText(ACCOUNT_COPY.signOutUnconfirmed)).toBeTruthy();
      await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle });
      // The same forgetting as a confirmed sign-out: the generation moves on, private queries
      // go, and the other tabs are told (the recorded change, and the channel).
      expect(visitorGeneration()).toBeGreaterThan(generation);
      await waitFor(() => expect(previousVisitorGone(app.client)).toBe(true));
      const change = window.localStorage.getItem(VISITOR_STORAGE_KEY);
      expect(change).not.toBe(marker);
      await waitFor(() => expect(heard).toEqual([{ type: 'visitor-changed', change, recorded: true }]));
      expect(screen.queryByText(ACCOUNT_COPY.failed)).toBeNull();
    } finally {
      otherTab.close();
    }
  }, 20_000);

  it('a sign-out that got no answer forgets them all the same and shows the account the server still has, saying so (gate t22 r2 finding 1)', async () => {
    signedInApi();
    const app = await briefWithDrawer();
    signOutFails('network');
    const generation = visitorGeneration();
    const marker = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
    expect(await screen.findByText(ACCOUNT_COPY.signOutUnconfirmed)).toBeTruthy();
    // The account is read again: the server still holds the session, so it shows, to sign out again.
    expect(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut })).toBeTruthy();
    expect(visitorGeneration()).toBeGreaterThan(generation);
    expect(window.localStorage.getItem(VISITOR_STORAGE_KEY)).not.toBe(marker);
    const empty = (root: string) => app.client.getQueriesData({ queryKey: [root] }).every(([, data]) => data === undefined);
    expect(empty('brief') && empty('brief-case')).toBe(true);
  }, 20_000);

  it.each(SIGN_OUT_FAILURES)('a sign-out ending %s forgets at once: late private answers, held questions, retry keys and AI sends of the previous visitor (gate t22 r2 finding 1)', async (failure) => {
    signedInApi();
    signOutFails(failure);
    await expectForgottenWhatever(signOut, SignOutUnconfirmedError);
  });

  it.each(DELETION_FAILURES)('a deletion ending %s forgets at once as well: late private answers, held questions, retry keys and AI sends of the previous visitor', async (failure) => {
    signedInApi();
    deletionFails(failure);
    await expectForgottenWhatever(deleteAccount, DeletionUnconfirmedError);
  });

  it('a deletion refused in full for a Google confirmation forgets nothing: nothing was deleted and the session stands', async () => {
    signedInApi();
    server.use(
      http.post('*/api/account/delete', () =>
        HttpResponse.json({ error: 'reauth_required', message: "Confirm with Google that it's you, then delete your account." }, { status: 403 }),
      ),
    );
    rememberQuestion('b1', 'A question of this visitor');
    rememberUnsettled('id1', 'retry-key-0001');
    const marker = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    await expect(deleteAccount(new QueryClient())).rejects.toMatchObject({ status: 403, body: { error: 'reauth_required' } });
    expect(rememberedQuestion('b1')).toBe('A question of this visitor');
    expect(unsettledKey('id1')).toBe('retry-key-0001');
    expect(window.localStorage.getItem(VISITOR_STORAGE_KEY)).toBe(marker);
  });

  it.each(DELETION_FAILURES)('the account page after a deletion ending %s: everything private forgotten, the account read again, and the server’s silence said', async (failure) => {
    signedInApi();
    const app = await briefWithDrawer();
    deletionFails(failure);
    const generation = visitorGeneration();
    const marker = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleteAsk);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    expect(await screen.findByText(ACCOUNT_COPY.deleteUnconfirmed)).toBeTruthy();
    if (failure === 'interrupted') {
      // The account is gone: signed out.
      await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle });
    } else {
      // Still there: it shows, to be deleted again.
      expect(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut })).toBeTruthy();
      expect(screen.queryByText(ACCOUNT_COPY.deleteAsk)).toBeNull();
    }
    expect(visitorGeneration()).toBeGreaterThan(generation);
    expect(window.localStorage.getItem(VISITOR_STORAGE_KEY)).not.toBe(marker);
    const empty = (root: string) => app.client.getQueriesData({ queryKey: [root] }).every(([, data]) => data === undefined);
    expect(empty('brief') && empty('brief-case')).toBe(true);
    expect(screen.queryByText(ACCOUNT_COPY.deleted)).toBeNull();
    expect(screen.queryByText(ACCOUNT_COPY.failed)).toBeNull();
  }, 20_000);

  it('deleting the account forgets them too', async () => {
    signedInApi();
    const app = await briefWithDrawer();
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleteAsk);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    expect(await screen.findByText(ACCOUNT_COPY.deleted)).toBeTruthy();
    expect(previousVisitorGone(app.client)).toBe(true);
    await act(() => app.router.navigate(app.drawerUrl));
    expect((await screen.findAllByText(EXPIRED_TITLE, {}, SLOW)).length).toBeGreaterThan(0);
    expect(screen.queryByText(CITED, { selector: 'mark' })).toBeNull();
  }, 20_000);

  it('an answer still on its way when the visitor changes is dropped, never cached', async () => {
    const client = new QueryClient();
    let answer!: (value: { secret: string }) => void;
    const late = privateRead(() => new Promise<{ secret: string }>((resolve) => (answer = resolve)));
    const pending = client.fetchQuery({ queryKey: ['brief-case', 'b', 1, 'N1'], queryFn: () => late });
    await forgetVisitor(client);
    answer({ secret: 'the previous visitor’s case context' });
    await expect(late).rejects.toBeInstanceOf(VisitorChangedError);
    await expect(pending).rejects.toBeTruthy();
    expect(client.getQueryData(['brief-case', 'b', 1, 'N1'])).toBeUndefined();
    // A read that starts after the change is the new visitor's and is kept.
    await expect(privateRead(async () => 'new')).resolves.toBe('new');
  });

  it('the questions held for “Ask again” and the retry keys go with the visitor', async () => {
    rememberQuestion('b1', 'A question of the previous visitor');
    rememberUnsettled('id1', 'retry-key-0001');
    await forgetVisitor(new QueryClient());
    expect(rememberedQuestion('b1')).toBeNull();
    expect(unsettledKey('id1')).toBeNull();
  });

  it('every query namespace of the app is either private (forgotten with the visitor, read through privateRead) or public', () => {
    const root = resolve(fileURLToPath(import.meta.url), '../../../web/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const seen = new Map<string, string[]>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/queryKey:\s*\[\s*'([a-z-]+)'/g)) seen.set(m[1]!, [...(seen.get(m[1]!) ?? []), file]);
    }
    const known = new Set<string>([...PRIVATE_QUERY_ROOTS, ...PUBLIC_QUERY_ROOTS]);
    for (const key of seen.keys()) expect(known.has(key), `query key root '${key}' is neither private nor public`).toBe(true);
    // Each private namespace's query function guards its answer.
    for (const key of PRIVATE_QUERY_ROOTS) {
      const definitions = files.filter((f) => new RegExp(`queryKey:\\s*\\['${key}'[^\\n]*\\n\\s*queryFn: \\(\\{ signal \\}\\) =>\\s*privateRead`).test(readFileSync(f, 'utf8')));
      expect(definitions, key).toHaveLength(1);
    }
  });
});

describe('signed-in AI and the extra check (DESIGN §8)', () => {
  it('the AI status says whether a request takes a check: every anonymous one, a signed-in one only when asked', () => {
    expect(askAvailability(AI_STATUS_SAMPLES.checkedAccount)).toMatchObject({ kind: 'available', anonymous: false, check: true });
    expect(askAvailability(AI_STATUS_SAMPLES.signedIn)).toMatchObject({ kind: 'available', anonymous: false, check: false });
    expect(askAvailability(AI_STATUS_SAMPLES.fresh)).toMatchObject({ kind: 'available', anonymous: true, check: true });
  });

  it('ordinary signed-in requests take no check', async () => {
    signedInApi();
    const turnstile = installTurnstile();
    await briefWithDrawer();
    expect(turnstile.appearances).toEqual([]);
  });

  it('when the server asks for a check, the request takes one at click time without the panel', async () => {
    signedInApi({ accountCheck: true });
    const turnstile = installTurnstile();
    const tokens: (string | undefined)[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/briefs') {
        void request.clone().json().then((b: { turnstileToken?: string }) => tokens.push(b.turnstileToken));
      }
    });
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await waitFor(() => expect(currentUrl(app.router)).toMatch(/^\/briefs\//), SLOW);
    expect(turnstile.appearances).toEqual(['interaction-only']);
    expect(tokens).toEqual(['XXXX.DUMMY.TOKEN.XXXX']);
    expect(screen.queryByRole('dialog', { name: LATER_CHECK_TITLE })).toBeNull();
    server.events.removeAllListeners();
  });

  it('a check the status did not announce shows the panel, then sends again with a token', async () => {
    signedInApi();
    const turnstile = installTurnstile();
    let refused = 0;
    server.use(
      http.post('*/api/briefs', async ({ request }) => {
        const body = (await request.clone().json()) as { turnstileToken?: string };
        if (!body.turnstileToken) {
          refused += 1;
          return HttpResponse.json({ error: 'challenge_required', message: 'A quick check is needed before this AI search.' }, { status: 403 });
        }
        return undefined;
      }),
    );
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    expect(await screen.findByRole('dialog', { name: LATER_CHECK_TITLE })).toBeTruthy();
    await waitFor(() => expect(currentUrl(app.router)).toMatch(/^\/briefs\//), SLOW);
    expect(refused).toBe(1);
    expect(turnstile.appearances).toEqual(['always']);
  });

  it('a request refused because the session ended says so and forgets the previous visitor', async () => {
    signedInApi();
    server.use(
      http.post('*/api/briefs', () =>
        HttpResponse.json({ error: 'signed_out', message: "You were signed out, so this AI search didn't start. Sign in to ask again." }, { status: 403 }),
      ),
    );
    const app = renderApp('/');
    await within(await screen.findByRole('banner')).findByRole('link', { name: 'Account' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    expect(await screen.findByText("You were signed out, so this AI search didn't start. Sign in to ask again.")).toBeTruthy();
    await waitFor(() => expect(app.client.getQueryData(['account'])).toEqual({ signedIn: false }));
  });
});

describe('an AI request whose visitor changes before it ends keeps nothing (Task 20 gate)', () => {
  const ANSWERED_ID = '00000000-0000-4000-8000-0000000000ff';

  async function askHeld(answer: () => Response) {
    const held = holdPost('*/api/briefs', answer);
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await waitFor(() => expect(held.calls()).toBe(1));
    return { ...app, held };
  }

  /** Sign out from the account page; `failure`: the sign-out ends that way, unconfirmed. */
  async function signOutHere(app: ReturnType<typeof renderApp>, { failure }: { failure?: SignOutFailure } = {}): Promise<void> {
    if (failure) signOutFails(failure);
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
    if (failure) await screen.findByText(ACCOUNT_COPY.signOutUnconfirmed);
    else await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle });
  }

  it.each(SIGN_OUT_FAILURES)('a question answered after a sign-out ending %s opens nothing and keeps nothing (gate t22 finding 1, r2 finding 1)', async (failure) => {
    signedInApi();
    const app = await askHeld(() => HttpResponse.json({ kind: 'started', briefId: ANSWERED_ID, step: 1, stage: 'retrieve' }, { status: 202 }));
    await signOutHere(app, { failure });
    app.held.release();
    await act(() => sleep(150));
    expect(currentUrl(app.router)).toBe('/account');
    expect(rememberedQuestion(ANSWERED_ID)).toBeNull();
    expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
  });

  it('a question answered while the sign-out is still on its way opens nothing and keeps nothing (gate t22 r2 finding 1)', async () => {
    signedInApi();
    const app = await askHeld(() => HttpResponse.json({ kind: 'started', briefId: ANSWERED_ID, step: 1, stage: 'retrieve' }, { status: 202 }));
    // The server takes its time over the sign-out, and the question's answer comes first.
    const signingOut = holdPost('*/api/auth/sign-out', () => HttpResponse.error());
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
    await waitFor(() => expect(signingOut.calls()).toBe(1));
    app.held.release();
    await act(() => sleep(150));
    expect(currentUrl(app.router)).toBe('/account');
    expect(rememberedQuestion(ANSWERED_ID)).toBeNull();
    signingOut.release();
    await screen.findByText(ACCOUNT_COPY.signOutUnconfirmed);
    expect(currentUrl(app.router)).toBe('/account');
    expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
  });

  it('a question answered while the deletion is still on its way opens nothing and keeps nothing', async () => {
    signedInApi();
    const app = await askHeld(() => HttpResponse.json({ kind: 'started', briefId: ANSWERED_ID, step: 1, stage: 'retrieve' }, { status: 202 }));
    // The server takes its time over the deletion, and the question's answer comes first.
    const deleting = holdPost('*/api/account/delete', () => HttpResponse.error());
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleteAsk);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await waitFor(() => expect(deleting.calls()).toBe(1));
    app.held.release();
    await act(() => sleep(150));
    expect(currentUrl(app.router)).toBe('/account');
    expect(rememberedQuestion(ANSWERED_ID)).toBeNull();
    deleting.release();
    await screen.findByText(ACCOUNT_COPY.deleteUnconfirmed);
    expect(currentUrl(app.router)).toBe('/account');
    expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
  }, 20_000);

  it.each(DELETION_FAILURES)('a check still open when a deletion ends %s is cancelled, and nothing is sent', async (failure) => {
    signedInApi({ accountCheck: true });
    const turnstile = installTurnstile({ hold: true });
    let posts = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/briefs') posts += 1;
    });
    try {
      const app = renderApp('/');
      fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
      fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
      await waitFor(() => expect(turnstile.appearances).toHaveLength(1));
      // The deletion, as the account page sends it, while the request waits for its check.
      deletionFails(failure);
      await act(() => expect(deleteAccount(app.client)).rejects.toBeInstanceOf(DeletionUnconfirmedError));
      turnstile.release();
      await act(() => sleep(150));
      expect(posts).toBe(0);
      expect(currentUrl(app.router)).toBe('/');
      expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
    } finally {
      server.events.removeAllListeners();
    }
  });

  it.each(['interrupted', 'network'] as const)('a check still open when a sign-out ends %s is cancelled, and nothing is sent (gate t22 r2 finding 1)', async (failure) => {
    signedInApi({ accountCheck: true });
    const turnstile = installTurnstile({ hold: true });
    let posts = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/briefs') posts += 1;
    });
    try {
      const app = renderApp('/');
      fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
      fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
      await waitFor(() => expect(turnstile.appearances).toHaveLength(1));
      // The sign-out, as the account page sends it, while the request waits for its check.
      signOutFails(failure);
      await act(() => expect(signOut(app.client)).rejects.toBeInstanceOf(SignOutUnconfirmedError));
      turnstile.release();
      await act(() => sleep(150));
      expect(posts).toBe(0);
      expect(currentUrl(app.router)).toBe('/');
      expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
    } finally {
      server.events.removeAllListeners();
    }
  });

  it('a question answered after sign-out opens nothing and keeps neither the question nor a retry key', async () => {
    signedInApi();
    const app = await askHeld(() => HttpResponse.json({ kind: 'started', briefId: ANSWERED_ID, step: 1, stage: 'retrieve' }, { status: 202 }));
    await signOutHere(app);
    app.held.release();
    await act(() => sleep(150));
    expect(currentUrl(app.router)).toBe('/account');
    expect(rememberedQuestion(ANSWERED_ID)).toBeNull();
    expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
  });

  it('a question whose answer is lost after sign-out keeps no retry key', async () => {
    signedInApi();
    const app = await askHeld(() => HttpResponse.error());
    await signOutHere(app);
    app.held.release();
    await act(() => sleep(150));
    expect(currentUrl(app.router)).toBe('/account');
    expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
  });

  it('a refinement whose answer is lost after the account is deleted keeps no retry key and moves nowhere', async () => {
    signedInApi();
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    const briefId = currentUrl(app.router).split('/')[2]!;
    const held = holdPost('*/api/briefs/:id/refine', () => HttpResponse.error());
    fireEvent.change(screen.getByRole('textbox', { name: /^refine$/i }), { target: { value: 'only helicopters' } });
    fireEvent.click(screen.getByRole('button', { name: /^Refine\s*·\s*uses 1$/ }));
    await waitFor(() => expect(held.calls()).toBe(1));
    // Deleted meanwhile, from the account page.
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleteAsk);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleted);
    held.release();
    await act(() => sleep(150));
    expect(currentUrl(app.router)).toBe('/account');
    expect(unsettledKey(await unsettledId({ kind: 'refine', briefId, change: { kind: 'text', text: 'only helicopters' } }))).toBeNull();
  }, 20_000);

  it('a refinement whose brief is still being read again when the visitor changes moves nowhere', async () => {
    signedInApi();
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await screen.findByRole('heading', { name: /AI summary/i }, SLOW);
    // Once the refinement is answered, the brief is read again: those reads wait.
    let reads = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('*/api/briefs/:id', async () => {
        reads += 1;
        await released;
        return undefined;
      }),
    );
    const at = app.router.state.location.key;
    fireEvent.change(screen.getByRole('textbox', { name: /^refine$/i }), { target: { value: 'only helicopters' } });
    fireEvent.click(screen.getByRole('button', { name: /^Refine\s*·\s*uses 1$/ }));
    await waitFor(() => expect(reads).toBe(1));
    // Another tab signs out meanwhile.
    await fetch(new URL('/api/auth/sign-out', window.location.href), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await otherTabChangesVisitor();
    release();
    await act(() => sleep(150));
    expect(app.router.state.location.key).toBe(at);
  }, 20_000);

  it('a second check, asked for after a refused token and still open when the visitor changes, is cancelled and nothing more is sent', async () => {
    signedInApi();
    const turnstile = installTurnstile({ hold: true });
    let posts = 0;
    server.use(
      http.post('*/api/briefs', () => {
        posts += 1;
        return HttpResponse.json({ error: 'challenge_required', message: 'A quick check is needed before this AI search.' }, { status: 403 });
      }),
    );
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await waitFor(() => expect(turnstile.appearances).toEqual(['always']));
    await otherTabChangesVisitor();
    turnstile.release();
    await act(() => sleep(150));
    expect(posts).toBe(1);
    expect(currentUrl(app.router)).toBe('/');
    expect(unsettledKey(await unsettledId({ kind: 'create', question: MOCK_SEED_QUESTION }))).toBeNull();
  });

  it('a check still open when the visitor changes is cancelled, and nothing is sent', async () => {
    signedInApi({ accountCheck: true });
    const turnstile = installTurnstile({ hold: true });
    let posts = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/briefs') posts += 1;
    });
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await waitFor(() => expect(turnstile.appearances).toHaveLength(1));
    // Another tab signs out while the check is open.
    await otherTabChangesVisitor();
    turnstile.release();
    await act(() => sleep(150));
    expect(posts).toBe(0);
    expect(currentUrl(app.router)).toBe('/');
    server.events.removeAllListeners();
  });
});

describe('every open tab forgets the previous visitor (Task 20 review N4)', () => {
  it('another tab’s sign-out makes this tab drop the previous visitor’s brief and AI context', async () => {
    signedInApi();
    const app = await briefWithDrawer();
    // The other tab signs out (the server's session ends) and says so.
    await fetch(new URL('/api/auth/sign-out', window.location.href), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await otherTabChangesVisitor();
    await waitFor(() => expect(previousVisitorGone(app.client)).toBe(true));
    // What this tab still shows is read again as the new visitor: the brief is not theirs.
    expect((await screen.findAllByText(EXPIRED_TITLE, {}, SLOW)).length).toBeGreaterThan(0);
    expect(screen.queryByText(CITED, { selector: 'mark' })).toBeNull();
    expect(screen.queryByText('AI classified')).toBeNull();
  }, 20_000);

  it('without BroadcastChannel the change still arrives: the other tab’s record in local storage (Task 20 review N9)', async () => {
    signedInApi();
    const app = await briefWithDrawer();
    await signOutOnServer();
    await otherTabRecordsChange({ event: true });
    await waitFor(() => expect(previousVisitorGone(app.client)).toBe(true));
    expect((await screen.findAllByText(EXPIRED_TITLE, {}, SLOW)).length).toBeGreaterThan(0);
    expect(screen.queryByText(CITED, { selector: 'mark' })).toBeNull();
  }, 20_000);

  it('a page restored from the back/forward cache checks the record: a change made while it was away is forgotten (N9)', async () => {
    signedInApi();
    const app = await briefWithDrawer();
    // Restored with nothing changed: everything stays.
    const before = visitorGeneration();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await act(() => sleep(50));
    expect(visitorGeneration()).toBe(before);
    expect(screen.getByText(CITED, { selector: 'mark' })).toBeTruthy();
    // Away while another tab signed out: no message reached it, the record did change.
    await signOutOnServer();
    await otherTabRecordsChange({ event: false });
    expect(visitorGeneration()).toBe(before);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(() => expect(previousVisitorGone(app.client)).toBe(true));
    expect(screen.queryByText(CITED, { selector: 'mark' })).toBeNull();
  }, 20_000);

  it('a tab that starts listening after another tab’s change still forgets it (N9)', async () => {
    rememberQuestion('00000000-0000-4000-8000-0000000000aa', 'an earlier question');
    const before = visitorGeneration();
    // The change happened after this page's code loaded and before the app listened.
    await otherTabRecordsChange({ event: false });
    renderApp('/');
    await waitFor(() => expect(visitorGeneration()).toBe(before + 1));
    expect(rememberedQuestion('00000000-0000-4000-8000-0000000000aa')).toBeNull();
  });

  it('changes missed while the page was away are forgotten once, even when their queued messages arrive afterwards (round 5)', async () => {
    signedInApi();
    renderApp('/');
    await act(() => sleep(50));
    const before = visitorGeneration();
    // Away in the cache while another tab made three changes: each recorded, its message queued.
    const changes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const change of changes) await otherTabRecordsChange({ event: false }, change);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await act(() => sleep(50));
    expect(visitorGeneration()).toBe(before + 1);
    for (const change of changes) await messageFromOtherTab(change, { recorded: true });
    expect(visitorGeneration()).toBe(before + 1);
    // A later change still counts, also one its tab could not record.
    await messageFromOtherTab(crypto.randomUUID(), { recorded: false });
    expect(visitorGeneration()).toBe(before + 2);
  });

  it('after another tab’s change the page reads the account again: it shows who the server says is signed in (round 5)', async () => {
    signedInApi();
    renderApp('/');
    const banner = await screen.findByRole('banner');
    await within(banner).findByRole('link', { name: 'Account' });
    // The other tab signed out and in again: this browser still has a session on the server.
    await otherTabChangesVisitor();
    await within(banner).findByRole('link', { name: 'Account' });
  });

  it('a page restored without readable local storage forgets as if the visitor changed: memory, checks, waiting requests (Task 20 gate, round 5)', async () => {
    signedInApi({ accountCheck: true });
    const turnstile = installTurnstile({ hold: true });
    let posts = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/briefs') posts += 1;
    });
    // What the page holds for this visitor: a question for "Ask again" and a retry key.
    const heldId = '00000000-0000-4000-8000-0000000000bb';
    rememberQuestion(heldId, 'an earlier question');
    const retryId = await unsettledId({ kind: 'create', question: 'an earlier question' });
    rememberUnsettled(retryId, 'an-earlier-retry-key');
    const app = renderApp('/');
    // An AI request waits for its check.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_SEED_QUESTION } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await waitFor(() => expect(turnstile.open()).toBe(1));
    const before = visitorGeneration();
    // Back from the back/forward cache, where local storage cannot be read.
    const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await act(() => sleep(50));
    } finally {
      blocked.mockRestore();
    }
    expect(visitorGeneration()).toBe(before + 1);
    expect(rememberedQuestion(heldId)).toBeNull();
    expect(unsettledKey(retryId)).toBeNull();
    // The check was cancelled: a token arriving now sends nothing, and the page stays where it is.
    expect(turnstile.open()).toBe(0);
    turnstile.release();
    await act(() => sleep(150));
    expect(posts).toBe(0);
    expect(currentUrl(app.router)).toBe('/');
    // Who is signed in is read again (the server still has this browser's session).
    await within(await screen.findByRole('banner')).findByRole('link', { name: 'Account' });
    server.events.removeAllListeners();
  });

  it('one change heard twice, on the channel and through local storage, is forgotten once (N9)', async () => {
    signedInApi();
    renderApp('/');
    await act(() => sleep(50));
    const before = visitorGeneration();
    const change = crypto.randomUUID();
    await otherTabChangesVisitor(change);
    await otherTabRecordsChange({ event: true }, change);
    expect(visitorGeneration()).toBe(before + 1);
  });
});
