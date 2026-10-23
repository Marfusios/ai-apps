/**
 * The coded-reference retrieval set (Track C): label rules over a synthetic corpus
 * (codes only, probable-cause citation, filters, aircraft attribution, reachability
 * under aircraft filters), assembly (classes never capped, paraphrases, splits), the
 * dataset checks, the committed dataset, and the runner's fail-closed preflight.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORPUS_QUERIES, buildCodedFromCorpus, frozenSplits } from '../../evals/retrieval/coded/build-coded.js';
import {
  AREAS,
  CAVEAT,
  CLASSES,
  CodedDatasetSchema,
  MIN_NARROW,
  MIN_PARAPHRASES,
  MIN_QUESTIONS,
  NARROW_MAX,
  REFERENCE,
  assembleCoded,
  codeStats,
  codedDatasetProblems,
  codedLabels,
  commonWordSuffix,
  deriveQuestion,
  describeCodeSet,
  familyWarnings,
  indexCorpus,
  normalizeFindingDescription,
  specProblems,
  specSha256,
  type CodedCorpus,
  type CodedDataset,
  type CodedItem,
  type CodedQuestionSpec,
  type Derivation,
} from '../../evals/retrieval/coded/coded.js';
import { codedTable, summarizeCoded, type CodedQuestionResult } from '../../evals/retrieval/coded/evaluate.js';
import { CODED_PARAPHRASES, CODED_QUESTIONS, CODE_FAMILIES } from '../../evals/retrieval/coded/questions.js';
import { classGroup, codedPreflight, parseCodedDataset } from '../../evals/retrieval/coded/run.js';
import { targetProblems, type GenerationSource, type TargetCheck } from '../../evals/retrieval/generation.js';
import { codedReference, scoreQuestion } from '../../evals/retrieval/metrics.js';
import { runOptions } from '../../evals/retrieval/run.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const committed = (): CodedDataset => CodedDatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/coded/dataset.json'), 'utf8')));

const CARB = '0303103081';
const CARB_OP = '0303103082';
const DECISION = '0204152044';

/** A synthetic cohort: case numbers are fixtures, not real NTSB cases. */
const corpus: CodedCorpus = {
  cases: [
    { ntsbNo: 'FIX10TX001', evYear: 2010, state: 'TX' },
    { ntsbNo: 'FIX12TX002', evYear: 2012, state: 'TX' },
    { ntsbNo: 'FIX15AK003', evYear: 2015, state: 'AK' },
    { ntsbNo: 'FIX15AK004', evYear: 2015, state: 'AK' },
    { ntsbNo: 'FIX18CO005', evYear: 2018, state: 'CO' },
    { ntsbNo: 'FIX20XX006', evYear: 2020, state: null },
    { ntsbNo: 'FIX21CO007', evYear: 2021, state: 'CO' },
  ],
  aircraft: [
    { ntsbNo: 'FIX10TX001', aircraftKey: 1, category: 'AIR', definingPhaseGroup: 'landing' },
    { ntsbNo: 'FIX12TX002', aircraftKey: 1, category: 'AIR', definingPhaseGroup: 'takeoff' },
    { ntsbNo: 'FIX15AK003', aircraftKey: 1, category: 'HELI', definingPhaseGroup: null },
    // A helicopter and an airplane.
    { ntsbNo: 'FIX15AK004', aircraftKey: 1, category: 'HELI', definingPhaseGroup: 'en_route' },
    { ntsbNo: 'FIX15AK004', aircraftKey: 2, category: 'AIR', definingPhaseGroup: 'approach' },
    // Two helicopters.
    { ntsbNo: 'FIX18CO005', aircraftKey: 1, category: 'HELI', definingPhaseGroup: 'en_route' },
    { ntsbNo: 'FIX18CO005', aircraftKey: 2, category: 'HELI', definingPhaseGroup: 'en_route' },
    { ntsbNo: 'FIX20XX006', aircraftKey: 1, category: null, definingPhaseGroup: 'landing' },
    { ntsbNo: 'FIX21CO007', aircraftKey: 1, category: 'AIR', definingPhaseGroup: 'landing' },
  ],
  findings: [
    // Cited in the probable cause; the " - C" suffix is never read.
    { ntsbNo: 'FIX10TX001', aircraftKey: 1, code: CARB, description: 'Environmental issues-...-Conducive to carburetor icing-Effect on equipment - C', inProbableCause: true },
    // Not cited, although its description carries a " - C" suffix.
    { ntsbNo: 'FIX12TX002', aircraftKey: 1, code: CARB_OP, description: 'Environmental issues-...-Conducive to carburetor icing-Effect on operation - C', inProbableCause: false },
    // A misleading description: the code decides.
    { ntsbNo: 'FIX15AK003', aircraftKey: 1, code: CARB, description: 'Aircraft-Aircraft systems-Fuel system-Fuel pumps-Failure', inProbableCause: true },
    { ntsbNo: 'FIX15AK003', aircraftKey: 1, code: DECISION, description: 'Personnel issues-...-Decision making/judgment-Pilot', inProbableCause: true },
    // The description says carburetor icing, the code does not.
    { ntsbNo: 'FIX15AK004', aircraftKey: 2, code: DECISION, description: 'Environmental issues-...-Conducive to carburetor icing-Effect on equipment', inProbableCause: true },
    { ntsbNo: 'FIX18CO005', aircraftKey: 1, code: DECISION, description: 'Personnel issues-...-Decision making/judgment-Pilot', inProbableCause: true },
    { ntsbNo: 'FIX18CO005', aircraftKey: 2, code: CARB, description: 'Environmental issues-...-Conducive to carburetor icing-Effect on equipment ', inProbableCause: true },
    // A blank `cm_inpc` is not a citation.
    { ntsbNo: 'FIX20XX006', aircraftKey: 1, code: CARB, description: null, inProbableCause: null },
    { ntsbNo: 'FIX21CO007', aircraftKey: 1, code: DECISION, description: 'Personnel issues-...-Decision making/judgment-Pilot - F', inProbableCause: true },
  ],
  sequence: [
    { ntsbNo: 'FIX10TX001', aircraftKey: 1, eventCode: '192', description: 'Enroute-cruise Fuel exhaustion' },
    { ntsbNo: 'FIX15AK004', aircraftKey: 1, eventCode: '250', description: 'Enroute Midair collision' },
    { ntsbNo: 'FIX15AK004', aircraftKey: 2, eventCode: '250', description: 'Approach  Midair collision ' },
    { ntsbNo: 'FIX18CO005', aircraftKey: 1, eventCode: '250', description: 'Enroute-cruise Midair collision' },
    { ntsbNo: 'FIX21CO007', aircraftKey: 1, eventCode: '192', description: 'Approach Fuel exhaustion' },
  ],
};
const index = indexCorpus(corpus);
const finding = (codes: string[], inProbableCause: boolean) => ({ kind: 'finding' as const, codes, inProbableCause });
const event = (...codes: string[]) => ({ kind: 'event' as const, codes });
const derive = (filters: CodedQuestionSpec['filters'], clauses: CodedQuestionSpec['codeSet']['clauses'], attribution: 'same-aircraft' | 'any-aircraft' = 'same-aircraft') =>
  deriveQuestion(index, { filters, codeSet: { clauses, attribution } });

