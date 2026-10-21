import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

/**
 * A coded NTSB value in B612 Mono on `blue-wash`: weather and other coded fields,
 * e.g. `VMC`, `10 SM`, `ALTIMETER 30.22` (UI_DESIGN §2.5).
 */
export function MonoChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-block rounded-badge bg-blue-wash px-[5px] py-px font-mono text-meta tracking-mono whitespace-nowrap text-ink',
        className,
      )}
    >
      {children}
    </span>
  );
}
