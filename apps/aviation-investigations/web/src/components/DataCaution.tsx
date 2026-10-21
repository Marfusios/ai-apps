import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface DataCautionProps {
  /** One plain sentence (box) or a short phrase (chip). */
  children: ReactNode;
  /** `box` for the drawer and case page; `chip` for card footers and strips. */
  variant?: 'box' | 'chip';
  /** Defaults to "Data caution". Other hatched states (e.g. "Summary withheld") set their own. */
  label?: string;
  /** The AI flagged this caution: adds the magenta "AI" label (UI_DESIGN §2.7). */
  ai?: boolean;
  className?: string;
}

/**
 * Diagonal hatching on `raised` with a visible label: never red, never a severity
 * colour. The label is always rendered, so the hatching is never the only signal.
 */
export function DataCaution({ children, variant = 'box', label, ai = false, className }: DataCautionProps) {
  const text = label?.trim() || 'Data caution';
  const aiTag = ai && <span className="font-bold tracking-caps text-magenta">AI</span>;
  if (variant === 'chip') {
    return (
      <span
        className={cx(
          'hatch inline-flex items-baseline gap-1.5 rounded-tag border border-caution-edge px-[7px] py-px text-meta text-ink',
          className,
        )}
      >
        <span className="text-[8.5px] font-bold tracking-caps uppercase">{text}</span>
        {aiTag && <span className="text-[8.5px]">{aiTag}</span>}
        <span>{children}</span>
      </span>
    );
  }
  return (
    <div
      role="note"
      className={cx('hatch rounded-chip border border-caution-edge px-3 py-2 text-[12px] leading-[1.45] text-ink', className)}
    >
      <p className="flex gap-2 text-micro font-bold tracking-caps uppercase">
        <span>{text}</span>
        {aiTag}
      </p>
      <p>{children}</p>
    </div>
  );
}
