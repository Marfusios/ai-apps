/**
 * The narrative-relevance question set (Track N): cohort derivation with the passages
 * index semantics (event facets, aircraft facets, every aircraft of a multi-aircraft
 * event), the spec and dataset checks, assembly (versions, paraphrase families, bounded
 * and broad cohorts, related-code positives) and the committed dataset.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNarrativeFromCorpus, COHORT_QUERIES, type NarrativeCorpus } from '../../evals/retrieval/narrative/build.js';
import {
  NarrativeDatasetSchema,
  assembleNarrative,
  deriveCohort,
  families,
  inCohort,
  membersOf,
  narrativeDatasetProblems,
  type CohortCase,
  type NarrativeDataset,
} from '../../evals/retrieval/narrative/dataset.js';
import { NARRATIVE_PARAPHRASES, NARRATIVE_QUESTIONS } from '../../evals/retrieval/narrative/questions.js';
import {
  BOUNDED_MAX,
  CAVEAT,
  MIN_BOUNDED,
  TAGS,
  canonicalJson,
  narrativeSpecProblems,
  questionVersion,
  rubricVersion,
  specSha256,
  type NarrativeParaphraseSpec,
  type NarrativeQuestionSpec,
} from '../../evals/retrieval/narrative/spec.js';
import type { GenerationSource } from '../../evals/retrieval/generation.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const committed = (): NarrativeDataset =>
  NarrativeDatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/dataset.json'), 'utf8')));

const aircraft = (over: Partial<CohortCase['aircraft'][number]> = {}): CohortCase['aircraft'][number] => ({
  aircraftKey: 1,
  category: 'AIR',
  phase: 'landing',
  farPart: '091',
  purpose: 'PERS',
  engines: ['REC'],
  ...over,
});
const kase = (ntsbNo: string, over: Partial<CohortCase> = {}): CohortCase => ({
  ntsbNo,
  evYear: 2016,
  state: 'TX',
  injury: 'NONE',
  conditions: 'VMC',
  light: 'DAYL',
  aircraft: [aircraft()],
  ...over,
});

describe('cohort derivation (passages-v2 semantics)', () => {
  const cases: CohortCase[] = [
    kase('FIX16TX001'),
    kase('FIX12AK002', { evYear: 2012, state: 'AK', light: 'NITE', aircraft: [aircraft({ category: 'HELI', engines: ['TS'] })] }),
    kase('FIX18AK003', { evYear: 2018, state: 'AK', aircraft: [aircraft({ aircraftKey: 1, category: 'HELI' }), aircraft({ aircraftKey: 2, category: 'HELI' })] }),
    kase('FIX18AK004', { evYear: 2018, state: 'AK', aircraft: [aircraft({ aircraftKey: 1, category: 'HELI' }), aircraft({ aircraftKey: 2, category: 'AIR' })] }),
    kase('FIX19CO005', { evYear: null, state: null, aircraft: [aircraft({ category: null, purpose: null, engines: [] })] }),
    kase('FIX20NV006', { evYear: 2020, state: 'NV', aircraft: [aircraft({ purpose: 'SKYD', farPart: '091', engines: ['TP'] })] }),
    kase('FIX21NV007', { evYear: 2021, state: 'NV', aircraft: [] }),
  ];

  it('applies years and event facets, a missing value failing its facet', () => {
    expect(deriveCohort(cases, {})).toEqual(cases.map((c) => c.ntsbNo).sort());
    expect(deriveCohort(cases, { yearFrom: 2016 })).toEqual(['FIX16TX001', 'FIX18AK003', 'FIX18AK004', 'FIX20NV006', 'FIX21NV007']);
    expect(deriveCohort(cases, { yearTo: 2012 })).toEqual(['FIX12AK002']);
    expect(deriveCohort(cases, { state: ['AK'] })).toEqual(['FIX12AK002', 'FIX18AK003', 'FIX18AK004']);
    expect(deriveCohort(cases, { light: ['NITE', 'NDRK'] })).toEqual(['FIX12AK002']);
    expect(inCohort(cases[4] as CohortCase, { yearFrom: 2000 })).toBe(false);
  });

  it('needs every aircraft of a multi-aircraft event to meet the aircraft facets', () => {
    expect(deriveCohort(cases, { category: ['HELI'] })).toEqual(['FIX12AK002', 'FIX18AK003']);
    expect(deriveCohort(cases, { category: ['AIR'] })).toEqual(['FIX16TX001', 'FIX20NV006']);
    expect(deriveCohort(cases, { category: ['AIR', 'HELI'] })).toEqual(['FIX12AK002', 'FIX16TX001', 'FIX18AK003', 'FIX18AK004', 'FIX20NV006']);
  });

  it('reads engine types as a set, and other aircraft facets as single values', () => {
    expect(deriveCohort(cases, { engine: ['TS'] })).toEqual(['FIX12AK002']);
    expect(deriveCohort(cases, { purpose: ['SKYD'] })).toEqual(['FIX20NV006']);
    expect(deriveCohort(cases, { purpose: ['SKYD'], engine: ['REC'] })).toEqual([]);
    expect(deriveCohort(cases, { far_part: ['091'], state: ['NV'] })).toEqual(['FIX20NV006']);
    expect(deriveCohort(cases, { phase: ['landing'], state: ['TX'] })).toEqual(['FIX16TX001']);
  });

  it('keeps an event without aircraft rows out of any aircraft facet', () => {
    expect(inCohort(cases[6] as CohortCase, {})).toBe(true);
    expect(inCohort(cases[6] as CohortCase, { category: ['AIR'] })).toBe(false);
  });

  it('reads no narrative text', () => {
    for (const sql of Object.values(COHORT_QUERIES)) expect(sql).not.toMatch(/case_sections|\btext\b|cause_factor/);
  });
});

// ---------------------------------------------------------------------------

const rubric = {
  relevant: 'The record states the thing the question asks about, in full.',
  partial: 'The record states part of the thing the question asks about.',
  notRelevant: 'The record does not state the thing the question asks about.',
  edgeCases: [
    { situation: 'A record that states it in full.', grade: 2 as const, why: 'Complete.' },
    { situation: 'A record that states half of it.', grade: 1 as const, why: 'Part.' },
    { situation: 'A record that states the opposite.', grade: 0 as const, why: 'Contrast.' },
  ],
};
const spec = (id: string, over: Partial<NarrativeQuestionSpec> = {}): NarrativeQuestionSpec => ({
  id,
  question: `Which accidents match the ${id} question?`,
  tags: ['negation', 'mechanical'],
  type: 'broad',
  filters: {},
  rubric,
  lure: 'a lure that shares the surface terms',
  note: 'A synthetic question.',
  ...over,
});

describe('spec checks', () => {
  it('passes the committed questions', () => {
    expect(narrativeSpecProblems(NARRATIVE_QUESTIONS, NARRATIVE_PARAPHRASES)).toEqual([]);
  });

  it('finds duplicate ids, missing aircraft-filter tags, one-sided edge cases and unknown paraphrase targets', () => {
    const specs = [
      spec('a-one'),
      spec('a-one'),
      spec('b-two', { filters: { category: ['AIR'] } }),
      spec('c-three', { tags: ['negation', 'aircraft_filter'] }),
      spec('d-four', { rubric: { ...rubric, edgeCases: rubric.edgeCases.map((e) => ({ ...e, grade: 0 as const })) } }),
    ];
    const paraphrases: NarrativeParaphraseSpec[] = [{ id: 'p-one', of: 'missing', question: 'Which accidents are like that one?', note: 'A paraphrase.' }];
    const problems = narrativeSpecProblems(specs, paraphrases);
    expect(problems).toContain('duplicate question id a-one');
    expect(problems).toContain('b-two: tagged aircraft_filter exactly when it filters on an aircraft facet');
    expect(problems).toContain('c-three: tagged aircraft_filter exactly when it filters on an aircraft facet');
    expect(problems).toContain('d-four: the edge cases need a not-relevant case and a (partially) relevant one');
    expect(problems).toContain('p-one: paraphrase of unknown question missing');
    expect(problems.some((p) => p.startsWith('only ') && p.includes('bounded cohorts'))).toBe(true);
  });

  it('allows related codes only with Track C filters', () => {
    const codes = { clauses: [{ kind: 'event' as const, codes: ['250'] }], attribution: 'same-aircraft' as const };
    expect(narrativeSpecProblems([spec('e-five', { relatedCodes: codes, filters: { purpose: ['SKYD'] }, tags: ['negation', 'aircraft_filter'] })], [])).toContain(
      'e-five: related codes need Track C filters only (years, state, aircraft category, phase group)',
    );
    expect(narrativeSpecProblems([spec('e-five', { relatedCodes: codes, filters: { yearFrom: 2010 } })], []).filter((p) => p.startsWith('e-five'))).toEqual([]);
  });

  it('refuses blank filter values', () => {
    expect(narrativeSpecProblems([spec('f-six', { filters: { state: ['blank'] } })], []).some((p) => p.startsWith('f-six: filters'))).toBe(true);
  });
});

describe('versions', () => {
  it('hash the judged question and the rubric, stable under key order', () => {
    const a = questionVersion({ question: 'Which?', filters: { state: ['TX'], yearFrom: 2010 } });
    const b = questionVersion({ question: 'Which?', filters: { yearFrom: 2010, state: ['TX'] } });
    expect(a).toBe(b);
    expect(a).toMatch(/^q-[0-9a-f]{16}$/);
    expect(questionVersion({ question: 'Which?', filters: { state: ['TX'] } })).not.toBe(a);
    expect(rubricVersion(rubric)).not.toBe(rubricVersion({ ...rubric, partial: `${rubric.partial} More.` }));
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });
});

// ---------------------------------------------------------------------------

const SOURCE: GenerationSource = {
  generationId: 7,
  archiveSha256: 'a'.repeat(64),
  mappingVersion: 'v1-empirical',
  fieldNormalizationVersion: 'v1',
  citationTextVersion: 'v1',
};
const source = { ...SOURCE, answerEligibleCases: 900, builder: 'test' };

describe('assembly', () => {
  const big = Array.from({ length: BOUNDED_MAX + 1 }, (_, i) => `FIX10TX${String(i).padStart(3, '0')}`);
  const small = big.slice(0, 12);

  it('lists bounded cohorts, sizes broad ones and copies a family to its paraphrases', () => {
    const specs = [spec('a-one', { type: 'bounded-cohort' }), spec('b-two')];
    const built = assembleNarrative(source, specs, [{ id: 'p-one', of: 'a-one', question: 'Which accidents look like that?', note: 'Lay wording.' }], new Map([['a-one', small], ['b-two', big]]), new Map());
    const byId = new Map(built.dataset.questions.map((q) => [q.id, q]));
    expect(byId.get('a-one')?.cohort).toEqual({ size: 12, cases: small });
    expect(byId.get('b-two')?.cohort).toEqual({ size: BOUNDED_MAX + 1, cases: null });
    const p = byId.get('p-one');
    expect(p?.family).toBe('a-one');
    expect(p?.questionVersion).toBe(byId.get('a-one')?.questionVersion);
    expect(p?.memberVersion).not.toBe(p?.questionVersion);
    expect(p?.tags).toContain('paraphrase');
    expect(p?.cohort).toEqual(byId.get('a-one')?.cohort);
    expect(built.dataset.source.specSha256).toBe(specSha256(specs, [{ id: 'p-one', of: 'a-one', question: 'Which accidents look like that?', note: 'Lay wording.' }]));
  });

  it('refuses a bounded cohort above the limit and a broad question within it', () => {
    const built = assembleNarrative(source, [spec('a-one', { type: 'bounded-cohort' }), spec('b-two')], [], new Map([['a-one', big], ['b-two', small]]), new Map());
    expect(built.problems).toContain(`a-one: a bounded cohort reaches ${BOUNDED_MAX + 1} cases (at most ${BOUNDED_MAX})`);
    expect(built.problems).toContain(`b-two: a broad question's cohort is larger than ${BOUNDED_MAX} (it holds 12); make it a bounded cohort`);
  });

  it('records related positives and refuses them outside the cohort or above the limit', () => {
    const codes = { clauses: [{ kind: 'event' as const, codes: ['250'] }], attribution: 'same-aircraft' as const };
    const ok = assembleNarrative(source, [spec('a-one', { type: 'bounded-cohort', relatedCodes: codes })], [], new Map([['a-one', small]]), new Map([['a-one', [small[3] as string, small[1] as string]]]));
    expect(ok.dataset.questions[0]?.relatedPositives).toEqual([small[1], small[3]]);
    const outside = assembleNarrative(source, [spec('a-one', { type: 'bounded-cohort', relatedCodes: codes })], [], new Map([['a-one', small]]), new Map([['a-one', ['ZZZ99XX999']]]));
    expect(outside.problems.some((p) => p.includes('outside the cohort'))).toBe(true);
    const many = assembleNarrative(source, [spec('a-one', { relatedCodes: codes })], [], new Map([['a-one', big]]), new Map([['a-one', big.slice(0, 81)]]));
    expect(many.problems).toContain('a-one: 81 related positives (at most 80); narrow the related codes');
  });

  it('builds end to end from a synthetic corpus', () => {
    const corpus: NarrativeCorpus = {
      source: SOURCE,
      cohort: [kase('FIX16TX001'), kase('FIX17TX002', { aircraft: [aircraft({ purpose: 'SKYD' })] })],
      coded: null,
    };
    const built = buildNarrativeFromCorpus(corpus, [spec('a-one', { type: 'bounded-cohort', filters: { purpose: ['SKYD'] }, tags: ['negation', 'aircraft_filter'] })], []);
    expect(built.dataset.questions[0]?.cohort).toEqual({ size: 1, cases: ['FIX17TX002'] });
    expect(built.dataset.source.answerEligibleCases).toBe(2);
  });
});

describe('the committed dataset', () => {
  const d = committed();

  it('is the build of the committed specs, without problems', () => {
    expect(d.source.specSha256).toBe(specSha256(NARRATIVE_QUESTIONS, NARRATIVE_PARAPHRASES));
    expect(narrativeDatasetProblems(d)).toEqual([]);
  });

  it('has about 24 questions, at least four bounded cohorts within the limit, and every tag', () => {
    expect(d.questions.length).toBeGreaterThanOrEqual(22);
    expect(d.questions.length).toBeLessThanOrEqual(28);
    const bounded = families(d).filter((q) => q.type === 'bounded-cohort');
    expect(bounded.length).toBeGreaterThanOrEqual(MIN_BOUNDED);
    for (const q of bounded) expect(q.cohort.size).toBeLessThanOrEqual(BOUNDED_MAX);
    for (const tag of TAGS) expect(d.questions.some((q) => q.tags.includes(tag))).toBe(true);
  });

  it('judges every paraphrase under its family question and rubric', () => {
    for (const f of families(d)) {
      for (const m of membersOf(d, f.id)) {
        expect(m.questionVersion).toBe(f.questionVersion);
        expect(m.rubricVersion).toBe(f.rubricVersion);
      }
    }
  });

  it('is labelled model-judged and never claims expert adjudication', () => {
    const text = readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/dataset.json'), 'utf8');
    expect(d.reference).toBe('model-judged');
    expect(d.caveat).toBe(CAVEAT);
    for (const m of text.matchAll(/expert/gi)) expect(text.slice(Math.max(0, (m.index ?? 0) - 12), m.index)).toMatch(/never |not /);
  });
});
