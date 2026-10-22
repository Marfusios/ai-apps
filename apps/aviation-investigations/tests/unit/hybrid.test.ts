import type { Client, estypes } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_INPUT_TOKENS,
  QueryEmbeddingError,
  QueryTooLongError,
  createOpenAIQueryEmbedder,
  queryEmbeddingInput,
} from '../../server/ai/embeddings.js';
import { errors } from '@elastic/elasticsearch';
import {
  PASSAGES_CONTRACT,
  PassagesCheckTimeoutError,
  PassagesIndexIncompatibleError,
  isDefinitivePassagesFailure,
  passagesCheckFailure,
  passagesIndexMismatches,
  passagesIndexProblems,
  type PassagesContract,
} from '../../server/search/passages-contract.js';
import { IndexMetaError, type IndexMeta } from '../../server/search/index-meta.js';
import { packEvidence, type PackOptions, type PackablePassage } from '../../server/search/evidence.js';
import {
  NO_AIRCRAFT,
  RetrievalFiltersSchema,
  compileFilters,
  filterClauses,
  type Query,
} from '../../server/search/filters.js';
import {
  IncompleteSearchError,
  RETRIEVAL_DEFAULTS,
  RetrievalUnavailableError,
  SERVABLE_PASSAGES_VERSIONS,
  elideVectors,
  retrieveEvidence,
  retrievalParams,
  type QueryEmbeddingUsage,
  type RetrievalDataset,
} from '../../server/search/hybrid.js';
import { rankCases, rrfFuse } from '../../server/search/rrf.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { CHUNKER_VERSION } from '../../worker/index/chunk.js';
import { EMBEDDING_INPUT_TEMPLATE_VERSION } from '../../worker/index/passages.js';
import { PASSAGES_EMBEDDING_DIMS, PASSAGES_INDEX_VERSION, passagesIndexFingerprint } from '../../worker/index/passages-index.js';

const DIMS = 16;
const INDEX = 'test-passages-v1-g7';
const DATASET: RetrievalDataset = { generationId: 7, passagesIndex: INDEX };
const FAKE_FINGERPRINT = 'f'.repeat(64);
/** The approved contract plus the fake embedder's 16-dimension test embedding. */
const CONTRACT: PassagesContract = { ...PASSAGES_CONTRACT, fingerprints: { 'fake-embedding-v1/16': FAKE_FINGERPRINT } };

// ---------------------------------------------------------------------------
// Synthetic passages

type Kind = 'factual' | 'analysis' | 'probable_cause';
interface Doc {
  passage_id: string;
  ntsb_no: string;
  section_id: string;
  revision_id: string;
  section_kind: Kind;
  scope: 'aircraft' | 'event';
  aircraft_specific: boolean;
  aircraft_key: number | null;
  start: number;
  end: number;
  part: number;
  parts: number;
  continuation: boolean;
  text: string;
}

function doc(ntsbNo: string, kind: Kind, part = 1, opts: { section?: string; words?: number } = {}): Doc {
  const section = opts.section ?? kind;
  return {
    passage_id: `${ntsbNo}:${section}:${part}`,
    ntsb_no: ntsbNo,
    section_id: `${ntsbNo}:${section}`,
    revision_id: `r-${ntsbNo}-${section}`,
    section_kind: kind,
    scope: 'aircraft',
    aircraft_specific: true,
    aircraft_key: 1,
    start: 0,
    end: 10,
    part,
    parts: 1,
    continuation: part > 1,
    text: Array.from({ length: opts.words ?? 20 }, (_, i) => `word${i}`).join(' '),
  };
}

const hit = (d: Doc): estypes.SearchHit<Record<string, unknown>> => {
  const { text: _text, ...meta } = d;
  return { _index: INDEX, _id: d.passage_id, _score: 1, _source: meta };
};

interface FakeEs {
  es: Client;
  calls: estypes.SearchRequest[];
  mappingCalls: number;
  /** Transport options of every metadata lookup. */
  mappingOptions: Record<string, unknown>[];
}

type Request = 'keyword' | 'vector' | 'fetch';
interface FakeOptions {
  meta?: Record<string, unknown>;
  /** Overrides of a response's completeness fields, per request. */
  incomplete?: Partial<Record<Request, { timed_out?: boolean; _shards?: Record<string, unknown> }>>;
  /** Requests that fail outright. */
  fail?: Request[];
}

