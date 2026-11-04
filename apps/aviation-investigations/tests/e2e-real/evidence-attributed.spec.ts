/**
 * The attributed policy end to end (Task 30, UI_DESIGN §4.9): the production build against the real
 * server's fourth app (tests/e2e-real/server.ts, E2E_REAL_FIELDS_PORT), which runs `attributed.v1` on
 * live's ranking (`er-q-h50-v1`) over the fixture corpus, with offline fakes for every provider: the
 * scripted scope stage and the scripted attribution check (one check per value, attr.a2,
 * tests/e2e-real/evidence-fakes.ts) behind the server's own candidate rules, decision, metering and
 * storage. Covered: a state, years and an aircraft type the question names, applied on their own,
 * each a chip tagged "from your question", with the fixed note; taking the years out, the search's
 * one free undo, which the server makes without using one of the visitor's searches; and the stored
 * search, read again with its automatic filters (stored through migration 0030's guard). Every test
 * fails on a CSP violation, a page error or a request that would leave the machine.
 *
 * `E2E_SCREENSHOTS=<dir>` keeps screenshots of the flow there.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EVIDENCE_HEADING, EVIDENCE_SUGGESTION_LABEL } from '../../shared/contracts/evidence.js';
import { FAKE_TURNSTILE } from '../e2e/fake-turnstile.js';
import { E2E_QUESTIONS, FIELDS_SUGGESTION } from './evidence-fakes.js';
import { watchPage } from './watch.js';

test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_REAL_FIELDS_PORT) || 5186}` });

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
/** The fixed words under automatic filters (web/src/features/evidence/display.ts), with the undo there and without. */
const AUTOMATIC_NOTE = 'AI applied the filters marked “from your question”.';
const AUTOMATIC_NOTE_FREE = `${AUTOMATIC_NOTE} Remove any that are wrong: taking out everything AI added is free once.`;
const AUTOMATIC = { state: ['TX'], yearFrom: 2008, category: ['HELI'] };

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
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
const automaticChip = (page: Page, label: string) =>
  yours(page).getByRole('button', { name: new RegExp(`^${label}\\s*,\\s*added automatically from your question\\s*,\\s*remove$`) });

test('a state, years and an aircraft type the question names are applied, tagged and noted; taking the years out is free; the stored search reads them again', async ({ page }) => {
  const problems = await watchPage(page);
  const api = recordApi(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(`localStorage.setItem('casebook-theme', 'day')`);
  await page.addInitScript(`window.__checkDelay = 60;`);
  await page.addInitScript(FAKE_TURNSTILE);
  // The configuration says the policy applies all three.
  expect(await (await page.request.get('/api/config')).json()).toMatchObject({ aiAutomaticFilters: ['state', 'years', 'category'] });

  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(E2E_QUESTIONS.fields);
  await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
  await expect(page).toHaveURL(SEARCH_PATH);
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  const asked = searchIdOf(page);
  // The question alone was sent: what was applied, the server applied.
  expect(searches(api).map((c) => c.body)).toEqual([{ kind: 'question', question: E2E_QUESTIONS.fields, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN }]);
  await expect(counter(page, 9)).toBeVisible();
  // The server applied the three on its own, once its check approved each value, and stored them.
  expect(await (await page.request.get(`/api/evidence/${asked}?page=1`)).json()).toMatchObject({
    automaticFilters: AUTOMATIC,
    appliedFilters: AUTOMATIC,
    query: { source: 'question', keywords: { kind: 'question' } },
    undo: 'available',
    freeUndo: false,
    suggestion: { filters: { phase: ['approach'] }, terms: FIELDS_SUGGESTION.terms },
  });

  // Three applied chips, each tagged, and under them the fixed note.
  await expect(yours(page).locator('[data-automatic]')).toHaveCount(3);
  for (const label of ['Aircraft: Helicopter', 'Location: Texas', 'Years: from 2008']) {
    await expect(automaticChip(page, label).locator('[data-automatic-tag]')).toHaveText('from your question');
  }
  await expect(yours(page).locator('[data-automatic-note]')).toHaveText(AUTOMATIC_NOTE_FREE);
  // Every case meets the three, and says so.
  const relevance = page.locator('article[data-card] [data-relevance]');
  await expect(relevance.first()).toBeVisible();
  for (const line of (await relevance.allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim())) {
    expect(line).toMatch(/^How it was found: Aircraft: Helicopter · Location: Texas · Years: from 2008 · /);
  }
  // The suggestion keeps only what was not applied.
  const suggestion = page.getByRole('region', { name: EVIDENCE_SUGGESTION_LABEL });
  await expect(suggestion.getByRole('list', { name: 'Suggested filters' })).toHaveText('Phase: Approach');
  await expect(suggestion).toContainText(`“${FIELDS_SUGGESTION.terms}”`);
  await shot(page, 'real-fields-search-1280-day');

  // Taking the years out: "free", and the server agrees; none of the visitor's searches is used.
  await automaticChip(page, 'Years: from 2008').click();
  await expect(yours(page).locator('[data-automatic]')).toHaveCount(2);
  await yours(page).getByRole('button', { name: 'Search again · free' }).click();
  await expect(yours(page, true)).toBeVisible();
  const undone = searchIdOf(page);
  expect(undone).not.toBe(asked);
  expect(searches(api)[1]?.body).toEqual({ kind: 'edited', from: asked, filters: { category: ['HELI'], state: ['TX'] }, idempotencyKey: expect.any(String), turnstileToken: DUMMY_TOKEN });
  await expect(page.locator('[data-undo-charged]')).toHaveCount(0);
  expect(await (await page.request.get(`/api/evidence/${undone}?page=1`)).json()).toMatchObject({
    freeUndo: true,
    undo: 'none',
    automaticFilters: null,
    appliedFilters: { state: ['TX'], category: ['HELI'] },
  });
  await expect(counter(page, 9)).toBeVisible();
  expect(await (await page.request.get('/api/ai/status')).json()).toMatchObject({ state: 'available', remaining: { kind: 'trial', left: 9 } });
  await expect(yours(page, true).locator('[data-automatic], [data-automatic-note]')).toHaveCount(0);
  await shot(page, 'real-fields-undone-1280-day');

  // The first search, loaded again from what the server stored: its automatic filters, tagged; its undo used.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/ai/${asked}`));
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })).toBeVisible();
  await expect(yours(page).locator('[data-automatic]')).toHaveCount(3);
  await expect(automaticChip(page, 'Years: from 2008')).toBeVisible();
  await expect(yours(page).locator('[data-automatic-note]')).toHaveText(AUTOMATIC_NOTE);
  expect(await (await page.request.get(`/api/evidence/${asked}?page=1`)).json()).toMatchObject({ automaticFilters: AUTOMATIC, appliedFilters: AUTOMATIC, undo: 'used' });
  expect(searches(api)).toHaveLength(2);
  expect(problems).toEqual([]);
});
