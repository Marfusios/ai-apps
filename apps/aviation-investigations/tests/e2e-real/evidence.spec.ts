/**
 * The AI evidence view end to end with AI on (UI_DESIGN §4.9; contract `evidence.v2`): the
 * production build against the real server (tests/e2e-real/server.ts), whose evidence pipeline
 * runs for real over the fixture corpus with offline fakes for every provider: a scripted scope
 * stage (tests/e2e-real/evidence-fakes.ts), the fake embedder of the fixture passages index and
 * Cloudflare's test keys answered locally. In the browser, Cloudflare's widget is the local
 * stand-in of the mock suite (tests/e2e/fake-turnstile.ts), so nothing leaves the machine.
 *
 * Covered: asking from Home and from Explore; the results under the fixed heading and notice;
 * the AI's suggestion shown unapplied, then its filters applied with the question kept and its
 * terms accepted, each an edited search that says it uses one; free paging; "Show the full
 * section" from the private context endpoint; the drawer, Compare and print with the notice; the
 * capability notes, and none for a case search; a scope stage that fails; an unknown search and
 * another visitor's; the anonymous daily limit; and the known context-loss examples on the
 * initial surfaces. Every test fails on a CSP violation, a page error or a request that would leave
 * the machine.
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the flow there.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EVIDENCE_HEADING, EVIDENCE_NOTE_TEXT, EVIDENCE_NOTICE, EVIDENCE_SUGGESTION_LABEL } from '../../shared/contracts/evidence.js';
import { FAKE_TURNSTILE } from '../e2e/fake-turnstile.js';
import {
  CONTEXT_LOSS_EXAMPLES,
  CONTEXT_LOSS_SEARCH_ID,
  contextLossDetail,
  contextLossPage,
  contextLossPageJson,
  contextLossParagraph,
} from '../support/context-loss.js';
import { CARB_SUGGESTION, E2E_QUESTIONS } from './evidence-fakes.js';
import { unexpected, watchPage } from './watch.js';

/** Every test's page: a request that would leave the machine is refused, and fails the test. */
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

const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const SEARCH_PATH = /\/ai\/([0-9a-f-]{36})(?:\?.*)?$/;
const COUNT_LINE = /^\d+ retrieved · best match first · not every matching investigation$/;

type Theme = 'day' | 'night';

/** A screenshot under `E2E_SCREENSHOTS`, when set. */
async function shot(page: Page, name: string, { fullPage = false } = {}): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage });
}

interface ApiCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** Every API request the page makes, with the JSON body of each POST. */
function recordApi(page: Page): ApiCall[] {
  const calls: ApiCall[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    calls.push({ method: request.method(), path: `${url.pathname}${url.search}`, body: request.method() === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : null });
  });
  return calls;
}

const searches = (calls: readonly ApiCall[]) => calls.filter((c) => c.method === 'POST' && c.path === '/api/evidence');

/** The viewport, theme and Turnstile stand-in (its check passes after `checkDelay` ms), before the first page. */
async function prepare(page: Page, { width = 1280, theme = 'day' as Theme, checkDelay = 60 } = {}): Promise<void> {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  await page.addInitScript(`localStorage.setItem('casebook-theme', '${theme}')`);
  await page.addInitScript(`window.__checkDelay = ${checkDelay};`);
  await page.addInitScript(FAKE_TURNSTILE);
}

const searchIdOf = (page: Page): string => SEARCH_PATH.exec(page.url())?.[1] ?? '';

/** Ask AI from the box on Home; resolves on the search's page with its id. */
async function askFromHome(page: Page, question: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(question);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page).toHaveURL(SEARCH_PATH);
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  return searchIdOf(page);
}

/** The banner's AI counter (the long form at desktop widths). */
const counter = (page: Page, left: number) => page.getByRole('banner').getByText(`AI searches left: ${left} of 10`);

/** No sideways scrolling: the page is never wider than the viewport. */
async function fitsTheWidth(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth')).toBeLessThanOrEqual(0);
}

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();

