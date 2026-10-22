/**
 * The task 10d retrieval experiments (offline): every knob defaults to production and
 * the baseline sends exactly the production request bodies; the fusion functions; the
 * case-level channel's filter, query and mapping; the group bootstrap and the
 * registered selection rule; the scope samples' reservations; the miss classification;
 * the summaries; the configuration loader's key allowlist; the grid checks.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '../../server/ai/fake.js';
import { STAGE_CAPS, stageWorstCaseUsd } from '../../server/ai/pricing.js';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { compileFilters, filterClauses, type Query, type RetrievalFilters } from '../../server/search/filters.js';
import { RETRIEVAL_DEFAULTS, retrieveCandidates, retrieveEvidence, type PassageHit, type RetrievalDataset } from '../../server/search/hybrid.js';
import { rrfFuse } from '../../server/search/rrf.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { PASSAGES_EMBEDDING_DIMS, passagesIndexFingerprint } from '../../worker/index/passages-index.js';
import { caseAircraftClause, caseChannelBody, caseChannelFilter, caseMappingBody } from '../../evals/retrieval/experiments/cases-channel.js';
import { experimentAppConfig, spentUsd } from '../../evals/retrieval/experiments/cli.js';
import { BASELINE_CONFIG, canonicalConfig, changedKnobs, experimentConfig, isBaseline, paramsOf } from '../../evals/retrieval/experiments/config.js';
import { classify, representableVia, thresholdsOf, type Signals } from '../../evals/retrieval/experiments/diagnose.js';
import { gridConfigs, latencyOf, poolCases, poolCeiling, questionValue, runKey, summarize, type ExperimentItem, type StoredRun } from '../../evals/retrieval/experiments/experiment.js';
import { candidatesFor, caseRrfFuse, roundRobinCases, uniqueCaseOrder, weightedRrfFuse } from '../../evals/retrieval/experiments/fusion.js';
import { GRID_VERSION, GridSchema, gridProblems, loadGrid, sha256, type Grid } from '../../evals/retrieval/experiments/grid.js';
import { CodedDatasetSchema } from '../../evals/retrieval/coded/coded.js';
import { SCOPE_STAGE_TIMEOUT_MS, ScopeBudgetError, runScopeSamples, scopeInventory } from '../../evals/retrieval/experiments/scope.js';
import { applyRule, mulberry32, nearestRank, pairedGroupBootstrap, percentile, type BootstrapResult, type VariantEvaluation } from '../../evals/retrieval/experiments/stats.js';
import { runVariant } from '../../evals/retrieval/experiments/variant.js';
import { codedReference, scoreQuestion } from '../../evals/retrieval/metrics.js';

const MODEL = 'text-embedding-3-small';
const DIMS = PASSAGES_EMBEDDING_DIMS;
const INDEX = 'test-experiments-passages-v2-g7';
const CASES_INDEX = 'test-experiments-cases-v3-g7';
const DATASET: RetrievalDataset = { generationId: 7, passagesIndex: INDEX };

// ---------------------------------------------------------------------------
// A fake Elasticsearch: canned channel results, a fetch that honours ids and causes,
// a cases-index channel and the mapping kNN (restricted to cases).

type Kind = 'factual' | 'analysis' | 'probable_cause';
interface Doc {
  passage_id: string;
  ntsb_no: string;
  section_id: string;
  revision_id: string;
  section_kind: Kind;
  scope: 'aircraft';
  aircraft_specific: true;
  aircraft_key: number;
  start: number;
  end: number;
  part: number;
  parts: number;
  continuation: boolean;
  text: string;
}

function doc(ntsbNo: string, kind: Kind, part = 1): Doc {
  return {
    passage_id: `${ntsbNo}:${kind}:${part}`,
    ntsb_no: ntsbNo,
    section_id: `${ntsbNo}:${kind}`,
    revision_id: `r-${ntsbNo}-${kind}`,
    section_kind: kind,
    scope: 'aircraft',
    aircraft_specific: true,
    aircraft_key: 1,
    start: 0,
    end: 10,
    part,
    parts: 1,
    continuation: part > 1,
    text: Array.from({ length: 30 }, (_, i) => `${ntsbNo.toLowerCase()}w${i}`).join(' '),
  };
}

/** n cases FIX00..: analysis parts 1..2, factual 1, one cause each. */
function corpus(n: number): Doc[] {
  return Array.from({ length: n }, (_, i) => `FIX${String(i).padStart(3, '0')}`).flatMap((c) => [doc(c, 'analysis', 1), doc(c, 'analysis', 2), doc(c, 'factual', 1), doc(c, 'probable_cause', 1)]);
}

const sourceOf = (d: Doc, withText = false): Record<string, unknown> => {
  const { text, ...meta } = d;
  return withText ? { ...meta, text } : meta;
};

interface FakeEs {
  es: Client;
  calls: estypes.SearchRequest[];
}

function fakeEs(o: { keyword: Doc[]; vector: Doc[]; all: Doc[]; cases?: string[] }): FakeEs {
  const calls: estypes.SearchRequest[] = [];
  const reply = (hits: estypes.SearchHit<Record<string, unknown>>[]) => ({
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: { total: { value: hits.length, relation: 'eq' }, hits },
  });
  const hit = (d: Doc, withText = false): estypes.SearchHit<Record<string, unknown>> => ({ _index: INDEX, _id: d.passage_id, _score: 1, _source: sourceOf(d, withText) });
  const client = {
    indices: {
      getMapping: async ({ index }: { index: string }) => ({
        [index]: {
          mappings: {
            _meta: {
              index_version: 'passages-v2',
              generation_id: 7,
              fingerprint: passagesIndexFingerprint(MODEL, 'passages-v2'),
              chunker_version: 'chunk-v2',
              input_template_version: 'input-v1',
              embedding_model: MODEL,
              embedding_dims: DIMS,
            },
          },
        },
      }),
    },
    search: async (body: estypes.SearchRequest) => {
      calls.push(JSON.parse(JSON.stringify(body)) as estypes.SearchRequest);
      if (body.index === CASES_INDEX) {
        return reply((o.cases ?? []).slice(0, body.size).map((n) => ({ _index: CASES_INDEX, _id: n, _score: 1, _source: { ntsb_no: n } })));
      }
      if (body.knn) {
        const knn = body.knn as estypes.KnnSearch;
        const filter = (knn.filter as { bool: { filter: Query[] } }).bool.filter;
        const restrict = (filter.at(-1) as { terms?: { ntsb_no?: string[] } }).terms?.ntsb_no;
        if (restrict) return reply(o.all.filter((d) => restrict.includes(d.ntsb_no)).map((d) => hit(d)));
        return reply(o.vector.slice(0, knn.k).map((d) => hit(d)));
      }
      if ((body.query as { bool: { must?: unknown } }).bool.must) return reply(o.keyword.slice(0, body.size).map((d) => hit(d)));
      const wanted = ((body.query as { bool: { filter: Query[] } }).bool.filter.at(-1) as { bool: { should: Record<string, unknown>[] } }).bool.should;
      const ids = new Set<string>();
      const causes = new Set<string>();
      for (const w of wanted) {
        if ('ids' in w) for (const id of (w.ids as { values: string[] }).values) ids.add(id);
        else for (const n of (w as { bool: { filter: { terms?: { ntsb_no: string[] } }[] } }).bool.filter[0]?.terms?.ntsb_no ?? []) causes.add(n);
      }
      return reply(o.all.filter((d) => ids.has(d.passage_id) || (causes.has(d.ntsb_no) && d.section_kind === 'probable_cause')).map((d) => hit(d, true)));
    },
  };
  return { es: client as unknown as Client, calls };
}

