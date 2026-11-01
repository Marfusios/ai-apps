import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The admin page (UI_DESIGN §4.12, Task 25) against the mock API, on a desktop by day and a phone
 * at night: the mock's signed-in account is an admin (session storage `casebook-mock-admin`), so
 * the header links "Admin" (the phone menu too), and `/admin` shows users, usage, costs and the
 * system from the mock's synthetic overview, readable at phone width without sideways scrolling;
 * for an account that is not an admin, and when signed out, `/admin` is the ordinary "not found"
 * page. Task 26: the System section's "Automatic import" in each of the mock importer's states
 * (session storage `casebook-mock-admin-imports`), the stop for review first.
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the page there.
 */

type Theme = 'day' | 'night';

const FAKE_TURNSTILE = `
window.turnstile = {
  render(host, params) { setTimeout(() => params.callback('XXXX.DUMMY.TOKEN.XXXX'), 50); return 'w1'; },
  remove() {},
};
`;

/** Signed in as the mock's account (an admin unless `admin: false`), at a width and theme. */
async function signIn(page: Page, { width, theme, admin = true }: { width: number; theme: Theme; admin?: boolean }): Promise<void> {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  await page.addInitScript(FAKE_TURNSTILE);
  await page.addInitScript(`localStorage.setItem('casebook-theme', '${theme}');
    // Signed in on the first load; a sign-out the test makes is kept across its reloads.
    if (!sessionStorage.getItem('casebook-mock-account')) sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
    sessionStorage.setItem('casebook-mock-evidence', JSON.stringify({ ranking: 'er-q-h50-v1', autoFilters: 'none' }));
    ${admin ? "sessionStorage.setItem('casebook-mock-admin', '1');" : ''}`);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function fitsTheWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Screenshots under `E2E_SCREENSHOTS`, when set: the whole page, and on a phone also in parts a reader can look at. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  const { width, height } = await page.evaluate<{ width: number; height: number }>('({ width: window.innerWidth, height: document.documentElement.scrollHeight })');
  if (width >= 640) return;
  for (let y = 0, n = 1; y < height; y += 1600, n++) {
    await page.screenshot({ path: join(dir, `${name}-part${n}.png`), fullPage: true, clip: { x: 0, y, width, height: Math.min(1600, height - y) } });
  }
}

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`an admin reaches the admin page from the header and reads users, usage, costs and the system (${width}px, ${theme})`, async ({ page }) => {
    await signIn(page, { width, theme });
    const banner = page.getByRole('banner');
    if (width < 640) await banner.getByRole('button', { name: 'Menu' }).click();
    await banner.getByRole('link', { name: 'Admin' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    await expect(page).toHaveTitle('Admin · AirCase');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    await expect(page.locator('[data-as-of]')).toContainText('Times are in your time zone, ');

    // Users: on a desktop a table, on a phone a list of blocks.
    const users = page.getByRole('region', { name: 'Users' });
    await expect(users.locator('[data-stat="Accounts"] dd')).toHaveText('37');
    if (width >= 640) {
      await expect(users.getByRole('table', { name: 'Accounts, most recently active first' })).toBeVisible();
      await expect(users.locator('[data-users-list]')).toBeHidden();
    } else {
      await expect(users.getByRole('list', { name: 'Accounts, most recently active first' })).toBeVisible();
      await expect(users.locator('[data-users-table]')).toBeHidden();
    }
    // (both layouts are in the page; the one for this width shows)
    await expect(users.getByText('Alex Example').filter({ visible: true })).toHaveCount(1);

    // Usage: the chart's four rows, a day read with the keyboard, the figures as a table, the ratings.
    const usage = page.getByRole('region', { name: 'Usage' });
    await expect(usage.locator('[data-usage-row]')).toHaveCount(4);
    const plot = usage.getByRole('group', { name: /^AI searches per UTC day, last 30 days/ });
    await plot.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(usage.locator('[data-usage-tooltip]')).toContainText('so far');
    await page.keyboard.press('ArrowLeft');
    await expect(usage.locator('[data-usage-tooltip]')).not.toContainText('so far');
    await usage.getByRole('button', { name: 'Show the figures' }).click();
    await expect(usage.getByRole('table', { name: 'AI searches per UTC day, last 30 days' })).toBeVisible();
    await expect(usage.getByRole('table', { name: 'Search ratings' })).toContainText('Rated useful');

    // Costs: the budgets as meters; System: the ranking in words, and the importer's daily schedule.
    const costs = page.getByRole('region', { name: 'Costs' });
    await expect(costs.getByRole('meter')).toHaveCount(4);
    const system = page.getByRole('region', { name: 'System' });
    await expect(system.locator('[data-fact="Ranking"] dd')).toContainText('The question as asked; AI reranks the top 50');
    await expect(system.locator('[data-fact="Schedule"] dd')).toHaveText('Daily at 05:30, Europe/Prague');
    await fitsTheWidth(page);
    await usage.getByRole('button', { name: 'Hide the figures' }).click();
    await page.evaluate('document.activeElement && document.activeElement.blur()');
    await page.evaluate('window.scrollTo(0, 0)');
    await shot(page, `admin-${width}-${theme}`);
  });
}

