import { expect, test, type Page } from '@playwright/test';

/**
 * Google sign-in and the account against the mock API (web/src/mocks/handlers.ts): the
 * mock answers sign-in with the page to come back to, as if Google had sent the browser
 * straight back, and keeps the signed-in state in the tab's session storage across that
 * reload. Cloudflare's Turnstile is a local stand-in, as in brief.spec.ts.
 */

const SEED_QUESTION = 'Engine power loss shortly after maintenance';

const FAKE_TURNSTILE = `
window.turnstile = {
  _n: 0,
  render(host, params) {
    const id = 'w' + (++this._n);
    setTimeout(() => params.callback('XXXX.DUMMY.TOKEN.XXXX'), 50);
    return id;
  },
  remove() {},
};
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_TURNSTILE);
  await page.emulateMedia({ colorScheme: 'light' });
});

async function useUpTrial(page: Page): Promise<void> {
  await page.goto('/');
  for (const left of [3, 2, 1]) {
    await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(SEED_QUESTION);
    await page.getByRole('button', { name: `Ask AI · ${left} free` }).click();
    await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]{36}$/);
    await page.getByRole('link', { name: 'AirCase' }).click();
    await expect(page).toHaveURL(/\/$/);
  }
}

test('trial used up: Continue with Google opens the sign-in dialog; a first sign-in comes back here with the welcome', async ({ page }) => {
  await useUpTrial(page);
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(SEED_QUESTION);
  await page.getByRole('button', { name: 'Ask AI · sign in' }).click();
  await expect(page.getByText('That was your third free AI search.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).click();

  const dialog = page.getByRole('dialog', { name: 'Sign in to AirCase' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("We keep your Google account ID, email and name, and how many AI searches you've used.");
  await expect(dialog).toContainText('Questions and answers are held for up to 24 hours to deliver them, then deleted.');
  await expect(dialog).toContainText('Delete your account any time from Account.');
  await expect(dialog.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', '/privacy');
  await dialog.getByRole('button', { name: 'Continue with Google' }).click();

  // Back on the same page, signed in, with the welcome once.
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  const welcome = page.getByRole('dialog', { name: 'Welcome aboard.' });
  await expect(welcome).toContainText('You have 5 AI searches a day for your first three days, then 20.');
  await welcome.getByRole('button', { name: 'Continue' }).click();
  await expect(welcome).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  const banner = page.getByRole('banner');
  await expect(banner.getByText('AI left today: 5 of 5')).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Account' })).toBeVisible();
  // Signed in, Ask AI needs no check.
  await expect(page.getByRole('button', { name: 'Ask AI · 5 left today' })).toBeVisible();
});

test('account page: name, email and searches left; sign out; delete asks once more', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('dialog', { name: 'Sign in to AirCase' }).getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('dialog', { name: 'Welcome aboard.' }).getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('banner').getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/account$/);

  await expect(page.getByRole('heading', { level: 1, name: 'Alex Example' })).toBeVisible();
  await expect(page.getByText('alex@example.com')).toBeVisible();
  await expect(page.getByRole('main').getByText(/5 of 5\s*left today/)).toBeVisible();
  await expect(page.getByText(/Backups never include your account or your AI searches/)).toBeVisible();

  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByText('Delete your account now? This can’t be undone.')).toBeFocused();
  await page.getByRole('button', { name: 'Keep account' }).click();
  await expect(page.getByText('Delete your account now? This can’t be undone.')).toBeHidden();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'You aren’t signed in.' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Sign in' })).toBeVisible();

  // Signing in again (not a first sign-in: no welcome), then deleting the account.
  await page.getByRole('main').getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('dialog', { name: 'Sign in to AirCase' }).getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('dialog', { name: 'Welcome aboard.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete account' }).click();
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByText('Your account is deleted.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'You aren’t signed in.' })).toBeVisible();
});

test('deleting after an older sign-in confirms with Google first, then asks once more', async ({ page }) => {
  await page.addInitScript(`window.sessionStorage.setItem('casebook-mock-deletion-reauth', '1');`);
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('dialog', { name: 'Sign in to AirCase' }).getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('dialog', { name: 'Welcome aboard.' }).getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('banner').getByRole('link', { name: 'Account' }).click();

  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByText('To delete your account, first confirm with Google that it’s you.')).toBeFocused();
  await page.getByRole('main').getByRole('button', { name: 'Continue with Google' }).click();
  // Back from "Google" on the account page, confirmed: only the last question is left.
  await expect(page.getByText('Delete your account now? This can’t be undone.')).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByText('Your account is deleted.')).toBeVisible();
});

test('signing out forgets the brief and its AI context: going back shows nothing of it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('dialog', { name: 'Sign in to AirCase' }).getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('dialog', { name: 'Welcome aboard.' }).getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Search NTSB investigations' }).fill(SEED_QUESTION);
  await page.getByRole('button', { name: 'Ask AI · 5 left today' }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]{36}$/);
  const summary = page.getByRole('heading', { name: /AI summary/i });
  await expect(summary).toBeVisible();
  await summary.locator('..').getByRole('link', { name: 'DFW08TA066' }).click();
  const drawer = page.getByRole('dialog', { name: /^DFW08TA066: / });
  await expect(drawer.locator('[data-cited] mark.hit').first()).toBeVisible();
  await expect(page).toHaveURL(/case=DFW08TA066/);
  const drawerUrl = new URL(page.url());

  // Close the drawer, sign out from the account page.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('banner').getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'You aren’t signed in.' })).toBeVisible();

  // Back to the drawer in the same page (no reload: the page's cache is what is tested): the
  // brief is not this visitor's, and nothing of its AI context shows.
  const target = JSON.stringify(`${drawerUrl.pathname}${drawerUrl.search}`);
  await page.evaluate(`history.pushState(null, '', ${target}); dispatchEvent(new PopStateEvent('popstate'));`);
  await expect(page).toHaveURL(/case=DFW08TA066/);
  await expect(page.getByText('This AI search has expired.').first()).toBeVisible();
  await expect(page.locator('[data-cited] mark.hit')).toHaveCount(0);
  await expect(page.getByText('AI classified')).toHaveCount(0);
});
