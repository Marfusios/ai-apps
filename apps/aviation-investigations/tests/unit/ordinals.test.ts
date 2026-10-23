import { describe, expect, it } from 'vitest';
import type { ChronologyFact } from '../../shared/contracts/briefs.js';
import { conflictingFacts, firstFlightDecision, timingDecision, type CaseEvidence } from '../../server/briefs/criteria.js';
import { ORDINAL_EVIDENCE_VERSION, interveningEvidence, ordinalEvidence, textOrdinals, textOrdinalsVerified } from '../../server/briefs/ordinals.js';

/** The gate's control (16d verdict, finding 2): a narrated sequence with an unreported interval between the second and the accident flight. */
const NARRATED =
  'The first flight after the installation of the new engine systems lasted about 5 minutes. The second flight lasted about 10 minutes. The accident flight was conducted 2 days later, and lasted about 30 minutes.';

const fact = (relation: ChronologyFact['relation'], over: Partial<ChronologyFact> & { passageIds: string[] }): ChronologyFact => ({ anchor: 'relevant_maintenance', relation, ...over });

/** A single-aircraft case whose passages have the given texts (by id). */
const evidence = (texts: Record<string, string>, multi?: { scopes: Record<string, { scope: 'aircraft' | 'event'; aircraftKey: number | null }> }): CaseEvidence => ({
  passageIds: Object.keys(texts),
  scopes: new Map(Object.keys(texts).map((id) => [id, multi?.scopes[id] ?? { scope: 'aircraft' as const, aircraftKey: 1 }])),
  multiAircraft: multi !== undefined,
  texts: new Map(Object.entries(texts)),
});

describe('ordinal-evidence-v2', () => {
  it('reads flight ordinals in prose', () => {
    expect(ORDINAL_EVIDENCE_VERSION).toBe('ordinal-evidence-v2');
    expect(textOrdinals('In the Vans case, the engine quit on the third flight after the installation (WPR18LA021).')).toEqual([3]);
    expect(textOrdinals("The accident flight was the airplane's first flight after the annual inspection.")).toEqual([1]);
    expect(textOrdinals('It was its 2nd test flight and then its next flight.')).toEqual([2, 'next']);
    expect(textOrdinals('The engine lost power during the initial climb.')).toEqual([]);
    // The noun left out after "flight was the".
    expect(textOrdinals('The accident flight was the first following the 100-hour inspection.')).toEqual([1]);
    expect(textOrdinals('It was the first time the engine was run after the repair.')).toEqual([]);
  });

  it('a "whether" clause asks and is left out; a negated ordinal is stated and stays', () => {
    expect(textOrdinals('The supplied passages call the flight a postmaintenance test flight but do not say whether it was the first flight after the elevator trim actuator was replaced.')).toEqual([]);
    expect(textOrdinals('The passages do not say whether it was the first flight after the repair; it was the third flight after the overhaul.')).toEqual([3]);
    expect(textOrdinals('The supplied passages do not put the failure on the first flight after the work: a 0.2-hour maintenance flight check came first.')).toEqual([1]);
  });

  it('16d held-out ERA12LA469: "the first following" is explicit evidence for the first flight', () => {
    expect(ordinalEvidence(['The accident flight was the first following a 100-hour maintenance inspection.'], 1)).toBe(true);
    expect(ordinalEvidence(['The accident flight was the first following a 100-hour maintenance inspection.'], 2)).toBe(false);
    expect(ordinalEvidence(['The accident flight was the first of the day.'], 1)).toBe(true);
    expect(ordinalEvidence(['The accident flight was the first in a series of test flights.'], 1)).toBe(false);
  });

  it('the gate\'s control: a narrated sequence with an unreported interval does not establish the third flight', () => {
    expect(ordinalEvidence([NARRATED], 3)).toBe(false);
    expect(textOrdinalsVerified('A total power loss occurred on the third flight, two days after new engine systems were installed.', [NARRATED])).toBe(false);
    // The first and second flights are stated explicitly.
    expect(ordinalEvidence([NARRATED], 1)).toBe(true);
    expect(ordinalEvidence([NARRATED], 2)).toBe(true);
  });

  it('explicit evidence: the ordinal for a flight, or an explicitly complete count', () => {
    expect(ordinalEvidence(['The accident flight was the third flight since the overhaul.'], 3)).toBe(true);
    expect(ordinalEvidence(['It was the 3rd post-maintenance flight.'], 3)).toBe(true);
    expect(ordinalEvidence(['The airplane had not flown since the annual inspection.'], 1)).toBe(true);
    expect(ordinalEvidence(['No flights were made between the repair and the accident flight.'], 1)).toBe(true);
    expect(ordinalEvidence(['The mechanic completed the inspection immediately before the accident flight.'], 1)).toBe(true);
    expect(ordinalEvidence(['Two flights were flown since the inspection.'], 3)).toBe(true);
    expect(ordinalEvidence(['The airplane had flown several times since the inspection.'], 3)).toBe(false);
    expect(ordinalEvidence(['The next flight was the accident flight.'], 'next')).toBe(true);
    expect(interveningEvidence(['No other flights were made since the overhaul.'], 0)).toBe(true);
    expect(interveningEvidence(['Two flights were made since the overhaul.'], 2)).toBe(true);
    expect(interveningEvidence([NARRATED], 2)).toBe(false);
  });

  it('v2: a count or "had not flown" is evidence only with what it counts from beside it', () => {
    // 16e held-out ERA23LA144: inactivity before the work is not a count of flights after it.
    const inactive = 'The pilot purchased an airplane that had not flown in 22 years and that had an extensive annual inspection completed the day before the accident flight.';
    expect(ordinalEvidence([inactive], 1)).toBe(false);
    expect(ordinalEvidence(['The airplane had not flown since the annual inspection.'], 1)).toBe(true);
    expect(ordinalEvidence(["The airplane hadn't been flown after the repair."], 1)).toBe(true);
    // "The previous two flights" or "all three flights" count no flights from the maintenance.
    const previous = 'The pilot stated that there were no anomalies during the previous two flights, and the mechanic stated that the engine had issues after the annual inspection.';
    expect(ordinalEvidence([previous], 3)).toBe(false);
    expect(interveningEvidence(['For all three flights, on takeoff, the current rose rapidly after the inspection.'], 3)).toBe(false);
    expect(interveningEvidence(['The previous owner flew two flights after fueling.'], 2)).toBe(true);
  });
});

