/**
 * The reader's criteria applied to presented cases (gate G6 #3): the readings in effect
 * (timing window, first flight only, failure type; pinned by the reader or the
 * planner's default) are server-owned. Each presented case gets one decision per
 * criterion, decided in code from the case's chronology facts and symptom, and **every
 * decision becomes a server-template claim** the evidence checker judges against all of
 * the case's supplied passages, `unconfirmed` ones included. So a fact the composition
 * left out cannot settle anything: "the passages do not establish whether the event
 * happened within 10 flight hours" fails the check when a passage states 5.1 hours. The
 * compose prompt asks for the same, but nothing relies on it.
 *
 * Decisions are bound-aware: `matches`, `does_not_match` or `unknown` (shown as
 * unconfirmed).
 * - **Timing window** ("within D calendar days or H flight hours"): each stated fact is
 *   compared with the limit on its own basis; days are never converted into hours.
 *   `exact` values compare directly; `at_most v` can only match (v ≤ limit) or stay
 *   unknown; `at_least v` can only fail (v > limit) or stay unknown; `about v` stays
 *   unknown: an approximate value supplies no bound (gate G6 #2), so no tolerance is
 *   assumed. The window is an OR: one basis within matches; it fails only when every
 *   basis the window sets is decided outside; otherwise unknown. Which flight and
 *   wording without a number decide nothing here.
 * - **First flight only**: a stated first flight matches, a stated later flight fails,
 *   anything else is unknown.
 * - **Failure type**: a structured symptom matches when equal and fails when it is
 *   another value; without one (or for a question that is not about a mechanical cause)
 *   the criterion is semantic: a `matches` claim the checker must confirm.
 *
 * A presented case that fails a criterion withholds the summary (the composition should
 * have abstained or noted the case as a gap). Unknown decisions are shown labelled
 * unconfirmed, never as a match.
 */
import type { ChronologyAmount, ComposeCase, Criterion, FailureType, TimingWindow } from '../../shared/contracts/briefs.js';
import type { ReadingState } from './clarify.js';

const FAILURE_PHRASE: Readonly<Record<FailureType, string>> = {
  total_power_loss: 'a total loss of engine power',
  partial_power_loss: 'a partial loss of engine power',
  rough_running: 'an engine running rough',
  failure_to_climb: 'an aircraft unable to climb',
};

export type Decision = 'matches' | 'does_not_match' | 'unknown';

type Chronology = NonNullable<ComposeCase['chronology']>;
type Limit = 'within' | 'outside' | 'unknown';

/** One stated amount against its limit. */
export function againstLimit(a: Pick<ChronologyAmount, 'value' | 'bound'>, limit: number): Limit {
  switch (a.bound) {
    case 'exact':
      return a.value <= limit ? 'within' : 'outside';
    case 'at_most':
      return a.value <= limit ? 'within' : 'unknown';
    case 'at_least':
      return a.value > limit ? 'outside' : 'unknown';
    case 'about':
      // No bound is stated: no tolerance is assumed for eligibility.
      return 'unknown';
  }
}

/** A decision with the passages it rests on: the deciding facts' passages, or none (unknown). */
interface Decided {
  decision: Decision;
  passageIds: string[];
}

export function timingDecision(window: TimingWindow, c: Chronology | undefined): Decided {
  const bases: { state: Limit; passageIds: string[] }[] = [];
  const on = (limit: number | null, fact: ChronologyAmount | undefined) => {
    if (limit === null) return;
    bases.push(fact ? { state: againstLimit(fact, limit), passageIds: [...fact.passageIds] } : { state: 'unknown', passageIds: [] });
  };
  on(window.days, c?.calendarDays);
  on(window.flightHours, c?.flightHours);
  const within = bases.filter((b) => b.state === 'within');
  if (within.length > 0) return { decision: 'matches', passageIds: unique(within.flatMap((b) => b.passageIds)) };
  if (bases.length > 0 && bases.every((b) => b.state === 'outside')) {
    return { decision: 'does_not_match', passageIds: unique(bases.flatMap((b) => b.passageIds)) };
  }
  return { decision: 'unknown', passageIds: [] };
}

export function firstFlightDecision(c: Chronology | undefined): Decided {
  if (!c?.flight) return { decision: 'unknown', passageIds: [] };
  return { decision: c.flight.value === 'first' ? 'matches' : 'does_not_match', passageIds: [...c.flight.passageIds] };
}

const unique = (ids: readonly string[]) => [...new Set(ids)];

/** One criterion's decision for one case, with its checker claim and the passages that claim cites. */
export interface CriterionCheck {
  criterion: Criterion;
  decision: Decision;
  /** A server template stating the decision about the case. */
  claim: string;
  /**
   * The passages the claim cites, and the line in the case context links: the deciding
   * facts' passages, or every supplied passage of the case for an unknown or semantic
   * decision (a statement about the whole case).
   */
  passageIds: string[];
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

/** The server-template claim of each decision. */
export const CRITERION_CLAIMS = {
  timing_window: {
    matches: (w: TimingWindow) => `The event happened within ${windowWords(w)} after the relevant maintenance.`,
    does_not_match: (w: TimingWindow) => `The event did not happen within ${windowWords(w)} after the relevant maintenance.`,
    unknown: (w: TimingWindow) =>
      `The passages do not establish whether the event happened within ${windowWords(w)} after the relevant maintenance.`,
  },
  first_flight_only: {
    matches: 'The event happened on the first flight after the relevant maintenance.',
    does_not_match: 'The event happened on a later flight, not on the first flight after the relevant maintenance.',
    unknown: 'The passages do not establish whether the event happened on the first flight after the relevant maintenance.',
  },
  failure_type: {
    matches: (f: FailureType) => `This event involved ${FAILURE_PHRASE[f]}.`,
    does_not_match: (f: FailureType) => `This event did not involve ${FAILURE_PHRASE[f]}.`,
  },
} as const;

/**
 * The criteria decisions for one presented case, each with its checker claim.
 * `casePassageIds`: every supplied passage of the case.
 */
export function evaluateCase(r: ReadingState, k: ComposeCase, mechanicalCause: boolean, casePassageIds: readonly string[]): CriterionCheck[] {
  const all = [...casePassageIds];
  const out: CriterionCheck[] = [];
  const cited = (d: Decided) => (d.decision === 'unknown' || d.passageIds.length === 0 ? all : d.passageIds);
  if (r.timingWindow) {
    const w = r.timingWindow.value;
    const d = timingDecision(w, k.chronology);
    out.push({ criterion: 'timing_window', decision: d.decision, claim: CRITERION_CLAIMS.timing_window[d.decision](w), passageIds: cited(d) });
  }
  if (r.firstFlightOnly?.value) {
    const d = firstFlightDecision(k.chronology);
    out.push({ criterion: 'first_flight_only', decision: d.decision, claim: CRITERION_CLAIMS.first_flight_only[d.decision], passageIds: cited(d) });
  }
  if (r.failureType) {
    const f = r.failureType.value;
    const symptom = mechanicalCause ? k.symptom : undefined;
    if (!symptom) {
      // Semantic: the checker must confirm it on all of the case's passages, or the summary is withheld.
      out.push({ criterion: 'failure_type', decision: 'matches', claim: CRITERION_CLAIMS.failure_type.matches(f), passageIds: all });
    } else {
      const decision = symptom.value === f ? 'matches' : 'does_not_match';
      out.push({ criterion: 'failure_type', decision, claim: CRITERION_CLAIMS.failure_type[decision](f), passageIds: cited({ decision, passageIds: [...symptom.passageIds] }) });
    }
  }
  return out;
}
