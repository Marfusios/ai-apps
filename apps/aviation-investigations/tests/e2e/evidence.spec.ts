import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_TURNSTILE, TEST_SITE_KEY } from './fake-turnstile.js';

/**
 * The AI evidence view (UI_DESIGN §4.9; contract `evidence.v3`) against the mock API
 * (web/mock/evidence.ts), on a desktop and a phone, by day and at night: Ask AI, what was
 * searched and the AI's suggestion beside it, not applied, the heading and notice on every
 * surface, cards with marked whole paragraphs, the full section, free paging, applying the
 * suggestion and the reader's own edits, the hints, the drawer, Compare, print, and a gone
 * search; and, with the mock standing in for the configurations the evaluation may pick (session
 * storage `casebook-mock-evidence`), what AirCase added on its own (a state the question names,
 * terms in keyword search, AI's order), said as such, and its one free undo, at zero searches left
 * too, used in another tab, or failing after the server took it; the configuration live runs
 * (`er-q-h50-v1` with nothing applied on its own); and the attributed policy of Task 30, which
 * applies a state, years and an aircraft type the question names, each tagged and free to remove.
 * Cloudflare's Turnstile is a local stand-in (tests/e2e/fake-turnstile.ts).
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the new states there.
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

/** The body of every POST to `path`, parsed. */
const postBodies = (page: Page, path: string) =>
  page.evaluate<Record<string, unknown>[]>(`window.__reads.filter((r) => r.method === 'POST' && r.path === ${JSON.stringify(path)}).map((r) => JSON.parse(r.body))`);

/** A screenshot under `E2E_SCREENSHOTS`, when set. */
async function shot(page: Page, name: string, { fullPage = false } = {}): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage });
}

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

    // On arrival the results are announced, and the heading holds focus (the Ask AI button went with Home).
    await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeFocused();
    await expect(page.locator('[data-evidence-live]')).toHaveText('21 investigations retrieved.');

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
    await expect(page.locator('[data-count-line]')).toHaveText('21 retrieved · highest-ranked first · not every matching investigation');
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
    await card.getByRole('button', { name: /^Show the full analysis section\b/ }).first().click();
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
  await expect(hint).toContainText('For counts and trends, the dashboard charts the investigations in this snapshot by year, phase and more.');
  await expect(hint.getByRole('link', { name: 'Open the dashboard' })).toHaveAttribute('href', '/dashboard');
  await expect(page.locator('article[data-card]').first()).toBeVisible();
});

const NOTE = {
  scope: 'AirCase searches published NTSB aviation investigations only. The investigations below were retrieved for your words.',
  operational:
    'AirCase is a research tool, not a source of operational flight or maintenance advice. For a flight in progress, contact ATC; for airworthiness, use your aircraft’s approved data and a certificated mechanic.',
};

for (const [width, theme] of [
  [1280, 'night'],
  [390, 'day'],
] as const) {
  test(`nothing blocks a search: a question about something else, or asking for advice, gets its results under a fixed note (${width}px, ${theme})`, async ({ page }) => {
    await open(page, { width, theme });
    await ask(page, 'Write a poem about clouds');
    const note = page.locator('[data-evidence-note]');
    await expect(note).toHaveText(NOTE.scope);
    await expect(note).toHaveAttribute('data-evidence-note', 'scope');
    // Above the results, which still come, under the notice as always; it was one AI search.
    await expect(page.getByRole('note').first()).toHaveText(NOTICE);
    await expect(page.locator('article[data-card]').first()).toBeVisible();
    const above = await page.evaluate<boolean>(`(() => {
      const note = document.querySelector('[data-evidence-note]');
      const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent === ${JSON.stringify(HEADING)});
      return Boolean(note.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`);
    expect(above).toBe(true);
    await expect(page.getByRole('banner').getByText(width < 640 ? 'AI left 9 of 10' : 'AI searches left: 9 of 10')).toBeVisible();
    await fitsTheWidth(page);

    await page.getByRole('link', { name: 'AirCase' }).click();
    await ask(page, 'What should I do right now, my engine is running rough');
    await expect(note).toHaveText(NOTE.operational);
    await expect(page.getByRole('region', { name: SUGGESTION })).toHaveCount(0);
    await fitsTheWidth(page);
  });
}

