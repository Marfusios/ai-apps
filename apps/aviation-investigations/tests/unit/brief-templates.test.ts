import { describe, expect, it } from 'vitest';
import {
  FAILURE_TYPE_LABELS,
  SYMPTOMS,
  type ChronologyFact,
  type ComposeCase,
  type ComposeChronology,
  type ComposeOutput,
  type TimingBound,
} from '../../shared/contracts/briefs.js';
import { ScopeOutputSchema, type ScopeOutput } from '../../server/ai/provider.js';
import {
  clarificationReadings,
  clarificationTemplateLabels,
  composeInterpretations,
  interpretationChips,
  parseTimingToken,
  timingToken,
  timingWindowLabel,
  withDefaultReading,
} from '../../server/briefs/clarify.js';
import {
  canonicalFilters,
  createRequestHash,
  mergeFilters,
  questionRequest,
  refinementRequest,
  resolveIntent,
  scopeFiltersToBrief,
  scopeInput,
} from '../../server/briefs/intent.js';
import { CRITERION_LINE, readingLines, timingLine } from '../../server/briefs/context.js';
import {
  CHRONOLOGY_RULES_VERSION,
  againstLimit,
  evaluateCase,
  factAttribution,
  firstFlightDecision,
  timingDecision,
  type CaseEvidence,
} from '../../server/briefs/criteria.js';
import { projectDisplay } from '../../server/briefs/display.js';
import {
  caseEvidence,
  checkInput,
  chronologyFacts,
  displayPlan,
  storedDimensions,
  summarySegments,
  summarySentences,
  timingChip,
  timingValueText,
  type VerifiedCase,
} from '../../server/briefs/render.js';
import {
  OPERATIONAL_LINES,
  OPERATIONAL_SUGGESTIONS,
  OPERATIONAL_SUGGESTIONS_LABEL,
  OPERATIONAL_TITLE,
  OUT_OF_SCOPE_LINES,
  comparisonReply,
  operationalReply,
  outOfScopeReply,
} from '../../server/briefs/static-replies.js';
import type { ResolvedCitation } from '../../server/briefs/validate.js';

/** A chronology fact from the relevant maintenance. */
const fact = (relation: ChronologyFact['relation'], over: Partial<ChronologyFact> & { passageIds: string[] }): ChronologyFact => ({
  anchor: 'relevant_maintenance',
  relation,
  ...over,
});
const chrono = (maintenance: string, facts: ChronologyFact[]): ComposeChronology => ({ maintenance, facts });
/** A single-aircraft case whose passages are all aircraft-scoped to aircraft 1. */
const evidence = (ids: string[]): CaseEvidence => ({
  passageIds: ids,
  scopes: new Map(ids.map((id) => [id, { scope: 'aircraft' as const, aircraftKey: 1 }])),
  multiAircraft: false,
});

const scope = (over: Partial<ScopeOutput> = {}): ScopeOutput =>
  ScopeOutputSchema.parse({ intent: 'case_search', mechanicalCause: true, filters: {}, keywordText: 'power loss', ...over });

describe('static replies (UI_DESIGN §4.3, §5 copy)', () => {
  it('out of scope and operational copy is exact', () => {
    expect(OUT_OF_SCOPE_LINES).toEqual([
      'This tool only searches NTSB aviation investigations.',
      'Try a question about what happened in past accidents or incidents.',
    ]);
    expect(outOfScopeReply()).toEqual({ kind: 'out_of_scope', lines: [...OUT_OF_SCOPE_LINES], keywordSearchLabel: 'Search by keyword instead' });
    expect(OPERATIONAL_TITLE).toBe('This tool studies past investigations.');
    expect(OPERATIONAL_LINES).toEqual([
      "It can't help with a flight in progress or a maintenance decision. In flight, contact ATC. For airworthiness, use your aircraft's approved data and a certificated mechanic.",
    ]);
    expect(OPERATIONAL_SUGGESTIONS_LABEL).toBe('You can still look for past cases like yours:');
    expect(operationalReply()).toMatchObject({ suggestions: OPERATIONAL_SUGGESTIONS.map((s) => ({ label: s.label, q: s.q })) });
  });

  it('a comparison lists found and unknown numbers once, in question order', () => {
    expect(comparisonReply(['B', 'A', 'B', 'C'], new Set(['A', 'C']))).toEqual({ kind: 'case_comparison', found: ['A', 'C'], notFound: ['B'] });
  });
});

