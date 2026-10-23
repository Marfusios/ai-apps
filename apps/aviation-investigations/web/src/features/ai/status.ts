/**
 * What the AI status (`GET /api/ai/status`, UI_DESIGN §5) means for the controls: the
 * header counter, the Ask AI and Refine labels, and whether a click can run the AI.
 * The copy is the owner-approved §5 text.
 */
import type { AiStatusResponse } from '../../../../shared/contracts/ai';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Nov" from a UTC instant (budgets reset at 00:00 UTC). */
export function retryDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "AI back tomorrow", "AI back on 1 Nov" or "AI temporarily unavailable" for a paused state. */
export function pausedNote(status: Extract<AiStatusResponse, { state: 'paused' }>): string {
  if (!status.retryAt) return 'AI temporarily unavailable';
  if (status.reason === 'daily_budget' || status.reason === 'daily_cap') return 'AI back tomorrow';
  if (status.reason === 'monthly_budget' || status.reason === 'monthly_cap') return `AI back on ${retryDay(status.retryAt)}`;
  return 'AI temporarily unavailable';
}

export type AskAvailability =
  /** Status not known yet: the button waits. */
  | { kind: 'loading' }
  /**
   * A click runs the AI. `counter` is the suffix ("3 free", "18 left today"). `check`: the
   * request takes a Turnstile check (every anonymous one; a signed-in one the server asks
   * to check, DESIGN §8).
   */
  | { kind: 'available'; counter: string; anonymous: boolean; firstCheck: boolean; check: boolean }
  /** Only signed-in AI is open and this visitor is anonymous: "Ask AI · sign in". */
  | { kind: 'sign_in'; reason: Extract<AiStatusResponse, { state: 'signed_in_only' }>['reason'] }
  /**
   * AI is paused (for everyone, or this account's cap), or its status cannot be read
   * (`status` null): disabled, with a muted note.
   */
  | { kind: 'paused'; note: string; status: Extract<AiStatusResponse, { state: 'paused' }> | null };

/** `unreadable`: the status request failed, so nothing is promised and nothing runs. */
export function askAvailability(status: AiStatusResponse | undefined, unreadable = false): AskAvailability {
  if (!status) return unreadable ? { kind: 'paused', note: 'AI temporarily unavailable', status: null } : { kind: 'loading' };
  if (status.state === 'paused') return { kind: 'paused', note: pausedNote(status), status };
  const remaining = status.remaining;
  if (status.state === 'signed_in_only' && remaining?.kind !== 'account') return { kind: 'sign_in', reason: status.reason };
  if (remaining?.kind === 'account') {
    return { kind: 'available', counter: `${remaining.leftToday} left today`, anonymous: false, firstCheck: false, check: remaining.check === true };
  }
  if (remaining?.kind === 'trial') {
    return { kind: 'available', counter: `${remaining.left} free`, anonymous: true, firstCheck: !remaining.started, check: true };
  }
  // No counts to show (should not happen while available): still anonymous until proven otherwise.
  return { kind: 'available', counter: 'free', anonymous: true, firstCheck: true, check: true };
}

/** The counter suffix of an AI button: "3 free", "sign in", or nothing when paused. */
export function askCounter(a: AskAvailability): string | undefined {
  if (a.kind === 'available') return a.counter;
  if (a.kind === 'sign_in') return 'sign in';
  return undefined;
}

/** "AI searches left: 2 of 3" in words, for lines next to a brief's controls. */
export function remainingWords(status: AiStatusResponse | undefined): string | null {
  const r = status?.remaining;
  if (!r) return null;
  return r.kind === 'trial' ? `AI searches left: ${r.left} of ${r.limit}` : `AI left today: ${r.leftToday} of ${r.limitToday}`;
}
