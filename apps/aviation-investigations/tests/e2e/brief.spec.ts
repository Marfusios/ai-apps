import { expect, test, type Page } from '@playwright/test';
import { FAKE_TURNSTILE } from './fake-turnstile.js';

/**
 * AI briefs that exist, against the mock API (web/mock/briefs.ts, the fake provider's
 * hand-written seed readings). The interface no longer starts briefs (Task 23: Ask AI starts an
 * AI evidence search, tests/e2e/evidence.spec.ts), so each test makes one through the mock API
 * from the page, as the trial's request would, and opens it by its link without a reload (the
 * mock keeps it in the page's memory). Cloudflare's Turnstile is a local stand-in
 * (tests/e2e/fake-turnstile.ts).
 */

const SEED_QUESTION = 'Engine power loss shortly after maintenance';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_TURNSTILE);
  await page.emulateMedia({ colorScheme: 'light' });
});

/**
 * A brief that exists: made through the mock API from the page, then opened by its link (no
 * reload). With `searchedFirst`, the visitor first asks an AI search on Home, so the trial's
 * first check (the visible one) is behind them, as it would be for anyone holding a brief.
 */
async function ask(page: Page, question: string, { searchedFirst = false } = {}): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Ask AI · \d+ free$/ })).toBeVisible();
  if (searchedFirst) {
    await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill('Carb icing on approach');
    await page.getByRole('button', { name: /^Ask AI · \d+ free$/ }).click();
    await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('banner').getByText('AI searches left: 9 of 10')).toBeVisible();
  }
  const id = await page.evaluate(async (q) => {
    const response = await fetch('/api/briefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: q, idempotencyKey: crypto.randomUUID(), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
    });
    return ((await response.json()) as { briefId: string }).briefId;
  }, question);
  await page.evaluate(`history.pushState(null, '', ${JSON.stringify(`/briefs/${id}`)}); dispatchEvent(new PopStateEvent('popstate'));`);
  await expect(page).toHaveURL(new RegExp(`/briefs/${id}$`));
}

const summaryLabel = (page: Page) => page.getByRole('heading', { name: /^AI summary · check the cited passages$/i });

test('a brief that exists shows the checklist, then the briefing sheet with the magenta summary label', async ({ page }) => {
  await ask(page, SEED_QUESTION);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED_QUESTION);
  const checklist = page.getByRole('region', { name: /answer checklist/i });
  await expect(checklist).toBeVisible();
  await expect(checklist.getByRole('listitem').first()).toContainText('IN SCOPE');
  await expect(checklist.getByRole('listitem').nth(1)).toContainText('4 CASES · 9 PASSAGES');
  await expect(checklist).toContainText('Nothing is shown until each quote matches the report text word for word. Usually about a minute; up to two.');
  await expect(checklist.getByRole('button', { name: 'Cancel' })).toBeVisible();

  const label = summaryLabel(page);
  await expect(label).toBeVisible({ timeout: 15_000 });
  await expect(checklist).toBeHidden();
  // The AI's words sit under a magenta label (the `magenta` token, #A0166C by day).
  await expect(label).toHaveCSS('color', 'rgb(160, 22, 108)');
  await expect(page.getByText('3 examples found · not every matching investigation')).toBeVisible();
  // The four evidence groups in order; an empty one still shows, with "none".
  for (const group of ['Causal fault established, 1 case', 'Defect found, causal link not established, 1 case', 'No fault identified, 1 case', 'Insufficient evidence, none']) {
    await expect(page.getByRole('region', { name: group, exact: true })).toBeVisible();
  }
  await expect(page.locator('article[data-card]')).toHaveCount(3);
  await expect(page.locator('article[data-card="DFW08TA066"]')).toContainText('5.1 FH');
  // MIA08LA156's timing is only "first flight": unconfirmed against a 30-day/10-hour window.
  await expect(page.locator('article[data-card="MIA08LA156"]')).toContainText(/unconfirmed/i);
  await expect(page.getByRole('button', { name: 'Refine · uses 1' })).toBeVisible();
});

test('withheld notice copy exact', async ({ page }) => {
  await ask(page, 'Engine power loss after maintenance, withheld summary');
  const notice = page.getByRole('note').filter({ hasText: /summary withheld/i });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice.locator('p').nth(1)).toHaveText(
    "The AI's summary didn't pass the citation check, so it isn't shown. Below are the 4 cases it found, with their NTSB text. You can still open, compare and print them.",
  );
  await expect(summaryLabel(page)).toHaveCount(0);
  await expect(page.locator('article[data-card]')).toHaveCount(4);
  await expect(page.getByText(/why it matched/i)).toHaveCount(0);
  await expect(page.locator('article[data-card]').first()).toContainText('NTSB · ANALYSIS');
});

