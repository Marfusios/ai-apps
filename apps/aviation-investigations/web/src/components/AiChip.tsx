import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

/**
 * Every AI element carries a visible text label (UI_DESIGN §2.1). A blank label
 * becomes "AI"; a label that does not name the AI gets an "AI · " prefix.
 */
export function aiLabel(label?: string): string {
  const text = (label ?? '').trim();
  if (text === '') return 'AI';
  return /\bAI\b/i.test(text) ? text : `AI · ${text}`;
}

export interface AiChipProps {
  children: ReactNode;
  /** The label cell; defaults to "AI". */
  label?: string;
  /** Makes the chip a button with the ✎ edit mark (interpretation chips). */
  onEdit?: () => void;
  className?: string;
}

/**
 * Magenta chip for anything the AI wrote or decided: interpretation chips and
 * suggested readings. The AI label is part of the chip and cannot be turned off.
 * Timing values use TimingChip.
 */
export function AiChip({ children, label, onEdit, className }: AiChipProps) {
  const body = (
    <>
      <span className="flex items-center border-r border-magenta-soft px-1.5 text-micro font-bold tracking-caps uppercase">
        {aiLabel(label)}
      </span>
      <span className="px-2 py-0.5">
        {children}
        {onEdit && (
          <>
            <span aria-hidden="true" className="ml-1.5">
              ✎
            </span>
            <span className="sr-only">, edit</span>
          </>
        )}
      </span>
    </>
  );
  const classes = cx(
    'inline-flex items-stretch rounded-chip border border-magenta bg-raised text-meta text-magenta',
    className,
  );
  if (onEdit) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className={cx(classes, 'cursor-pointer text-left hover:bg-magenta-wash pointer-coarse:min-h-11')}
      >
        {body}
      </button>
    );
  }
  return <span className={classes}>{body}</span>;
}
