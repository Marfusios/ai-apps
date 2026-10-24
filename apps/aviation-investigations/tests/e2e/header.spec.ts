/**
 * The header's lockup in a real browser (UI_DESIGN §3, §6, owner decisions of 2026-10-24): the
 * mark and the wordmark link home, and the link's box (so its focus ring) holds both at every
 * width; the descriptor sits beside the wordmark after a hairline from 1024px and under it below
 * that, on tablets and phones. It is never cut short and never wraps the navigation; the
 * desktop and phone headers stay as tall as they were. At night the wordmark is plain blue
 * text, not a placard.
 */
import { expect, test, type Page } from '@playwright/test';

const DESCRIPTOR = 'Plane crash & accident investigations';
/** The header's height from 1024px (and on tablets before the line went under the wordmark). */
const DESKTOP_HEIGHT = 47.25;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;
const middle = (b: Box): number => b.y + b.height / 2;
const apart = (a: Box, b: Box): boolean => right(a) <= b.x || right(b) <= a.x || bottom(a) <= b.y || bottom(b) <= a.y;
const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && right(inner) <= right(outer) + 0.5 && bottom(inner) <= bottom(outer) + 0.5;

type Visitor = 'signed out' | 'signed in';

async function open(page: Page, width: number, theme: 'day' | 'night', path = '/explore', visitor: Visitor = 'signed out'): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.addInitScript(`localStorage.setItem('casebook-theme', '${theme}')`);
  // The mock API keeps this tab's sign-in in session storage (web/src/mocks/handlers.ts).
  if (visitor === 'signed in') await page.addInitScript(`sessionStorage.setItem('casebook-mock-account', '{"signedIn":true,"registered":true}')`);
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate('document.fonts.ready');
  // The AI counter has read the status, and the sign-in slot its answer: the header is complete.
  await expect
    .poll(() => page.locator('header').evaluate((h) => h.querySelector('button[aria-controls]')?.parentElement?.firstElementChild?.textContent ?? ''))
    .toMatch(/^AI /);
  if (width >= 640) {
    const slot = visitor === 'signed in' ? page.getByRole('banner').getByRole('link', { name: 'Account' }) : page.getByRole('banner').getByRole('button', { name: 'Sign in' });
    await expect(slot.first()).toBeVisible();
  }
}

interface Measured {
  header: Box;
  link: Box | null;
  mark: Box | null;
  wordmark: Box | null;
  /** The descriptor's text, when it shows. */
  descriptor: Box | null;
  descriptorCut: boolean;
  descriptorLines: number;
  navLinks: Box[];
  counter: Box | null;
  counterCut: boolean;
  menu: Box | null;
  pageWidth: number;
}

/** The boxes of the lockup's parts and its neighbours (the descriptor's is its text's own). */
async function measure(page: Page): Promise<Measured> {
  return page.locator('header').evaluate((header, descriptor) => {
    type Rect = { x: number; y: number; width: number; height: number };
    const box = (el: { getBoundingClientRect(): Rect } | null | undefined): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width === 0 && r.height === 0 ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const doc = header.ownerDocument;
    const home = header.querySelector('a[href="/"]');
    const text = [...header.querySelectorAll('p')].find((p) => p.textContent === descriptor);
    const range = doc.createRange();
    if (text) range.selectNodeContents(text);
    const menu = header.querySelector('button[aria-controls]');
    const counter = menu?.parentElement?.firstElementChild;
    return {
      header: box(header) as Rect,
      link: box(home),
      mark: box(home?.querySelector('svg')),
      wordmark: box(home?.querySelector('.wordmark')),
      descriptor: text && box(text) ? box(range) : null,
      descriptorCut: text ? text.scrollWidth > text.clientWidth : false,
      descriptorLines: text ? range.getClientRects().length : 0,
      navLinks: [...header.querySelectorAll('nav a')].map((a) => box(a)).filter((b): b is Rect => b !== null),
      counter: box(counter),
      counterCut: counter ? counter.scrollWidth > counter.clientWidth : false,
      menu: box(menu),
      pageWidth: doc.documentElement.scrollWidth,
    };
  }, DESCRIPTOR);
}