test('case number citation opens drawer at passage', async ({ page }) => {
  await ask(page, SEED_QUESTION);
  await expect(summaryLabel(page)).toBeVisible({ timeout: 15_000 });
  const citation = summaryLabel(page).locator('..').getByRole('link', { name: 'DFW08TA066' });
  await citation.click();

  const dialog = page.getByRole('dialog', { name: /^DFW08TA066: / });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page).toHaveURL(/[?&]case=DFW08TA066/);
  await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(dialog.getByText('1 of 3')).toBeVisible();
  // The AI context comes from the brief's private endpoint; the drawer opens at the cited span.
  await expect(dialog.getByText('Causal fault established · AI classified', { exact: false })).toBeVisible();
  const cited = dialog.locator('[data-cited] mark.hit').first();
  await expect(cited).toContainText('castellated nut used to secure the governor lever control rod');
  await expect(cited).toBeInViewport();
  await expect(dialog.getByRole('region', { name: "Why it's in your results" })).toContainText('TIMING');

  // Each line jumps to its own passage: the TIMING line to the analysis passage that states the 5.1 hours.
  const why = dialog.getByRole('region', { name: "Why it's in your results" });
  const timing = why.locator('[data-line="TIMING"]');
  await expect(timing).toContainText('5.1 flight hours after the maintenance');
  await timing.getByRole('button', { name: 'Go to the analysis passage' }).click();
  await expect(dialog.locator('[data-cited]').first()).toBeFocused();
  await expect(dialog.locator('[data-cited]').first()).toContainText('The engine had  been replaced 5.1 hours prior to the accident');

  // ‹ › keep opening each case at its cited passage, also when its context is already loaded:
  // straight back before the next case has shown its passage, and back after it has.
  const citedMark = () => page.getByRole('dialog').locator('[data-cited] mark.hit').first();
  await dialog.getByRole('button', { name: 'Next case' }).click();
  await expect(page).toHaveURL(/case=MIA08LA156/);
  await page.getByRole('dialog').getByRole('button', { name: 'Previous case' }).click();
  await expect(page).toHaveURL(/case=DFW08TA066/);
  await expect(citedMark()).toContainText('castellated nut');
  await expect(citedMark()).toBeInViewport();
  await page.getByRole('dialog').getByRole('button', { name: 'Next case' }).click();
  await expect(page.getByRole('dialog', { name: /^MIA08LA156: / })).toBeVisible();
  await expect(citedMark()).toContainText('check valve');
  await expect(citedMark()).toBeInViewport();
  await page.getByRole('dialog').getByRole('button', { name: 'Previous case' }).click();
  await expect(page.getByRole('dialog', { name: /^DFW08TA066: / })).toBeVisible();
  await expect(citedMark()).toContainText('castellated nut');
  await expect(citedMark()).toBeInViewport();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/case=/);
  await expect(citation).toBeFocused();
});