describe('clarification templates', () => {
  it('parses only the timing grammar, within range', () => {
    expect(parseTimingToken('30d_or_10h')).toEqual({ kind: 'window', window: { days: 30, flightHours: 10 } });
    expect(parseTimingToken('7d')).toEqual({ kind: 'window', window: { days: 7, flightHours: null } });
    expect(parseTimingToken('10h')).toEqual({ kind: 'window', window: { days: null, flightHours: 10 } });
    expect(parseTimingToken('first_flight')).toEqual({ kind: 'first_flight' });
    for (const bad of ['', '0d', '366d', '501h', '30d10h', '_or_10h', '30d_or_', 'thirty_days', '1d_or_1h_or_1d']) {
      expect(parseTimingToken(bad), bad).toBeNull();
    }
    expect(timingToken({ days: 30, flightHours: 10 })).toBe('30d_or_10h');
    expect(timingWindowLabel({ days: 1, flightHours: null })).toBe('Within 1 day');
    expect(timingWindowLabel({ days: null, flightHours: 1 })).toBe('Within 1 flight hour');
  });

  it('readings come from templates; unknown values are dropped; fewer than two is none', () => {
    const readings = clarificationReadings({ type: 'aircraft_category', values: ['HELI', 'AIR', 'SUB'] }, { injury: ['FATL'] });
    expect(readings).toEqual([
      { label: 'Helicopters only', refinement: { kind: 'filters', filters: { injury: ['FATL'], category: ['HELI'] } } },
      { label: 'Airplanes only', refinement: { kind: 'filters', filters: { injury: ['FATL'], category: ['AIR'] } } },
    ]);
    expect(clarificationReadings({ type: 'phase', values: ['takeoff', 'landing'] }, {}).map((r) => r.label)).toEqual([
      'Phase of flight: Takeoff',
      'Phase of flight: Landing',
    ]);
    expect(clarificationReadings({ type: 'failure_type', values: ['total_power_loss', 'explode'] }, {})).toEqual([]);
    expect(clarificationReadings({ type: 'timing_window', values: ['7d', '7d'] }, {})).toEqual([]);
    const { fixed, patterns } = clarificationTemplateLabels();
    const all = [
      ...clarificationReadings({ type: 'timing_window', values: ['30d_or_10h', '10h', 'first_flight'] }, {}),
      ...clarificationReadings({ type: 'failure_type', values: ['rough_running', 'failure_to_climb'] }, {}),
    ];
    for (const r of all) expect(fixed.includes(r.label) || patterns.some((p) => p.test(r.label)), r.label).toBe(true);
  });

  it('pinned readings win over the planner default; chips and interpretations follow', () => {
    const pinned = withDefaultReading({ timingWindow: { value: { days: 7, flightHours: null }, pinned: true } }, { type: 'timing_window', values: ['30d_or_10h'] });
    expect(pinned.timingWindow).toEqual({ value: { days: 7, flightHours: null }, pinned: true });
    const defaulted = withDefaultReading({}, { type: 'timing_window', values: ['30d_or_10h'] });
    expect(interpretationChips(defaulted)).toEqual([
      { field: 'timing_window', value: { days: 30, flightHours: 10 }, label: 'Within 30 days or 10 flight hours', pinned: false },
    ]);
    expect(composeInterpretations({ ...defaulted, firstFlightOnly: { value: true, pinned: true }, failureType: { value: 'partial_power_loss', pinned: false } })).toEqual([
      'Read vague timing words about maintenance as: within 30 calendar days or 10 flight hours after the maintenance.',
      'Only an event on the first flight after the maintenance counts.',
      'Read the failure in the question as: a partial loss of engine power.',
    ]);
    // Category and phase readings are filters, not interpretations.
    expect(withDefaultReading({}, { type: 'aircraft_category', values: ['HELI'] })).toEqual({});
  });
});

describe('search intent', () => {
  it('validates planner filters against Explore vocabularies', () => {
    expect(scopeFiltersToBrief({ category: ['HELI', 'SUBMARINE' as 'AIR'], injury: ['FATL'], yearFrom: 2015, yearTo: 2010 })).toEqual({
      injury: ['FATL'],
      category: ['HELI'],
    });
    expect(canonicalFilters({ category: ['HELI', 'AIR', 'HELI'], phase: [] })).toEqual({ category: ['AIR', 'HELI'] });
    expect(mergeFilters({ injury: ['FATL'], category: ['AIR'] }, { category: ['HELI'] })).toEqual({ injury: ['FATL'], category: ['HELI'] });
  });

  it('the question: the request filters win per facet; the planner keyword text is used', () => {
    const req = questionRequest('Power loss after maintenance', { category: ['HELI'] });
    expect(scopeInput(req)).toEqual({ question: 'Power loss after maintenance' });
    const intent = resolveIntent(req, scope({ filters: { category: ['AIR'], injury: ['FATL'] }, keywordText: 'engine power loss maintenance' }));
    expect(intent).toMatchObject({ filters: { injury: ['FATL'], category: ['HELI'] }, keywordText: 'engine power loss maintenance', intent: 'case_search' });
    expect(resolveIntent(req, scope({ keywordText: '' })).keywordText).toBe('Power loss after maintenance');
  });

  it('refinements carry the server-owned state, never an answer', () => {
    const first = questionRequest('Power loss after maintenance', undefined);
    const firstIntent = { ...resolveIntent(first, scope({ filters: { injury: ['FATL'] }, ambiguity: { type: 'timing_window', values: ['30d_or_10h'] } })), caseNumbers: ['DFW08TA066'] };
    const text = refinementRequest({ request: first, intent: firstIntent }, { kind: 'text', text: 'Only helicopters' });
    expect(scopeInput(text)).toEqual({
      question: 'Only helicopters',
      prior: {
        question: 'Power loss after maintenance',
        intent: 'case_search',
        filters: { injury: ['FATL'] },
        readings: [{ type: 'timing_window', value: '30d_or_10h', pinned: false }],
        caseNumbers: ['DFW08TA066'],
      },
    });
    expect(resolveIntent(text, scope({ filters: { category: ['HELI'] } })).filters).toEqual({ injury: ['FATL'], category: ['HELI'] });

    const reading = refinementRequest({ request: text, intent: null }, { kind: 'interpretation', field: 'timing_window', value: { days: 7, flightHours: null } });
    expect(scopeInput(reading)).toMatchObject({
      question: 'Power loss after maintenance',
      prior: { refinement: 'Only helicopters', readings: [{ type: 'timing_window', value: '7d', pinned: true }] },
    });
    // The planner cannot ask again about a pinned reading.
    expect(resolveIntent(reading, scope({ intent: 'needs_clarification', ambiguity: { type: 'timing_window', values: ['1d', '2d'] } })).intent).toBe('case_search');

    const filters = refinementRequest({ request: first, intent: firstIntent }, { kind: 'filters', filters: { state: ['TX'] } });
    expect(resolveIntent(filters, scope({ filters: { category: ['AIR'] } })).filters).toEqual({ state: ['TX'] });
  });

  it('request hashes are canonical', () => {
    expect(createRequestHash('q', { category: ['HELI', 'AIR'] })).toBe(createRequestHash('q', { category: ['AIR', 'HELI'] }));
    expect(createRequestHash('q', {})).toBe(createRequestHash('q', undefined));
    expect(createRequestHash('q', {})).not.toBe(createRequestHash('q ', {}));
  });
});

