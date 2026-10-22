import { describe, expect, it } from 'vitest';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
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
import { checkInput, summarySegments, summarySentences, timingChip, type VerifiedCase } from '../../server/briefs/render.js';
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
  it('summary segments carry case numbers as server-owned citations', () => {
    expect(summarySegments('A nut came loose [[case:DFW08TA066]]. The cause [[case:DEN08LA103]] was not found.')).toEqual([
      { kind: 'text', text: 'A nut came loose ' },
      { kind: 'case', ntsbNo: 'DFW08TA066' },
      { kind: 'text', text: '. The cause ' },
      { kind: 'case', ntsbNo: 'DEN08LA103' },
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

  it('timing chips are server labels', () => {
    expect(timingChip({ basis: 'flight_hours', value: 5.1, bound: 'exact' }).label).toBe('5.1 FH');
    expect(timingChip({ basis: 'calendar_days', value: 17, bound: 'at_most' }).label).toBe('≤ 17 DAYS');
    expect(timingChip({ basis: 'calendar_days', value: 1, bound: 'about' }).label).toBe('≈ 1 DAY');
    expect(timingChip({ basis: 'first_flight', bound: 'exact' })).toEqual({ basis: 'first_flight', value: null, bound: 'exact', label: '1ST FLIGHT' });
    expect(timingChip({ basis: 'qualitative', bound: 'about' }).label).toBe('NOT QUANTIFIED');
  });

  it('the checker gets every claim with its passages, from templates where values are structured', () => {
    const passage = (id: string): VerifiedCase['passages'][number] => ({
      passageId: id,
      role: 'retrieved',
      rank: 1,
      sectionKind: 'analysis',
      allowed: { ntsbNo: 'DFW08TA066', text: 'The pilot said the engine quit. A nut was loose.', sha: 'a'.repeat(64), sectionId: 'DFW08TA066:analysis/aircraft-1', revisionId: 'b'.repeat(64), sectionStart: 0, scope: 'aircraft', aircraftKey: 1 },
    });
    const vc = {
      ntsbNo: 'DFW08TA066',
      rank: 1,
      summary: { row: { aircraft: [{ aircraftKey: 1, make: 'Hughes', model: 'OH-6' }] }, report: {}, aircraftNumbers: [] },
      passages: [passage('p1'), passage('p2')],
    } as unknown as VerifiedCase;
    const composition: ComposeOutput = {
      summary: 'A nut came loose [[case:DFW08TA066]]. Mechanics matter.',
      groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }],
      cases: [
        {
          ntsbNo: 'DFW08TA066',
          why: 'The engine quit after maintenance.',
          quotes: [{ passageId: 'p1', quote: 'A nut was loose.', speaker: 'investigators' }],
          maintenance: 'investigator_attributed',
          symptom: 'other',
          timing: { basis: 'flight_hours', value: 5.1, bound: 'exact' },
        },
      ],
      gaps: [{ ntsbNo: 'DFW08TA066', note: 'No inspection date is given.', passageIds: ['p2'] }],
    };
    const citation: ResolvedCitation = {
      ntsbNo: 'DFW08TA066', caseIndex: 0, quoteIndex: 0, passageId: 'p1', sectionId: 'x', revisionId: 'y', sectionSha: 'z',
      text: 'A nut was loose.', passageSpan: { start: 31, end: 47 }, sectionSpan: { start: 31, end: 47 }, matches: 1, occurrence: 'first',
    };
    const { input, claims } = checkInput(composition, [citation], new Map([['DFW08TA066', vc]]), { mechanicalCause: true });
    expect(claims.map((c) => c.kind)).toEqual(['summary', 'summary', 'why', 'classification', 'maintenance', 'timing', 'attribution', 'gap']);
    expect(input.claims[0]).toEqual({ kind: 'summary', ntsbNo: 'DFW08TA066', text: 'A nut came loose (DFW08TA066).', passageIds: ['p1'] });
    expect(input.claims[3]!.text).toBe('Investigators established a mechanical fault that caused this event.');
    expect(input.claims[5]!.text).toBe('The event happened 5.1 flight hours after the relevant maintenance.');
    expect(input.claims[6]!.text).toBe('These words are the investigators’ own (examination, analysis, findings or probable cause): “A nut was loose.”');
    expect(input.passages.map((p) => [p.passageId, p.section, p.aircraft])).toEqual([
      ['p1', 'Analysis', 'Hughes OH-6'],
      ['p2', 'Analysis', 'Hughes OH-6'],
    ]);

    // More claims than the checker takes: the check is inconclusive, never partial.
    const many = { ...composition, summary: Array.from({ length: 120 }, () => 'A.').join(' ') };
    expect(checkInput(many, [citation], new Map([['DFW08TA066', vc]]), { mechanicalCause: true }).overflow).toBe(true);
    expect(checkInput(composition, [citation], new Map([['DFW08TA066', vc]]), { mechanicalCause: true }).overflow).toBe(false);
  });
});
