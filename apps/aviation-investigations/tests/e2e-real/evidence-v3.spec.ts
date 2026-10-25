/**
 * The evidence view's `evidence.v3` disclosures end to end (UI_DESIGN §4.9): the production build
 * against the real server's second app (tests/e2e-real/server.ts, E2E_REAL_V3_PORT), which runs the
 * configuration live runs (the question alone in keyword search, in match order, `er-q-v1`; a state
 * the question names applied automatically by the guarded policy, `state-explicit.v1.3`), over the
 * fixture corpus with offline fakes for every provider. Covered: the automatic state, said and
 * removable; the suggested terms marked and said so; "highest-ranked first"; the suggestion keeping
 * the rest, terms included, under its note for a search AirCase added to; the state's one free undo,
 * which the server makes without using one of the visitor's searches, once per search; and the free
 * undo at zero searches left, through the usual check. The other configurations the evaluation may
 * pick are covered against the mock (tests/e2e/evidence.spec.ts) and the server's own tests. Every
 * test fails on a CSP violation, a page error or a request that would leave the machine.
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the flow there.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EVIDENCE_HEADING, EVIDENCE_NOTICE, EVIDENCE_SUGGESTION_LABEL } from '../../shared/contracts/evidence.js';
import { FAKE_TURNSTILE } from '../e2e/fake-turnstile.js';
import { E2E_QUESTIONS, STATE_MARKED_SUGGESTION } from './evidence-fakes.js';
import { watchPage } from './watch.js';

test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_REAL_V3_PORT) || 5184}` });

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
const searchIdOf = (page: Page): string => SEARCH_PATH.exec(page.url())?.[1] ?? '';
const counter = (page: Page, left: number) => page.getByRole('banner').getByText(`AI searches left: ${left} of 10`);
const yours = (page: Page, edited = false) => page.getByRole('region', { name: edited ? 'Your edited search' : 'Your search', exact: true });
const stateChip = (page: Page, state: 'Texas' | 'Missouri') =>
  yours(page).getByRole('button', { name: new RegExp(`^Location: ${state}\\s*,\\s*added automatically from your question\\s*,\\s*remove$`) });

async function prepare(page: Page, { width = 1280, checkDelay = 60 } = {}): Promise<void> {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  await page.addInitScript(`localStorage.setItem('casebook-theme', 'day')`);
  await page.addInitScript(`window.__checkDelay = ${checkDelay};`);
  await page.addInitScript(FAKE_TURNSTILE);
}

async function askFromHome(page: Page, question: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(question);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page).toHaveURL(SEARCH_PATH);
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  return searchIdOf(page);
}

test('a state the question names is applied and said; the suggested terms are marked and suggested; highest-ranked first; removing the state is free, once', async ({ page }) => {
  const problems = await watchPage(page);
  const api = recordApi(page);
  await prepare(page);
  const asked = await askFromHome(page, E2E_QUESTIONS.stateMarked);
  // The question alone was sent: what was applied, the server applied.
  expect(searches(api).map((c) => c.body)).toEqual([{ kind: 'question', question: E2E_QUESTIONS.stateMarked, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN }]);
  await expect(counter(page, 9)).toBeVisible();
  // The server says what it applied and that the search's one free undo is there.
  expect(await (await page.request.get(`/api/evidence/${asked}?page=1`)).json()).toMatchObject({
    automaticFilters: { state: ['MO'] },
    query: { source: 'question', keywords: { kind: 'question' } },
    order: 'match',
    marks: 'suggested_terms',
    undo: 'available',
    freeUndo: false,
  });
  // The state, a normal applied chip with its tag; nothing was added to keyword search.
  await expect(stateChip(page, 'Missouri')).toBeVisible();
  await expect(stateChip(page, 'Missouri').locator('[data-automatic-tag]')).toHaveText('from your question');
  await expect(yours(page).locator('[data-added-terms], [data-keywords-note]')).toHaveCount(0);
  await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · highest-ranked first · not every matching investigation$/);
  // The suggested terms are marked, and said so.
  await expect(page.locator('[data-legend]')).toHaveAttribute('data-legend', 'suggested');
  await expect(page.locator('[data-legend]')).toHaveText(/^Marked in the excerpts: the suggested terms · .*their synonyms$/);
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  // Every case meets the state the server applied; the suggested terms are found in the excerpts.
  const relevance = page.locator('article[data-card] [data-relevance]');
  await expect(relevance.first()).toBeVisible();
  const lines = (await relevance.allInnerTexts()).map((line) => line.replace(/\s+/g, ' ').trim());
  for (const line of lines) expect(line).toMatch(/^How it was found: Location: Missouri · /);
  expect(lines.some((line) => line.includes('Suggested terms in these excerpts:'))).toBe(true);
  // The suggestion keeps the phase and the terms, with the note for a search AirCase added to.
  const suggestion = page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL });
  await expect(suggestion).toContainText('AI suggested these as well. AirCase applies none of them unless you choose them.');
  await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
  await expect(suggestion).toContainText(`“${STATE_MARKED_SUGGESTION.terms}”`);
  await expect(suggestion.getByRole('button', { name: /^Apply these filters\s*·\s*uses 1$/ })).toBeVisible();
  await expect(suggestion.getByRole('button', { name: /^Apply filters and terms\s*·\s*uses 1$/ })).toBeVisible();
  await shot(page, 'real-release-search-1280-day');

  // The undo: the state out, "free", and the server agrees.
  await stateChip(page, 'Missouri').click();
  await yours(page).getByRole('button', { name: 'Search again · free' }).click();
  await expect(yours(page, true)).toBeVisible();
  const undone = searchIdOf(page);
  expect(undone).not.toBe(asked);
  expect(searches(api)[1]?.body).toEqual({ kind: 'edited', from: asked, filters: {}, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN });
  await expect(page.locator('[data-undo-charged]')).toHaveCount(0);
  const page1 = await (await page.request.get(`/api/evidence/${undone}?page=1`)).json();
  expect(page1).toMatchObject({ freeUndo: true, undo: 'none', automaticFilters: null, appliedFilters: {}, query: { source: 'question', keywords: { kind: 'question' } } });
  // The first search's undo is used now, read from the server's claim.
  expect(await (await page.request.get(`/api/evidence/${asked}?page=1`)).json()).toMatchObject({ undo: 'used' });
  // It used none of the visitor's searches.
  await expect(counter(page, 9)).toBeVisible();
  await expect(yours(page, true).locator('[data-automatic]')).toHaveCount(0);
  await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · highest-ranked first/);
  await shot(page, 'real-release-undone-1280-day');

  // Back on the first search: its page says its undo is used, so the next one says it uses one, and the server counts it.
  // (That edit kept the question alone with no filter left, so its page reads as a question's own search.)
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/ai/${asked}`));
  await stateChip(page, 'Missouri').click();
  await yours(page).getByRole('button', { name: 'Search again · uses 1' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/ai/(?:${asked}|${undone})`));
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  const charged = await (await page.request.get(`/api/evidence/${searchIdOf(page)}?page=1`)).json();
  expect(charged).toMatchObject({ freeUndo: false, undo: 'none', automaticFilters: null, appliedFilters: {} });
  await expect(counter(page, 8)).toBeVisible();
  expect(searches(api)).toHaveLength(3);
  expect(problems).toEqual([]);
});

test('with no searches left the free undo still runs, through the usual check; charged actions stay off', async ({ page }) => {
  const problems = await watchPage(page);
  const api = recordApi(page);
  await prepare(page, { width: 390 });
  const asked = await askFromHome(page, E2E_QUESTIONS.state);
  // Nine more from this browser: none left today.
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
  await page.goto(`/ai/${asked}`);
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  // Sign-in is not offered on this server: the counter says the free searches are used.
  await expect(page.getByRole('banner').getByText('Free AI searches used')).toBeVisible();
  await expect(page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL }).getByRole('button', { name: /^Apply these filters/ })).toHaveAttribute('aria-disabled', 'true');
  await stateChip(page, 'Texas').click();
  const again = yours(page).getByRole('button', { name: 'Search again · free' });
  await expect(again).toHaveAttribute('aria-disabled', 'false');
  await shot(page, 'real-release-zero-left-390-day');
  await again.click();
  await expect(yours(page, true)).toBeVisible();
  expect(searches(api).at(-1)?.body).toEqual({ kind: 'edited', from: asked, filters: {}, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN });
  const made = await (await page.request.get(`/api/evidence/${searchIdOf(page)}?page=1`)).json();
  expect(made).toMatchObject({ freeUndo: true });
  // Still none left: the server took nothing.
  const status = await (await page.request.get('/api/ai/status')).json();
  expect(status).toMatchObject({ state: 'signed_in_only', reason: 'trial_used', remaining: { kind: 'trial', left: 0 } });
  // The undo's own search has none: anything else stays off.
  await yours(page, true).getByRole('button', { name: 'Use your own words' }).click();
  await yours(page, true).getByRole('textbox', { name: 'Search words' }).fill('carburetor');
  await yours(page, true).getByRole('textbox', { name: 'Search words' }).press('Enter');
  await expect(yours(page, true).getByRole('button', { name: /^Search again/ })).toHaveAttribute('aria-disabled', 'true');
  expect(problems).toEqual([]);
});

test('the configuration says the server applies states, and Explore’s AI nudge says so', async ({ page }) => {
  const problems = await watchPage(page);
  await prepare(page, { width: 390 });
  expect(await (await page.request.get('/api/config')).json()).toMatchObject({ aiAutomaticFilters: ['state'] });
  await page.goto('/explore?q=carburetor+icing');
  await expect(
    page.getByText('Ask in plain English: AirCase searches with your question. A US state it names explicitly can be applied automatically, and you can remove it; everything else AI suggests stays a suggestion.'),
  ).toBeVisible();
  expect(problems).toEqual([]);
});
