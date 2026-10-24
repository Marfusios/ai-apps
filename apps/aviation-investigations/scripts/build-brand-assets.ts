/**
 * Regenerates the brand assets in `web/public` from the mark (shared/brand-mark.ts), the day
 * values of its colour tokens (web/src/styles/tokens.css) and the words in shared/brand.ts:
 *
 *   favicon.svg, favicon.ico (16, 32 and 48 px), apple-touch-icon.png, icon-192.png,
 *   icon-512.png, icon-maskable-512.png, social/card.png and manifest.webmanifest
 *
 *   pnpm brand:build
 *
 * A development tool: its outputs are committed, and the production build only copies
 * `web/public`. It renders with Playwright's Chromium (`pnpm exec playwright install chromium`)
 * and makes no network requests: the share card's fonts come from the app's own @fontsource
 * packages. tests/unit/brand-assets.test.ts fails when the committed favicon.svg or manifest no
 * longer matches its sources; the PNG files need this script run again after a change to the
 * mark, its colours or the share card's words.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { SHARE_IMAGE } from '../shared/brand.js';
import { markSvg, markVariant } from '../shared/brand-mark.js';
import { encodeIco } from './brand-assets/ico.js';
import { BRAND_ICONS, FAVICON_ICO_SIZES, cardHtml, faviconSvg, iconSvg, manifestJson, readBrandColours } from './brand-assets/sources.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appDir, 'web', 'public');

function write(name: string, content: string | Uint8Array): void {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
  console.log(`web/public/${name}: ${(bytes / 1024).toFixed(1)} KiB`);
}

/** `svg` rendered at `size` px square, one CSS pixel per image pixel; transparent where nothing is drawn. */
async function renderSvg(page: Page, svg: string, size: number): Promise<Uint8Array> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

async function main(): Promise<void> {
  const colours = readBrandColours(appDir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });

    write('favicon.svg', faviconSvg(colours));
    const icoImages: Uint8Array[] = [];
    for (const size of FAVICON_ICO_SIZES) {
      icoImages.push(await renderSvg(page, markSvg({ variant: markVariant(size), tile: colours.tile, glyph: colours.glyph, size }), size));
    }
    write('favicon.ico', encodeIco(icoImages));
    for (const icon of BRAND_ICONS) write(icon.file, await renderSvg(page, iconSvg(icon, colours), icon.size));

    await page.setViewportSize({ width: SHARE_IMAGE.width, height: SHARE_IMAGE.height });
    await page.setContent(cardHtml(appDir, colours));
    // Every font face the card declares must have loaded: a fallback font would go unnoticed in a PNG.
    const fonts = await page.evaluate<string[]>(
      'document.fonts.ready.then((set) => [...set].map((face) => `${face.family} ${face.weight}: ${face.status}`))',
    );
    const missing = fonts.filter((face) => !face.endsWith(': loaded'));
    if (fonts.length !== 4 || missing.length > 0) throw new Error(`the share card's fonts did not all load: ${fonts.join(', ')}`);
    write(SHARE_IMAGE.path.slice(1), await page.locator('#card').screenshot());

    write('manifest.webmanifest', manifestJson(colours));
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
