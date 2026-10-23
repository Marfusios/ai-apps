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
import { afterEach, describe, expect, it } from 'vitest';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status';
import { MOCK_SEED_QUESTION } from '../../web/mock/briefs';
import { askAvailability } from '../../web/src/features/ai/status';
import { LATER_CHECK_TITLE, type TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { rememberUnsettled, resetUnsettledForTests, unsettledId, unsettledKey } from '../../web/src/features/ai/unsettled';
import { PRIVATE_QUERY_ROOTS, PUBLIC_QUERY_ROOTS, VISITOR_CHANNEL, VisitorChangedError, forgetVisitor, privateRead } from '../../web/src/features/auth/visitor';
import { rememberQuestion, rememberedQuestion } from '../../web/src/features/brief/memory';
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
 * held), unless it was removed first; records how it was shown.
 */
function installTurnstile({ hold = false }: { hold?: boolean } = {}): { appearances: string[]; release: () => void } {
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
  return { appearances, release: () => waiting.splice(0).forEach((answer) => answer()) };
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

/** Another tab of the site announces a visitor change. */
async function otherTabChangesVisitor(): Promise<void> {
  const other = new BroadcastChannel(VISITOR_CHANNEL);
  other.postMessage({ type: 'visitor-changed' });
  other.close();
  await act(() => sleep(50));
}

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

  async function signOutHere(app: ReturnType<typeof renderApp>): Promise<void> {
    await act(() => app.router.navigate('/account'));
    fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.signOut }));
    await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle });
  }

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
});
