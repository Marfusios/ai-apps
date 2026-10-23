import { describe, expect, it } from 'vitest';
import { FAILURE_TYPE_LABELS, SYMPTOMS, type ChronologyAmount, type ComposeCase, type ComposeOutput } from '../../shared/contracts/briefs.js';
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
import { againstLimit, criteriaLines, evaluateCase, firstFlightDecision, timingDecision } from '../../server/briefs/criteria.js';
import {
  checkInput,
  chronologyFacts,
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

  it('timing chips are server labels, one per stated fact, with the value exactly as checked', () => {
    const facts = chronologyFacts({
      flightHours: { value: 20, bound: 'exact', passageIds: ['p1'] },
      calendarDays: { value: 40, bound: 'about', passageIds: ['p2'] },
      flight: { value: 'later', passageIds: ['p1'] },
      qualitative: { passageIds: ['p3'] },
    });
    expect(facts.map(timingChip)).toEqual([
      { basis: 'flight_hours', value: 20, bound: 'exact', label: '20 FH' },
      { basis: 'calendar_days', value: 40, bound: 'about', label: '≈ 40 DAYS' },
      { basis: 'subsequent_flight', value: null, bound: 'exact', label: 'LATER FLIGHT' },
      { basis: 'qualitative', value: null, bound: 'exact', label: 'NOT QUANTIFIED' },
    ]);
    expect(facts.map((f) => [f.claim, f.passageIds])).toEqual([
      ['The event happened 20 flight hours after the relevant maintenance.', ['p1']],
      ['The event happened about 40 calendar days after the relevant maintenance.', ['p2']],
      ['The event happened on a later flight after the relevant maintenance, not the first.', ['p1']],
      ['The passages describe the time between the relevant maintenance and the event in words, without a number.', ['p3']],
    ]);
    const chip = (c: Parameters<typeof chronologyFacts>[0]) => chronologyFacts(c).map(timingChip)[0]!;
    expect(chip({ calendarDays: { value: 17, bound: 'at_most', passageIds: ['p'] } }).label).toBe('≤ 17 DAYS');
    expect(chip({ calendarDays: { value: 1, bound: 'about', passageIds: ['p'] } }).label).toBe('≈ 1 DAY');
    expect(chip({ flight: { value: 'first', passageIds: ['p'] } })).toEqual({ basis: 'first_flight', value: null, bound: 'exact', label: '1ST FLIGHT' });
    expect(chronologyFacts(undefined)).toEqual([]);
    // One canonical representation: what is shown is what was checked (no rounding).
    expect(timingValueText(12.5)).toBe('12.5');
    expect(timingLine(chip({ flightHours: { value: 12.5, bound: 'about', passageIds: ['p'] } }))).toBe('About 12.5 flight hours after the maintenance');
  });

  it('the checker gets every claim with its own passages, and every passage of each case it is about', () => {
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
      chronology: { calendarDays: { value: 1, bound: 'exact', passageIds: ['p2'] }, flight: { value: 'first', passageIds: ['p2'] } },
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
      criteria: criteriaLines(readings),
      criterionChecks: new Map([['DFW08TA066', evaluateCase(readings, k, false, ['p1', 'p2', 'p3'])]]),
    };
    const { input, claims } = checkInput(composition, [citation], cases, { ...opts, mechanicalCause: true });
    expect(claims.map((c) => c.kind)).toEqual([
      'summary', 'summary', 'why', 'classification', 'maintenance', 'timing', 'timing', 'criterion', 'criterion', 'criterion', 'attribution', 'gap',
    ]);
    const all = (kind: string) => input.claims.filter((_, i) => claims[i]!.kind === kind);
    const byKind = (kind: string) => all(kind)[0]!;
    // Every passage of the case, the probable cause included, even though only p1 was quoted.
    expect(input.passages.map((p) => [p.passageId, p.section, p.aircraft])).toEqual([
      ['p1', 'Analysis', 'Hughes OH-6'],
      ['p2', 'Analysis', 'Hughes OH-6'],
      ['p3', 'Probable cause', 'Hughes OH-6'],
    ]);
    expect(input.criteria).toEqual(opts.criteria);
    expect(input.claims[0]).toEqual({ kind: 'summary', ntsbNo: 'DFW08TA066', text: 'A nut came loose (DFW08TA066).', passageIds: ['p1', 'p2', 'p3'] });
    // Insufficiency and absence are judged on all of the case's passages, never only the quoted one.
    expect(byKind('classification')).toMatchObject({ passageIds: ['p1', 'p2', 'p3'] });
    expect(byKind('classification').text).toContain('This is about the supplied passages, not an NTSB finding.');
    expect(byKind('maintenance')).toMatchObject({ text: 'None of the supplied passages of this case mentions maintenance relevant to the event.', passageIds: ['p1', 'p2', 'p3'] });
    // Each chronology fact is its own claim with its own passages.
    expect(all('timing').map((c) => [c.text, c.passageIds])).toEqual([
      ['The event happened 1 calendar day after the relevant maintenance.', ['p2']],
      ['The event happened on the first flight after the relevant maintenance.', ['p2']],
    ]);
    // Every criterion decision is a claim: unknown and semantic ones on every passage of the case.
    expect(all('criterion').map((c) => [c.text, c.passageIds])).toEqual([
      ['The passages do not establish whether the event happened within 1 flight hour after the relevant maintenance.', ['p1', 'p2', 'p3']],
      ['The event happened on the first flight after the relevant maintenance.', ['p2']],
      ['This event involved a total loss of engine power.', ['p1', 'p2', 'p3']],
    ]);
    expect(byKind('attribution').text).toContain('“A nut was loose.”');
    expect(byKind('gap')).toMatchObject({ passageIds: ['p2'] });

    // More claims than the checker takes: the check is inconclusive, never partial.
    const many = { ...composition, summary: Array.from({ length: 120 }, () => 'A note [[case:DFW08TA066]].').join(' ') };
    expect(checkInput(many, [citation], cases, opts).overflow).toBe(true);
    expect(checkInput(composition, [citation], cases, opts).overflow).toBe(false);

    // The case context keeps each criterion's checked passage set apart from timing and symptom support.
    const dims = storedDimensions(composition, true, opts.criterionChecks)[0]!;
    expect(dims.timing).toEqual([
      { basis: 'calendar_days', passageIds: ['p2'] },
      { basis: 'first_flight', passageIds: ['p2'] },
    ]);
    expect(dims.criteria).toEqual([
      { criterion: 'timing_window', decision: 'unconfirmed', passageIds: ['p1', 'p2', 'p3'] },
      { criterion: 'first_flight_only', decision: 'matches', passageIds: ['p2'] },
      { criterion: 'failure_type', decision: 'matches', passageIds: ['p1', 'p2', 'p3'] },
    ]);
  });
});