/** The header's height with the mark and the descriptor taken out. */
async function heightWithoutLockup(page: Page): Promise<number> {
  return page.locator('header').evaluate((header, descriptor) => {
    const text = [...header.querySelectorAll('p')].find((p) => p.textContent === descriptor);
    for (const el of [header.querySelector('a[href="/"] svg'), text]) if (el) el.style.display = 'none';
    return header.getBoundingClientRect().height;
  }, DESCRIPTOR);
}

/** Computed style properties of the first element `locator` finds. */
async function styleOf(locator: ReturnType<Page['locator']>, ...names: string[]): Promise<string[]> {
  return locator.first().evaluate((el, props) => {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return props.map((p) => style.getPropertyValue(p));
  }, names);
}

/** The parts every width shares: the mark before the wordmark inside the link's box, and the line whole, on one line. */
function expectLinkAndLine(m: Measured): { mark: Box; wordmark: Box; descriptor: Box } {
  const { link, mark, wordmark, descriptor } = m;
  if (!link || !mark || !wordmark || !descriptor) throw new Error(`missing part: ${JSON.stringify(m)}`);
  expect(contains(link, mark), 'the link holds the mark').toBe(true);
  expect(contains(link, wordmark), 'the link holds the wordmark').toBe(true);
  expect(right(mark)).toBeLessThanOrEqual(wordmark.x);
  expect(Math.abs(middle(mark) - middle(wordmark))).toBeLessThanOrEqual(1.5);
  expect(m.descriptorLines).toBe(1);
  expect(m.descriptorCut).toBe(false);
  return { mark, wordmark, descriptor };
}

/** Two lines: the descriptor under the wordmark, starting where the wordmark does. */
function expectUnderWordmark(wordmark: Box, descriptor: Box): void {
  expect(descriptor.y).toBeGreaterThanOrEqual(bottom(wordmark) - 1);
  expect(Math.abs(descriptor.x - wordmark.x)).toBeLessThanOrEqual(1);
}

