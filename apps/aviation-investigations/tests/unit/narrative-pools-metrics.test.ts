/**
 * Track N pools, metrics and the dry run's arithmetic: the pool rule (union of the
 * retrieval versions' first cases, bounded cohorts, related positives, hard negatives by
 * the lure's order, the mapping diagnostic, the seeded near and far tail), priorities and
 * bundle pairs, the retrieval versions' configuration identities and the frozen pool
 * identity; references with unknown grades kept in every denominator, supported P@6
 * bounds, kappa and Wilson intervals, discovery by depth, version-exclusive hits, the tail
 * estimate, the agreement and calibration figures and the discrepancy log; the
 * diagnostics (the regression's frozen rules, the mapping's natural and forced outcomes);
 * pool and cost estimates; and the CLI's usage errors (nothing contacted).
 */
import { describe, expect, it } from 'vitest';
import { main, USAGE } from '../../evals/retrieval/narrative/cli.js';
import type { CalibrationItem } from '../../evals/retrieval/narrative/calibration.js';
import { ADJUDICATOR, EXPECTED_OUTPUT, JUDGE_A, JUDGE_B } from '../../evals/retrieval/narrative/config.js';
import { llmPrice } from '../../server/ai/pricing.js';
import { NarrativeDatasetSchema, type NarrativeItem } from '../../evals/retrieval/narrative/dataset.js';
import type { PairRecord } from '../../evals/retrieval/narrative/judging.js';
import {
  ASSUMPTIONS,
  PRODUCTION_BUNDLE_PAIRS,
  PRODUCTION_MAPPING_DIAGNOSTIC,
  PRODUCTION_TOP20,
  PRODUCTION_UNION,
  addRuns,
  callUsd,
  canaryOf,
  poolCounts,
  poolSample,
  caseCost,
  fullEscalationUsd,
  measuredUsage,
  outputsFor,
  planInputs,
  poolEstimates,
  protocolArithmetic,
  rates,
  scaleRun,
  statsOf,
  type Measured,
} from '../../evals/retrieval/narrative/plan.js';
import { attemptReserveUsd } from '../../evals/retrieval/narrative/clients.js';
import {
  POOL_RULE,
  SCHEDULE,
  assemblePool,
  bundlePairs,
  casePriority,
  freezePools,
  frozenPoolsProblems,
  poolFileVersion,
  poolMethods,
  poolSummary,
  tierOf,
  verifyPoolFile,
  withFingerprints,
  type MappingDiagnosticRun,
  type PoolFile,
  type PoolRun,
} from '../../evals/retrieval/narrative/pool.js';
import { bundleKeyOf } from '../../evals/retrieval/narrative/judging.js';
import {
  agreementClass,
  agreementReport,
  auditSamples,
  calibrationReport,
  compareMethods,
  methodDifferences,
  type QuestionValue,
  cohenKappa,
  discoveryByDepth,
  discrepancies,
  familyReference,
  judgedCoverage,
  mappingDiagnosticReport,
  methodExclusive,
  ordinaryMapping,
  questionValues,
  regressionConclusion,
  regressionDiagnostic,
  scoreRuns,
  supportedAt6,
  tailEstimate,
  wilson,
} from '../../evals/retrieval/narrative/score.js';
import { codedReference, scoreQuestion } from '../../evals/retrieval/metrics.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Label } from '../../evals/retrieval/metrics.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const dataset = () => NarrativeDatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/dataset.json'), 'utf8')));