// ---------------------------------------------------------------------------
// evidence.v3: what AirCase added on its own, and its one free undo

/** The mock stands in for a configuration the evaluation may pick (web/mock/evidence.ts `MOCK_EVIDENCE_CONFIG_KEY`). */
async function configure(page: Page, config: { ranking: string; autoFilters: string }): Promise<void> {
  await page.addInitScript(`sessionStorage.setItem('casebook-mock-evidence', ${JSON.stringify(JSON.stringify(config))})`);
}

const STATE_TERMS_AI = { ranking: 'er-qt-h50-v1', autoFilters: 'state-explicit.v1.3' };
const STATE_TERMS = 'Carb icing on approach in Texas';

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`what AirCase added on its own is said, and removing it searches again for free (${width}px, ${theme})`, async ({ page }) => {
    await configure(page, STATE_TERMS_AI);
    await open(page, { width, theme });
    await ask(page, STATE_TERMS);
    const parent = page.url();
    const yours = page.getByRole('region', { name: 'Your search', exact: true });
    // The state the question names: a normal applied chip, tagged.
    const texas = yours.getByRole('button', { name: /^Location: Texas\s*, added automatically from your question, remove$/ });
    await expect(texas).toBeVisible();
    await expect(texas.locator('[data-automatic-tag]')).toHaveText('from your question');
    // The terms searched beside the question, with the AI's tag.
    const terms = yours.getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ });
    await expect(terms).toBeVisible();
    await expect(terms.locator('[data-ai-tag]')).toHaveText('AI');
    await expect(yours.locator('dt').filter({ hasText: 'Also searched' })).toBeVisible();
    // AI's order, said in fixed words; the words searched marked.
    await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · leading results ordered by AI for relevance · not every matching investigation$/);
    await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: the words searched · .*their synonyms$/);
    // The suggestion: only what was not used, with its note.
    const suggestion = page.getByRole('region', { name: SUGGESTION });
    await expect(suggestion).toContainText('AI suggested these as well. AirCase applies none of them unless you choose them.');
    await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
    await expect(suggestion).not.toContainText('carb icing');
    await expect(suggestion.getByRole('button')).toHaveCount(1);
    await fitsTheWidth(page);
    await shot(page, `v3-search-${width}-${theme}`);

    // Removing what AirCase added: free.
    await texas.click();
    await expect(yours.getByRole('button', { name: '+ Filter' })).toBeFocused();
    await terms.click();
    await expect(yours.getByRole('button', { name: 'Use your own words' })).toBeFocused();
    const again = yours.getByRole('button', { name: 'Search again · free' });
    await expect(again).toBeVisible();
    await fitsTheWidth(page);
    await shot(page, `v3-undo-draft-${width}-${theme}`);
    await again.click();
    const edited = page.getByRole('region', { name: 'Your edited search', exact: true });
    await expect(edited).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeFocused();
    await expect(page.locator('[data-evidence-live]')).toHaveText(/^\d+ investigations retrieved\.\s*$/);
    // Exactly the undo: no filter, the question's own keywords, no words.
    const bodies = await postBodies(page, '/api/evidence');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ kind: 'edited', from: expect.any(String), filters: {}, keywords: 'question', idempotencyKey: expect.any(String), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
    // It used none of the visitor's searches; nothing is left to undo.
    await expect(page.getByRole('banner').getByText(width < 640 ? 'AI left 9 of 10' : 'AI searches left: 9 of 10')).toBeVisible();
    await expect(edited.locator('[data-added-terms], [data-automatic]')).toHaveCount(0);
    await expect(page.locator('[data-count-line]')).toHaveText(/^21 retrieved · leading results ordered by AI for relevance/);
    await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: your words/);
    await shot(page, `v3-undone-${width}-${theme}`);

    // Back on the first search: its page says its free undo is used, so removing the state again uses one.
    await page.goBack();
    await expect(page).toHaveURL(parent);
    await page.getByRole('region', { name: 'Your search', exact: true }).getByRole('button', { name: /^Location: Texas/ }).click();
    await expect(page.getByRole('region', { name: 'Your search', exact: true }).getByRole('button', { name: 'Search again · uses 1' })).toBeVisible();
    await shot(page, `v3-undo-used-${width}-${theme}`);

    // Print: the tags, the added terms and the order line; no controls.
    await page.getByRole('region', { name: 'Your search', exact: true }).getByRole('button', { name: 'Undo changes' }).click();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('[data-automatic-tag]')).toBeVisible();
    await expect(page.locator('[data-ai-tag]')).toBeVisible();
    await expect(page.locator('[data-count-line]')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Filter' })).toBeHidden();
    await expect(page.locator('[data-suggestion-print]')).toHaveText('Suggested filters and terms — not applied: Phase: Approach');
    await shot(page, `v3-print-${width}`, { fullPage: true });
    await page.emulateMedia({ media: 'screen' });
  });
}