describe('rendering', () => {
  it('summary segments carry case numbers as server-owned citations, flagged when unconfirmed', () => {
    expect(summarySegments('A nut came loose [[case:DFW08TA066]]. The cause [[case:DEN08LA103]] was not found.', new Set(['DEN08LA103']))).toEqual([
      { kind: 'text', text: 'A nut came loose ' },
      { kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false },
      { kind: 'text', text: '. The cause ' },
      { kind: 'case', ntsbNo: 'DEN08LA103', unconfirmed: true },
      { kind: 'text', text: ' was not found.' },
    ]);
    expect(summarySentences('One [[case:A1B2C3]]. Two. Three [[case:D4E5F6]] [[case:G7H8I9]]! Four?')).toEqual([
      'One [[case:A1B2C3]].',
      'Two.',
      'Three [[case:D4E5F6]] [[case:G7H8I9]]!',
      'Four?',
    ]);
    expect(summarySentences('Loose nut. [[case:A1B2C3]] Next one.')).toEqual(['Loose nut. [[case:A1B2C3]]', 'Next one.']);
  });

  it('timing chips are server labels, one per stated fact from the relevant maintenance, with the value exactly as checked', () => {
    const facts = chronologyFacts(
      chrono('the overhaul', [
        fact('flight_hours', { value: 20, bound: 'exact', passageIds: ['p1'] }),
        fact('calendar_days', { value: 40, bound: 'about', passageIds: ['p2'] }),
        fact('previous_day', { passageIds: ['p2'] }),
        fact('immediately_before', { passageIds: ['p3'] }),
        fact('flight_ordinal', { value: 3, passageIds: ['p1'] }),
        fact('intervening_flights', { value: 0, bound: 'exact', passageIds: ['p1'] }),
        fact('words', { passageIds: ['p3'] }),
        // Measured from another anchor: kept in the composition, never shown or decisive.
        { ...fact('calendar_days', { value: 2, bound: 'exact', passageIds: ['p1'] }), anchor: 'other', other: 'the second test flight' },
      ]),
    );
    expect(facts.map(timingChip)).toEqual([
      { basis: 'flight_hours', value: 20, bound: 'exact', label: '20 FH' },
      { basis: 'calendar_days', value: 40, bound: 'about', label: '≈ 40 DAYS' },
      { basis: 'previous_day', value: null, bound: 'exact', label: 'PREVIOUS DAY' },
      { basis: 'immediately_before', value: null, bound: 'exact', label: 'IMMEDIATELY BEFORE' },
      { basis: 'subsequent_flight', value: 3, bound: 'exact', label: '3RD FLIGHT' },
      { basis: 'flights_between', value: 0, bound: 'exact', label: '0 FLIGHTS BETWEEN' },
      { basis: 'qualitative', value: null, bound: 'exact', label: 'IN WORDS' },
    ]);
    expect(facts.map((f) => [f.claim, f.passageIds])).toEqual([
      ['The event happened 20 flight hours after the relevant maintenance (the overhaul).', ['p1']],
      ['The event happened about 40 calendar days after the relevant maintenance (the overhaul).', ['p2']],
      ['The relevant maintenance (the overhaul) was done on the calendar day before the event.', ['p2']],
      ['The relevant maintenance (the overhaul) was completed immediately before the flight on which the event happened.', ['p3']],
      ['The event happened on the third flight after the relevant maintenance (the overhaul).', ['p1']],
      ['No completed flight came between the relevant maintenance (the overhaul) and the flight on which the event happened.', ['p1']],
      ['A supplied passage describes the time between the relevant maintenance (the overhaul) and the event in words, without a number.', ['p3']],
    ]);
    const chip = (f: ChronologyFact) => chronologyFacts(chrono('m', [f])).map(timingChip)[0]!;
    expect(chip(fact('calendar_days', { value: 17, bound: 'at_most', passageIds: ['p'] })).label).toBe('≤ 17 DAYS');
    expect(chip(fact('calendar_days', { value: 1, bound: 'about', passageIds: ['p'] })).label).toBe('≈ 1 DAY');
    expect(chip(fact('same_day', { passageIds: ['p'] })).label).toBe('SAME DAY');
    expect(chip(fact('flight_ordinal', { value: 1, passageIds: ['p'] }))).toEqual({ basis: 'first_flight', value: 1, bound: 'exact', label: '1ST FLIGHT' });
    expect(chip(fact('flight_ordinal', { value: 12, passageIds: ['p'] })).label).toBe('12TH FLIGHT');
    expect(chip(fact('intervening_flights', { value: 2, bound: 'at_least', passageIds: ['p'] })).label).toBe('≥ 2 FLIGHTS BETWEEN');
    expect(chronologyFacts(undefined)).toEqual([]);
    // Every label fits its schema bound.
    for (const f of facts) expect(timingChip(f).label.length).toBeLessThanOrEqual(24);
    // One canonical representation: what is shown is what was checked (no rounding).
    expect(timingValueText(12.5)).toBe('12.5');
    expect(timingLine(chip(fact('flight_hours', { value: 12.5, bound: 'about', passageIds: ['p'] })), 'the overhaul')).toBe(
      'About 12.5 flight hours after the maintenance (the overhaul)',
    );
    expect(timingLine(chip(fact('previous_day', { passageIds: ['p'] })))).toBe('On the calendar day after the maintenance');
    expect(timingLine(chip(fact('flight_ordinal', { value: 3, passageIds: ['p'] })), 'the installation')).toBe('On the third flight after the maintenance (the installation)');
  });

  it('the checker gets every claim under a server-issued id, with its own passages and every passage of each case it is about', () => {
    const passage = (id: string, text: string, kind: 'analysis' | 'probable_cause' = 'analysis'): VerifiedCase['passages'][number] => ({
      passageId: id,
      role: kind === 'analysis' ? 'retrieved' : 'probable_cause',
      reserved: true,
      rank: kind === 'analysis' ? 1 : null,
      sectionKind: kind,
      allowed: {
        ntsbNo: 'DFW08TA066',
        text,
        sha: 'a'.repeat(64),
        sectionId: `DFW08TA066:${kind}/aircraft-1`,
        revisionId: 'b'.repeat(64),
        sectionKind: kind,
        sectionStart: 0,
        scope: 'aircraft',
        aircraftKey: 1,
      },
    });
    const vc = {
      ntsbNo: 'DFW08TA066',
      rank: 1,
      summary: { row: { aircraft: [{ aircraftKey: 1, make: 'Hughes', model: 'OH-6' }] }, report: {}, aircraftNumbers: [] },
      header: 'Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas · 2008-02-08',
      checkHeader: 'Hughes OH-6, near Valentine, Texas · 2008-02-08',
      passages: [
        passage('p1', 'The pilot said the engine quit. A nut was loose.'),
        passage('p2', 'The engine was changed the day before.'),
        passage('p3', "The contract mechanic's failure to secure the nut.", 'probable_cause'),
      ],
    } as unknown as VerifiedCase;
    const other = { ...vc, ntsbNo: 'DEN08LA103', passages: [{ ...passage('p9', 'Unrelated.'), allowed: { ...passage('p9', 'Unrelated.').allowed, ntsbNo: 'DEN08LA103' } }] } as VerifiedCase;
    const k: ComposeCase = {
      ntsbNo: 'DFW08TA066',
      why: 'The engine quit after maintenance.',
      quotes: [{ passageId: 'p1', quote: 'A nut was loose.', speaker: 'investigators' }],
      evidencePassageIds: [],
      maintenance: { relation: 'no_evidence', passageIds: [] },
      symptom: { value: 'other', passageIds: ['p1'] },
      chronology: chrono('the engine change', [fact('previous_day', { passageIds: ['p2'] }), fact('flight_ordinal', { value: 1, passageIds: ['p2'] })]),
    };
    const composition: ComposeOutput = {
      outcome: 'answer',
      summary: 'A nut came loose [[case:DFW08TA066]]. Mechanics matter here [[case:DFW08TA066]].',
      groups: [{ kind: 'insufficient', caseNumbers: ['DFW08TA066'] }],
      cases: [k],
      gaps: [{ ntsbNo: 'DFW08TA066', note: 'The supplied passages give no inspection date.', passageIds: ['p2'] }],
    };
    const citation: ResolvedCitation = {
      ntsbNo: 'DFW08TA066', caseIndex: 0, quoteIndex: 0, passageId: 'p1', sectionId: 'x', revisionId: 'y', sectionSha: 'z',
      text: 'A nut was loose.', passageSpan: { start: 31, end: 47 }, sectionSpan: { start: 31, end: 47 }, matches: 1, occurrence: 'first',
    };
    const cases = new Map([['DFW08TA066', vc], ['DEN08LA103', other]]);
    const readings = {
      timingWindow: { value: { days: null, flightHours: 1 }, pinned: true },
      firstFlightOnly: { value: true, pinned: true },
      failureType: { value: 'total_power_loss' as const, pinned: false },
    };
    const opts = {
      mechanicalCause: false,
      criterionChecks: new Map([['DFW08TA066', evaluateCase(readings, k, false, caseEvidence(vc))]]),
    };
    const { input, claims } = checkInput(composition, [citation], cases, { ...opts, mechanicalCause: true });
    expect(claims.map((c) => c.kind)).toEqual([
      'summary', 'summary', 'why', 'classification', 'maintenance', 'timing', 'timing', 'criterion', 'criterion', 'criterion', 'attribution', 'gap',
    ]);
    // Server-issued ids, in order; the verdicts must name exactly these.
    expect(input.claims.map((c) => c.id)).toEqual(input.claims.map((_, i) => `C${i + 1}`));
    const all = (kind: string) => input.claims.filter((_, i) => claims[i]!.kind === kind);
    const byKind = (kind: string) => all(kind)[0]!;
    // Every passage of the case, the probable cause included, even though only p1 was quoted.
    expect(input.passages.map((p) => [p.passageId, p.section, p.aircraft])).toEqual([
      ['p1', 'Analysis', 'Hughes OH-6'],
      ['p2', 'Analysis', 'Hughes OH-6'],
      ['p3', 'Probable cause', 'Hughes OH-6'],
    ]);
    // The case headers are server data; the reader's criteria are not in the input (each criterion claim states its own).
    expect(input.cases).toEqual([{ ntsbNo: 'DFW08TA066', header: 'Hughes OH-6, near Valentine, Texas · 2008-02-08' }]);
    expect(input).not.toHaveProperty('criteria');
    // Each claim knows the element it stands for, under a stable key.
    expect(claims.map((c) => c.key)).toEqual([
      'summary.0',
      'summary.1',
      'case.DFW08TA066.why',
      'case.DFW08TA066.classification',
      'case.DFW08TA066.maintenance',
      'case.DFW08TA066.timing.0',
      'case.DFW08TA066.timing.1',
      'case.DFW08TA066.criterion.timing_window',
      'case.DFW08TA066.criterion.first_flight_only',
      'case.DFW08TA066.criterion.failure_type',
      'case.DFW08TA066.quote.0',
      'gap.0',
    ]);
    expect(claims.map((c) => c.ref)).toEqual([
      { kind: 'summary', sentence: 0 },
      { kind: 'summary', sentence: 1 },
      { kind: 'why', case: 0 },
      { kind: 'classification', case: 0 },
      { kind: 'maintenance', case: 0 },
      { kind: 'timing', case: 0, fact: 0, chip: 0 },
      { kind: 'timing', case: 0, fact: 1, chip: 1 },
      { kind: 'criterion', case: 0, criterion: 'timing_window' },
      { kind: 'criterion', case: 0, criterion: 'first_flight_only' },
      { kind: 'criterion', case: 0, criterion: 'failure_type' },
      { kind: 'attribution', case: 0, quote: 0, citation: 0 },
      { kind: 'gap', gap: 0 },
    ]);
    expect(input.claims[0]).toEqual({ id: 'C1', kind: 'summary', ntsbNo: 'DFW08TA066', text: 'A nut came loose (DFW08TA066).', passageIds: ['p1', 'p2', 'p3'], absence: false });
    // Absence claims cite every passage of the case: their scope is explicit.
    expect(byKind('classification')).toMatchObject({ passageIds: ['p1', 'p2', 'p3'], absence: true });
    expect(byKind('classification').text).toContain('This is about the supplied passages, not an NTSB finding.');
    expect(byKind('maintenance')).toMatchObject({
      text: 'None of the supplied passages of this case mentions maintenance relevant to the event.',
      passageIds: ['p1', 'p2', 'p3'],
      absence: true,
    });
    expect(byKind('gap')).toMatchObject({ passageIds: ['p1', 'p2', 'p3'], absence: true });
    expect(byKind('why')).toMatchObject({ passageIds: ['p1'], absence: false });
    // Each chronology fact is its own claim with its own passages, naming the maintenance.
    expect(all('timing').map((c) => [c.text, c.passageIds, c.absence])).toEqual([
      ['The relevant maintenance (the engine change) was done on the calendar day before the event.', ['p2'], false],
      ['The event happened on the first flight after the relevant maintenance (the engine change).', ['p2'], false],
    ]);
    // Every criterion decision is a claim: unknown ones are absence claims on every passage.
    expect(all('criterion').map((c) => [c.text, c.passageIds, c.absence])).toEqual([
      [
        'Under the timing rules, the supplied passages of this case do not settle whether the event happened within 1 flight hour after the relevant maintenance (the engine change).',
        ['p1', 'p2', 'p3'],
        true,
      ],
      ['Under the timing rules, the event happened on the first flight after the relevant maintenance (the engine change).', ['p2'], false],
      ['This event involved a total loss of engine power.', ['p1', 'p2', 'p3'], false],
    ]);
    expect(claims.filter((c) => c.kind === 'criterion').map((c) => [c.criterion, c.decision])).toEqual([
      ['timing_window', 'unknown'],
      ['first_flight_only', 'matches'],
      ['failure_type', 'matches'],
    ]);
    expect(claims[0]!.scope).toEqual(['p1', 'p2', 'p3']);
    expect(byKind('attribution').text).toContain('“A nut was loose.”');

    // More claims than the checker takes: the check is inconclusive, never partial.
    const many = { ...composition, summary: Array.from({ length: 120 }, () => 'A note [[case:DFW08TA066]].').join(' ') };
    expect(checkInput(many, [citation], cases, opts).overflow).toBe(true);
    expect(checkInput(composition, [citation], cases, opts).overflow).toBe(false);

    // The case context keeps each criterion's checked passage set apart from timing and symptom support.
    const all12 = { kind: 'judged' as const, judgement: { structural: [], claims: claims.map(() => ({ verdict: 'supported' as const, confirmed: true })) } };
    const shownAll = projectDisplay(displayPlan(composition, claims, true), all12, 'claims');
    const dims = storedDimensions(composition, true, opts.criterionChecks, { claims, display: shownAll })[0]!;
    expect(dims.timing).toEqual([
      { basis: 'previous_day', passageIds: ['p2'] },
      { basis: 'first_flight', passageIds: ['p2'] },
    ]);
    expect(dims.relevantMaintenance).toBe('the engine change');
    expect(dims.criteria).toEqual([
      { criterion: 'timing_window', decision: 'unconfirmed', passageIds: ['p1', 'p2', 'p3'] },
      { criterion: 'first_flight_only', decision: 'matches', passageIds: ['p2'] },
      { criterion: 'failure_type', decision: 'matches', passageIds: ['p1', 'p2', 'p3'] },
    ]);
  });
});