/** An Elasticsearch stand-in: canned channel results, and a fetch that honours ids and cause cases. */
function fakeEs(keyword: Doc[], vector: Doc[], all: Doc[], opts: FakeOptions = {}): FakeEs {
  const state: FakeEs = { es: undefined as unknown as Client, calls: [], mappingCalls: 0, mappingOptions: [] };
  const client = {
    indices: {
      getMapping: async ({ index }: { index: string }, transport: Record<string, unknown> = {}) => {
        state.mappingCalls += 1;
        state.mappingOptions.push(transport);
        return {
          [index]: {
            mappings: {
              _meta: {
                index_version: 'passages-v1',
                generation_id: 7,
                fingerprint: FAKE_FINGERPRINT,
                chunker_version: 'chunk-v2',
                input_template_version: 'input-v1',
                embedding_model: 'fake-embedding-v1',
                embedding_dims: DIMS,
                ...opts.meta,
              },
            },
          },
        };
      },
    },
    search: async (body: estypes.SearchRequest) => {
      state.calls.push(body);
      const kind: Request = body.knn ? 'vector' : (body.query as { bool: { must?: unknown } }).bool.must ? 'keyword' : 'fetch';
      if (opts.fail?.includes(kind)) throw new Error(`${kind} search failed`);
      const reply = (docs: Doc[], withText = false) => ({
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        ...opts.incomplete?.[kind],
        hits: {
          total: { value: docs.length, relation: 'eq' },
          hits: docs.map((d) => (withText ? { ...hit(d), _source: { ...hit(d)._source, text: d.text } } : hit(d))),
        },
      });
      if (kind === 'vector') return reply(vector.slice(0, body.size));
      if (kind === 'keyword') return reply(keyword.slice(0, body.size));
      const b = (body.query as { bool: { filter: Query[] } }).bool;
      const wanted = (b.filter.at(-1) as { bool: { should: Query[] } }).bool.should;
      const idSet = new Set<string>();
      const causeCases = new Set<string>();
      for (const w of wanted as Record<string, unknown>[]) {
        if ('ids' in w) for (const id of (w.ids as { values: string[] }).values) idSet.add(id);
        else for (const n of ((w as { bool: { filter: { terms?: { ntsb_no: string[] } }[] } }).bool.filter[0]?.terms?.ntsb_no ?? [])) causeCases.add(n);
      }
      const out = all.filter((d) => idSet.has(d.passage_id) || (causeCases.has(d.ntsb_no) && d.section_kind === 'probable_cause'));
      return reply(out, true);
    },
  };
  state.es = client as unknown as Client;
  return state;
}

/** n cases, each with analysis parts 1..3, factual 1 and one cause. */
function corpus(n: number): Doc[] {
  return Array.from({ length: n }, (_, i) => `C${String(i).padStart(3, '0')}`).flatMap((c) => [
    doc(c, 'analysis', 1),
    doc(c, 'analysis', 2),
    doc(c, 'analysis', 3),
    doc(c, 'factual', 1),
    doc(c, 'probable_cause', 1),
  ]);
}

// ---------------------------------------------------------------------------