describe('coded labels', () => {
  it('derive from code identifiers only, never from descriptions or their suffixes', () => {
    expect(derive({}, [finding([CARB], false)]).relevant).toEqual(['FIX10TX001', 'FIX15AK003', 'FIX18CO005', 'FIX20XX006']);
    // FIX15AK004's description reads carburetor icing under another code: not coded.
    expect(derive({}, [finding([CARB, CARB_OP], false)]).relevant).not.toContain('FIX15AK004');
    // The loader never reads cause_factor, and derivation never reads descriptions.
    for (const q of Object.values(CORPUS_QUERIES)) expect(q).not.toMatch(/cause_factor/);
    const blind = indexCorpus({ ...corpus, findings: corpus.findings.map((f) => ({ ...f, description: 'unrelated text - F' })) });
    expect(deriveQuestion(blind, { filters: {}, codeSet: { clauses: [finding([CARB], true)], attribution: 'same-aircraft' } }).relevant).toEqual(
      derive({}, [finding([CARB], true)]).relevant,
    );
  });

  it('requires a probable-cause citation (in_probable_cause true) only when the clause says so; blank is not a citation', () => {
    expect(derive({}, [finding([CARB, CARB_OP], true)]).relevant).toEqual(['FIX10TX001', 'FIX15AK003', 'FIX18CO005']);
    expect(derive({}, [finding([CARB, CARB_OP], false)]).relevant).toEqual(['FIX10TX001', 'FIX12TX002', 'FIX15AK003', 'FIX18CO005', 'FIX20XX006']);
  });

  it('applies years and state to the event; a missing value fails its filter', () => {
    expect(derive({ yearFrom: 2010, yearTo: 2012 }, [finding([CARB, CARB_OP], false)]).relevant).toEqual(['FIX10TX001', 'FIX12TX002']);
    expect(derive({ state: ['TX'] }, [finding([CARB, CARB_OP], false)]).relevant).toEqual(['FIX10TX001', 'FIX12TX002']);
    expect(derive({ yearFrom: 2020 }, [finding([CARB], false)]).relevant).toEqual(['FIX20XX006']);
    expect(derive({ state: ['TX', 'CO'], yearFrom: 2020 }, [finding([CARB], false)]).relevant).toEqual([]);
  });

  it('requires the carrying aircraft to meet the aircraft facets (category, defining-event phase group)', () => {
    expect(derive({ category: ['AIR'] }, [finding([CARB, CARB_OP], false)]).relevant).toEqual(['FIX10TX001', 'FIX12TX002']);
    expect(derive({ phase: ['landing'] }, [finding([CARB, CARB_OP], false)]).relevant).toEqual(['FIX10TX001', 'FIX20XX006']);
    // A null category or phase fails the facet.
    expect(derive({ category: ['HELI'], phase: ['en_route'] }, [finding([CARB], false)]).relevant).toEqual(['FIX18CO005']);
    expect(derive({ category: ['HELI'] }, [finding([CARB], false)]).relevant).toEqual(['FIX15AK003', 'FIX18CO005']);
  });

  it('keeps a multi-aircraft event only when every aircraft meets the facets, recording the rest as unreachable', () => {
    const heli = derive({ category: ['HELI'] }, [event('250')]);
    // Two helicopters: reachable through the event-level qualification. Helicopter and airplane: unreachable.
    expect(heli).toMatchObject({ relevant: ['FIX18CO005'], unreachable: ['FIX15AK004'], multiAircraftRelevant: 1 });
    const air = derive({ category: ['AIR'] }, [event('250')]);
    expect(air).toMatchObject({ relevant: [], unreachable: ['FIX15AK004'] });
    // Without an aircraft facet every coded event counts and nothing needs the qualification.
    expect(derive({}, [event('250')])).toMatchObject({ relevant: ['FIX15AK004', 'FIX18CO005'], unreachable: [], multiAircraftRelevant: 0 });
  });

  it('attributes clauses to one aircraft (same-aircraft) or to any aircraft of the event (any-aircraft)', () => {
    // FIX15AK003: one helicopter carries both findings. FIX18CO005: one helicopter each.
    const clauses = [finding([DECISION], true), finding([CARB], true)];
    expect(derive({}, clauses, 'same-aircraft').relevant).toEqual(['FIX15AK003']);
    expect(derive({}, clauses, 'any-aircraft').relevant).toEqual(['FIX15AK003', 'FIX18CO005']);
    // FIX15AK004: both aircraft carry the midair, only the airplane the decision finding.
    const midairDecision = [event('250'), finding([DECISION], true)];
    expect(derive({}, midairDecision, 'same-aircraft').relevant).toEqual(['FIX15AK004', 'FIX18CO005']);
    // Under the helicopter filter only a helicopter may carry a clause: FIX15AK004's decision finding is the airplane's.
    expect(derive({ category: ['HELI'] }, midairDecision, 'any-aircraft')).toMatchObject({ relevant: ['FIX18CO005'], unreachable: [] });
    const d = derive({}, [event('192'), finding([CARB], true)]);
    expect(d.relevant).toEqual(['FIX10TX001']);
    expect(Object.fromEntries(d.perCode)).toEqual({ 'event:192': 1, [`finding:${CARB}`]: 1 });
  });

  it('records the text seen: finding descriptions without suffix, event text without its phase', () => {
    expect(normalizeFindingDescription('A-B-C - C')).toBe('A-B-C');
    expect(normalizeFindingDescription('A-B-C - F ')).toBe('A-B-C');
    expect(normalizeFindingDescription('A-B-C ')).toBe('A-B-C');
    expect(normalizeFindingDescription('Personnel issues-Task performance-Inspection-Preflight inspection-Pilot')).toBe(
      'Personnel issues-Task performance-Inspection-Preflight inspection-Pilot',
    );
    expect(commonWordSuffix(['Enroute-cruise Fuel exhaustion', 'Approach Fuel exhaustion'])).toBe('Fuel exhaustion');
    expect(commonWordSuffix(['Landing Midair collision'])).toBe('Landing Midair collision');
    const stats = codeStats(corpus, [
      { kind: 'finding', code: CARB },
      { kind: 'event', code: '250' },
      { kind: 'finding', code: '0000000000' },
    ]);
    expect(stats.get(`finding:${CARB}`)).toEqual({
      descriptions: [
        'Aircraft-Aircraft systems-Fuel system-Fuel pumps-Failure',
        'Environmental issues-...-Conducive to carburetor icing-Effect on equipment',
      ],
      cohortCases: 4,
      cohortCasesInProbableCause: 3,
    });
    expect(stats.get('event:250')).toEqual({ descriptions: ['Midair collision'], cohortCases: 2 });
    expect(stats.get('finding:0000000000')).toMatchObject({ descriptions: [], cohortCases: 0 });
  });

  it('refuses a corpus with rows of unknown cases or aircraft', () => {
    expect(() => indexCorpus({ ...corpus, findings: [{ ntsbNo: 'FIX10TX001', aircraftKey: 9, code: CARB, description: null, inProbableCause: true }] })).toThrow(/unknown aircraft/);
    expect(() => indexCorpus({ ...corpus, aircraft: [...corpus.aircraft, { ntsbNo: 'NOPE', aircraftKey: 1, category: null, definingPhaseGroup: null }] })).toThrow(/outside/);
  });

  it('describes the label rule as a sentence', () => {
    expect(describeCodeSet({ filters: { state: ['TX'], yearFrom: 2010, yearTo: 2012 }, codeSet: { clauses: [finding([CARB], true)], attribution: 'same-aircraft' } })).toBe(
      `Answer-eligible US cases from 2010 to 2012 in TX where one aircraft carries a finding coded ${CARB} cited in the probable cause.`,
    );
    expect(describeCodeSet({ filters: { category: ['HELI'] }, codeSet: { clauses: [event('250'), finding([DECISION], false)], attribution: 'any-aircraft' } })).toBe(
      'Answer-eligible US cases where a sequence-of-events occurrence coded 250 (any phase) is carried by some aircraft of category HELI, and ' +
        `a finding coded ${DECISION} (anywhere) is carried by some aircraft of category HELI. A multi-aircraft event counts only when every aircraft meets the aircraft filter (the passages-v2 event-level qualification).`,
    );
  });
});

