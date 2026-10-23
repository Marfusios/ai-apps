import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETURN_PATH_MAX, SignInRequestSchema } from '../../shared/contracts/account';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status';
import { AiNoticeBox } from '../../web/src/features/ai/AiNoticeBox';
import { reauthRequest, returnPath, signInNavigation, signInRequest } from '../../web/src/features/auth/api';
import { CONTINUE_WITH_GOOGLE, KEPT, PRIVACY_LINK, SIGN_IN_FAILED, SIGN_IN_TITLE, SIGN_IN_UNAVAILABLE, SignInDialog } from '../../web/src/features/auth/SignInDialog';
import { WELCOME_TEXT, WELCOME_TITLE } from '../../web/src/features/auth/Welcome';
import { MOCK_USER, createHandlers, type HandlerOptions } from '../../web/src/mocks/handlers';
import { ACCOUNT_COPY } from '../../web/src/pages/Account';
import { currentUrl, renderApp, setupMockApi } from './render-app';

const server = setupMockApi();

/** Fresh mock handlers for one test; `signedIn` starts this tab signed in (the mock keeps it in session storage). */
function freshApi(options: HandlerOptions & { signedIn?: boolean } = {}): void {
  const { signedIn, ...rest } = options;
  if (signedIn) window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
  server.use(...createHandlers({ googleEnabled: true, ...rest }));
}

/** Leaving for Google, recorded instead. */
function recordNavigation(): string[] {
  const went: string[] = [];
  vi.spyOn(signInNavigation, 'go').mockImplementation((url: string) => {
    went.push(url);
  });
  return went;
}

/** Bodies the page posted to the sign-in endpoint. */
function recordSignInRequests(): unknown[] {
  const bodies: unknown[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/auth/sign-in/social') void request.clone().json().then((b) => bodies.push(b));
  });
  return bodies;
}

afterEach(() => {
  server.events.removeAllListeners();
});

describe('sign-in dialog (UI_DESIGN §4.8)', () => {
  function dialog(props: Partial<Parameters<typeof SignInDialog>[0]> = {}) {
    const onOpenChange = vi.fn();
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SignInDialog open onOpenChange={onOpenChange} returnTo="/briefs/abc?step=2" {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { ...view, onOpenChange };
  }

  it('shows the title, Continue with Google, what is kept and the privacy notice; focus starts on the title', () => {
    freshApi();
    dialog();
    const d = screen.getByRole('dialog', { name: SIGN_IN_TITLE });
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(within(d).getByRole('heading', { name: SIGN_IN_TITLE })).toBe(document.activeElement);
    expect(within(d).getByRole('button', { name: CONTINUE_WITH_GOOGLE })).toBeTruthy();
    expect(within(d).getAllByRole('listitem').map((li) => li.textContent)).toEqual(KEPT.map((line) => `·${line}`));
    expect(KEPT).toEqual([
      "We keep your Google account ID, email and name, and how many AI searches you've used.",
      'Questions and answers are held for up to 24 hours to deliver them, then deleted.',
      'Delete your account any time from Account.',
    ]);
    expect(within(d).getByRole('link', { name: PRIVACY_LINK }).getAttribute('href')).toBe('/privacy');
    expect(within(d).queryByText(SIGN_IN_FAILED)).toBeNull();
  });

  it('Continue asks the server for Google’s address, to come back here, and leaves for it', async () => {
    freshApi();
    server.use(http.post('*/api/auth/sign-in/social', () => HttpResponse.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=x', redirect: false })));
    const bodies = recordSignInRequests();
    const went: string[] = [];
    dialog({ navigate: (url) => went.push(url) });
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_WITH_GOOGLE }));
    await waitFor(() => expect(went).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=x']));
    expect(bodies).toEqual([
      {
        provider: 'google',
        callbackURL: '/briefs/abc?step=2',
        newUserCallbackURL: '/briefs/abc?step=2&welcome=1',
        errorCallbackURL: '/briefs/abc?step=2&signin=failed',
        disableRedirect: true,
      },
    ]);
  });

  it('never leaves for another site; a refusal says sign-in could not start', async () => {
    freshApi();
    server.use(http.post('*/api/auth/sign-in/social', () => HttpResponse.json({ url: 'https://evil.example/login', redirect: false })));
    const went: string[] = [];
    dialog({ navigate: (url) => went.push(url) });
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_WITH_GOOGLE }));
    expect(await screen.findByText(SIGN_IN_UNAVAILABLE)).toBeTruthy();
    expect(went).toEqual([]);

    server.use(http.post('*/api/auth/sign-in/social', () => HttpResponse.json({ message: 'Too many requests.' }, { status: 429 })));
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_WITH_GOOGLE }));
    await waitFor(() => expect(screen.getByText(SIGN_IN_UNAVAILABLE)).toBeTruthy());
    expect(went).toEqual([]);
  });

  it('after a sign-in that did not complete it says so', () => {
    freshApi();
    dialog({ failed: true });
    expect(screen.getByText(SIGN_IN_FAILED)).toBeTruthy();
  });

  it('return paths drop sign-in’s own parameters; the request matches the contract', () => {
    expect(returnPath('/explore', '?q=icing&welcome=1&signin=failed&error=state_mismatch')).toBe('/explore?q=icing');
    expect(returnPath('//evil', '')).toBe('/');
    expect(SignInRequestSchema.safeParse(signInRequest('/explore?q=icing')).success).toBe(true);
    // Too long for the sign-in's state cookie: the query is dropped, then the path.
    const long = returnPath('/explore', `?q=${'x'.repeat(400)}`);
    expect(long).toBe('/explore');
    expect(returnPath(`/${'p'.repeat(400)}`, '')).toBe('/');
    const fits = returnPath('/explore', `?q=${'x'.repeat(RETURN_PATH_MAX - '/explore?q=&signin=failed'.length)}`);
    expect(fits.startsWith('/explore?q=x')).toBe(true);
    expect(SignInRequestSchema.safeParse(signInRequest(fits)).success).toBe(true);
  });
});

