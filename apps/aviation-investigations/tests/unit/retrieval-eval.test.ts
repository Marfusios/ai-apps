import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleSilver } from '../../evals/retrieval/build-silver.js';
import { summarize, type ModeResult, type QuestionResult } from '../../evals/retrieval/evaluate.js';
import { aggregate, bundleCoverage, bundlePrecision, firstHitRank, ndcgAt, recallAt, scoreMode } from '../../evals/retrieval/metrics.js';
import { PARAPHRASES, QUESTIONS } from '../../evals/retrieval/questions.js';
import { precomputedEmbedder } from '../../evals/retrieval/run.js';
import {
  DatasetSchema,
  MAX_EXPECTED,
  MIN_PARAPHRASES,
  MIN_QUESTIONS,
  REQUIRED_TAGS,
  SEED_CASES,
  assignSplits,
  compileCriteria,
  datasetProblems,
  describeCriteria,
  filterProblems,
  jsPattern,
  needsEventAircraftQualification,
  rulesSha256,
  satisfiesTextCriterion,
  type Dataset,
  type QuestionSpec,
} from '../../evals/retrieval/silver.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const committed = (): Dataset => DatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/dataset.json'), 'utf8')));
const pc = (text = 'cause') => ({ sectionKind: 'probable_cause', text });
const an = (text = 'analysis') => ({ sectionKind: 'analysis', text });

describe('retrieval metrics', () => {
  it('measures case recall@k against min(|expected|, k)', () => {
    const ranking = ['A', 'X', 'B', 'Y', 'Z', 'W', 'C'];
    expect(recallAt(['A', 'B', 'C'], ranking, 20)).toBe(1);
    expect(recallAt(['A', 'B', 'C'], ranking, 6)).toBeCloseTo(2 / 3, 12);
    expect(recallAt(['A', 'B', 'C'], ranking, 2)).toBe(0.5);
    expect(recallAt(['Q'], ranking, 20)).toBe(0);
    expect(firstHitRank(['B', 'C'], ranking)).toBe(3);
    expect(firstHitRank(['Q'], ranking)).toBeNull();
    expect(() => recallAt([], ranking, 20)).toThrow();
  });

  it('measures case, question-specific evidence and structural cause coverage of the bundle', () => {
    const criteria = { text: [{ in: ['analysis' as const], pattern: String.raw`stall warning\y` }] };
    const bundle = [
      { ntsbNo: 'A', passages: [an('the stall warning did not sound'), pc()] },
      { ntsbNo: 'B', passages: [an('airspeed decayed'), pc('the pilot stalled')] },
      { ntsbNo: 'X', passages: [pc()] },
    ];
    expect(bundleCoverage(['A', 'B', 'C'], bundle, 6, criteria)).toEqual({
      cases: 2,
      evidence: 1,
      causes: 2,
      denominator: 3,
      caseRatio: 2 / 3,
      evidenceRatio: 1 / 3,
      causeRatio: 2 / 3,
    });
    // A rule without text has no evidence criterion.
    expect(bundleCoverage(['A'], bundle, 6, { minAircraft: 2 }).evidence).toBeNull();
    // With more expected cases than the bundle can hold, the bound is the bundle size.
    const many = Array.from({ length: 10 }, (_, i) => `E${i}`);
    expect(bundleCoverage(many, many.slice(0, 6).map((n) => ({ ntsbNo: n, passages: [pc()] })), 6).caseRatio).toBe(1);
  });

  it('measures bundle precision and binary nDCG@6', () => {
    expect(bundlePrecision(['A', 'B'], ['A', 'X', 'B', 'Y'])).toBe(0.5);
    expect(bundlePrecision(['A'], [])).toBeNull();
    expect(ndcgAt(['A', 'B'], ['A', 'B', 'X'])).toBe(1);
    expect(ndcgAt(['A', 'B'], ['X', 'A', 'B'])).toBeCloseTo((1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)), 12);
    expect(ndcgAt(['A'], ['X'])).toBe(0);
  });

  it('averages questions per group, leaving undefined metrics out', () => {
    const criteria = { text: [{ in: ['probable_cause' as const], pattern: 'carb' }] };
    const s1 = scoreMode(['A'], ['A'], [{ ntsbNo: 'A', passages: [pc('carb ice')] }], 6, criteria);
    const s2 = scoreMode(['B'], ['A'], [], 6, criteria);
    expect(aggregate([s1, s2])).toMatchObject({
      questions: 2,
      recallAt20: 0.5,
      fullRecallAt20: 0.5,
      anyInBundle: 0.5,
      coverageCases: 0.5,
      coverageEvidence: 0.5,
      evidenceQuestions: 2,
      coverageCausesStructural: 0.5,
      bundlePrecision: 1,
      ndcg6: 0.5,
    });
    const mode = (s: typeof s1): ModeResult => ({ ...s, top20: [], expectedRanks: {}, bundle: { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: 0 }, fetch: null });
    const result = (id: string, split: 'dev' | 'holdout', s: typeof s1): QuestionResult => ({
      id,
      split,
      group: 'g1',
      paraphraseOf: null,
      tags: ['negation'],
      question: 'q',
      filters: {},
      expected: ['A'],
      sizes: { '50': { candidates: { keyword: 0, vector: 0, fused: 0, cases: 0 }, modes: { keyword: mode(s), vector: mode(s), hybrid: mode(s) }, requests: { keyword: {}, vector: {} }, timingsMs: { embed: 0, channels: 0 } } },
    });
    const summary = summarize([result('a', 'dev', s1), result('b', 'holdout', s2)], [50]);
    expect(summary['50']?.hybrid.dev?.recallAt20).toBe(1);
    expect(summary['50']?.hybrid.holdout?.recallAt20).toBe(0);
    expect(summary['50']?.hybrid['tag:negation']?.questions).toBe(2);
  });

  it('answers queries from vectors embedded up front', async () => {
    const v = new Float32Array([1, 0]);
    const e = precomputedEmbedder({ model: 'm', dims: 2, usdPerMillionTokens: 0.02 }, new Map([['carb ice', v]]));
    expect((await e.embed(['carb ice'])).vectors[0]).toBe(v);
    await expect(e.embed(['other'])).rejects.toThrow(/up front/);
  });
});