// ---------------------------------------------------------------------------
// Assembly

const spec = (id: string, over: Partial<CodedQuestionSpec> = {}): CodedQuestionSpec => ({
  id,
  question: `Which accidents have a finding of conditions conducive to carburetor icing (${id})?`,
  area: 'environment',
  class: 'narrow',
  filters: {},
  codeSet: { clauses: [finding([CARB], false)], attribution: 'same-aircraft' },
  wording: ['conditions conducive to carburetor icing'],
  note: 'n',
  ...over,
});
const derivation = (relevant: string[]): Derivation => ({ relevant, unreachable: [], multiAircraftRelevant: 0, perCode: new Map([[`finding:${CARB}`, relevant.length]]) });
const cases = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
const stats = new Map([[`finding:${CARB}`, { descriptions: ['Conducive to carburetor icing-Effect on equipment'], cohortCases: 99, cohortCasesInProbableCause: 50 }]]);
const IDENTITY: GenerationSource = { generationId: 1, archiveSha256: 'a'.repeat(64), mappingVersion: 'v1-empirical', fieldNormalizationVersion: 'v1', citationTextVersion: 'v1' };
const SOURCE = { ...IDENTITY, answerEligibleCases: 100, builder: 'test' };

describe('coded set assembly', () => {
  it('keeps full relevant sets, rejects counts outside the class (never capped), and copies labels to paraphrases', () => {
    const specs = [spec('narrow-ok'), spec('narrow-big'), spec('broad-ok', { class: 'broad' }), spec('broad-small', { class: 'broad' }), spec('empty')];
    const derived = new Map([
      ['narrow-ok', derivation(cases('NOK', 20))],
      ['narrow-big', derivation(cases('NBG', 21))],
      ['broad-ok', derivation(cases('BOK', 40))],
      ['broad-small', derivation(cases('BSM', 20))],
      ['empty', derivation([])],
    ]);
    const built = assembleCoded(SOURCE, specs, [{ id: 'para-narrow-ok', of: 'narrow-ok', question: 'Which accidents involved weather favouring induction ice?', avoids: ['carburetor'] }], derived, stats);
    expect(built.rejected).toEqual([
      { id: 'narrow-big', class: 'narrow', count: 21 },
      { id: 'broad-small', class: 'broad', count: 20 },
      { id: 'empty', class: 'narrow', count: 0 },
    ]);
    const byId = new Map(built.dataset.questions.map((q) => [q.id, q]));
    expect(byId.get('narrow-ok')?.relevant).toHaveLength(20);
    expect(byId.get('broad-ok')?.relevant).toHaveLength(40);
    expect(byId.has('narrow-big')).toBe(false);
    expect(byId.get('para-narrow-ok')).toMatchObject({ paraphrase_of: 'narrow-ok', relevant: byId.get('narrow-ok')?.relevant, group: byId.get('narrow-ok')?.group, wording: ['carburetor'] });
    expect(byId.get('para-narrow-ok')?.tags).toContain('paraphrase');
    expect(byId.get('narrow-ok')?.codes).toEqual([
      { kind: 'finding', code: CARB, descriptions: ['Conducive to carburetor icing-Effect on equipment'], cohortCases: 99, cohortCasesInProbableCause: 50, relevantCases: 20 },
    ]);
    expect(built.problems).toEqual(
      expect.arrayContaining([
        'narrow-big: a narrow question cannot have 21 relevant cases (narrow 1..20, broad more; never capped)',
        'broad-small: a broad question cannot have 20 relevant cases (narrow 1..20, broad more; never capped)',
        'empty: the code set derives no case',
      ]),
    );
    expect(built.dataset.reference).toBe(REFERENCE);
    expect(built.dataset.caveat).toBe(CAVEAT);
  });

  it('keeps frozen splits: pinned questions stay put, the set is marked frozen, and groups pinned to both splits are refused', () => {
    const specs = [spec('a'), spec('b'), spec('c')];
    const derived = new Map([
      ['a', derivation(['C0000001'])],
      ['b', derivation(['C0000002'])],
      ['c', derivation(['C0000003'])],
    ]);
    const free = assembleCoded(SOURCE, specs, [], derived, stats);
    expect(free.dataset.splitsFrozen).toBe(false);
    const flip = (s: string | undefined) => (s === 'dev' ? ('holdout' as const) : ('dev' as const));
    const pins = new Map(free.dataset.questions.map((q) => [q.id, flip(q.split)]));
    const frozen = assembleCoded(SOURCE, specs, [], derived, stats, { pinned: pins, splitsFrozen: true });
    expect(frozen.dataset.splitsFrozen).toBe(true);
    for (const q of frozen.dataset.questions) expect(q.split, q.id).toBe(pins.get(q.id));
    // A spec edit that joins questions frozen in both splits.
    const edited = new Map([...derived, ['c', derivation(['C0000001', 'C0000002'])]]);
    const both = assembleCoded(SOURCE, specs, [], edited, stats, { pinned: new Map([['a', 'dev' as const], ['b', 'holdout' as const]]), splitsFrozen: true });
    expect(both.problems.join('\n')).toMatch(/split: group g\d+ joins questions pinned to dev \(a\) and to holdout \(b\); frozen splits cannot be kept/);
  });

  it('reads frozen splits from a committed file whatever else its schema holds', () => {
    expect(frozenSplits(null)).toEqual({ frozen: false, pinned: new Map() });
    expect(frozenSplits(JSON.stringify({ questions: [{ id: 'a', split: 'dev', extra: 1 }] }))).toEqual({ frozen: false, pinned: new Map() });
    expect(frozenSplits(JSON.stringify({ splitsFrozen: true, other: 'x', questions: [{ id: 'a', split: 'dev' }, { id: 'b', split: 'holdout' }] }))).toEqual({
      frozen: true,
      pinned: new Map([['a', 'dev'], ['b', 'holdout']]),
    });
    expect(() => frozenSplits(JSON.stringify({ splitsFrozen: true }))).toThrow(/no readable splits/);
  });

  it('warns about codes of a frozen family the frozen list does not hold', () => {
    const families = [{ name: 'carburetor icing', pattern: '^03031030[0-9]{2}$', codes: [CARB] }];
    // CARB_OP (0303103082) is in the cohort, of the family, and not frozen.
    expect(familyWarnings(corpus, families)).toEqual([`code family "carburetor icing": ${CARB_OP} occurs in 1 cohort case(s) but is not in the frozen set`]);
    expect(familyWarnings(corpus, [{ ...families[0] as (typeof families)[number], codes: [CARB, CARB_OP] }])).toEqual([]);
    // Every committed family's frozen codes are of its own kind.
    for (const f of CODE_FAMILIES) for (const code of f.codes) expect(code, f.name).toMatch(new RegExp(f.pattern, 'u'));
  });

  it('groups questions sharing a case, and paraphrases with their originals, in one split', () => {
    const specs = [spec('a'), spec('b'), spec('c')];
    const derived = new Map([
      ['a', derivation(['C0000001', 'C0000002'])],
      ['b', derivation(['C0000002', 'C0000003'])],
      ['c', derivation(['C0000009'])],
    ]);
    const built = assembleCoded(SOURCE, specs, [{ id: 'p', of: 'c', question: 'Which accidents involved weather favouring induction ice?', avoids: ['carburetor'] }], derived, stats);
    const q = new Map(built.dataset.questions.map((x) => [x.id, x]));
    expect(q.get('a')?.group).toBe(q.get('b')?.group);
    expect(q.get('p')?.group).toBe(q.get('c')?.group);
    expect(q.get('a')?.split).toBe(q.get('b')?.split);
  });

  it('checks the wording: code phrases in originals, "probable cause" exactly for cited clauses, avoided words in paraphrases', () => {
    expect(specProblems([spec('ok')], [])).toEqual([]);
    expect(specProblems([spec('x', { question: 'Which accidents had confirmed carburetor icing?' })], [])).toEqual([
      'x: the question does not contain the code phrase "conditions conducive to carburetor icing"',
    ]);
    expect(specProblems([spec('x', { codeSet: { clauses: [finding([CARB], true)], attribution: 'same-aircraft' } })], [])).toEqual([
      'x: a question says "probable cause" exactly when a clause must be cited in the probable cause',
    ]);
    expect(specProblems([spec('x', { question: 'Which accidents have a probable cause citing conditions conducive to carburetor icing?' })], [])).toHaveLength(1);
    expect(specProblems([spec('x')], [{ id: 'p', of: 'x', question: 'Which accidents had carburetor ice?', avoids: ['carburetor'] }])).toEqual([
      'p: the paraphrase uses the code word "carburetor"',
    ]);
    expect(specProblems([spec('x')], [{ id: 'p', of: 'nope', question: 'Which accidents had induction ice?', avoids: ['carburetor'] }])).toEqual([
      'p: paraphrase of unknown question nope',
    ]);
    expect(specProblems([spec('x', { codeSet: { clauses: [finding([CARB], false)], attribution: 'any-aircraft' } })], [])).toEqual([
      'x: a single clause is attributed to one aircraft (same-aircraft)',
    ]);
    // Only years, state, category and phase filter a coded question, never blank.
    expect(specProblems([spec('x', { filters: { injury: ['FATL'] } as CodedQuestionSpec['filters'] })], []).join()).toMatch(/filters only by/);
    expect(specProblems([spec('x', { filters: { category: ['blank'] } as CodedQuestionSpec['filters'] })], []).join()).toMatch(/blank/);
  });
});