/** Each state of the mock importer (web/mock/imports.ts): what its block must say first. */
const IMPORT_STATES = [
  ['needs_review', 'Import needs a review'],
  ['overdue', 'The daily snapshot check is overdue'],
  ['healthy', 'No new file (NTSB still lists the 16 Oct 2026 file)'],
  ['published', 'Imported generation 8'],
  ['disabled', 'Off'],
] as const;

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`the automatic import, state by state: a stop for review first, then the facts and the recent runs (${width}px, ${theme})`, async ({ page }) => {
    await signIn(page, { width, theme });
    for (const [state, first] of IMPORT_STATES) {
      await page.evaluate(`sessionStorage.setItem('casebook-mock-admin-imports', '${state}')`);
      await page.goto('/admin');
      const system = page.getByRole('region', { name: 'System' });
      const block = system.locator('[data-imports]');
      await expect(block).toContainText(first);
      const notices = block.locator('[data-import-notice]');
      const pointer = page.locator('[data-import-pointer]');
      if (state === 'needs_review') {
        // At the head of the page a line says so; in the block, attention comes first, with the reason in words and the way to resolve it.
        await expect(pointer).toHaveText('The automatic import needs a review.');
        await expect(notices).toHaveCount(1);
        await expect(block.locator(':scope > *').first()).toHaveAttribute('data-import-notice', 'attention');
        await expect(notices.first()).toContainText('the new file differs from the current data by more than the automatic limits allow');
        await expect(notices.first()).toContainText('pnpm importer approve, rebaseline or rollback');
      } else if (state === 'overdue') {
        await expect(pointer).toHaveText('The daily snapshot check is overdue.');
        await expect(notices).toHaveCount(1);
        await expect(notices.first()).toContainText('It has not succeeded for over 36 hours.');
      } else {
        await expect(pointer).toHaveCount(0);
        await expect(notices).toHaveCount(0);
      }
      // The runs: a table on a desktop, blocks on a phone; none while nothing has run.
      const table = block.getByRole('table', { name: 'Recent import runs, newest first' });
      const list = block.getByRole('list', { name: 'Recent import runs, newest first' });
      if (state === 'disabled') {
        await expect(block).toContainText('No runs yet.');
      } else if (width >= 640) {
        await expect(table).toBeVisible();
        await expect(list).toBeHidden();
      } else {
        await expect(list).toBeVisible();
        await expect(table).toBeHidden();
      }
      // No identifier with an underscore shows outside the secondary code lines.
      const words = String(
        await block.evaluate('(el) => { const copy = el.cloneNode(true); for (const code of copy.querySelectorAll("[data-code]")) code.remove(); return copy.textContent || ""; }'),
      );
      expect(words).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      await fitsTheWidth(page);
      await block.scrollIntoViewIfNeeded();
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await blockShot(page, block, `admin-imports-${state}-${width}-${theme}`);
    }
    // The line at the head of the page takes the reader to the notice, at the foot of the page.
    await page.evaluate("sessionStorage.setItem('casebook-mock-admin-imports', 'needs_review')");
    await page.goto('/admin');
    await expect(page.locator('[data-import-pointer]')).toBeVisible();
    await expect(page.getByRole('region', { name: 'System' }).locator('[data-imports]')).toBeVisible();
    await page.evaluate('window.scrollTo(0, 0)');
    await shot(page, `admin-imports-page-${width}-${theme}`);
    await page.locator('[data-import-pointer]').getByRole('link', { name: 'The automatic import needs a review.' }).click();
    const notice = page.getByRole('region', { name: 'System' }).locator('[data-import-notice="attention"]');
    await expect(notice).toBeFocused();
    await expect(notice).toBeInViewport();
  });
}

/** A screenshot of one block, under `E2E_SCREENSHOTS` when set. */
async function blockShot(page: Page, block: ReturnType<Page['locator']>, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await block.screenshot({ path: join(dir, `${name}.png`) });
}

test('on a 640px tablet an admin’s three links leave the AI counter whole', async ({ page }) => {
  await signIn(page, { width: 640, theme: 'day' });
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('link', { name: 'Admin' })).toBeVisible();
  await expect(banner.getByText('AI left today:')).toBeVisible();
  await page.evaluate('document.fonts.ready');
  const cut = await page.locator('header .truncate').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(cut).toBe(0);
  await fitsTheWidth(page);
});

test('for an account that is not an admin, and when signed out, /admin is the ordinary “not found” page with no Admin link', async ({ page }) => {
  await signIn(page, { width: 1280, theme: 'day', admin: false });
  await expect(page.getByRole('banner').getByRole('link', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'There is no page here.' })).toBeVisible();
  await expect(page).toHaveTitle('Page not found · AirCase');
  const reads = await page.evaluate<number>(`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/admin/')).length`);
  expect(reads).toBe(0);
  await shot(page, 'admin-not-found-1280-day');

  await page.getByRole('banner').getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signOut).toBeVisible();
  await signOut.click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Sign in' })).toBeVisible();
  // Reloaded signed out: the sign-out is kept in this tab's session storage.
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'There is no page here.' })).toBeVisible();
});
