/**
 * Track N pools, metrics and the dry run's arithmetic: the pool rule (method union by
 * unique cases, bounded cohorts, related positives, hard negatives by the lure's order,
 * the seeded near and far tail), priorities and bundle pairs; references with unknown
 * grades kept in every denominator, supported P@6 bounds, kappa and Wilson intervals,
 * discovery by depth, method-exclusive hits, the tail estimate, the agreement and
 * calibration figures and the discrepancy log; pool and cost estimates; and the CLI's
 * usage errors (nothing contacted).
 */
import { describe, expect, it } from 'vitest';
import { main, USAGE } from '../../evals/retrieval/narrative/cli.js';
import type { CalibrationItem } from '../../evals/retrieval/narrative/calibration.js';
import { ADJUDICATOR, EXPECTED_OUTPUT, JUDGE_A, JUDGE_B } from '../../evals/retrieval/narrative/config.js';
import { llmPrice } from '../../server/ai/pricing.js';
import { NarrativeDatasetSchema, type NarrativeItem } from '../../evals/retrieval/narrative/dataset.js';
import type { PairRecord } from '../../evals/retrieval/narrative/judging.js';
import { ASSUMPTIONS, PHASE_A_UNION, addRuns, callUsd, caseCost, poolEstimates, rates, scaleRun, statsOf, type Measured } from '../../evals/retrieval/narrative/plan.js';
import { POOL_RULE, assemblePool, bundlePairs, casePriority, poolFileVersion, type PoolRun } from '../../evals/retrieval/narrative/pool.js';
import {
  agreementClass,
  agreementReport,
  auditSamples,
  calibrationReport,
  cohenKappa,
  discoveryByDepth,
  discrepancies,
  familyReference,
  judgedCoverage,
  methodExclusive,
  questionValues,
  scoreRuns,
  supportedAt6,
  tailEstimate,
  wilson,
} from '../../evals/retrieval/narrative/score.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Label } from '../../evals/retrieval/metrics.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const dataset = () => NarrativeDatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/dataset.json'), 'utf8')));

const RUBRIC = { relevant: 'All conditions are stated.', partial: 'Some conditions are stated.', notRelevant: 'No condition is stated.', edgeCases: [{ situation: 'Everything stated here.', grade: 2 as const, why: 'All.' }, { situation: 'Nothing stated here.', grade: 0 as const, why: 'None.' }, { situation: 'Half stated here.', grade: 1 as const, why: 'Some.' }] };
const item = (over: Partial<NarrativeItem> = {}): NarrativeItem => ({
  id: 'fam',
  question: 'Which accidents match?',
  family: 'fam',
  tags: ['negation'],
  type: 'broad',
  filters: {},
  questionVersion: 'q-0000000000000000',
  memberVersion: 'q-0000000000000000',
  rubric: RUBRIC,
  rubricVersion: 'r-0000000000000000',
  lure: 'lure words here',
  cohort: { size: 400, cases: null },
  relatedPositives: [],
  note: 'n',
  ...over,
});
const COHORT = Array.from({ length: 40 }, (_, i) => `C${String(i).padStart(3, '0')}XX`);
const run = (method: string, sample: number, ranking: string[], bundle: string[] = ranking.slice(0, 2)): PoolRun => ({
  member: 'fam',
  method,
  sample,
  ranking,
  bundle: bundle.map((n, i) => ({ ntsbNo: n, caseRank: i + 1, passages: [{ passageId: `p-${n}`, sectionId: `${n}:factual/aircraft-1`, revisionId: 'r', kind: 'factual', scope: 'aircraft', aircraftKey: 1, start: 0, end: 10, textSha256: `s-${n}` }] })),
});
const RULE = { ...POOL_RULE, depth: 5, hardNegatives: 2, lureDepth: 50, tail: { nearFrom: 6, nearTo: 10, near: 2, far: 3 } };