describe('the reader’s criteria under the timing rules (server-owned, decided in code, every decision checked)', () => {
  const single = evidence(['p', 'q', 'pd', 'ph', 'pf']);
  const window = (w: { days: number | null; flightHours: number | null }, facts: ChronologyFact[], ev = single) => timingDecision(w, chrono('the overhaul', facts), ev);
  const decision = (w: { days: number | null; flightHours: number | null }, facts: ChronologyFact[]) => window(w, facts).decision;
  const hours = (value: number, bound: TimingBound, ids = ['ph']) => fact('flight_hours', { value, bound, passageIds: ids });
  const days = (value: number, bound: TimingBound, ids = ['pd']) => fact('calendar_days', { value, bound, passageIds: ids });
  const shortly = { days: 30, flightHours: 10 };

  it('TW-N: numbers are bound-aware and days are never converted into hours', () => {
    const oneHour = { days: null, flightHours: 1 };
    expect(decision(oneHour, [hours(5.1, 'exact')])).toBe('does_not_match');
    expect(decision(oneHour, [hours(0.5, 'exact')])).toBe('matches');
    expect(decision(oneHour, [hours(5, 'at_most')])).toBe('unknown');
    expect(decision(oneHour, [hours(0.5, 'at_most')])).toBe('matches');
    expect(decision(oneHour, [hours(0.5, 'at_least')])).toBe('unknown');
    expect(decision(oneHour, [hours(2, 'at_least')])).toBe('does_not_match');
    expect(decision(oneHour, [days(0, 'exact')])).toBe('unknown');
    expect(window(oneHour, [])).toEqual({ decision: 'unknown', passageIds: [], facts: [], rules: [], reason: 'unstated' });
    expect(timingDecision(oneHour, undefined, single)).toEqual({ decision: 'unknown', passageIds: [], facts: [], rules: [], reason: 'unstated' });
    // An OR window: outside on hours, but days are not stated.
    expect(window(shortly, [hours(12, 'exact')])).toEqual({ decision: 'unknown', passageIds: [], facts: [], rules: [], reason: 'not_settling' });
    expect(decision(shortly, [hours(5.1, 'exact')])).toBe('matches');
    // Within on either basis matches, with the deciding fact's passages and rule.
    expect(window(shortly, [hours(20, 'exact'), days(3, 'exact')])).toEqual({ decision: 'matches', passageIds: ['pd'], facts: [1], rules: ['TW-N'] });
  });

  it('G6 regression (c): 40 days and 20 flight hours are both stated, so 30 days OR 10 hours does not match', () => {
    expect(window(shortly, [days(40, 'exact'), hours(20, 'exact')])).toEqual({ decision: 'does_not_match', passageIds: ['pd', 'ph'], facts: [0, 1], rules: ['TW-N'] });
  });

  it('G6: an approximate value supplies no bound, so it never decides eligibility (no assumed tolerance)', () => {
    expect(window({ days: null, flightHours: 9 }, [hours(8, 'about')])).toMatchObject({ decision: 'unknown', reason: 'approximate' });
    expect(decision({ days: null, flightHours: 1 }, [hours(1, 'about')])).toBe('unknown');
    expect(decision({ days: 30, flightHours: null }, [days(60, 'about')])).toBe('unknown');
    // Even far inside the limit: "about 45 minutes" is approximate, and the summary must not present it as within.
    expect(window(shortly, [hours(0.8, 'about')])).toMatchObject({ decision: 'unknown', reason: 'approximate' });
    expect(againstLimit({ value: 0.1, bound: 'about' }, 500)).toBe('unknown');
    // A stated limit is usable: "less than ten hours" under a ten-hour window.
    expect(decision({ days: null, flightHours: 10 }, [hours(10, 'at_most')])).toBe('matches');
    expect(window({ days: null, flightHours: 10 }, [hours(40, 'at_most')])).toMatchObject({ decision: 'unknown', reason: 'insufficient_bound' });
    // The case is shown unconfirmed: never "Within your timing window", never "the investigation has no timing".
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [], chronology: chrono('the overhaul', [hours(8, 'about', ['p'])]) } as unknown as ComposeCase;
    const [check] = evaluateCase({ timingWindow: { value: { days: null, flightHours: 9 }, pinned: true } }, k, true, evidence(['p', 'q']));
    expect(check).toMatchObject({ decision: 'unknown', passageIds: ['p', 'q'], absence: true, reason: 'approximate' });
    const lines = readingLines(
      { glyph: null, why: 'w', timing: chronologyFacts(k.chronology).map(timingChip), quotes: [], evidence: { scope: 'event', multiAircraft: false }, criteria: [{ criterion: 'timing_window', decision: 'unconfirmed' }] },
      { ntsbNo: 'DFW08TA066', evidencePassageIds: [], timing: [{ basis: 'flight_hours', passageIds: ['p'] }], relevantMaintenance: 'the overhaul', criteria: [{ criterion: 'timing_window', decision: 'unconfirmed', passageIds: ['p', 'q'] }] },
    );
    expect(lines).toEqual([
      { label: 'TIMING', text: 'About 8 flight hours after the maintenance (the overhaul)', passageIds: ['p'] },
      { label: 'CRITERIA', text: 'Unconfirmed: this analysis could not establish your timing window from the supplied passages', passageIds: ['p', 'q'] },
    ]);
    for (const l of Object.values(CRITERION_LINE)) {
      expect(l.unconfirmed.startsWith('Unconfirmed: this analysis could not establish')).toBe(true);
      expect(l.unconfirmed).not.toMatch(/investigation|no timing|Within/);
    }
  });

  it('TW-I and FF-I: "immediately before the flight" is a relation, never a zero-day or zero-hour interval', () => {
    const before = fact('immediately_before', { passageIds: ['pf'] });
    // Within any calendar-day window, by rule; the first flight, by rule.
    expect(window(shortly, [before])).toEqual({ decision: 'matches', passageIds: ['pf'], facts: [0], rules: ['TW-I'] });
    expect(firstFlightDecision(chrono('the annual inspection', [before]), single)).toEqual({ decision: 'matches', passageIds: ['pf'], facts: [0], rules: ['FF-I'] });
    // Not a number of flight hours: a flight-hour window stays unknown.
    expect(window({ days: null, flightHours: 10 }, [before])).toMatchObject({ decision: 'unknown', reason: 'not_settling' });
    // Its chip and claim say what the passage says, not "0 DAYS" or "0 FH".
    expect(chronologyFacts(chrono('the annual inspection', [before])).map((f) => [timingChip(f).label, f.claim])).toEqual([
      ['IMMEDIATELY BEFORE', 'The relevant maintenance (the annual inspection) was completed immediately before the flight on which the event happened.'],
    ]);
  });

  it('TW-C: "the previous day" is one calendar-date boundary, not 24 hours', () => {
    const previous = fact('previous_day', { passageIds: ['pd'] });
    expect(window(shortly, [previous])).toEqual({ decision: 'matches', passageIds: ['pd'], facts: [0], rules: ['TW-C'] });
    expect(window({ days: 1, flightHours: null }, [previous])).toMatchObject({ decision: 'matches' });
    expect(window({ days: 1, flightHours: null }, [fact('same_day', { passageIds: ['pd'] })])).toMatchObject({ decision: 'matches', rules: ['TW-C'] });
    // Never on the flight-hour basis, and never the first flight.
    expect(window({ days: null, flightHours: 24 }, [previous])).toMatchObject({ decision: 'unknown', reason: 'not_settling' });
    expect(firstFlightDecision(chrono('m', [previous]), single)).toMatchObject({ decision: 'unknown', reason: 'not_settling' });
  });

  it('FF-O and FF-Z: which flight settles only the first flight; the first flight alone never settles a calendar-day window', () => {
    const first = fact('flight_ordinal', { value: 1, passageIds: ['pf'] });
    expect(firstFlightDecision(chrono('m', [first]), single)).toEqual({ decision: 'matches', passageIds: ['pf'], facts: [0], rules: ['FF-O'] });
    expect(window(shortly, [first])).toMatchObject({ decision: 'unknown', reason: 'not_settling' });
    expect(firstFlightDecision(chrono('m', [fact('flight_ordinal', { value: 3, passageIds: ['pf'] })]), single)).toMatchObject({ decision: 'does_not_match', rules: ['FF-O'] });
    // Zero completed flights in between is its own statement, settling the first flight by rule.
    const none = (bound: TimingBound, value = 0) => firstFlightDecision(chrono('m', [fact('intervening_flights', { value, bound, passageIds: ['pf'] })]), single);
    expect(none('exact')).toMatchObject({ decision: 'matches', rules: ['FF-Z'] });
    expect(none('at_most')).toMatchObject({ decision: 'matches', rules: ['FF-Z'] });
    expect(none('at_least', 1)).toMatchObject({ decision: 'does_not_match', rules: ['FF-Z'] });
    expect(none('exact', 2)).toMatchObject({ decision: 'does_not_match' });
    expect(none('about', 2)).toMatchObject({ decision: 'unknown', reason: 'approximate' });
    expect(none('at_most', 3)).toMatchObject({ decision: 'unknown', reason: 'insufficient_bound' });
    // Hours alone do not say which flight it was.
    expect(firstFlightDecision(chrono('m', [hours(0.2, 'exact')]), single)).toMatchObject({ decision: 'unknown', reason: 'not_settling' });
  });

  it('A-1: "two days later" keeps its antecedent; a time from another anchor decides nothing', () => {
    // WPR18LA021: the accident flight was 2 days after the second test flight, the third flight after the installation.
    const later = { ...fact('calendar_days', { value: 2, bound: 'exact', passageIds: ['pd'] }), anchor: 'other' as const, other: 'the second test flight' };
    const third = fact('flight_ordinal', { value: 3, passageIds: ['pf'] });
    expect(window(shortly, [later])).toEqual({ decision: 'unknown', passageIds: [], facts: [], rules: [], reason: 'other_anchor' });
    expect(window(shortly, [later, third])).toMatchObject({ decision: 'unknown', reason: 'not_settling' });
    expect(firstFlightDecision(chrono('the installation of the new engine systems', [later, third]), single)).toMatchObject({ decision: 'does_not_match', passageIds: ['pf'] });
    expect(chronologyFacts(chrono('the installation', [later])).length).toBe(0);
  });

  it('C-1: conflicting facts decide nothing, the gate\'s probe included (2 days and 40 days against 30 days)', () => {
    expect(window(shortly, [days(2, 'exact'), days(40, 'exact', ['pd2'])])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // chronology-rules-v2: a conflict on any quantity the window reads decides nothing (v1 let the hours decide).
    expect(window(shortly, [days(2, 'exact'), days(40, 'exact'), hours(3, 'exact')])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    const both = chrono('m', [fact('flight_ordinal', { value: 1, passageIds: ['pf'] }), fact('intervening_flights', { value: 2, bound: 'exact', passageIds: ['pf'] })]);
    expect(firstFlightDecision(both, single)).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // "Immediately before" and a third flight cannot both be true (review §6).
    expect(firstFlightDecision(chrono('m', [fact('immediately_before', { passageIds: ['pf'] }), fact('flight_ordinal', { value: 3, passageIds: ['pf'] })]), single)).toMatchObject({
      decision: 'unknown',
      reason: 'conflict',
    });
    // "The day before" and an exact 45 days conflict.
    expect(window(shortly, [fact('previous_day', { passageIds: ['pd'] }), days(45, 'exact')])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
  });

  it('C-1 before any decision: the 16c review\'s probes (I3), with the approximation policy AP-1', () => {
    // exact 20 days + about 45 days, 30-day window (v1: matches).
    expect(window({ days: 30, flightHours: null }, [days(20, 'exact'), days(45, 'about')])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // exact 20 days + at least 40 days under a 50-day window: they conflict whatever the window (v1: matches).
    expect(window({ days: 50, flightHours: null }, [days(20, 'exact'), days(40, 'at_least')])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // exact 5 FH + about 50 FH (v1: matches).
    expect(window({ days: null, flightHours: 10 }, [hours(5, 'exact'), hours(50, 'about')])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // the first flight + about 3 completed flights in between (v1: first flight).
    const firstAboutThree = chrono('m', [fact('flight_ordinal', { value: 1, passageIds: ['pf'] }), fact('intervening_flights', { value: 3, bound: 'about', passageIds: ['pf'] })]);
    expect(firstFlightDecision(firstAboutThree, single)).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // AP-1: "about N" is consistent only with facts that allow N; consistent facts still decide.
    expect(window({ days: 30, flightHours: null }, [days(42, 'about'), days(42, 'exact')])).toMatchObject({ decision: 'does_not_match' });
    expect(window({ days: 30, flightHours: null }, [days(10, 'about'), days(20, 'at_most')])).toMatchObject({ decision: 'matches', facts: [1] });
    expect(window({ days: 30, flightHours: null }, [days(25, 'about'), days(20, 'at_most')])).toMatchObject({ decision: 'unknown', reason: 'conflict' });
    // Bounds narrow together: at most 20 and at least 10 is within 30, at least 10 alone is not settled.
    expect(window({ days: 30, flightHours: null }, [days(20, 'at_most'), days(10, 'at_least')])).toMatchObject({ decision: 'matches', facts: [0, 1] });
    expect(window({ days: 30, flightHours: null }, [days(10, 'at_least')])).toMatchObject({ decision: 'unknown', reason: 'insufficient_bound' });
    // Units are compared only with themselves: days never conflict with hours.
    expect(window(shortly, [days(2, 'exact'), hours(50, 'exact')])).toMatchObject({ decision: 'matches', facts: [0] });
  });

  it('TW-H: hours a passage does not call flight hours never decide a flight-hour window, and are never called flight hours (review M4)', () => {
    const engine = fact('operating_hours', { value: 198, bound: 'about', passageIds: ['ph'] });
    expect(window({ days: null, flightHours: 500 }, [engine])).toMatchObject({ decision: 'unknown', reason: 'operating_hours' });
    expect(window({ days: null, flightHours: 500 }, [fact('operating_hours', { value: 3, bound: 'exact', passageIds: ['ph'] })])).toMatchObject({
      decision: 'unknown',
      reason: 'operating_hours',
    });
    // Never compared with flight hours either.
    expect(window({ days: null, flightHours: 10 }, [hours(5, 'exact'), fact('operating_hours', { value: 800, bound: 'exact', passageIds: ['ph'] })])).toMatchObject({ decision: 'matches' });
    const [f] = chronologyFacts(chrono('the replacement of all 6 cylinders', [engine]));
    expect(f!.claim).toBe('A supplied passage puts the event about 198 hours after the relevant maintenance (the replacement of all 6 cylinders), without calling them flight hours.');
    expect(f!.claim).not.toMatch(/flight hours after/);
    expect(timingChip(f!)).toEqual({ basis: 'operating_hours', value: 198, bound: 'about', label: '≈ 198 H' });
    expect(timingLine(timingChip(f!), 'the cylinder replacement')).toBe('About 198 hours after the maintenance (the cylinder replacement), not stated as flight hours');
  });

  it('A-2: in a multi-aircraft event, a fact not cited from passages of one aircraft decides nothing', () => {
    const multi: CaseEvidence = { ...evidence(['e1', 'a1']), multiAircraft: true, scopes: new Map([['e1', { scope: 'event', aircraftKey: null }], ['a1', { scope: 'aircraft', aircraftKey: 2 }]]) };
    const onEvent = fact('previous_day', { passageIds: ['e1'] });
    expect(window(shortly, [onEvent], multi)).toEqual({ decision: 'unknown', passageIds: [], facts: [], rules: [], reason: 'ambiguous_attribution' });
    expect(factAttribution(onEvent, multi)).toEqual({ scope: 'event', multiAircraft: true });
    expect(window(shortly, [fact('previous_day', { passageIds: ['a1'] })], multi)).toMatchObject({ decision: 'matches' });
    expect(factAttribution(fact('previous_day', { passageIds: ['a1'] }), multi)).toEqual({ scope: 'aircraft', aircraftKey: 2 });
    // In a single-aircraft event, event-level text is about that aircraft.
    expect(window(shortly, [onEvent], { ...multi, multiAircraft: false })).toMatchObject({ decision: 'matches' });
    // Review M2: facts about different aircraft are never combined, even when each is attributable.
    const two: CaseEvidence = { ...multi, scopes: new Map([['a1', { scope: 'aircraft', aircraftKey: 1 }], ['a2', { scope: 'aircraft', aircraftKey: 2 }]]) };
    expect(window(shortly, [fact('previous_day', { passageIds: ['a1'] }), days(3, 'exact', ['a2'])], two)).toMatchObject({ decision: 'unknown', reason: 'ambiguous_attribution' });
    expect(window(shortly, [fact('previous_day', { passageIds: ['a1'] }), days(1, 'exact', ['a1'])], two)).toMatchObject({ decision: 'matches' });
  });

  it('G6 regression (b): a stated later flight fails first-flight-only, whatever the hours say', () => {
    const second = [hours(1.2, 'exact'), fact('flight_ordinal', { value: 2, passageIds: ['pf'] })];
    expect(firstFlightDecision(chrono('m', second), single)).toEqual({ decision: 'does_not_match', passageIds: ['pf'], facts: [1], rules: ['FF-O'] });
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [], chronology: chrono('the overhaul', [hours(1.2, 'exact', ['p1'])]) } as unknown as ComposeCase;
    expect(evaluateCase({ firstFlightOnly: { value: true, pinned: true } }, k, true, evidence(['p1', 'p2']))).toEqual([
      {
        criterion: 'first_flight_only',
        decision: 'unknown',
        claim: 'Under the timing rules, the supplied passages of this case do not settle whether the event happened on the first flight after the relevant maintenance (the overhaul).',
        passageIds: ['p1', 'p2'],
        absence: true,
        rules: [],
        facts: [],
        reason: 'not_settling',
      },
    ]);
  });

  it('G6 regression (a): an omitted fact settles nothing; the unknown decision is an absence claim on every passage', () => {
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [] } as unknown as ComposeCase;
    const pinned = { timingWindow: { value: { days: null, flightHours: 1 }, pinned: true } };
    expect(evaluateCase(pinned, k, true, evidence(['p1', 'p2', 'p3']))).toEqual([
      {
        criterion: 'timing_window',
        decision: 'unknown',
        claim: 'Under the timing rules, the supplied passages of this case do not settle whether the event happened within 1 flight hour after the relevant maintenance.',
        passageIds: ['p1', 'p2', 'p3'],
        absence: true,
        rules: [],
        facts: [],
        reason: 'unstated',
      },
    ]);
  });

  it('a case is judged on every reading in effect; semantic criteria go to the checker', () => {
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [], chronology: chrono('the overhaul', [hours(5.1, 'exact', ['p'])]) } as unknown as ComposeCase;
    const pinned = { timingWindow: { value: { days: null, flightHours: 1 }, pinned: true } };
    expect(evaluateCase(pinned, k, true, evidence(['p', 'q']))).toEqual([
      {
        criterion: 'timing_window',
        decision: 'does_not_match',
        claim: 'Under the timing rules, the event did not happen within 1 flight hour after the relevant maintenance (the overhaul).',
        passageIds: ['p'],
        absence: false,
        rules: ['TW-N'],
        facts: [0],
      },
    ]);
    const failure = { failureType: { value: 'total_power_loss' as const, pinned: false } };
    // No structured symptom: semantic, confirmed by the checker on all of the case's passages.
    expect(evaluateCase(failure, k, true, evidence(['p', 'q']))).toEqual([
      { criterion: 'failure_type', decision: 'matches', claim: 'This event involved a total loss of engine power.', passageIds: ['p', 'q'], absence: false, rules: [], facts: [] },
    ]);
    expect(evaluateCase(failure, { ...k, symptom: { value: 'total_power_loss', passageIds: ['ps'] } }, true, evidence(['p', 'q']))).toEqual([
      { criterion: 'failure_type', decision: 'matches', claim: 'This event involved a total loss of engine power.', passageIds: ['ps'], absence: false, rules: [], facts: [] },
    ]);
    expect(evaluateCase(failure, { ...k, symptom: { value: 'partial_power_loss', passageIds: ['ps'] } }, true, evidence(['p', 'q'])).map((c) => c.decision)).toEqual([
      'does_not_match',
    ]);
    // Every criterion claim states its own criterion: the check input carries no criteria lines (Task 16d).
    const claims = evaluateCase({ ...pinned, firstFlightOnly: { value: true, pinned: true }, ...failure }, k, true, evidence(['p', 'q'])).map((c) => c.claim);
    expect(claims[0]).toContain('within 1 flight hour after the relevant maintenance (the overhaul)');
    expect(claims[1]).toContain('the first flight after the relevant maintenance (the overhaul)');
    expect(claims[2]).toContain('a total loss of engine power');
    expect(CHRONOLOGY_RULES_VERSION).toBe('chronology-rules-v2');
  });

  it('G6 #3: the semantic failure-type line links the passage set its claim was checked on', () => {
    const reading = {
      glyph: null,
      why: 'w',
      timing: [],
      quotes: [],
      evidence: { scope: 'event' as const, multiAircraft: false },
      criteria: [{ criterion: 'failure_type' as const, decision: 'matches' as const }],
    };
    // No structured symptom: the line used to fall back to the (absent) symptom passages.
    const lines = readingLines(reading, {
      ntsbNo: 'DFW08TA066',
      evidencePassageIds: [],
      criteria: [{ criterion: 'failure_type', decision: 'matches', passageIds: ['p1', 'p2', 'p3'] }],
    });
    expect(lines).toEqual([{ label: 'CRITERIA', text: 'The failure you asked about', passageIds: ['p1', 'p2', 'p3'] }]);
  });

  it('the SYMPTOM line uses the contract’s failure-type words; `other` has none', () => {
    const reading = { glyph: null, why: 'w', timing: [], quotes: [], evidence: { scope: 'event' as const, multiAircraft: false }, criteria: [] };
    for (const value of SYMPTOMS) {
      const lines = readingLines(reading, { ntsbNo: 'DFW08TA066', evidencePassageIds: [], symptom: { value, passageIds: ['ps'] } });
      expect(lines, value).toEqual(value === 'other' ? [] : [{ label: 'SYMPTOM', text: FAILURE_TYPE_LABELS[value], passageIds: ['ps'] }]);
    }
  });
});
