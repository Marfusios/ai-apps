import { cx } from '../lib/cx';

/**
 * The home page compass mark (UI_DESIGN §2.5): outer ring, dotted inner ring,
 * cardinal ticks, an ink diamond needle and a magenta centre dot. Decorative.
 */
export function CompassMark({ size = 58, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 58 58"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0', className)}
    >
      <circle cx="29" cy="29" r="26" className="fill-none stroke-blue" strokeWidth="1.2" />
      <circle cx="29" cy="29" r="20" className="fill-none stroke-blue" strokeWidth=".6" strokeDasharray="1 3.2" />
      <path d="M29 2v10M29 46v10M2 29h10M46 29h10" className="stroke-blue" strokeWidth="1.2" />
      <path d="M29 14 L32 29 L29 44 L26 29 Z" className="fill-none stroke-ink" strokeWidth="1" strokeLinejoin="round" />
      <circle cx="29" cy="29" r="3" className="fill-magenta" />
    </svg>
  );
}
