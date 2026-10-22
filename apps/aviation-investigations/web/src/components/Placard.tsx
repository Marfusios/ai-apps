import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export type PlacardTone = 'blue' | 'ink' | 'ai';

export interface PlacardProps {
  children: ReactNode;
  /** `blue` for eyebrows, `ink` for section heads, `ai` for AI labels (always magenta). */
  tone?: PlacardTone;
  as?: 'span' | 'p' | 'div' | 'h2' | 'h3' | 'h4';
  id?: string;
  className?: string;
}

/**
 * Small uppercase label: an eyebrow such as "YOUR QUESTION" or a section head such
 * as "THE FLIGHT". By day it is plain coloured text; at night it becomes an
 * engraved placard (UI_DESIGN §2.8). Write the text in sentence case; CSS sets caps.
 */
export function Placard({ children, tone = 'blue', as: Tag = 'span', id, className }: PlacardProps) {
  return (
    <Tag id={id} className={cx('placard', className)} data-tone={tone}>
      {children}
    </Tag>
  );
}
