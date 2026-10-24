/**
 * The header's lockup in a real browser (UI_DESIGN §3, §6, owner decisions of 2026-10-24): the
 * mark and the wordmark link home; the descriptor sits beside the wordmark after a hairline from
 * 1024px, is left out on tablets, where the header has no room for it, and goes under the
 * wordmark on phones. It is never cut short, never wraps the navigation and leaves the header
 * as tall as it was. At night the wordmark is plain blue text, not a placard.
 */
import { expect, test, type Page } from '@playwright/test';

const DESCRIPTOR = 'Plane crash & accident investigations';

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

async function open(page: Page, width: number, theme: 'day' | 'night', path = '/explore'): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.addInitScript(`localStorage.setItem('casebook-theme', '${theme}')`);
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate('document.fonts.ready');
  // The AI counter has read the status: the header is complete.
  await expect
    .poll(() => page.locator('header').evaluate((h) => h.querySelector('button[aria-controls]')?.parentElement?.firstElementChild?.textContent ?? ''))
    .toMatch(/^AI /);
}

interface Measured {
  header: Box;
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

for (const theme of ['day', 'night'] as const) {
  test.describe(`by ${theme}`, () => {
    test('phone (390px): the descriptor under the wordmark, the mark centred beside both, the counter whole', async ({ page }) => {
      await open(page, 390, theme);
      await expect(page.getByRole('banner').getByRole('link', { name: 'AirCase', exact: true })).toBeVisible();
      await expect(page.getByRole('banner').getByText(DESCRIPTOR)).toBeVisible();
      const m = await measure(page);
      const { mark, wordmark, descriptor, counter, menu } = m;
      if (!mark || !wordmark || !descriptor || !counter || !menu) throw new Error(`missing part: ${JSON.stringify(m)}`);
      // Two lines: the descriptor starts under the wordmark, at its left edge, on one line, whole.
      expect(descriptor.y).toBeGreaterThanOrEqual(bottom(wordmark) - 1);
      expect(Math.abs(descriptor.x - wordmark.x)).toBeLessThanOrEqual(1);
      expect(m.descriptorLines).toBe(1);
      expect(m.descriptorCut).toBe(false);
      // The mark sits left of both lines, centred on them.
      expect(right(mark)).toBeLessThanOrEqual(wordmark.x);
      expect(Math.abs(middle(mark) - (wordmark.y + bottom(descriptor)) / 2)).toBeLessThanOrEqual(1.5);
      // The AI counter keeps the wordmark's line and its whole text; nothing touches the menu button.
      expect(Math.abs(middle(counter) - middle(wordmark))).toBeLessThanOrEqual(1.5);
      expect(apart(counter, menu) && apart(descriptor, menu) && apart(descriptor, counter)).toBe(true);
      expect(m.counterCut).toBe(false);
      // As tall as the menu button's row was, and no sideways scrolling.
      expect(m.header.height).toBe(await heightWithoutLockup(page));
      expect(m.pageWidth).toBe(390);
    });

    test('tablet (768px): the mark and the wordmark, no descriptor, the nav on one line', async ({ page }) => {
      await open(page, 768, theme);
      await expect(page.getByRole('banner').getByRole('link', { name: 'AirCase', exact: true })).toBeVisible();
      await expect(page.getByRole('banner').getByText(DESCRIPTOR)).toBeHidden();
      const m = await measure(page);
      expect(m.mark).not.toBeNull();
      expect(m.navLinks).toHaveLength(2);
      for (const link of m.navLinks) expect(link.height).toBeLessThan(30);
      expect(m.header.height).toBe(await heightWithoutLockup(page));
      expect(m.pageWidth).toBe(768);
    });

    for (const width of [1024, 1280]) {
      test(`desktop (${width}px): the descriptor beside the wordmark after a hairline, the header as tall as before`, async ({ page }) => {
        await open(page, width, theme);
        await expect(page.getByRole('banner').getByText(DESCRIPTOR)).toBeVisible();
        const m = await measure(page);
        const { mark, wordmark, descriptor, counter } = m;
        if (!mark || !wordmark || !descriptor || !counter) throw new Error(`missing part: ${JSON.stringify(m)}`);
        expect(right(mark)).toBeLessThanOrEqual(wordmark.x);
        expect(descriptor.x).toBeGreaterThan(right(wordmark));
        expect(Math.abs(middle(descriptor) - middle(wordmark))).toBeLessThanOrEqual(2);
        expect(m.descriptorLines).toBe(1);
        expect(m.descriptorCut).toBe(false);
        // Nothing overlaps, and the nav stays on one line.
        for (const link of m.navLinks) {
          expect(link.height).toBeLessThan(30);
          expect(apart(descriptor, link)).toBe(true);
        }
        expect(right(descriptor)).toBeLessThan(m.navLinks[0]?.x ?? 0);
        expect(apart(descriptor, counter)).toBe(true);
        // A hairline before it.
        expect(await styleOf(page.getByRole('banner').getByText(DESCRIPTOR), 'border-left-width', 'border-left-style')).toEqual(['1px', 'solid']);
        expect(m.header.height).toBe(await heightWithoutLockup(page));
        expect(m.pageWidth).toBe(width);
      });
    }

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