test('refine uses 1 and adds step switcher', async ({ page }) => {
  await ask(page, SEED_QUESTION, { searchedFirst: true });
  await expect(summaryLabel(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('navigation', { name: 'Answers in this brief' })).toHaveCount(0);

  const refine = page.getByRole('button', { name: 'Refine · uses 1' });
  await expect(refine).toBeVisible();
  // (the count as this page last read it: the brief was made from the page without a re-read)
  await expect(page.getByText(/^AI searches left: \d+ of 10 · 3 of 3 refinements left in this brief$/)).toBeVisible();
  await page.getByRole('textbox', { name: /^refine$/i }).fill('only helicopters');
  await refine.click();
  // Every anonymous AI request takes a fresh check; later ones run invisibly while the button says so.
  await expect(page.getByRole('button', { name: 'Checking…' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /quick check/i })).toBeHidden();

  await expect(page.getByRole('region', { name: /answer checklist/i })).toBeVisible();
  const switcher = page.getByRole('navigation', { name: 'Answers in this brief' });
  await expect(switcher).toBeVisible();
  await expect(switcher.getByRole('link', { name: 'Answer 2, latest' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Refined: “only helicopters”')).toBeVisible();
  await expect(summaryLabel(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('AI searches left: 7 of 10 · 2 of 3 refinements left in this brief')).toBeVisible();

  // The AI search on Home took the first check; the refinement took a fresh, invisible one.
  const renders = await page.evaluate<{ appearance: string }[]>('window.__turnstile.renders');
  expect(renders.map((r) => r.appearance)).toEqual(['always', 'interaction-only']);

  // Earlier answers stay readable, for free.
  await switcher.getByRole('link', { name: 'Answer 1', exact: true }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]{36}\?step=1$/);
  await expect(page.getByText('You are reading answer 1 of 2.')).toBeVisible();
  await expect(switcher.getByRole('link', { name: 'Answer 1', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(summaryLabel(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refine · uses 1' })).toHaveCount(0);
});

test('expired brief shows empty search', async ({ page }) => {
  await page.goto('/briefs/00000000-0000-4000-8000-999999999999');
  await expect(page.getByRole('heading', { level: 1, name: 'This AI search has expired.' })).toBeVisible();
  // A 404 ends the reads: the expired page does not poll. (The dev server runs React's
  // StrictMode, whose remount aborts and repeats the very first read.)
  const briefReads = () => page.evaluate<number>("window.__reads.filter((r) => r.path.startsWith('/api/briefs/')).length");
  const atRender = await briefReads();
  expect(atRender).toBeLessThanOrEqual(2);
  await page.waitForTimeout(3_000);
  expect(await briefReads()).toBe(atRender);
  await expect(page.getByText('We delete questions and answers after 24 hours.')).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Search NTSB investigations' });
  await expect(box).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask AI/ })).toBeVisible();
  // Nothing of the question survives outside this page's memory.
  await expect(page.getByRole('button', { name: 'Ask again' })).toHaveCount(0);
  await box.fill('carburetor icing');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/explore\?q=carburetor\+icing$/);
});

test('today\'s free searches used up: the button and counter change, and a click explains', async ({ page }) => {
  await page.addInitScript('window.__checkDelay = 40;');
  await page.goto('/');
  // Ask AI starts an AI evidence search; the trial has ten a day.
  for (let left = 10; left >= 1; left--) {
    await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(`${SEED_QUESTION} ${left}`);
    await page.getByRole('button', { name: `Ask AI · ${left} free` }).click();
    await expect(page).toHaveURL(/\/ai\/[0-9a-f-]{36}$/);
    // Back home inside the app: the mock keeps the trial in this page's memory.
    await page.getByRole('link', { name: 'AirCase' }).click();
    await expect(page).toHaveURL(/\/$/);
  }
  await expect(page.getByRole('banner').getByRole('button', { name: 'Sign in to keep asking' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(SEED_QUESTION);
  await page.getByRole('button', { name: 'Ask AI · sign in' }).click();
  await expect(page.getByText('That was your tenth free AI search today.')).toBeVisible();
  await expect(
    page.getByText('Sign in with Google to keep asking. New accounts start with 20 AI searches a day, rising to 50 after three days.'),
  ).toBeVisible();
  await expect(page.getByText(/^Free AI searches return at 00:00 UTC\. Search, case pages, compare and the dashboard stay open without an account\.$/)).toBeVisible();
  // Refused before any work: no eleventh search was requested.
  const posts = await page.evaluate<number>("window.__reads.filter((r) => r.method === 'POST' && r.path === '/api/evidence').length");
  expect(posts).toBe(10);
});

test('cancelling the first check gives the button back', async ({ page }) => {
  await page.addInitScript('window.__checkDelay = 1e9;');
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(SEED_QUESTION);
  const ask = page.getByRole('button', { name: 'Ask AI · 10 free' });
  await ask.click();
  const check = page.getByRole('dialog', { name: 'Quick check before your first AI search' });
  await expect(check).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checking…' })).toBeVisible();
  await check.getByRole('button', { name: 'Cancel' }).click();
  await expect(check).toBeHidden();
  await expect(ask).toBeVisible();
  await expect(ask).toHaveAttribute('aria-busy', 'false');
  await expect(ask).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
});

test('partial display: removed statements are markers, unclassified cases stay on the sheet, the drawer and print say what was not shown', async ({ page }) => {
  await ask(page, 'Engine power loss shortly after maintenance, partial display');
  await expect(summaryLabel(page)).toBeVisible({ timeout: 15_000 });
  // Factual copy from the count, never a blanket "partly checked" (Task 16e).
  await expect(page.getByText('Evidence check completed · 13 statements removed')).toBeVisible();
  await expect(page.getByText(/partly checked/i)).toHaveCount(0);
  await expect(page.getByText('[one statement not shown: the check could not confirm it]')).toBeVisible();
  // Every counted case is a card; the ones without a confirmed classification are listed apart.
  const ungrouped = page.locator('[data-ungrouped]');
  await expect(ungrouped).toContainText('The evidence check could not confirm a classification for these cases.');
  await expect(ungrouped.locator('article[data-card]')).toHaveCount(2);
  await expect(page.locator('article[data-card="DEN08LA103"]')).toContainText('AI reading not shown');
  await expect(page.locator('article[data-card="DFW08TA066"]')).toContainText('Not verified');
  // Print keeps the markers and the unclassified cases.
  await page.emulateMedia({ media: 'print' });
  await expect(ungrouped).toBeVisible();
  await expect(page.locator('[data-check-status]').first()).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  // The drawer of a case without its reading says so, and shows no AI line of it.
  await page.locator('article[data-card="DEN08LA103"]').getByRole('link', { name: 'DEN08LA103' }).first().click();
  const dialog = page.getByRole('dialog', { name: /^DEN08LA103: / });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('AI reading not shown: the check could not confirm it against the cited passages')).toBeVisible();
  await expect(dialog.getByText(/Why it matched/i)).toHaveCount(0);
});
