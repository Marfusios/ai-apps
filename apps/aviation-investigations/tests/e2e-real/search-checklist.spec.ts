/**
 * The search checklist and ratings (UI_DESIGN §4.10, §4.11; Task 25) against the real server: the
 * live-configuration app of tests/e2e-real/server.ts, which runs what live runs (the question alone,
 * the leading results put in order by the reranker, here the fake one) over the fixture corpus,
 * with offline fakes for every provider. Its fake scope stage and reranker each take about a second,
 * and its answer to the search waits a little once the search is done, so the checklist's reads see
 * each stage under way and then the finished search.
 *
 * Covered: a visitor's first anonymous search, sent with no trial cookie yet, ticks from the
 * server's own progress (bound to the visitor's network until the trial exists): the question's
 * result, as many cases as the results page then counts, and AI's order; its progress reads carry
 * no trial cookie either. A second search, with the trial cookie on its POST and its reads, ticks
 * the same way; every read used the POST's own idempotency key, and the reads that saw stages under
 * way and the finished search were answered 200, not a fallback. Then
 * the visitor rates a search Useful, and changes it to Not useful, each kept (204). Every test fails
 * on a CSP violation, a page error or a request that would leave the machine.
 */
import { expect, test, type Page } from '@playwright/test';
import type { EvidenceProgress } from '../../shared/contracts/evidence.js';
import { FAKE_TURNSTILE } from '../e2e/fake-turnstile.js';
import { E2E_QUESTIONS } from './evidence-fakes.js';
import { watchPage } from './watch.js';

/** The live-configuration app (tests/e2e-real/server.ts). */
const LIVE = `http://127.0.0.1:${Number(process.env.E2E_REAL_LIVE_PORT) || (Number(process.env.E2E_REAL_PORT) || 5181) + 4}`;
const HEADING = 'Investigations retrieved for your search';
const TRIAL_COOKIE = /(^|;\s*)(__Host-)?aviation_trial=/;

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
  await page.addInitScript(FAKE_TURNSTILE);
  await page.addInitScript('window.__checkDelay = 60;');
});
test.afterEach(async ({ page }) => {
  expect(outside.get(page), 'requests that would leave the machine').toEqual([]);
});

interface Sent {
  key: string;
  /** The POST carried the visitor's trial cookie. */
  trialCookie: boolean;
}

interface Read {
  key: string;
  status: number;
  body: EvidenceProgress | null;
  /** The read carried the visitor's trial cookie. */
  trialCookie: boolean;
}

/** Every `POST /api/evidence` (its key and whether it carried a trial cookie) and every progress read, with its answer. */
function record(page: Page): { sent: Sent[]; reads: Read[]; settled: () => Promise<void> } {
  const sent: Sent[] = [];
  const reads: Read[] = [];
  const pending: Promise<void>[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'POST' || url.pathname !== '/api/evidence') return;
    const one: Sent = { key: (request.postDataJSON() as { idempotencyKey: string }).idempotencyKey, trialCookie: false };
    sent.push(one);
    // The cookie header is among the headers the browser adds itself.
    pending.push(request.allHeaders().then((headers) => void (one.trialCookie = TRIAL_COOKIE.test(headers.cookie ?? ''))));
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/evidence/progress/')) return;
    const read: Read = { key: decodeURIComponent(url.pathname.split('/').pop() ?? ''), status: response.status(), body: null, trialCookie: false };
    reads.push(read);
    pending.push(
      response
        .request()
        .allHeaders()
        .then((headers) => void (read.trialCookie = TRIAL_COOKIE.test(headers.cookie ?? ''))),
    );
    if (response.status() === 200) {
      pending.push(
        response.json().then(
          (body: unknown) => void (read.body = body as EvidenceProgress),
          () => undefined,
        ),
      );
    }
  });
  return { sent, reads, settled: async () => void (await Promise.all(pending)) };
}

const card = (page: Page) => page.getByRole('region', { name: 'Search checklist' });
const result = (page: Page, row: 'question' | 'search' | 'order') => card(page).locator(`[data-row="${row}"] [data-result]`);
const tick = (page: Page, row: 'question' | 'search' | 'order') => card(page).locator(`[data-row="${row}"] [data-tick]`);

/**
 * Asks `question` from the box on Home and watches the checklist tick through to the finished
 * search: the question's result, the cases found and AI's order, each with its ✓; returns the cases
 * the card counted once the results page is open.
 */