describe('silver set rules', () => {
  it('compiles a rule to bound SQL over the answer-eligible cohort', () => {
    const q = compileCriteria({
      years: [2008, 2010],
      states: ['AK'],
      categoryAny: ['HELI'],
      maxAircraft: 1,
      inspectedWithinDays: 3,
      text: [{ in: ['probable_cause'], pattern: "carb'; drop table cases; --" }],
      textNot: [{ in: ['analysis', 'factual'], pattern: 'x' }],
    });
    expect(q.text).toContain('c.generation_id = $1');
    expect(q.text).toContain('c.answer_eligible');
    expect(q.text).not.toContain('drop table');
    expect(q.values).toContain("carb'; drop table cases; --");
    expect(q.values).toContainEqual(['analysis', 'factual']);
    expect(q.text.match(/\$\d+/g)?.length).toBe(q.values.length + 1);
    const rule = describeCriteria({ years: [2008, 2010], categoryAny: ['HELI'], maxAircraft: 1, text: [{ in: ['probable_cause'], pattern: 'carb' }] });
    expect(rule).toBe(
      'Answer-eligible US cases from 2008 to 2010 with a single aircraft with an aircraft of category HELI, where the probable cause matches /carb/ (case-insensitive PostgreSQL regular expressions, one section at a time).',
    );
  });

  it('reads hours since the last inspection directly from afm_hrs_last_insp', () => {
    const q = compileCriteria({ hoursSinceInspectionMax: 5 });
    expect(q.text).toContain('a.afm_hrs_last_insp between 0 and $2');
    expect(q.text).not.toMatch(/afm_hrs\s*-/);
    expect(q.values).toEqual([5]);
  });

  it('matches every committed text rule in JavaScript as in PostgreSQL', () => {
    for (const spec of QUESTIONS) {
      for (const rule of [...(spec.criteria.text ?? []), ...(spec.criteria.textNot ?? [])]) expect(() => jsPattern(rule.pattern), spec.id).not.toThrow();
    }
    expect(jsPattern(String.raw`\ybird`).test('a bird strike')).toBe(true);
    expect(jsPattern(String.raw`\ybird`).test('a seabird')).toBe(false);
    const criteria = { text: [{ in: ['probable_cause' as const], pattern: 'carburetor ic' }, { in: ['analysis' as const], pattern: 'heat' }] };
    expect(satisfiesTextCriterion(criteria, [pc('Carburetor icing'), an('no carburetor heat')])).toBe(true);
    // Each rule needs a passage of its own section kinds.
    expect(satisfiesTextCriterion(criteria, [pc('carburetor icing; heat')])).toBe(false);
  });

  it('groups questions that share a case or are paraphrases, and splits groups whole', () => {
    const g = assignSplits(
      [
        { id: 'a', tags: ['negation'], expected: ['C1'] },
        { id: 'b', tags: ['negation'], expected: ['C3'] },
        { id: 'c', tags: ['multi_aircraft'], expected: ['C3', 'C4'] },
        { id: 'd', tags: ['negation'], expected: ['C9'] },
        { id: 'p', tags: ['negation', 'paraphrase'], expected: ['C9'] },
        { id: 'q', tags: ['negation', 'paraphrase'], expected: ['C7'] },
        { id: 'e', tags: ['negation'], expected: ['C8'] },
      ],
      [['q', 'e']],
    );
    // b and c share C3; d and p share C9; q is linked to e as its paraphrase.
    expect(g.group.get('b')).toBe(g.group.get('c'));
    expect(g.group.get('d')).toBe(g.group.get('p'));
    expect(g.group.get('q')).toBe(g.group.get('e'));
    expect(g.groups).toHaveLength(4);
    for (const group of g.groups) for (const id of group.questions) expect(g.split.get(id)).toBe(group.split);
    expect(() => assignSplits([{ id: 'a', tags: ['negation'], expected: ['C1'] }], [['a', 'zz']])).toThrow(/unknown question/);
  });

  it('keeps full positive sets, copies them to paraphrases and rejects out-of-bounds rules without capping', () => {
    const spec = (id: string, tag: QuestionSpec['tags'][number], over: Partial<QuestionSpec> = {}): QuestionSpec => ({
      id,
      question: `question ${id} about something`,
      tags: [tag],
      filters: {},
      criteria: { text: [{ in: ['probable_cause'], pattern: id }] },
      note: 'n',
      ...over,
    });
    const specs = [spec('one', 'negation'), spec('two', 'negation'), spec('big', 'multi_aircraft'), spec('struct', 'structured_timing', { section: 'structured' })];
    const derived = new Map<string, string[]>([
      ['one', ['C1', 'C2']],
      ['two', ['C2', 'C3']],
      ['big', Array.from({ length: 25 }, (_, i) => `D${String(i).padStart(6, '0')}`)],
      ['struct', ['C9AAAA']],
    ].map(([k, v]) => [k as string, (v as string[]).map((n) => (n.length < 6 ? `${n}XXXXX` : n))]));
    const built = assembleSilver(
      { generationId: 1, archiveSha256: 'a'.repeat(64), mappingVersion: 'v1-empirical', fieldNormalizationVersion: 'v1', citationTextVersion: 'v1', answerEligibleCases: 100 },
      specs,
      [{ id: 'one-p', of: 'one', question: 'the same question in other words', avoids: ['one'] }],
      derived,
    );
    const byId = new Map(built.dataset.questions.map((q) => [q.id, q]));
    // The shared case C2 stays in both questions; they land in one group.
    expect(byId.get('one')?.expected).toEqual(['C1XXXXX', 'C2XXXXX']);
    expect(byId.get('two')?.expected).toEqual(['C2XXXXX', 'C3XXXXX']);
    expect(byId.get('one')?.group).toBe(byId.get('two')?.group);
    expect(byId.get('one-p')).toMatchObject({ paraphrase_of: 'one', expected: ['C1XXXXX', 'C2XXXXX'], tags: ['negation', 'paraphrase'], group: byId.get('one')?.group });
    expect(byId.get('struct')?.section).toBe('structured');
    // 25 cases: rejected, never cut to 20.
    expect(built.rejected).toEqual([{ id: 'big', count: 25 }]);
    expect(byId.has('big')).toBe(false);
    expect(built.problems.some((p) => p.includes('never capped'))).toBe(true);
    // The generation's identity is recorded next to its id.
    expect(built.dataset.source).toMatchObject({ generationId: 1, archiveSha256: 'a'.repeat(64), mappingVersion: 'v1-empirical', fieldNormalizationVersion: 'v1', citationTextVersion: 'v1' });
  });

  it('keeps pinned groups in their split, places a question that joins one with it, and reports groups pinned to both', () => {
    const items = [
      { id: 'a', tags: ['negation'], expected: ['C1'] },
      { id: 'b', tags: ['negation'], expected: ['C2'] },
      { id: 'c', tags: ['negation'], expected: ['C3'] },
    ];
    const free = assignSplits(items);
    // Pin every question to the opposite of its free split: the pins win.
    const flipped = new Map(items.map((q) => [q.id, free.split.get(q.id) === 'dev' ? ('holdout' as const) : ('dev' as const)]));
    const pinned = assignSplits(items, [], undefined, flipped);
    for (const q of items) expect(pinned.split.get(q.id), q.id).toBe(flipped.get(q.id));
    expect(pinned.conflicts).toEqual([]);
    // Labels stay in sha256 order of the groups, pinned or not.
    expect([...pinned.group.entries()]).toEqual([...free.group.entries()]);
    // A new question sharing a case with a pinned one follows its group.
    const grown = assignSplits([...items, { id: 'new', tags: ['negation'], expected: ['C2', 'C9'] }], [], undefined, flipped);
    expect(grown.split.get('new')).toBe(flipped.get('b'));
    // A new question joining questions pinned to both splits is a conflict.
    const both = new Map([['a', 'dev' as const], ['b', 'holdout' as const]]);
    const joined = assignSplits([...items, { id: 'bridge', tags: ['negation'], expected: ['C1', 'C2'] }], [], undefined, both);
    expect(joined.conflicts).toHaveLength(1);
    expect(joined.conflicts[0]).toMatch(/joins questions pinned to dev \(a\) and to holdout \(b\)/);
    // Without pins nothing changes and nothing conflicts.
    expect(assignSplits(items).conflicts).toEqual([]);
  });

  it('requires filters to state what the rule states', () => {
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { categoryAny: ['HELI'] } })).toEqual([
      'x: an aircraft filter needs a single-aircraft rule (maxAircraft 1) or an every-aircraft rule (categoryEvery)',
    ]);
    expect(filterProblems({ id: 'x', filters: { yearFrom: 2008, yearTo: 2009 }, criteria: { years: [2008, 2010] } })).toHaveLength(1);
    expect(filterProblems({ id: 'x', filters: { state: ['AK'] }, criteria: { states: ['AK'], text: [] } })).toEqual([]);
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { categoryAny: ['HELI'], maxAircraft: 1 } })).toEqual([]);
  });

  it('accepts an aircraft filter over multi-aircraft events only with an every-aircraft rule of that one category', () => {
    // Every aircraft of each derived event is a helicopter: the event-level qualification reaches all of them.
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { minAircraft: 2, categoryEvery: 'HELI' } })).toEqual([]);
    expect(filterProblems({ id: 'x', filters: { category: ['AIR'] }, criteria: { minAircraft: 2, categoryEvery: 'HELI' } })).toEqual([
      "x: filter category differs from the rule's categoryEvery",
    ]);
    expect(filterProblems({ id: 'x', filters: { category: ['HELI', 'AIR'] }, criteria: { minAircraft: 2, categoryEvery: 'HELI' } })).toHaveLength(1);
    // A helicopter-and-airplane event never meets a helicopter filter (mixed events stay excluded).
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { minAircraft: 2, categoriesAll: ['HELI', 'AIR'] } })).toHaveLength(2);
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { minAircraft: 2, categoryEvery: 'HELI', categoryAny: ['HELI'] } })).toEqual([
      'x: an every-aircraft rule states its category once (categoryEvery)',
    ]);
    // "Every aircraft" holds vacuously for an event without aircraft rows, which no aircraft filter matches.
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { categoryEvery: 'HELI' } })).toEqual([
      'x: an every-aircraft rule under an aircraft filter needs minAircraft',
    ]);
  });

  it('marks the questions only the event-level aircraft qualification can answer', () => {
    expect(needsEventAircraftQualification({ filters: { category: ['HELI'] }, criteria: { minAircraft: 2, categoryEvery: 'HELI' } })).toBe(true);
    expect(needsEventAircraftQualification({ filters: { category: ['HELI'] }, criteria: { categoryAny: ['HELI'], maxAircraft: 1 } })).toBe(false);
    expect(needsEventAircraftQualification({ filters: { state: ['AK'] }, criteria: { minAircraft: 2 } })).toBe(false);
    expect(needsEventAircraftQualification({ filters: {}, criteria: { minAircraft: 2, categoryEvery: 'HELI' } })).toBe(false);
  });

  it('places groups so that every required tag spread over several groups reaches both splits', () => {
    // Two negation groups and two multi-aircraft groups: each tag lands in both splits whatever the hash order.
    const g = assignSplits([
      { id: 'n1', tags: ['negation'], expected: ['N1'] },
      { id: 'n2', tags: ['mechanical', 'negation'], expected: ['N2'] },
      { id: 'm1', tags: ['multi_aircraft'], expected: ['M1'] },
      { id: 'm2', tags: ['operational', 'multi_aircraft'], expected: ['M2'] },
      { id: 's1', tags: ['structured_timing', 'negation'], expected: ['S1'], section: 'structured' },
    ]);
    for (const [a, b] of [['n1', 'n2'], ['m1', 'm2']] as const) expect(g.split.get(a), `${a}/${b}`).not.toBe(g.split.get(b));
  });
});

