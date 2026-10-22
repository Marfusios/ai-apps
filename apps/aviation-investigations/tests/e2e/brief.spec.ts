import { expect, test, type Page } from '@playwright/test';

/**
 * The AI brief interface against the mock API (web/mock/briefs.ts, the fake provider's
 * hand-written seed readings). Cloudflare's Turnstile is replaced by a local stand-in
 * installed before the app loads (the app then never fetches Cloudflare's script, and
 * the mock's service worker would hide that request from routing anyway), so nothing
 * leaves the machine. It records each widget's parameters and answers with the dummy
 * token of Cloudflare's always-passing test keys.
 */

const SEED_QUESTION = 'Engine power loss shortly after maintenance';
const TEST_SITE_KEY = '1x00000000000000000000AA';

const FAKE_TURNSTILE = `
window.__turnstile = { renders: [], removed: 0 };
window.turnstile = {
  _n: 0,
  _widgets: {},
  render(host, params) {
    const id = 'w' + (++this._n);
    window.__turnstile.renders.push({ sitekey: params.sitekey, action: params.action, appearance: params.appearance, theme: params.theme });
    const box = document.createElement('div');
    box.textContent = 'Verifying…';
    box.style.cssText = 'border:1px solid #c9c4b4;border-radius:4px;padding:9px 12px;background:#fafafa;color:#1E2A36;font:12px sans-serif;width:250px';
    if (params.appearance === 'interaction-only') box.style.display = 'none';
    host.appendChild(box);
    this._widgets[id] = box;
    setTimeout(() => {
      if (!this._widgets[id]) return;
      box.textContent = 'Success!';
      params.callback('XXXX.DUMMY.TOKEN.XXXX');
    }, 700);
    return id;
  },
  remove(id) {
    const box = this._widgets[id];
    if (box) box.remove();
    delete this._widgets[id];
    window.__turnstile.removed += 1;
  },
};
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_TURNSTILE);
  await page.emulateMedia({ colorScheme: 'light' });
});

async function ask(page: Page, question: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(question);
  await page.getByRole('button', { name: /^Ask AI · \d free$/ }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]{36}$/);
}

const summaryLabel = (page: Page) => page.getByRole('heading', { name: /^AI summary · check the cited passages$/i });

test('ask AI shows checklist then briefing sheet with magenta summary label', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner').getByText('AI searches left: 3 of 3')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(SEED_QUESTION);
  await page.getByRole('button', { name: 'Ask AI · 3 free' }).click();

  // The first AI search of a trial identity explains the check, with the widget inside.
  const check = page.getByRole('dialog', { name: 'Quick check before your first AI search' });
  await expect(check).toBeVisible();
  await expect(check).toContainText('Up to three free AI searches, subject to daily availability. Search, cases and comparisons never need this.');
  await expect(check.getByText('Verifying…')).toBeVisible();

  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED_QUESTION);
  const checklist = page.getByRole('region', { name: /answer checklist/i });
  await expect(checklist).toBeVisible();
  await expect(checklist.getByRole('listitem').first()).toContainText('IN SCOPE');
  await expect(checklist.getByRole('listitem').nth(1)).toContainText('4 CASES · 9 PASSAGES');
  await expect(checklist).toContainText('Nothing is shown until each quote matches the report text word for word. Up to a minute.');
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

  const renders = await page.evaluate<unknown[]>('window.__turnstile.renders');
  expect(renders).toEqual([{ sitekey: TEST_SITE_KEY, action: 'ask-ai', appearance: 'always', theme: 'light' }]);
  await expect(page.getByRole('banner').getByText('AI searches left: 2 of 3')).toBeVisible();
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

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/case=/);
  await expect(citation).toBeFocused();
});

test('refine uses 1 and adds step switcher', async ({ page }) => {
  await ask(page, SEED_QUESTION);
  await expect(summaryLabel(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('navigation', { name: 'Answers in this brief' })).toHaveCount(0);

  const refine = page.getByRole('button', { name: 'Refine · uses 1' });
  await expect(refine).toBeVisible();
  await expect(page.getByText('AI searches left: 2 of 3 · 3 of 3 refinements left in this brief')).toBeVisible();
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
  await expect(page.getByText('AI searches left: 1 of 3 · 2 of 3 refinements left in this brief')).toBeVisible();

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