async function askAndWatch(page: Page, question: string, button: RegExp): Promise<number> {
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(question);
  await page.getByRole('button', { name: button }).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('search').getByRole('button', { name: 'Searching…' })).toBeVisible();
  // A stage under way, read from the server: the question first (a second at the fake scope stage).
  await expect(card(page).locator('[aria-current="step"]')).toHaveCount(1);
  // Each row's result as the server reports it, with its tick, before the results open.
  await expect(result(page, 'question')).toHaveText('READ · SUGGESTIONS READY');
  await expect(tick(page, 'question')).toBeVisible();
  await expect(result(page, 'search')).toHaveText(/^\d+ CASES?$/);
  await expect(tick(page, 'search')).toBeVisible();
  const counted = Number((await result(page, 'search').textContent())?.split(' ')[0]);
  await expect(result(page, 'order')).toHaveText('ORDERED BY AI');
  await expect(tick(page, 'order')).toBeVisible();
  // Then the results, as many as the card counted, in AI's order; the card is gone.
  await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible();
  await expect(page.locator('[data-count-line]')).toHaveText(new RegExp(`^${counted} retrieved · leading results ordered by AI for relevance · not every matching investigation$`));
  await expect(card(page)).toHaveCount(0);
  return counted;
}

/** The progress reads of one search: all under its key, the stages seen under way and then the finished search, each read answered 200. */
function checkReads(reads: readonly Read[], key: string): void {
  const own = reads.filter((r) => r.key === key);
  expect(own.length).toBeGreaterThan(0);
  const answered = own.filter((r) => r.status === 200).map((r) => r.body as EvidenceProgress);
  // Only 404s besides (before the server registered the search), never another status.
  expect(own.filter((r) => r.status !== 200 && r.status !== 404)).toEqual([]);
  expect(answered.some((p) => p.state === 'running' && p.question.status === 'running')).toBe(true);
  expect(answered.some((p) => p.state === 'running' && p.order.status === 'running')).toBe(true);
  const done = answered.find((p) => p.state === 'done');
  expect(done).toMatchObject({ question: { status: 'done', result: 'suggestions' }, search: { status: 'done' }, order: { status: 'done', result: 'ai_relevance' } });
}

test('a first anonymous search ticks from the real server’s progress, and so does the next, with the trial cookie; every read used the POST’s key', async ({ page }) => {
  const problems = await watchPage(page);
  const { sent, reads, settled } = record(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${LIVE}/`);

  // The first search: no trial cookie yet, so its reads are bound to this visitor's network.
  const first = await askAndWatch(page, E2E_QUESTIONS.carb, /^Ask AI · 10 free$/);
  expect(first).toBeGreaterThan(0);
  await settled();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.trialCookie).toBe(false);

  // The second, from Home again, now with the trial cookie the first search set.
  await page.goto(`${LIVE}/`);
  await askAndWatch(page, 'Carburetor icing in cruise flight', /^Ask AI · 9 free$/);
  await settled();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.trialCookie).toBe(true);

  // Every read used the key its POST was sent under; each search's reads saw it under way and finished.
  await settled();
  const keys = sent.map((s) => s.key);
  expect([...new Set(reads.map((r) => r.key))].sort()).toEqual([...keys].sort());
  for (const key of keys) checkReads(reads, key);
  // The first search's reads carried no trial cookie, as its POST did not: the server bound them to
  // this visitor's network. The second search's reads carried the cookie the first one set.
  const readsOf = (key: string | undefined) => reads.filter((r) => r.key === key);
  expect(readsOf(keys[0]).length).toBeGreaterThan(0);
  expect(readsOf(keys[0]).filter((r) => r.trialCookie)).toEqual([]);
  expect(readsOf(keys[1]).length).toBeGreaterThan(0);
  expect(readsOf(keys[1]).every((r) => r.trialCookie)).toBe(true);
  expect(problems).toEqual([]);
});

test('a visitor rates a search Useful, then changes it to Not useful: each kept (204), the choice shown', async ({ page }) => {
  const problems = await watchPage(page);
  const ratings: { body: unknown; status: number }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.request().method() === 'POST' && /^\/api\/evidence\/[0-9a-f-]{36}\/feedback$/.test(url.pathname)) {
      ratings.push({ body: response.request().postDataJSON() as unknown, status: response.status() });
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${LIVE}/`);
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(E2E_QUESTIONS.carb);
  await page.getByRole('button', { name: /^Ask AI · 10 free$/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible({ timeout: 15_000 });

  const rating = page.locator('[data-search-rating]');
  await rating.scrollIntoViewIfNeeded();
  await expect(rating.getByRole('group', { name: 'Was this search useful?' })).toBeVisible();
  const useful = rating.getByRole('button', { name: 'Useful', exact: true });
  const notUseful = rating.getByRole('button', { name: 'Not useful', exact: true });
  await useful.click();
  await expect(rating.locator('[data-rating-status]')).toHaveText('Thanks — noted.');
  await expect(useful).toHaveAttribute('aria-pressed', 'true');
  await expect(notUseful).toHaveAttribute('aria-pressed', 'false');
  await notUseful.click();
  await expect(notUseful).toHaveAttribute('aria-pressed', 'true');
  await expect(useful).toHaveAttribute('aria-pressed', 'false');
  await expect(rating.locator('[data-rating-status]')).toHaveText('Thanks — noted.');
  await expect.poll(() => ratings.length).toBe(2);
  expect(ratings).toEqual([
    { body: { rating: 'useful' }, status: 204 },
    { body: { rating: 'not_useful' }, status: 204 },
  ]);
  expect(problems).toEqual([]);
});