test('terms instead of the question in keyword search: “Keywords searched”, with its note, on a phone', async ({ page }) => {
  await configure(page, { ranking: 'er-t-v1', autoFilters: 'none' });
  await open(page, { width: 390, theme: 'day' });
  await ask(page, CARB);
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  await expect(yours.locator('dt').filter({ hasText: 'Keywords searched' })).toBeVisible();
  await expect(yours.locator('[data-keywords-note]')).toHaveText('Keyword search used these terms instead of your question; similarity search still used your question.');
  await expect(page.locator('[data-count-line]')).toHaveText('21 retrieved · highest-ranked first · not every matching investigation');
  await fitsTheWidth(page);
  // Taking the terms out is the search's free undo.
  await yours.getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ }).click();
  await expect(yours.getByRole('button', { name: 'Search again · free' })).toBeVisible();
  await fitsTheWidth(page);
  await shot(page, 'v3-keywords-390-day');
});

test('with no searches left the free undo still runs, with the usual check; anything else stays off', async ({ page }) => {
  await configure(page, STATE_TERMS_AI);
  await open(page, { width: 390, theme: 'day' });
  // Nine searches from this browser, then the tenth from the box: the last of the day.
  await page.evaluate(async () => {
    for (let i = 1; i <= 9; i++) {
      await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'question', question: `Engine power loss, search ${i}`, idempotencyKey: crypto.randomUUID(), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
      });
    }
  });
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(STATE_TERMS);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible();
  const parent = page.url();
  // The mock offers Google sign-in: the counter asks to sign in.
  await expect(page.getByRole('banner').getByText('Sign in to keep asking')).toBeVisible();
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  // A charged action asks to sign in; the undo runs.
  await expect(page.getByRole('region', { name: SUGGESTION }).getByRole('button', { name: /^Apply these filters\s*·\s*sign in$/ })).toBeVisible();
  await yours.getByRole('button', { name: /^Location: Texas/ }).click();
  const again = yours.getByRole('button', { name: 'Search again · free' });
  await expect(again).toHaveAttribute('aria-disabled', 'false');
  await shot(page, 'v3-zero-left-390-day');
  const checks = await page.evaluate<number>('window.__turnstile.renders.length');
  await again.click();
  await expect(page.getByRole('region', { name: 'Your edited search', exact: true })).toBeVisible();
  expect(await page.evaluate<number>('window.__turnstile.renders.length')).toBe(checks + 1);
  await expect(page.locator('[data-undo-charged]')).toHaveCount(0);

  // Back on the first search: its one undo is used, so taking out the terms would use one, and none is left.
  await page.goBack();
  await expect(page).toHaveURL(parent);
  const first = page.getByRole('region', { name: 'Your search', exact: true });
  await first.getByRole('button', { name: /^“carb icing”/ }).click();
  await expect(first.getByRole('button', { name: /^Search again\s*·\s*sign in$/ })).toBeVisible();
});

