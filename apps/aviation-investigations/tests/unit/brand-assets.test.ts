/**
 * The brand assets in web/public (`pnpm brand:build`, scripts/build-brand-assets.ts): the ICO
 * encoder's header bytes, and the committed files against what they are built from, so a change
 * to the mark, its colours or the words in shared/brand.ts without a rebuild fails here.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeIco, pngSize } from '../../scripts/brand-assets/ico.js';
import { BRAND_ICONS, faviconSvg, manifestJson, readBrandColours } from '../../scripts/brand-assets/sources.js';
import { SHARE_IMAGE, SITE_DESCRIPTION } from '../../shared/brand.js';
import { APP_DIR } from '../support/extract-dir.js';

/** A stand-in PNG: the signature and an IHDR chunk header with the given size, then filler bytes. */
function fakePng(width: number, height: number, length: number): Uint8Array {
  const png = new Uint8Array(length).fill(0xab);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return png;
}

describe('the ICO encoder', () => {
  it('writes the icon header and one directory entry per PNG, then the PNGs as they are', () => {
    const pngs = [fakePng(16, 16, 40), fakePng(32, 32, 52), fakePng(48, 48, 64)];
    const ico = encodeIco(pngs);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    // Reserved 0, type 1 (icon), three images; all little-endian.
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0]);
    let offset = 6 + 3 * 16;
    pngs.forEach((png, i) => {
      const at = 6 + 16 * i;
      const side = [16, 32, 48][i] as number;
      // Width, height, no palette, reserved, one colour plane, 32 bits per pixel.
      expect([...ico.subarray(at, at + 8)]).toEqual([side, side, 0, 0, 1, 0, 32, 0]);
      expect(view.getUint32(at + 8, true)).toBe(png.length);
      expect(view.getUint32(at + 12, true)).toBe(offset);
      expect(ico.subarray(offset, offset + png.length)).toEqual(png);
      offset += png.length;
    });
    expect(ico.length).toBe(offset);
    // 256 px is written as 0; a larger image, or one that is not a PNG, is refused.
    expect([...encodeIco([fakePng(256, 256, 30)]).subarray(6, 8)]).toEqual([0, 0]);
    expect(() => encodeIco([fakePng(300, 300, 30)])).toThrow(/256/);
    expect(() => encodeIco([new Uint8Array(30)])).toThrow(/PNG/);
  });
});

describe('the committed brand assets (rebuild with pnpm brand:build)', () => {
  const file = (name: string): string => join(APP_DIR, 'web/public', name);
  const colours = readBrandColours(APP_DIR);

  it('take the mark and paper colours from the day tokens', () => {
    expect(colours).toEqual({ tile: '#1F519A', glyph: '#F3EEE1', paper: '#F3EEE1' });
  });

  it('favicon.svg is the small mark in its day colours', () => {
    expect(readFileSync(file('favicon.svg'), 'utf8')).toBe(faviconSvg(colours));
  });

  it('manifest.webmanifest names AirCase, describes the site and lists the three icons', () => {
    const text = readFileSync(file('manifest.webmanifest'), 'utf8');
    expect(text).toBe(manifestJson(colours));
    expect(JSON.parse(text)).toEqual({
      name: 'AirCase',
      short_name: 'AirCase',
      description: SITE_DESCRIPTION,
      start_url: '/',
      display: 'standalone',
      background_color: '#F3EEE1',
      theme_color: '#F3EEE1',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  it('the icons and the share card have their sizes, and every file stays under 200 KB', () => {
    for (const icon of BRAND_ICONS) {
      expect(pngSize(readFileSync(file(icon.file))), icon.file).toEqual({ width: icon.size, height: icon.size });
    }
    expect(pngSize(readFileSync(file(SHARE_IMAGE.path.slice(1))))).toEqual({ width: SHARE_IMAGE.width, height: SHARE_IMAGE.height });
    // favicon.ico: 16, 32 and 48 px.
    const ico = readFileSync(file('favicon.ico'));
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0]);
    expect([ico[6], ico[22], ico[38]]).toEqual([16, 32, 48]);
    for (const name of ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'social/card.png', ...BRAND_ICONS.map((i) => i.file)]) {
      expect(statSync(file(name)).size, name).toBeLessThan(200 * 1024);
    }
  });
});