describe('the reader’s criteria (server-owned, decided in code, every decision checked)', () => {
  const amount = (value: number, bound: ChronologyAmount['bound'], passageIds = ['p']): ChronologyAmount => ({ value, bound, passageIds });
  const hours = (value: number, bound: ChronologyAmount['bound']) => ({ flightHours: amount(value, bound) });
  const days = (value: number, bound: ChronologyAmount['bound']) => ({ calendarDays: amount(value, bound) });
  const decision = (w: { days: number | null; flightHours: number | null }, c: Parameters<typeof timingDecision>[1]) => timingDecision(w, c).decision;

  it('timing windows are bound-aware and never convert days into hours', () => {
    const oneHour = { days: null, flightHours: 1 };
    expect(decision(oneHour, hours(5.1, 'exact'))).toBe('does_not_match');
    expect(decision(oneHour, hours(0.5, 'exact'))).toBe('matches');
    expect(decision(oneHour, hours(5, 'at_most'))).toBe('unknown');
    expect(decision(oneHour, hours(0.5, 'at_most'))).toBe('matches');
    expect(decision(oneHour, hours(0.5, 'at_least'))).toBe('unknown');
    expect(decision(oneHour, hours(2, 'at_least'))).toBe('does_not_match');
    expect(decision(oneHour, days(0, 'exact'))).toBe('unknown');
    expect(decision(oneHour, { flight: { value: 'first', passageIds: ['p'] } })).toBe('unknown');
    expect(decision(oneHour, undefined)).toBe('unknown');
    // An OR window: outside on hours, but days are not stated.
    const shortly = { days: 30, flightHours: 10 };
    expect(decision(shortly, hours(12, 'exact'))).toBe('unknown');
    expect(decision(shortly, hours(5.1, 'exact'))).toBe('matches');
    // Within on either basis matches, with the deciding fact's passages.
    expect(timingDecision(shortly, { flightHours: amount(20, 'exact', ['ph']), calendarDays: amount(3, 'exact', ['pd']) })).toEqual({ decision: 'matches', passageIds: ['pd'] });
  });

  it('G6 regression (c): 40 days and 20 flight hours are both stated, so 30 days OR 10 hours does not match', () => {
    const both = { calendarDays: amount(40, 'exact', ['pd']), flightHours: amount(20, 'exact', ['ph']) };
    expect(timingDecision({ days: 30, flightHours: 10 }, both)).toEqual({ decision: 'does_not_match', passageIds: ['pd', 'ph'] });
  });

  it('G6 #2: an approximate value supplies no bound, so it never decides eligibility (no assumed tolerance)', () => {
    // "About eight hours" against a nine-hour window: unknown, not a match.
    expect(decision({ days: null, flightHours: 9 }, hours(8, 'about'))).toBe('unknown');
    expect(decision({ days: null, flightHours: 1 }, hours(1, 'about'))).toBe('unknown');
    expect(decision({ days: 30, flightHours: null }, days(60, 'about'))).toBe('unknown');
    expect(againstLimit({ value: 0.1, bound: 'about' }, 500)).toBe('unknown');
    // A stated limit is usable: "less than ten hours" under a ten-hour window.
    expect(decision({ days: null, flightHours: 10 }, hours(10, 'at_most'))).toBe('matches');
    // The case is shown unconfirmed: never "Within your timing window".
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [], chronology: hours(8, 'about') } as unknown as ComposeCase;
    const [check] = evaluateCase({ timingWindow: { value: { days: null, flightHours: 9 }, pinned: true } }, k, true, ['p', 'q']);
    expect(check).toMatchObject({ decision: 'unknown', passageIds: ['p', 'q'] });
    const lines = readingLines(
      { glyph: null, why: 'w', timing: chronologyFacts(k.chronology).map(timingChip), quotes: [], evidence: { scope: 'event', multiAircraft: false }, criteria: [{ criterion: 'timing_window', decision: 'unconfirmed' }] },
      { ntsbNo: 'DFW08TA066', evidencePassageIds: [], timing: [{ basis: 'flight_hours', passageIds: ['p'] }], criteria: [{ criterion: 'timing_window', decision: 'unconfirmed', passageIds: ['p', 'q'] }] },
    );
    expect(lines).toEqual([
      { label: 'TIMING', text: 'About 8 flight hours after the maintenance', passageIds: ['p'] },
      { label: 'CRITERIA', text: 'Unconfirmed: the passages do not establish your timing window', passageIds: ['p', 'q'] },
    ]);
    expect(Object.values(CRITERION_LINE).every((l) => l.unconfirmed.startsWith('Unconfirmed:') && !l.unconfirmed.includes('Within'))).toBe(true);
  });

  it('G6 regression (b): a stated later flight fails first-flight-only, whatever the hours say', () => {
    const second = { flightHours: amount(1.2, 'exact', ['ph']), flight: { value: 'later' as const, passageIds: ['pf'] } };
    expect(firstFlightDecision(second)).toEqual({ decision: 'does_not_match', passageIds: ['pf'] });
    expect(firstFlightDecision({ flight: { value: 'first', passageIds: ['pf'] } })).toEqual({ decision: 'matches', passageIds: ['pf'] });
    // Hours alone do not say which flight it was: unknown, and that claim goes to the checker.
    expect(firstFlightDecision(hours(0.2, 'exact')).decision).toBe('unknown');
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [], chronology: hours(1.2, 'exact') } as unknown as ComposeCase;
    expect(evaluateCase({ firstFlightOnly: { value: true, pinned: true } }, k, true, ['p1', 'p2'])).toEqual([
      {
        criterion: 'first_flight_only',
        decision: 'unknown',
        claim: 'The passages do not establish whether the event happened on the first flight after the relevant maintenance.',
        passageIds: ['p1', 'p2'],
      },
    ]);
  });

  it('G6 regression (a): an omitted fact settles nothing; the unknown decision is a claim on every passage', () => {
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [] } as unknown as ComposeCase;
    const pinned = { timingWindow: { value: { days: null, flightHours: 1 }, pinned: true } };
    expect(evaluateCase(pinned, k, true, ['p1', 'p2', 'p3'])).toEqual([
      {
        criterion: 'timing_window',
        decision: 'unknown',
        claim: 'The passages do not establish whether the event happened within 1 flight hour after the relevant maintenance.',
        passageIds: ['p1', 'p2', 'p3'],
      },
    ]);
  });

  it('a case is judged on every reading in effect; semantic criteria go to the checker', () => {
    const k = { ntsbNo: 'DFW08TA066', why: 'w', quotes: [], evidencePassageIds: [], chronology: hours(5.1, 'exact') } as unknown as ComposeCase;
    const pinned = { timingWindow: { value: { days: null, flightHours: 1 }, pinned: true } };
    expect(evaluateCase(pinned, k, true, ['p', 'q'])).toEqual([
      { criterion: 'timing_window', decision: 'does_not_match', claim: 'The event did not happen within 1 flight hour after the relevant maintenance.', passageIds: ['p'] },
    ]);
    const failure = { failureType: { value: 'total_power_loss' as const, pinned: false } };
    // No structured symptom: semantic, confirmed by the checker on all of the case's passages.
    expect(evaluateCase(failure, k, true, ['p', 'q'])).toEqual([
      { criterion: 'failure_type', decision: 'matches', claim: 'This event involved a total loss of engine power.', passageIds: ['p', 'q'] },
    ]);
    expect(evaluateCase(failure, { ...k, symptom: { value: 'total_power_loss', passageIds: ['ps'] } }, true, ['p', 'q'])).toEqual([
      { criterion: 'failure_type', decision: 'matches', claim: 'This event involved a total loss of engine power.', passageIds: ['ps'] },
    ]);
    expect(evaluateCase(failure, { ...k, symptom: { value: 'partial_power_loss', passageIds: ['ps'] } }, true, ['p', 'q']).map((c) => c.decision)).toEqual([
      'does_not_match',
    ]);
    expect(criteriaLines({ ...pinned, firstFlightOnly: { value: true, pinned: true }, ...failure })).toEqual([
      'Timing: the event happened within 1 flight hour after the relevant maintenance.',
      'First flight: the event happened on the first flight after the relevant maintenance.',
      'Failure: the event involved a total loss of engine power.',
    ]);
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
