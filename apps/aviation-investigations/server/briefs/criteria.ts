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
 * is recorded as `chronology_missed` (server/briefs/verdicts.ts); the display projection
 * removes the case's reading and never adopts the checker's reading (server/briefs/display.ts).
 *
 * Decisions are bound-aware: `matches`, `does_not_match` or `unknown` (shown as
 * unconfirmed: the analysis could not settle it from the supplied passages, never "the
 * investigation has no timing"). A decision is made once, here, before the check; the
 * display projection only ever downgrades it (it never recomputes one after a removal).
 *
 * **Timing rules, `chronology-rules-v3`** (Task 16e; v2 was Task 16d's; the check prompt
 * states the same rules, so the checker judges the criterion claims by them). A chronology
 * fact (compose v6 and later) is stored as its anchor, relation, evidence and attribution,
 * and read as a constraint on one **quantity**: the calendar-date difference from the maintenance to the
 * event (`days`: calendar days, the same day 0, the day before 1, immediately before the
 * event flight 0 or 1), flight hours (`flight_hours`), hours a passage counts without
 * calling them flight hours (`operating_hours`), or completed flights between the
 * maintenance and the event flight (`flights`: the n-th flight is n - 1, immediately
 * before is 0, intervening flights their count). An exact value is a point, `at_most N`
 * the range up to N, `at_least N` the range from N.
 * - **A-1 anchor.** Only a fact measured from the case's relevant maintenance
 *   (`anchor: relevant_maintenance`) to the event flight can decide a criterion. A fact
 *   measured from anything else keeps its own antecedent and decides nothing, and so does a
 *   bound derived from such a time ("eleven days before the accident the pilot noticed …
 *   and had the part replaced" is a fact from that observation, not "at most 11 days after
 *   the replacement"; compose.v7 encodes it with its own anchor).
 * - **A-2 attribution.** The server derives a fact's attribution from its cited
 *   passages' verified scope (never from the model). In an event with more than one
 *   aircraft, a fact not cited entirely from passages scoped to one aircraft decides
 *   nothing, and facts about different aircraft are never compared or combined: when the
 *   attributable facts name more than one aircraft, nothing is decided (review M2). A fact
 *   about the whole event still takes part in the conflict test (v3, 16d review m1): "2
 *   days" for the aircraft and "40 days" for the event conflict, as they would in a
 *   single-aircraft event, so neither settles a 30-day window.
 * - **O-1 ordinal evidence** (v3, `ordinal-evidence-v1`, server/briefs/ordinals.ts). A
 *   `flight_ordinal` or `intervening_flights` fact decides only when the passages it cites
 *   give that ordinal for a flight ("the third flight") or an explicitly complete count
 *   ("had not flown since", "no flights between"); a narrated sequence may leave flights
 *   out. Without that evidence the fact takes part in the conflict test only, and a
 *   criterion it alone would settle stays unknown (`ordinal_unverified`).
 * - **C-1 conflicts, before any decision.** All the facts on one quantity (one anchor, one
 *   aircraft, one unit) must be able to hold together: their ranges must overlap. If they do
 *   not, the quantity is in conflict and decides nothing, whatever the window: "exact 20
 *   days" and "at least 40 days" conflict under a 50-day window as under a 30-day one
 *   (review I3; the gate's 2 days and 40 days). Units are never mixed: days are never
 *   hours, and operating hours are never flight hours.
 * - **AP-1 approximation policy.** "About N" decides nothing, and for the conflict test it
 *   counts as exactly N, with no tolerance in either direction: it is consistent only with
 *   facts whose range holds N. So "exact 20 days" and "about 45 days" conflict, and so do
 *   "the first flight" and "about 3 completed flights in between". This can only turn a
 *   decision into `unknown`.
 * - **TW-N numbers.** With the facts consistent, the non-approximate ones on a quantity
 *   narrow it to one range (exact 5, or at most 11 and at least 3): within the limit when the
 *   whole range is, outside when the whole range is beyond it, otherwise undecided
 *   (`insufficient_bound`). Calendar days counted from stated dates are exact. Wording
 *   without a number (`words`) decides nothing.
 * - **TW-C calendar dates.** `same_day` and `previous_day` are a calendar-date difference
 *   of 0 and 1: within any calendar-day window (every window is at least one day). They
 *   decide nothing about flight hours (one date boundary is not 24 hours).
 * - **TW-I immediately before.** Maintenance completed immediately before the flight on
 *   which the event happened is a calendar-date difference of 0 or 1 (no flight in this
 *   corpus lasts across two calendar-date boundaries): within any calendar-day window. It
 *   is never a zero-day or zero-hour value and decides nothing about flight hours.
 * - **TW-H operating hours** (review M4). Engine, tachometer or Hobbs time, time in
 *   service, or "hours" a passage does not call flight hours decide no flight-hour window
 *   (`operating_hours` reason when nothing else decides it).
 * - **FF-O, FF-Z, FF-I which flight.** The first flight after the maintenance
 *   (`flight_ordinal` 1), zero completed flights in between (exactly 0, or at most 0) and
 *   maintenance completed immediately before the event flight establish the first flight;
 *   a later ordinal, or at least one completed flight in between, a later flight; an
 *   approximate or upper-bounded count decides nothing. Which flight never decides a
 *   calendar-day or flight-hour window, and calendar days or flight hours never decide
 *   which flight it was.
 * - **Z-1 no zero intervals** (review M1). Validation refuses zero calendar days, flight
 *   hours or operating hours (`zero_interval`).
 * - The window is an OR: one quantity within matches; it fails only when every quantity
 *   the window sets is decided outside; a conflict on any quantity it reads decides
 *   nothing; otherwise unknown, with a content-free reason (`UNKNOWN_REASONS`).
 * - **First flight only**: a stated first flight matches, a stated later flight fails,
 *   anything else (or a conflict) is unknown.
 * - **Failure type**: a structured symptom matches when equal and fails when it is
 *   another value; without one (or for a question that is not about a mechanical cause)
 *   the criterion is semantic: a `matches` claim the checker must confirm.
 *
 * A presented case that fails a criterion withholds the summary (the composition should
 * have abstained or noted the case as a gap). Unknown decisions are shown labelled
 * unconfirmed, never as a match. Version 1 (Task 16c) compared facts only after reducing
 * each to within, outside or unknown, so an approximate or bounded fact that conflicted
 * with the deciding one went unnoticed (review I3).
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
import { factOrdinalVerified } from './ordinals.js';

/** The version of the timing rules below; the check prompt states the same rules. */
export const CHRONOLOGY_RULES_VERSION = 'chronology-rules-v3';

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
 * attributable to one aircraft of a multi-aircraft event, or naming more than one
 * (`ambiguous_attribution`), approximate values only (`approximate`), bounds that do not
 * settle the limit (`insufficient_bound`), facts that do not bear on this criterion
 * (`not_settling`), hours not stated as flight hours (`operating_hours`), facts that
 * cannot hold together (`conflict`), or a flight ordinal or count without explicit
 * evidence in its passages (`ordinal_unverified`, rule O-1).
 */
export const UNKNOWN_REASONS = [
  'unstated',
  'other_anchor',
  'ambiguous_attribution',
  'approximate',
  'insufficient_bound',
  'not_settling',
  'operating_hours',
  'conflict',
  'ordinal_unverified',
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** The rules that decided a criterion (content-free; `meta.criteria`). */
export const CHRONOLOGY_RULES = ['TW-N', 'TW-C', 'TW-I', 'FF-O', 'FF-Z', 'FF-I'] as const;
export type ChronologyRule = (typeof CHRONOLOGY_RULES)[number];

type Chronology = ComposeChronology;
type Fact = Chronology['facts'][number];

/** What the server knows about a presented case's supplied passages, for attribution (rule A-2) and ordinal evidence (rule O-1). */
export interface CaseEvidence {
  /** Every supplied passage of the case, in bundle order. */
  passageIds: readonly string[];
  /** The verified scope of each supplied passage. */
  scopes: ReadonlyMap<string, { scope: 'aircraft' | 'event'; aircraftKey: number | null }>;
  /** The event involved more than one aircraft. */
  multiAircraft: boolean;
  /** The canonical text of each supplied passage (rule O-1 reads a fact's own passages). */
  texts: ReadonlyMap<string, string>;
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

/** A relevant fact that may decide a criterion, with its index in the chronology's facts. */
export interface DecidingFact {
  index: number;
  fact: Fact;
}

/** Whether a fact meets rule O-1 (ordinal evidence in the passages it cites). */
export function ordinalVerified(f: Fact, ev: CaseEvidence): boolean {
  return factOrdinalVerified(f, f.passageIds.flatMap((id) => (ev.texts.has(id) ? [ev.texts.get(id)!] : [])));
}

/**
 * Facts that may decide a criterion (rules A-1, A-2 and O-1), with their indices in the
 * chronology, or why there are none; and the facts that may only block one (`blocking`):
 * in a multi-aircraft event the facts about the whole event (v3), and anywhere a flight
 * ordinal or count without its evidence. In a multi-aircraft event every deciding fact must
 * be attributable to the same aircraft. A blocking fact takes part in the conflict test
 * (C-1) and decides nothing.
 */
export function decidingFacts(c: Chronology | undefined, ev: CaseEvidence): { facts: DecidingFact[]; blocking: DecidingFact[]; reason?: UnknownReason } {
  const relevant = (c?.facts ?? []).flatMap((fact, index) => (fact.anchor === 'relevant_maintenance' ? [{ index, fact }] : []));
  if (relevant.length === 0) return { facts: [], blocking: [], reason: (c?.facts.length ?? 0) > 0 ? 'other_anchor' : 'unstated' };
  const verified = relevant.filter((d) => ordinalVerified(d.fact, ev));
  const unverified = relevant.filter((d) => !ordinalVerified(d.fact, ev));
  if (!ev.multiAircraft) return { facts: verified, blocking: unverified, ...(verified.length === 0 ? { reason: 'ordinal_unverified' as const } : {}) };
  const attributed = verified.map((d) => ({ d, a: factAttribution(d.fact, ev) }));
  const aircraft = attributed.flatMap(({ d, a }) => (a.scope === 'aircraft' ? [{ d, key: a.aircraftKey }] : []));
  const event = attributed.flatMap(({ d, a }) => (a.scope === 'event' ? [d] : []));
  const blocking = [...event, ...unverified];
  // Facts about different aircraft are never combined (review M2).
  if (aircraft.length === 0 || new Set(aircraft.map((x) => x.key)).size > 1) {
    return { facts: [], blocking, reason: verified.length === 0 ? 'ordinal_unverified' : 'ambiguous_attribution' };
  }
  return { facts: aircraft.map((x) => x.d), blocking };
}

/** A decision with the passages it rests on (the deciding facts' passages, or none), the facts and rules used and, when unknown, why. */
export interface Decided {
  decision: Decision;
  passageIds: string[];
  /** Indices (in the chronology's facts) of the facts the decision rests on. */
  facts: number[];
  rules: ChronologyRule[];
  reason?: UnknownReason;
}

// ---------------------------------------------------------------------------
// Facts as constraints on quantities (rules C-1, AP-1)

/** What a fact measures (one anchor, one aircraft, one unit; never compared across them). */
export type Quantity = 'days' | 'flight_hours' | 'operating_hours' | 'flights';

/** One fact's constraint on one quantity: the range it allows, and whether it is approximate (AP-1: a point for the conflict test, deciding nothing). */
export interface Constraint {
  quantity: Quantity;
  lo: number;
  hi: number;
  approximate: boolean;
  rule: ChronologyRule | null;
  fact: number;
  passageIds: readonly string[];
}

const ranged = (value: number, bound: TimingBound): { lo: number; hi: number; approximate: boolean } => {
  switch (bound) {
    case 'exact':
      return { lo: value, hi: value, approximate: false };
    case 'at_most':
      return { lo: 0, hi: value, approximate: false };
    case 'at_least':
      return { lo: value, hi: Number.POSITIVE_INFINITY, approximate: false };
    case 'about':
      return { lo: value, hi: value, approximate: true };
  }
};

/** A fact's constraints (an "immediately before" fact constrains days and flights). */
export function constraintsOf(f: Fact, index: number): Constraint[] {
  const at = (quantity: Quantity, r: { lo: number; hi: number; approximate: boolean }, rule: ChronologyRule | null): Constraint => ({
    quantity,
    ...r,
    rule,
    fact: index,
    passageIds: f.passageIds,
  });
  const point = (v: number) => ({ lo: v, hi: v, approximate: false });
  const v = f.value;
  const b = f.bound;
  switch (f.relation) {
    case 'calendar_days':
      return v !== undefined && b !== undefined ? [at('days', ranged(v, b), 'TW-N')] : [];
    case 'flight_hours':
      return v !== undefined && b !== undefined ? [at('flight_hours', ranged(v, b), 'TW-N')] : [];
    case 'operating_hours':
      return v !== undefined && b !== undefined ? [at('operating_hours', ranged(v, b), null)] : [];
    case 'same_day':
      return [at('days', point(0), 'TW-C')];
    case 'previous_day':
      return [at('days', point(1), 'TW-C')];
    case 'immediately_before':
      return [at('days', { lo: 0, hi: 1, approximate: false }, 'TW-I'), at('flights', point(0), 'FF-I')];
    case 'flight_ordinal':
      return v !== undefined && Number.isInteger(v) && v >= 1 ? [at('flights', point(v - 1), 'FF-O')] : [];
    case 'intervening_flights':
      return v !== undefined && b !== undefined ? [at('flights', ranged(v, b), 'FF-Z')] : [];
    case 'words':
      return [];
  }
}

/** One quantity's facts: in conflict (C-1), or the range the non-approximate ones narrow it to (null: none), with the facts and rules behind it. */
export interface Settled {
  conflict: boolean;
  range: { lo: number; hi: number } | null;
  approximate: boolean;
  facts: number[];
  passageIds: string[];
  rules: ChronologyRule[];
}

const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

/** Settle one quantity from its constraints: a conflict when they cannot all hold (C-1, AP-1). */
export function settleQuantity(constraints: readonly Constraint[]): Settled {
  const lo = Math.max(...constraints.map((c) => c.lo));
  const hi = Math.min(...constraints.map((c) => c.hi));
  const exact = constraints.filter((c) => !c.approximate);
  const approximate = constraints.some((c) => c.approximate);
  if (constraints.length > 0 && lo > hi) return { conflict: true, range: null, approximate, facts: [], passageIds: [], rules: [] };
  if (exact.length === 0) return { conflict: false, range: null, approximate, facts: [], passageIds: [], rules: [] };
  return {
    conflict: false,
    range: { lo: Math.max(...exact.map((c) => c.lo)), hi: Math.min(...exact.map((c) => c.hi)) },
    approximate,
    facts: unique(exact.map((c) => c.fact)),
    passageIds: unique(exact.flatMap((c) => [...c.passageIds])),
    rules: unique(exact.flatMap((c) => (c.rule ? [c.rule] : []))),
  };
}

/** The constraints of the deciding facts, by quantity. */
function quantities(facts: readonly DecidingFact[]): Map<Quantity, Constraint[]> {
  const out = new Map<Quantity, Constraint[]>();
  for (const { fact, index } of facts) for (const c of constraintsOf(fact, index)) out.set(c.quantity, [...(out.get(c.quantity) ?? []), c]);
  return out;
}

type Limit = 'within' | 'outside' | 'unknown';

const againstRange = (r: { lo: number; hi: number }, limit: number): Limit => (r.hi <= limit ? 'within' : r.lo > limit ? 'outside' : 'unknown');

/** One stated amount against its limit (rule TW-N for a single fact). */
export function againstLimit(a: { value: number; bound: TimingBound }, limit: number): Limit {
  if (a.bound === 'about') return 'unknown';
  return againstRange(ranged(a.value, a.bound), limit);
}

/** Why a criterion stays unknown when nothing conflicted and nothing decided: from the quantities it reads that stayed undecided. */
function undecided(open: readonly Settled[], extra?: UnknownReason): UnknownReason {
  if (open.some((s) => s.range !== null)) return 'insufficient_bound';
  if (open.some((s) => s.approximate)) return 'approximate';
  return extra ?? 'not_settling';
}

const NOTHING = (reason: UnknownReason): Decided => ({ decision: 'unknown', passageIds: [], facts: [], rules: [], reason });

/** The timing window ("within D calendar days or H flight hours") under rules C-1, AP-1, TW-N, TW-C, TW-I, TW-H, O-1. */
export function timingDecision(window: TimingWindow, c: Chronology | undefined, ev: CaseEvidence): Decided {
  const { facts, blocking, reason } = decidingFacts(c, ev);
  if (facts.length === 0) return NOTHING(reason ?? 'unstated');
  const q = quantities(facts);
  const all = quantities([...facts, ...blocking]);
  const read: [Quantity, number][] = [
    ...(window.days !== null ? ([['days', window.days]] as [Quantity, number][]) : []),
    ...(window.flightHours !== null ? ([['flight_hours', window.flightHours]] as [Quantity, number][]) : []),
  ];
  // Conflicts first, with the blocking facts too (C-1; v3: event-level facts, unverified ordinals).
  if (read.some(([quantity]) => settleQuantity(all.get(quantity) ?? []).conflict)) return NOTHING('conflict');
  const settled = read.map(([quantity, limit]) => ({ limit, s: settleQuantity(q.get(quantity) ?? []), present: (q.get(quantity) ?? []).length > 0 }));
  if (settled.some((x) => x.s.conflict)) return NOTHING('conflict');
  const states = settled.map((x) => ({ ...x, state: x.s.range ? againstRange(x.s.range, x.limit) : ('unknown' as Limit) }));
  const within = states.filter((x) => x.state === 'within');
  if (within.length > 0) {
    return {
      decision: 'matches',
      passageIds: unique(within.flatMap((x) => x.s.passageIds)),
      facts: unique(within.flatMap((x) => x.s.facts)),
      rules: unique(within.flatMap((x) => x.s.rules)),
    };
  }
  if (states.length > 0 && states.every((x) => x.state === 'outside')) {
    return {
      decision: 'does_not_match',
      passageIds: unique(states.flatMap((x) => x.s.passageIds)),
      facts: unique(states.flatMap((x) => x.s.facts)),
      rules: unique(states.flatMap((x) => x.s.rules)),
    };
  }
  const hoursOnlyOperating = window.flightHours !== null && (q.get('operating_hours') ?? []).length > 0 && !settled.some((x) => x.present);
  return NOTHING(undecided(states.filter((x) => x.state === 'unknown').map((x) => x.s), hoursOnlyOperating ? 'operating_hours' : undefined));
}

/** First flight only, under rules C-1, AP-1, FF-O, FF-Z, FF-I, O-1. */
export function firstFlightDecision(c: Chronology | undefined, ev: CaseEvidence): Decided {
  const { facts, blocking, reason } = decidingFacts(c, ev);
  if (facts.length === 0) return NOTHING(reason ?? 'unstated');
  const constraints = quantities(facts).get('flights') ?? [];
  const blocked = quantities(blocking).get('flights') ?? [];
  if (settleQuantity([...constraints, ...blocked]).conflict) return NOTHING('conflict');
  const s = settleQuantity(constraints);
  if (s.conflict) return NOTHING('conflict');
  if (s.range && s.range.hi === 0) return { decision: 'matches', passageIds: s.passageIds, facts: s.facts, rules: s.rules };
  if (s.range && s.range.lo >= 1) return { decision: 'does_not_match', passageIds: s.passageIds, facts: s.facts, rules: s.rules };
  // Only an ordinal or count without its evidence spoke to which flight it was (O-1).
  if (constraints.length === 0 && blocked.length > 0 && blocking.some((d) => !ordinalVerified(d.fact, ev))) return NOTHING('ordinal_unverified');
  return NOTHING(undecided([s]));
}

/**
 * The relevant facts of a case whose constraints on one quantity cannot all hold (C-1),
 * deciding and blocking facts together, as groups of fact indices (one group per quantity
 * in conflict). The display shows such facts only together (`display-deps-v2`): a lone
 * survivor of a conflict would read as settled (16d review m3).
 */
export function conflictingFacts(c: Chronology | undefined, ev: CaseEvidence): number[][] {
  const { facts, blocking } = decidingFacts(c, ev);
  const out: number[][] = [];
  for (const [, constraints] of quantities([...facts, ...blocking])) {
    if (constraints.length > 1 && settleQuantity(constraints).conflict) out.push(unique(constraints.map((x) => x.fact)));
  }
  return out;
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
  /** Indices (in the case's chronology facts) of the facts the decision rests on (diagnostic; the display reads every timing fact of the case). */
  facts: number[];
  /** Why an unknown decision stays unknown. */
  reason?: UnknownReason;
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
      facts: d.facts,
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
      out.push({ criterion: 'failure_type', decision: 'matches', claim: CRITERION_CLAIMS.failure_type.matches(f), passageIds: all, absence: false, rules: [], facts: [] });
    } else {
      const decision = symptom.value === f ? 'matches' : 'does_not_match';
      const ids = symptom.passageIds.length > 0 ? [...symptom.passageIds] : all;
      out.push({ criterion: 'failure_type', decision, claim: CRITERION_CLAIMS.failure_type[decision](f), passageIds: ids, absence: false, rules: [], facts: [] });
    }
  }
  return out;
}
