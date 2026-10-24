import { MARK_AIRCRAFT, MARK_FOLDER_PATH, MARK_GRID, markVariant } from '../../../shared/brand-mark';
import { cx } from '../lib/cx';

export interface BrandMarkProps {
  /** Width and height in px; below 40 the heavier aircraft is drawn (shared/brand-mark.ts). */
  size?: number;
  className?: string;
}

/**
 * The AirCase mark (UI_DESIGN §2.5): a case folder carrying an aircraft, transparent around the
 * folder. Its colours are the `--mark-tile` and `--mark-glyph` tokens, so it follows the theme
 * and prints in its day colours. Decorative: it stands beside the wordmark, which names the link.
 */
export function BrandMark({ size = 22, className }: BrandMarkProps) {
  const aircraft = MARK_AIRCRAFT[markVariant(size)];
  return (
    <svg
      viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0', className)}
    >
      <path d={MARK_FOLDER_PATH} className="fill-mark-tile" />
      <g transform={aircraft.transform} className="fill-mark-glyph">
        {aircraft.shapes.map((shape, i) =>
          shape.kind === 'rect' ? (
            <rect key={i} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />
          ) : (
            <path key={i} d={shape.d} />
          ),
        )}
      </g>
    </svg>
  );
}
