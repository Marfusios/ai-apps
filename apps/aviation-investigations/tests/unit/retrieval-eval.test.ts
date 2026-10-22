import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { precomputedEmbedder } from '../../evals/retrieval/run.js';
import { aggregate, bundleCoverage, firstHitRank, recallAt, scoreMode } from '../../evals/retrieval/metrics.js';
import { QUESTIONS } from '../../evals/retrieval/questions.js';
import {
  DatasetSchema,
  MAX_EXPECTED,
  MIN_QUESTIONS,
  REQUIRED_TAGS,
  SEED_CASES,
  assignSplits,
  compileCriteria,
  datasetProblems,
  describeCriteria,
  disjointExpected,
  filterProblems,
  rulesSha256,
  type Dataset,
} from '../../evals/retrieval/silver.js';
import { summarize, type QuestionResult } from '../../evals/retrieval/evaluate.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const committed = (): Dataset => DatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/dataset.json'), 'utf8')));

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

  it('measures bundle coverage of expected cases and of their causes', () => {
    const bundle = [
      { ntsbNo: 'A', passages: [{ sectionKind: 'analysis' }, { sectionKind: 'probable_cause' }] },
      { ntsbNo: 'B', passages: [{ sectionKind: 'analysis' }] },
      { ntsbNo: 'X', passages: [{ sectionKind: 'probable_cause' }] },
    ];
    expect(bundleCoverage(['A', 'B', 'C'], bundle, 6)).toEqual({ cases: 2, causes: 1, denominator: 3, caseRatio: 2 / 3, causeRatio: 1 / 3 });
    // With more expected cases than the bundle can hold, the bound is the bundle size.
    const many = Array.from({ length: 10 }, (_, i) => `E${i}`);
    expect(bundleCoverage(many, many.slice(0, 6).map((n) => ({ ntsbNo: n, passages: [{ sectionKind: 'probable_cause' }] })), 6).caseRatio).toBe(1);
  });

  it('averages questions per group', () => {
    const s1 = scoreMode(['A'], ['A'], [{ ntsbNo: 'A', passages: [{ sectionKind: 'probable_cause' }] }], 6);
    const s2 = scoreMode(['B'], ['A'], [], 6);
    expect(aggregate([s1, s2])).toMatchObject({ questions: 2, recallAt20: 0.5, fullRecallAt20: 0.5, anyInBundle: 0.5, coverageCases: 0.5, coverageCauses: 0.5 });
    const result = (id: string, split: 'dev' | 'holdout', s: typeof s1): QuestionResult => ({
      id,
      split,
      tags: ['negation'],
      question: 'q',
      filters: {},
      expected: ['A'],
      sizes: { '50': { candidates: { keyword: 0, vector: 0, fused: 0, cases: 0 }, modes: { keyword: { ...s, top20: [], expectedRanks: {}, bundle: { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: 0 }, fetch: null }, vector: { ...s, top20: [], expectedRanks: {}, bundle: { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: 0 }, fetch: null }, hybrid: { ...s, top20: [], expectedRanks: {}, bundle: { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: 0 }, fetch: null } }, requests: { keyword: {}, vector: {} }, timingsMs: { embed: 0, channels: 0 } } },
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

  it('keeps a case derived by several rules with the first question only, and splits held out by case', () => {
    const d = disjointExpected([
      { id: 'a', tags: ['negation'], derived: ['C1', 'C2'] },
      { id: 'b', tags: ['negation'], derived: ['C2', 'C3'] },
    ]);
    expect(d[1]).toMatchObject({ expected: ['C3'], sharedWith: [{ ntsbNo: 'C2', keptIn: 'a' }] });
    const splits = assignSplits([
      { id: 'a', tags: ['negation'], expected: ['C1'] },
      { id: 'b', tags: ['negation'], expected: ['C3'] },
      { id: 'c', tags: ['multi_aircraft'], expected: ['C3', 'C4'] },
    ]);
    // b and c share C3: one component, one split; a goes to the other split.
    expect(splits.get('b')).toBe(splits.get('c'));
    expect(splits.get('a')).not.toBe(splits.get('b'));
  });

  it('requires filters to state what the rule states', () => {
    expect(filterProblems({ id: 'x', filters: { category: ['HELI'] }, criteria: { categoryAny: ['HELI'] } })).toEqual([
      'x: an aircraft filter needs a single-aircraft rule (maxAircraft 1)',
    ]);
    expect(filterProblems({ id: 'x', filters: { yearFrom: 2008, yearTo: 2009 }, criteria: { years: [2008, 2010] } })).toHaveLength(1);
    expect(filterProblems({ id: 'x', filters: { state: ['AK'] }, criteria: { states: ['AK'], text: [] } })).toEqual([]);
  });
});

describe('the committed silver set', () => {
  it('is built from the committed rules, with every label pending expert adjudication', () => {
    const d = committed();
    expect(d.source.rulesSha256).toBe(rulesSha256(QUESTIONS));
    expect(d.questions.length).toBeGreaterThanOrEqual(MIN_QUESTIONS);
    expect(d.adjudication).toBe('pending-expert');
    const specs = new Map(QUESTIONS.map((q) => [q.id, q]));
    for (const q of d.questions) {
      const spec = specs.get(q.id);
      expect(spec, q.id).toBeDefined();
      expect(q.adjudication).toBe('pending-expert');
      expect(q.question).toBe(spec?.question);
      expect(q.filters).toEqual(spec?.filters);
      expect(q.derivation.criteria).toEqual(spec?.criteria);
      expect(q.derivation.rule).toBe(describeCriteria(spec?.criteria ?? {}));
      expect(q.expected.length).toBeLessThanOrEqual(MAX_EXPECTED);
      expect([...q.expected].sort()).toEqual(q.expected);
    }
  });

  it('covers negation, causal uncertainty, maintenance timing and multi-aircraft cases in both splits, held out by case', () => {
    const d = committed();
    expect(datasetProblems(d)).toEqual([]);
    for (const tag of REQUIRED_TAGS) {
      for (const split of ['dev', 'holdout'] as const) expect(d.questions.some((q) => q.split === split && q.tags.includes(tag)), `${tag}/${split}`).toBe(true);
    }
    const all = d.questions.flatMap((q) => q.expected);
    expect(new Set(all).size).toBe(all.length);
    // The seed cases appear, but never alone.
    const seeds = new Set<string>(SEED_CASES);
    expect(all.filter((n) => seeds.has(n)).length).toBeGreaterThan(0);
    expect(d.questions.every((q) => q.expected.some((n) => !seeds.has(n)))).toBe(true);
  });
});