// ---------------------------------------------------------------------------
// The committed coded set

describe('the committed coded set', () => {
  it('is built from the committed specs, labelled coded-reference, with every question consistent with its spec', () => {
    const d = committed();
    expect(d.source.specSha256).toBe(specSha256(CODED_QUESTIONS, CODED_PARAPHRASES));
    expect(d.reference).toBe('coded-reference');
    // Frozen splits (protocol section 6), and the generation's identity next to its id.
    expect(d.splitsFrozen).toBe(true);
    expect(d.source).toMatchObject({ generationId: 1, mappingVersion: 'v1-empirical', fieldNormalizationVersion: 'v1', citationTextVersion: 'v1' });
    expect(d.source.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(codedDatasetProblems(d)).toEqual([]);
    expect(specProblems(CODED_QUESTIONS, CODED_PARAPHRASES)).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/expert/i);
    const specs = new Map(CODED_QUESTIONS.map((q) => [q.id, q]));
    const paraphrases = new Map(CODED_PARAPHRASES.map((p) => [p.id, p]));
    expect(d.questions).toHaveLength(CODED_QUESTIONS.length + CODED_PARAPHRASES.length);
    for (const q of d.questions) {
      const s = specs.get(q.paraphrase_of ?? q.id) as CodedQuestionSpec;
      expect(s, q.id).toBeDefined();
      expect(q.question).toBe(q.paraphrase_of ? paraphrases.get(q.id)?.question : s.question);
      expect(q.filters).toEqual(s.filters);
      expect(q.codeSet).toEqual(s.codeSet);
      expect(q.class).toBe(s.class);
      expect(q.rule).toBe(describeCodeSet(s));
      expect(q.wording).toEqual(q.paraphrase_of ? paraphrases.get(q.id)?.avoids : s.wording);
      expect([...q.relevant].sort()).toEqual(q.relevant);
    }
  });

  it('covers every area with narrow and broad questions in both splits, with paraphrases, across 2008-2026', () => {
    const d = committed();
    expect(d.questions.length).toBeGreaterThanOrEqual(MIN_QUESTIONS);
    const narrow = d.questions.filter((q) => q.class === 'narrow');
    expect(narrow.length).toBeGreaterThanOrEqual(MIN_NARROW);
    for (const q of narrow) expect(q.relevant.length, q.id).toBeLessThanOrEqual(NARROW_MAX);
    for (const q of d.questions.filter((x) => x.class === 'broad')) expect(q.relevant.length, q.id).toBeGreaterThan(NARROW_MAX);
    expect(d.questions.filter((q) => q.paraphrase_of).length).toBeGreaterThanOrEqual(MIN_PARAPHRASES);
    for (const split of ['dev', 'holdout'] as const) {
      for (const area of AREAS) {
        for (const cls of CLASSES) expect(d.questions.some((q) => q.split === split && q.area === area && q.class === cls), `${split} ${area} ${cls}`).toBe(true);
      }
    }
    // No relevant case in both splits.
    const splitOf = new Map<string, string>();
    for (const q of d.questions) {
      for (const n of q.relevant) {
        expect(splitOf.get(n) ?? q.split, n).toBe(q.split);
        splitOf.set(n, q.split);
      }
    }
    // Every code identifier is recorded with the text seen and occurs in the cohort; the codes are ten-digit findings or three-digit events.
    for (const q of d.questions) {
      for (const c of q.codes) {
        expect(c.code).toMatch(c.kind === 'finding' ? /^\d{10}$/ : /^\d{3}$/);
        expect(c.cohortCases, `${q.id} ${c.code}`).toBeGreaterThan(0);
        expect(c.descriptions.length).toBeGreaterThan(0);
      }
    }
    const years = d.questions.flatMap((q) => [q.filters.yearFrom ?? 2008, q.filters.yearTo ?? 2026]);
    expect(Math.min(...years)).toBe(2008);
    expect(Math.max(...years)).toBe(2026);
    // Exercised: probable-cause clauses, aircraft filters, a phase filter, multi-clause attribution, and the event-level qualification.
    for (const tag of ['probable_cause', 'aircraft_filter', 'multi_clause', 'paraphrase']) expect(d.questions.some((q) => q.tags.includes(tag)), tag).toBe(true);
    expect(d.questions.some((q) => (q.filters.phase ?? []).length > 0)).toBe(true);
    expect(d.questions.some((q) => q.needsEventAircraftQualification && q.unreachable.length > 0)).toBe(true);
  });

  it('words conditions as conditions: carburetor icing questions never claim confirmed ice', () => {
    for (const q of committed().questions.filter((x) => x.codes.some((c) => c.code.startsWith('03031030')) && !x.paraphrase_of)) {
      expect(q.question).toContain('conditions conducive to carburetor icing');
      expect(q.question).not.toMatch(/confirmed|found ice|ice formed/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Runner checks before anything is embedded

const item = (id: string, over: Partial<CodedItem> = {}): CodedItem => ({
  id,
  question: 'Which accidents involved a midair collision?',
  tags: ['occurrence', 'narrow'],
  area: 'occurrence',
  class: 'narrow',
  wording: ['midair collision'],
  filters: {},
  codeSet: { clauses: [event('250')], attribution: 'same-aircraft' },
  rule: describeCodeSet({ filters: {}, codeSet: { clauses: [event('250')], attribution: 'same-aircraft' } }),
  codes: [{ kind: 'event', code: '250', descriptions: ['Midair collision'], cohortCases: 3, relevantCases: 1 }],
  relevant: ['FIX18CO005'],
  unreachable: [],
  needsEventAircraftQualification: false,
  group: 'g1',
  split: 'dev',
  note: 'n',
  ...over,
});

describe('coded runner preflight (fails closed before embedding)', () => {
  const clean = committed();
  const sha = specSha256(CODED_QUESTIONS, CODED_PARAPHRASES);
  const identity: GenerationSource = {
    generationId: clean.source.generationId,
    archiveSha256: clean.source.archiveSha256,
    mappingVersion: clean.source.mappingVersion,
    fieldNormalizationVersion: clean.source.fieldNormalizationVersion,
    citationTextVersion: clean.source.citationTextVersion,
  };
  /** The target as a re-derivation on the same generation would find it. */
  const sameTarget: TargetCheck = { source: identity, labels: codedLabels(clean), warnings: [] };
  const base = { split: 'all' as const, eventAircraftQualification: true, specSha256: sha, target: sameTarget };

  it('passes the committed set against its generation on a passages-v2 index', () => {
    const pre = codedPreflight(clean, base);
    expect(pre.problems).toEqual([]);
    expect(pre.items).toHaveLength(clean.questions.length);
    expect(codedPreflight(clean, { ...base, split: 'holdout' }).items.every((q) => q.split === 'holdout')).toBe(true);
  });

  it('refuses labels that do not hold on the target: another generation, another archive or version, or other re-derived cases', () => {
    const target = (over: Partial<GenerationSource>, labels = codedLabels(clean)): TargetCheck => ({ source: { ...identity, ...over }, labels, warnings: [] });
    expect(codedPreflight(clean, { ...base, target: target({ generationId: identity.generationId + 1 }) }).problems).toEqual([
      `generation: the coded set was built from generation ${identity.generationId}; the target is generation ${identity.generationId + 1}`,
    ]);
    expect(codedPreflight(clean, { ...base, target: target({ archiveSha256: 'f'.repeat(64), mappingVersion: 'v2', fieldNormalizationVersion: 'v2', citationTextVersion: 'v2' }) }).problems).toEqual([
      `generation: the coded set was built from source archive sha256 ${identity.archiveSha256}; the target generation has ${'f'.repeat(64)}`,
      `generation: the coded set was built from completion mapping version ${identity.mappingVersion}; the target generation has v2`,
      `generation: the coded set was built from field normalization version ${identity.fieldNormalizationVersion}; the target generation has v2`,
      `generation: the coded set was built from citation text version ${identity.citationTextVersion}; the target generation has v2`,
    ]);
    // One question derives another case on the target; another loses an unreachable case; a third was not re-derived.
    const q = clean.questions.find((x) => x.id === 'occ-midair-nevada') as CodedItem;
    const heli = clean.questions.find((x) => x.id === 'occ-midair-helicopters') as CodedItem;
    const labels = codedLabels(clean);
    labels.set(q.id, { relevant: [...q.relevant.slice(1), 'ZZZ99XX999'], unreachable: [] });
    labels.set(heli.id, { relevant: heli.relevant, unreachable: heli.unreachable.slice(1) });
    labels.delete('occ-cfit-utah');
    expect(codedPreflight(clean, { ...base, target: target({}, labels) }).problems).toEqual([
      `labels: occ-midair-nevada: the target derives ${q.relevant.length} positive cases, the dataset has ${q.relevant.length}: +1 (ZZZ99XX999) -1 (${q.relevant[0]})`,
      `labels: occ-midair-helicopters: unreachable cases differ on the target: -1 (${heli.unreachable[0]})`,
      'labels: occ-cfit-utah was not re-derived on the target',
    ]);
    // The same comparison serves the silver set (no unreachable cases).
    expect(targetProblems('silver', { source: identity, labels: new Map([['s', { relevant: ['A0000001'] }]]) }, target({}, new Map([['s', { relevant: ['A0000001'] }]])))).toEqual([]);
  });

  it('reports other question specs, and questions a passages-v1 index cannot reach', () => {
    expect(codedPreflight(clean, { ...base, specSha256: '0'.repeat(64) }).problems).toEqual([
      'dataset: built from other question specs than the committed ones; rebuild it with pnpm eval:retrieval:coded',
    ]);
    const v1 = codedPreflight(clean, { ...base, eventAircraftQualification: false });
    const needs = clean.questions.filter((q) => q.needsEventAircraftQualification).map((q) => q.id);
    expect(needs.length).toBeGreaterThan(0);
    expect(v1.notRun).toEqual(needs);
    expect(v1.items.some((q) => needs.includes(q.id))).toBe(false);
    expect(v1.problems.join()).toMatch(/no event-level aircraft qualification/);
  });

  it('reports dataset problems: classes, splits, paraphrases and coverage', () => {
    const bad: CodedDataset = {
      ...clean,
      questions: [
        item('big', { relevant: cases('R', 21) }),
        item('x', { relevant: ['C0000001'], split: 'dev' }),
        item('y', { relevant: ['C0000001'], split: 'holdout', group: 'g2' }),
        item('p', { paraphrase_of: 'x', relevant: ['C0000002'], tags: ['occurrence', 'narrow'] }),
      ],
    };
    const problems = codedPreflight(bad, base).problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        'dataset: big: a narrow question cannot have 21 relevant cases (narrow 1..20, broad more)',
        'dataset: case C0000001 is relevant in both splits',
        'dataset: p: relevant differs from x',
        'dataset: p: a paraphrase carries the paraphrase tag',
        `dataset: only 4 questions (at least ${MIN_QUESTIONS})`,
      ]),
    );
  });

  it('refuses a dataset that does not parse, and options that are not a valid run', () => {
    expect(parseCodedDataset('{')).toMatchObject({ issues: [expect.stringMatching(/not JSON/)] });
    const wrongLabel = JSON.stringify({ ...clean, reference: 'expert' });
    expect('issues' in parseCodedDataset(wrongLabel)).toBe(true);
    expect('dataset' in parseCodedDataset(JSON.stringify(clean))).toBe(true);
    expect(runOptions({ 'confirm-cost': true, 'fake-embedder': true })).toBeNull();
    expect(runOptions({ sizes: '50,0' })).toBeNull();
    expect(runOptions({ split: 'test' })).toBeNull();
    expect(runOptions({})).toMatchObject({ sizes: [50, 100], split: 'all', confirmCost: false, fake: false, exploratory: false });
  });
});

describe('coded summaries', () => {
  it('averages per size, mode and group, and tabulates every question', () => {
    const result = (id: string, split: 'dev' | 'holdout', cls: 'narrow' | 'broad', relevant: string[], ranking: string[]): CodedQuestionResult => {
      const score = scoreQuestion(ranking, ranking.slice(0, 6), codedReference(relevant));
      const mode = { score, top20: [], codedRanks: {}, bundle: { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: 0 }, fetch: null };
      return {
        id,
        split,
        group: 'g1',
        class: cls,
        area: 'occurrence',
        paraphraseOf: null,
        tags: ['occurrence', cls, 'paraphrase'],
        question: 'q',
        filters: {},
        relevant: relevant.length,
        sizes: { '50': { candidates: { keyword: 0, vector: 0, fused: 0, cases: 0 }, modes: { keyword: mode, vector: mode, hybrid: mode }, requests: { keyword: {}, vector: {} }, timingsMs: { embed: 0, channels: 0 } } },
      };
    };
    const qs = [result('n1', 'dev', 'narrow', ['A'], ['A']), result('b1', 'holdout', 'broad', cases('B', 30), cases('B', 6))];
    const s = summarizeCoded(qs, [50]);
    expect(s['50']?.hybrid['dev/narrow']?.recallGate).toEqual({ questions: 1, mean: 1, atTarget: 1 });
    expect(s['50']?.hybrid['holdout/broad']?.strictP6).toEqual({ lower: 1, upper: 1 });
    expect(s['50']?.hybrid['holdout/broad']?.recallDiagnostic).toEqual({ questions: 1, mean: 0.2, ceiling: 0.6667 });
    expect(s['50']?.hybrid['area:occurrence']?.questions).toBe(2);
    expect(s['50']?.hybrid['tag:paraphrase']?.questions).toBe(2);
    // Every area and tag group is also split by class, so a block never mixes narrow and broad questions.
    expect(s['50']?.hybrid[classGroup('tag:paraphrase', 'narrow')]).toMatchObject({ questions: 1, recallGate: { questions: 1, mean: 1 } });
    expect(s['50']?.hybrid[classGroup('tag:paraphrase', 'broad')]).toMatchObject({ questions: 1, strictP6: { lower: 1, upper: 1 }, recallGate: { questions: 0 } });
    expect(s['50']?.hybrid[classGroup('area:occurrence', 'broad')]?.questions).toBe(1);
    expect(classGroup('all', 'narrow')).toBe('narrow');
    // n1 returns its one coded case: strict P@6 is 1/6.
    expect(s['50']?.hybrid['tag:paraphrase/narrow']?.strictP6).toEqual({ lower: 0.1667, upper: 0.1667 });
    const table = codedTable(qs, [50]);
    expect(table).toHaveLength(6);
    expect(table.find((r) => r.id === 'b1' && r.mode === 'hybrid')).toMatchObject({ recallAt20: 0.2, recallGate: 'diagnostic', recallCeiling: 20 / 30, strictP6: 1, codedPrecision: 1, ndcg6: 1, returned: 6 });
  });
});

describe('building from a corpus', () => {
  it('derives every committed question over a corpus and reports the coverage problems of a tiny one', () => {
    const built = buildCodedFromCorpus(IDENTITY, corpus);
    // Only the two-helicopter midair fits its class in the synthetic cohort; the mixed event is unreachable under the filter.
    expect(built.dataset.questions.filter((q) => !q.paraphrase_of).map((q) => q.id)).toEqual(['occ-midair-helicopters']);
    expect(built.dataset.questions[0]).toMatchObject({ relevant: ['FIX18CO005'], unreachable: ['FIX15AK004'], needsEventAircraftQualification: true });
    expect(built.rejected).toHaveLength(CODED_QUESTIONS.length - 1);
    expect(built.dataset.source).toMatchObject({ ...IDENTITY, answerEligibleCases: 7, specSha256: specSha256(CODED_QUESTIONS, CODED_PARAPHRASES) });
    expect(built.problems).toEqual(expect.arrayContaining(['env-carb-icing-cause-michigan: the code set derives no case', `only 1 questions (at least ${MIN_QUESTIONS})`]));
  });
});
