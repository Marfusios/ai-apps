import { useId, type MouseEvent } from 'react';
import { cx } from '../lib/cx';
import { Button } from './Button';

export const ASK_AI_PENDING = 'AI search arrives in a later step';

/**
 * The magenta Ask AI button, present but not yet available: it stays focusable
 * (aria-disabled) so its tooltip can be read, and a click does nothing. Briefs
 * (a later step) replace this with the live AI status and counter (UI_DESIGN §5).
 */
export function AskAiButton({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  const tip = useId();
  const ignore = (event: MouseEvent): void => event.preventDefault();
  return (
    <span className={cx('group relative inline-flex', className)}>
      <Button
        variant="ai"
        size={size}
        aria-disabled="true"
        aria-describedby={tip}
        onClick={ignore}
        className="aria-disabled:cursor-not-allowed aria-disabled:border-tint aria-disabled:bg-tint aria-disabled:text-muted aria-disabled:shadow-none"
      >
        Ask AI
      </Button>
      <span
        role="tooltip"
        id={tip}
        className={cx(
          'pointer-events-none absolute top-full right-0 z-30 mt-1.5 rounded-badge bg-ink px-2 py-1 text-meta whitespace-nowrap text-paper',
          'opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        {ASK_AI_PENDING}
      </span>
    </span>
  );
}
