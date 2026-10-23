import { Fragment } from 'react';
import { Link } from 'react-router';
import type { BriefStepResponse } from '../../../../shared/contracts/briefs';
import { cx } from '../../lib/cx';
import { filterChips } from './filters';

/** What started a step, in words (the line under the switcher). */
export function originWords(origin: BriefStepResponse['origin']): string | null {
  switch (origin.kind) {
    case 'question':
      return null;
    case 'text':
      return `Refined: “${origin.text}”`;
    case 'interpretation':
      return `Reading changed: ${origin.label}`;
    case 'filters': {
      const chips = filterChips(origin.filters).map((c) => c.label);
      return chips.length > 0 ? `Filters changed: ${chips.join(', ')}` : 'Filters removed';
    }
  }
}

export interface StepSwitcherProps {
  briefId: string;
  /** The step shown. */
  step: number;
  /** Steps in the brief. */
  steps: number;
  origin: BriefStepResponse['origin'];
}

/**
 * "Answer 1 · 2 · 3" under the question (UI_DESIGN §3, §4.3): every step of the brief
 * stays readable until it expires. Reading an earlier answer is free.
 */
export function StepSwitcher({ briefId, step, steps, origin }: StepSwitcherProps) {
  const words = originWords(origin);
  return (
    <div className="mt-1.5 mb-2.5 text-meta" data-print="hide">
      {steps > 1 && (
        <nav aria-label="Answers in this brief" className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-muted">Answer</span>
          {Array.from({ length: steps }, (_, i) => i + 1).map((n) => (
            <Fragment key={n}>
              {n > 1 && (
                <span aria-hidden="true" className="text-muted">
                  ·
                </span>
              )}
              <Link
                to={n === steps ? `/briefs/${briefId}` : `/briefs/${briefId}?step=${n}`}
                aria-current={n === step ? 'page' : undefined}
                aria-label={`Answer ${n}${n === steps ? ', latest' : ''}`}
                className={cx(
                  'touch-target inline-flex min-w-4 justify-center font-mono',
                  n === step ? 'border-b-2 border-blue font-bold text-ink' : 'text-blue hover:underline',
                )}
              >
                {n}
              </Link>
            </Fragment>
          ))}
        </nav>
      )}
      {words && <p className="mt-0.5 text-muted">{words}</p>}
    </div>
  );
}
