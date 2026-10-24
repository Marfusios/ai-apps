import { expect, test, type Page } from '@playwright/test';
import { FAKE_TURNSTILE, TEST_SITE_KEY } from './fake-turnstile.js';

/**
 * The AI evidence view (UI_DESIGN §4.9; contract `evidence.v2`, the advisory-only design)
 * against the mock API (web/mock/evidence.ts), on a desktop and a phone, by day and at night:
 * Ask AI, what was searched and the AI's suggestion beside it, not applied, the heading and
 * notice on every surface, cards with marked whole paragraphs, the full section, free paging,
 * applying the suggestion and the reader's own edits, the hints, the drawer, Compare, print,
 * and a gone search. Cloudflare's Turnstile is a local stand-in (tests/e2e/fake-turnstile.ts).
 */

const HEADING = 'Investigations retrieved for your search';
const NOTICE = 'AirCase matched your words and filters. It has not checked timing, causes or things that did not happen: read the excerpts.';
const CARB = 'Carb icing on approach';
const SEED = 'Engine power loss shortly after maintenance';
const SUGGESTION = 'Suggested filters and terms — not applied';

type Theme = 'day' | 'night';

/** Opens Home at a width and theme; the stand-in check passes after `checkDelay` ms. */
async function open(page: Page, { width, theme, checkDelay = 60 }: { width: number; theme: Theme; checkDelay?: number }): Promise<void> {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  await page.addInitScript(`localStorage.setItem('casebook-theme', '${theme}')`);
  await page.addInitScript(`window.__checkDelay = ${checkDelay};`);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(question);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible();
}

/** No sideways scrolling: the page is never wider than the viewport. */
async function fitsTheWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(0);
}