const embedder = createFakeEmbedder(DIMS, MODEL);
const FILTERS: RetrievalFilters = { category: ['AIR'], phase: ['landing'], state: ['CA'], yearFrom: 2010, yearTo: 2015 };

/** A fixture where keyword and vector disagree: keyword reads analysis passages in order, vector factual passages in reverse. */
function fixture(n = 30) {
  const all = corpus(n);
  const keyword = all.filter((d) => d.section_kind === 'analysis');
  const vector = all.filter((d) => d.section_kind === 'factual').reverse();
  return { all, keyword, vector };
}

// ---------------------------------------------------------------------------

describe('the baseline is production, byte for byte', () => {
  it('derives every default from RETRIEVAL_DEFAULTS and leaves them unchanged', () => {
    expect(RETRIEVAL_DEFAULTS).toEqual({
      rrfK: 60,
      perChannel: 50,
      numCandidatesFactor: 4,
      caseScoring: 'best',
      maxCases: 6,
      maxPassages: 12,
      retrievedPerCase: 2,
      maxPassagesPerCase: 3,
      maxEvidenceTokens: 10_000,
      packCandidates: 12,
      timeoutMs: 5_000,
    });
    expect(BASELINE_CONFIG).toEqual({
      perChannel: 50,
      numCandidatesFactor: 4,
      rrfK: 60,
      weights: { keyword: 1, vector: 1, cases: 1 },
      fusion: 'passage',
      caseChannel: null,
      keywordText: 'question',
    });
    expect(paramsOf(BASELINE_CONFIG)).toEqual(RETRIEVAL_DEFAULTS);
    expect(experimentConfig({})).toEqual(BASELINE_CONFIG);
    expect(isBaseline(experimentConfig({}))).toBe(true);
    expect(Object.isFrozen(BASELINE_CONFIG) && Object.isFrozen(BASELINE_CONFIG.weights)).toBe(true);
  });

  it('the default configuration sends exactly the production request bodies and returns the production ranking and bundle', async () => {
    const fx = fixture();
    const prod = fakeEs(fx);
    const reference = await retrieveEvidence(prod.es, embedder, { dataset: DATASET, text: 'engine power loss after maintenance', filters: FILTERS });
    const candidates = await retrieveCandidates(fakeEs(fx).es, embedder, { dataset: DATASET, text: 'engine power loss after maintenance', filters: FILTERS });
    const exp = fakeEs(fx);
    const run = await runVariant(exp.es, embedder, { dataset: DATASET, casesIndex: CASES_INDEX, question: 'engine power loss after maintenance', filters: FILTERS }, experimentConfig({}));
    // The same requests, in the same order, query vectors included.
    expect(exp.calls).toHaveLength(3);
    expect(exp.calls).toEqual(prod.calls);
    expect(run.requests.keyword).toEqual(reference.requests.keyword);
    expect(run.requests.vector).toEqual(reference.requests.vector);
    expect(run.requests.fetch).toEqual(reference.requests.fetch);
    expect(run.requests.cases).toBeNull();
    expect(run.requests.mapping).toBeNull();
    // The production ranking and bundle.
    expect(run.ranking).toEqual(candidates.cases.map((c) => c.ntsbNo));
    expect(run.packed.cases).toEqual(reference.cases);
    expect(run.packed.skipped).toEqual(reference.skipped);
    expect(run.mappedCases).toEqual([]);
    // And the production body shapes: 50 passages per channel, num_candidates 200, the passages-v2 filter.
    const [kw, vec] = exp.calls;
    expect(kw?.size).toBe(50);
    expect((vec?.knn as estypes.KnnSearch).num_candidates).toBe(200);
    expect((kw?.query as { bool: { filter: Query[] } }).bool.filter).toEqual(compileFilters(FILTERS, { eventAircraftQualification: true }).bool.filter);
  });

  it('depth, num_candidates and the RRF constant are the production parameters', async () => {
    const fx = fixture(60);
    const over = { perChannel: 100, numCandidatesFactor: 10, rrfK: 30 };
    const prod = fakeEs(fx);
    const reference = await retrieveEvidence(prod.es, embedder, { dataset: DATASET, text: 'carburetor ice', filters: { state: ['MI'] }, params: over });
    const exp = fakeEs(fx);
    const run = await runVariant(exp.es, embedder, { dataset: DATASET, casesIndex: CASES_INDEX, question: 'carburetor ice', filters: { state: ['MI'] } }, experimentConfig(over));
    expect(exp.calls).toEqual(prod.calls);
    expect(run.packed.cases).toEqual(reference.cases);
    expect((exp.calls[1]?.knn as estypes.KnnSearch).num_candidates).toBe(1_000);
  });

  it('the scope keyword text replaces the question in BM25 only; the vector channel embeds the question', async () => {
    const fx = fixture();
    const prod = fakeEs(fx);
    await retrieveEvidence(prod.es, embedder, { dataset: DATASET, text: 'which accidents involved carb ice', keywordText: 'carburetor ice induction icing', filters: {} });
    const exp = fakeEs(fx);
    await runVariant(
      exp.es,
      embedder,
      { dataset: DATASET, casesIndex: CASES_INDEX, question: 'which accidents involved carb ice', scopeKeywordText: 'carburetor ice induction icing', filters: {} },
      experimentConfig({ keywordText: 'scope' }),
    );
    expect(exp.calls).toEqual(prod.calls);
    expect(JSON.stringify(exp.calls[0])).toContain('carburetor ice induction icing');
    await expect(
      runVariant(fakeEs(fx).es, embedder, { dataset: DATASET, casesIndex: CASES_INDEX, question: 'x', filters: {} }, experimentConfig({ keywordText: 'scope' })),
    ).rejects.toThrow(/scope stage keyword text/);
  });
});

