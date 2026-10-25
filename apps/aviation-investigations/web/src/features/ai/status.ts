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

/**
 * What a click can do for an AI evidence search's one free undo (contract `evidence.v3`), which
 * uses none of the visitor's own searches: it runs while those are used up (a trial's: signed-in
 * only with `trial_used`; an account's day or month: paused with `daily_cap` or `monthly_cap`),
 * with the usual Turnstile check, saying "free". Every other state is as for any AI request: a
 * pause for everyone, the anonymous share, the login-required mode or an unreadable status still
 * stop it (the server's gate and admission, server/quota/admit.ts).
 */
export function undoAvailability(status: AiStatusResponse | undefined, unreadable = false): AskAvailability {
  const r = status?.remaining;
  if (status?.state === 'signed_in_only' && status.reason === 'trial_used' && r?.kind === 'trial') {
    return { kind: 'available', counter: 'free', anonymous: true, firstCheck: !r.started, check: true };
  }
  if (status?.state === 'paused' && (status.reason === 'daily_cap' || status.reason === 'monthly_cap') && r?.kind === 'account') {
    return { kind: 'available', counter: 'free', anonymous: false, firstCheck: false, check: r.check === true };
  }
  return askAvailability(status, unreadable);
}

/**
 * What the counter and Ask AI say when only signed-in AI is open and sign-in is not
 * offered here (Google sign-in not configured): never "sign in" (Task 22 review W-10;
 * Builder copy, for the owner's review). With the login-required mode nobody can ask, so
 * it reads like any pause with no time promised.
 */
export function signedInOnlyNote(reason: Extract<AiStatusResponse, { state: 'signed_in_only' }>['reason']): string {
  if (reason === 'trial_used') return 'Free AI searches used';
  if (reason === 'anonymous_share') return 'Free AI searches paused for today';
  return 'AI temporarily unavailable';
}

/**
 * Whether this site offers AI searches (the About page, Task 23): available, open to signed-in
 * visitors only, or paused by a budget or an account's cap, which end by themselves. Paused for
 * maintenance (the kill switch) or a missing dependency (AI not configured, a provider or the
 * check unavailable) reads as off.
 */
export function aiFeatureOn(status: AiStatusResponse): boolean {
  if (status.state !== 'paused') return true;
  return status.reason !== 'maintenance' && status.reason !== 'dependency';
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
