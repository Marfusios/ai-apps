/**
 * The reader's criteria applied to presented cases (gate G6 #3): the readings in effect
 * (timing window, first flight only, failure type; pinned by the reader or the
 * planner's default) are server-owned, so they are enforced in code where the case's
 * values are structured, and sent to the evidence checker as server-template claims
 * where they are semantic. The compose prompt asks for the same, but nothing relies on it.
 *
 * Decisions are bound-aware: `matches`, `does_not_match` or `unknown`.
 * - **Timing window** ("within D calendar days or H flight hours"): the case's checked
 *   timing value on one basis is compared with the limit on that basis; days are never
 *   converted into hours. `exact` values compare directly; `at_most v` can only match
 *   (v ≤ limit) or stay unknown; `at_least v` can only fail (v > limit) or stay unknown;
 *   `about v` matches when v + 10% ≤ limit and fails when v − 10% > limit. The window is
 *   an OR: one matching basis matches; it fails only when every basis the window sets
 *   is decided outside; otherwise unknown. First or later flight, qualitative timing and
 *   no timing are unknown.
 * - **First flight only**: `first_flight` matches, `subsequent_flight` fails, anything
 *   else is unknown.
 * - **Failure type**: the case's symptom matches when equal and fails when it is another
 *   value; without a symptom the checker judges a criterion claim, which must hold.
 *
 * A presented case that fails a criterion withholds the summary (the composition should
 * have abstained or noted the case as a gap). Unknown decisions are shown as not
 * established, never as a match.
 */
import type { ComposeCase, CriterionDecision, TimingWindow } from '../../shared/contracts/briefs.js';
import type { ReadingState } from './clarify.js';

const FAILURE_PHRASE = {
  total_power_loss: 'a total loss of engine power',
  partial_power_loss: 'a partial loss of engine power',
  rough_running: 'an engine running rough',
  failure_to_climb: 'an aircraft unable to climb',
} as const;

export type Decision = 'matches' | 'does_not_match' | 'unknown';

type Timing = NonNullable<ComposeCase['timing']>;

/** One basis against its limit. */
function againstLimit(value: number, bound: Timing['bound'], limit: number): 'within' | 'outside' | 'unknown' {
  switch (bound) {
    case 'exact':
      return value <= limit ? 'within' : 'outside';
    case 'about':
      return value * 1.1 <= limit ? 'within' : value * 0.9 > limit ? 'outside' : 'unknown';
    case 'at_most':
      return value <= limit ? 'within' : 'unknown';
    case 'at_least':
      return value > limit ? 'outside' : 'unknown';
  }
}

export function timingDecision(window: TimingWindow, t: Timing | undefined): Decision {
  const states: ('within' | 'outside' | 'unknown')[] = [];
  const on = (limit: number | null, basis: Timing['basis']) => {
    if (limit === null) return;
    if (!t || t.basis !== basis || t.value === undefined) states.push('unknown');
    else states.push(againstLimit(t.value, t.bound, limit));
  };
  on(window.days, 'calendar_days');
  on(window.flightHours, 'flight_hours');
  if (states.includes('within')) return 'matches';
  if (states.length > 0 && states.every((s) => s === 'outside')) return 'does_not_match';
  return 'unknown';
}

export function firstFlightDecision(t: Timing | undefined): Decision {
  if (t?.basis === 'first_flight') return 'matches';
  if (t?.basis === 'subsequent_flight') return 'does_not_match';
  return 'unknown';
}

export interface CaseCriteria {
  /** One decision per criterion in effect; `does_not_match` means the case must not be presented. */
  decisions: { criterion: CriterionDecision['criterion']; decision: Decision }[];
  /** Semantic criteria the checker must confirm (server templates). */
  claims: string[];
}

/** The criteria in effect for a brief, as the checker's `<criteria>` lines. */
export function criteriaLines(r: ReadingState): string[] {
  return [
    ...(r.timingWindow ? [`Timing: the event happened within ${windowWords(r.timingWindow.value)} after the relevant maintenance.`] : []),
    ...(r.firstFlightOnly?.value ? ['First flight: the event happened on the first flight after the relevant maintenance.'] : []),
    ...(r.failureType ? [`Failure: the event involved ${FAILURE_PHRASE[r.failureType.value]}.`] : []),
  ];
}

function windowWords(w: TimingWindow): string {
  const parts = [
    ...(w.days !== null ? [`${w.days} calendar ${w.days === 1 ? 'day' : 'days'}`] : []),
    ...(w.flightHours !== null ? [`${w.flightHours} flight ${w.flightHours === 1 ? 'hour' : 'hours'}`] : []),
  ];
  return parts.join(' or ');
}

/** The criteria decisions for one presented case. */
export function evaluateCase(r: ReadingState, k: ComposeCase, mechanicalCause: boolean): CaseCriteria {
  const decisions: CaseCriteria['decisions'] = [];
  const claims: string[] = [];
  if (r.timingWindow) decisions.push({ criterion: 'timing_window', decision: timingDecision(r.timingWindow.value, k.timing) });
  if (r.firstFlightOnly?.value) decisions.push({ criterion: 'first_flight_only', decision: firstFlightDecision(k.timing) });
  if (r.failureType) {
    const symptom = mechanicalCause ? k.symptom?.value : undefined;
    if (symptom === undefined) {
      // Semantic: the checker must confirm it on the case's passages, or the summary is withheld.
      decisions.push({ criterion: 'failure_type', decision: 'matches' });
      claims.push(`This event involved ${FAILURE_PHRASE[r.failureType.value]}.`);
    } else {
      decisions.push({ criterion: 'failure_type', decision: symptom === r.failureType.value ? 'matches' : 'does_not_match' });
    }
  }
  return { decisions, claims };
}