describe('configuration', () => {
  it('validates every knob and the production limits', () => {
    expect(() => experimentConfig({ caseChannel: { fields: 'narratives', depth: 50, role: 'third' } })).toThrow(/case-level fusion/);
    expect(() => experimentConfig({ perChannel: 201 })).toThrow();
    expect(() => experimentConfig({ perChannel: 200, numCandidatesFactor: 51 })).toThrow();
    expect(() => experimentConfig({ weights: { keyword: -1 } })).toThrow();
    const c = experimentConfig({ fusion: 'case', perChannel: 100, caseChannel: { fields: 'narratives+findings', depth: 100, role: 'third' }, weights: { vector: 2 } });
    expect(changedKnobs(c)).toEqual(['perChannel', 'fusion', 'weights.vector', 'caseChannel']);
    expect(canonicalConfig(c)).toBe(canonicalConfig(experimentConfig({ weights: { vector: 2 }, caseChannel: { role: 'third', depth: 100, fields: 'narratives+findings' }, fusion: 'case', perChannel: 100 })));
  });
});

const hit = (id: string, ntsbNo: string): PassageHit => ({
  id,
  ntsbNo,
  sectionId: `${ntsbNo}:analysis`,
  revisionId: `r-${ntsbNo}`,
  sectionKind: 'analysis',
  scope: 'aircraft',
  aircraftSpecific: true,
  aircraftKey: 1,
  start: 0,
  end: 1,
  part: 1,
  parts: 1,
  continuation: false,
});

