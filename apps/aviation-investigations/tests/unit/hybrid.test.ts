import type { Client, estypes } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_INPUT_TOKENS,
  QueryEmbeddingError,
  QueryTooLongError,
  createOpenAIQueryEmbedder,
  queryEmbeddingInput,
} from '../../server/ai/embeddings.js';
import { packEvidence, type PackOptions, type PackablePassage } from '../../server/search/evidence.js';
import {
  NO_AIRCRAFT,
  RetrievalFiltersSchema,
  compileFilters,
  filterClauses,
  type Query,
} from '../../server/search/filters.js';
import {
  RETRIEVAL_DEFAULTS,
  RetrievalUnavailableError,
  SERVABLE_PASSAGES_VERSIONS,
  elideVectors,
  retrieveEvidence,
  retrievalParams,
  type RetrievalDataset,
} from '../../server/search/hybrid.js';
import { rankCases, rrfFuse } from '../../server/search/rrf.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { PASSAGES_INDEX_VERSION } from '../../worker/index/passages-index.js';

const DIMS = 16;
const INDEX = 'test-passages-v1-g7';
const DATASET: RetrievalDataset = { generationId: 7, passagesIndex: INDEX };

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
}

/** An Elasticsearch stand-in: canned channel results, and a fetch that honours ids and cause cases. */
function fakeEs(keyword: Doc[], vector: Doc[], all: Doc[], meta: Record<string, unknown> = {}): FakeEs {
  const state: FakeEs = { es: undefined as unknown as Client, calls: [], mappingCalls: 0 };
  const byId = new Map(all.map((d) => [d.passage_id, d]));
  const client = {
    indices: {
      getMapping: async ({ index }: { index: string }) => {
        state.mappingCalls += 1;
        return {
          [index]: {
            mappings: {
              _meta: {
                index_version: 'passages-v1',
                generation_id: 7,
                embedding_model: 'fake-embedding-v1',
                embedding_dims: DIMS,
                ...meta,
              },
            },
          },
        };
      },
    },
    search: async (body: estypes.SearchRequest) => {
      state.calls.push(body);
      const reply = (docs: Doc[], withText = false) => ({
        hits: {
          total: { value: docs.length, relation: 'eq' },
          hits: docs.map((d) => (withText ? { ...hit(d), _source: { ...hit(d)._source, text: d.text } } : hit(d))),
        },
      });
      if (body.knn) return reply(vector.slice(0, body.size));
      const b = (body.query as { bool: { must?: unknown; filter: Query[] } }).bool;
      if (b.must) return reply(keyword.slice(0, body.size));
      const wanted = (b.filter.at(-1) as { bool: { should: Query[] } }).bool.should;
      const idSet = new Set<string>();
      const causeCases = new Set<string>();
      for (const w of wanted as Record<string, unknown>[]) {
        if ('ids' in w) for (const id of (w.ids as { values: string[] }).values) idSet.add(id);
        else for (const n of ((w as { bool: { filter: { terms?: { ntsb_no: string[] } }[] } }).bool.filter[0]?.terms?.ntsb_no ?? [])) causeCases.add(n);
      }
      const out = all.filter((d) => idSet.has(d.passage_id) || (causeCases.has(d.ntsb_no) && d.section_kind === 'probable_cause'));
      void byId;
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
    const r = await retrieveEvidence(f.es, embedder, { dataset: DATASET, text: 'engine power loss after maintenance', filters });
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
    const err = await retrieveEvidence(f.es, embedder, { dataset: { generationId: 7, passagesIndex: null }, text: 'carb ice' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetrievalUnavailableError);
    expect((err as RetrievalUnavailableError).reason).toBe('no_passages_index');
    expect(f.calls).toHaveLength(0);
    expect(embedder.calls).toHaveLength(0);
  });

  it.each([
    [{ generation_id: 6 }, /generation 6/],
    [{ index_version: 'passages-v0' }, /version passages-v0/],
    [{ embedding_model: 'text-embedding-3-large' }, /embedding model text-embedding-3-large/],
    [{ embedding_dims: 512 }, /512 dimensions/],
  ])('refuses an index built differently (%o)', async (meta, message) => {
    const f = fakeEs([], [], [], meta);
    const embedder = createFakeEmbedder(DIMS);
    const err = await retrieveEvidence(f.es, embedder, { dataset: { generationId: 7, passagesIndex: `${INDEX}-${JSON.stringify(meta).length}` }, text: 'carb ice' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetrievalUnavailableError);
    expect((err as RetrievalUnavailableError).reason).toBe('index_mismatch');
    expect(String((err as Error).message)).toMatch(message);
    expect(f.calls).toHaveLength(0);
  });

  it('serves the index version the worker builds', () => {
    expect(SERVABLE_PASSAGES_VERSIONS).toContain(PASSAGES_INDEX_VERSION);
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
    }

    // The same through retrieveEvidence with the default parameters.
    const all = corpus(30);
    const f = fakeEs(all.filter((d) => d.section_kind !== 'probable_cause'), [...all].reverse(), all);
    const result = await retrieveEvidence(f.es, createFakeEmbedder(DIMS), { dataset: DATASET, text: 'stall on approach' });
    expect(result.cases.length).toBeLessThanOrEqual(6);
    expect(result.passages).toBeLessThanOrEqual(12);
    expect(result.cases.flatMap((c) => c.passages)).toHaveLength(result.passages);
    expect(new Set(result.cases.flatMap((c) => c.passages.map((x) => x.id))).size).toBe(result.passages);
    for (const c of result.cases) expect(c.passages.some((x) => x.sectionKind === 'probable_cause' && x.ntsbNo === c.ntsbNo)).toBe(true);
    expect(result.queryEmbedding).toMatchObject({ model: 'fake-embedding-v1', dims: DIMS, inputTemplate: 'query-v1', usd: 0 });
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
      expect(c.passages[1]?.role).toBe('probable_cause');
      expect(c.passages[1]?.fusedRank).toBeNull();
    }
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
      { ntsbNo: 'BIG', caseRank: 3, reason: 'cause_over_budget' },
    ]);
    expect(r.passages).toBe(4);
  });

  it('keeps the bundle within the token budget, dropping retrieved passages before causes', () => {
    const ranked = [p('A', 'analysis', 1, 600), p('A', 'analysis', 2, 600), p('B', 'analysis', 1, 600)];
    const r = pack(ranked, [p('A', 'probable_cause', 1, 100), p('B', 'probable_cause', 1, 100)], { maxEvidenceTokens: 1_500 });
    expect(r.tokens).toBeLessThanOrEqual(1_500);
    expect(r.cases.flatMap((c) => c.passages.filter((x) => x.role === 'probable_cause'))).toHaveLength(2);
    expect(r.trimmed.map((t) => t.id)).toEqual(['B:analysis:1']);
  });

  it('caps a case at maxPassagesPerCase, causes included', () => {
    const ranked = [p('A', 'analysis', 1), p('A', 'analysis', 2), p('A', 'analysis', 3), p('A', 'factual', 1)];
    const twoCauses = [p('A', 'probable_cause', 1, 100, 'probable_cause:a'), p('A', 'probable_cause', 1, 100, 'probable_cause:b')];
    const r = pack(ranked, twoCauses);
    expect(r.cases[0]?.passages).toHaveLength(3);
    expect(r.cases[0]?.passages.filter((x) => x.role === 'probable_cause')).toHaveLength(2);
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

  it('refuses empty questions and questions over the reserved embed cap', () => {
    expect(() => queryEmbeddingInput('   ')).toThrow(/empty/);
    expect(() => queryEmbeddingInput('word '.repeat(MAX_QUERY_INPUT_TOKENS + 10))).toThrow(QueryTooLongError);
    expect(() => createOpenAIQueryEmbedder({ apiKey: '', model: 'text-embedding-3-small', dims: 4 })).toThrow(/OPENAI_API_KEY/);
  });
});