describe('sign-in in the app', () => {
  it('the header offers Sign in, which opens the dialog and comes back to this page', async () => {
    freshApi();
    const went = recordNavigation();
    const bodies = recordSignInRequests();
    renderApp('/explore?q=icing');
    const header = await screen.findByRole('banner');
    fireEvent.click(await within(header).findByRole('button', { name: 'Sign in' }));
    const d = await screen.findByRole('dialog', { name: SIGN_IN_TITLE });
    fireEvent.click(within(d).getByRole('button', { name: CONTINUE_WITH_GOOGLE }));
    // The mock sends the browser straight back, as Google would after a first sign-in.
    await waitFor(() => expect(went).toEqual([`${window.location.origin}/explore?q=icing&welcome=1`]));
    expect(bodies).toMatchObject([{ callbackURL: '/explore?q=icing' }]);
  });

  it('without Google sign-in nothing offers it: no header button, a plain counter, no Continue with Google', async () => {
    freshApi({ googleEnabled: false, aiStatus: AI_STATUS_SAMPLES.trialUsed });
    renderApp('/');
    const header = await screen.findByRole('banner');
    expect(await within(header).findByText('Sign in to keep asking')).toBeTruthy();
    expect(within(header).queryByRole('button', { name: 'Sign in to keep asking' })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: CONTINUE_WITH_GOOGLE })).toBeNull();
  });

  it('the counter’s sign-in pill opens the dialog', async () => {
    freshApi({ aiStatus: AI_STATUS_SAMPLES.trialUsed });
    renderApp('/');
    fireEvent.click(await within(await screen.findByRole('banner')).findByRole('button', { name: 'Sign in to keep asking' }));
    expect(await screen.findByRole('dialog', { name: SIGN_IN_TITLE })).toBeTruthy();
  });

  it('a sign-in that came back without signing in opens the dialog with a line saying so, and drops the parameter', async () => {
    freshApi();
    const { router } = renderApp('/dashboard?signin=failed&error=access_denied');
    const d = await screen.findByRole('dialog', { name: SIGN_IN_TITLE });
    expect(within(d).getByText(SIGN_IN_FAILED)).toBeTruthy();
    await waitFor(() => expect(currentUrl(router)).toBe('/dashboard'));
  });

  it('first sign-in: the welcome, once; Continue drops the parameter; the header shows Account', async () => {
    freshApi({ signedIn: true });
    const { router } = renderApp('/explore?q=icing&welcome=1');
    const d = await screen.findByRole('dialog', { name: WELCOME_TITLE });
    expect(within(d).getByText(WELCOME_TEXT)).toBeTruthy();
    expect(WELCOME_TEXT).toBe('You have 5 AI searches a day for your first three days, then 20.');
    expect(within(d).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(d).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: WELCOME_TITLE })).toBeNull());
    expect(currentUrl(router)).toBe('/explore?q=icing');
    const header = await screen.findByRole('banner');
    expect(await within(header).findByRole('link', { name: 'Account' })).toBeTruthy();
    expect(within(header).getByText('5 of 5')).toBeTruthy();
  });

  it('the welcome is not shown to a visitor who is not signed in', async () => {
    freshApi();
    renderApp('/?welcome=1');
    await within(await screen.findByRole('banner')).findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('dialog', { name: WELCOME_TITLE })).toBeNull();
  });

  it('a retry whose brief moved to an account says to sign in to view it', () => {
    freshApi();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AiNoticeBox notice={{ kind: 'moved' }} keywordHref="/explore" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('This AI search moved to the account that signed in.')).toBeTruthy();
    expect(screen.getByText('Sign in with that account to view it.')).toBeTruthy();
  });
});