const RUBRIC = { relevant: 'All conditions are stated.', partial: 'Some conditions are stated.', notRelevant: 'No condition is stated.', edgeCases: [{ situation: 'Everything stated here.', grade: 2 as const, why: 'All.' }, { situation: 'Nothing stated here.', grade: 0 as const, why: 'None.' }, { situation: 'Half stated here.', grade: 1 as const, why: 'Some.' }] };
const item = (over: Partial<NarrativeItem> = {}): NarrativeItem => ({
  id: 'fam',
  question: 'Which accidents match?',
  role: 'benchmark',
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
const passageOf = (n: string, over: Partial<PoolRun['bundle'][number]['passages'][number]> = {}): PoolRun['bundle'][number]['passages'][number] => ({
  passageId: `p-${n}`,
  sectionId: `${n}:factual/aircraft-1`,
  revisionId: 'r',
  kind: 'factual',
  scope: 'aircraft',
  aircraftKey: 1,
  start: 0,
  end: 10,
  textSha256: `s-${n}`,
  role: 'retrieved',
  reserved: true,
  fusedRank: 1,
  ...over,
});
const run = (method: string, sample: number, ranking: string[], bundle: string[] = ranking.slice(0, 2), member = 'fam'): PoolRun => ({
  member,
  method,
  sample,
  ranking,
  bundle: bundle.map((n, i) => ({ ntsbNo: n, caseRank: i + 1, mapped: false, channels: { keyword: i + 1, vector: null, cases: null }, passages: [passageOf(n)] })),
  mapping: method === 'retrieval.v1' ? null : [],
});
/** A mapping diagnostic run: `cases` forced through the mapping, `delivered` packed with a mapped passage and the attached cause. */
const forced = (method: string, sample: number, cases: string[], delivered: string[] = cases, unmapped: string[] = []): MappingDiagnosticRun => ({
  member: 'fam',
  method,
  sample,
  cases: cases.map((n, i) => ({ ntsbNo: n, fusedRank: 50 + i, casesRank: 10 + i })),
  mapping: cases.map((n) => (unmapped.includes(n) ? { ntsbNo: n, status: 'unmapped', reason: 'no_passages', passagesUnderFilter: 0, returned: 0 } : { ntsbNo: n, status: 'mapped', reason: null, passagesUnderFilter: 5, returned: 5 })),
  bundle: delivered.map((n, i) => ({
    ntsbNo: n,
    caseRank: 50 + i,
    mapped: true,
    channels: { keyword: null, vector: null, cases: 10 + i },
    passages: [passageOf(n, { passageId: `m-${n}`, fusedRank: 400 + i }), passageOf(n, { passageId: `c-${n}`, kind: 'probable_cause', role: 'probable_cause', fusedRank: null })],
  })),
  skipped: unmapped.map((n, i) => ({ ntsbNo: n, caseRank: 60 + i, reason: 'no_retrieved_passage' as const })),
});
const RULE = { ...POOL_RULE, depth: 5, hardNegatives: 2, lureDepth: 50, tail: { nearFrom: 6, nearTo: 10, near: 2, far: 3 } };
const INPUTS = { version: 'i'.repeat(64), scope: { model: 'scope-model', promptVersion: 'scope.v2' }, embedding: { model: 'embedding-model', dims: 4, inputTemplate: 'query-v1' } };

describe('the pool rule', () => {
  const runs = [run('retrieval.v1', 1, COHORT.slice(0, 12)), run('retrieval.v2', 1, [...COHORT.slice(3, 8), ...COHORT.slice(20, 30)])];

  it('compares the production retrieval versions, each with its configuration identity', () => {
    expect([...POOL_RULE.methods]).toEqual(['retrieval.v1', 'retrieval.v2', 'retrieval.v2-nf']);
    expect(POOL_RULE.version).toBe('track-n-pool-v2');
    const methods = poolMethods();
    expect(methods.map((m) => [m.id, m.retrieval.version, m.config.version])).toEqual(POOL_RULE.methods.map((v) => [v, v, v]));
    for (const m of methods) expect(m.retrieval.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(methods.map((m) => m.retrieval.sha256)).size).toBe(3);
  });

  it('unions each version\'s first unique cases, adds lure hard negatives and a seeded near and far tail', () => {
    const p = assemblePool({ family: item(), members: [item()], runs, cohort: COHORT, lure: ['C001XX', 'C039XX', 'C038XX', 'C037XX'], rule: RULE as never });
    const methodCases = p.cases.filter((c) => c.sources.includes('method')).map((c) => c.ntsbNo);
    expect(methodCases).toEqual([...COHORT.slice(0, 8)]);
    expect(p.cases.find((c) => c.ntsbNo === 'C003XX')?.bestRank).toEqual({ 'retrieval.v1': 4, 'retrieval.v2': 1, 'retrieval.v2-nf': null });
    expect(p.cases.filter((c) => c.sources.includes('hard-negative')).map((c) => [c.ntsbNo, c.lureRank])).toEqual([
      ['C038XX', 3],
      ['C039XX', 2],
    ]);
    expect(p.tail.near).toHaveLength(2);
    expect(p.tail.far).toHaveLength(3);
    // Ranks 6 to 10 outside the pool: retrieval.v1's C008 and C009 (C005 to C007 are retrieval.v2's first five), retrieval.v2's C020 to C024.
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
    const body = { kind: 'track-n-pools' as const, rule: POOL_RULE, datasetSpecSha256: 'x', generationId: 1, target: {}, inputs: INPUTS, methods: [], families: [a] };
    expect(poolFileVersion(body)).not.toBe(poolFileVersion({ ...body, families: [b] }));
    // The inputs every version ran with are part of the identity.
    expect(poolFileVersion(body)).not.toBe(poolFileVersion({ ...body, inputs: { ...INPUTS, version: 'j'.repeat(64) } }));
  });

  it('recomputes every family version on load: a changed ranking, case or fingerprint is caught although the stored hashes are kept', () => {
    const rule = RULE as never;
    const a = withFingerprints(rule, assemblePool({ family: item(), members: [item()], runs, cohort: COHORT, lure: [], rule }), new Map([['C000XX', 'f0'], ['C001XX', 'f1']]));
    expect(a.fingerprints).toEqual({ C000XX: 'f0', C001XX: 'f1' });
    const body = { kind: 'track-n-pools' as const, rule, datasetSpecSha256: 'x', generationId: 1, target: {}, inputs: INPUTS, methods: [], families: [a] };
    const file = { ...body, version: poolFileVersion(body) } as PoolFile;
    expect(verifyPoolFile(file)).toEqual([]);
    const tamperedRun = { ...file, families: [{ ...a, runs: a.runs.map((r, i) => (i === 0 ? { ...r, ranking: [...r.ranking].reverse() } : r)) }] };
    expect(verifyPoolFile(tamperedRun)).toEqual([`family ${a.family}: its version does not match its content`]);
    const tamperedFingerprint = { ...file, families: [{ ...a, fingerprints: { ...a.fingerprints, C000XX: 'other' } }] };
    expect(verifyPoolFile(tamperedFingerprint)).toHaveLength(1);
    const tamperedVersion = { ...file, version: 'f'.repeat(64) };
    expect(verifyPoolFile(tamperedVersion)).toEqual(['the pool file version does not match its families']);
  });

  it('checks each retrieval version\'s recorded identity against its recorded configuration', () => {
    const methods = poolMethods();
    const body = { kind: 'track-n-pools' as const, rule: POOL_RULE, datasetSpecSha256: 'x', generationId: 1, target: {}, inputs: INPUTS, methods, families: [] };
    const file = { ...body, version: poolFileVersion(body) } as PoolFile;
    expect(verifyPoolFile(file)).toEqual([]);
    const edited = methods.map((m, i) => (i === 1 ? { ...m, config: { ...m.config, params: { ...m.config.params, perChannel: 199 } } } : m));
    const tampered = { ...body, methods: edited };
    expect(verifyPoolFile({ ...tampered, version: poolFileVersion(tampered) } as PoolFile)).toEqual(['method retrieval.v2: its configuration identity does not match its configuration']);
  });

  it('orders escalations: delivered, then the first 20, then bounded cohorts, then the rest; bundle pairs are distinct', () => {
    const base = { ntsbNo: 'X', sources: ['method' as const], lureRank: null, delivered: false };
    expect(SCHEDULE.version).toBe('track-n-schedule-v2');
    expect(casePriority({ ...base, bestRank: { a: 3 }, delivered: true }, 'broad')).toBe(3);
    expect(casePriority({ ...base, bestRank: { a: 15 } }, 'broad')).toBe(10_015);
    expect(casePriority({ ...base, bestRank: { a: 60 } }, 'bounded-cohort')).toBe(20_060);
    expect(casePriority({ ...base, bestRank: { a: 60 } }, 'broad')).toBe(30_060);
    expect(casePriority({ ...base, sources: ['hard-negative'], bestRank: { a: null }, lureRank: 4 }, 'broad')).toBe(40_004);
    const p = assemblePool({ family: item(), members: [item()], runs: [...runs, run('retrieval.v2', 2, COHORT.slice(0, 5))], cohort: COHORT, lure: [], rule: RULE as never });
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
      runs: [run('retrieval.v1', 1, cohort), run('retrieval.v1', 2, [...cohort].reverse())],
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

  const calItem = (n: string, question: string, split: 'dev' | 'holdout', label: 0 | 1 | 2, family = 'negation'): CalibrationItem =>
    ({ id: `i-${n.toLowerCase()}-${question}`, set: 'narrative-control', kind: 'relevance', bundle: null, split, tags: [family], question, questionVersion: 'q', rubricVersion: 'r', case: { ntsbNo: n, source: 'synthetic', fingerprint: 'f' }, label, provenance: 'constructed', mutation: null, anchors: [], why: 'w' }) as CalibrationItem;

  it('scores calibration as correct over expected: unknown and missing are wrong, conditional accuracy apart', () => {
    // One correct item and one with two unjudgeable judges (unknown): 1 of 2, not 100%.
    const items = [calItem('A', 'f1', 'dev', 2), calItem('E', 'f3', 'dev', 2), calItem('Z', 'f9', 'dev', 0)];
    const r = calibrationReport(items, records);
    const cell = r.cells['dev|narrative-control|negation'];
    expect(cell).toMatchObject({ expected: 3, recorded: 2, known: 1, correct: 1 });
    expect(cell?.accuracy.rate).toBeCloseTo(1 / 3, 12);
    expect(cell?.conditionalAccuracy.rate).toBe(1);
    expect(cell?.coverage.rate).toBeCloseTo(1 / 3, 12);
    // Judge A: valid on A (correct), unusable on E, no record for Z.
    expect(cell?.judgeA).toMatchObject({ valid: 1, correct: 1, failed: 1, missing: 1 });
    expect(cell?.judgeA.failureRate.rate).toBeCloseTo(2 / 3, 12);
    expect(cell?.confusion[0]).toEqual([0, 0, 0, 0, 1]);
    expect(r.verdict.status).toBe('not-run');
  });

  it('passes the frozen criteria only on a complete holdout that meets every threshold', () => {
    const fam = (family: string, n: number) => Array.from({ length: n }, (_, i) => calItem(`${family.slice(0, 3).toUpperCase()}${i}`, `q-${family}`, 'holdout', 2, family));
    const items = [...fam('negation', 8), ...fam('chronology', 8)];
    const agreed = (i: CalibrationItem, grade: 0 | 1 | 2) => ({ ...record(i.question, i.case.ntsbNo, grade, grade, grade, 'agreed') });
    // Every item judged correctly: pass.
    expect(calibrationReport(items, items.map((i) => agreed(i, 2))).verdict.status).toBe('pass');
    // One item without a record: incomplete, never pass.
    expect(calibrationReport(items, items.slice(1).map((i) => agreed(i, 2))).verdict.status).toBe('incomplete');
    // One stopped before its escalation: incomplete.
    const stopped = items.map((i, k) => (k === 0 ? { ...record(i.question, i.case.ntsbNo, 2, 1, 'unknown', 'escalation-budget-exhausted') } : agreed(i, 2)));
    expect(calibrationReport(items, stopped).verdict.status).toBe('incomplete');
    // Four wrong in one family: that family fails its floor (and the overall bound).
    const wrong = items.map((i, k) => agreed(i, k < 4 ? 0 : 2));
    const v = calibrationReport(items, wrong).verdict;
    expect(v.status).toBe('fail');
    expect(v.reasons.join(' ')).toMatch(/narrative-control\/negation: final labels accuracy/);
    // A family below the minimum size fails the criteria.
    expect(calibrationReport(fam('negation', 7), fam('negation', 7).map((i) => agreed(i, 2))).verdict.reasons.join(' ')).toMatch(/holdout items/);
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
    const out = discrepancies(d, [record(fam.id, coded, 0, 2, 0, 'adjudicated', adj(0, 0)), record(fam.id, 'ZZZ00XX000', 2, 1, 2, 'adjudicated', adj(2, 2))]);
    expect(out).toEqual([
      { family: fam.id, ntsbNo: coded, kind: 'coded-not-relevant', by: 'final', grade: 0 },
      { family: fam.id, ntsbNo: coded, kind: 'coded-not-relevant', by: 'judge-a', grade: 0 },
      { family: fam.id, ntsbNo: 'ZZZ00XX000', kind: 'relevant-not-coded', by: 'final', grade: 2 },
      { family: fam.id, ntsbNo: 'ZZZ00XX000', kind: 'relevant-not-coded', by: 'judge-a', grade: 2 },
    ]);
  });
});

describe('method comparisons', () => {
  const runAt = (method: string, sample: number, top: string[]): PoolRun => ({ ...run(method, sample, top, top), member: 'fam' });
  const poolOf = (runs: PoolRun[], cases: string[]) => assemblePool({ family: item(), members: [item()], runs, cohort: cases, lure: [], rule: { ...RULE, depth: 10, tail: { nearFrom: 11, nearTo: 12, near: 0, far: 0 } } as never });

  it('bounds the P@6 improvement jointly over shared unknowns, tighter than the endpoints', () => {
    // A and B deliver the same unknown case U plus one known case each; U cancels in the difference.
    const cases = ['K1', 'K2', 'U'];
    const pool = poolOf([runAt('a', 1, ['U', 'K1']), runAt('b', 1, ['U', 'K2'])], cases);
    const ref = familyReference({ ...pool, cohort: null }, new Map<string, Label>([['K1', 0], ['K2', 2]]));
    const values = questionValues(pool, scoreRuns(pool, ref, new Map()));
    const [d] = methodDifferences(pool, ref, new Map(), values, 'a', 'b', 'p6');
    expect(d).toMatchObject({ lower: 1 / 6, upper: 1 / 6, method: 'joint' });
    // The endpoints alone would give [b.lower - a.upper, b.upper - a.lower] = [0, 2/6].
    const va = values.find((v) => v.method === 'a')?.p6 as { lower: number; upper: number };
    const vb = values.find((v) => v.method === 'b')?.p6 as { lower: number; upper: number };
    expect([vb.lower - va.upper, vb.upper - va.lower]).toEqual([0, 2 / 6]);
  });

  it("uses cross-endpoint differences for nDCG@6: the gate's example A = [0.5, 1], B = [2/3, 1] gives [-1/3, 1/2]", () => {
    const pool = poolOf([runAt('a', 1, ['K1']), runAt('b', 1, ['K1'])], ['K1']);
    const ref = familyReference({ ...pool, cohort: null }, new Map<string, Label>([['K1', 2]]));
    const values: QuestionValue[] = [
      { member: 'fam', family: 'fam', method: 'a', recallGate: null, recallDiagnostic: null, p6: { lower: 0, upper: 0 }, ndcg6: { lower: 0.5, upper: 1 }, noPositivePossible: false, abstention: false, supported: { lower: 0, upper: 0 } },
      { member: 'fam', family: 'fam', method: 'b', recallGate: null, recallDiagnostic: null, p6: { lower: 0, upper: 0 }, ndcg6: { lower: 2 / 3, upper: 1 }, noPositivePossible: false, abstention: false, supported: { lower: 0, upper: 0 } },
    ];
    const [d] = methodDifferences(pool, ref, new Map(), values, 'a', 'b', 'ndcg6');
    expect(d?.lower).toBeCloseTo(-1 / 3, 12);
    expect(d?.upper).toBeCloseTo(1 / 2, 12);
    expect(d?.method).toBe('cross-endpoint');
  });

  it('bounds supported P@6 jointly over relevance and each bundle\'s answerability', () => {
    // Same relevant case K delivered by both methods with different passages: only the bundles' answerability differs.
    const a = runAt('a', 1, ['K']);
    const b = { ...runAt('b', 1, ['K']), bundle: [{ ...(runAt('b', 1, ['K']).bundle[0] as PoolRun['bundle'][number]), passages: [passageOf('K', { passageId: 'p-other', start: 20, end: 30, textSha256: 's-other' })] }] };
    const pool = poolOf([a, b], ['K']);
    const ref = familyReference({ ...pool, cohort: null }, new Map<string, Label>([['K', 2]]));
    const keyA = bundleKeyOf(a.bundle[0]?.passages ?? []);
    const values = questionValues(pool, scoreRuns(pool, ref, new Map()));
    // A's bundle is known answerable, B's unknown: the improvement lies in [-1/6, 0].
    const [d] = methodDifferences(pool, ref, new Map([[`K|${keyA}`, 2]]), values, 'a', 'b', 'supported');
    expect(d?.lower).toBeCloseTo(-1 / 6, 12);
    expect(d?.upper).toBeCloseTo(0, 12);
  });

  it('declares a winner only when the bootstrapped interval of the improvement bounds clears zero', () => {
    const boot = { resamples: 500, seed: 1 };
    const sure = Array.from({ length: 8 }, (_, i) => ({ member: `m${i}`, family: `f${i}`, lower: 0.1, upper: 0.3, method: 'joint' as const }));
    expect(compareMethods(sure, (m) => m, boot).conclusion).toBe('b-better');
    const open = sure.map((d) => ({ ...d, lower: -0.1 }));
    expect(compareMethods(open, (m) => m, boot).conclusion).toBe('inconclusive');
    const worse = sure.map((d) => ({ ...d, lower: -0.3, upper: -0.1 }));
    expect(compareMethods(worse, (m) => m, boot).conclusion).toBe('a-better');
  });
});

describe('pool diagnostics', () => {
  const runs = [run('retrieval.v1', 1, ['A', 'B', 'C', 'D']), run('retrieval.v2', 1, ['B', 'E', 'F', 'A'])];
  const pool = assemblePool({ family: item(), members: [item()], runs, cohort: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], lure: [], rule: { ...RULE, depth: 4, tail: { nearFrom: 5, nearTo: 6, near: 0, far: 2 } } as never });
  const labels = new Map<string, Label>([['A', 2], ['B', 2], ['C', 0], ['E', 2], ['F', 1]]);

  it('tracks discovery by depth and method-exclusive relevant hits', () => {
    expect(discoveryByDepth(pool, labels, [1, 2, 4])).toEqual([
      { depth: 1, relevant: 2, added: 2 },
      { depth: 2, relevant: 3, added: 1 },
      { depth: 4, relevant: 3, added: 0 },
    ]);
    expect(methodExclusive(pool, labels, 4)).toEqual({ 'retrieval.v2': ['E'] });
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

describe('the mapping diagnostic in the pool', () => {
  const runs = [run('retrieval.v1', 1, COHORT.slice(0, 6)), run('retrieval.v2', 1, COHORT.slice(0, 6))];
  const mapping = [forced('retrieval.v2', 1, ['C030XX', 'C031XX'], ['C030XX'], ['C031XX']), forced('retrieval.v2-nf', 1, ['C030XX', 'C032XX'])];
  const p = assemblePool({ family: item(), members: [item()], runs, mapping, cohort: COHORT, lure: [], rule: RULE as never });

  it('adds its delivered cases to the pool, never to the tail, judged in the first tier', () => {
    const diag = p.cases.filter((c) => c.sources.includes('mapping-diagnostic')).map((c) => c.ntsbNo);
    expect(diag).toEqual(['C030XX', 'C032XX']);
    // An unmapped case was not delivered, so it is not pooled by the diagnostic.
    expect(p.cases.some((c) => c.ntsbNo === 'C031XX' && c.sources.includes('mapping-diagnostic'))).toBe(false);
    for (const n of diag) {
      expect([...p.tail.near, ...p.tail.far]).not.toContain(n);
      const c = p.cases.find((x) => x.ntsbNo === n);
      expect(tierOf(casePriority(c as never, 'broad'))).toBe(0);
    }
    expect(p.mappingDiagnostic.map((r) => r.method)).toEqual(['retrieval.v2', 'retrieval.v2-nf']);
  });

  it('versions the pool with its runs, and pairs its bundles for answerability apart from the retrieval runs\' ', () => {
    const without = assemblePool({ family: item(), members: [item()], runs, mapping: mapping.slice(0, 1), cohort: COHORT, lure: [], rule: RULE as never });
    expect(without.version).not.toBe(p.version);
    const pairs = bundlePairs(p);
    const c030 = pairs.find((x) => x.ntsbNo === 'C030XX');
    expect(c030?.runs.map((r) => r.source)).toEqual(['mapping-diagnostic', 'mapping-diagnostic']);
    expect(pairs.filter((x) => x.runs.every((r) => r.source === 'run')).map((x) => x.ntsbNo)).toEqual(['C000XX', 'C001XX']);
  });

  it('summarises each version\'s cases and mapping, natural and forced', () => {
    const natural = { ...run('retrieval.v2', 2, COHORT.slice(0, 6)), mapping: [{ ntsbNo: 'C005XX', status: 'mapped' as const, reason: null, passagesUnderFilter: 3, returned: 3 }, { ntsbNo: 'C039XX', status: 'unmapped' as const, reason: 'too_many_passages' as const, passagesUnderFilter: 1_200, returned: 0 }] };
    const q = assemblePool({ family: item(), members: [item()], runs: [...runs, natural], mapping, cohort: COHORT, lure: [], rule: RULE as never });
    const sum = poolSummary({ rule: POOL_RULE, families: [q] }, new Map([['fam', 'benchmark']]));
    const f = sum.families[0] as (typeof sum.families)[number];
    expect(f.versions['retrieval.v1']).toEqual({ cases: 5, delivered: 2, runs: 1, runsWithMapping: 0, mapped: 0, unmapped: 0 });
    expect(f.versions['retrieval.v2']).toMatchObject({ runs: 2, runsWithMapping: 1, mapped: 1, unmapped: 1 });
    expect(f.mappingDiagnostic).toEqual({ forced: 3, mapped: 2, delivered: 2 });
    expect(f.stage1).toBe(q.cases.filter((c) => tierOf(casePriority(c, 'broad')) <= 2).length);
    expect(sum.total.benchmarkCases).toBe(q.cases.length);
    expect(ordinaryMapping([q])['retrieval.v2']).toEqual({ runs: 2, runsWithMapping: 1, mapped: 1, unmapped: { too_many_passages: 1 }, deliveredMapped: 0, questions: ['fam'] });
    expect(ordinaryMapping([q])['retrieval.v1']).toMatchObject({ runs: 1, runsWithMapping: 0 });
  });
});

describe('the frozen pool identity', () => {
  const pool = assemblePool({ family: item(), members: [item()], runs: [run('retrieval.v1', 1, COHORT.slice(0, 4))], cohort: COHORT, lure: [], rule: RULE as never });
  const body = { kind: 'track-n-pools' as const, rule: POOL_RULE, datasetSpecSha256: 'x', generationId: 1, target: {}, inputs: INPUTS, methods: poolMethods(), families: [pool] };
  const file = { ...body, version: poolFileVersion(body) } as PoolFile;

  it('is recorded once, accepted again unchanged, and another identity is refused', () => {
    const frozen = join(mkdtempSync(join(tmpdir(), 'track-n-frozen-')), 'frozen-pools.json');
    expect(freezePools(frozen, file, new Date('2026-10-23T12:00:00Z'))).toBe('recorded');
    const record = JSON.parse(readFileSync(frozen, 'utf8'));
    expect(record).toMatchObject({ kind: 'track-n-frozen-pools', poolVersion: file.version, rule: 'track-n-pool-v2', schedule: 'track-n-schedule-v2', inputsVersion: INPUTS.version, families: { fam: pool.version } });
    expect(Object.keys(record.retrieval)).toEqual(['retrieval.v1', 'retrieval.v2', 'retrieval.v2-nf']);
    expect(freezePools(frozen, file)).toBe('unchanged');
    const other = { ...file, version: 'e'.repeat(64) };
    expect(() => freezePools(frozen, other)).toThrow(/differs from the frozen one/);
    expect(JSON.parse(readFileSync(frozen, 'utf8')).poolVersion).toBe(file.version);
  });

  it('lets judging proceed only on the frozen identity, committed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'track-n-frozen-'));
    const frozen = join(dir, 'frozen-pools.json');
    expect(frozenPoolsProblems(frozen, file, () => true)[0]).toMatch(/no pool identity is frozen/);
    freezePools(frozen, file);
    expect(frozenPoolsProblems(frozen, file, () => true)).toEqual([]);
    expect(frozenPoolsProblems(frozen, { version: 'e'.repeat(64) }, () => true)[0]).toMatch(/is not the frozen pool identity/);
    expect(frozenPoolsProblems(frozen, file, () => false)[0]).toMatch(/is not committed/);
  });
});

describe('the diagnostics', () => {
  const d = dataset();
  const diag = d.questions.find((q) => q.role === 'diagnostic') as NarrativeItem;
  const R = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
  const X = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'];
  const labels = new Map<string, Label>([...R.map((n) => [n, 2] as const), ...X.map((n) => [n, 0] as const)]);
  const member = diag.id;
  const pool = (variantBundle: string[]) =>
    assemblePool({
      family: { ...diag, relatedPositives: ['R1', 'R2', 'R3', 'R4'] },
      members: [diag],
      runs: [1, 2].flatMap((sample) => [
        run('retrieval.v1', sample, [...R.slice(0, 4), 'X1', 'X2', ...R.slice(4), ...X.slice(2)], [...R.slice(0, 4), 'X1', 'X2'], member),
        run('retrieval.v2', sample, [...variantBundle, ...R, ...X].filter((n, i, a) => a.indexOf(n) === i), variantBundle, member),
        run('retrieval.v2-nf', sample, [...variantBundle, ...R, ...X].filter((n, i, a) => a.indexOf(n) === i), variantBundle, member),
      ]),
      cohort: [...R, ...X],
      lure: [],
    });

  it('concludes on the primary metric only: regression when the upper bound is below zero', () => {
    expect(regressionConclusion({ lower: -0.4, upper: -0.01 })).toBe('regression');
    expect(regressionConclusion({ lower: 0, upper: 0.2 })).toBe('no-regression');
    expect(regressionConclusion({ lower: -0.1, upper: 0.1 })).toBe('inconclusive');
    expect(regressionConclusion(null)).toBe('inconclusive');
  });

  it('applies the frozen comparison to the regression question, with the displaced and admitted cases and the coded reproduction', () => {
    const p = pool(['X1', 'X2', 'X3', 'R1', 'X4', 'X5']);
    const family = { ...diag, relatedPositives: ['R1', 'R2', 'R3', 'R4'] };
    const coded = scoreQuestion(p.runs[0]?.ranking ?? [], (p.runs[0]?.bundle ?? []).map((b) => b.ntsbNo), codedReference(family.relatedPositives)).ndcg.bounds?.lower as number;
    const def = family.diagnostic as NonNullable<NarrativeItem['diagnostic']>;
    const expected = { 'retrieval.v1': coded, 'retrieval.v2': 0.25, 'retrieval.v2-nf': 0.25 };
    const rep = regressionDiagnostic(p, { ...family, diagnostic: { ...def, comparison: { ...def.comparison, reproduction: { ...def.comparison.reproduction, expected } } } }, labels, new Map());
    expect(rep.comparison.base).toBe('retrieval.v1');
    expect(rep.comparisons['retrieval.v2']?.conclusion).toBe('regression');
    expect(rep.comparisons['retrieval.v2-nf']?.conclusion).toBe('regression');
    expect(Object.keys(rep.comparisons['retrieval.v2']?.metrics ?? {})).toEqual(['ndcg6', 'p6', 'supported']);
    expect(rep.methods['retrieval.v1']?.p6).toEqual({ lower: 4 / 6, upper: 4 / 6 });
    expect(rep.reproduction.observed['retrieval.v1']).toBeCloseTo(coded, 12);
    // retrieval.v2's coded value is not 0.25 here: not reproduced.
    expect(rep.reproduction.reproduced).toBe(false);
    expect(rep.perSample.map((s) => s.sample)).toEqual([1, 2]);
    const s1 = rep.perSample[0] as (typeof rep.perSample)[number];
    expect(s1.displaced['retrieval.v2']?.map((b) => [b.ntsbNo, b.label, b.coded])).toEqual([
      ['R2', 2, true],
      ['R3', 2, true],
      ['R4', 2, true],
    ]);
    expect(s1.admitted['retrieval.v2']?.map((b) => b.ntsbNo)).toEqual(['X3', 'X4', 'X5']);
    // The same bundles: no regression on these labels, and the coded values reproduce.
    const same = pool([...R.slice(0, 4), 'X1', 'X2']);
    const repSame = regressionDiagnostic(same, { ...family, diagnostic: { ...def, comparison: { ...def.comparison, reproduction: { ...def.comparison.reproduction, expected: { 'retrieval.v1': coded, 'retrieval.v2': coded, 'retrieval.v2-nf': coded } } } } }, labels, new Map());
    expect(repSame.comparisons['retrieval.v2']?.conclusion).toBe('no-regression');
    expect(repSame.reproduction.reproduced).toBe(true);
  });

  it('keeps unknown labels as bounds: an unjudged admitted case leaves the conclusion open', () => {
    const p = pool(['R1', 'R2', 'R3', 'U1', 'X1', 'X2']);
    const rep = regressionDiagnostic(p, { ...diag, relatedPositives: [] }, labels, new Map());
    const m = rep.comparisons['retrieval.v2']?.metrics.ndcg6;
    expect(m?.method).toBe('cross-endpoint');
    expect(rep.comparisons['retrieval.v2']?.conclusion).toBe('inconclusive');
  });

  it('reports the forced mapping: outcomes, relevance by answerability, and whether a supported bundle rests on a mapped passage', () => {
    const mapping = [forced('retrieval.v2', 1, ['M1', 'M2', 'M3'], ['M1', 'M2'], ['M3']), forced('retrieval.v2-nf', 1, ['M1', 'M4'])];
    const p = { family: 'fam', mappingDiagnostic: mapping };
    const key = (n: string) => `m-${n}:s-${n},c-${n}:s-${n}`;
    const rel = new Map([['fam', new Map<string, Label>([['M1', 2], ['M2', 2], ['M4', 0]])]]);
    const ans = new Map([['fam', new Map<string, Label>([[`M1|${key('M1')}`, 2], [`M2|${key('M2')}`, 0], [`M4|${key('M4')}`, 0]])]]);
    const verdict = (passageId: string) => ({ grade: 2, evidence: [{ source: 'P1', kind: 'passage', quote: 'x', passageId }], absent: false, absentWhat: null, rationale: 'r' });
    const records = [
      { kind: 'answerability', family: 'fam', ntsbNo: 'M1', bundleKey: key('M1'), adjudication: null, verdicts: [{ role: 'judge-a', verdict: verdict('m-M1') }, { role: 'judge-b', verdict: verdict('c-M1') }] },
    ] as never[];
    const r = mappingDiagnosticReport([p], rel, ans, records);
    expect(r).toMatchObject({ runs: 2, forced: 4, mapped: 3, unmapped: { no_passages: 1 }, delivered: 3 });
    expect(r.relevance).toEqual({ '2': 2, '1': 0, '0': 1, unknown: 0 });
    expect(r.crossTab).toEqual({ '2': { '2': 1, '0': 1 }, '0': { '0': 1 } });
    expect(r.supportedAmongRelevant).toMatchObject({ k: 1, n: 2, unknown: 0 });
    expect(r.restsOnMappedPassage).toEqual({ answerable: 1, mappedPassage: 1, causeOnly: 0, unread: 0 });
    const causeOnly = [{ ...(records[0] as unknown as object), verdicts: [{ role: 'judge-a', verdict: verdict('c-M1') }, { role: 'judge-b', verdict: verdict('c-M1') }] }] as never[];
    expect(mappingDiagnosticReport([p], rel, ans, causeOnly).restsOnMappedPassage).toEqual({ answerable: 1, mappedPassage: 0, causeOnly: 1, unread: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('the dry run arithmetic', () => {
  it('estimates pools: exact bounded cohorts, the production retrievers\' unions for broad questions, the mapping diagnostic in stage 1', () => {
    const d = dataset();
    const e = poolEstimates(d, 3);
    const bounded = e.filter((x) => x.type === 'bounded-cohort');
    for (const b of bounded) expect(b.mean).toBe(d.questions.find((q) => q.id === b.family)?.cohort.size);
    const broad = e.find((x) => x.type === 'broad' && x.members === 1 && x.role === 'benchmark') as (typeof e)[number];
    const m = PRODUCTION_MAPPING_DIAGNOSTIC[3];
    expect(broad.mean).toBe(Math.round(PRODUCTION_UNION[3].mean + POOL_RULE.hardNegatives + POOL_RULE.tail.near + POOL_RULE.tail.far + (d.questions.find((q) => q.id === broad.family)?.relatedPositives.length ?? 0) / 2 + m.newCases.mean));
    expect(broad.stage1.mean).toBe(Math.round(PRODUCTION_TOP20[3].mean + m.delivered.mean));
    expect(broad.mappingDiagnostic).toEqual({ mean: m.delivered.mean, max: m.delivered.max });
    expect(broad.answerabilityPairs.mean).toBeCloseTo(PRODUCTION_BUNDLE_PAIRS[3].mean + m.delivered.mean, 10);
    expect(poolEstimates(d, 1).reduce((n, x) => n + x.mean, 0)).toBeLessThan(e.reduce((n, x) => n + x.mean, 0));
    // The regression diagnostic runs with its frozen scope output, one distinct keyword text: the one-sample figures, whatever the plan's samples.
    const diag = e.find((x) => x.role === 'diagnostic') as (typeof e)[number];
    expect(diag.family).toBe('per-pilot-decision-cause-weight-shift');
    expect(diag).toEqual(poolEstimates(d, 1).find((x) => x.role === 'diagnostic'));
    expect(diag.mappingDiagnostic.mean).toBe(PRODUCTION_MAPPING_DIAGNOSTIC[1].delivered.mean);
  });

  it('re-plans from a built pool: its exact pairs per family, and its own cases to measure', () => {
    const d = dataset();
    const fam = d.questions.find((q) => q.type === 'broad' && q.role === 'benchmark') as NarrativeItem;
    const runs = [run('retrieval.v1', 1, COHORT.slice(0, 30), COHORT.slice(0, 6), fam.id), run('retrieval.v2', 1, COHORT.slice(5, 35), COHORT.slice(5, 11), fam.id)];
    const mapping = [{ ...forced('retrieval.v2', 1, ['C036XX', 'C037XX']), member: fam.id }];
    const pool = assemblePool({ family: fam, members: [fam], runs, mapping, cohort: COHORT, lure: [], rule: RULE as never });
    const [counts] = poolCounts({ families: [pool] }, d);
    expect(counts).toMatchObject({ family: fam.id, role: 'benchmark', type: 'broad', members: 1, mean: pool.cases.length, max: pool.cases.length });
    expect(counts?.stage1.mean).toBe(pool.cases.filter((c) => tierOf(casePriority(c, 'broad')) <= SCHEDULE.stages[1]).length);
    expect(counts?.answerabilityPairs.mean).toBe(bundlePairs(pool).length);
    // The mapping diagnostic's own bundles: two cases no retrieval run delivered.
    expect(counts?.mappingDiagnostic.mean).toBe(2);
    const sample = poolSample(pool, { stage1: 4, rest: 3 });
    expect(sample).toHaveLength(7);
    expect(new Set(sample.map((x) => x.ntsbNo)).size).toBe(7);
    expect(sample.every((x) => x.origin === 'pool' && x.family === fam.id)).toBe(true);
    const tierOfCase = (n: string) => tierOf(casePriority(pool.cases.find((c) => c.ntsbNo === n) as never, 'broad'));
    expect(sample.slice(0, 4).every((x) => tierOfCase(x.ntsbNo) <= 2)).toBe(true);
    expect(sample.slice(4).every((x) => tierOfCase(x.ntsbNo) > 2)).toBe(true);
    expect(poolSample(pool, { stage1: 4, rest: 3 })).toEqual(sample);
  });

  it("splits each family's pairs into the schedule's stage 1 and the rest, and reproduces the protocol's own estimate", () => {
    const d = dataset();
    for (const e of poolEstimates(d, 3)) {
      if (e.type === 'bounded-cohort') expect(e.stage1).toEqual({ mean: e.mean, max: e.max });
      else {
        expect(e.stage1.mean).toBeGreaterThan(0);
        expect(e.stage1.mean).toBeLessThan(e.mean);
      }
    }
    // Section 7 of the protocol: 2,500 pairs, 2,000 input and 200 output tokens, 15% to one Sonnet call: about $4.60.
    expect(protocolArithmetic().usd.total).toBeCloseTo(4.6, 6);
    expect(outputsFor('input')).toMatchObject({ a: 0, b: 0 });
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

  it('takes measured output tokens and disagreement in place of the assumptions (review N13)', () => {
    const attempt = (role: string, outputTokens: number) => ({ purpose: 'relevance', role, provider: 'p', model: 'm', status: 'ok', category: null, billing: 'usage', inputTokens: 1, reservedUsd: 0, chargedUsd: 0, usage: { inputTokens: 1, outputTokens, cacheWriteTokens: 0, cacheReadTokens: 0 }, latencyMs: 1 });
    const judges = (failed = false) => [{ status: 'valid' }, { status: failed ? 'failed' : 'valid' }];
    const records = [
      { judges: judges(), adjudication: null, status: 'agreed', attempts: [attempt('judge-a', 900), attempt('judge-b', 2_100)] },
      { judges: judges(), adjudication: {}, status: 'adjudicated', attempts: [attempt('judge-a', 1_100), attempt('judge-b', 1_900), attempt('adjudicator', 500)] },
      { judges: judges(), adjudication: null, status: 'escalation-budget-exhausted', attempts: [] },
      { judges: judges(true), adjudication: null, status: 'incomplete', attempts: [] },
    ] as never[];
    const m = measuredUsage(records);
    expect(m.pairs).toBe(3);
    expect(m.outputTokens).toEqual({ a: 1_000, b: 2_000, adj: 500 });
    expect(m.calls).toEqual({ a: 2, b: 2, adj: 1 });
    expect(m.disagreement).toBeCloseTo(2 / 3, 12);
    const measured = planInputs(m);
    expect(measured.outputs).toEqual({ a: 1_000, b: 2_000, adj: 500 });
    expect(measured.calibrationDisagreement).toBeCloseTo(2 / 3, 12);
    // A measured disagreement stands in for the pool escalation share, within the bound.
    expect(measured.escalation).toBe(ASSUMPTIONS.escalationBound);
    expect(measured.source).toEqual({ outputs: 'measured', escalation: 'measured' });
    const given = planInputs(m, { outputTokens: { a: 700, b: 800 }, disagreement: 0.1 });
    expect(given.outputs).toMatchObject({ a: 700, b: 800 });
    expect(given.escalation).toBe(0.1);
    expect(given.source).toEqual({ outputs: 'given', escalation: 'given' });
    expect(planInputs(null)).toMatchObject({ escalation: ASSUMPTIONS.escalationExpected, calibrationDisagreement: ASSUMPTIONS.calibrationDisagreement, source: { outputs: 'assumed', escalation: 'assumed' } });
    expect(outputsFor('visible', measured.outputs)).toMatchObject({ a: EXPECTED_OUTPUT['judge-a'].visible, b: EXPECTED_OUTPUT['judge-b'].visible });
  });

  it('picks the canary as the judge orders the dev items, and sizes its limit for one full escalation at its caps (review N9)', () => {
    const items = [
      { split: 'holdout', question: 'a', case: { ntsbNo: 'AAA00LA000' }, bundle: null },
      { split: 'dev', question: 'b', case: { ntsbNo: 'CEN19LA911' }, bundle: null },
      { split: 'dev', question: 'a', case: { ntsbNo: 'CEN19LA911' }, bundle: null },
      { split: 'dev', question: 'a', case: { ntsbNo: 'ERA15LA961' }, bundle: null },
    ];
    expect(canaryOf(items)).toBe(items[2]);
    const m: Measured = { ntsbNo: 'X', family: 'f', claude: [5_000], openai: [4_000], caseTokens: 3_000, chunks: 1, uncovered: false };
    const c = caseCost(m, { claude: 2_000, openai: 1_800 }, 900);
    expect(fullEscalationUsd(c)).toBeCloseTo(attemptReserveUsd(JUDGE_A, 5_000) + attemptReserveUsd(JUDGE_B, 4_000) + attemptReserveUsd(ADJUDICATOR, 5_000) + attemptReserveUsd(ADJUDICATOR, 5_900), 12);
  });
});

describe('the CLI', () => {
  it('refuses unknown commands and bad options before contacting anything', async () => {
    const errors0: string[] = [];
    const original0 = console.error;
    console.error = (m: string) => errors0.push(m);
    try {
      // Saved inputs pay nothing: no --confirm-cost, no --vectors.
      expect(await main(['pools', '--inputs', 'inputs.json', '--confirm-cost'])).toBe(2);
      expect(await main(['pools', '--inputs', 'inputs.json', '--vectors', 'vectors.json'])).toBe(2);
    } finally {
      console.error = original0;
    }
    expect(errors0[0]).toMatch(/pays nothing/);
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      expect(await main([])).toBe(2);
      expect(await main(['launch'])).toBe(2);
      expect(await main(['plan', '--samples', '2'])).toBe(2);
      expect(await main(['judge', '--split', 'later'])).toBe(2);
      // Calibration runs one split at a time: never dev and holdout together (review N11).
      expect(await main(['judge', '--set', 'calibration', '--split', 'all'])).toBe(2);
      expect(await main(['plan', '--disagreement', '1.5'])).toBe(2);
      expect(await main(['plan', '--output-tokens', '900'])).toBe(2);
      // Recovery names the allocation and the run that holds its lock.
      expect(await main(['recover', '--allocation', 'track-n-2026-10'])).toBe(2);
      expect(await main(['recover', '--run', 'eval-10c2-relevance-20261023T000000Z'])).toBe(2);
      expect(await main(['report'])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors[0]).toBe(USAGE);
  });
});
