/**
 * The frozen retrieval configurations (server/search/retrieval-config.ts) and the
 * operator setting that picks one (`AVIATION_RETRIEVAL_VERSION`).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config.js';
import { DEFAULT_RETRIEVAL_VERSION, RETRIEVAL_VERSIONS } from '../../shared/contracts/retrieval.js';
import { RETRIEVAL_DEFAULTS, numCandidates } from '../../server/search/hybrid.js';
import {
  CASES_CHANNEL_FIELDS,
  RETRIEVAL_CONFIGS,
  RETRIEVAL_V1,
  RETRIEVAL_V2,
  RETRIEVAL_V2_NF,
  canonicalRetrievalConfig,
  retrievalConfig,
  retrievalConfigSha256,
  retrievalIdentity,
} from '../../server/search/retrieval-config.js';
import { CASE_FIELD_SETS, experimentConfig, paramsOf } from '../../evals/retrieval/experiments/config.js';
import { loadGrid } from '../../evals/retrieval/experiments/grid.js';
import { DEFAULT_GRID } from '../../evals/retrieval/experiments/cli.js';
import { BASELINE_CONFIG } from '../../evals/retrieval/experiments/config.js';

describe('the frozen retrieval configurations', () => {
  it('retrieval.v1 is exactly the behaviour before task 10e, kept as the rollback', () => {
    expect(RETRIEVAL_V1).toMatchObject({ version: 'retrieval.v1', status: 'rollback', channels: { cases: null }, mapping: null });
    expect(RETRIEVAL_V1.params).toEqual(RETRIEVAL_DEFAULTS);
    // Elasticsearch's own cut, as before (no tie-break sort is sent under retrieval.v1).
    expect(RETRIEVAL_V1.channels.keyword).toEqual({ index: 'passages', fields: ['text'], size: 50, cutoff: 'elasticsearch-order' });
    expect(RETRIEVAL_V1.channels.vector).toEqual({ index: 'passages', field: 'embedding', k: 50, numCandidates: 200, cutoff: 'approximate' });
    expect(RETRIEVAL_V1.fusion).toMatchObject({ level: 'passage', k: 60, weights: { keyword: 1, vector: 1 } });
    expect(RETRIEVAL_V1.text).toEqual({ lexical: 'keyword-text', vector: 'question' });
  });

  it('retrieval.v2 is exactly the tested c200+n-kt, with the existing packing', () => {
    expect(RETRIEVAL_V2).toMatchObject({ version: 'retrieval.v2', status: 'production' });
    // 200 passage BM25 + 200 passage kNN + 200 cases; num_candidates 800 (the existing factor of four).
    // Cutoffs: the lexical cuts by score then id inside Elasticsearch; kNN approximate discovery.
    expect(RETRIEVAL_V2.channels.keyword).toEqual({ index: 'passages', fields: ['text'], size: 200, cutoff: 'score-then-id' });
    expect(RETRIEVAL_V2.channels.vector).toEqual({ index: 'passages', field: 'embedding', k: 200, numCandidates: 800, cutoff: 'approximate' });
    expect(numCandidates(RETRIEVAL_V2.params)).toBe(800);
    // The cases channel reads only the cases index version its validation covered.
    expect(RETRIEVAL_V2.channels.cases).toEqual({
      index: 'cases',
      content: 'narratives',
      fields: ['probable_cause', 'analysis', 'factual'],
      size: 200,
      cutoff: 'score-then-id',
      indexVersions: ['cases-v3'],
    });
    // Case-level RRF, k = 60, equal channel weights, exact comparison and a total tie order.
    expect(RETRIEVAL_V2.fusion).toMatchObject({ level: 'case', k: 60, weights: { keyword: 1, vector: 1, cases: 1 } });
    expect(RETRIEVAL_V2.fusion.ranking).toMatch(/exact/);
    // Scope keyword text for both lexical channels; the original effective question for the embedding.
    expect(RETRIEVAL_V2.text).toEqual({ lexical: 'keyword-text', vector: 'question' });
    expect(RETRIEVAL_V2.lexicalQuery).toEqual({ type: 'best_fields', operator: 'or' });
    expect(RETRIEVAL_V2.mapping).toEqual({ cases: 'leading-without-passages', passagesPerCase: 3, selection: 'count-then-exact-all-then-score-then-id', maxPassagesPerCase: 1_000 });
    // Packing is unchanged: 6 cases, 12 passages, the token budget, 12 leading candidates.
    const { perChannel: _p, ...packing } = RETRIEVAL_V2.params;
    const { perChannel: _q, ...before } = RETRIEVAL_DEFAULTS;
    expect(packing).toEqual(before);

    // The same values the phase A harness ran as c200+n-kt (grid.json).
    const { grid } = loadGrid(DEFAULT_GRID, BASELINE_CONFIG);
    const tested = experimentConfig(grid.variants.find((v) => v.id === 'c200+n-kt')!.config);
    expect(paramsOf(tested)).toEqual(RETRIEVAL_V2.params);
    expect(tested).toMatchObject({ fusion: 'case', keywordText: 'scope', weights: { keyword: 1, vector: 1, cases: 1 }, caseChannel: { fields: 'narratives', depth: 200, role: 'third' } });
    expect(CASE_FIELD_SETS.narratives).toEqual(CASES_CHANNEL_FIELDS.narratives);
    expect(CASE_FIELD_SETS['narratives+findings']).toEqual(RETRIEVAL_V2_NF.channels.cases?.fields);
  });

  it('NF exists only as an experimental configuration', () => {
    expect(RETRIEVAL_V2_NF).toMatchObject({ version: 'retrieval.v2-nf', status: 'experimental' });
    expect(RETRIEVAL_V2_NF.channels.cases?.fields).toEqual(['probable_cause', 'analysis', 'factual', 'findings_text']);
    const { channels: a, version: _a, status: _s, ...restNf } = RETRIEVAL_V2_NF;
    const { channels: b, version: _b, status: _t, ...restN } = RETRIEVAL_V2;
    expect(restNf).toEqual(restN);
    expect({ ...a, cases: null }).toEqual({ ...b, cases: null });
  });

  it('is frozen all the way down, and identified by its content', () => {
    for (const c of Object.values(RETRIEVAL_CONFIGS)) {
      expect(Object.isFrozen(c)).toBe(true);
      expect(Object.isFrozen(c.params)).toBe(true);
      expect(Object.isFrozen(c.fusion.weights)).toBe(true);
      expect(() => {
        (c.params as { perChannel: number }).perChannel = 7;
      }).toThrow();
    }
    expect(Object.keys(RETRIEVAL_CONFIGS)).toEqual([...RETRIEVAL_VERSIONS]);
    for (const v of RETRIEVAL_VERSIONS) expect(retrievalConfig(v).version).toBe(v);
    const shas = new Set(Object.values(RETRIEVAL_CONFIGS).map(retrievalConfigSha256));
    expect(shas.size).toBe(3);
    // Key order does not matter; any value does.
    expect(canonicalRetrievalConfig({ ...RETRIEVAL_V2 })).toBe(canonicalRetrievalConfig(RETRIEVAL_V2));
    expect(retrievalConfigSha256({ ...RETRIEVAL_V2, params: { ...RETRIEVAL_V2.params, rrfK: 61 } })).not.toBe(retrievalConfigSha256(RETRIEVAL_V2));
    expect(retrievalIdentity(RETRIEVAL_V2)).toEqual({ version: 'retrieval.v2', status: 'production', sha256: retrievalConfigSha256(RETRIEVAL_V2) });
  });
});

describe('the operator setting', () => {
  const load = (env: Record<string, string>) => loadConfig({ env: { NODE_ENV: 'test', ...env }, files: [] });

  it('defaults to retrieval.v2 and selects any version on dev', () => {
    expect(DEFAULT_RETRIEVAL_VERSION).toBe('retrieval.v2');
    expect(load({}).retrieval).toEqual({ version: 'retrieval.v2' });
    expect(load({ AVIATION_RETRIEVAL_VERSION: '' }).retrieval.version).toBe('retrieval.v2');
    for (const v of RETRIEVAL_VERSIONS) expect(load({ AVIATION_RETRIEVAL_VERSION: v }).retrieval.version).toBe(v);
  });

  it('refuses an unknown version, and the experimental one on live', () => {
    expect(() => load({ AVIATION_RETRIEVAL_VERSION: 'retrieval.v3' })).toThrow(/AVIATION_RETRIEVAL_VERSION/);
    expect(() => load({ APP_ENV: 'live', AVIATION_RETRIEVAL_VERSION: 'retrieval.v2-nf' })).toThrow(/experimental/);
    expect(load({ APP_ENV: 'live', AVIATION_RETRIEVAL_VERSION: 'retrieval.v1' }).retrieval.version).toBe('retrieval.v1');
    expect(load({ APP_ENV: 'live' }).retrieval.version).toBe('retrieval.v2');
  });
});