const posts = (page: Page, path: string) => page.evaluate<number>(`window.__reads.filter((r) => r.method === 'POST' && r.path === ${JSON.stringify(path)}).length`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_TURNSTILE);
});

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`Ask AI shows what the search retrieved, in NTSB words, with the notice on every surface (${width}px, ${theme})`, async ({ page }) => {
    await open(page, { width, theme, checkDelay: 1_500 });
    await expect(page.getByRole('banner').getByText(width < 640 ? 'AI left 10 of 10' : 'AI searches left: 10 of 10')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(CARB);
    await page.getByRole('button', { name: 'Ask AI · 10 free' }).click();
    const check = page.getByRole('dialog', { name: 'Quick check before your first AI search' });
    await expect(check).toContainText('Up to ten free AI searches a day, subject to daily availability.');
    await expect(check.getByText('Verifying…')).toBeVisible();
    await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/);
    const renders = await page.evaluate<unknown[]>('window.__turnstile.renders');
    expect(renders).toEqual([{ sitekey: TEST_SITE_KEY, action: 'ask-ai', appearance: 'always', theme: theme === 'night' ? 'dark' : 'light' }]);
    await expect(page.getByRole('banner').getByText(width < 640 ? 'AI left 9 of 10' : 'AI searches left: 9 of 10')).toBeVisible();

    // The question as asked is what was searched; the AI's suggestion stands beside it, not applied.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(CARB);
    const yours = page.getByRole('region', { name: 'Your search', exact: true });
    await expect(yours).toContainText('Your question, as asked');
    const suggestion = page.getByRole('region', { name: SUGGESTION });
    await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
    await expect(suggestion).toContainText('“carb icing”');
    await expect(suggestion.getByRole('button', { name: /^Apply these filters\s*·\s*uses 1$/ })).toBeVisible();
    await expect(suggestion.getByRole('button', { name: /^Apply filters and terms\s*·\s*uses 1$/ })).toBeVisible();
    // The heading, the notice, the count that never claims every match: the question's results, unfiltered.
    await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible();
    await expect(page.getByRole('note').first()).toHaveText(NOTICE);
    await expect(page.locator('[data-count-line]')).toHaveText('21 retrieved · best match first · not every matching investigation');
    // (its text holds the screen-reader words "; dotted:" between the two marks)
    await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: the suggested terms · .*their synonyms$/);
    await fitsTheWidth(page);

    // A card: whole paragraphs, literal and synonym matches told apart by line and fill.
    const card = page.locator('article[data-card]').filter({ has: page.locator('mark.hit') }).filter({ has: page.locator('mark.hit-synonym') }).first();
    await expect(card.locator('mark.hit').first()).toBeVisible();
    await expect(card.locator('mark.hit-synonym').first()).toBeVisible();
    const ntsbNo = (await card.getAttribute('data-card')) as string;
    const rank = (await card.getAttribute('data-rank')) as string;
    const lines = await page.evaluate<{ literal: string[]; synonym: string[] }>(`(() => {
      const card = document.querySelector('article[data-card="${ntsbNo}"]');
      const literal = getComputedStyle(card.querySelector('mark.hit'));
      const synonym = getComputedStyle(card.querySelector('mark.hit-synonym'));
      return { literal: [literal.borderBottomStyle, literal.backgroundColor], synonym: [synonym.borderBottomStyle, synonym.backgroundColor] };
    })()`);
    expect(lines.literal[0]).toBe('solid');
    expect(lines.synonym[0]).toBe('dotted');
    expect(lines.synonym[1]).toBe('rgba(0, 0, 0, 0)');
    expect(lines.literal[1]).not.toBe('rgba(0, 0, 0, 0)');
    // Occurrences of the suggested terms, said as suggested; no filter claimed.
    await expect(card.locator('[data-relevance]')).toHaveText(/^How it was found:\s*Suggested terms in these excerpts: .+ · found by .+ search$/);

    // The full section, at the excerpt's paragraph, marked and in view.
    await card.getByRole('button', { name: 'Show the full analysis section' }).click();
    const marked = card.locator('[data-excerpt-paragraph]');
    await expect(marked).toBeFocused();
    await expect(marked).toBeInViewport();
    await card.getByRole('button', { name: 'Show the excerpt only' }).click();
    await expect(marked).toHaveCount(0);

    // The drawer: the same projection under the heading and notice.
    await card.getByRole('link', { name: ntsbNo, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(`^${ntsbNo}: `) });
    await expect(drawer).toBeVisible();
    const section = drawer.getByRole('region', { name: HEADING });
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole('note')).toHaveText(NOTICE);
    await expect(drawer.getByText(`${rank} of 21`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(card.getByRole('link', { name: ntsbNo, exact: true })).toBeFocused();

    // Compare two of them: the heading, the notice, each strip's evidence row.
    // (the ticks live in the URL, so a box shows its tick once the router has moved: click, then expect)
    for (const n of [0, 1]) {
      const box = page.locator('article[data-card]').nth(n).getByRole('checkbox');
      await box.click();
      await expect(box).toBeChecked();
    }
    await page.getByRole('complementary', { name: 'Compare tray' }).getByRole('link', { name: 'Compare →' }).click();
    await expect(page).toHaveURL(/\/compare\?cases=[A-Z0-9]+,[A-Z0-9]+&evidence=[0-9a-f-]{36}&pages=1$/);
    const top = page.locator('[data-compare-evidence]');
    await expect(top).toContainText(`From your search “${CARB}”`);
    await expect(top.getByRole('note')).toHaveText(NOTICE);
    await expect(page.locator('[data-strip-evidence]')).toHaveCount(2);
    await fitsTheWidth(page);

    // Print: the notice and the rows print; nothing to click does.
    await page.emulateMedia({ media: 'print' });
    await expect(top.getByRole('note')).toBeVisible();
    await expect(page.locator('[data-strip-evidence]').first()).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
  });
}