test('Ask AI from Home: the results under the notice, the suggestion unapplied; applying its filters keeps the question, its terms only by choice, each an edited search that uses one', async ({ page }) => {
  const problems = await watchPage(page);
  const api = recordApi(page);
  // The first check stays on screen long enough to be read.
  await prepare(page, { checkDelay: 1_500 });
  await page.goto('/');
  await expect(counter(page, 10)).toBeVisible();
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(E2E_QUESTIONS.carb);
  await page.getByRole('button', { name: 'Ask AI · 10 free' }).click();
  await expect(page.getByRole('dialog', { name: 'Quick check before your first AI search' })).toContainText('Up to ten free AI searches a day, subject to daily availability.');
  await expect(page).toHaveURL(SEARCH_PATH);
  const asked = searchIdOf(page);
  // The question alone, with the widget's token: one AI search.
  expect(searches(api).map((c) => c.body)).toEqual([{ kind: 'question', question: E2E_QUESTIONS.carb, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN }]);
  await expect(counter(page, 9)).toBeVisible();

  // The question as asked is what was searched; the suggestion stands beside it, labelled, not applied.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E2E_QUESTIONS.carb);
  const yours = page.getByRole('region', { name: 'Your search', exact: true });
  await expect(yours).toContainText('Your question, as asked');
  await expect(yours.getByRole('button', { name: /, remove$/ })).toHaveCount(0);
  const suggestion = page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL });
  await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
  await expect(suggestion).toContainText(`“${CARB_SUGGESTION.terms}”`);
  const applyFilters = suggestion.getByRole('button', { name: /^Apply these filters\s*·\s*uses 1$/ });
  await expect(applyFilters).toBeVisible();
  await expect(suggestion.getByRole('button', { name: /^Apply filters and terms\s*·\s*uses 1$/ })).toBeVisible();
  // The heading, the notice, the count that never claims every match, the marks explained; a case search has no note.
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  await expect(page.locator('[data-count-line]')).toHaveText(COUNT_LINE);
  await expect(page.locator('[data-legend]')).toHaveAttribute('data-legend', 'suggested');
  await expect(page.locator('[data-evidence-note]')).toHaveCount(0);
  // A card that marks the suggested terms counts them as occurrences, said as suggested.
  const marked = page.locator('article[data-card]').filter({ has: page.locator('mark.hit') }).first();
  await expect(marked.locator('[data-relevance]')).toHaveText(/^How it was found:\s*Suggested terms in these excerpts: .+ · found by .+ search$/);
  // A probable-cause statement is a passage too (the mock never quoted one): a paragraph of it can be an
  // excerpt, under its own label, beside the statement the card shows verbatim.
  const causeCard = page.locator('article[data-card]').filter({ has: page.locator('figure[data-excerpt^="probable_cause/"]') }).first();
  const causeExcerpt = causeCard.locator('figure[data-excerpt^="probable_cause/"]').first();
  await expect(causeExcerpt.locator('figcaption')).toHaveText(/^NTSB · PROBABLE CAUSE/);
  const statement = normalized(await causeCard.locator('[data-probable-cause]').first().innerText());
  expect(statement).toContain(normalized(await causeExcerpt.locator('blockquote').innerText()));
  await fitsTheWidth(page);
  await shot(page, 'home-results-1280-day');
  await shot(page, 'home-results-full-1280-day', { fullPage: true });

  // Apply these filters: an edited search with exactly those filters and no terms; the question stays.
  await applyFilters.click();
  await expect(page.getByRole('region', { name: 'Your edited search', exact: true })).toBeVisible();
  const filtered = searchIdOf(page);
  expect(filtered).not.toBe(asked);
  const applied = searches(api)[1]?.body ?? {};
  expect(applied).toEqual({ kind: 'edited', from: asked, filters: CARB_SUGGESTION.filters, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN });
  expect('terms' in applied).toBe(false);
  const edited = page.getByRole('region', { name: 'Your edited search', exact: true });
  await expect(edited).toContainText('Your question, as asked');
  await expect(edited.getByRole('button', { name: /^Phase: Approach\s*, remove$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL })).toHaveCount(0);
  await expect(page.locator('[data-legend]')).toHaveAttribute('data-legend', 'yours');
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  // Every case retrieved under the filter says it meets it (the server rechecked the coded field).
  const relevance = page.locator('article[data-card] [data-relevance]');
  await expect(relevance.first()).toBeVisible();
  for (const line of await relevance.allInnerTexts()) expect(normalized(line)).toMatch(/^How it was found: Phase: Approach · /);
  await expect(counter(page, 8)).toBeVisible();
  await shot(page, 'applied-filters-1280-day');

  // Back on the first search: Apply filters and terms takes the terms too, as an explicit choice.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/ai/${asked}`));
  await page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL }).getByRole('button', { name: /^Apply filters and terms\s*·\s*uses 1$/ }).click();
  await expect(page.getByRole('region', { name: 'Your edited search', exact: true }).getByRole('button', { name: new RegExp(`^${CARB_SUGGESTION.terms}\\s*✎?\\s*, edit the search words$`) })).toBeVisible();
  expect(searchIdOf(page)).not.toBe(filtered);
  expect(searches(api)[2]?.body).toEqual({
    kind: 'edited',
    from: asked,
    filters: CARB_SUGGESTION.filters,
    terms: CARB_SUGGESTION.terms,
    idempotencyKey: expect.any(String),
    turnstileToken: DUMMY_TOKEN,
  });
  await expect(page.locator('[data-legend]')).toHaveAttribute('data-legend', 'yours');
  await expect(counter(page, 7)).toBeVisible();
  await shot(page, 'applied-terms-1280-day');
  expect(searches(api)).toHaveLength(3);
  expect(problems).toEqual([]);
});

