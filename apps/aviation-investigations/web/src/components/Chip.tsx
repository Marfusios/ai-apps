import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export type ChipVariant = 'filter' | 'add' | 'filled' | 'example';

export interface ChipProps {
  children: ReactNode;
  /**
   * `filter`: a set filter or cohort (blue outline, 6px radius).
   * `add`: "+ Filter" (dashed).
   * `filled`: emphasised, e.g. the phone "Filters (2)" chip.
   * `example`: home example questions, prefixed with ↳.
   */
  variant?: ChipVariant;
  /** Renders a button. */
  onClick?: () => void;
  /** For toggle chips: rendered as aria-pressed. */
  pressed?: boolean;
  className?: string;
}

const VARIANT: Record<ChipVariant, string> = {
  filter: 'rounded-chip border border-blue bg-raised px-2 py-0.5 text-blue',
  add: 'rounded-chip border border-dashed border-blue px-2 py-0.5 text-blue',
  filled: 'rounded-chip border border-blue bg-blue px-2 py-0.5 font-bold text-on-blue',
  example: 'rounded-full border border-hairline bg-raised/75 px-2.5 py-[3px] text-ink',
};

export function Chip({ children, variant = 'filter', onClick, pressed, className }: ChipProps) {
  const content = (
    <>
      {variant === 'example' && (
        <span aria-hidden="true" className="mr-1 text-blue">
          ↳
        </span>
      )}
      {children}
    </>
  );
  const classes = cx('inline-flex items-center text-meta whitespace-nowrap', VARIANT[variant], className);
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        className={cx(
          classes,
          'cursor-pointer pointer-coarse:min-h-11',
          variant === 'filled' ? 'hover:shadow-[0_0_0_3px_var(--blue-wash)]' : 'hover:bg-blue-wash',
        )}
      >
        {content}
      </button>
    );
  }
  return <span className={classes}>{content}</span>;
}