test('a free undo used in another tab is caught right before sending: nothing is sent, and it says so', async ({ page }) => {
  await configure(page, STATE_TERMS_AI);
  await open(page, { width: 1280, theme: 'night' });
  await ask(page, STATE_TERMS);
  const id = /\/ai\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  // Its undo used in another tab: this one does not know.
  await page.evaluate(async (from) => {
    await fetch('/api/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'edited', from, filters: {}, idempotencyKey: crypto.randomUUID(), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
    });
  }, id);
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  await yours.getByRole('button', { name: /^Location: Texas/ }).click();
  await yours.getByRole('button', { name: 'Search again · free' }).click();
  // The page is read again first: its undo is used, so nothing is sent as free.
  await expect(page.getByText("This search's free undo has already been used, so searching again uses one of your AI searches.")).toBeVisible();
  await expect(yours.getByRole('button', { name: 'Search again · uses 1' })).toBeVisible();
  expect(await posts(page, '/api/evidence')).toBe(2);
  await expect(page.getByRole('banner').getByText('AI searches left: 9 of 10')).toBeVisible();
  await shot(page, 'v3-undo-used-notice-1280-night');
});

test('a free undo that fails after the server took it: the notice does not promise free, and trying again uses one', async ({ page }) => {
  await configure(page, STATE_TERMS_AI);
  await open(page, { width: 1280, theme: 'day' });
  await ask(page, `${STATE_TERMS}, undo fails`);
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  await yours.getByRole('button', { name: /^Location: Texas/ }).click();
  await yours.getByRole('button', { name: 'Search again · free' }).click();
  await expect(page.getByText("AirCase couldn't finish this AI search.")).toBeVisible();
  await expect(page.getByText('The free undo may be used up now, so trying again can use one of your AI searches.')).toBeVisible();
  await expect(page.getByText("It didn't use one of your searches.")).toHaveCount(0);
  // Read again: the server kept the undo, so both buttons say they use one.
  await expect(page.getByRole('button', { name: /^Try again\s*·\s*uses 1$/ })).toBeVisible();
  await expect(yours.getByRole('button', { name: 'Search again · uses 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: /·\s*free$/ })).toHaveCount(0);
  await fitsTheWidth(page);
  await shot(page, 'v3-undo-failed-1280-day');
});

// ---------------------------------------------------------------------------
// The reviewed state policy, off on live: the question alone, highest-ranked first, the suggested terms marked, a named state applied

const STATE_POLICY = { ranking: 'er-q-v1', autoFilters: 'state-explicit.v1.3' };
const STATE_MARKED = 'Carb icing on approach in Missouri';

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`the reviewed state policy: the state chip, the suggested terms marked and suggested, highest-ranked first, and the state's free undo (${width}px, ${theme})`, async ({ page }) => {
    await configure(page, STATE_POLICY);
    await open(page, { width, theme });
    await ask(page, STATE_MARKED);
    const parent = page.url();
    const yours = page.getByRole('region', { name: 'Your search', exact: true });
    const missouri = yours.getByRole('button', { name: /^Location: Missouri\s*, added automatically from your question, remove$/ });
    await expect(missouri).toBeVisible();
    await expect(missouri.locator('[data-automatic-tag]')).toHaveText('from your question');
    // Keyword search read the question alone: nothing else was added.
    await expect(yours.locator('[data-added-terms], [data-keywords-note]')).toHaveCount(0);
    await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · highest-ranked first · not every matching investigation$/);
    // The suggested terms are marked, and said so.
    await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: the suggested terms · .*their synonyms$/);
    await expect(page.locator('[data-relevance]').first()).toContainText('Suggested terms in these excerpts:');
    // The suggestion keeps the phase and the terms, with the note for a search AirCase added to.
    const suggestion = page.getByRole('region', { name: SUGGESTION });
    await expect(suggestion).toContainText('AI suggested these as well. AirCase applies none of them unless you choose them.');
    await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
    await expect(suggestion).toContainText('“carb icing”');
    await expect(suggestion.getByRole('button', { name: /^Apply these filters\s*·\s*uses 1$/ })).toBeVisible();
    await expect(suggestion.getByRole('button', { name: /^Apply filters and terms\s*·\s*uses 1$/ })).toBeVisible();
    await fitsTheWidth(page);
    await shot(page, `state-policy-search-${width}-${theme}`);

    // Removing the state: the free undo, an edit with no filters and no words.
    await missouri.click();
    const again = yours.getByRole('button', { name: 'Search again · free' });
    await expect(again).toBeVisible();
    await again.click();
    const edited = page.getByRole('region', { name: 'Your edited search', exact: true });
    await expect(edited).toBeVisible();
    await expect(page.locator('[data-evidence-live]')).toHaveText(/^\d+ investigations? retrieved\.\s*$/);
    const bodies = await postBodies(page, '/api/evidence');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ kind: 'edited', from: expect.any(String), filters: {}, idempotencyKey: expect.any(String), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
    await expect(page.getByRole('banner').getByText(width < 640 ? 'AI left 9 of 10' : 'AI searches left: 9 of 10')).toBeVisible();
    await expect(page.locator('[data-undo-charged]')).toHaveCount(0);
    await expect(edited.locator('[data-automatic]')).toHaveCount(0);
    await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · highest-ranked first/);
    await shot(page, `state-policy-undone-${width}-${theme}`);

    // Back on the first search: its undo is used, so removing the state again uses one.
    await page.goBack();
    await expect(page).toHaveURL(parent);
    await page.getByRole('region', { name: 'Your search', exact: true }).getByRole('button', { name: /^Location: Missouri/ }).click();
    await expect(page.getByRole('region', { name: 'Your search', exact: true }).getByRole('button', { name: 'Search again · uses 1' })).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// What live runs: the question alone, the leading results in AI order, the reader's words marked, nothing applied on its own

const RELEASE = { ranking: 'er-q-h50-v1', autoFilters: 'none' };

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`what live runs: the leading results in AI order, the reader's words marked, a named state only suggested (${width}px, ${theme})`, async ({ page }) => {
    await configure(page, RELEASE);
    await open(page, { width, theme });
    await ask(page, STATE_MARKED);
    const yours = page.getByRole('region', { name: 'Your search', exact: true });
    await expect(yours).toBeVisible();
    await expect(yours.locator('[data-automatic], [data-added-terms], [data-keywords-note]')).toHaveCount(0);
    await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · leading results ordered by AI for relevance · not every matching investigation$/);
    await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: your words · .*their synonyms$/);
    const suggestion = page.getByRole('region', { name: SUGGESTION });
    await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toContainText('Location: Missouri');
    await expect(suggestion.getByRole('button', { name: /^Apply these filters\s*·\s*uses 1$/ })).toBeVisible();
    await fitsTheWidth(page);
    await shot(page, `release-search-${width}-${theme}`);
  });
}

