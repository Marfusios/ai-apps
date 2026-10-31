/**
 * The admin page (UI_DESIGN §4.12, Task 25) against the real server: the live-configuration app of
 * tests/e2e-real/server.ts, with Google sign-in through the stand-in of tests/e2e-real/auth-server.ts
 * and `AIRCASE_ADMIN_EMAILS` naming the stand-in's `e2e-admin@example.com`. The browser signs in as a
 * person would: "Sign in", "Continue with Google", and Google's page, which the test sends to the
 * stand-in (`e2e_user` picks the account), where the user continues and comes back signed in.
 *
 * Covered: the admin sees "Admin" in the header and opens `/admin`, whose four sections come from
 * the server's own overview: the signed-in account in Users, the dataset's generation and snapshot,
 * the ranking in plain words and "Next import: Not set up yet". Another account, not an admin, sees
 * no Admin link, the ordinary not-found page at `/admin` and a 404 from `/api/admin/overview`, and so
 * does a visitor who is not signed in. Signing in adds sessions that tests/e2e-real/sign-in-out.spec.ts
 * would count, so these tests run after the others (playwright.real.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { AdminOverviewSchema } from '../../shared/contracts/admin.js';
import { formatDate } from '../../shared/format.js';
import { E2E_ADMIN_EMAIL } from './evidence-fakes.js';
import { unexpected, watchPage } from './watch.js';

/** The live-configuration app (tests/e2e-real/server.ts) and the stand-in for Google. */
const LIVE = `http://127.0.0.1:${Number(process.env.E2E_REAL_LIVE_PORT) || (Number(process.env.E2E_REAL_PORT) || 5181) + 4}`;
const GOOGLE = `http://localhost:${Number(process.env.E2E_GOOGLE_PORT) || 5183}`;
const NOT_FOUND = 'There is no page here.';

/** The tests sign in on one app: one at a time. */
test.describe.configure({ mode: 'serial' });

/** Every test's page: Google's page is the stand-in; any other request that would leave the machine is refused, and fails the test. */
const outside = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const refused: string[] = [];
  outside.set(page, refused);
  await page.route(
    (url) => url.protocol !== 'data:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => {
      refused.push(route.request().url());
      return route.abort();
    },
  );
});
test.afterEach(async ({ page }) => {
  expect(outside.get(page), 'requests that would leave the machine').toEqual([]);
});

/**
 * Signs in on the live app as the stand-in's `user` (`e2e-<user>@example.com`): Sign in, Continue
 * with Google, Google's page (the stand-in, another site), Continue; back on Home, signed in.
 */
async function signIn(page: Page, user: string): Promise<void> {
  // Google's own page is the stand-in's, for the account `user`.
  await page.route('https://accounts.google.com/o/oauth2/v2/auth**', (route) =>
    route.fulfill({ status: 302, headers: { location: `${GOOGLE}/o/oauth2/v2/auth${new URL(route.request().url()).search}&e2e_user=${user}` } }),
  );
  await page.goto(`${LIVE}/`);
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('dialog', { name: 'Sign in to AirCase' }).getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL((url) => url.origin === GOOGLE);
  await Promise.all([page.waitForURL((url) => url.origin === LIVE && !url.pathname.startsWith('/api/auth/')), page.click('#continue')]);
  // A new account comes back to `/?welcome=1` and is welcomed once.
  if (new URL(page.url()).searchParams.get('welcome') === '1') {
    const welcome = page.getByRole('dialog', { name: 'Welcome aboard.' });
    await welcome.getByRole('button', { name: 'Continue' }).click();
    await expect(welcome).toBeHidden();
  }
  await expect(page.getByRole('banner').getByRole('link', { name: 'Account' })).toBeVisible();
}

