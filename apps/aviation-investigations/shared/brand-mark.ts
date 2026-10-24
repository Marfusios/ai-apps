/**
 * The AirCase mark (owner pick of 2026-10-24, UI_DESIGN §2.5): a case folder carrying an
 * aircraft, drawn on a 64-unit grid. This module is the one source of its geometry, for the
 * header's mark (web/src/components/BrandMark.tsx, coloured by the `--mark-tile` and
 * `--mark-glyph` tokens) and for the icons and the share card (scripts/build-brand-assets.ts,
 * `pnpm brand:build`, which takes the same tokens' day values).
 *
 * Two optical sizes: below 40 px (the tab icon, the header) the aircraft is heavier and a little
 * larger, so that it still reads at 16 px; from 40 px up it is the finer drawing. There is no
 * tile behind the folder: around it the mark is transparent.
 */

/** The grid the mark is drawn on (`viewBox="0 0 64 64"`). */
export const MARK_GRID = 64;

/** The folder, its tab at the top left, in the tile colour. */
export const MARK_FOLDER_PATH =
  'M5 15.5 a4.5 4.5 0 0 1 4.5-4.5 H24 l5.5 5.5 H54.5 a4.5 4.5 0 0 1 4.5 4.5 V50.5 a4.5 4.5 0 0 1 -4.5 4.5 H9.5 a4.5 4.5 0 0 1 -4.5-4.5 Z';

/** The folder's box on the grid and the radius of its corners: for icons that place it on a square. */
export const MARK_FOLDER_BOX = { x: 5, y: 11, width: 54, height: 44, cornerRadius: 4.5 } as const;

export type MarkShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { kind: 'path'; d: string };

/** The aircraft, in the glyph colour: one group (placed and turned nose up to the right) of shapes. */
export interface MarkAircraft {
  transform: string;
  /** The fuselage, the wings and the tailplane. */
  shapes: readonly MarkShape[];
}

export type MarkVariant = 'small' | 'large';

/** From this size (CSS pixels) up the finer aircraft is drawn. */
export const MARK_LARGE_FROM_PX = 40;

/** The aircraft at each optical size. */
export const MARK_AIRCRAFT: Readonly<Record<MarkVariant, MarkAircraft>> = {
  small: {
    transform: 'translate(32 36.5) rotate(-35) scale(1.1)',
    shapes: [
      { kind: 'rect', x: -3.1, y: -15.5, width: 6.2, height: 30, rx: 3.1 },
      { kind: 'path', d: 'M0 -5 L18 3.6 V8.8 L0 2.8 L-18 8.8 V3.6 Z' },
      { kind: 'path', d: 'M0 8.6 L8.2 12.6 V16 L0 13.6 L-8.2 16 V12.6 Z' },
    ],
  },
  large: {
    transform: 'translate(32 36) rotate(-35)',
    shapes: [
      { kind: 'rect', x: -2.1, y: -15, width: 4.2, height: 29, rx: 2.1 },
      { kind: 'path', d: 'M0 -3.5 L17 4 V7 L0 2.2 L-17 7 V4 Z' },
      { kind: 'path', d: 'M0 9.5 L7 13 V14.8 L0 12.8 L-7 14.8 V13 Z' },
    ],
  },
};

/** The optical size for a mark drawn `sizePx` CSS pixels wide. */
export function markVariant(sizePx: number): MarkVariant {
  return sizePx >= MARK_LARGE_FROM_PX ? 'large' : 'small';
}

export interface MarkSvgOptions {
  variant: MarkVariant;
  /** The folder's colour. */
  tile: string;
  /** The aircraft's colour. */
  glyph: string;
  /** Width and height attributes in px; left out, the SVG scales to where it is used (a favicon). */
  size?: number;
  /** The area shown, `[x, y, width, height]` on the grid: the whole grid unless an icon frames the folder itself. */
  frame?: readonly [number, number, number, number];
  /** A full-bleed fill behind the folder, for icon formats that cannot be transparent. */
  background?: string;
}

function shapeMarkup(shape: MarkShape): string {
  return shape.kind === 'rect'
    ? `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.rx}"/>`
    : `<path d="${shape.d}"/>`;
}

/**
 * The mark as a standalone SVG document, in the given colours: the favicon, the icons and the
 * share card's mark, which cannot read the stylesheet's tokens. Colours are written as given
 * and must be CSS colours.
 */
export function markSvg(options: MarkSvgOptions): string {
  const [x, y, width, height] = options.frame ?? [0, 0, MARK_GRID, MARK_GRID];
  const aircraft = MARK_AIRCRAFT[options.variant];
  const size = options.size === undefined ? '' : ` width="${options.size}" height="${options.size}"`;
  const background = options.background === undefined ? '' : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${options.background}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}"${size}>` +
    background +
    `<path d="${MARK_FOLDER_PATH}" fill="${options.tile}"/>` +
    `<g transform="${aircraft.transform}" fill="${options.glyph}">${aircraft.shapes.map(shapeMarkup).join('')}</g>` +
    '</svg>'
  );
}