describe('fusion', () => {
  it('weighted RRF is the production RRF at equal weights, and scales with them', () => {
    const rand = mulberry32(7);
    for (let t = 0; t < 50; t += 1) {
      const pool = Array.from({ length: 40 }, (_, i) => hit(`p${i}`, `C${i % 13}`));
      const pick = () => pool.filter(() => rand() < 0.4).sort(() => rand() - 0.5);
      const lists = [pick(), pick()];
      const k = Math.floor(rand() * 100);
      expect(weightedRrfFuse(lists, [1, 1], k)).toEqual(rrfFuse(lists, k));
      // The weighted path: doubling both weights doubles every score and keeps the order.
      const doubled = weightedRrfFuse(lists, [2, 2], k);
      const plain = rrfFuse(lists, k);
      expect(doubled.map((h) => h.id)).toEqual(plain.map((h) => h.id));
      doubled.forEach((h, i) => expect(h.score).toBeCloseTo(2 * (plain[i]?.score as number), 12));
    }
    const a = hit('a', 'A');
    const b = hit('b', 'B');
    // Keyword ranks a first, vector b first; a vector weight of 2 puts b first.
    expect(weightedRrfFuse([[a, b], [b, a]], [1, 2], 60).map((h) => h.id)).toEqual(['b', 'a']);
    expect(weightedRrfFuse([[a, b], [b, a]], [2, 1], 60).map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('case-level RRF counts agreement on a case through different passages; passage-level RRF does not', () => {
    const k = [hit('x1', 'X'), hit('a1', 'A'), hit('y1', 'Y')];
    const v = [hit('z1', 'Z'), hit('a2', 'A'), hit('w1', 'W')];
    const passage = uniqueCaseOrder(rrfFuse([k, v], 60).map((h) => h.item));
    expect(passage.indexOf('A')).toBe(2);
    const cases = caseRrfFuse([uniqueCaseOrder(k), uniqueCaseOrder(v)], [1, 1], 60);
    expect(cases[0]).toMatchObject({ ntsbNo: 'A', ranks: [2, 2], rank: 1 });
    expect(cases[0]?.score).toBeCloseTo(2 / 62, 12);
    // Ties: the best rank any list gave, then the case number.
    expect(caseRrfFuse([['B', 'A'], ['A', 'B']], [1, 1], 60).map((c) => c.ntsbNo)).toEqual(['A', 'B']);
    expect(caseRrfFuse([['Q'], ['P']], [1, 1], 60).map((c) => c.ntsbNo)).toEqual(['P', 'Q']);
    // A repeat inside one list keeps its first rank.
    expect(caseRrfFuse([['A', 'B', 'A']], [1], 60).map((c) => [c.ntsbNo, c.ranks[0]])).toEqual([
      ['A', 1],
      ['B', 2],
    ]);
  });

  it('builds a channel-balanced pool in turn, unique and bounded', () => {
    expect(roundRobinCases([['A', 'B', 'C'], ['B', 'D', 'E']], 4)).toEqual(['A', 'B', 'C', 'D']);
    expect(roundRobinCases([['A'], ['A', 'B'], []], 10)).toEqual(['A', 'B']);
    expect(roundRobinCases([['A', 'B', 'C'], ['D']], 10)).toEqual(['A', 'D', 'B', 'C']);
    expect(() => roundRobinCases([['A']], 0)).toThrow();
  });

  it('gives case-channel-only cases their mapped passages, ranked after every fused passage', () => {
    const fused = rrfFuse([[hit('a1', 'A'), hit('a2', 'A')], [hit('b1', 'B')]], 60);
    const byCase = new Map([
      ['A', fused.filter((h) => h.item.ntsbNo === 'A')],
      ['B', fused.filter((h) => h.item.ntsbNo === 'B')],
    ]);
    const out = candidatesFor(['C', 'A', 'B', 'D'], byCase, new Map([['C', [hit('c2', 'C'), hit('c1', 'C')]]]), fused.length, new Map([['C', 0.5]]));
    expect(out.map((c) => [c.ntsbNo, c.rank, c.passages.map((p) => [p.id, p.rank])])).toEqual([
      ['C', 1, [['c2', 4], ['c1', 5]]],
      ['A', 2, [['a1', 1], ['a2', 3]]],
      ['B', 3, [['b1', 2]]],
      ['D', 4, []],
    ]);
    expect(out[0]?.score).toBe(0.5);
  });
});

describe('the case-level channel', () => {
  it('reaches the passages cohort: the compiler’s event clauses, answer-eligible, and the passages-v2 aircraft qualification', () => {
    expect(caseChannelFilter({})).toEqual([{ term: { country: 'USA' } }, { term: { answer_eligible: true } }]);
    const f = caseChannelFilter({ state: ['CA'], injury: ['FATL'], yearFrom: 2010, yearTo: 2012 });
    // The event clauses are exactly the passages compiler's.
    const passages = filterClauses('passages', { state: ['CA'], injury: ['FATL'], yearFrom: 2010, yearTo: 2012 });
    expect(f.filter((c) => !JSON.stringify(c).includes('answer_eligible'))).toEqual(passages.filter((c) => !JSON.stringify(c).includes('answer_eligible')));
    expect(caseChannelFilter({ category: ['HELI'], phase: ['landing'] })).toEqual([
      { term: { country: 'USA' } },
      { term: { answer_eligible: true } },
      {
        bool: {
          should: [
            {
              bool: {
                filter: [
                  { term: { aircraft_count: 1 } },
                  { nested: { path: 'aircraft', query: { bool: { filter: [{ terms: { 'aircraft.defining_phase_group': ['landing'] } }, { terms: { 'aircraft.category': ['HELI'] } }] } } } },
                ],
              },
            },
            {
              bool: {
                filter: [{ range: { aircraft_count: { gte: 2 } } }, { nested: { path: 'aircraft', query: { match_all: {} } } }],
                must_not: [
                  {
                    nested: {
                      path: 'aircraft',
                      query: { bool: { must_not: [{ bool: { filter: [{ terms: { 'aircraft.defining_phase_group': ['landing'] } }, { terms: { 'aircraft.category': ['HELI'] } }] } }] } },
                    },
                  },
                ],
              },
            },
          ],
          minimum_should_match: 1,
        },
      },
    ]);
  });

  it('a missing value fails on a multi-aircraft event: blank is dropped there, and a blank-only facet leaves only the single-aircraft branch', () => {
    const single = caseAircraftClause({ category: ['blank'] }) as { bool: { filter: Query[] } };
    expect(JSON.stringify(single)).toContain('"aircraft_count":1');
    expect(JSON.stringify(single)).not.toContain('"gte":2');
    const mixed = JSON.stringify(caseAircraftClause({ category: ['HELI', 'blank'] }));
    expect(mixed).toContain('"must_not":[{"exists":{"field":"aircraft.category"}}]');
    const [, several] = (caseAircraftClause({ category: ['HELI', 'blank'] }) as { bool: { should: Query[] } }).bool.should;
    expect(JSON.stringify(several)).not.toContain('exists');
    expect(caseAircraftClause({})).toBeNull();
  });

  it('searches the field set with the passage channel’s query form; never a query language', () => {
    const body = caseChannelBody(CASES_INDEX, 'fuel pump failure', 'narratives+findings', caseChannelFilter({ state: ['AZ'] }), 100);
    expect(body).toMatchObject({ index: CASES_INDEX, size: 100, allow_partial_search_results: false, track_total_hits: false, _source: ['ntsb_no'] });
    expect((body.query as { bool: { must: unknown[] } }).bool.must).toEqual([
      { multi_match: { query: 'fuel pump failure', fields: ['probable_cause', 'analysis', 'factual', 'findings_text'], type: 'best_fields', operator: 'or' } },
    ]);
    expect(JSON.stringify(caseChannelBody(CASES_INDEX, 'x', 'narratives', [], 5))).not.toContain('findings_text');
    for (const forbidden of ['query_string', 'wildcard', 'regexp', 'script']) expect(JSON.stringify(body)).not.toContain(forbidden);
    const mapping = caseMappingBody(INDEX, [0.1, 0.2], [{ term: { country: 'USA' } }], ['A1', 'B2']);
    expect(mapping.knn).toMatchObject({ k: 2_000, num_candidates: 2_000, filter: { bool: { filter: [{ term: { country: 'USA' } }, { terms: { ntsb_no: ['A1', 'B2'] } }] } } });
  });

  it('runs in parallel with the passage channels, maps case-only hits to passages and packs them', async () => {
    // Four cases: keyword reads FIX000..FIX003, vector FIX003..FIX000; FIX900 only the case channel finds.
    const fx = fixture(4);
    const extra = [doc('FIX900', 'analysis', 1), doc('FIX900', 'factual', 1), doc('FIX900', 'probable_cause', 1)];
    const f = fakeEs({ ...fx, all: [...fx.all, ...extra], cases: ['FIX900', 'FIX000', 'FIX001'] });
    const config = experimentConfig({ fusion: 'case', caseChannel: { fields: 'narratives+findings', depth: 50, role: 'third' } });
    const run = await runVariant(f.es, embedder, { dataset: DATASET, casesIndex: CASES_INDEX, question: 'fuel pump', filters: { category: ['AIR'] } }, config);
    expect(run.channels.cases).toEqual(['FIX900', 'FIX000', 'FIX001']);
    // Case-level RRF, k 60: FIX000 1/61+1/64+1/62, FIX001 1/62+1/63+1/63, FIX003 1/64+1/61, FIX002 1/63+1/62, FIX900 1/61.
    expect(run.ranking).toEqual(['FIX000', 'FIX001', 'FIX003', 'FIX002', 'FIX900']);
    expect(run.mappedCases).toEqual(['FIX900']);
    expect(JSON.stringify(run.requests.mapping)).toContain('"terms":{"ntsb_no":["FIX900"]}');
    expect(JSON.stringify(run.requests.mapping)).toContain('query vector elided');
    expect((run.requests.cases as { index: string }).index).toBe(CASES_INDEX);
    expect(JSON.stringify(run.requests.cases)).toContain('"aircraft_count":1');
    // FIX900 is packed with its best mapped passage and its probable cause.
    const packed = run.packed.cases.find((c) => c.ntsbNo === 'FIX900');
    expect(packed?.passages.map((p) => p.sectionKind)).toContain('analysis');
    expect(packed?.passages.map((p) => p.sectionKind)).toContain('probable_cause');
    // Replacing passage BM25: only vector and the case channel rank (FIX003 and FIX900 tie at 1/61; the case number breaks it).
    const replace = await runVariant(
      fakeEs({ ...fx, all: [...fx.all, ...extra], cases: ['FIX900'] }).es,
      embedder,
      { dataset: DATASET, casesIndex: CASES_INDEX, question: 'fuel pump', filters: {} },
      experimentConfig({ fusion: 'case', caseChannel: { fields: 'narratives', depth: 50, role: 'replace-keyword' } }),
    );
    expect(replace.ranking).toEqual(['FIX003', 'FIX900', 'FIX002', 'FIX001', 'FIX000']);
  });
});

describe('uncertainty by connected case group', () => {
  it('has deterministic percentiles and a seeded PRNG', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.05)).toBe(10);
    expect(percentile([0, 10], 0.05)).toBeCloseTo(0.5, 12);
    expect(nearestRank([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(nearestRank(Array.from({ length: 21 }, (_, i) => i + 1), 0.95)).toBe(20);
  });

  it('resamples whole groups: a paraphrase pair moves together', () => {
    // Two groups: g1 (two paraphrases, +1 each), g2 (one question, -1).
    const values = [
      { id: 'q1', group: 'g1', base: 0, variant: 1 },
      { id: 'q1p', group: 'g1', base: 0, variant: 1 },
      { id: 'q2', group: 'g2', base: 1, variant: 0 },
    ];
    const r = pairedGroupBootstrap(values, 4_000, 1);
    expect(r).toMatchObject({ questions: 3, groups: 2, resamples: 4_000, seed: 1 });
    expect(r.delta).toBeCloseTo(1 / 3, 12);
    // Group resamples can only give 1 (g1 g1), 1/3 (g1 g2) or -1 (g2 g2): never question-level mixes.
    expect(r.ci95[0]).toBe(-1);
    expect(r.ci95[1]).toBe(1);
    expect(pairedGroupBootstrap(values, 4_000, 1)).toEqual(r);
    // A constant improvement has a degenerate interval.
    const flat = pairedGroupBootstrap([{ id: 'a', group: 'g1', base: 0.2, variant: 0.3 }, { id: 'b', group: 'g2', base: 0.5, variant: 0.6 }], 1_000, 3);
    expect(flat.lower95).toBeCloseTo(0.1, 12);
    expect(flat.ci95[1]).toBeCloseTo(0.1, 12);
    expect(() => pairedGroupBootstrap([], 10, 1)).toThrow();
  });
});

const boot = (delta: number, lower95 = delta): BootstrapResult => ({ questions: 12, groups: 7, base: 0.5, variant: 0.5 + delta, delta, ci95: [lower95 - 0.01, delta + 0.05], lower95, resamples: 10_000, seed: 1 });
const evaluation = (id: string, narrow: number, opts: Partial<VariantEvaluation> & { lower?: number; p6?: number; ndcg?: number } = {}): VariantEvaluation => ({
  id,
  target: 'narrowRecall20',
  metrics: { narrowRecall20: boot(narrow, opts.lower ?? narrow), broadStrictP6: boot(opts.p6 ?? 0), broadNdcg6: boot(opts.ndcg ?? 0) },
  latency: { p95AddedMs: 10, p95TotalMs: 100 },
  addedPaidCallsPerRequest: 0,
  changedKnobs: 1,
  failures: 0,
  ...opts,
});
const RULE = { improvementPp: 5, regressionTolerancePp: 2, p95AddedLatencyMs: 200, p95TotalLatencyMs: 1_000, maxAddedPaidCallsPerRequest: 0, tieWindowPp: 1 };

describe('the registered selection rule', () => {
  it('qualifies only a meaningful, group-robust, regression-free, fast and free improvement', () => {
    const out = applyRule(
      [
        evaluation('small', 0.04),
        evaluation('noisy', 0.08, { lower: -0.01 }),
        evaluation('regresses', 0.1, { p6: -0.03 }),
        evaluation('slow', 0.1, { latency: { p95AddedMs: 250, p95TotalMs: 300 } }),
        evaluation('paid', 0.1, { addedPaidCallsPerRequest: 1 }),
        evaluation('failed', 0.1, { failures: 1 }),
        evaluation('good', 0.07, { p6: -0.015 }),
      ],
      RULE,
    );
    const reasons = Object.fromEntries(out.verdicts.map((v) => [v.id, v.reasons.join('; ')]));
    expect(reasons.small).toMatch(/improves 4\.0 pp/);
    expect(reasons.noisy).toMatch(/lower bound -1\.0 pp is not above 0/);
    expect(reasons.regresses).toMatch(/broadStrictP6 falls 3\.0 pp/);
    expect(reasons.slow).toMatch(/p95 added latency 250 ms/);
    expect(reasons.paid).toMatch(/paid call/);
    expect(reasons.failed).toMatch(/failed run/);
    expect(reasons.good).toBe('');
    expect(out.selected).toBe('good');
    expect(applyRule([evaluation('small', 0.04)], RULE)).toMatchObject({ selected: null, order: [] });
  });

  it('breaks ties within the window by broad nDCG@6, then latency, then fewer knobs', () => {
    const out = applyRule(
      [
        evaluation('best-recall', 0.2, { ndcg: 0 }),
        evaluation('close-better-ndcg', 0.195, { ndcg: 0.03 }),
        evaluation('far', 0.15, { ndcg: 0.1 }),
        evaluation('close-same-ndcg-faster', 0.192, { ndcg: 0.03, latency: { p95AddedMs: 1, p95TotalMs: 50 } }),
      ],
      RULE,
    );
    expect(out.order).toEqual(['close-same-ndcg-faster', 'close-better-ndcg', 'best-recall', 'far']);
    expect(out.selected).toBe('close-same-ndcg-faster');
    const knobs = applyRule([evaluation('two', 0.2, { changedKnobs: 2 }), evaluation('one', 0.2, { changedKnobs: 1 })], RULE);
    expect(knobs.selected).toBe('one');
  });
});

describe('E3 scope samples', () => {
  const items = [
    { id: 'q-carb', question: 'In Michigan, which accidents have a probable cause that cites conditions conducive to carburetor icing?' },
    { id: 'q-midair', question: 'Which accidents in Nevada involved a midair collision?' },
  ];
  const scopeOutput = (keywordText: string) => ({ intent: 'case_search' as const, mechanicalCause: false, filters: { state: ['MI'] }, keywordText });

  it('uses the brief pipeline’s stage budget', () => {
    expect(SCOPE_STAGE_TIMEOUT_MS).toBe(STAGE_TIMEOUTS.scope);
  });

  it('inventories input tokens for free: nothing is generated or reserved', async () => {
    const provider = createFakeProvider({ counts: { scope: 1_234 } });
    const inv = await scopeInventory(provider, items, 3);
    expect(provider.calls).toHaveLength(0);
    expect(inv).toMatchObject({ model: 'claude-haiku-5-5', samples: 3, calls: 6, inputTokens: 1_234 * 2 * 3 });
    expect(inv.perCallReserveUsd).toBeCloseTo(stageWorstCaseUsd('claude-haiku-5-5', STAGE_CAPS.scope), 12);
    expect(inv.reserveUsd).toBeCloseTo(6 * inv.perCallReserveUsd, 12);
  });

  it('reserves every attempt, settles what was billed, retries with a new reservation and falls back to the question', async () => {
    const provider = createFakeProvider({
      scope: [
        { output: scopeOutput('carburetor ice carb heat induction icing') },
        { fail: 'timeout' },
        { fail: 'rate_limited' },
        { output: scopeOutput('') },
      ],
    });
    const gate = createMemorySpendGate(1);
    const run = await runScopeSamples(provider, gate, items, { samples: 1, retries: 2, maxUsd: 0.1, purpose: 'eval-10d-test' });
    const [carb, midair] = run.samples;
    expect(carb).toMatchObject({ status: 'ok', keywordText: 'carburetor ice carb heat induction icing', plannerFilters: { state: ['MI'] } });
    // Midair: a timeout (uncertain: charged in full), a rate limit (nothing billed), then an empty keyword text: the question.
    expect(midair?.attempts.map((a) => [a.status, a.billing])).toEqual([
      ['failed', 'uncertain'],
      ['failed', 'none'],
      ['ok', 'usage'],
    ]);
    expect(midair?.keywordText).toBe(items[1]?.question);
    expect(gate.records).toHaveLength(4);
    const worst = stageWorstCaseUsd('claude-haiku-5-5', STAGE_CAPS.scope);
    expect(gate.records.map((r) => r.status)).toEqual(['settled', 'uncertain', 'settled', 'settled']);
    expect(gate.records[1]?.chargedUsd).toBeCloseTo(Math.ceil(worst * 1e6) / 1e6, 9);
    expect(gate.records[2]?.chargedUsd).toBe(0);
    expect(run.attempts).toBe(4);
    expect(gate.records.every((r) => r.category === 'evaluation' && r.purpose.startsWith('eval-10d-test-'))).toBe(true);
  });

  it('stops before an attempt that could exceed its limit', async () => {
    const provider = createFakeProvider({ scope: { output: scopeOutput('x') } });
    const worst = stageWorstCaseUsd('claude-haiku-5-5', STAGE_CAPS.scope);
    await expect(runScopeSamples(provider, createMemorySpendGate(1), items, { samples: 3, retries: 0, maxUsd: worst * 1.5, purpose: 'p' })).rejects.toBeInstanceOf(ScopeBudgetError);
    expect(provider.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('miss classification', () => {
  const thresholds = { percentile: 0.9, bm25: 10, cosine: 0.8, findings: 5 };
  it('needs a signal above zero and at the background percentile', () => {
    expect(representableVia({ bm25: 12, cosine: 0, findings: 0 }, thresholds)).toBe('narrative');
    expect(representableVia({ bm25: 0, cosine: 0.81, findings: 0 }, thresholds)).toBe('narrative');
    expect(representableVia({ bm25: 1, cosine: 0.5, findings: 9 }, thresholds)).toBe('findings_only');
    expect(representableVia({ bm25: 0, cosine: 0.5, findings: 0 }, { ...thresholds, bm25: 0, findings: 0 })).toBeNull();
    const bg: Signals[] = Array.from({ length: 11 }, (_, i) => ({ bm25: i, cosine: i / 10, findings: 0 }));
    expect(thresholdsOf(bg, 0.9)).toMatchObject({ percentile: 0.9, bm25: 9, findings: 0 });
  });

  it('places every positive in one class', () => {
    const signals = new Map<string, Signals>([
      ['ABS', { bm25: 1, cosine: 0.1, findings: 0 }],
      ['OUT', { bm25: 50, cosine: 0.1, findings: 0 }],
      ['FIN', { bm25: 0, cosine: 0.1, findings: 9 }],
    ]);
    const ranking = [...Array.from({ length: 22 }, (_, i) => (i === 1 ? 'DEL' : i === 2 ? 'LOST' : i === 9 ? 'BEY' : i === 21 ? 'LOW' : `X${i}`))];
    const out = classify(
      ['GONE', 'ABS', 'OUT', 'FIN', 'LOW', 'DEL', 'LOST', 'BEY'],
      { ranking, channels: { keyword: ['DEL', 'LOW'], vector: ['LOST', 'BEY'] }, bundle: ['X0', 'DEL'], skipped: [{ ntsbNo: 'LOST', reason: 'over_budget' }] },
      { reachable: new Set(['ABS', 'OUT', 'FIN', 'LOW', 'DEL', 'LOST', 'BEY']), signals, thresholds, sensitivity: [{ ...thresholds, percentile: 0.75, bm25: 0.5 }] },
    );
    expect(Object.fromEntries(out.map((p) => [p.ntsbNo, p.class]))).toEqual({
      GONE: 'excluded_by_filters',
      ABS: 'absent_from_representation',
      OUT: 'outside_pool',
      FIN: 'outside_pool',
      LOW: 'ranked_below_20',
      DEL: 'delivered',
      LOST: 'lost_in_packing',
      BEY: 'beyond_bundle',
    });
    expect(out.find((p) => p.ntsbNo === 'FIN')?.via).toBe('findings_only');
    expect(out.find((p) => p.ntsbNo === 'LOST')?.skipReason).toBe('over_budget');
    expect(out.find((p) => p.ntsbNo === 'ABS')?.viaAt['0.75']).toBe('narrative');
    expect(out.find((p) => p.ntsbNo === 'LOW')).toMatchObject({ rank: 22, inKeyword: true, inVector: false });
  });
});

// ---------------------------------------------------------------------------
// Summaries over synthetic runs

const GRID: Grid = GridSchema.parse({
  version: GRID_VERSION,
  registered: '2026-10-23',
  frozen: {
    dataset: { file: 'evals/retrieval/coded/dataset.json', sha256: 'a'.repeat(64), specSha256: 'b'.repeat(64), version: 'coded-v1' },
    generation: { id: 1, archiveSha256: 'c'.repeat(64), mappingVersion: 'v1-empirical', fieldNormalizationVersion: 'v1', citationTextVersion: 'v1' },
    passagesIndex: { name: INDEX, version: 'passages-v2', fingerprint: 'd'.repeat(64) },
    casesIndex: { name: CASES_INDEX, version: 'cases-v3', fingerprint: 'e'.repeat(64) },
    embedding: { model: MODEL, dims: DIMS },
    scope: { model: 'claude-haiku-5-5', promptVersion: 'scope.v2' },
    split: 'dev',
  },
  baseline: BASELINE_CONFIG,
  variants: [
    { id: 'p100', family: 'E7-depth', target: 'narrowRecall20', description: '100 per channel', config: { perChannel: 100 } },
    { id: 'p50-kt', family: 'E3', target: 'narrowRecall20', description: 'scope keyword text', config: { keywordText: 'scope' } },
  ],
  pools: [
    { id: 'pool-hyb50@50', description: 'baseline top 50', config: {}, method: 'ranking', size: 50 },
    { id: 'pool-bal50@100', description: 'balanced', config: { perChannel: 100 }, method: 'balanced', channels: ['vector', 'keyword'], size: 2 },
  ],
  channelsAlone: [
    { id: 'kw@50', channel: 'keyword', depth: 50 },
    { id: 'vec@50', channel: 'vector', depth: 50 },
  ],
  rule: { improvementPp: 5, regressionTolerancePp: 2, tieWindowPp: 1, poolImprovementPp: 5 },
  bootstrap: { resamples: 2_000, seed: 20261023, lowerBound: 'one-sided-95' },
  latency: { repetitions: 3, p95AddedMs: 200, p95TotalMs: 1_000 },
  cost: { phaseAUsd: 0.5, maxAddedPaidCallsPerRequest: 0 },
  scope: { samples: 2, timeoutMs: 10_000, retries: 1, maxUsd: 0.1 },
  diagnostics: { perChannel: 50, backgroundSample: 300, percentile: 0.9, sensitivity: [0.75, 0.95], seed: 7 },
  holdout: { confirmations: 1 },
});

const items: ExperimentItem[] = [
  { id: 'n1', split: 'dev', group: 'g1', class: 'narrow', area: 'environment', paraphraseOf: null, question: 'q1', filters: {}, relevant: ['A', 'B'] },
  { id: 'n1p', split: 'dev', group: 'g1', class: 'narrow', area: 'environment', paraphraseOf: 'n1', question: 'q1p', filters: {}, relevant: ['A', 'B'] },
  { id: 'b1', split: 'dev', group: 'g2', class: 'broad', area: 'occurrence', paraphraseOf: null, question: 'q2', filters: {}, relevant: ['C', 'D', 'E'] },
];

function stored(config: string, item: ExperimentItem, ranking: string[], ms: number[], o: { sample?: number; keyword?: string[]; vector?: string[] } = {}): StoredRun {
  const bundle = ranking.slice(0, 6);
  return {
    config,
    question: item.id,
    sample: o.sample ?? null,
    ranking,
    channels: { keyword: o.keyword ?? ranking, vector: o.vector ?? [], cases: null },
    bundle: bundle.map((n, i) => ({ ntsbNo: n, caseRank: i + 1, coded: item.relevant.includes(n), passages: [] })),
    skipped: [],
    trimmed: 0,
    passages: 0,
    tokens: 0,
    mappedCases: [],
    requests: { keyword: {}, vector: {}, cases: null, mapping: null, fetch: null },
    score: scoreQuestion(ranking, bundle, codedReference(item.relevant)),
    totalMs: ms,
    stagesMs: [],
    stable: true,
    error: null,
  };
}

describe('summaries', () => {
  const keys = gridConfigs(GRID);
  const base = canonicalConfig(BASELINE_CONFIG);
  const p100 = keys.variantKeys.get('p100') as string;
  const kt = keys.variantKeys.get('p50-kt') as string;
  const runs = new Map<string, StoredRun>();
  const put = (r: StoredRun) => runs.set(runKey(r.config, r.question, r.sample), r);
  const [n1, n1p, b1] = items as [ExperimentItem, ExperimentItem, ExperimentItem];
  put(stored(base, n1, ['A', 'X'], [10, 12, 11], { keyword: ['A'], vector: ['X', 'B'] }));
  put(stored(base, n1p, ['X'], [20, 20, 20], { keyword: ['X'], vector: ['Y'] }));
  put(stored(base, b1, ['C', 'X', 'Y'], [30, 30, 30]));
  put(stored(p100, n1, ['A', 'B'], [15, 15, 15], { keyword: ['A'], vector: ['B'] }));
  put(stored(p100, n1p, ['B', 'A'], [25, 25, 25], { keyword: ['B'], vector: ['A'] }));
  put(stored(p100, b1, ['C', 'D', 'E'], [35, 35, 35]));
  put(stored(kt, n1, ['A'], [10], { sample: 1 }));
  put(stored(kt, n1, ['A', 'B'], [12], { sample: 2 }));
  put(stored(kt, n1p, ['X'], [20], { sample: 1 }));
  put(stored(kt, n1p, ['X'], [22], { sample: 2 }));
  put(stored(kt, b1, ['C'], [30], { sample: 1 }));
  put(stored(kt, b1, ['C'], [30], { sample: 2 }));

  it('deduplicates configurations: the baseline pool and single channels reuse the baseline run', () => {
    expect(keys.entries.map((e) => e.key)).toEqual([base, p100, kt]);
    expect(keys.poolKeys.get('pool-hyb50@50')).toBe(base);
    expect(keys.aloneKeys.get('kw@50')).toBe(base);
  });

  it('averages scope samples per question and takes latency medians over repetitions', () => {
    expect(questionValue(runs, kt, n1, 'narrowRecall20')).toBeCloseTo(0.75, 12);
    const lat = latencyOf(runs, p100, base, items);
    expect(lat.perQuestion).toEqual({ n1: 15, n1p: 25, b1: 35 });
    expect(lat.p95AddedMs).toBe(5);
    expect(lat.p95TotalMs).toBe(35);
  });

  it('scores pools by their oracle ceiling, in turn across channels', () => {
    const r = runs.get(runKey(p100, 'n1', null)) as StoredRun;
    expect(poolCases(GRID.pools[1] as Grid['pools'][number], r)).toEqual(['B', 'A']);
    expect(poolCeiling(['B', 'Q'], ['A', 'B'])).toBe(0.5);
  });

  it('pairs every variant with the baseline by group and applies the rule', () => {
    const s = summarize(GRID, runs, items, keys, { baselinePool: 'pool-hyb50@50' });
    expect(s.baseline.arm).toMatchObject({ narrowRecall20: 0.25, narrowQuestions: 2, broadQuestions: 1 });
    const v = s.variants.find((x) => x.id === 'p100');
    expect(v?.metrics.narrowRecall20.delta).toBeCloseTo(0.75, 12);
    expect(v?.metrics.narrowRecall20.groups).toBe(1);
    expect(v?.metrics.broadStrictP6.delta).toBeCloseTo(2 / 6, 12);
    expect(v?.perQuestion.n1p).toEqual({ metric: 'narrowRecall20', base: 0, variant: 1 });
    expect(s.rule.selected).toBe('p100');
    expect(s.pools.find((p) => p.id === 'pool-hyb50@50')?.ceiling).toBeCloseTo(0.25, 12);
    expect(s.channelsAlone).toEqual([
      { id: 'kw@50', channel: 'keyword', depth: 50, narrowRecall20: 0.25, ceiling: 0.25 },
      { id: 'vec@50', channel: 'vector', depth: 50, narrowRecall20: 0.25, ceiling: 0.25 },
    ]);
    expect(s.unions).toEqual([{ depth: 50, channels: ['kw@50', 'vec@50'], ceiling: 0.5, perQuestion: { n1: 1, n1p: 0 } }]);
  });
});

describe('configuration and grid files', () => {
  it('reads only the two provider keys from a keys file, never over a nonempty process value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aviation-10d-keys-'));
    const keys = join(dir, 'keys.env');
    const base = join(dir, 'base.env');
    writeFileSync(keys, 'OPENAI_API_KEY=from-file-openai\nANTHROPIC_API_KEY=from-file-anthropic\nDATABASE_URL=postgres://file/not-allowed\nELASTICSEARCH_READ_API_KEY=not-allowed\n');
    writeFileSync(base, 'ELASTICSEARCH_INDEX_PREFIX=ai-aviation-test\n');
    const env = { NODE_ENV: 'test', OPENAI_API_KEY: 'from-env' } as NodeJS.ProcessEnv;
    const c = experimentAppConfig(base, keys, env);
    expect(c.ai.openai.apiKey).toBe('from-env');
    expect(c.ai.anthropic.apiKey).toBe('from-file-anthropic');
    expect(c.databaseUrl).toBeUndefined();
    expect(c.elasticsearch.readApiKey).toBeUndefined();
    expect(c.elasticsearch.indexPrefix).toBe('ai-aviation-test');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => experimentAppConfig(join(dir, 'missing.env'), keys, env)).toThrow(/not found/);
    expect(spentUsd(dir)).toBe(0);
    writeFileSync(join(dir, 'spend.jsonl'), '{"chargedUsd":0.25}\n{"chargedUsd":0.125}\n');
    expect(spentUsd(dir)).toBeCloseTo(0.375, 12);
  });

  it('refuses a grid whose baseline is not production, or with duplicate or invalid variants', () => {
    expect(gridProblems(GRID, BASELINE_CONFIG)).toEqual([]);
    const bad = {
      ...GRID,
      baseline: { ...BASELINE_CONFIG, rrfK: 30 },
      variants: [
        ...GRID.variants,
        { id: 'p100', family: 'x', target: 'narrowRecall20' as const, description: 'dup', config: { perChannel: 100 } },
        { id: 'same', family: 'x', target: 'narrowRecall20' as const, description: 'baseline again', config: {} },
        { id: 'bad', family: 'x', target: 'narrowRecall20' as const, description: 'case channel without case fusion', config: { caseChannel: { fields: 'narratives' as const, depth: 50, role: 'third' as const } } },
      ],
    };
    const problems = gridProblems(bad, BASELINE_CONFIG);
    expect(problems).toContain('the grid baseline is not the production baseline (BASELINE_CONFIG)');
    expect(problems).toContain('duplicate id p100');
    expect(problems).toContain('same: is the baseline');
    expect(problems.some((p) => p.startsWith('bad: invalid configuration'))).toBe(true);
  });
});

describe('the committed registration', () => {
  const APP_DIR = resolve(import.meta.dirname, '../..');
  const { grid } = loadGrid(resolve(APP_DIR, 'evals/retrieval/experiments/grid.json'), BASELINE_CONFIG);

  it('is a valid grid whose baseline is production, freezing the committed coded dataset and its generation', () => {
    const raw = readFileSync(resolve(APP_DIR, grid.frozen.dataset.file), 'utf8');
    expect(sha256(raw)).toBe(grid.frozen.dataset.sha256);
    const dataset = CodedDatasetSchema.parse(JSON.parse(raw));
    expect(dataset.source.specSha256).toBe(grid.frozen.dataset.specSha256);
    expect(dataset.version).toBe(grid.frozen.dataset.version);
    expect({
      id: dataset.source.generationId,
      archiveSha256: dataset.source.archiveSha256,
      mappingVersion: dataset.source.mappingVersion,
      fieldNormalizationVersion: dataset.source.fieldNormalizationVersion,
      citationTextVersion: dataset.source.citationTextVersion,
    }).toEqual(grid.frozen.generation);
    expect(grid.frozen.split).toBe('dev');
    expect(grid.baseline).toEqual(BASELINE_CONFIG);
    expect(grid.variants).toHaveLength(37);
    expect(grid.variants.every((v) => v.target === 'narrowRecall20')).toBe(true);
    expect(grid.rule).toEqual({ improvementPp: 5, regressionTolerancePp: 2, tieWindowPp: 1, poolImprovementPp: 5 });
    expect(grid.cost.phaseAUsd).toBe(0.5);
    // Every pool and single channel reuses the baseline or a variant: no extra configuration runs.
    const keys = gridConfigs(grid);
    expect(keys.entries).toHaveLength(1 + grid.variants.length);
  });

  it('PREREG.md lists exactly the grid’s variants and pools', () => {
    const prereg = readFileSync(resolve(APP_DIR, 'evals/retrieval/experiments/PREREG.md'), 'utf8');
    const ids = [...prereg.matchAll(/^\| `([^`]+)` \|/gmu)].map((m) => m[1]);
    expect(ids).toEqual([...grid.variants.map((v) => v.id), ...grid.pools.map((p) => p.id)]);
  });
});
