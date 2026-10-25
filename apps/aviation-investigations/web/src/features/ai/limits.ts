/**
 * The AI limits in the interface's words (Task 23). Every number comes from the API: the
 * limits `GET /api/config` reports (`aiLimits`: anonymous visitors, accounts and new accounts
 * per day, owner decision of 2026-10-24) or the visitor's own counts in `GET /api/ai/status`.
 * A line never states a number the API did not give: without one it says the same without it.
 * The sentences keep the owner-approved wording of UI_DESIGN §4.8 and §5, with the numbers
 * filled in.
 */
import type { AiStatusResponse } from '../../../../shared/contracts/ai';
import type { ConfigResponse } from '../../../../shared/contracts/config';
import { formatCount, numberWord } from '../../lib/format';

/** The limits `GET /api/config` reports (`aiLimits`); absent from a server that does not report them. */
export type AiLimits = NonNullable<ConfigResponse['aiLimits']>;

const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

/** "third", "tenth", "21st": the word up to twelfth, then the number. */
export function ordinal(n: number): string {
  if (ORDINALS[n]) return ORDINALS[n] as string;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${formatCount(n)}${suffix}`;
}

/** The trial's allowance: the configured daily limit, else the visitor's own `limit` from the status. */
function anonymousLimit(limits: AiLimits | undefined, status: AiStatusResponse | undefined): { n: number; daily: boolean } | null {
  if (limits) return { n: limits.anonymousDaily, daily: true };
  const r = status?.remaining;
  return r?.kind === 'trial' ? { n: r.limit, daily: false } : null;
}

const NEVER_NEED = 'Search, cases and comparisons never need this.';

/** "search" or "searches". */
const searches = (n: number): string => (n === 1 ? 'search' : 'searches');
/** "one day", "three days". */
const days = (n: number): string => `${numberWord(n)} ${n === 1 ? 'day' : 'days'}`;

/** The first anonymous check's panel (UI_DESIGN §5): "Up to ten free AI searches a day, subject to daily availability. …" */
export function firstCheckText(limits: AiLimits | undefined, status: AiStatusResponse | undefined): string {
  const a = anonymousLimit(limits, status);
  if (!a) return `Free AI searches are subject to daily availability. ${NEVER_NEED}`;
  return `Up to ${numberWord(a.n)} free AI ${a.n === 1 ? 'search' : 'searches'}${a.daily ? ' a day' : ''}, subject to daily availability. ${NEVER_NEED}`;
}

/** "That was your tenth free AI search today." (the trial-used box, UI_DESIGN §5). */
export function trialUsedTitle(limits: AiLimits | undefined, status: AiStatusResponse | undefined): string {
  const a = anonymousLimit(limits, status);
  if (!a || a.n < 1) return 'Your free AI searches are used up.';
  return `That was your ${ordinal(a.n)} free AI search${a.daily ? ' today' : ''}.`;
}

/** "Sign in with Google to keep asking. New accounts start with 20 AI searches a day, rising to 50 after three days." */
export function trialUsedSignIn(limits: AiLimits | undefined): string {
  if (!limits) return 'Sign in with Google to keep asking.';
  return `Sign in with Google to keep asking. New accounts start with ${limits.newAccountDaily} AI ${searches(limits.newAccountDaily)} a day, rising to ${limits.accountDaily} after ${days(limits.newAccountDays)}.`;
}

/**
 * When an anonymous visitor's free searches come back, as the status says (Task 23: the daily
 * allowance resets at `retryAt`, the next 00:00 UTC): "Free AI searches return at 00:00 UTC."
 */
export function trialReturns(status: AiStatusResponse | undefined): string | null {
  if (status?.state !== 'signed_in_only' || status.reason !== 'trial_used' || !status.retryAt) return null;
  const at = new Date(status.retryAt);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `Free AI searches return at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC.`;
}

/** The first sign-in's welcome (UI_DESIGN §4.8): "You have 20 AI searches a day for your first three days, then 50." */
export function welcomeText(limits: AiLimits | undefined, status: AiStatusResponse | undefined): string {
  if (limits) {
    return `You have ${limits.newAccountDaily} AI ${searches(limits.newAccountDaily)} a day for your first ${limits.newAccountDays === 1 ? 'day' : days(limits.newAccountDays)}, then ${limits.accountDaily}.`;
  }
  const r = status?.remaining;
  if (r?.kind === 'account') return `You have ${r.limitToday} AI ${searches(r.limitToday)} today.`;
  return 'Your account is ready.';
}