describe('account page (UI_DESIGN §4.8)', () => {
  it('signed in: name, email, searches left, Sign out', async () => {
    freshApi({ signedIn: true });
    renderApp('/account');
    expect(await screen.findByRole('heading', { level: 1, name: MOCK_USER.name })).toBeTruthy();
    expect(screen.getByText(MOCK_USER.email)).toBeTruthy();
    const main = screen.getByRole('main');
    await waitFor(() => expect(within(main).getByText(/left today/).closest('p')?.textContent).toBe('5 of 5 left today · , 150 of 150 left this month'));
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.signOut }));
    expect(await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle })).toBeTruthy();
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('delete account: says what goes, what backups hold and what stays, then asks once more (right after signing in)', async () => {
    freshApi({ signedIn: true });
    renderApp('/account');
    await screen.findByRole('heading', { level: 1, name: MOCK_USER.name });
    for (const text of [ACCOUNT_COPY.deleteNow, ACCOUNT_COPY.deleteBackups, ACCOUNT_COPY.deleteKept]) expect(screen.getByText(text)).toBeTruthy();
    expect(ACCOUNT_COPY.deleteBackups).toMatch(/Backups never include your account or your AI searches/);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    const ask = await screen.findByText(ACCOUNT_COPY.deleteAsk);
    await waitFor(() => expect(document.activeElement).toBe(ask));
    // Keep: nothing happens.
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteKeep }));
    expect(screen.queryByText(ACCOUNT_COPY.deleteAsk)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    await screen.findByText(ACCOUNT_COPY.deleteAsk);
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    expect(await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle })).toBeTruthy();
    expect(screen.getByText(ACCOUNT_COPY.deleted)).toBeTruthy();
  });

  it('delete account with an older sign-in: confirm with Google first, come back confirmed, then asks once more', async () => {
    freshApi({ signedIn: true, deletionNeedsReauth: true });
    const went = recordNavigation();
    const posted = recordSignInRequests();
    const { router } = renderApp('/account');
    await screen.findByRole('heading', { level: 1, name: MOCK_USER.name });
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    const reauth = await screen.findByText(ACCOUNT_COPY.reauthText);
    await waitFor(() => expect(document.activeElement).toBe(reauth));
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_WITH_GOOGLE }));
    await waitFor(() => expect(went).toEqual(['http://localhost:3000/account?delete=confirm']));
    expect(posted).toEqual([reauthRequest()]);
    // Back from Google, confirmed: only the last question is left.
    await act(() => router.navigate('/account?delete=confirm'));
    expect(await screen.findByText(ACCOUNT_COPY.deleteAsk)).toBeTruthy();
    await waitFor(() => expect(currentUrl(router)).toBe('/account'));
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_COPY.deleteConfirm }));
    expect(await screen.findByText(ACCOUNT_COPY.deleted)).toBeTruthy();
  });

  it('coming back without a confirmation says nothing was deleted', async () => {
    freshApi({ signedIn: true, deletionNeedsReauth: true });
    const { router } = renderApp('/account?delete=failed&error=access_denied');
    expect(await screen.findByText(ACCOUNT_COPY.reauthFailed)).toBeTruthy();
    await waitFor(() => expect(currentUrl(router)).toBe('/account'));
    await act(() => router.navigate('/account?delete=confirm'));
    expect(await screen.findByText(ACCOUNT_COPY.reauthOther)).toBeTruthy();
    expect(screen.queryByText(ACCOUNT_COPY.deleteAsk)).toBeNull();
  });

  it('signed out: the page offers sign-in', async () => {
    freshApi();
    renderApp('/account');
    expect(await screen.findByRole('heading', { level: 1, name: ACCOUNT_COPY.signedOutTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_WITH_GOOGLE }));
    expect(await screen.findByRole('dialog', { name: SIGN_IN_TITLE })).toBeTruthy();
  });

  it('without Google sign-in the page says so', async () => {
    freshApi({ googleEnabled: false });
    renderApp('/account');
    expect(await screen.findByText(ACCOUNT_COPY.unavailable)).toBeTruthy();
  });
});