describe('the pool rule', () => {
  const runs = [run('p50-kt', 1, COHORT.slice(0, 12)), run('c200+n-kt', 1, [...COHORT.slice(3, 8), ...COHORT.slice(20, 30)])];

  it('unions each method\'s first unique cases, adds lure hard negatives and a seeded near and far tail', () => {
    const p = assemblePool({ family: item(), members: [item()], runs, cohort: COHORT, lure: ['C001XX', 'C039XX', 'C038XX', 'C037XX'], rule: RULE as never });
    const methodCases = p.cases.filter((c) => c.sources.includes('method')).map((c) => c.ntsbNo);
    expect(methodCases).toEqual([...COHORT.slice(0, 8)]);
    expect(p.cases.find((c) => c.ntsbNo === 'C003XX')?.bestRank).toEqual({ 'p50-kt': 4, 'c200+n-kt': 1, 'c200+nf-kt': null });
    expect(p.cases.filter((c) => c.sources.includes('hard-negative')).map((c) => [c.ntsbNo, c.lureRank])).toEqual([
      ['C038XX', 3],
      ['C039XX', 2],
    ]);
    expect(p.tail.near).toHaveLength(2);
    expect(p.tail.far).toHaveLength(3);
    // Ranks 6 to 10 outside the pool: p50-kt's C008 and C009 (C005 to C007 are c200+n-kt's first five), c200+n-kt's C020 to C024.
    for (const n of p.tail.near) expect([...COHORT.slice(8, 10), ...COHORT.slice(20, 25)]).toContain(n);
    expect(p.tail.nearSize).toBe(7);
    expect(assemblePool({ family: item(), members: [item()], runs, cohort: COHORT, lure: ['C001XX', 'C039XX', 'C038XX', 'C037XX'], rule: RULE as never })).toEqual(p);
  });

  it('judges a bounded cohort completely, with no tail, and adds related positives', () => {
    const p = assemblePool({ family: item({ type: 'bounded-cohort', cohort: { size: 10, cases: COHORT.slice(0, 10) }, relatedPositives: ['C002XX'] }), members: [item()], runs, cohort: COHORT.slice(0, 10), lure: [], rule: RULE as never });
    expect(p.cases.filter((c) => c.sources.includes('cohort'))).toHaveLength(10);
    expect(p.cases.find((c) => c.ntsbNo === 'C002XX')?.sources).toContain('related');
    expect(p.tail).toEqual({ nearSize: 0, farSize: 0, near: [], far: [] });
  });

  it('versions the pool by its content', () => {
    const a = assemblePool({ family: item(), members: [item()], runs, cohort: COHORT, lure: [], rule: RULE as never });
    const b = assemblePool({ family: item(), members: [item()], runs: [runs[0] as PoolRun], cohort: COHORT, lure: [], rule: RULE as never });
    expect(a.version).not.toBe(b.version);
    const body = { kind: 'track-n-pools' as const, rule: POOL_RULE, datasetSpecSha256: 'x', generationId: 1, target: {}, methods: [], families: [a] };
    expect(poolFileVersion(body)).not.toBe(poolFileVersion({ ...body, families: [b] }));
  });

  it('orders escalations: delivered, then the first 20, then bounded cohorts, then the rest; bundle pairs are distinct', () => {
    const base = { ntsbNo: 'X', sources: ['method' as const], lureRank: null, delivered: false };
    expect(casePriority({ ...base, bestRank: { a: 3 }, delivered: true }, 'broad')).toBe(3);
    expect(casePriority({ ...base, bestRank: { a: 15 } }, 'broad')).toBe(10_015);
    expect(casePriority({ ...base, bestRank: { a: 60 } }, 'bounded-cohort')).toBe(20_060);
    expect(casePriority({ ...base, bestRank: { a: 60 } }, 'broad')).toBe(30_060);
    expect(casePriority({ ...base, sources: ['hard-negative'], bestRank: { a: null }, lureRank: 4 }, 'broad')).toBe(40_004);
    const p = assemblePool({ family: item(), members: [item()], runs: [...runs, run('c200+n-kt', 2, COHORT.slice(0, 5))], cohort: COHORT, lure: [], rule: RULE as never });
    const pairs = bundlePairs(p);
    expect(pairs.map((x) => x.ntsbNo)).toEqual(['C000XX', 'C001XX', 'C003XX', 'C004XX']);
    expect(pairs.find((x) => x.ntsbNo === 'C000XX')?.runs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('references and run scores', () => {
  it('keep unknown grades in every denominator; a bounded cohort is exhaustive only without unknowns', () => {
    const cohort = ['A', 'B', 'C', 'D'];
    const ref = familyReference({ type: 'bounded-cohort', cases: [], cohort }, new Map<string, Label>([['A', 2], ['B', 0], ['C', 2]]));
    expect(ref.labels.get('D')).toBe('unknown');
    expect(ref.exhaustive).toBe(true);
    const broad = familyReference({ type: 'broad', cases: [{ ntsbNo: 'A', sources: [], bestRank: {}, lureRank: null, delivered: false }] }, new Map([['A', 1]]));
    expect(broad.unlisted).toBe('unknown');
    expect(broad.exhaustive).toBe(false);
  });

  it('reports judged coverage of the pool and of a bounded cohort, unresolved and unjudged cases apart', () => {
    const cases = ['A', 'B', 'C'].map((n) => ({ ntsbNo: n, sources: [], bestRank: {}, lureRank: null, delivered: false }));
    const labels = new Map<string, Label>([['A', 2], ['B', 'unknown']]);
    expect(judgedCoverage({ cases }, labels, ['A', 'B', 'C', 'D'])).toEqual({
      pool: { cases: 3, known: 1, unresolved: 1, notJudged: 1 },
      cohort: { cases: 4, known: 1, unresolved: 1, notJudged: 2 },
    });
    expect(judgedCoverage({ cases }, labels, null).cohort).toBeNull();
  });

  it('bounds supported P@6 by the unknowns of either judgment', () => {
    const bundle = run('m', 1, ['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D']).bundle;
    const rel = new Map<string, Label>([['A', 2], ['B', 2], ['C', 'unknown'], ['D', 0]]);
    const ans = new Map<string, Label>([['A|p-A:s-A', 2], ['B|p-B:s-B', 0], ['C|p-C:s-C', 2]]);
    expect(supportedAt6(bundle, (n) => rel.get(n) ?? 'unknown', (n, k) => ans.get(`${n}|${k}`) ?? 'unknown')).toEqual({ lower: 1 / 6, upper: 2 / 6 });
  });

  it('scores each run and averages the scope samples per method', () => {
    const cohort = Array.from({ length: 8 }, (_, i) => `K${i}`);
    const labels = new Map<string, Label>(cohort.map((n, i) => [n, i < 3 ? 2 : 0]));
    const pool = assemblePool({
      family: item({ type: 'bounded-cohort', cohort: { size: 8, cases: cohort } }),
      members: [item()],
      runs: [run('p50-kt', 1, cohort), run('p50-kt', 2, [...cohort].reverse())],
      cohort,
      lure: [],
    });
    const ref = familyReference({ ...pool, cohort }, labels);
    const scores = scoreRuns(pool, ref, new Map());
    expect(scores.map((s) => s.protocol.recall.gate)).toEqual(['eligible', 'eligible']);
    const [v] = questionValues(pool, scores);
    expect(v?.recallGate).toBe(1);
    expect(v?.p6.lower).toBeCloseTo((2 / 6 + 0) / 2, 10);
    expect(v).toMatchObject({ noPositivePossible: false, abstention: false });
    // All unknown: some assignment leaves no relevant case (flagged), and none abstains under every assignment.
    const unknown = scoreRuns(pool, familyReference({ ...pool, cohort }, new Map()), new Map());
    expect(questionValues(pool, unknown)[0]).toMatchObject({ noPositivePossible: true, abstention: false, recallGate: null });
    // All judged 0: the ideal DCG is 0 under every assignment, so nDCG@6 abstains.
    const none = scoreRuns(pool, familyReference({ ...pool, cohort }, new Map(cohort.map((n) => [n, 0 as const]))), new Map());
    expect(questionValues(pool, none)[0]).toMatchObject({ noPositivePossible: true, abstention: true, ndcg6: null });
  });
});

describe('agreement and calibration figures', () => {
  it('computes Cohen\'s kappa (unweighted and linear-weighted) and Wilson intervals', () => {
    expect(cohenKappa([[2, 2], [0, 0], [1, 1]]).kappa).toBe(1);
    const k = cohenKappa([[2, 2], [2, 1], [0, 0], [1, 1], [0, 2]]);
    // Observed 3/5; expected 0.4 x 0.2 + 0.2 x 0.4 + 0.4 x 0.4 = 0.32; (0.6 - 0.32) / 0.68.
    expect(k.kappa).toBeCloseTo(0.28 / 0.68, 10);
    expect(k.weighted).not.toBeNull();
    expect(cohenKappa([[2, 2], [2, 2]]).kappa).toBeNull();
    const w = wilson(8, 10);
    expect(w.rate).toBe(0.8);
    expect(w.lower).toBeCloseTo(0.4902, 3);
    expect(w.upper).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0).rate).toBeNull();
  });

  const record = (family: string, ntsbNo: string, a: 0 | 1 | 2 | null, b: 0 | 1 | 2 | null, label: Label, status: PairRecord['status'], adjudication: PairRecord['adjudication'] = null): PairRecord => ({
    kind: 'relevance',
    family,
    ntsbNo,
    bundleKey: null,
    questionVersion: 'q',
    rubricVersion: 'r',
    fingerprint: 'f',
    judges: [
      { role: 'judge-a', provider: 'anthropic', model: 'm', key: 'k', outcome: `a${a}`, status: a === null ? 'unjudgeable' : 'valid', grade: a, reason: null, absent: null, cached: false },
      { role: 'judge-b', provider: 'openai', model: 'm', key: 'k', outcome: `b${b}`, status: b === null ? 'unjudgeable' : 'valid', grade: b, reason: null, absent: null, cached: false },
    ],
    adjudication,
    label,
    status,
    attempts: [],
    verdicts: [],
  });
  const adj = (initial: 0 | 1 | 2, final: 0 | 1 | 2 | 'abstain'): PairRecord['adjudication'] => ({ initialKey: 'ki', key: 'k', order: ['judge-a', 'judge-b'], initial, initialStatus: 'valid', final, status: 'valid', cached: false });
  const records = [
    record('f1', 'A', 2, 2, 2, 'agreed'),
    record('f1', 'B', 0, 0, 0, 'agreed'),
    record('f2', 'C', 2, 1, 2, 'adjudicated', adj(1, 2)),
    record('f2', 'D', 1, 0, 'unknown', 'abstained', adj(1, 'abstain')),
    record('f3', 'E', null, 2, 'unknown', 'escalation-budget-exhausted'),
  ];

  it('reports judge-judge and judge-adjudicator agreement, per tag and grade', () => {
    const r = agreementReport(records, (f) => (f === 'f1' ? ['negation'] : ['chronology']), { resamples: 200, seed: 1 });
    expect(r.judgeJudge.all.n).toBe(4);
    expect(r.judgeJudge.all.agreement.k).toBe(2);
    expect(r.judgeJudge.byTag.negation?.n).toBe(2);
    expect(r.judgeJudge.byGrade.unknown?.n).toBe(1);
    expect(r.judgeAdjudicator).toMatchObject({ adjudicated: 2, abstained: 1 });
    expect(r.judgeAdjudicator.withA.k).toBe(1);
    expect(r.judgeAdjudicator.changedFromInitial.k).toBe(1);
    expect(r.statuses).toEqual({ agreed: 2, adjudicated: 1, abstained: 1, 'escalation-budget-exhausted': 1 });
    expect(r.judgeJudge.byTag.negation?.lowConfidence).toBe(false);
    expect(r.judgeJudge.byTag.chronology?.lowConfidence).toBe(true);
    expect(r.judgeAdjudicator.byTag.chronology?.adjudicated).toBe(2);
  });

  it('scores calibration items against their constructed labels, unknowns counted separately', () => {
    const items = (['A', 'C', 'D'] as const).map((n, i) => ({ id: `i${i}`, set: 'narrative-control', split: 'dev', tags: ['negation'], question: n === 'A' ? 'f1' : 'f2', questionVersion: 'q', rubricVersion: 'r', case: { ntsbNo: n, source: 'synthetic', fingerprint: 'f' }, label: 2, provenance: 'constructed', mutation: null, anchors: [], why: 'w' }) as CalibrationItem);
    const r = calibrationReport(items, records);
    expect(r.bySet['narrative-control/dev']).toMatchObject({ n: 2, unknown: 1 });
    expect(r.bySet['narrative-control/dev']?.accuracy.k).toBe(2);
    expect(r.missing).toEqual([]);
  });

  it('draws disjoint AI and owner audit samples by tag, label and agreement class, agreements included', () => {
    const many = [
      ...records,
      record('f1', 'F', 2, 2, 2, 'agreed'),
      record('f1', 'G', 2, 1, 2, 'adjudicated', adj(2, 2)),
      record('f1', 'H', 2, 1, 1, 'adjudicated', adj(1, 1)),
    ];
    const tagsOf = (f: string) => (f === 'f1' ? ['negation'] : ['chronology', 'paraphrase']);
    const s = auditSamples(many, tagsOf);
    const ids = (x: typeof s.ai) => x.rows.map((r) => r.ntsbNo);
    expect(new Set([...ids(s.ai), ...ids(s.owner)]).size).toBe(ids(s.ai).length + ids(s.owner).length);
    // Negation, label 2: two agreements (A, F) and one disagreement (G); each audit gets one agreement, the AI audit the disagreement.
    expect(s.ai.strata.find((x) => x.tag === 'negation' && x.label === '2' && x.agreement === 'agreed')).toMatchObject({ population: 2, sampled: 1 });
    expect(s.owner.strata.find((x) => x.tag === 'negation' && x.label === '2' && x.agreement === 'agreed')).toMatchObject({ population: 2, sampled: 1 });
    expect(s.ai.rows.map((r) => r.stratum.agreement)).toEqual(expect.arrayContaining(['agreed', 'disagreed', 'judge-missing']));
    // A pair of a two-tag family is sampled once, under its first stratum.
    expect(ids(s.ai).filter((n) => n === 'E')).toHaveLength(1);
    expect(s.ai.rows.find((r) => r.ntsbNo === 'E')?.stratum).toEqual({ tag: 'chronology', label: 'unknown', agreement: 'judge-missing' });
    expect(agreementClass(record('x', 'Y', 1, 1, 1, 'agreed'))).toBe('agreed');
    expect(s.ai.note).toMatch(/Not expert adjudication/);
    expect(auditSamples(many, tagsOf)).toEqual(s);
  });

  it('logs candidate code-narrative discrepancies without changing any label', () => {
    const d = dataset();
    const fam = d.questions.find((q) => q.relatedCodes !== undefined && q.paraphrase_of === undefined) as NarrativeItem;
    const coded = fam.relatedPositives[0] as string;
    const out = discrepancies(d, [record(fam.id, coded, 0, 0, 0, 'agreed'), record(fam.id, 'ZZZ00XX000', 2, 2, 2, 'agreed')]);
    expect(out).toEqual([
      { family: fam.id, ntsbNo: coded, kind: 'coded-not-relevant', label: 0 },
      { family: fam.id, ntsbNo: 'ZZZ00XX000', kind: 'relevant-not-coded', label: 2 },
    ]);
  });
});

describe('pool diagnostics', () => {
  const runs = [run('p50-kt', 1, ['A', 'B', 'C', 'D']), run('c200+n-kt', 1, ['B', 'E', 'F', 'A'])];
  const pool = assemblePool({ family: item(), members: [item()], runs, cohort: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], lure: [], rule: { ...RULE, depth: 4, tail: { nearFrom: 5, nearTo: 6, near: 0, far: 2 } } as never });
  const labels = new Map<string, Label>([['A', 2], ['B', 2], ['C', 0], ['E', 2], ['F', 1]]);

  it('tracks discovery by depth and method-exclusive relevant hits', () => {
    expect(discoveryByDepth(pool, labels, [1, 2, 4])).toEqual([
      { depth: 1, relevant: 2, added: 2 },
      { depth: 2, relevant: 3, added: 1 },
      { depth: 4, relevant: 3, added: 0 },
    ]);
    expect(methodExclusive(pool, labels, 4)).toEqual({ 'c200+n-kt': ['E'] });
  });

  it('estimates missed relevant cases from the tail samples, never guessing unknowns', () => {
    const far = tailEstimate(pool, new Map<string, Label>([...labels, [pool.tail.far[0] as string, 2]])).find((t) => t.stratum === 'far');
    expect(far?.sampled).toBe(2);
    expect(far?.unknown).toBe(1);
    expect(far?.relevant.k).toBe(1);
    expect(far?.estimatedMissed).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the dry run arithmetic', () => {
  it('estimates pools: exact bounded cohorts, phase A unions for broad questions', () => {
    const d = dataset();
    const e = poolEstimates(d, 3);
    const bounded = e.filter((x) => x.type === 'bounded-cohort');
    for (const b of bounded) expect(b.mean).toBe(d.questions.find((q) => q.id === b.family)?.cohort.size);
    const broad = e.find((x) => x.type === 'broad' && x.members === 1) as (typeof e)[number];
    expect(broad.mean).toBe(Math.round(PHASE_A_UNION[3].mean + POOL_RULE.hardNegatives + POOL_RULE.tail.near + POOL_RULE.tail.far + (d.questions.find((q) => q.id === broad.family)?.relatedPositives.length ?? 0) / 2));
    expect(poolEstimates(d, 1).reduce((n, x) => n + x.mean, 0)).toBeLessThan(e.reduce((n, x) => n + x.mean, 0));
  });

  it('prices calls with the cached prefix at the repository rates, with no override', () => {
    // Anthropic's pricing page (2026-10-23): Sonnet 5.5 cache reads $0.10 per million, 0.05 times input.
    expect(rates('claude-sonnet-5-5').cacheRead).toBeCloseTo(llmPrice('claude-sonnet-5-5').cacheRead / 1e6, 15);
    expect(llmPrice('claude-sonnet-5-5').cacheRead).toBeCloseTo(0.05 * llmPrice('claude-sonnet-5-5').input, 12);
    expect(callUsd('claude-haiku-5-5', 5_000, 2_000, 1_800)).toBeCloseTo((3_000 * 0.1 + 2_000 * 0.01 + 1_800 * 0.5) / 1e6, 12);
    const m: Measured = { ntsbNo: 'X', family: 'f', claude: [5_000], openai: [4_000], caseTokens: 3_000, chunks: 1, uncovered: false };
    const c = caseCost(m, { claude: 2_000, openai: 1_800 }, 900);
    const outA = EXPECTED_OUTPUT['judge-a'].visible + EXPECTED_OUTPUT['judge-a'].reasoning;
    expect(c.judgeA).toBeCloseTo(callUsd(JUDGE_A.model, 5_000, 2_000, outA), 12);
    expect(c.calls).toEqual({ judgeA: 1, judgeB: 1, adjudication: 2 });
    expect(c.worstJudges).toBeGreaterThan(c.judgeA + c.judgeB);
    const r = scaleRun([c], 100, 0.15);
    expect(r.usd.total).toBeCloseTo(100 * (1 + ASSUMPTIONS.invalidRetryShare) * (c.judgeA + c.judgeB + 0.15 * c.adjudication), 9);
    expect(r.totalAtBoundUsd).toBeGreaterThan(r.usd.total);
    expect(addRuns([r, r]).usd.total).toBeCloseTo(2 * r.usd.total, 9);
    expect(statsOf([3, 1, 2])).toEqual({ n: 3, mean: 2, p90: 3, max: 3 });
    expect([JUDGE_B.provider, ADJUDICATOR.model]).toEqual(['openai', 'claude-sonnet-5-5']);
  });
});

describe('the CLI', () => {
  it('refuses unknown commands and bad options before contacting anything', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      expect(await main([])).toBe(2);
      expect(await main(['launch'])).toBe(2);
      expect(await main(['plan', '--samples', '2'])).toBe(2);
      expect(await main(['judge', '--split', 'later'])).toBe(2);
      expect(await main(['report'])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors[0]).toBe(USAGE);
  });
});