test('Ask AI from Explore, then the free surfaces: more pages, the full section from the private endpoint, the drawer, Compare and print, each with the notice', async ({ page }) => {
  const problems = await watchPage(page);
  const api = recordApi(page);
  await prepare(page, { theme: 'night' });
  await page.goto('/explore?q=engine+power+loss');
  await expect(page.getByRole('list', { name: 'Results' })).toBeVisible();
  // The search box's Ask AI (the nudge under the results has one too).
  await page.getByRole('button', { name: /^Ask AI · 10 free$/ }).first().click();
  await expect(page).toHaveURL(SEARCH_PATH);
  const id = searchIdOf(page);
  expect(searches(api).map((c) => c.body)).toEqual([{ kind: 'question', question: 'engine power loss', idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN }]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('engine power loss');
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);

  // More pages are free: the pinned ranking, read page by page.
  const cards = page.locator('article[data-card]');
  await expect(cards).toHaveCount(10);
  const more = page.getByRole('navigation', { name: 'More investigations' });
  const showing = normalized(await more.innerText());
  const total = Number(/Showing 1–10 of (\d+)/.exec(showing)?.[1]);
  expect(total).toBeGreaterThan(10);
  await more.getByRole('button', { name: /^Show \d+ more/ }).click();
  await expect(cards).toHaveCount(Math.min(20, total));
  await expect(page).toHaveURL(new RegExp(`/ai/${id}\\?pages=2$`));
  await expect(page.locator('article[data-rank="11"] [data-case-trigger]')).toBeFocused();
  expect(api.some((c) => c.method === 'GET' && c.path === `/api/evidence/${id}?page=2`)).toBe(true);
  expect(searches(api)).toHaveLength(1);

  // Show the full section: the section at the search's own generation, from the private endpoint (never the public case).
  const card = cards.filter({ has: page.locator('figure[data-excerpt]') }).first();
  const ntsbNo = (await card.getAttribute('data-card')) as string;
  const rank = (await card.getAttribute('data-rank')) as string;
  const context = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/evidence/${id}/cases/${ntsbNo}`);
  await card.getByRole('button', { name: /^Show the full .+ section$/ }).first().click();
  const contextResponse = await context;
  expect(contextResponse.status()).toBe(200);
  expect(contextResponse.headers()['cache-control']).toBe('private, no-store');
  const paragraph = card.locator('[data-excerpt-paragraph]');
  await expect(paragraph).toBeFocused();
  await expect(paragraph).toBeInViewport();
  expect(api.some((c) => c.path === `/api/cases/${ntsbNo}`)).toBe(false);
  await shot(page, 'full-section-1280-night');
  await card.getByRole('button', { name: 'Show the excerpt only' }).click();
  await expect(paragraph).toHaveCount(0);

  // The drawer: the same projection under the heading and notice, with its place in the ranking.
  await card.getByRole('link', { name: ntsbNo, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(`^${ntsbNo}: `) });
  await expect(drawer).toBeVisible();
  const section = drawer.getByRole('region', { name: EVIDENCE_HEADING });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole('note')).toHaveText(EVIDENCE_NOTICE);
  await expect(drawer.getByText(`${rank} of ${total}`)).toBeVisible();
  await shot(page, 'drawer-1280-night');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Compare two of them: the question, the heading and notice, each strip's evidence row.
  for (const n of [0, 1]) {
    const box = cards.nth(n).getByRole('checkbox');
    await box.click();
    await expect(box).toBeChecked();
  }
  await page.getByRole('complementary', { name: 'Compare tray' }).getByRole('link', { name: 'Compare →' }).click();
  await expect(page).toHaveURL(new RegExp(`/compare\\?cases=[A-Z0-9]+,[A-Z0-9]+&evidence=${id}&pages=2$`));
  const top = page.locator('[data-compare-evidence]');
  await expect(top).toContainText('From your search “engine power loss”');
  await expect(top.getByRole('note')).toHaveText(EVIDENCE_NOTICE);
  await expect(page.locator('[data-strip-evidence]')).toHaveCount(2);
  await shot(page, 'compare-1280-night');

  // Print: Compare's notice and evidence rows print; then the sheet's heading, notice and cards, without the controls.
  await page.emulateMedia({ media: 'print' });
  await expect(top.getByRole('note')).toBeVisible();
  await expect(page.locator('[data-strip-evidence]').first()).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.goto(`/ai/${id}?pages=2`);
  await expect(cards).toHaveCount(Math.min(20, total));
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  await expect(page.getByRole('note').first()).toBeVisible();
  await expect(cards.first()).toBeVisible();
  await expect(page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL })).toBeHidden();
  await expect(more).toBeHidden();
  await shot(page, 'print-1280');
  await page.emulateMedia({ media: 'screen' });
  expect(searches(api)).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('nothing blocks a search: a question about something else, or asking for advice, gets its results under a fixed capability note (390px, day)', async ({ page }) => {
  const problems = await watchPage(page);
  await prepare(page, { width: 390 });
  await askFromHome(page, E2E_QUESTIONS.poem);
  const note = page.locator('[data-evidence-note]');
  await expect(note).toHaveAttribute('data-evidence-note', 'scope');
  await expect(note).toHaveText(EVIDENCE_NOTE_TEXT.scope);
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  await expect(page.locator('article[data-card]').first()).toBeVisible();
  await expect(page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL })).toHaveCount(0);
  // The note is above the results heading, and the notice is still there.
  const above = await page.evaluate<boolean>(`(() => {
    const note = document.querySelector('[data-evidence-note]');
    const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent === ${JSON.stringify(EVIDENCE_HEADING)});
    return Boolean(note && heading && note.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
  })()`);
  expect(above).toBe(true);
  await expect(page.getByRole('banner').getByText('AI left 9 of 10')).toBeVisible();
  await fitsTheWidth(page);
  await shot(page, 'note-scope-390-day');

  await askFromHome(page, E2E_QUESTIONS.advice);
  await expect(note).toHaveAttribute('data-evidence-note', 'operational_advice');
  await expect(note).toHaveText(EVIDENCE_NOTE_TEXT.operational_advice);
  await expect(page.locator('article[data-card]').first()).toBeVisible();
  await expect(page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL })).toHaveCount(0);
  await fitsTheWidth(page);
  await shot(page, 'note-operational-390-day');
  expect(problems).toEqual([]);
});

test('an explicit counting or comparison request gets its results with the server’s hint above them', async ({ page }) => {
  const problems = await watchPage(page);
  await prepare(page);
  await askFromHome(page, 'How many helicopter accidents involved an engine failure?');
  const statistics = page.locator('[data-hint="corpus_statistics"]');
  await expect(statistics).toContainText('For counts and trends, the dashboard counts every investigation in the snapshot.');
  await expect(statistics.getByRole('link', { name: 'Open the dashboard' })).toHaveAttribute('href', '/dashboard');
  await expect(page.locator('article[data-card]').first()).toBeVisible();

  await askFromHome(page, 'Compare SEA08LA057 and DCA25MA108 and ZZZ99ZZ999');
  const comparison = page.locator('[data-hint="case_comparison"]');
  await expect(comparison).toContainText('Comparing named investigations is free; it doesn’t need the AI.');
  await expect(comparison.getByRole('link', { name: 'Compare SEA08LA057, DCA25MA108 →' })).toHaveAttribute('href', '/compare?cases=SEA08LA057,DCA25MA108');
  await expect(comparison).toContainText('Not found: ZZZ99ZZ999');
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  await expect(page.locator('article[data-card]').first()).toBeVisible();
  await shot(page, 'hint-comparison-1280-day');
  expect(problems).toEqual([]);
});

test('a scope stage that fails still shows the question’s results, with no suggestion and no note, and counts as one search', async ({ page }) => {
  const problems = await watchPage(page);
  await prepare(page);
  await askFromHome(page, E2E_QUESTIONS.scopeFails);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E2E_QUESTIONS.scopeFails);
  await expect(page.getByRole('region', { name: 'Your search', exact: true })).toContainText('Your question, as asked');
  await expect(page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL })).toHaveCount(0);
  await expect(page.locator('[data-evidence-note]')).toHaveCount(0);
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  await expect(page.locator('[data-count-line]')).toHaveText(COUNT_LINE);
  await expect(page.locator('article[data-card]').first()).toBeVisible();
  // The marks are the question's own words.
  await expect(page.locator('[data-legend]')).toHaveAttribute('data-legend', 'yours');
  await expect(counter(page, 9)).toBeVisible();
  await shot(page, 'scope-failed-1280-day');
  expect(problems).toEqual([]);
});

test('an unknown search, and another visitor’s, read as gone: the expired page, with Ask AI', async ({ page, browser, baseURL }) => {
  const problems = await watchPage(page);
  await prepare(page);
  const unknown = '00000000-0000-4000-9000-00000000dead';
  await page.goto(`/ai/${unknown}`);
  await expect(page.getByRole('heading', { level: 1, name: 'This AI search is no longer available.' })).toBeVisible();
  await expect(page.getByText('AirCase deletes AI searches after 24 hours, and each one opens only for the person who asked it.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask AI/ })).toBeVisible();
  await expect(page).toHaveTitle('AI search expired · AirCase');
  await shot(page, 'expired-1280-day');

  // A live search of this visitor opens for them only.
  const id = await askFromHome(page, 'Engine fire during the takeoff roll');
  const ntsbNo = (await page.locator('article[data-card]').first().getAttribute('data-card')) as string;
  const other = await browser.newContext({ baseURL });
  try {
    const stranger = await other.newPage();
    const strangerProblems = await watchPage(stranger);
    await stranger.goto(`/ai/${id}`);
    await expect(stranger.getByRole('heading', { level: 1, name: 'This AI search is no longer available.' })).toBeVisible();
    expect((await stranger.request.get(`/api/evidence/${id}?page=1`)).status()).toBe(404);
    expect((await stranger.request.get(`/api/evidence/${id}/cases/${ntsbNo}`)).status()).toBe(404);
    expect(unexpected(strangerProblems, [`/api/evidence/${id}`])).toEqual([]);
  } finally {
    await other.close();
  }
  expect(unexpected(problems, [`/api/evidence/${unknown}`])).toEqual([]);
});

test('the anonymous daily limit: the tenth search is the last of the day, the box says when they return, and the server refuses an eleventh', async ({ page }) => {
  const problems = await watchPage(page);
  await prepare(page);
  await askFromHome(page, 'Engine failure on climb out');
  // Nine more searches from this browser (its trial cookie), each with the test widget's token.
  const statuses = await page.evaluate(async (token) => {
    const out: number[] = [];
    for (let i = 2; i <= 10; i++) {
      const r = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'question', question: `Engine failure, search ${i}`, idempotencyKey: crypto.randomUUID(), turnstileToken: token }),
      });
      out.push(r.status);
    }
    return out;
  }, DUMMY_TOKEN);
  expect(statuses).toEqual(Array(9).fill(201));
  const status = await (await page.request.get('/api/ai/status')).json();
  expect(status).toMatchObject({ state: 'signed_in_only', reason: 'trial_used', remaining: { kind: 'trial', left: 0, limit: 10 } });
  expect(new Date(status.retryAt as string).toISOString()).toMatch(/T00:00:00\.000Z$/);

  // Sign-in is not offered here: the counter and the button say so, and asking explains.
  await page.goto('/');
  await expect(page.getByRole('banner').getByText('Free AI searches used')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill('Engine failure, one more');
  await page.getByRole('button', { name: /^Ask AI/ }).click({ force: true });
  await expect(page.getByText('That was your tenth free AI search today.')).toBeVisible();
  await expect(page.getByText('Free AI searches return at 00:00 UTC.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Search by keyword instead' })).toBeVisible();
  await shot(page, 'trial-used-1280-day');

  // The server refuses an eleventh itself.
  const eleventh = await page.evaluate(async (token) => {
    const r = await fetch('/api/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'question', question: 'Engine failure, search 11', idempotencyKey: crypto.randomUUID(), turnstileToken: token }),
    });
    return { status: r.status, body: (await r.json()) as { error?: string } };
  }, DUMMY_TOKEN);
  expect(eleventh).toMatchObject({ status: 429, body: { error: 'trial_used' } });
  // Only that refusal is logged by the browser.
  expect(problems.filter((p) => !/status of 429 \(Too Many Requests\): \/api\/evidence$/.test(p))).toEqual([]);
});

test('the known context-loss examples: the initial card, drawer, Compare and print show the whole paragraph with its antecedent', async ({ page }) => {
  const problems = await watchPage(page);
  await prepare(page);
  // The server's projection of the canonical texts (tests/support/context-loss.ts), served for its search id;
  // the corpus fixture lacks these cases, so their case pages are stand-ins with the record's texts only.
  const { snapshotDate } = (await (await page.request.get('/api/config')).json()) as { snapshotDate: string };
  await page.route(
    (url) => url.pathname === `/api/evidence/${CONTEXT_LOSS_SEARCH_ID}`,
    (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: contextLossPageJson() }),
  );
  for (const example of CONTEXT_LOSS_EXAMPLES) {
    await page.route(
      (url) => url.pathname === `/api/cases/${example.ntsbNo}`,
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(contextLossDetail(example, snapshotDate)) }),
    );
  }
  const replay = contextLossPage();
  const whole = async (scope: ReturnType<Page['locator']>, example: (typeof CONTEXT_LOSS_EXAMPLES)[number]) => {
    const paragraph = contextLossParagraph(replay, example);
    const quote = scope.locator('figure[data-excerpt] blockquote').filter({ hasText: example.quote });
    await expect(quote).toBeVisible();
    // (a synonym mark's screen-reader suffix aside: these paragraphs mark literal words only)
    const shown = normalized((await quote.innerText()).replaceAll(' (synonym)', ''));
    expect(shown, example.ntsbNo).toBe(normalized(paragraph));
    for (const anchor of example.anchors) expect(shown, `${example.ntsbNo}: ${anchor}`).toContain(anchor);
    // Not folded: the whole paragraph is laid out, nothing clipped below a fade.
    expect(await quote.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  };

  await page.goto(`/ai/${CONTEXT_LOSS_SEARCH_ID}`);
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  for (const example of CONTEXT_LOSS_EXAMPLES) await whole(page.locator(`article[data-card="${example.ntsbNo}"]`), example);
  await shot(page, 'context-loss-cards-1280-day', { fullPage: true });

  // Print, from the sheet: the same paragraphs, whole.
  await page.emulateMedia({ media: 'print' });
  for (const example of CONTEXT_LOSS_EXAMPLES) await whole(page.locator(`article[data-card="${example.ntsbNo}"]`), example);
  await expect(page.getByRole('note').first()).toBeVisible();
  await shot(page, 'context-loss-print-1280', { fullPage: true });
  await page.emulateMedia({ media: 'screen' });

  // The drawer, opened from each card.
  for (const example of CONTEXT_LOSS_EXAMPLES) {
    await page.locator(`article[data-card="${example.ntsbNo}"]`).getByRole('link', { name: example.ntsbNo, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(`^${example.ntsbNo}: `) });
    const section = drawer.getByRole('region', { name: EVIDENCE_HEADING });
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole('note')).toHaveText(EVIDENCE_NOTICE);
    await whole(section, example);
    if (example === CONTEXT_LOSS_EXAMPLES[0]) await shot(page, 'context-loss-drawer-1280-day');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  }

  // Compare: each strip's evidence row, on screen and in print.
  await page.goto(`/compare?cases=${CONTEXT_LOSS_EXAMPLES.map((e) => e.ntsbNo).join(',')}&evidence=${CONTEXT_LOSS_SEARCH_ID}&pages=1`);
  await expect(page.locator('[data-compare-evidence]').getByRole('note')).toHaveText(EVIDENCE_NOTICE);
  for (const [i, example] of CONTEXT_LOSS_EXAMPLES.entries()) {
    await whole(page.getByRole('article', { name: `${example.ntsbNo}, strip ${i + 1}` }).locator('[data-strip-evidence]'), example);
  }
  await shot(page, 'context-loss-compare-1280-day', { fullPage: true });
  await page.emulateMedia({ media: 'print' });
  for (const [i, example] of CONTEXT_LOSS_EXAMPLES.entries()) {
    await whole(page.getByRole('article', { name: `${example.ntsbNo}, strip ${i + 1}` }).locator('[data-strip-evidence]'), example);
  }
  await page.emulateMedia({ media: 'screen' });
  expect(problems).toEqual([]);
});