test('an admin signs in, sees Admin in the header and reads the overview the server builds: users, usage, costs and the system', async ({ page }) => {
  const problems = await watchPage(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, 'admin');
  // The account says so; the server's overview is the admin's to read.
  expect(await (await page.request.get(`${LIVE}/api/account`)).json()).toMatchObject({ signedIn: true, user: { email: E2E_ADMIN_EMAIL }, isAdmin: true });
  const answer = await page.request.get(`${LIVE}/api/admin/overview`);
  expect(answer.status()).toBe(200);
  expect(answer.headers()['cache-control']).toContain('no-store');
  const overview = AdminOverviewSchema.parse(await answer.json());
  expect(overview.users.list.some((u) => u.email === E2E_ADMIN_EMAIL && u.isAdmin)).toBe(true);
  const dataset = overview.system.dataset;
  expect(dataset).not.toBeNull();

  // From the header to the page.
  await page.getByRole('banner').getByRole('link', { name: 'Admin' }).click();
  await expect(page).toHaveURL(`${LIVE}/admin`);
  await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
  await expect(page).toHaveTitle('Admin · AirCase');
  for (const section of ['Users', 'Usage', 'Costs', 'System']) await expect(page.getByRole('region', { name: section })).toBeVisible();

  // Opened directly, as a crawler would: the server sends a path it does not know (404, noindex)
  // with no admin data in it, and the client shows the page to the admin; nothing says index.
  const direct = await page.goto(`${LIVE}/admin`);
  expect(direct?.status()).toBe(404);
  expect(await direct?.text()).not.toContain(E2E_ADMIN_EMAIL);
  await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content="noindex, nofollow"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]:not([content*="noindex"])')).toHaveCount(0);
  for (const section of ['Users', 'Usage', 'Costs', 'System']) await expect(page.getByRole('region', { name: section })).toBeVisible();

  // Users: the signed-in account, its name and e-mail, tagged Admin.
  const users = page.getByRole('region', { name: 'Users' });
  const row = users.getByRole('table', { name: 'Accounts, most recently active first' }).getByRole('row').filter({ hasText: E2E_ADMIN_EMAIL });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('rowheader')).toHaveText('E2E adminAdmin');
  await expect(users.locator('[data-stat="Accounts"] dd')).toHaveText(String(overview.users.total));

  // System: the dataset's generation and snapshot, the ranking in plain words, no automatic import yet.
  const system = page.getByRole('region', { name: 'System' });
  const fact = (label: string) => system.locator(`[data-fact="${label}"] dd`);
  await expect(fact('Generation')).toHaveText(String(dataset?.generationId));
  await expect(fact('NTSB snapshot')).toHaveText(formatDate(dataset?.snapshotDate ?? null));
  await expect(fact('Ranking')).toHaveText('The question as asked; AI reranks the top 50er-q-h50-v1');
  await expect(fact('Automatic filters')).toHaveText('None: every filter AI suggests stays a suggestionnone');
  await expect(fact('Next import')).toHaveText('Not set up yet');
  await expect(fact('Environment')).toHaveText('Dev');

  // Usage and costs come from the same overview: the 30-day chart's rows and the four budgets.
  await expect(page.getByRole('region', { name: 'Usage' }).locator('[data-usage-row]')).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'Costs' }).getByRole('meter')).toHaveCount(4);
  // The server serves `/admin` as a path it does not know (404, noindex); the page is the client's.
  expect(unexpected(problems, ['/admin'])).toEqual([]);
});

test('an account that is not an admin sees no Admin link, the not-found page at /admin and a 404 from the overview; so does a visitor who is not signed in', async ({ page, browser }) => {
  const problems = await watchPage(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, 'pilot');
  const account = await (await page.request.get(`${LIVE}/api/account`)).json();
  expect(account).toMatchObject({ signedIn: true, user: { email: 'e2e-pilot@example.com' } });
  expect(account).not.toHaveProperty('isAdmin');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await page.goto(`${LIVE}/admin`);
  await expect(page.getByRole('heading', { level: 1, name: NOT_FOUND })).toBeVisible();
  await expect(page).toHaveTitle('Page not found · AirCase');
  expect((await page.request.get(`${LIVE}/api/admin/overview`)).status()).toBe(404);
  expect(unexpected(problems, ['/admin'])).toEqual([]);

  // Not signed in: a browser of its own.
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    const seen = await watchPage(visitor);
    await visitor.goto(`${LIVE}/admin`);
    await expect(visitor.getByRole('heading', { level: 1, name: NOT_FOUND })).toBeVisible();
    await expect(visitor.getByRole('banner').getByRole('link', { name: 'Admin' })).toHaveCount(0);
    expect(await (await visitor.request.get(`${LIVE}/api/account`)).json()).toEqual({ signedIn: false });
    expect((await visitor.request.get(`${LIVE}/api/admin/overview`)).status()).toBe(404);
    expect(unexpected(seen, ['/admin'])).toEqual([]);
  } finally {
    await context.close();
  }
});
