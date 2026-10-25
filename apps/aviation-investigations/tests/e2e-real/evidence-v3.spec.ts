/**
 * The evidence view's `evidence.v3` disclosures end to end (UI_DESIGN §4.9): the production build
 * against the real server's second app (tests/e2e-real/server.ts, E2E_REAL_V3_PORT), whose evidence
 * policies are the ones the evaluation may pick (a state the question names applied automatically,
 * `state-explicit.v1.1`; the suggested terms searched beside the question and the leading results
 * ordered by the fake reranker, `er-qt-h50-v1`), over the fixture corpus with offline fakes for every
 * provider. Covered: the automatic state and the added terms, each said and removable; AI's order in
 * the count line; the suggestion keeping only what was not used; the one free undo, which the server
 * makes without using one of the visitor's searches, once per search; and the free undo at zero
 * searches left, through the usual check. Every test fails on a CSP violation, a page error or a
 * request that would leave the machine.
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the flow there.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EVIDENCE_HEADING, EVIDENCE_NOTICE, EVIDENCE_SUGGESTION_LABEL } from '../../shared/contracts/evidence.js';
import { FAKE_TURNSTILE } from '../e2e/fake-turnstile.js';
import { E2E_QUESTIONS, STATE_SUGGESTION } from './evidence-fakes.js';
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
const texasChip = (page: Page) => yours(page).getByRole('button', { name: /^Location: Texas\s*,\s*added automatically from your question\s*,\s*remove$/ });
const termsChip = (page: Page, edited = false) => yours(page, edited).getByRole('button', { name: new RegExp(`^“${STATE_SUGGESTION.terms}”\\s*,\\s*added by AI\\s*,\\s*remove$`) });

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

test('a state the question names is applied and said, the added terms are said, AI’s order is said; removing them is free, once', async ({ page }) => {
  const problems = await watchPage(page);
  const api = recordApi(page);
  await prepare(page);
  const asked = await askFromHome(page, E2E_QUESTIONS.state);
  // The question alone was sent: what was applied, the server applied.
  expect(searches(api).map((c) => c.body)).toEqual([{ kind: 'question', question: E2E_QUESTIONS.state, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN }]);
  await expect(counter(page, 9)).toBeVisible();
  // The server says the search's one free undo is there.
  expect(await (await page.request.get(`/api/evidence/${asked}?page=1`)).json()).toMatchObject({ undo: 'available', freeUndo: false });
  // The state, a normal applied chip with its tag; the terms, with the AI's tag.
  await expect(texasChip(page)).toBeVisible();
  await expect(texasChip(page).locator('[data-automatic-tag]')).toHaveText('from your question');
  await expect(termsChip(page)).toBeVisible();
  await expect(yours(page).locator('dt').filter({ hasText: 'Also searched' })).toBeVisible();
  await expect(page.locator('[data-count-line]')).toHaveText(/^\d+ retrieved · leading results ordered by AI for relevance · not every matching investigation$/);
  await expect(page.locator('[data-legend]')).toHaveAttribute('data-legend', 'searched');
  await expect(page.getByRole('note').first()).toHaveText(EVIDENCE_NOTICE);
  // Every case meets the state the server applied.
  const relevance = page.locator('article[data-card] [data-relevance]');
  await expect(relevance.first()).toBeVisible();
  for (const line of await relevance.allInnerTexts()) expect(line.replace(/\s+/g, ' ').trim()).toMatch(/^How it was found: Location: Texas · /);
  // The suggestion keeps the phase only, with its note.
  const suggestion = page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL });
  await expect(suggestion).toContainText('AI suggested these as well. AirCase applies none of them unless you choose them.');
  await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
  await expect(suggestion).not.toContainText(STATE_SUGGESTION.terms);
  await shot(page, 'real-v3-search-1280-day');

  // The undo: both additions out, "free", and the server agrees.
  await texasChip(page).click();
  await termsChip(page).click();
  await yours(page).getByRole('button', { name: 'Search again · free' }).click();
  await expect(yours(page, true)).toBeVisible();
  const undone = searchIdOf(page);
  expect(undone).not.toBe(asked);
  expect(searches(api)[1]?.body).toEqual({ kind: 'edited', from: asked, filters: {}, keywords: 'question', idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN });
  await expect(page.locator('[data-undo-charged]')).toHaveCount(0);
  const page1 = await (await page.request.get(`/api/evidence/${undone}?page=1`)).json();
  expect(page1).toMatchObject({ freeUndo: true, undo: 'none', automaticFilters: null, appliedFilters: {}, query: { source: 'question', keywords: { kind: 'question' } } });
  // The first search's undo is used now, read from the server's claim.
  expect(await (await page.request.get(`/api/evidence/${asked}?page=1`)).json()).toMatchObject({ undo: 'used' });
  // It used none of the visitor's searches.
  await expect(counter(page, 9)).toBeVisible();
  await expect(yours(page, true).locator('[data-added-terms], [data-automatic]')).toHaveCount(0);
  await shot(page, 'real-v3-undone-1280-day');

  // Back on the first search: its page says its undo is used, so the next one says it uses one, and the server counts it.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/ai/${asked}`));
  await texasChip(page).click();
  await yours(page).getByRole('button', { name: 'Search again · uses 1' }).click();
  await expect(yours(page, true)).toBeVisible();
  const charged = await (await page.request.get(`/api/evidence/${searchIdOf(page)}?page=1`)).json();
  expect(charged).toMatchObject({ freeUndo: false, appliedFilters: {} });
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
  await texasChip(page).click();
  const again = yours(page).getByRole('button', { name: 'Search again · free' });
  await expect(again).toHaveAttribute('aria-disabled', 'false');
  await shot(page, 'real-v3-zero-left-390-day');
  await again.click();
  await expect(yours(page, true)).toBeVisible();
  expect(searches(api).at(-1)?.body).toEqual({ kind: 'edited', from: asked, filters: {}, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN });
  const made = await (await page.request.get(`/api/evidence/${searchIdOf(page)}?page=1`)).json();
  expect(made).toMatchObject({ freeUndo: true });
  // Still none left: the server took nothing.
  const status = await (await page.request.get('/api/ai/status')).json();
  expect(status).toMatchObject({ state: 'signed_in_only', reason: 'trial_used', remaining: { kind: 'trial', left: 0 } });
  // The undo's own search has none: anything else stays off.
  await termsChip(page, true).click();
  await expect(yours(page, true).getByRole('button', { name: /^Search again/ })).toHaveAttribute('aria-disabled', 'true');
  expect(problems).toEqual([]);
});
