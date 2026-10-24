import { expect, test, type Page } from '@playwright/test';

const COMPARE_FULL = 'Compare holds four cases. Remove one first.';

async function countLine(page: Page) {
  return page.locator('p[aria-live="polite"]').filter({ hasText: /investigations?$/ });
}

test('the home page is AirCase: its tab title, the wordmark, and the credit in the footer', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('AirCase · aviation casebook');
  await expect(page.getByRole('banner').getByRole('link', { name: 'AirCase' })).toHaveAttribute('href', '/');
  const footer = page.getByRole('contentinfo');
  await expect(footer).toContainText('Built by Mariusz Kotas');
  // The website is a link that opens in a new tab and, like the footer's other links, is reachable with the keyboard.
  const credit = footer.getByRole('link', { name: 'mkotas.cz', exact: true });
  await expect(credit).toHaveAttribute('href', 'https://mkotas.cz');
  await expect(credit).toHaveAttribute('target', '_blank');
  await credit.focus();
  await expect(credit).toBeFocused();
});

test('search carburetor icing shows count line and rows', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Search NTSB investigations' });
  await box.fill('carburetor icing');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/explore\?q=carburetor\+icing$/);
  await expect(await countLine(page)).toHaveText('7 completed investigations');
  const rows = page.getByRole('list', { name: 'Results' }).getByRole('listitem');
  await expect(rows).toHaveCount(7);
  await expect(rows.first().locator('mark.hit').first()).toContainText(/carburetor/i);
  await expect(rows.first()).toContainText('PROBABLE CAUSE', { ignoreCase: true });
});

test('facet click updates URL and counts', async ({ page }) => {
  await page.goto('/explore?q=carburetor+icing');
  await expect(await countLine(page)).toHaveText('7 completed investigations');
  const facets = page.getByRole('complementary', { name: 'Filters' });
  await facets.getByRole('button', { name: 'Initial climb, 3 investigations' }).click();
  await expect(page).toHaveURL(/phase=initial_climb/);
  await expect(await countLine(page)).toHaveText('3 completed investigations');
  // Disjunctive: the phase facet still offers its alternatives; injuries narrow to the selection.
  await expect(facets.getByRole('button', { name: 'Approach, 2 investigations' })).toBeVisible();
  await expect(facets.getByRole('button', { name: /^Fatal, 1 investigation$/ })).toBeVisible();
  await facets.getByRole('button', { name: 'clear Phase' }).click();
  await expect(page).not.toHaveURL(/phase=/);
});

test('drawer opens from row, Esc closes and focus returns', async ({ page }) => {
  await page.goto('/explore?q=carburetor+icing');
  const trigger = page.getByRole('link', { name: 'ERA25LA016' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page).toHaveURL(/case=ERA25LA016/);
  const headline = dialog.getByRole('heading', { level: 2 });
  await expect(headline).toContainText('Piper PA-28-151');
  await expect(headline).toBeFocused();
  await expect(dialog.getByText('1 of 7')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next case' }).click();
  await expect(page).toHaveURL(/case=WPR24FA190/);
  await expect(dialog.getByText('2 of 7')).toBeVisible();
  await dialog.getByRole('button', { name: 'Previous case' }).click();
  await expect(page).toHaveURL(/case=ERA25LA016/);
  await expect(dialog.getByText('1 of 7')).toBeVisible();
  // At the start of the list ‹ stays focusable but does nothing.
  await expect(dialog.getByRole('button', { name: 'Previous case' })).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.getByRole('button', { name: 'Previous case' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/case=/);
  await expect(trigger).toBeFocused();
});

test(`compare four cases shows strips; fifth tick shows "${COMPARE_FULL}"`, async ({ page }) => {
  await page.goto('/explore?q=carburetor+icing');
  const boxes = page.getByRole('list', { name: 'Results' }).getByRole('checkbox');
  await expect(boxes).toHaveCount(7);
  for (let i = 0; i < 4; i++) {
    await boxes.nth(i).click();
    await expect(boxes.nth(i)).toBeChecked();
    await expect(page).toHaveURL(new RegExp(`cases=([A-Z0-9]+%2C){${i}}[A-Z0-9]+`));
  }
  await boxes.nth(4).click();
  const tray = page.getByRole('complementary', { name: 'Compare tray' });
  await expect(tray.getByRole('status')).toHaveText(COMPARE_FULL);
  await expect(boxes.nth(4)).not.toBeChecked();
  await tray.getByRole('link', { name: 'Compare →' }).click();
  await expect(page).toHaveURL(/\/compare\?cases=ERA25LA016,WPR24FA190,WPR24LA154,CEN19FA009$/);
  await expect(page.getByRole('heading', { name: 'Comparing 4 cases' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(4);
  await expect(page.getByText(/^Same in all four:/)).toBeVisible();
  await page.getByRole('link', { name: '← Back to results' }).click();
  await expect(page).toHaveURL(/\/explore\?q=carburetor\+icing&cases=/);
});

test('phone viewport shows Filters (n) sheet', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/explore?q=carburetor+icing&phase=initial_climb');
  await expect(page.getByRole('complementary', { name: 'Filters' })).toBeHidden();
  await page.getByRole('button', { name: 'Filters (1)' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(sheet.getByRole('heading', { name: 'Filters' })).toBeFocused();
  await expect(sheet.getByRole('button', { name: 'Show 3 investigations' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Approach, 2 investigations' }).click();
  await expect(page).toHaveURL(/phase=initial_climb%2Capproach/);
  await expect(sheet.getByRole('button', { name: 'Show 5 investigations' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Show 5 investigations' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters (2)' })).toBeVisible();
});

test('night theme toggle persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.getByRole('group', { name: 'Colour theme' }).getByRole('button', { name: 'Night' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.goto('/explore');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
});
