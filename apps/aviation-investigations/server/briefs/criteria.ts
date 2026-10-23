/**
 * The reader's criteria applied to presented cases (gate G6 #3): the readings in effect
 * (timing window, first flight only, failure type; pinned by the reader or the
 * planner's default) are server-owned. Each presented case gets one decision per
 * criterion, decided in code from the case's chronology facts and symptom, and **every
 * decision becomes a server-template claim** the evidence checker judges against all of
 * the case's supplied passages, `unknown` ones included. So a fact the composition left
 * out cannot settle anything: "under the timing rules, the supplied passages of this case
 * do not settle whether the event happened within 10 flight hours" is contradicted when a
 * passage states 5.1 hours since that maintenance. A contradicted "do not settle" claim
 * is recorded as `chronology_missed` (server/briefs/verdicts.ts) and still withholds the
 * summary: there is no repair call.
 *
 * Decisions are bound-aware: `matches`, `does_not_match` or `unknown` (shown as
 * unconfirmed: the analysis could not settle it from the supplied passages, never "the
 * investigation has no timing").
 *
 * **Timing rules, `chronology-rules-v1`** (the check prompt states the same rules, so the
 * checker judges the criterion claims by them). A chronology fact (compose.v6) is stored
 * as its anchor, relation, evidence and attribution:
 * - **A-1 anchor.** Only a fact measured from the case's relevant maintenance
 *   (`anchor: relevant_maintenance`) to the event flight can decide a criterion. A fact
 *   measured from anything else (an earlier flight, other maintenance) keeps its own
 *   antecedent and decides nothing.
 * - **A-2 attribution.** The server derives a fact's attribution from its cited
 *   passages' verified scope (never from the model). In an event with more than one
 *   aircraft, a fact not cited entirely from passages scoped to one aircraft decides
 *   nothing.
 * - **TW-N numbers.** Flight hours and calendar days are compared with the window on
 *   their own basis; days are never converted into hours. `exact` compares directly;
 *   `at_most v` can only match (v ≤ limit); `at_least v` can only fail (v > limit);
 *   `about v` decides nothing: an approximate value supplies no bound, so no tolerance is
 *   assumed. Calendar days counted from stated dates of the maintenance and the event are
 *   exact. Wording without a number (`words`: "shortly after", "a few days", "recent")
 *   decides nothing.
 * - **TW-C calendar dates.** `same_day` and `previous_day` put the calendar-date
 *   difference at 0 and 1: within any calendar-day window (every window is at least one
 *   day). They decide nothing about flight hours (one date boundary is not 24 hours).
 * - **TW-I immediately before.** Maintenance completed immediately before the flight on
 *   which the event happened is within any calendar-day window: the event is on that
 *   flight, and no flight in this corpus lasts across two calendar-date boundaries. It is
 *   never a zero-day or zero-hour value and decides nothing about flight hours.
 * - **FF-O, FF-Z, FF-I which flight.** The first flight after the maintenance
 *   (`flight_ordinal` 1), zero completed flights in between (`intervening_flights`
 *   exactly 0, or at most 0) and maintenance completed immediately before the event
 *   flight establish the first flight; a later ordinal, or at least one completed flight
 *   in between, a later flight; an approximate or upper-bounded count decides nothing.
 *   Which flight never decides a calendar-day or flight-hour window, and calendar days or
 *   flight hours never decide which flight it was.
 * - **C-1 conflicts.** Facts that put one basis both within and outside, or the flight
 *   both first and later, decide nothing for it.
 * - The window is an OR: one basis within matches; it fails only when every basis the
 *   window sets is decided outside; otherwise unknown, with a content-free reason
 *   (`UNKNOWN_REASONS`).
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
import type {
  ComposeCase,
  ComposeChronology,
  Criterion,
  FailureType,
  TimingBound,
  TimingWindow,
} from '../../shared/contracts/briefs.js';
import type { ReadingState } from './clarify.js';

/** The version of the timing rules below; the check prompt states the same rules. */
export const CHRONOLOGY_RULES_VERSION = 'chronology-rules-v1';

const FAILURE_PHRASE: Readonly<Record<FailureType, string>> = {
  total_power_loss: 'a total loss of engine power',
  partial_power_loss: 'a partial loss of engine power',
  rough_running: 'an engine running rough',
  failure_to_climb: 'an aircraft unable to climb',
};

