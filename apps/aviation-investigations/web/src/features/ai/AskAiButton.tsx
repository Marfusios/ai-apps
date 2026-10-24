import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { aiStatusQuery } from '../../api';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { useSignIn } from '../auth/SignInDialog';
import { askAvailability, askCounter, signedInOnlyNote, type AskAvailability } from './status';
import type { AiPhase } from './useAiRequest';

export interface AskAiButtonProps {
  /** Runs the AI request (useAiRequest); also called when paused, to explain why. */
  onAsk: () => void;
  phase?: AiPhase;
  /** "Ask AI" by default; brief controls name their action ("Refine", "Re-run AI"). */
  label?: string;
  /** Controls on a brief show "· uses 1" before the click instead of the counter (UI_DESIGN §4.3). */
  usesOne?: boolean;
  size?: 'sm' | 'md';
  /** `chip`: a magenta interpretation chip (AI suggested readings) instead of the filled pill. */
  look?: 'pill' | 'chip';
  className?: string;
}

/**
 * What an AI control says while its request runs: "Checking…" during the Turnstile check,
 * "Starting…" while the request is on its way (the server answers once the scope stage is
 * done, a few seconds); null when idle.
 */
export function busyLabel(phase: AiPhase): string | null {
  return phase === 'checking' ? 'Checking…' : phase === 'sending' ? 'Starting…' : null;
}

/**
 * The magenta Ask AI button with its live availability (UI_DESIGN §2.6, §5):
 * "Ask AI · 3 free", "Ask AI · 18 left today", "Ask AI · sign in" (only while sign-in is
 * offered: otherwise disabled with the counter's words), or disabled with
 * "AI back tomorrow" / "AI back on {date}" / "AI temporarily unavailable". It shows
 * "Checking…" while the Turnstile check runs and "Starting…" while the request is on its
 * way. A disabled button stays focusable (aria-disabled) so its note is read; a click then
 * explains instead of asking.
 */
export function AskAiButton({ onAsk, phase = 'idle', label = 'Ask AI', usesOne = false, size = 'md', look = 'pill', className }: AskAiButtonProps) {
  const status = useQuery(aiStatusQuery());
  const signIn = useSignIn();
  const noteId = useId();
  const read = askAvailability(status.data, status.isError);
  // Only signed-in AI is open and nobody can sign in here: off, with the counter's words (review
  // W-10); while the first configuration read is on its way, the button waits.
  const availability: AskAvailability =
    read.kind !== 'sign_in' || signIn.enabled
      ? read
      : signIn.pending
        ? { kind: 'loading' }
        : { kind: 'paused', note: signedInOnlyNote(read.reason), status: null };
  const describedBy = availability.kind === 'paused' ? noteId : undefined;
  const busy = phase !== 'idle';
  const disabled = availability.kind === 'loading' || availability.kind === 'paused' || busy;
  const counter = busy ? undefined : availability.kind === 'available' && usesOne ? 'uses 1' : askCounter(availability);
  const click = (): void => {
    if (busy || availability.kind === 'loading') return;
    onAsk();
  };
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      {availability.kind === 'paused' && (
        <span id={noteId} className="text-meta whitespace-nowrap text-muted">
          {availability.note}
        </span>
      )}
      {look === 'chip' ? (
        <button
          type="button"
          aria-disabled={disabled}
          aria-busy={busy}
          aria-describedby={describedBy}
          onClick={click}
          className="inline-flex cursor-pointer items-center rounded-chip border border-magenta bg-raised px-2 py-0.5 text-left text-meta text-magenta hover:bg-magenta-wash aria-disabled:cursor-not-allowed aria-disabled:border-hairline aria-disabled:text-muted pointer-coarse:min-h-11"
        >
          {busyLabel(phase) ?? label}
          {counter && <span className="ml-1 whitespace-nowrap">· {counter}</span>}
        </button>
      ) : (
        <Button
          variant="ai"
          size={size}
          counter={counter}
          aria-disabled={disabled}
          aria-busy={busy}
          aria-describedby={describedBy}
          onClick={click}
          className="aria-disabled:cursor-not-allowed aria-disabled:border-tint aria-disabled:bg-tint aria-disabled:text-muted aria-disabled:shadow-none"
        >
          {busyLabel(phase) ?? label}
        </Button>
      )}
    </span>
  );
}