describe('the committed silver set', () => {
  it('is built from the committed rules, with full positive sets and every label pending expert adjudication', () => {
    const d = committed();
    expect(d.source.rulesSha256).toBe(rulesSha256(QUESTIONS, PARAPHRASES));
    expect(d.questions.filter((q) => q.section === 'rag').length).toBeGreaterThanOrEqual(MIN_QUESTIONS);
    expect(d.adjudication).toBe('pending-expert');
    const specs = new Map(QUESTIONS.map((q) => [q.id, q]));
    const paraphrases = new Map(PARAPHRASES.map((p) => [p.id, p]));
    for (const q of d.questions) {
      const spec = specs.get(q.paraphrase_of ?? q.id);
      expect(spec, q.id).toBeDefined();
      expect(q.adjudication).toBe('pending-expert');
      expect(q.question).toBe(q.paraphrase_of ? paraphrases.get(q.id)?.question : spec?.question);
      expect(q.filters).toEqual(spec?.filters);
      expect(q.derivation.criteria).toEqual(spec?.criteria);
      expect(q.derivation.rule).toBe(describeCriteria(spec?.criteria ?? {}));
      expect(q.expected.length).toBeLessThanOrEqual(MAX_EXPECTED);
      expect([...q.expected].sort()).toEqual(q.expected);
    }
  });

  it('keeps the three structured inspection-time questions out of the RAG section', () => {
    const structured = committed().questions.filter((q) => q.section === 'structured');
    expect(structured.map((q) => q.id).sort()).toEqual(['mt-inspected-within-3-days', 'mt-inspected-within-30-days-power-loss', 'mt-within-5-hours-of-inspection']);
    for (const q of structured) expect(q.tags).toEqual(['structured_timing']);
  });

  it('has at least 12 paraphrases across the tags, each avoiding its original label words', () => {
    const d = committed();
    const paraphrases = d.questions.filter((q) => q.paraphrase_of !== undefined);
    expect(paraphrases.length).toBeGreaterThanOrEqual(MIN_PARAPHRASES);
    for (const tag of REQUIRED_TAGS) expect(paraphrases.some((q) => q.tags.includes(tag)), tag).toBe(true);
    for (const p of PARAPHRASES) {
      for (const word of p.avoids) expect(p.question.toLowerCase(), `${p.id} avoids ${word}`).not.toContain(word.toLowerCase());
    }
  });

  it('covers negation, causal uncertainty, narrative maintenance timing and multi-aircraft cases in both splits, held out by group', () => {
    const d = committed();
    expect(datasetProblems(d)).toEqual([]);
    const rag = d.questions.filter((q) => q.section === 'rag');
    for (const tag of REQUIRED_TAGS) {
      for (const split of ['dev', 'holdout'] as const) expect(rag.some((q) => q.split === split && q.tags.includes(tag)), `${tag}/${split}`).toBe(true);
    }
    // A case shared by several questions keeps them in one group, hence one split.
    const groupOf = new Map<string, string>();
    for (const q of d.questions) {
      for (const n of q.expected) {
        expect(groupOf.get(n) ?? q.group, n).toBe(q.group);
        groupOf.set(n, q.group);
      }
    }
    // The seed cases appear, but never alone.
    const seeds = new Set<string>(SEED_CASES);
    expect(d.questions.flatMap((q) => q.expected).filter((n) => seeds.has(n)).length).toBeGreaterThan(0);
    expect(d.questions.every((q) => q.expected.some((n) => !seeds.has(n)))).toBe(true);
  });
});
