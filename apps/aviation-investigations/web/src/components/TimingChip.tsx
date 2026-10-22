import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface TimingChipProps {
  /** An AI-extracted timing value, e.g. `5.1 FH`, `1ST FLIGHT`, `≤ 17 DAYS`. */
  children: ReactNode;
  /**
   * Shows the "AI" cell (default). Pass `false` only inside a container that
   * already carries an AI label: a "WHY IT MATCHED" line, an AI box or an AI
   * compare column.
   */
  labelled?: boolean;
  className?: string;
}

/**
 * Timing chip (UI_DESIGN §2.5): magenta mono with a `magenta-soft` border. The
 * values are AI-extracted, so the chip is always magenta.
 */
export function TimingChip({ children, labelled = true, className }: TimingChipProps) {
  return (
    <span
      className={cx(
        'inline-flex items-stretch rounded-tag border border-magenta-soft align-baseline whitespace-nowrap text-magenta',
        className,
      )}
    >
      {labelled && (
        <span className="flex items-center border-r border-magenta-soft px-1 text-micro font-bold tracking-caps">AI</span>
      )}
      <span className="px-[5px] font-mono text-label tracking-mono">{children}</span>
    </span>
  );
}
