import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { aiLabel } from './AiChip';
import { Placard } from './Placard';

export interface AiBlockProps {
  /** For example "AI summary · check the cited passages". Always shown. */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * AI-written text: serif on a 3px magenta left rule, under a magenta label
 * (UI_DESIGN §4.3). The colour and label come from here so they cannot drift.
 */
export function AiBlock({ label, children, className }: AiBlockProps) {
  return (
    <section className={cx('border-l-[3px] border-magenta py-0.5 pl-3.5', className)}>
      <Placard tone="ai" as="h2">
        {aiLabel(label)}
      </Placard>
      <div className="mt-1 font-serif text-quote">{children}</div>
    </section>
  );
}
