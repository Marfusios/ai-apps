import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_TURNSTILE } from './fake-turnstile.js';

/**
 * The search checklist and search ratings (UI_DESIGN §4.10, §4.11; Task 25) against the mock API,
 * on a desktop by day and a phone at night: the mock stands in for what live runs (the question
 * alone, AI reranking the top 50: session storage `casebook-mock-evidence`) and times the stages as
 * live does (`casebook-mock-evidence-timing` 1: the question about 1.5 s, the search 1.7 s, the
 * order 2.7 s). While the search runs the card shows where the visitor waited, unticked until the
 * server has registered the search, then each row ticking in turn; the results then ask "Was this
 * search useful?". An edit's card skips the question; reduced motion stills the ticks; a rating
 * that does not save says so, with Try again; neither prints. Cloudflare's Turnstile is a local
 * stand-in (tests/e2e/fake-turnstile.ts).
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the states there.
 */

const HEADING = 'Investigations retrieved for your search';
const CARB = 'Carb icing on approach';
const LIVE = { ranking: 'er-q-h50-v1', autoFilters: 'none' };

type Theme = 'day' | 'night';

/** Opens Home at a width and theme, the mock standing in for live with its stage times scaled by `timing`. */
async function open(page: Page, { width, theme, timing = 1 }: { width: number; theme: Theme; timing?: number }): Promise<void> {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  await page.addInitScript(FAKE_TURNSTILE);
  await page.addInitScript(`localStorage.setItem('casebook-theme', '${theme}');
    window.__checkDelay = 60;
    sessionStorage.setItem('casebook-mock-evidence', ${JSON.stringify(JSON.stringify(LIVE))});
    sessionStorage.setItem('casebook-mock-evidence-timing', '${timing}');`);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** No sideways scrolling: the page is never wider than the viewport. */
async function fitsTheWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A screenshot under `E2E_SCREENSHOTS`, when set. */
async function shot(page: Page, name: string, { fullPage = false } = {}): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage });
}

const card = (page: Page) => page.getByRole('region', { name: 'Search checklist' });
const row = (page: Page, id: 'question' | 'search' | 'order') => card(page).locator(`[data-row="${id}"]`);

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`while an AI search runs, its checklist ticks each stage where the visitor waits; then the results ask for a rating (${width}px, ${theme})`, async ({ page }) => {
    await open(page, { width, theme });
    await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(CARB);
    await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();

    // The card, under the question box: the ink title bar, three rows, the note.
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Search checklist');
    await expect(card(page)).toContainText('AirCase shows NTSB investigations; nothing is written by AI. Usually 5–10 seconds.');
    await expect(card(page).getByRole('listitem')).toHaveCount(3);
    await expect(row(page, 'search').locator('[data-challenge]')).toHaveText('Search 21 investigations');
    const below = await page.evaluate<boolean>(`(() => {
      const box = document.querySelector('form[role="search"]');
      const card = document.querySelector('[data-search-checklist]');
      return Boolean(box.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`);
    expect(below).toBe(true);

    // The question under way: washed, its result in magenta.
    await expect(row(page, 'question')).toHaveAttribute('data-state', 'current');
    await expect(row(page, 'question').locator('[data-result]')).toHaveText('IN PROGRESS');
    await expect(row(page, 'order')).toHaveAttribute('data-state', 'todo');
    await fitsTheWidth(page);
    await shot(page, `checklist-question-${width}-${theme}`);

    // Then the search, with the question's result ticked.
    await expect(row(page, 'question').locator('[data-result]')).toHaveText('READ · SUGGESTIONS READY');
    await expect(row(page, 'question').locator('[data-tick]')).toBeVisible();
    await expect(row(page, 'search')).toHaveAttribute('data-state', 'current');
    await expect(card(page).locator('[data-checklist-live]')).toHaveText('Question read: suggestions ready.');
    await shot(page, `checklist-search-${width}-${theme}`);

    // Then AI ordering the leading results.
    await expect(row(page, 'search').locator('[data-result]')).toHaveText('21 CASES');
    await expect(row(page, 'order')).toHaveAttribute('data-state', 'current');
    await expect(card(page).locator('[data-checklist-live]')).toHaveText('Search done: 21 cases.');
    const timer = await card(page).locator('[data-checklist-timer]').textContent();
    expect(timer).toMatch(/^0:0[2-9]$/);
    await fitsTheWidth(page);
    await shot(page, `checklist-order-${width}-${theme}`);

    // The results open; the card is gone.
    await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('[data-count-line]')).toHaveText('21 retrieved · leading results ordered by AI for relevance · not every matching investigation');

    // Was this search useful?
    const rating = page.locator('[data-search-rating]');
    await rating.scrollIntoViewIfNeeded();
    await expect(rating.getByRole('group', { name: 'Was this search useful?' })).toBeVisible();
    const useful = rating.getByRole('button', { name: 'Useful', exact: true });
    const notUseful = rating.getByRole('button', { name: 'Not useful', exact: true });
    await expect(useful).toHaveAttribute('aria-pressed', 'false');
    await shot(page, `rating-${width}-${theme}`);
    await useful.click();
    await expect(rating.locator('[data-rating-status]')).toHaveText('Thanks — noted.');
    await expect(useful).toHaveAttribute('aria-pressed', 'true');
    await fitsTheWidth(page);
    await shot(page, `rating-noted-${width}-${theme}`);
    await notUseful.click();
    await expect(notUseful).toHaveAttribute('aria-pressed', 'true');
    await expect(useful).toHaveAttribute('aria-pressed', 'false');
    const bodies = await page.evaluate<string[]>(`window.__reads.filter((r) => r.method === 'POST' && r.path.endsWith('/feedback')).map((r) => r.body)`);
    expect(bodies.map((b) => JSON.parse(b))).toEqual([{ rating: 'useful' }, { rating: 'not_useful' }]);

    // Neither prints.
    await page.emulateMedia({ media: 'print' });
    await expect(rating).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
  });
}