for (const theme of ['day', 'night'] as const) {
  test.describe(`by ${theme}`, () => {
    for (const visitor of ['signed out', 'signed in'] as const) {
      test(`phone (390px), ${visitor}: the line under the wordmark, the counter whole on the wordmark's line`, async ({ page }) => {
        await open(page, 390, theme, '/explore', visitor);
        await expect(page.getByRole('banner').getByRole('link', { name: 'AirCase', exact: true })).toBeVisible();
        const m = await measure(page);
        const { wordmark, descriptor } = expectLinkAndLine(m);
        expectUnderWordmark(wordmark, descriptor);
        const { counter, menu } = m;
        if (!counter || !menu) throw new Error(`missing part: ${JSON.stringify(m)}`);
        expect(Math.abs(middle(counter) - middle(wordmark))).toBeLessThanOrEqual(1.5);
        expect(apart(counter, menu) && apart(descriptor, menu) && apart(descriptor, counter)).toBe(true);
        expect(m.counterCut).toBe(false);
        // As tall as the menu button's row was, and no sideways scrolling.
        expect(m.header.height).toBe(await heightWithoutLockup(page));
        expect(m.pageWidth).toBe(390);
      });
    }

    for (const width of [640, 700, 768, 900, 1023]) {
      test(`tablet (${width}px): the line under the wordmark and below the navigation, nothing cut or wrapped`, async ({ page }) => {
        for (const visitor of ['signed out', 'signed in'] as const) {
          await open(page, width, theme, '/explore', visitor);
          await expect(page.getByRole('banner').getByText(DESCRIPTOR), visitor).toBeVisible();
          const m = await measure(page);
          const { wordmark, descriptor } = expectLinkAndLine(m);
          expectUnderWordmark(wordmark, descriptor);
          // The navigation keeps its one line, and the line runs below it.
          expect(m.navLinks, visitor).toHaveLength(2);
          for (const link of m.navLinks) {
            expect(link.height, visitor).toBeLessThan(30);
            expect(descriptor.y, visitor).toBeGreaterThanOrEqual(bottom(link));
          }
          expect(Math.abs((m.navLinks[0]?.y ?? 0) - (m.navLinks[1]?.y ?? 99)), visitor).toBeLessThan(1);
          expect(m.counterCut, visitor).toBe(false);
          expect(m.counter && apart(descriptor, m.counter), visitor).toBe(true);
          // The header grows by the line alone (and 3px of air above it).
          const without = await heightWithoutLockup(page);
          expect(without, visitor).toBe(DESKTOP_HEIGHT);
          expect(m.header.height - without, visitor).toBeGreaterThan(15);
          expect(m.header.height - without, visitor).toBeLessThanOrEqual(20);
          expect(m.pageWidth, visitor).toBe(width);
        }
      });
    }

    for (const width of [1024, 1280]) {
      test(`desktop (${width}px): the line beside the wordmark after a hairline, the header as tall as before`, async ({ page }) => {
        for (const visitor of ['signed out', 'signed in'] as const) {
          await open(page, width, theme, '/explore', visitor);
          await expect(page.getByRole('banner').getByText(DESCRIPTOR), visitor).toBeVisible();
          const m = await measure(page);
          const { wordmark, descriptor } = expectLinkAndLine(m);
          expect(descriptor.x, visitor).toBeGreaterThan(right(wordmark));
          expect(Math.abs(middle(descriptor) - middle(wordmark)), visitor).toBeLessThanOrEqual(2);
          // Nothing overlaps, and the nav stays on one line.
          for (const link of m.navLinks) {
            expect(link.height, visitor).toBeLessThan(30);
            expect(apart(descriptor, link), visitor).toBe(true);
          }
          expect(right(descriptor), visitor).toBeLessThan(m.navLinks[0]?.x ?? 0);
          expect(m.counter && apart(descriptor, m.counter), visitor).toBe(true);
          expect(m.counterCut, visitor).toBe(false);
          // A hairline before it.
          expect(await styleOf(page.getByRole('banner').getByText(DESCRIPTOR), 'border-left-width', 'border-left-style'), visitor).toEqual(['1px', 'solid']);
          expect(m.header.height, visitor).toBe(DESKTOP_HEIGHT);
          expect(await heightWithoutLockup(page), visitor).toBe(DESKTOP_HEIGHT);
          expect(m.pageWidth, visitor).toBe(width);
        }
      });
    }

    test('the home link’s focus ring goes round the mark and the wordmark at every width', async ({ page }) => {
      for (const width of [390, 768, 1280]) {
        await open(page, width, theme);
        const home = page.getByRole('banner').getByRole('link', { name: 'AirCase', exact: true });
        // From the top of the page: the skip link, then the home link.
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await expect(home, `${width}px`).toBeFocused();
        expect(await styleOf(home, 'outline-style', 'outline-width'), `${width}px`).toEqual(['solid', '2px']);
        const m = await measure(page);
        expect(m.link && m.mark && contains(m.link, m.mark), `${width}px`).toBe(true);
      }
    });

    test('the wordmark is plain text in the theme blue, the mark in its tokens; other placards keep their style', async ({ page }) => {
      await open(page, 1280, theme, '/cases/DFW08TA066');
      const banner = page.getByRole('banner');
      expect(await styleOf(banner.locator('.wordmark'), 'color', 'background-color', 'border-top-width', 'padding-left', 'text-indent', 'box-shadow')).toEqual([
        theme === 'night' ? 'rgb(147, 185, 247)' : 'rgb(31, 81, 154)',
        'rgba(0, 0, 0, 0)',
        '0px',
        '0px',
        '0px',
        'none',
      ]);
      const [tile] = await styleOf(banner.locator('a[href="/"] svg > path'), 'fill');
      const [glyph] = await styleOf(banner.locator('a[href="/"] svg > g'), 'fill');
      expect([tile, glyph]).toEqual(theme === 'night' ? ['rgb(42, 95, 175)', 'rgb(237, 237, 234)'] : ['rgb(31, 81, 154)', 'rgb(243, 238, 225)']);
      // A section head on the case page is still an engraved placard at night.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await styleOf(page.locator('main .placard'), 'border-top-width', 'background-color')).toEqual(
        theme === 'night' ? ['1px', 'rgb(14, 15, 17)'] : ['0px', 'rgba(0, 0, 0, 0)'],
      );
    });

    test('in print the mark and the wordmark print in day colours; the descriptor does not', async ({ page }) => {
      await open(page, 1280, theme, '/about');
      await page.emulateMedia({ media: 'print' });
      const banner = page.getByRole('banner');
      await expect(banner.getByText(DESCRIPTOR)).toBeHidden();
      await expect(banner.locator('a[href="/"] svg')).toBeVisible();
      await expect(banner.locator('.wordmark')).toBeVisible();
      expect(await styleOf(banner.locator('a[href="/"] svg > path'), 'fill')).toEqual(['rgb(31, 81, 154)']);
    });
  });
}
