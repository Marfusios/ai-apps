/**
 * The task 10e validation runner (evals/retrieval/adoption): the cached scope outputs as
 * the pipeline uses them, the arms through production code, the scores, delivered
 * evidence, the regression case, and the load harness's pieces. No network.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { RETRIEVAL_V1, RETRIEVAL_V2 } from '../../server/search/retrieval-config.js';
import { MAX_SPEND_USD, loadScopeUses } from '../../evals/retrieval/adoption/cli.js';
import { delayedEmbedder, failingClient, percentiles, summarizeLoad, type LoadSample } from '../../evals/retrieval/adoption/load.js';
import {
  ARMS,
  COMPARISON,
  REGRESSION_CASES,
  armScores,
  deliveredEvidence,
  pairedArms,
  pipelineIntent,
  provenanceOf,
  questionChanges,
  regressionRuns,
  runArm,
  runKey,
  type AdoptionRun,
  type Arm,
  type DeliveredCase,
} from '../../evals/retrieval/adoption/validate.js';
import { codedReference, scoreQuestion } from '../../evals/retrieval/metrics.js';
import type { ExperimentItem } from '../../evals/retrieval/experiments/experiment.js';
import { questionSha } from '../../evals/retrieval/experiments/scope.js';
import { CASES_INDEX_VERSION, casesIndexFingerprint } from '../../worker/index/cases-index.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { PASSAGES_V2_CONTRACT } from '../../server/search/passages-contract.js';
import { DEFAULT_CODED_DATASET } from '../../evals/retrieval/coded/build-coded.js';
import { parseCodedDataset } from '../../evals/retrieval/coded/run.js';
import { readFileSync } from 'node:fs';
import { casePassages, createFakeEs } from '../support/fake-es.js';

const item = (id: string, cls: 'narrow' | 'broad', relevant: string[], group = 'g1'): ExperimentItem => ({
  id,
  split: 'dev',
  group,
  class: cls,
  area: 'occurrence',
  paraphraseOf: null,
  question: `question ${id}`,
  filters: {},
  relevant,
});

describe('the cached scope outputs, as the pipeline uses them', () => {
  it('resolves keyword text and filters exactly as a new brief does', () => {
    expect(pipelineIntent('Which accidents in Michigan?', { intent: 'case_search', plannerKeywordText: 'carburetor icing', plannerFilters: { state: ['MI'], yearFrom: 2010 } })).toEqual({
      intent: 'case_search',
      keywordText: 'carburetor icing',
      filters: { state: ['MI'], yearFrom: 2010 },
    });
    // No keyword text from the planner: the question; values outside the vocabularies dropped.
    expect(pipelineIntent('Which helicopter accidents?', { intent: 'case_search', plannerKeywordText: '', plannerFilters: { category: ['HELI'], phase: ['landing'] } })).toMatchObject({
      keywordText: 'Which helicopter accidents?',
      filters: { phase: ['landing'], category: ['HELI'] },
    });
  });

  it('accepts only phase A’s development file of the frozen grid, sample by sample', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adoption-scope-'));
    const q = item('q-one', 'narrow', ['A1']);
    const sample = (n: number, over: Record<string, unknown> = {}) => ({
      id: q.id,
      questionSha256: questionSha(q.question),
      sample: n,
      status: 'ok',
      intent: 'case_search',
      plannerKeywordText: 'midair collision',
      keywordText: 'midair collision',
      plannerFilters: { state: ['NV'] },
      attempts: [],
      ...over,
    });
    const write = (body: unknown) => {
      const f = join(dir, `${Math.random()}.json`);
      writeFileSync(f, JSON.stringify(body));
      return f;
    };
    const file = (samples: unknown[], over: Record<string, unknown> = {}) => write({ kind: 'eval-retrieval-experiments-scope', split: 'dev', gridSha256: 'g', run: { samples }, ...over });
    const uses = loadScopeUses(file([sample(1), sample(2), sample(3)]), 'g', [q], 3);
    expect(uses.get(q.id)).toEqual([1, 2, 3].map((s) => ({ sample: s, intent: 'case_search', keywordText: 'midair collision', inferredFilters: { state: ['NV'] }, plannerFilters: { state: ['NV'] } })));
    expect(() => loadScopeUses(file([sample(1), sample(2), sample(3)], { split: 'holdout' }), 'g', [q], 3)).toThrow(/development file/);
    expect(() => loadScopeUses(file([sample(1), sample(2), sample(3)]), 'other', [q], 3)).toThrow(/development file/);
    expect(() => loadScopeUses(file([sample(1), sample(2)]), 'g', [q], 3)).toThrow(/2 scope samples/);
    expect(() => loadScopeUses(file([sample(1), sample(2), sample(3, { status: 'failed' })]), 'g', [q], 3)).toThrow(/failed/);
    expect(() => loadScopeUses(file([sample(1), sample(2), sample(3, { questionSha256: 'x' })]), 'g', [q], 3)).toThrow(/another question/);
    expect(() => loadScopeUses(file([sample(1), sample(2), sample(3, { keywordText: 'else' })]), 'g', [q], 3)).toThrow(/does not resolve/);
  });
});

describe('arms and regression cases', () => {
  it('compares the deployed behaviour with retrieval.v2, NF for reference', () => {
    expect(ARMS['p50-kt']).toBe(RETRIEVAL_V1);
    expect(ARMS.N).toBe(RETRIEVAL_V2);
    expect(COMPARISON).toEqual({ base: 'p50-kt', variant: 'N' });
    expect(MAX_SPEND_USD).toBe(0.1);
  });

  it('keeps the weight-shift pilot-decision question as a regression case, a development question', () => {
    expect(REGRESSION_CASES.map((r) => r.id)).toEqual(['per-pilot-decision-cause-weight-shift']);
    const parsed = parseCodedDataset(readFileSync(DEFAULT_CODED_DATASET, 'utf8'));
    if ('issues' in parsed) throw new Error('dataset');
    expect(parsed.dataset.questions.find((q) => q.id === 'per-pilot-decision-cause-weight-shift')).toMatchObject({ split: 'dev', class: 'broad' });
  });

  it('runs each arm through the production stages, with the same query vector and scope output', async () => {
    const meta = {
      'p-idx': { index_version: 'passages-v2', generation_id: 7, fingerprint: PASSAGES_V2_CONTRACT.fingerprints['text-embedding-3-small/1536'], chunker_version: 'chunk-v2', input_template_version: 'input-v1', embedding_model: 'text-embedding-3-small', embedding_dims: 1536 },
      'c-idx': { index_version: CASES_INDEX_VERSION, fingerprint: casesIndexFingerprint(), generation_id: 7 },
    };
    const corpus = ['A00FA001', 'B00FA001', 'C00FA001'].flatMap((n) => casePassages(n));
    const f = createFakeEs({ passagesIndex: 'p-idx', casesIndex: 'c-idx', meta, corpus, keyword: ['A00FA001:analysis:1'], vector: ['B00FA001:analysis:1'], cases: ['C00FA001', 'A00FA001'] });
    const embedder = createFakeEmbedder(1536, 'text-embedding-3-small');
    const q = { ...item('q', 'narrow', ['C00FA001']), question: 'fuel selector misuse' };
    const use = { sample: 1, intent: 'case_search', keywordText: 'fuel selector', inferredFilters: {}, plannerFilters: {} };
    const target = { dataset: { generationId: 7, passagesIndex: 'p-idx' }, casesIndex: 'c-idx' };
    const n = await runArm(f.es, embedder, target, q, use, 'N', 'fixed');
    const v1 = await runArm(f.es, embedder, target, q, use, 'p50-kt', 'fixed');
    expect(n).toMatchObject({ arm: 'N', version: 'retrieval.v2', error: null, keywordText: 'fuel selector' });
    expect(v1).toMatchObject({ arm: 'p50-kt', version: 'retrieval.v1', error: null });
    // The case-only case is delivered through the mapping, with its channels recorded.
    const c = n.bundle.find((x) => x.ntsbNo === 'C00FA001')!;
    expect(c).toMatchObject({ coded: true, mapped: true, channels: { keyword: null, vector: null, cases: 1 } });
    expect(provenanceOf(c.channels)).toBe('cases');
    expect(v1.bundle.map((x) => x.ntsbNo)).not.toContain('C00FA001');
    expect(n.score.recall.value).toBe(1);
    // One embedding input for both arms: the same question.
    expect(new Set(embedder.calls.flat())).toEqual(new Set([queryEmbeddingInput('fuel selector misuse')]));
    const failed = await runArm(f.es, embedder, { ...target, casesIndex: 'missing' }, q, use, 'N', 'fixed');
    expect(failed.error).toMatch(/RetrievalUnavailableError/);
  });
});

const delivered = (ntsbNo: string, coded: boolean, channels: DeliveredCase['channels'], mapped = false): DeliveredCase => ({ ntsbNo, caseRank: 1, coded, channels, mapped, passages: [] });

function run(arm: Arm, q: ExperimentItem, sample: number, ranking: string[], bundle: DeliveredCase[], mode: 'fixed' | 'inferred' = 'fixed'): AdoptionRun {
  return {
    arm,
    version: ARMS[arm].version,
    question: q.id,
    sample,
    filters: mode,
    applied: {},
    keywordText: 'k',
    ranking,
    score: scoreQuestion(ranking, bundle.map((c) => c.ntsbNo), codedReference(q.relevant)),
    bundle,
    skipped: [],
    mapping: arm === 'p50-kt' ? null : [{ ntsbNo: 'X', status: 'mapped', reason: null, passagesUnderFilter: 4, returned: 3 }],
    timingsMs: { stage1: 1, fetch: 1 },
    error: null,
  };
}

describe('scores, delivered evidence and the regression case', () => {
  const narrow = item('n1', 'narrow', ['A', 'B'], 'g1');
  const broad = item('b1', 'broad', ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'], 'g2');
  const items = [narrow, broad];
  const none = { keyword: null, vector: null, cases: null };
  const runs = new Map<string, AdoptionRun>();
  for (const s of [1, 2]) {
    runs.set(runKey('p50-kt', 'fixed', 'n1', s), run('p50-kt', narrow, s, ['A', 'C'], [delivered('A', true, { ...none, keyword: 1 })]));
    runs.set(runKey('N', 'fixed', 'n1', s), run('N', narrow, s, ['A', 'B'], [delivered('A', true, { ...none, keyword: 1, cases: 2 }), delivered('B', true, { ...none, cases: 1 }, true)]));
    runs.set(runKey('NF', 'fixed', 'n1', s), run('NF', narrow, s, ['A', 'B'], []));
    runs.set(runKey('p50-kt', 'fixed', 'b1', s), run('p50-kt', broad, s, ['P'], [delivered('P', true, { ...none, vector: 1 }), delivered('Q', true, { ...none, vector: 2 })]));
    runs.set(runKey('N', 'fixed', 'b1', s), run('N', broad, s, ['P'], [delivered('P', true, { ...none, vector: 1 }), delivered('M', false, { ...none, cases: 1 }, true)]));
    runs.set(runKey('NF', 'fixed', 'b1', s), run('NF', broad, s, ['P'], []));
  }

  it('scores each arm over its samples and pairs N with p50-kt by group', () => {
    expect(armScores(runs, 'p50-kt', 'fixed', items)).toMatchObject({ narrowRecall20: 0.5, narrowAtTarget: 0, failures: 0 });
    expect(armScores(runs, 'N', 'fixed', items)).toMatchObject({ narrowRecall20: 1, narrowAtTarget: 1 });
    const paired = pairedArms(runs, 'p50-kt', 'N', 'fixed', items, { resamples: 100, seed: 1 });
    expect(paired.narrowRecall20.delta).toBeCloseTo(0.5, 12);
    expect(paired.broadStrictP6.delta).toBeCloseTo(-1 / 6, 12);
    const changes = questionChanges(runs, 'p50-kt', 'N', 'fixed', items);
    expect(changes.map((c) => [c.id, c.metric, c.perSample.length])).toEqual([
      ['n1', 'narrowRecall20', 2],
      ['b1', 'broadNdcg6', 2],
    ]);
  });

  it('counts delivered cases by the channels that brought them, and lists the cases-only ones', () => {
    const d = deliveredEvidence(runs, 'N', 'fixed');
    expect(d.byProvenance).toEqual({ 'keyword+cases': { cases: 2, coded: 2 }, cases: { cases: 4, coded: 2 }, vector: { cases: 2, coded: 2 } });
    expect(d.casesOnly.map((c) => [c.question, c.ntsbNo, c.coded, c.mapped])).toEqual([
      ['n1', 'B', true, true],
      ['b1', 'M', false, true],
      ['n1', 'B', true, true],
      ['b1', 'M', false, true],
    ]);
    expect(d.mapping).toEqual({ mapped: 4, unmapped: {} });
    for (const [c, p] of [
      [{ keyword: 1, vector: 2, cases: 3 }, 'all'],
      [{ keyword: 1, vector: 2, cases: null }, 'keyword+vector'],
      [{ keyword: null, vector: 2, cases: 3 }, 'vector+cases'],
      [{ keyword: 1, vector: null, cases: null }, 'keyword'],
    ] as const) expect(provenanceOf(c)).toBe(p);
  });

  it('shows a regression case’s displaced and entered cases, sample by sample', () => {
    const r = regressionRuns(runs, 'p50-kt', 'N', 'fixed', 'b1');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ sample: 1, displaced: [{ ntsbNo: 'Q', coded: true }], entered: [{ ntsbNo: 'M', coded: false, channels: { cases: 1 } }] });
  });
});

describe('the load harness', () => {
  it('reports nearest-rank percentiles over individual requests', () => {
    expect(percentiles([])).toEqual({ n: 0, p50: null, p95: null, p99: null, max: null });
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(xs)).toEqual({ n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('summarizes cells, the cold pass apart, and flags any request not settled exactly once', () => {
    const s = (over: Partial<LoadSample>): LoadSample => ({ arm: 'retrieval.v2', concurrency: 4, cold: false, kind: 'normal', request: 'q', ms: 10, afterAbortMs: null, outcome: 'ok', reason: null, settlements: 1, mapped: 0, unmapped: 0, ...over });
    const rows = summarizeLoad([
      s({ cold: true, concurrency: 1, ms: 80 }),
      s({ ms: 12, mapped: 1 }),
      s({ kind: 'cancel', outcome: 'cancelled', afterAbortMs: 3, settlements: 0 }),
      s({ kind: 'fail', outcome: 'failed', ms: 160, settlements: 1 }),
      s({ kind: 'fail', outcome: 'failed', ms: 20, settlements: 2 }),
      s({ kind: 'mapping-bound', ms: 9, settlements: 0 }),
    ]);
    const cold = rows.find((r) => r.concurrency === 'cold')!;
    const warm = rows.find((r) => r.concurrency === 4)!;
    expect(cold.ok).toMatchObject({ n: 1, p99: 80 });
    expect(warm.ok).toMatchObject({ n: 1, p50: 12 });
    expect(warm.cancelAfterAbort).toMatchObject({ n: 1, p95: 3 });
    expect(warm.failure).toMatchObject({ n: 2, max: 160 });
    expect(warm.mappingBound).toMatchObject({ n: 1, p50: 9 });
    expect(warm.mappedRequests).toBe(1);
    expect(warm.settlementProblems).toBe(1);
    expect(warm.outcomes).toEqual({ 'normal:ok': 1, 'cancel:cancelled': 1, 'fail:failed': 2 });
  });

  it('fails only the chosen search kind, and its embedder honours an abort', async () => {
    const seen: estypes.SearchRequest[] = [];
    const base = { search: async (b: estypes.SearchRequest) => (seen.push(b), { ok: true }) } as unknown as Client;
    const cases = failingClient(base, 'c-idx', 'cases');
    await expect(cases.search({ index: 'c-idx', query: { bool: { must: [] } } })).rejects.toThrow(/injected/);
    await expect(cases.search({ index: 'p-idx', query: { bool: { must: [] } } })).resolves.toEqual({ ok: true });
    const keyword = failingClient(base, 'c-idx', 'keyword');
    await expect(keyword.search({ index: 'p-idx', query: { bool: { must: [] } } })).rejects.toThrow(/injected/);
    await expect(keyword.search({ index: 'p-idx', knn: { field: 'embedding', k: 1, num_candidates: 1, query_vector: [0] } })).resolves.toEqual({ ok: true });
    const vectors = new Map([['q', new Float32Array([1, 0])]]);
    const e = delayedEmbedder(vectors, { model: 'm', dims: 2, usdPerMillionTokens: 0 }, 50);
    const c = new AbortController();
    const p = e.embedWithSignal(['q'], c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect((await delayedEmbedder(vectors, { model: 'm', dims: 2, usdPerMillionTokens: 0 }, 0).embed(['q'])).vectors[0]).toEqual(new Float32Array([1, 0]));
  });
});