test('an edit’s checklist skips the question; every read used the POST’s own key', async ({ page }) => {
  await open(page, { width: 1280, theme: 'night', timing: 0.6 });
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(CARB);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  await yours.getByRole('button', { name: 'Use your own words' }).click();
  await yours.getByRole('textbox', { name: 'Search words' }).fill('carburetor ice');
  await yours.getByRole('textbox', { name: 'Search words' }).press('Enter');
  await yours.getByRole('button', { name: 'Search again · uses 1' }).click();
  await expect(card(page)).toBeVisible();
  await expect(row(page, 'question').locator('[data-result]')).toHaveText('SKIPPED · YOUR EDIT');
  await expect(row(page, 'question')).toHaveAttribute('data-state', 'skipped');
  await expect(row(page, 'search')).toHaveAttribute('data-state', 'current');
  await shot(page, 'checklist-edit-1280-night');
  // Without reduced motion a row's ✓ ticks in over 180ms.
  await expect(row(page, 'search').locator('[data-tick]')).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-row="search"] [data-tick]')).animationDuration`)).toBe('0.18s');
  await expect(page.getByRole('region', { name: 'Your edited search', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(card(page)).toHaveCount(0);
  const keys = await page.evaluate<{ posts: string[]; reads: string[] }>(`({
    posts: window.__reads.filter((r) => r.method === 'POST' && r.path === '/api/evidence').map((r) => JSON.parse(r.body).idempotencyKey),
    reads: [...new Set(window.__reads.filter((r) => r.path.startsWith('/api/evidence/progress/')).map((r) => r.path.split('/').pop()))],
  })`);
  expect(keys.posts).toHaveLength(2);
  expect(keys.reads).toEqual(keys.posts);
});

test('with reduced motion the ticks appear at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, { width: 1280, theme: 'day', timing: 0.6 });
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(CARB);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  const tick = row(page, 'question').locator('[data-tick]');
  await expect(tick).toBeVisible();
  const duration = await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-row="question"] [data-tick]')).animationDuration`);
  expect(parseFloat(duration)).toBeLessThan(0.001);
});

test('a rating that does not save says so plainly, and Try again sends it again', async ({ page }) => {
  await open(page, { width: 390, theme: 'day', timing: 0 });
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill('Engine power loss, rating fails');
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible({ timeout: 15_000 });
  const rating = page.locator('[data-search-rating]');
  await rating.getByRole('button', { name: 'Useful', exact: true }).click();
  await expect(rating.locator('[data-rating-status]')).toHaveText('Your rating didn’t save.');
  await shot(page, 'rating-failed-390-day');
  await rating.getByRole('button', { name: 'Try again' }).click();
  await expect(rating.locator('[data-rating-status]')).toHaveText('Thanks — noted.');
  await expect(rating.getByRole('button', { name: 'Useful', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await fitsTheWidth(page);
});
