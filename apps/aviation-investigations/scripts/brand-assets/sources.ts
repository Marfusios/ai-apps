/**
 * What the brand assets in web/public are built from (scripts/build-brand-assets.ts): the mark
 * (shared/brand-mark.ts), the day values of its colour tokens and of the paper
 * (web/src/styles/tokens.css), and the words in shared/brand.ts. Pure apart from reading those
 * files, so tests/unit/brand-assets.test.ts can hold the committed files to them.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PRODUCT_DESCRIPTOR, PRODUCT_NAME, SHARE_CARD_TEXT, SITE_DESCRIPTION } from '../../shared/brand.js';
import { MARK_FOLDER_BOX, markSvg, markVariant } from '../../shared/brand-mark.js';

export interface BrandColours {
  /** The folder (`--mark-tile`). */
  tile: string;
  /** The aircraft (`--mark-glyph`). */
  glyph: string;
  /** The page (`--paper`): full-bleed icon backgrounds and the manifest's colours. */
  paper: string;
}

/** The day values of `--mark-tile`, `--mark-glyph` and `--paper` in web/src/styles/tokens.css. */
export function readBrandColours(appDir: string): BrandColours {
  const css = readFileSync(join(appDir, 'web/src/styles/tokens.css'), 'utf8');
  const start = css.indexOf('[data-theme="day"] {');
  if (start < 0) throw new Error('tokens.css has no day block');
  const block = css.slice(start, css.indexOf('}', start));
  const token = (name: string): string => {
    const value = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6});`).exec(block)?.[1];
    if (!value) throw new Error(`tokens.css has no day colour for --${name}`);
    return value;
  };
  return { tile: token('mark-tile'), glyph: token('mark-glyph'), paper: token('paper') };
}

/** The tab icon: the mark at its small optical size, transparent around the folder. */
export function faviconSvg(colours: BrandColours): string {
  return `${markSvg({ variant: 'small', tile: colours.tile, glyph: colours.glyph })}\n`;
}

/** The sizes in favicon.ico. */
export const FAVICON_ICO_SIZES = [16, 32, 48] as const;

export interface BrandIcon {
  file: string;
  size: number;
  /**
   * `mark`: the mark as drawn, transparent around the folder. `touch`: the folder 80 % of the
   * width across, on a full-bleed paper square (an Apple touch icon has no transparency, and the
   * folder would vanish into a blue one). `maskable`: on a full-bleed paper square, the folder
   * inside the safe zone that any mask leaves visible.
   */
  placement: 'mark' | 'touch' | 'maskable';
  /** Its purpose in the web app manifest; the Apple touch icon is not listed there. */
  purpose?: 'any' | 'maskable';
}

export const BRAND_ICONS: readonly BrandIcon[] = [
  { file: 'apple-touch-icon.png', size: 180, placement: 'touch' },
  { file: 'icon-192.png', size: 192, placement: 'mark', purpose: 'any' },
  { file: 'icon-512.png', size: 512, placement: 'mark', purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, placement: 'maskable', purpose: 'maskable' },
];

/** A square frame on the mark's grid, `side` units across, centred on the folder. */
function frameAroundFolder(side: number): [number, number, number, number] {
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const cx = MARK_FOLDER_BOX.x + MARK_FOLDER_BOX.width / 2;
  const cy = MARK_FOLDER_BOX.y + MARK_FOLDER_BOX.height / 2;
  return [round(cx - side / 2), round(cy - side / 2), round(side), round(side)];
}

/**
 * How far the folder reaches from its centre: to the outer edge of a rounded corner. The
 * maskable icon keeps that within 39 % of its width, just inside the safe zone, a circle whose
 * radius is 40 % of the width.
 */
const FOLDER_REACH = Math.hypot(MARK_FOLDER_BOX.width / 2 - MARK_FOLDER_BOX.cornerRadius, MARK_FOLDER_BOX.height / 2 - MARK_FOLDER_BOX.cornerRadius) + MARK_FOLDER_BOX.cornerRadius;
const FRAMES = {
  touch: frameAroundFolder(MARK_FOLDER_BOX.width / 0.8),
  maskable: frameAroundFolder(FOLDER_REACH / 0.39),
} as const;

/** An icon's SVG, at the optical size for its pixel size. */
export function iconSvg(icon: BrandIcon, colours: BrandColours): string {
  const mark = { variant: markVariant(icon.size), tile: colours.tile, glyph: colours.glyph, size: icon.size } as const;
  return icon.placement === 'mark' ? markSvg(mark) : markSvg({ ...mark, frame: FRAMES[icon.placement], background: colours.paper });
}

/** web/public/manifest.webmanifest, as written. */
export function manifestJson(colours: BrandColours): string {
  const manifest = {
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: SITE_DESCRIPTION,
    start_url: '/',
    display: 'standalone',
    background_color: colours.paper,
    theme_color: colours.paper,
    icons: BRAND_ICONS.filter((icon) => icon.purpose !== undefined).map((icon) => ({
      src: `/${icon.file}`,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: icon.purpose,
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The share card

export const CARD_TEMPLATE = 'scripts/brand-assets/card.html';
/** The mark on the card, in px. */
export const CARD_MARK_SIZE = 92;

/** The card's fonts: the app's own WOFF2 files (web/src/styles/fonts.css), as `data:` URLs. */
const CARD_FONTS = {
  'font-b612-400': '@fontsource/b612/files/b612-latin-400-normal.woff2',
  'font-b612-700': '@fontsource/b612/files/b612-latin-700-normal.woff2',
  'font-b612-mono-400': '@fontsource/b612-mono/files/b612-mono-latin-400-normal.woff2',
  'font-serif-4': '@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2',
} as const;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** The card template with every slot filled: a whole page, ready to render at 1200×630. */
export function cardHtml(appDir: string, colours: BrandColours): string {
  const require = createRequire(join(appDir, 'package.json'));
  const fonts = Object.fromEntries(
    Object.entries(CARD_FONTS).map(([slot, file]) => [slot, `data:font/woff2;base64,${readFileSync(require.resolve(file)).toString('base64')}`]),
  );
  const slots: Readonly<Record<string, string>> = {
    ...fonts,
    mark: markSvg({ variant: markVariant(CARD_MARK_SIZE), tile: colours.tile, glyph: colours.glyph, size: CARD_MARK_SIZE }),
    name: escapeHtml(PRODUCT_NAME),
    headline: escapeHtml(PRODUCT_DESCRIPTOR),
    subline: escapeHtml(SHARE_CARD_TEXT.subline),
    site: escapeHtml(SHARE_CARD_TEXT.site),
    disclaimer: escapeHtml(SHARE_CARD_TEXT.disclaimer),
  };
  const template = readFileSync(join(appDir, CARD_TEMPLATE), 'utf8');
  return template.replace(/\{\{([a-z0-9-]+)\}\}/g, (_, slot: string) => {
    const value = slots[slot];
    if (value === undefined) throw new Error(`${CARD_TEMPLATE} has an unknown slot {{${slot}}}`);
    return value;
  });
}
