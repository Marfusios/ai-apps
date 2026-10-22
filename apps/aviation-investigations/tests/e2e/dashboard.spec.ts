import { expect, test, type Page } from '@playwright/test';

async function countLine(page: Page) {
  return page.locator('p[aria-live="polite"]').filter({ hasText: /investigations?$/ });
}

/** The first number in a bar's accessible name: "Landing, 7 investigations, 33%. Open in Explore." */
function barCount(name: string): number {
  const match = /, ([\d,]+) investigations?, /.exec(name);
  if (!match) throw new Error(`No count in "${name}"`);
  return Number((match[1] as string).replaceAll(',', ''));
}

for (const cohort of ['default', 'all'] as const) {
  test(`dashboard bars reproduce their count in Explore (${cohort} cohort)`, async ({ page }) => {
    test.setTimeout(120_000);
    const url = cohort === 'all' ? '/dashboard?cohort=all' : '/dashboard';
    await page.goto(url);
    const panels = ['Phase of the defining event', 'Highest injury', 'Weather conditions', 'Aircraft category'];
    const targets: { label: string; name: string }[] = [];
    for (const label of panels) {
      const bars = page.getByRole('list', { name: label }).getByRole('button');
      await expect(bars.first()).toBeVisible();
      const found = await bars.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
      for (const name of found) targets.push({ label, name });
    }
    let checked = 0;
    for (const { label, name } of targets) {
      await page.goto(url);
      await page.getByRole('list', { name: label }).getByRole('button', { name, exact: true }).click();
      await expect(page).toHaveURL(/\/explore\?/);
      await expect(await countLine(page)).toContainText(new RegExp(`^${barCount(name).toLocaleString('en-US')}\\b`));
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });
}

test('year bar opens that year in Explore with the same count', async ({ page }) => {
  await page.goto('/dashboard');
  const bar = page.getByRole('button', { name: /^2024: 4 completed investigations/ });
  await bar.click();
  await expect(page).toHaveURL(/yearFrom=2024&yearTo=2024/);
  await expect(await countLine(page)).toContainText(/^4\b/);
});

test('phone shows one question per card with an open link', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /^Open the \d+ fatal cases/ })).toBeVisible();
  const overflow = await page.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth');
  expect(overflow).toBe(false);
});

test('all-records year button names the total Explore shows', async ({ page }) => {
  await page.goto('/dashboard?cohort=all');
  const bar = page.getByRole('button', {
    name: /^2023: 1 completed investigation, 1 other record\. Open 2023 in Explore, which shows 2 investigations\.$/,
  });
  await bar.click();
  await expect(page).toHaveURL(/completion=any&yearFrom=2023&yearTo=2023/);
  await expect(await countLine(page)).toContainText(/^2\b/);
});