describe('one filter for every retrieval request', () => {
  it('same filters applied to both channels', async () => {
    const all = corpus(8);
    const f = fakeEs(all.filter((d) => d.section_kind === 'analysis'), all.filter((d) => d.section_kind === 'factual'), all);
    const embedder = createFakeEmbedder(DIMS);
    const filters = { category: ['AIR'], phase: ['landing'], injury: ['FATL'], yearFrom: 2010, yearTo: 2015 };
    const r = await retrieveEvidence(f.es, embedder, { dataset: DATASET, text: 'engine power loss after maintenance', filters, contract: CONTRACT });
    const [kw, vec, fetch] = f.calls;
    const keywordFilter = (kw?.query as { bool: { filter: Query[] } }).bool.filter;
    const vectorFilter = (vec?.knn as estypes.KnnSearch).filter as { bool: { filter: Query[] } };
    const fetchFilter = (fetch?.query as { bool: { filter: Query[] } }).bool.filter;
    const compiled = compileFilters(filters).bool.filter;
    expect(keywordFilter).toEqual(compiled);
    expect(vectorFilter.bool.filter).toEqual(compiled);
    expect(fetchFilter.slice(0, -1)).toEqual(compiled);
    expect(compiled).toContainEqual({ term: { answer_eligible: true } });
    expect(compiled).toContainEqual({ term: { country: 'USA' } });
    expect(compiled).toContainEqual({ term: { aircraft_specific: true } });
    expect(compiled).toContainEqual({
      nested: {
        path: 'aircraft',
        query: { bool: { filter: [{ terms: { 'aircraft.defining_phase_group': ['landing'] } }, { terms: { 'aircraft.category': ['AIR'] } }] } },
      },
    });
    // Both channels ask for the same number of passages; kNN looks at 4x as many candidates.
    expect(kw?.size).toBe(50);
    // No search may return partial results.
    for (const body of [kw, vec, fetch]) expect(body?.allow_partial_search_results).toBe(false);
    expect((vec?.knn as estypes.KnnSearch).k).toBe(50);
    expect((vec?.knn as estypes.KnnSearch).num_candidates).toBe(200);
    // The recorded bodies are the sent ones, with the vector elided.
    expect(r.requests.keyword).toEqual(JSON.parse(JSON.stringify(kw)));
    expect(JSON.stringify(r.requests.vector)).toContain('16-dimension query vector elided');
    expect(JSON.stringify(r.requests.vector)).not.toMatch(/-?0\.\d{6,}/);
    // BM25 matches allowlisted text only, never a query language.
    const json = JSON.stringify(kw);
    for (const forbidden of ['query_string', 'simple_query_string', 'wildcard', 'regexp', 'script']) expect(json).not.toContain(forbidden);
  });

  it('always adds answer_eligible and USA, even without filters, and validates them first', () => {
    expect(compileFilters({}).bool.filter).toEqual([{ term: { country: 'USA' } }, { term: { answer_eligible: true } }]);
    expect(() => RetrievalFiltersSchema.parse({ completion: ['in_progress'] })).toThrow();
    expect(() => RetrievalFiltersSchema.parse({ country: 'CAN' })).toThrow();
    expect(() => RetrievalFiltersSchema.parse({ category: ['JET'] })).toThrow();
    expect(() => RetrievalFiltersSchema.parse({ yearFrom: 2020, yearTo: 2010 })).toThrow();
    expect(() => filterClauses('passages', { completion: ['completed_with_cause'] })).toThrow(/completion/);
  });

  it('never lets an event-scoped passage satisfy an aircraft filter, even for blank values', () => {
    // On the cases index, an all-blank aircraft selection also matches events without aircraft rows.
    expect(JSON.stringify(filterClauses('cases', { category: ['blank'] }))).toContain(JSON.stringify(NO_AIRCRAFT));
    // On passages that branch would match every event-scoped passage: it is never used.
    const passages = filterClauses('passages', { category: ['blank'] });
    expect(JSON.stringify(passages)).not.toContain(JSON.stringify(NO_AIRCRAFT));
    expect(passages).toContainEqual({ term: { aircraft_specific: true } });
    // Event facets alone keep event-scoped passages.
    expect(JSON.stringify(filterClauses('passages', { injury: ['FATL'], state: ['AK'] }))).not.toContain('aircraft_specific');
  });

  it('records request bodies without vectors', () => {
    const body = { index: 'x', knn: { field: 'embedding', query_vector: [0.1, 0.2, 0.3], k: 1, num_candidates: 4 } };
    expect(elideVectors(body)).toEqual({ index: 'x', knn: { field: 'embedding', query_vector: '<3-dimension query vector elided>', k: 1, num_candidates: 4 } });
    expect(body.knn.query_vector).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('refusals', () => {
  it('refuses without a published passages index and sends nothing', async () => {
    const f = fakeEs([], [], []);
    const embedder = createFakeEmbedder(DIMS);
    const err = await retrieveEvidence(f.es, embedder, { dataset: { generationId: 7, passagesIndex: null }, text: 'carb ice', contract: CONTRACT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetrievalUnavailableError);
    expect((err as RetrievalUnavailableError).reason).toBe('no_passages_index');
    expect(f.calls).toHaveLength(0);
    expect(embedder.calls).toHaveLength(0);
  });

  it.each([
    [{ generation_id: 6 }, /generation 6/],
    [{ index_version: 'passages-v0' }, /index version passages-v0/],
    [{ embedding_model: 'text-embedding-3-large' }, /embedding model text-embedding-3-large/],
    [{ embedding_dims: 512 }, /512 dimensions/],
    [{ fingerprint: 'e'.repeat(64) }, /fingerprint eeeeeeeeeeee/],
    [{ fingerprint: undefined }, /fingerprint none/],
    [{ chunker_version: 'chunk-v3' }, /chunker chunk-v3/],
    [{ chunker_version: undefined }, /chunker none/],
    [{ input_template_version: 'input-v2' }, /input template input-v2/],
  ])('refuses an index that breaks the passages contract (%o)', async (meta, message) => {
    const f = fakeEs([], [], [], { meta });
    const embedder = createFakeEmbedder(DIMS);
    // A distinct index name per case: a passed check is remembered per index.
    const dataset = { generationId: 7, passagesIndex: `${INDEX}-${JSON.stringify(meta)}` };
    const err = await retrieveEvidence(f.es, embedder, { dataset, text: 'carb ice', contract: CONTRACT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetrievalUnavailableError);
    expect((err as RetrievalUnavailableError).reason).toBe('index_mismatch');
    expect(String((err as Error).message)).toMatch(message);
    expect(f.calls).toHaveLength(0);
    expect(embedder.calls).toHaveLength(0);
  });

  it('refuses an embedding the contract has no approved fingerprint for', async () => {
    const f = fakeEs([], [], []);
    const err = await retrieveEvidence(f.es, createFakeEmbedder(DIMS), { dataset: DATASET, text: 'carb ice' }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/no approved fingerprint for fake-embedding-v1\/16/);
  });

  it('bounds the metadata lookup by the request deadline and signal', async () => {
    const f = fakeEs([], [], corpus(1));
    const controller = new AbortController();
    await retrieveEvidence(f.es, createFakeEmbedder(DIMS), {
      dataset: { generationId: 7, passagesIndex: `${INDEX}-deadline` },
      text: 'carb ice',
      contract: CONTRACT,
      params: { timeoutMs: 1234 },
      signal: controller.signal,
    });
    expect(f.mappingOptions.at(-1)).toMatchObject({ requestTimeout: 1234, signal: controller.signal });
  });

  it('serves exactly the index the worker builds: version, chunker, template and approved fingerprint', () => {
    expect(SERVABLE_PASSAGES_VERSIONS).toEqual([PASSAGES_INDEX_VERSION]);
    expect(PASSAGES_CONTRACT.indexVersion).toBe(PASSAGES_INDEX_VERSION);
    expect(PASSAGES_CONTRACT.chunkerVersion).toBe(CHUNKER_VERSION);
    expect(PASSAGES_CONTRACT.inputTemplateVersion).toBe(EMBEDDING_INPUT_TEMPLATE_VERSION);
    // Recomputed with the worker's definition: a mapping, analysis or chunking change fails here until approved.
    expect(PASSAGES_CONTRACT.fingerprints[`text-embedding-3-small/${PASSAGES_EMBEDDING_DIMS}`]).toBe(passagesIndexFingerprint('text-embedding-3-small'));
    const meta: IndexMeta = {
      index: 'x',
      indexVersion: 'passages-v1',
      fingerprint: passagesIndexFingerprint('text-embedding-3-small'),
      generationId: 1,
      buildId: 'b',
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      chunkerVersion: 'chunk-v2',
      inputTemplateVersion: 'input-v1',
    };
    expect(passagesIndexProblems(meta, { generationId: 1, model: 'text-embedding-3-small', dims: 1536 })).toEqual([]);
    expect(passagesIndexProblems(meta, { generationId: 1, model: 'text-embedding-3-small', dims: 512 })).toEqual([
      '1536 dimensions (expected 512)',
      'no approved fingerprint for text-embedding-3-small/512',
    ]);
  });

  it('fixes candidate counts and bundle limits in code', () => {
    expect(retrievalParams()).toEqual(RETRIEVAL_DEFAULTS);
    expect(() => retrievalParams({ maxCases: 7 })).toThrow(/maxCases/);
    expect(() => retrievalParams({ maxPassages: 13 })).toThrow(/maxPassages/);
    expect(() => retrievalParams({ perChannel: 500 })).toThrow(/perChannel/);
    expect(() => retrievalParams({ perChannel: 200, numCandidatesFactor: 60 })).toThrow(/numCandidatesFactor/);
    expect(retrievalParams({ perChannel: 100 }).perChannel).toBe(100);
  });
});

describe('passages check failures', () => {
  it('are fixed categories that never carry upstream text', () => {
    const meta = { context: null, name: 'es', request: { params: { method: 'GET', path: '/' }, options: {}, id: 1 }, connection: null, attempts: 0, aborted: false };
    const upstream = (statusCode: number) =>
      new errors.ResponseError({
        body: { error: { root_cause: [{ type: 'x', reason: 'SENTINEL_UPSTREAM' }], reason: 'SENTINEL_UPSTREAM' }, status: statusCode },
        statusCode,
        headers: {},
        warnings: null,
        meta,
      } as never);
    expect(upstream(500).message).toContain('SENTINEL_UPSTREAM');
    const cases: [unknown, string][] = [
      [upstream(500), 'http_500'],
      [upstream(42), 'http_unknown'],
      [new errors.TimeoutError('SENTINEL_UPSTREAM'), 'timeout'],
      [new PassagesCheckTimeoutError(300), 'timeout'],
      [new errors.ConnectionError('SENTINEL_UPSTREAM'), 'transport'],
      [new errors.RequestAbortedError('SENTINEL_UPSTREAM'), 'aborted'],
      [new Error('SENTINEL_UPSTREAM'), 'unexpected'],
      ['SENTINEL_UPSTREAM', 'unexpected'],
      [new IndexMetaError('index SENTINEL_UPSTREAM does not exist', 'missing'), 'index_missing'],
      [new IndexMetaError('SENTINEL_UPSTREAM resolves to x', 'not_concrete'), 'index_not_concrete'],
    ];
    for (const [err, category] of cases) {
      expect(passagesCheckFailure(err)).toBe(category);
      expect(passagesCheckFailure(err)).not.toContain('SENTINEL');
    }
    const meta2: IndexMeta = {
      index: 'x',
      indexVersion: 'SENTINEL_UPSTREAM',
      fingerprint: null,
      generationId: 1,
      buildId: null,
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      chunkerVersion: 'chunk-v2',
      inputTemplateVersion: 'input-v1',
    };
    const incompatible = new PassagesIndexIncompatibleError('x', passagesIndexMismatches(meta2, { generationId: 1, model: 'text-embedding-3-small', dims: 1536 }));
    expect(passagesCheckFailure(incompatible)).toBe('incompatible:index_version,fingerprint');
    expect(isDefinitivePassagesFailure(incompatible)).toBe(true);
    expect(isDefinitivePassagesFailure(upstream(503))).toBe(false);
  });
});

describe('complete answers only', () => {
  it.each([
    ['keyword', { timed_out: true }, /keyword search was incomplete: timed out/],
    ['vector', { _shards: { total: 2, successful: 1, skipped: 0, failed: 1, failures: [{ shard: 1 }] } }, /vector search was incomplete: 1 shard\(s\) failed/],
    ['vector', { _shards: { total: 3, successful: 2, skipped: 0, failed: 0 } }, /vector search was incomplete: 2 of 3 shard\(s\) successful/],
    // Skipped shards are counted inside `successful`, never added to it.
    ['keyword', { _shards: { total: 2, successful: 1, skipped: 1, failed: 0 } }, /keyword search was incomplete: 1 of 2 shard\(s\) successful \(1 of them skipped\)/],
    ['fetch', { _shards: { total: 2, successful: 2, skipped: 3, failed: 0 } }, /fetch search was incomplete: 2 of 2 shard\(s\) successful \(3 of them skipped\)/],
    ['fetch', { timed_out: true }, /fetch search was incomplete: timed out/],
    ['fetch', { _shards: { total: 1, successful: 0, skipped: 0, failed: 1 } }, /fetch search was incomplete: 1 shard\(s\) failed/],
  ] as const)('fails retrieval on an incomplete %s response (%o)', async (request, incomplete, message) => {
    const all = corpus(3);
    const f = fakeEs(all, all, all, { incomplete: { [request]: incomplete } });
    const err = await retrieveEvidence(f.es, createFakeEmbedder(DIMS), { dataset: DATASET, text: 'carb ice', contract: CONTRACT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteSearchError);
    expect(String((err as Error).message)).toMatch(message);
  });

  it.each([
    { total: 2, successful: 2, skipped: 1, failed: 0 },
    { total: 3, successful: 3, skipped: 2, failed: 0 },
  ])('accepts shards skipped by the pre-filter, which Elasticsearch counts as successful (%o)', async (shards) => {
    const all = corpus(3);
    const f = fakeEs(all, all, all, { incomplete: { keyword: { _shards: shards }, vector: { _shards: shards }, fetch: { _shards: shards } } });
    const r = await retrieveEvidence(f.es, createFakeEmbedder(DIMS), { dataset: DATASET, text: 'carb ice', contract: CONTRACT });
    expect(r.cases.length).toBeGreaterThan(0);
  });

  it('hands the query embedding usage to the caller before any search, so a later failure keeps it', async () => {
    for (const fail of [['keyword'], ['fetch']] as const) {
      const all = corpus(3);
      const f = fakeEs(all, all, all, { fail: [...fail] });
      const usage: QueryEmbeddingUsage[] = [];
      const err = await retrieveEvidence(f.es, createFakeEmbedder(DIMS), {
        dataset: DATASET,
        text: 'carb ice on climb',
        contract: CONTRACT,
        onQueryEmbedding: (u) => usage.push(u),
      }).catch((e: unknown) => e);
      expect(String((err as Error).message)).toContain(`${fail[0]} search failed`);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ model: 'fake-embedding-v1', billing: 'reported' });
      expect(usage[0]?.tokens).toBeGreaterThan(0);
    }
    // A paid embedding with an unusable vector is reported before the error.
    const wrongShape = { ...createFakeEmbedder(DIMS), embed: async (texts: string[]) => ({ vectors: [new Float32Array(3)], tokens: texts.length * 7 }) };
    const paid: QueryEmbeddingUsage[] = [];
    await expect(
      retrieveEvidence(fakeEs([], [], []).es, wrongShape, { dataset: DATASET, text: 'carb ice', contract: CONTRACT, onQueryEmbedding: (u) => paid.push(u) }),
    ).rejects.toThrow(/wrong shape/);
    expect(paid).toEqual([expect.objectContaining({ tokens: 7, billing: 'reported' })]);
    // A refusal before embedding reports nothing: nothing was paid.
    const usage: QueryEmbeddingUsage[] = [];
    await retrieveEvidence(fakeEs([], [], []).es, createFakeEmbedder(DIMS), {
      dataset: { generationId: 7, passagesIndex: null },
      text: 'x',
      onQueryEmbedding: (u) => usage.push(u),
    }).catch(() => undefined);
    expect(usage).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Packing

interface P extends PackablePassage {
  tokens: number;
}
const p = (ntsbNo: string, kind: P['sectionKind'], part = 1, tokens = 100, section: string = kind): P => ({
  id: `${ntsbNo}:${section}:${part}`,
  ntsbNo,
  sectionId: `${ntsbNo}:${section}`,
  sectionKind: kind,
  part,
  tokens,
});
const OPTS: PackOptions = { maxCases: 6, maxPassages: 12, retrievedPerCase: 2, maxPassagesPerCase: 3, maxEvidenceTokens: 10_000 };

function pack(ranked: P[], causes: P[], opts: Partial<PackOptions> = {}) {
  const cases = rankCases(rrfFuse([ranked]));
  const probableCauses = new Map<string, P[]>();
  for (const c of causes) probableCauses.set(c.ntsbNo, [...(probableCauses.get(c.ntsbNo) ?? []), c]);
  return packEvidence({ cases, probableCauses, tokensOf: (x) => x.tokens }, { ...OPTS, ...opts });
}

describe('evidence packing', () => {
  it('never more than 6 cases / 12 passages', async () => {
    // 20 cases; each has 3 analysis parts ranked before its factual passage; causes not retrieved.
    const ranked: P[] = [];
    for (let i = 0; i < 20; i += 1) for (const part of [1, 2, 3]) ranked.push(p(`C${i}`, 'analysis', part));
    const causes = Array.from({ length: 20 }, (_, i) => p(`C${i}`, 'probable_cause'));
    const r = pack(ranked, causes);
    expect(r.cases).toHaveLength(6);
    expect(r.passages).toBe(12);
    expect(r.cases.flatMap((c) => c.passages)).toHaveLength(12);
    for (const c of r.cases) {
      expect(c.passages.length).toBeLessThanOrEqual(3);
      expect(c.passages.filter((x) => x.role === 'probable_cause')).toHaveLength(1);
      expect(c.passages.some((x) => x.role !== 'probable_cause' && x.reserved && x.fusedRank !== null)).toBe(true);
    }

    // The same through retrieveEvidence with the default parameters.
    const all = corpus(30);
    const f = fakeEs(all.filter((d) => d.section_kind !== 'probable_cause'), [...all].reverse(), all);
    const result = await retrieveEvidence(f.es, createFakeEmbedder(DIMS), { dataset: DATASET, text: 'stall on approach', contract: CONTRACT });
    expect(result.cases.length).toBeLessThanOrEqual(6);
    expect(result.passages).toBeLessThanOrEqual(12);
    expect(result.cases.flatMap((c) => c.passages)).toHaveLength(result.passages);
    expect(new Set(result.cases.flatMap((c) => c.passages.map((x) => x.id))).size).toBe(result.passages);
    for (const c of result.cases) expect(c.passages.some((x) => x.sectionKind === 'probable_cause' && x.ntsbNo === c.ntsbNo)).toBe(true);
    expect(result.queryEmbedding).toMatchObject({ model: 'fake-embedding-v1', dims: DIMS, inputTemplate: 'query-v1', usd: 0, billing: 'reported' });
    expect(result.queryEmbedding.tokens).toBeGreaterThan(0);
  });

  it('attaches every selected case\'s cause, counts it, and drops the lowest-ranked other passages first', () => {
    const ranked: P[] = [];
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) ranked.push(p(c, 'analysis', 1));
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) ranked.push(p(c, 'analysis', 2));
    const causes = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => p(c, 'probable_cause'));
    const r = pack(ranked, causes);
    // 6 causes + 12 retrieved would be 18: the six lowest-ranked retrieved passages (all part 2) go.
    expect(r.passages).toBe(12);
    expect(r.trimmed.map((t) => t.id)).toEqual(['F:analysis:2', 'E:analysis:2', 'D:analysis:2', 'C:analysis:2', 'B:analysis:2', 'A:analysis:2']);
    for (const c of r.cases) {
      expect(c.passages.map((x) => x.passage.id)).toEqual([`${c.ntsbNo}:analysis:1`, `${c.ntsbNo}:probable_cause:1`]);
      expect(c.passages[0]).toMatchObject({ role: 'retrieved', reserved: true });
      expect(c.passages[1]).toMatchObject({ role: 'probable_cause', reserved: true, fusedRank: null });
    }
  });

  it('keeps the retrieved passage that justified a case (neg-stall-warning-silent / CEN13LA249 shape)', () => {
    // Six cases; the sixth is ranked by a single low passage, its cause was not retrieved.
    // Trimming by global rank used to drop that passage and leave the case with its cause
    // alone, which mentions airspeed and stalling but not the silent warning.
    const ranked = [
      ...['A', 'B', 'C', 'D', 'E'].flatMap((c) => [p(c, 'analysis', 1), p(c, 'analysis', 2)]),
      p('CEN13LA249', 'analysis', 1),
    ];
    const causes = [...['A', 'B', 'C', 'D', 'E'], 'CEN13LA249'].map((c) => p(c, 'probable_cause'));
    const r = pack(ranked, causes);
    expect(r.passages).toBe(12);
    const shape = r.cases.find((c) => c.ntsbNo === 'CEN13LA249');
    expect(shape?.passages.map((x) => [x.passage.id, x.role, x.reserved])).toEqual([
      ['CEN13LA249:analysis:1', 'retrieved', true],
      ['CEN13LA249:probable_cause:1', 'probable_cause', true],
    ]);
    // No case ever holds only causes it was not retrieved for.
    for (const c of r.cases) expect(c.passages.some((x) => x.fusedRank !== null)).toBe(true);
    expect(r.trimmed.map((t) => t.id).sort()).toEqual(['A:analysis:2', 'B:analysis:2', 'C:analysis:2', 'D:analysis:2', 'E:analysis:2']);
  });

  it('selects fewer cases when a reservation does not fit', () => {
    // C's best passage plus its cause would take the bundle over the token budget.
    const ranked = [p('A', 'analysis', 1, 400), p('B', 'analysis', 1, 400), p('C', 'analysis', 1, 900), p('D', 'analysis', 1, 100)];
    const causes = ['A', 'B', 'C', 'D'].map((c) => p(c, 'probable_cause', 1, 100));
    const r = pack(ranked, causes, { maxEvidenceTokens: 1_300 });
    expect(r.cases.map((c) => c.ntsbNo)).toEqual(['A', 'B', 'D']);
    expect(r.skipped).toEqual([{ ntsbNo: 'C', caseRank: 3, reason: 'over_budget' }]);
    expect(r.tokens).toBeLessThanOrEqual(1_300);
  });

  it('counts a retrieved cause among the case\'s retrieved passages and fills the free room', () => {
    const ranked = [p('A', 'probable_cause'), p('A', 'analysis', 1), p('B', 'analysis', 1), p('A', 'analysis', 2), p('A', 'analysis', 3)];
    const r = pack(ranked, [p('A', 'probable_cause'), p('B', 'probable_cause')]);
    const a = r.cases.find((c) => c.ntsbNo === 'A');
    expect(a?.passages.map((x) => [x.passage.id, x.role])).toEqual([
      ['A:analysis:1', 'retrieved'],
      ['A:analysis:2', 'fill'],
      ['A:probable_cause:1', 'probable_cause'],
    ]);
    expect(a?.passages.find((x) => x.role === 'probable_cause')?.fusedRank).toBe(1);
    expect(r.passages).toBe(5);
  });

  it('skips a case without a cause and prefers fewer cases over causes that do not fit', () => {
    const ranked = [p('A', 'analysis'), p('NOCAUSE', 'analysis'), p('BIG', 'analysis'), p('B', 'analysis')];
    const causes = [p('A', 'probable_cause'), ...[1, 2, 3, 4].map((n) => p('BIG', 'probable_cause', n)), p('B', 'probable_cause')];
    const r = pack(ranked, causes, { maxPassages: 4 });
    expect(r.cases.map((c) => c.ntsbNo)).toEqual(['A', 'B']);
    expect(r.skipped).toEqual([
      { ntsbNo: 'NOCAUSE', caseRank: 2, reason: 'no_probable_cause' },
      { ntsbNo: 'BIG', caseRank: 3, reason: 'over_budget' },
    ]);
    expect(r.passages).toBe(4);
  });

  it('keeps the bundle within the token budget, dropping extra passages before any reservation', () => {
    const ranked = [p('A', 'analysis', 1, 600), p('A', 'analysis', 2, 600), p('B', 'analysis', 1, 600)];
    const r = pack(ranked, [p('A', 'probable_cause', 1, 100), p('B', 'probable_cause', 1, 100)], { maxEvidenceTokens: 1_500 });
    expect(r.tokens).toBeLessThanOrEqual(1_500);
    expect(r.cases.flatMap((c) => c.passages.filter((x) => x.role === 'probable_cause'))).toHaveLength(2);
    // B's only retrieved passage outranks nothing, but it justifies B: A's second passage goes instead.
    expect(r.trimmed.map((t) => t.id)).toEqual(['A:analysis:2']);
    expect(r.cases.find((c) => c.ntsbNo === 'B')?.passages.map((x) => x.passage.id)).toEqual(['B:analysis:1', 'B:probable_cause:1']);
  });

  it('caps a case at maxPassagesPerCase, causes included, and reserves every cause variant', () => {
    const ranked = [p('A', 'analysis', 1), p('A', 'analysis', 2), p('A', 'analysis', 3), p('A', 'factual', 1)];
    const twoCauses = [p('A', 'probable_cause', 1, 100, 'probable_cause:a'), p('A', 'probable_cause', 1, 100, 'probable_cause:b')];
    const r = pack(ranked, twoCauses);
    expect(r.cases[0]?.passages).toHaveLength(3);
    expect(r.cases[0]?.passages.filter((x) => x.role === 'probable_cause')).toHaveLength(2);
    // Three cause variants and the best passage exceed the cap together: the reservation is kept whole.
    const three = [...twoCauses, p('A', 'probable_cause', 1, 100, 'probable_cause:c')];
    const r3 = pack(ranked, three);
    expect(r3.cases[0]?.passages.map((x) => x.passage.id)).toEqual([
      'A:analysis:1',
      'A:probable_cause:a:1',
      'A:probable_cause:b:1',
      'A:probable_cause:c:1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Query embeddings

function vectorB64(dims: number): string {
  return Buffer.from(new Float32Array(dims).map((_, i) => (i + 1) / dims).buffer).toString('base64');
}

function scripted(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('query embeddings', () => {
  const KEY = 'sk-test-not-a-real-key';

  it('embeds the collapsed question once and reports billed tokens', async () => {
    const embedder = createOpenAIQueryEmbedder({
      apiKey: KEY,
      model: 'text-embedding-3-small',
      dims: 4,
      fetch: scripted(200, { data: [{ index: 0, embedding: vectorB64(4) }], usage: { prompt_tokens: 7 } }),
    });
    const res = await embedder.embed([queryEmbeddingInput('  carb   ice\n on climb ')]);
    expect(res.tokens).toBe(7);
    expect(res.vectors[0]).toHaveLength(4);
    expect(queryEmbeddingInput('  carb   ice\n on climb ')).toBe('carb ice on climb');
  });

  it('reports how a failure is billed, without provider text or the key', async () => {
    const rejected = createOpenAIQueryEmbedder({
      apiKey: KEY,
      model: 'text-embedding-3-small',
      dims: 4,
      fetch: scripted(429, { error: { message: `Incorrect key ${KEY}`, type: 'rate_limit', code: 'rate_limit_exceeded' } }),
    });
    const e1 = await rejected.embed(['carb ice']).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(QueryEmbeddingError);
    expect((e1 as QueryEmbeddingError).billing).toBe('none');
    expect(String((e1 as Error).message)).not.toContain(KEY);
    const failed = createOpenAIQueryEmbedder({ apiKey: KEY, model: 'text-embedding-3-small', dims: 4, fetch: scripted(500, { error: { message: 'boom' } }) });
    const e2 = await failed.embed(['carb ice']).catch((e: unknown) => e);
    expect((e2 as QueryEmbeddingError).billing).toBe('uncertain');
    const malformed = createOpenAIQueryEmbedder({ apiKey: KEY, model: 'text-embedding-3-small', dims: 4, fetch: scripted(200, { data: [] }) });
    const e3 = await malformed.embed(['carb ice']).catch((e: unknown) => e);
    expect(String((e3 as Error).message)).toBe('invalid query embedding response: count_mismatch');
    expect((e3 as QueryEmbeddingError).billing).toBe('uncertain');
  });

  it('marks a missing usage report as uncertain and bills a malformed response at its reported usage', async () => {
    const noUsage = createOpenAIQueryEmbedder({
      apiKey: KEY,
      model: 'text-embedding-3-small',
      dims: 4,
      fetch: scripted(200, { data: [{ index: 0, embedding: vectorB64(4) }] }),
    });
    const res = await noUsage.embed(['carb ice']);
    expect(res.usageUncertain).toBe(true);
    const malformed = createOpenAIQueryEmbedder({
      apiKey: KEY,
      model: 'text-embedding-3-small',
      dims: 4,
      fetch: scripted(200, { data: [{ index: 0, embedding: 'AAAA' }], usage: { prompt_tokens: 3 } }),
    });
    const err = await malformed.embed(['carb ice']).catch((e: unknown) => e);
    expect(err).toMatchObject({ billing: 'usage', billedTokens: 3 });
  });

  it('an embedding aborted mid-request is billed uncertain, and not retried', async () => {
    // A provider that never answers: the request is aborted by the caller's signal.
    const calls: number[] = [];
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      calls.push(1);
      await new Promise<void>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason as Error);
        signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      });
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const embedder = createOpenAIQueryEmbedder({ apiKey: KEY, model: 'text-embedding-3-small', dims: 4, fetch: hanging });
    const controller = new AbortController();
    const pending = embedder.embedWithSignal(['carb ice'], controller.signal).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(QueryEmbeddingError);
    expect(err).toMatchObject({ billing: 'uncertain' });
    expect(String((err as Error).message)).toBe('query embedding failed: request aborted');
    expect(calls).toHaveLength(1);
  });

  it('takes exactly one input within the reserved embed cap', async () => {
    const embedder = createOpenAIQueryEmbedder({ apiKey: KEY, model: 'text-embedding-3-small', dims: 4, fetch: scripted(200, {}) });
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow(/exactly one input/);
    await expect(embedder.embed(['word '.repeat(MAX_QUERY_INPUT_TOKENS + 10)])).rejects.toBeInstanceOf(QueryTooLongError);
  });

  it('refuses empty questions and questions over the reserved embed cap', () => {
    expect(() => queryEmbeddingInput('   ')).toThrow(/empty/);
    expect(() => queryEmbeddingInput('word '.repeat(MAX_QUERY_INPUT_TOKENS + 10))).toThrow(QueryTooLongError);
    expect(() => createOpenAIQueryEmbedder({ apiKey: '', model: 'text-embedding-3-small', dims: 4 })).toThrow(/OPENAI_API_KEY/);
  });
});
