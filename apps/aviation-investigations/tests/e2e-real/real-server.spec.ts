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
    if (m.type() !== 'error') return;
    // A resource that failed says which one (a 404 page's document and its API read are expected).
    const url = m.location().url;
    problems.push(m.text().startsWith('Failed to load resource') && url ? `${m.text()}: ${new URL(url).pathname}` : m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

/** `problems` without the 404s a test expects: a not-found page's own document, a missing case's API read. */
function unexpected(problems: readonly string[], notFound: readonly string[]): string[] {
  const expected = new Set(notFound.map((path) => `Failed to load resource: the server responded with a status of 404 (Not Found): ${path}`));
  return problems.filter((p) => !expected.has(p));
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
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'mkotas.cz', exact: true }), path).toHaveAttribute('href', 'https://mkotas.cz');
  }
  // The About page says who built it, with his website and his e-mail address.
  await page.goto('/about');
  const main = page.getByRole('main');
  await expect(main.getByText('AirCase is built by Mariusz Kotas')).toBeVisible();
  await expect(main.getByRole('link', { name: 'mkotas.cz', exact: true })).toHaveAttribute('href', 'https://mkotas.cz');
  await expect(main.getByRole('link', { name: 'm@mkotas.cz', exact: true })).toHaveAttribute('href', 'mailto:m@mkotas.cz');
  expect(unexpected(problems, ['/no-such-page'])).toEqual([]);
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

// Search engines and link previews: the head the server builds for each page (server/seo/head.ts).

/** The text of an element or attribute as the server wrote it, entities decoded. */
function decoded(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '');
}

/** What the server's head says, read from the raw HTML (no script has run). */
function serverHead(html: string) {
  const meta = (attr: 'name' | 'property', key: string) => {
    const m = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`).exec(html);
    return m ? decoded(m[1] ?? '') : null;
  };
  const title = /<title>([^<]*)<\/title>/.exec(html);
  const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html);
  return {
    title: title ? decoded(title[1] ?? '') : null,
    titles: html.match(/<title>/g)?.length ?? 0,
    description: meta('name', 'description'),
    robots: meta('name', 'robots'),
    canonical: canonical ? decoded(canonical[1] ?? '') : null,
    ogUrl: meta('property', 'og:url'),
    ogImage: meta('property', 'og:image'),
    jsonLd: (html.match(/<script type="application\/ld\+json">/g) ?? []).length,
  };
}

const VALENTINE_TITLE = 'Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas (2008) · NTSB DFW08TA066 · AirCase';

test('a case page carries its head in the HTML the server sends', async ({ request, baseURL }) => {
  const response = await request.get('/cases/DFW08TA066', { headers: { accept: 'text/html' } });
  expect(response.status()).toBe(200);
  const head = serverHead(await response.text());
  expect(head).toEqual({
    title: VALENTINE_TITLE,
    titles: 1,
    description:
      "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries. Probable cause: The contract mechanic's failure to properly secure the castellated nut that attached the…",
    robots: 'index, follow',
    canonical: `${baseURL}/cases/DFW08TA066`,
    ogUrl: `${baseURL}/cases/DFW08TA066`,
    ogImage: `${baseURL}/social/card.png`,
    jsonLd: 1,
  });
});

test('after the client renders, the tab title is the one the server sent, with no CSP violation (JSON-LD included)', async ({ page }) => {
  const problems = await watchPage(page);
  for (const [path, ready] of [
    ['/cases/DFW08TA066', page.getByRole('heading', { level: 1 }).filter({ hasText: 'Hughes OH-6' })],
    ['/', page.getByRole('textbox', { name: 'Search NTSB investigations' })],
    ['/explore?q=carburetor+icing', page.getByRole('list', { name: 'Results' })],
    ['/compare?cases=DFW08TA066,ERA25LA016', page.getByRole('heading', { level: 1, name: 'Comparing 2 cases' })],
    ['/dashboard', page.getByRole('heading', { level: 1, name: 'The record, in questions' })],
    ['/about', page.getByRole('heading', { level: 1, name: 'About AirCase' })],
  ] as const) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    const sent = serverHead((await response?.text()) ?? '').title;
    await expect(ready, path).toBeVisible();
    await expect(page, path).toHaveTitle(sent ?? '');
  }
  expect(await page.title()).not.toBe('');
  expect(problems).toEqual([]);
});

test('a missing case answers 404 and still renders the not-found page, noindex', async ({ page }) => {
  const problems = await watchPage(page);
  const response = await page.goto('/cases/ZZZ99ZZ999');
  expect(response?.status()).toBe(404);
  const head = serverHead((await response?.text()) ?? '');
  expect(head).toMatchObject({ robots: 'noindex', canonical: null, ogUrl: null, jsonLd: 0, title: 'NTSB ZZZ99ZZ999 · AirCase' });
  await expect(page.getByRole('heading', { level: 1, name: 'No investigation has that number.' })).toBeVisible();
  await expect(page).toHaveTitle('NTSB ZZZ99ZZ999 · AirCase');
  // Any other path: 404, and the client's not-found page.
  const other = await page.goto('/no-such-page');
  expect(other?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'There is no page here.' })).toBeVisible();
  expect(unexpected(problems, ['/cases/ZZZ99ZZ999', '/api/cases/ZZZ99ZZ999', '/no-such-page'])).toEqual([]);
});

test('Explore with a query is noindex, follow; without one it is indexed', async ({ request }) => {
  const searched = serverHead(await (await request.get('/explore?q=x', { headers: { accept: 'text/html' } })).text());
  expect(searched.robots).toBe('noindex, follow');
  expect(searched.title).toBe('“x” · Explore · AirCase');
  expect(serverHead(await (await request.get('/explore', { headers: { accept: 'text/html' } })).text()).robots).toBe('index, follow');
});