test('Show more pages the pinned ranking for free, with the total; the reader’s own words make an edited search that says it uses one', async ({ page }) => {
  await open(page, { width: 1280, theme: 'day' });
  await ask(page, SEED);
  await expect(page.locator('article[data-card]')).toHaveCount(10);
  const more = page.getByRole('navigation', { name: 'More investigations' });
  await expect(more).toContainText('Showing 1–10 of 21');
  await more.getByRole('button', { name: /^Show 10 more/ }).click();
  await expect(page.locator('article[data-card]')).toHaveCount(20);
  await expect(page).toHaveURL(/\?pages=2$/);
  await expect(page.locator('article[data-rank="11"] [data-case-trigger]')).toBeFocused();
  await more.getByRole('button', { name: /^Show 1 more/ }).click();
  await expect(more).toHaveText('That’s all 21 retrieved.');
  // Paging asked the AI nothing: the one POST is the search itself.
  expect(await posts(page, '/api/evidence')).toBe(1);

  // The reader's own words: free until Search again, which says it uses one AI search.
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  await yours.getByRole('button', { name: 'Use your own words' }).click();
  await yours.getByRole('textbox', { name: 'Search words' }).fill('engine power loss');
  await yours.getByRole('textbox', { name: 'Search words' }).press('Enter');
  await expect(yours.getByRole('link', { name: /^Show keyword results/ })).toHaveAttribute('href', '/explore?q=engine+power+loss');
  await yours.getByRole('button', { name: 'Search again · uses 1' }).click();
  const edited = page.getByRole('region', { name: 'Your edited search', exact: true });
  await expect(edited).toBeVisible();
  expect(await posts(page, '/api/evidence')).toBe(2);
  // The question as asked carries over; the words are the reader's; an edited search has no suggestion.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED);
  await expect(edited.getByRole('button', { name: /^engine power loss\s*, edit the search words$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: SUGGESTION })).toHaveCount(0);
  await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: your words/);
});

test('applying the suggested filters, which here leave nothing: the empty result shows its filters and a free way out; a gone search says so', async ({ page }) => {
  await open(page, { width: 390, theme: 'day' });
  await ask(page, 'Fatal balloon accidents in Alaska');
  // The question's own results first: the suggestion is not applied.
  await expect(page.locator('article[data-card]').first()).toBeVisible();
  const suggestion = page.getByRole('region', { name: SUGGESTION });
  await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText(/Highest injury: Fatal\s*Aircraft: Balloon\s*Location: Alaska/);
  await fitsTheWidth(page);
  await suggestion.getByRole('button', { name: /^Apply these filters\s*·\s*uses 1$/ }).click();
  await expect(page.getByRole('region', { name: 'Your edited search', exact: true })).toBeVisible();
  // Exactly the suggested filters, and the question as asked (no terms sent).
  const sent = await page.evaluate<number>(`window.__reads.filter((r) => r.method === 'POST' && r.path === '/api/evidence').length`);
  expect(sent).toBe(2);
  const box = page.locator('[data-few-results]');
  await expect(box).toContainText('No investigations were retrieved for this search.');
  await expect(box).toContainText('Filters: Highest injury: Fatal · Aircraft: Balloon · Location: Alaska · Your question, as asked');
  await expect(box.getByRole('link', { name: /without filters/ })).toHaveAttribute('href', '/explore?q=Fatal+balloon+accidents+in+Alaska');
  await expect(page.getByRole('note')).toHaveText(NOTICE);
  await fitsTheWidth(page);

  await page.goto('/ai/00000000-0000-4000-9000-00000000dead');
  await expect(page.getByRole('heading', { level: 1, name: 'This AI search is no longer available.' })).toBeVisible();
  await expect(page.getByText('AirCase deletes AI searches after 24 hours, and each one opens only for the person who asked it.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask AI/ })).toBeVisible();
  await expect(page).toHaveTitle('AI search expired · AirCase');
});

test('a counting request gets its results with the dashboard hint above them', async ({ page }) => {
  await open(page, { width: 1280, theme: 'night' });
  await ask(page, 'How many helicopter accidents happened in Texas');
  const hint = page.locator('[data-hint="corpus_statistics"]');
  await expect(hint).toContainText('For counts and trends, the dashboard counts every investigation in the snapshot.');
  await expect(hint.getByRole('link', { name: 'Open the dashboard' })).toHaveAttribute('href', '/dashboard');
  await expect(page.locator('article[data-card]').first()).toBeVisible();
});

test('a static reply shows under the box and uses no search', async ({ page }) => {
  await open(page, { width: 1280, theme: 'night' });
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill('Write a poem about clouds');
  await page.getByRole('button', { name: 'Ask AI · 10 free' }).click();
  await expect(page.getByText('This tool only searches NTSB aviation investigations.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Search by keyword instead' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('banner').getByText('AI searches left: 10 of 10')).toBeVisible();
});