// ---------------------------------------------------------------------------
// The attributed policy (Task 30): live's ranking, with a state, years and an aircraft type the question names applied on their own

const FIELDS_POLICY = { ranking: 'er-q-h50-v1', autoFilters: 'attributed.v1' };
const FIELDS = 'Helicopter power loss on approach in Texas since 2008';
const AUTOMATIC_NOTE = 'AI applied the filters marked “from your question”.';

for (const [width, theme] of [
  [1280, 'day'],
  [390, 'night'],
] as const) {
  test(`the attributed policy: a state, years and an aircraft type from the question, each tagged; removing the years is free; the suggestion keeps the rest (${width}px, ${theme})`, async ({ page }) => {
    await configure(page, FIELDS_POLICY);
    await open(page, { width, theme });
    await ask(page, FIELDS);
    const parent = page.url();
    const yours = page.getByRole('region', { name: 'Your search', exact: true });
    // Three applied chips, each tagged, in the filters' order, years last.
    await expect(yours.locator('[data-automatic]')).toHaveCount(3);
    for (const label of ['Aircraft: Helicopter', 'Location: Texas', 'Years: from 2008']) {
      const chip = yours.getByRole('button', { name: new RegExp(`^${label}\\s*, added automatically from your question, remove$`) });
      await expect(chip).toBeVisible();
      await expect(chip.locator('[data-automatic-tag]')).toHaveText('from your question');
    }
    // Under them, the note that AI applied them, and that taking them out is free once.
    await expect(yours.locator('[data-automatic-note]')).toHaveText(`${AUTOMATIC_NOTE} Remove any that are wrong: taking out everything AI added is free once.`);
    // The suggestion keeps only what was not applied: the phase and the terms.
    const suggestion = page.getByRole('region', { name: SUGGESTION });
    await expect(suggestion).toContainText('AI suggested these as well. AirCase applies none of them unless you choose them.');
    await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
    await expect(suggestion).toContainText('“power loss”');
    await expect(suggestion).not.toContainText(/Texas|Helicopter|2008/);
    // Two investigations, in AI order, summed up with each automatic filter tagged.
    await expect(page.locator('[data-count-line]')).toHaveText('2 retrieved · leading results ordered by AI for relevance · not every matching investigation');
    await expect(page.locator('[data-few-results-search]')).toHaveText(
      'Filters: Aircraft: Helicopter (from your question) · Location: Texas (from your question) · Years: from 2008 (from your question) · Your question, as asked',
    );
    await fitsTheWidth(page);
    await shot(page, `fields-search-${width}-${theme}`);
    // On paper the tags print, and the note keeps its first sentence only (paper has no controls).
    await page.emulateMedia({ media: 'print' });
    await expect(yours.locator('[data-automatic-tag]')).toHaveCount(3);
    await expect(yours.locator('[data-automatic-tag]').first()).toBeVisible();
    await expect(yours.locator('[data-automatic-note]')).toBeHidden();
    await expect(yours.locator('[data-automatic-note-print]')).toBeVisible();
    await expect(yours.locator('[data-automatic-note-print]')).toHaveText(AUTOMATIC_NOTE);
    await page.emulateMedia({ media: 'screen' });
    await expect(yours.locator('[data-automatic-note-print]')).toBeHidden();

    // Removing the years: the search's one free undo.
    await yours.getByRole('button', { name: /^Years: from 2008/ }).click();
    await expect(yours.getByRole('button', { name: '+ Filter' })).toBeFocused();
    await expect(yours.locator('[data-automatic]')).toHaveCount(2);
    const again = yours.getByRole('button', { name: 'Search again · free' });
    await expect(again).toBeVisible();
    await fitsTheWidth(page);
    await shot(page, `fields-undo-draft-${width}-${theme}`);
    await again.click();
    const edited = page.getByRole('region', { name: 'Your edited search', exact: true });
    await expect(edited).toBeVisible();
    await expect(page.locator('[data-evidence-live]')).toHaveText(/^\d+ investigations? retrieved\.\s*$/);
    // Exactly the undo: the other two filters, no words; it used none of the visitor's searches.
    const bodies = await postBodies(page, '/api/evidence');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ kind: 'edited', from: expect.any(String), filters: { category: ['HELI'], state: ['TX'] }, idempotencyKey: expect.any(String), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
    await expect(page.getByRole('banner').getByText(width < 640 ? 'AI left 9 of 10' : 'AI searches left: 9 of 10')).toBeVisible();
    await expect(page.locator('[data-undo-charged]')).toHaveCount(0);
    // The filters left are the reader's own now: no tag, no note.
    await expect(edited.locator('[data-automatic], [data-automatic-note]')).toHaveCount(0);
    await shot(page, `fields-undone-${width}-${theme}`);

    // Back on the first search: its undo is used, so the note no longer offers it and removing another uses one.
    await page.goBack();
    await expect(page).toHaveURL(parent);
    const first = page.getByRole('region', { name: 'Your search', exact: true });
    await expect(first.locator('[data-automatic-note]')).toHaveText(AUTOMATIC_NOTE);
    await first.getByRole('button', { name: /^Aircraft: Helicopter/ }).click();
    await expect(first.getByRole('button', { name: 'Search again · uses 1' })).toBeVisible();
  });
}

for (const [policy, config, sentence] of [
  ['none', null, 'Ask in plain English: AirCase searches with your question, and AI suggests filters you can choose to apply.'],
  [
    'state',
    STATE_POLICY,
    'Ask in plain English: AirCase searches with your question. A US state it names explicitly can be applied automatically, and you can remove it; everything else AI suggests stays a suggestion.',
  ],
  [
    'fields',
    FIELDS_POLICY,
    'Ask in plain English: AirCase searches with your question. A US state, years or aircraft type your question sets for the accidents can be applied automatically, and you can remove them; everything else AI suggests stays a suggestion.',
  ],
] as const) {
  test(`the AI nudge on Explore follows the server’s automatic-filter policy (${policy})`, async ({ page }) => {
    if (config) await configure(page, config);
    await open(page, { width: 390, theme: 'day' });
    await page.goto('/explore?q=carburetor+icing&phase=approach');
    const nudge = page.getByText(sentence, { exact: false });
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText('It searches the question alone, not the filters set here.');
    await fitsTheWidth(page);
  });
}
