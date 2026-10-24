/**
 * Regenerates the brand assets in `web/public` from the mark (shared/brand-mark.ts), the day
 * values of the colour tokens (web/src/styles/tokens.css), the words in shared/brand.ts and the
 * share card's template (scripts/brand-assets/card.html):
 *
 *   favicon.svg, favicon.ico (16, 32 and 48 px), apple-touch-icon.png, icon-192.png,
 *   icon-512.png, icon-maskable-512.png, social/card.png and manifest.webmanifest
 *
 *   pnpm brand:build
 *
 * A development tool: its outputs are committed, and the production build only copies
 * `web/public`. It renders with Playwright's Chromium (`pnpm exec playwright install chromium`)
 * and makes no network requests: the share card's fonts come from the app's own @fontsource
 * packages. It also writes scripts/brand-assets/digest.json, the SHA-256 of what each file was
 * built from and of the file itself, which tests/unit/brand-assets.test.ts compares: a change to
 * any source without a rebuild, or to a file after it, fails that test.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { SHARE_IMAGE } from '../shared/brand.js';
import { encodeIco } from './brand-assets/ico.js';
import { DIGEST_FILE, assetSource, brandAssets, digestJson, sha256, type AssetDigest, type BrandAsset } from './brand-assets/sources.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appDir, 'web', 'public');

/** `svg` rendered at `size` px square, one CSS pixel per image pixel; transparent where nothing is drawn. */
async function renderSvg(page: Page, svg: string, size: number): Promise<Uint8Array> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** The share card: the filled template's `#card`, once every font face it declares has loaded. */
async function renderCard(page: Page, html: string): Promise<Uint8Array> {
  await page.setViewportSize({ width: SHARE_IMAGE.width, height: SHARE_IMAGE.height });
  await page.setContent(html);
  // A fallback font would go unnoticed in a PNG.
  const fonts = await page.evaluate<string[]>(
    'document.fonts.ready.then((set) => [...set].map((face) => `${face.family} ${face.weight}: ${face.status}`))',
  );
  const missing = fonts.filter((face) => !face.endsWith(': loaded'));
  if (fonts.length !== 4 || missing.length > 0) throw new Error(`the share card's fonts did not all load: ${fonts.join(', ')}`);
  return page.locator('#card').screenshot();
}

async function render(page: Page, asset: BrandAsset): Promise<Uint8Array> {
  switch (asset.kind) {
    case 'text':
      return Buffer.from(asset.text, 'utf8');
    case 'png':
      return renderSvg(page, asset.svg, asset.size);
    case 'ico': {
      const images: Uint8Array[] = [];
      for (const image of asset.images) images.push(await renderSvg(page, image.svg, image.size));
      return encodeIco(images);
    }
    case 'card':
      return renderCard(page, asset.html);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const digests: Record<string, AssetDigest> = {};
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const asset of brandAssets(appDir)) {
      const bytes = await render(page, asset);
      const path = join(outDir, asset.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      digests[asset.file] = { source: sha256(assetSource(asset)), output: sha256(bytes) };
      console.log(`web/public/${asset.file}: ${(bytes.length / 1024).toFixed(1)} KiB`);
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(appDir, DIGEST_FILE), digestJson(digests));
  console.log(DIGEST_FILE);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