export type Decision = 'matches' | 'does_not_match' | 'unknown';

/**
 * Why a decision stays unknown (content-free; `meta.criteria`): no fact from the relevant
 * maintenance (`unstated`), facts only from other anchors (`other_anchor`), facts not
 * attributable to one aircraft of a multi-aircraft event (`ambiguous_attribution`),
 * approximate values only (`approximate`), bounds that do not settle the limit
 * (`insufficient_bound`), facts that do not bear on this criterion (`not_settling`), or
 * conflicting facts (`conflict`).
 */
export const UNKNOWN_REASONS = [
  'unstated',
  'other_anchor',
  'ambiguous_attribution',
  'approximate',
  'insufficient_bound',
  'not_settling',
  'conflict',
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** The rules that decided a criterion (content-free; `meta.criteria`). */
export const CHRONOLOGY_RULES = ['TW-N', 'TW-C', 'TW-I', 'FF-O', 'FF-Z', 'FF-I'] as const;
export type ChronologyRule = (typeof CHRONOLOGY_RULES)[number];

type Chronology = ComposeChronology;
type Fact = Chronology['facts'][number];
type Limit = 'within' | 'outside' | 'unknown';

/** One stated amount against its limit. */
export function againstLimit(a: { value: number; bound: TimingBound }, limit: number): Limit {
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

/** What the server knows about a presented case's supplied passages, for attribution (rule A-2). */
export interface CaseEvidence {
  /** Every supplied passage of the case, in bundle order. */
  passageIds: readonly string[];
  /** The verified scope of each supplied passage. */
  scopes: ReadonlyMap<string, { scope: 'aircraft' | 'event'; aircraftKey: number | null }>;
  /** The event involved more than one aircraft. */
  multiAircraft: boolean;
}

export type FactAttribution = { scope: 'aircraft'; aircraftKey: number } | { scope: 'event'; multiAircraft: boolean };

/** A fact's attribution, from its cited passages' verified scope (never from the model). */
export function factAttribution(f: Pick<Fact, 'passageIds'>, ev: CaseEvidence): FactAttribution {
  const scopes = f.passageIds.map((id) => ev.scopes.get(id));
  const first = scopes[0];
  if (first && first.scope === 'aircraft' && first.aircraftKey !== null && scopes.every((s) => s?.scope === 'aircraft' && s.aircraftKey === first.aircraftKey)) {
    return { scope: 'aircraft', aircraftKey: first.aircraftKey };
  }
  return { scope: 'event', multiAircraft: ev.multiAircraft };
}

/** Facts that may decide a criterion (rules A-1 and A-2), or why there are none. */
export function decidingFacts(c: Chronology | undefined, ev: CaseEvidence): { facts: Fact[]; reason?: UnknownReason } {
  const relevant = (c?.facts ?? []).filter((f) => f.anchor === 'relevant_maintenance');
  if (relevant.length === 0) return { facts: [], reason: (c?.facts.length ?? 0) > 0 ? 'other_anchor' : 'unstated' };
  const attributable = relevant.filter((f) => {
    const a = factAttribution(f, ev);
    return a.scope === 'aircraft' || !a.multiAircraft;
  });
  return attributable.length === 0 ? { facts: [], reason: 'ambiguous_attribution' } : { facts: attributable };
}

/** A decision with the passages it rests on (the deciding facts' passages, or none), the rules used and, when unknown, why. */
export interface Decided {
  decision: Decision;
  passageIds: string[];
  rules: ChronologyRule[];
  reason?: UnknownReason;
}

interface BasisState {
  state: Limit;
  passageIds: string[];
  rule: ChronologyRule;
  bound?: TimingBound;
}

const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

/** One basis from its facts (rule C-1: within and outside together decide nothing). */
function settle(states: readonly BasisState[]): { state: Limit | 'conflict'; passageIds: string[]; rules: ChronologyRule[] } {
  const within = states.filter((s) => s.state === 'within');
  const outside = states.filter((s) => s.state === 'outside');
  if (within.length > 0 && outside.length > 0) return { state: 'conflict', passageIds: [], rules: [] };
  const deciding = within.length > 0 ? within : outside;
  if (deciding.length === 0) return { state: 'unknown', passageIds: [], rules: [] };
  return { state: within.length > 0 ? 'within' : 'outside', passageIds: unique(deciding.flatMap((s) => s.passageIds)), rules: unique(deciding.map((s) => s.rule)) };
}

/** Why a set of undecided facts leaves a criterion unknown. */
function undecidedReason(states: readonly BasisState[], conflict: boolean): UnknownReason {
  if (conflict) return 'conflict';
  if (states.some((s) => s.bound === 'about')) return 'approximate';
  if (states.some((s) => s.bound === 'at_most' || s.bound === 'at_least')) return 'insufficient_bound';
  return 'not_settling';
}

/** The timing window ("within D calendar days or H flight hours") under rules TW-N, TW-C, TW-I. */
export function timingDecision(window: TimingWindow, c: Chronology | undefined, ev: CaseEvidence): Decided {
  const { facts, reason } = decidingFacts(c, ev);
  if (facts.length === 0) return { decision: 'unknown', passageIds: [], rules: [], reason: reason ?? 'unstated' };
  const days: BasisState[] = [];
  const hours: BasisState[] = [];
  for (const f of facts) {
    const ids = [...f.passageIds];
    const numbered = f.value !== undefined && f.bound !== undefined ? { value: f.value, bound: f.bound } : null;
    switch (f.relation) {
      case 'calendar_days':
        if (window.days !== null && numbered) days.push({ state: againstLimit(numbered, window.days), passageIds: ids, rule: 'TW-N', bound: numbered.bound });
        break;
      case 'flight_hours':
        if (window.flightHours !== null && numbered) hours.push({ state: againstLimit(numbered, window.flightHours), passageIds: ids, rule: 'TW-N', bound: numbered.bound });
        break;
      case 'same_day':
      case 'previous_day':
        // A calendar-date difference of 0 or 1: within every window of at least one day.
        if (window.days !== null) days.push({ state: 'within', passageIds: ids, rule: 'TW-C' });
        break;
      case 'immediately_before':
        if (window.days !== null) days.push({ state: 'within', passageIds: ids, rule: 'TW-I' });
        break;
      default:
        // Which flight, flights in between and other words decide no window.
        break;
    }
  }
  const bases = [...(window.days !== null ? [settle(days)] : []), ...(window.flightHours !== null ? [settle(hours)] : [])];
  const within = bases.filter((b) => b.state === 'within');
  if (within.length > 0) return { decision: 'matches', passageIds: unique(within.flatMap((b) => b.passageIds)), rules: unique(within.flatMap((b) => b.rules)) };
  if (bases.length > 0 && bases.every((b) => b.state === 'outside')) {
    return { decision: 'does_not_match', passageIds: unique(bases.flatMap((b) => b.passageIds)), rules: unique(bases.flatMap((b) => b.rules)) };
  }
  return { decision: 'unknown', passageIds: [], rules: [], reason: undecidedReason([...days, ...hours], bases.some((b) => b.state === 'conflict')) };
}

/** First flight only, under rules FF-O, FF-Z, FF-I. */
export function firstFlightDecision(c: Chronology | undefined, ev: CaseEvidence): Decided {
  const { facts, reason } = decidingFacts(c, ev);
  if (facts.length === 0) return { decision: 'unknown', passageIds: [], rules: [], reason: reason ?? 'unstated' };
  const first: BasisState[] = [];
  const later: BasisState[] = [];
  const undecided: BasisState[] = [];
  for (const f of facts) {
    const ids = [...f.passageIds];
    if (f.relation === 'flight_ordinal' && f.value !== undefined) {
      (f.value === 1 ? first : later).push({ state: 'within', passageIds: ids, rule: 'FF-O' });
    } else if (f.relation === 'intervening_flights' && f.value !== undefined && f.bound !== undefined) {
      if (f.value === 0 && (f.bound === 'exact' || f.bound === 'at_most')) first.push({ state: 'within', passageIds: ids, rule: 'FF-Z' });
      else if (f.value >= 1 && (f.bound === 'exact' || f.bound === 'at_least')) later.push({ state: 'within', passageIds: ids, rule: 'FF-Z' });
      else undecided.push({ state: 'unknown', passageIds: ids, rule: 'FF-Z', bound: f.bound });
    } else if (f.relation === 'immediately_before') {
      first.push({ state: 'within', passageIds: ids, rule: 'FF-I' });
    }
  }
  if (first.length > 0 && later.length > 0) return { decision: 'unknown', passageIds: [], rules: [], reason: 'conflict' };
  const deciding = first.length > 0 ? first : later;
  if (deciding.length > 0) {
    return {
      decision: first.length > 0 ? 'matches' : 'does_not_match',
      passageIds: unique(deciding.flatMap((s) => s.passageIds)),
      rules: unique(deciding.map((s) => s.rule)),
    };
  }
  return { decision: 'unknown', passageIds: [], rules: [], reason: undecidedReason(undecided, false) };
}

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
  /** An unknown decision's claim says the supplied passages do not settle it: an absence claim over all of them. */
  absence: boolean;
  /** The timing rules that decided it (empty for an unknown decision and for the failure type). */
  rules: ChronologyRule[];
  /** Why an unknown decision stays unknown. */
  reason?: UnknownReason;
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

/** "the relevant maintenance (the annual inspection)": the anchor every criterion claim names. */
export function maintenanceWords(c: Pick<Chronology, 'maintenance'> | undefined): string {
  return c ? `the relevant maintenance (${c.maintenance})` : 'the relevant maintenance';
}

/** The server-template claim of each decision; `m` is `maintenanceWords`. */
export const CRITERION_CLAIMS = {
  timing_window: {
    matches: (w: TimingWindow, m: string) => `Under the timing rules, the event happened within ${windowWords(w)} after ${m}.`,
    does_not_match: (w: TimingWindow, m: string) => `Under the timing rules, the event did not happen within ${windowWords(w)} after ${m}.`,
    unknown: (w: TimingWindow, m: string) =>
      `Under the timing rules, the supplied passages of this case do not settle whether the event happened within ${windowWords(w)} after ${m}.`,
  },
  first_flight_only: {
    matches: (m: string) => `Under the timing rules, the event happened on the first flight after ${m}.`,
    does_not_match: (m: string) => `Under the timing rules, the event happened on a later flight, not on the first flight after ${m}.`,
    unknown: (m: string) => `Under the timing rules, the supplied passages of this case do not settle whether the event happened on the first flight after ${m}.`,
  },
  failure_type: {
    matches: (f: FailureType) => `This event involved ${FAILURE_PHRASE[f]}.`,
    does_not_match: (f: FailureType) => `This event did not involve ${FAILURE_PHRASE[f]}.`,
  },
} as const;

/** The criteria decisions for one presented case, each with its checker claim. */
export function evaluateCase(r: ReadingState, k: ComposeCase, mechanicalCause: boolean, ev: CaseEvidence): CriterionCheck[] {
  const all = [...ev.passageIds];
  const out: CriterionCheck[] = [];
  const m = maintenanceWords(k.chronology);
  const timed = (criterion: 'timing_window' | 'first_flight_only', d: Decided, claim: string): CriterionCheck => {
    const unknown = d.decision === 'unknown' || d.passageIds.length === 0;
    return {
      criterion,
      decision: d.decision,
      claim,
      passageIds: unknown ? all : d.passageIds,
      absence: d.decision === 'unknown',
      rules: d.rules,
      ...(d.reason ? { reason: d.reason } : {}),
    };
  };
  if (r.timingWindow) {
    const w = r.timingWindow.value;
    const d = timingDecision(w, k.chronology, ev);
    out.push(timed('timing_window', d, CRITERION_CLAIMS.timing_window[d.decision](w, m)));
  }
  if (r.firstFlightOnly?.value) {
    const d = firstFlightDecision(k.chronology, ev);
    out.push(timed('first_flight_only', d, CRITERION_CLAIMS.first_flight_only[d.decision](m)));
  }
  if (r.failureType) {
    const f = r.failureType.value;
    const symptom = mechanicalCause ? k.symptom : undefined;
    if (!symptom) {
      // Semantic: the checker must confirm it on all of the case's passages, or the summary is withheld.
      out.push({ criterion: 'failure_type', decision: 'matches', claim: CRITERION_CLAIMS.failure_type.matches(f), passageIds: all, absence: false, rules: [] });
    } else {
      const decision = symptom.value === f ? 'matches' : 'does_not_match';
      const ids = symptom.passageIds.length > 0 ? [...symptom.passageIds] : all;
      out.push({ criterion: 'failure_type', decision, claim: CRITERION_CLAIMS.failure_type[decision](f), passageIds: ids, absence: false, rules: [] });
    }
  }
  return out;
}