describe('chronology-rules-v3', () => {
  const NARRATIVE = { P1: NARRATED };

  it('O-1: a flight ordinal without explicit evidence decides nothing, and says why', () => {
    const third = { maintenance: 'the installation', facts: [fact('flight_ordinal', { value: 3, passageIds: ['P1'] })] };
    expect(firstFlightDecision(third, evidence(NARRATIVE))).toMatchObject({ decision: 'unknown', reason: 'ordinal_unverified' });
    // With the ordinal stated, it decides: a later flight.
    expect(firstFlightDecision(third, evidence({ P1: 'The accident flight was the third flight after the installation.' }))).toMatchObject({ decision: 'does_not_match', rules: ['FF-O'] });
    // An unverified ordinal still conflicts with a verified one.
    const both = { maintenance: 'the installation', facts: [fact('flight_ordinal', { value: 1, passageIds: ['P1'] }), fact('flight_ordinal', { value: 3, passageIds: ['P1'] })] };
    expect(firstFlightDecision(both, evidence(NARRATIVE))).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // Days are unaffected (which flight never decides a window).
    const days = { maintenance: 'the installation', facts: [fact('flight_ordinal', { value: 3, passageIds: ['P1'] }), fact('calendar_days', { value: 3, bound: 'exact', passageIds: ['P1'] })] };
    expect(timingDecision({ days: 30, flightHours: null }, days, evidence(NARRATIVE))).toMatchObject({ decision: 'matches' });
  });

  it('16d review m1: an event-level fact takes part in the conflict test in a two-aircraft event', () => {
    const scopes = { A1: { scope: 'aircraft' as const, aircraftKey: 1 }, E1: { scope: 'event' as const, aircraftKey: null } };
    const ev = evidence({ A1: 'The airplane was inspected 2 days before the accident.', E1: 'The event followed maintenance about 40 days earlier.' }, { scopes });
    const c = { maintenance: 'the inspection', facts: [fact('calendar_days', { value: 2, bound: 'exact', passageIds: ['A1'] }), fact('calendar_days', { value: 40, bound: 'exact', passageIds: ['E1'] })] };
    // v2 decided "within 30 days" from the aircraft's 2 days, dropping the event's 40 days before the conflict test.
    expect(timingDecision({ days: 30, flightHours: null }, c, ev)).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // The same facts in a single-aircraft event: the same conflict.
    expect(timingDecision({ days: 30, flightHours: null }, c, evidence({ A1: 'a', E1: 'b' }))).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // Without the event's conflicting fact, the aircraft's fact decides; an event fact alone still decides nothing.
    expect(timingDecision({ days: 30, flightHours: null }, { ...c, facts: [c.facts[0]!] }, ev)).toMatchObject({ decision: 'matches' });
    expect(timingDecision({ days: 30, flightHours: null }, { ...c, facts: [c.facts[1]!] }, ev)).toMatchObject({ decision: 'unknown', reason: 'ambiguous_attribution' });
    // The conflicting facts are grouped for the display (shown together or not at all).
    expect(conflictingFacts(c, ev)).toEqual([[0, 1]]);
  });
});
