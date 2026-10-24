/**
 * The web client against the real API server and the fixture index (no mocks): the
 * production build under the server's CSP, Elasticsearch analysis, facet counts from
 * aggregations and case pages from PostgreSQL.
 */
import { expect, test, type Page } from '@playwright/test';

/** Collects CSP violations and page errors from the moment the page starts. */
async function watchPage(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(
    "document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));",
  );
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

async function countLine(page: Page) {
  return page.locator('p[aria-live="polite"]').filter({ hasText: /investigations?$/ });
}

test('search from Home shows highlighted rows from the index, under the CSP', async ({ page }) => {
  const problems = await watchPage(page);
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self' 'sha256-");
  // The inline theme script ran (its hash is allowed).
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(day|night)$/);
  // The page is AirCase, and the app has started: its header is on screen.
  await expect(page).toHaveTitle('AirCase · aviation casebook');
  await expect(page.getByRole('banner').getByRole('link', { name: 'AirCase' })).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Search NTSB investigations' });
  await box.fill('carburetor icing');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/explore\?q=carburetor\+icing$/);
  await expect(await countLine(page)).toHaveText('7 completed investigations');
  const rows = page.getByRole('list', { name: 'Results' }).getByRole('listitem');
  await expect(rows).toHaveCount(7);
  await expect(rows.first().locator('mark.hit').first()).toContainText(/carburetor/i);
  expect(problems).toEqual([]);
});

test('the pages without data load under the CSP: AirCase in the title, the credit in the footer, no violation', async ({ page }) => {
  const problems = await watchPage(page);
  for (const [path, title] of [
    ['/about', 'About · AirCase'],
    ['/privacy', 'Privacy · AirCase'],
    ['/dashboard', 'The record, in questions · AirCase'],
    ['/no-such-page', 'Page not found · AirCase'],
  ] as const) {
    await page.goto(path);
    await expect(page, path).toHaveTitle(title);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'm@mkotas.cz' }), path).toHaveAttribute('href', 'mailto:m@mkotas.cz');
  }
  // The About page says who built it, with the same address.
  await page.goto('/about');
  await expect(page.getByRole('main').getByText('AirCase is built by Mariusz Kotas')).toBeVisible();
  expect(problems).toEqual([]);
});

test('facet click narrows with disjunctive counts', async ({ page }) => {
  const problems = await watchPage(page);
  await page.goto('/explore?q=carburetor+icing');
  const facets = page.getByRole('complementary', { name: 'Filters' });
  await facets.getByRole('button', { name: 'Initial climb, 3 investigations' }).click();
  await expect(page).toHaveURL(/phase=initial_climb/);
  await expect(await countLine(page)).toHaveText('3 completed investigations');
  await expect(facets.getByRole('button', { name: 'Approach, 2 investigations' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('drawer and case page read the case from the server', async ({ page }) => {
  const problems = await watchPage(page);
  await page.goto('/explore?q=carburetor+icing');
  await page.getByRole('link', { name: 'ERA25LA016' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toContainText('Piper PA-28-151');
  // The words matched in the probable cause, which the drawer shows in full.
  await expect(dialog.getByText(/inadequate use of carburetor heat/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.goto('/cases/DFW08TA066');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hughes OH-6');
  await expect(page.getByRole('link', { name: /NTSB report/ })).toHaveAttribute(
    'href',
    'https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/67493/pdf',
  );
  expect(problems).toEqual([]);
});

test('a dashboard bar opens Explore with its count', async ({ page }) => {
  const problems = await watchPage(page);
  await page.goto('/dashboard');
  const bar = page.getByRole('list', { name: 'Highest injury' }).getByRole('button').first();
  const name = (await bar.getAttribute('aria-label')) ?? '';
  const count = Number(/, ([\d,]+) investigations?, /.exec(name)?.[1]?.replaceAll(',', ''));
  expect(count).toBeGreaterThan(0);
  await bar.click();
  await expect(page).toHaveURL(/\/explore\?.*injury=/);
  await expect(await countLine(page)).toContainText(new RegExp(`^${count}\\b`));
  expect(problems).toEqual([]);
});
