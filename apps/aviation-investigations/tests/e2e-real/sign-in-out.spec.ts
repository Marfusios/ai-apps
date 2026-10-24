/**
 * Signing in and out in a real browser against the real server (tests/e2e-real/auth-server.ts):
 * Chromium keeps the cookies, so `SameSite` applies as in production. The user continues
 * on Google's page (the stand-in on localhost, another site: the app is on 127.0.0.1), so
 * the callback is a top-level navigation started by another site, as it is with Google.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const APP = `http://127.0.0.1:${Number(process.env.E2E_AUTH_PORT) || 5182}`;
const GOOGLE = `http://localhost:${Number(process.env.E2E_GOOGLE_PORT) || 5183}`;
const SIGN_IN = { provider: 'google', callbackURL: '/', newUserCallbackURL: '/?welcome=1', errorCallbackURL: '/?signin=failed', disableRedirect: true };

/** The tests share the server's switches: one at a time. */
test.describe.configure({ mode: 'serial' });

interface Answer {
  status: number;
  json: { url?: string; error?: string; signedIn?: boolean } | null;
}

/** A fetch from the page (same origin, this browser's cookies). */
async function call(page: Page, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  const answer = await page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as unknown };
    },
    { method, path, body },
  );
  return answer as Answer;
}

async function control(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<unknown> {
  const r = method === 'GET' ? await request.get(`${GOOGLE}${path}`) : await request.post(`${GOOGLE}${path}`, { data: data ?? {} });
  expect(r.ok(), `${method} ${path}`).toBe(true);
  return r.json();
}

/** Google, for `user`: the browser goes there (another site), the user continues, and it is back at the callback. */
async function viaGoogle(page: Page, authorizationUrl: string, user: string): Promise<string> {
  const query = new URL(authorizationUrl).search;
  await page.goto(`${GOOGLE}/o/oauth2/v2/auth${query}&e2e_user=${user}`);
  await Promise.all([page.waitForURL((u) => u.origin === APP && !u.pathname.startsWith('/api/auth/')), page.click('#continue')]);
  return page.url();
}

test('a sign-in answered after a sign-out the server cannot finish gets no session at Google’s callback (gate t22 r2 finding 2)', async ({ browser, request }) => {
  // The API's pages forbid scripts (CSP); the test drives the API from one of them.
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  try {
    await page.goto(`${APP}/api/account`);
    // Signed in, as usual.
    const first = await call(page, 'POST', '/api/auth/sign-in/social', SIGN_IN);
    expect(first.status).toBe(200);
    expect(await viaGoogle(page, first.json!.url!, 'first')).toBe(`${APP}/?welcome=1`);
    expect((await call(page, 'GET', '/api/account')).json).toMatchObject({ signedIn: true });
    expect(await control(request, 'GET', '/control/sessions')).toEqual({ n: 1 });

    // A sign-in starts, and its answer is held after the server has handled it...
    await control(request, 'POST', '/control/hold-sign-in');
    const started = call(page, 'POST', '/api/auth/sign-in/social', SIGN_IN);
    await expect.poll(() => control(request, 'GET', '/control/held')).toEqual({ held: 1 });
    // ...while the user signs out and the database cannot end the session.
    await control(request, 'POST', '/control/deletions', { failing: true });
    expect(await call(page, 'POST', '/api/auth/sign-out', {})).toMatchObject({ status: 503, json: { error: 'sign_out_pending' } });
    // The sign-in's answer arrives now and sets its OAuth state cookie again.
    await control(request, 'POST', '/control/release-sign-in');
    const second = await started;
    expect(second.status).toBe(200);

    // Google sends the browser back: the callback sees the pending sign-out and issues no session.
    expect(await viaGoogle(page, second.json!.url!, 'second')).toBe(`${APP}/account?signin=failed&error=sign_out_pending`);
    expect(await control(request, 'GET', '/control/sessions')).toEqual({ n: 1 });
    expect((await call(page, 'GET', '/api/account')).json).toEqual({ signedIn: false });

    // Once the database works again, this browser's next account read ends the old session.
    await control(request, 'POST', '/control/deletions', { failing: false });
    expect((await call(page, 'GET', '/api/account')).json).toEqual({ signedIn: false });
    expect(await control(request, 'GET', '/control/sessions')).toEqual({ n: 0 });
  } finally {
    await control(request, 'POST', '/control/deletions', { failing: false });
    await control(request, 'POST', '/control/release-sign-in');
    await context.close();
  }
});
