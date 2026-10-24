/**
 * Case-level retrieval (`retrieval.v2`) with a fake Elasticsearch (tests/support/fake-es.ts):
 * the requests and their order, the case → passage mapping (same in-memory vector,
 * per case, verified), packing guarantees through packing and re-packing, and the
 * failure semantics (a channel failing while the paid embedding is in flight, aborts,
 * incomplete answers, contracts first). Real indexes: tests/integration/case-retrieval.test.ts.
 */
import type { estypes } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { QueryEmbeddingError, queryEmbeddingInput, type Embedder, type EmbedResult } from '../../server/ai/embeddings.js';
import { RetrievalFailure, type EmbeddingUsage, type EvidenceQuery } from '../../server/briefs/evidence.js';
import { createHybridRetriever, retrievalFailureOf } from '../../server/briefs/retriever.js';
import { exactRrf, uniqueCases } from '../../server/search/case-fusion.js';
import { MAX_EXACT_CANDIDATES, mapCasesToPassages } from '../../server/search/case-mapping.js';
import { retrieveCandidatesWith, retrieveCaseCandidates, type CaseRetrievalQuery } from '../../server/search/case-retrieval.js';
import { casesChannelFilter } from '../../server/search/cases-channel.js';
import { compileFilters } from '../../server/search/filters.js';
import { IncompleteSearchError, RetrievalUnavailableError, fetchAndPack, retrievalParams, type QueryEmbeddingUsage } from '../../server/search/hybrid.js';
import { PASSAGES_V2_CONTRACT } from '../../server/search/passages-contract.js';
import { MAX_MAPPED_PASSAGES, RETRIEVAL_V1, RETRIEVAL_V2, RETRIEVAL_V2_NF } from '../../server/search/retrieval-config.js';
import { BoundedReadTimeoutError } from '../../server/db/bounded-read.js';
import { CASES_INDEX_VERSION, casesIndexFingerprint } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { caseTermOf, casePassages, createFakeEs, passage, type FakeEsOptions, type FakePassage } from '../support/fake-es.js';

const MODEL = 'text-embedding-3-small';
const DIMS = 1536;
const PASSAGES = 'test-passages-v2-g7';
const CASES = 'test-cases-v3-g7';
const DATASET = { generationId: 7, passagesIndex: PASSAGES };
const QUESTION = 'Which accidents involved fuel selector misuse?';
const KEYWORDS = 'fuel selector position tank starvation';

const META: Record<string, Record<string, unknown>> = {
  [PASSAGES]: {
    index_version: 'passages-v2',
    generation_id: 7,
    fingerprint: PASSAGES_V2_CONTRACT.fingerprints[`${MODEL}/${DIMS}`],
    chunker_version: 'chunk-v2',
    input_template_version: 'input-v1',
    embedding_model: MODEL,
    embedding_dims: DIMS,
  },
  [CASES]: { index_version: CASES_INDEX_VERSION, fingerprint: casesIndexFingerprint(), generation_id: 7 },
};

/** Cases A..C found by the passage channels; D, E only by the cases channel; L a long case; Z has no passage at all. */
const CORPUS: FakePassage[] = [
  ...['A', 'B', 'C', 'D', 'E'].flatMap((n) => casePassages(`${n}00FA001`)),
  ...casePassages('L00FA001', 40),
];
const n = (c: string) => `${c}00FA001`;

function fake(over: Partial<FakeEsOptions> = {}) {
  return createFakeEs({
    passagesIndex: PASSAGES,
    casesIndex: CASES,
    meta: META,
    corpus: CORPUS,
    keyword: [`${n('A')}:analysis:1`, `${n('B')}:analysis:1`, `${n('A')}:analysis:2`],
    vector: [`${n('B')}:analysis:2`, `${n('C')}:analysis:1`, `${n('A')}:analysis:1`],
    cases: [n('D'), n('A'), n('L'), 'Z00FA001', n('B'), n('E')],
    // Later analysis parts are closer to the question (so the mapped best is not part 1).
    similarity: (p) => (p.section_kind === 'analysis' ? p.part : p.section_kind === 'factual' ? 0.5 : 0.1),
    ...over,
  });
}

const query = (over: Partial<CaseRetrievalQuery> = {}): CaseRetrievalQuery => ({ dataset: DATASET, casesIndex: CASES, text: QUESTION, keywordText: KEYWORDS, filters: {}, ...over });

/** An embedder whose answer waits until `release()` (or fails with `fail`). */
function deferredEmbedder(fail?: () => Error): Embedder & { calls: number; release(): void; started: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  const base = createFakeEmbedder(DIMS, MODEL);
  const e = {
    model: MODEL,
    dims: DIMS,
    usdPerMillionTokens: 0.02,
    calls: 0,
    release: () => release(),
    started: begun,
    async embed(texts: string[]): Promise<EmbedResult> {
      e.calls += 1;
      started();
      await gate;
      if (fail) throw fail();
      return base.embed(texts);
    },
  };
  return e;
}

describe('case-level stage 1: requests, fusion and mapping', () => {
  it('runs every channel with its frozen values, fuses exactly, and maps the leading case-only hits with the same vector', async () => {
    const f = fake();
    const embedder = createFakeEmbedder(DIMS, MODEL);
    const usages: QueryEmbeddingUsage[] = [];
    const r = await retrieveCaseCandidates(f.es, embedder, RETRIEVAL_V2, query({ onQueryEmbedding: (u) => usages.push(u) }));
    expect(embedder.calls).toEqual([[queryEmbeddingInput(QUESTION)]]);
    expect(usages).toHaveLength(1);

    const filter = compileFilters({}, { eventAircraftQualification: true }).bool.filter;
    const byKind = (k: string) => f.calls.filter((c) => c.kind === k).map((c) => c.body);
    const [keyword] = byKind('keyword');
    const [cases] = byKind('cases');
    const [vector] = byKind('vector');
    // The lexical cuts: score, then id, inside Elasticsearch's top-200 selection.
    expect(keyword).toMatchObject({
      index: PASSAGES,
      size: 200,
      allow_partial_search_results: false,
      query: { bool: { must: [{ multi_match: { query: KEYWORDS, fields: ['text'] } }], filter } },
      sort: [{ _score: { order: 'desc' } }, { passage_id: { order: 'asc' } }],
    });
    expect(cases).toMatchObject({
      index: CASES,
      size: 200,
      allow_partial_search_results: false,
      query: { bool: { must: [{ multi_match: { query: KEYWORDS, fields: ['probable_cause', 'analysis', 'factual'], type: 'best_fields', operator: 'or' } }], filter: casesChannelFilter({}, { eventAircraftQualification: true }) } },
      sort: [{ _score: { order: 'desc' } }, { ntsb_no: { order: 'asc' } }],
    });
    // The kNN cut is the approximate search's own: no sort can apply to it.
    expect(vector?.sort).toBeUndefined();
    const knn = vector?.knn as estypes.KnnSearch;
    expect(knn).toMatchObject({ field: 'embedding', k: 200, num_candidates: 800 });
    expect(knn.query_vector).toEqual(Array.from(fakeVector(queryEmbeddingInput(QUESTION), DIMS)));

    // Exact case-level RRF over each channel's unique cases.
    const expected = exactRrf([uniqueCases(r.keyword), uniqueCases(r.vector), r.casesChannel.map((c) => c.ntsbNo)], (x) => x, [1, 1, 1], 60).map((x) => x.id);
    expect(r.cases.map((c) => c.ntsbNo)).toEqual(expected);
    expect(r.fusedCases.find((c) => c.id === n('A'))?.ranks).toEqual([1, 3, 2]);

    // D, L and Z have no passage from a passage channel: mapped (D, L) or reported unmapped (Z), each by itself.
    expect(r.mapping).toEqual([
      { ntsbNo: n('D'), status: 'mapped', reason: null, passagesUnderFilter: 5, returned: 5 },
      { ntsbNo: n('L'), status: 'mapped', reason: null, passagesUnderFilter: 42, returned: 42 },
      { ntsbNo: 'Z00FA001', status: 'unmapped', reason: 'no_passages', passagesUnderFilter: 0, returned: 0 },
      { ntsbNo: n('E'), status: 'mapped', reason: null, passagesUnderFilter: 5, returned: 5 },
    ]);
    const mappingKnn = byKind('mapping').map((b) => b.knn as estypes.KnnSearch);
    // Per case, every passage of the case scored exactly (k = num_candidates = its count), then the best 3 kept.
    expect(mappingKnn.map((k) => [k.k, k.num_candidates])).toEqual([
      [5, 5],
      [42, 42],
      [5, 5],
    ]);
    for (const c of r.cases.filter((x) => [n('D'), n('L'), n('E')].includes(x.ntsbNo))) expect(c.passages).toHaveLength(3);
    // The same in-memory vector; no second embedding anywhere.
    for (const k of mappingKnn) expect(k.query_vector).toEqual(knn.query_vector);
    expect(embedder.calls).toHaveLength(1);
    // A long case gets its own best passages: no global cut-off took them.
    const l = r.cases.find((c) => c.ntsbNo === n('L'))!;
    expect(l.passages.map((p) => p.id)).toEqual([`${n('L')}:analysis:40`, `${n('L')}:analysis:39`, `${n('L')}:analysis:38`]);
    // Mapped passages rank after every fused passage, in case order.
    const fusedCount = r.fusedPassages.length;
    expect(r.cases.find((c) => c.ntsbNo === n('D'))!.passages.map((p) => p.rank)).toEqual([fusedCount + 1, fusedCount + 2, fusedCount + 3]);
    expect(l.passages[0]!.rank).toBe(fusedCount + 4);
    expect(r.cases.find((c) => c.ntsbNo === 'Z00FA001')!.passages).toEqual([]);
    // Elided bodies only.
    expect(JSON.stringify(r.requests)).toContain('dimension query vector elided');
    expect(r).toMatchObject({ version: 'retrieval.v2', casesIndex: CASES, casesIndexVersion: CASES_INDEX_VERSION, chunkerVersion: 'chunk-v2' });
  });

  it('orders every channel’s returned window by score, then id, whatever order the answer listed equal scores in', async () => {
    // Which hits a channel returns is its cutoff policy's (score then id inside Elasticsearch
    // for the lexical channels, the approximate search's own for kNN); what fusion sees of
    // them is the same whatever order equal scores arrive in.
    const flatten = (reverse: boolean) => (res: estypes.SearchResponse<Record<string, unknown>>) => {
      for (const h of res.hits.hits) h._score = 7;
      if (reverse) res.hits.hits.reverse();
    };
    const run = async (reverse: boolean) => {
      const f = fake({ tamper: { keyword: flatten(reverse), vector: flatten(reverse), cases: flatten(reverse) } });
      const r = await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query());
      return {
        channels: [r.keyword.map((h) => h.id), r.vector.map((h) => h.id), r.casesChannel.map((h) => h.ntsbNo)],
        ranking: r.cases.map((c) => [c.ntsbNo, c.passages.map((p) => p.id)]),
      };
    };
    const listed = await run(false);
    expect(await run(true)).toEqual(listed);
    // Every score equal: the ids decide, in each channel.
    for (const ids of listed.channels) expect(ids).toEqual([...ids].sort());
  });

  it('packs mapped cases with their best passage and every cause; an unmapped case is never packed; re-packing reuses everything', async () => {
    const f = fake();
    const r = await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query());
    const packed = await fetchAndPack(f.es, r.index, r.filter, r.cases, r.params);
    expect(packed.cases.length).toBeLessThanOrEqual(6);
    expect(packed.passages).toBeLessThanOrEqual(12);
    expect(packed.skipped).toContainEqual({ ntsbNo: 'Z00FA001', caseRank: expect.any(Number), reason: 'no_probable_cause' });
    for (const c of packed.cases) {
      // The best retrieved passage (reserved, ranked) and every probable cause.
      expect(c.passages.some((p) => p.reserved && p.fusedRank !== null)).toBe(true);
      expect(c.passages.filter((p) => p.sectionKind === 'probable_cause').map((p) => p.id)).toEqual([`${c.ntsbNo}:probable_cause:1`]);
    }
    const d = packed.cases.find((c) => c.ntsbNo === n('D'))!;
    expect(d.passages.find((p) => p.role === 'retrieved' && p.reserved)?.id).toBe(`${n('D')}:analysis:3`);
    // Re-packing the same candidates under a smaller budget: one fetch, nothing else.
    const before = f.calls.length;
    const smaller = await fetchAndPack(f.es, r.index, r.filter, r.cases, retrievalParams({ ...r.params, maxEvidenceTokens: 60 }));
    expect(f.kinds().slice(before)).toEqual(['fetch']);
    expect(smaller.tokens).toBeLessThanOrEqual(60);
    for (const c of smaller.cases) expect(c.passages.some((p) => p.reserved && p.fusedRank !== null)).toBe(true);
  });

  it('an evidence fetch that matched more passages than it returned is an incomplete search (task 22 S-M2)', async () => {
    const f = fake({
      tamper: {
        fetch: (res) => {
          res.hits.total = { value: res.hits.hits.length + 5, relation: 'eq' };
        },
      },
    });
    const r = await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query());
    const err = await fetchAndPack(f.es, r.index, r.filter, r.cases, r.params).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IncompleteSearchError);
    expect(err).toMatchObject({ request: 'fetch' });
    // The step records it as such, not as an unexplained failure.
    expect(retrievalFailureOf(err, undefined, 'none')).toMatchObject({ kind: 'failed', reason: 'incomplete_search' });
  });

  it('several case-only cases, long ones among them, compete for the six slots in fused order, each mapped by itself', async () => {
    const corpus = ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'].flatMap((c, i) => casePassages(`${c}00FA001`, i % 2 === 0 ? 60 + i : 2));
    const f = fake({ corpus: [...CORPUS, ...corpus], keyword: [`${n('A')}:analysis:1`], vector: [`${n('A')}:analysis:2`], cases: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'].map((c) => `${c}00FA001`) });
    const r = await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query());
    // Nine candidates, eight of them only from the cases channel: all among the leading 12, all mapped.
    expect(r.mapping.map((m) => [m.ntsbNo, m.status, m.returned === m.passagesUnderFilter])).toEqual(['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'].map((c) => [`${c}00FA001`, 'mapped', true]));
    for (const c of r.cases.filter((x) => x.ntsbNo !== n('A'))) expect(c.passages).toHaveLength(3);
    expect(r.mapping.filter((m) => m.passagesUnderFilter > 60).length).toBe(4);
    const packed = await fetchAndPack(f.es, r.index, r.filter, r.cases, r.params);
    expect(packed.cases.map((c) => c.ntsbNo)).toEqual(r.cases.slice(0, 6).map((c) => c.ntsbNo));
    expect(packed.passages).toBeLessThanOrEqual(12);
  });

  it('fails the whole retrieval when a mapping answer does not hold exactly the counted passages of its case', async () => {
    const once = (change: (res: estypes.SearchResponse<Record<string, unknown>>) => void) => {
      let done = false;
      return (res: estypes.SearchResponse<Record<string, unknown>>) => {
        if (done) return;
        done = true;
        change(res);
      };
    };
    const other = { _index: PASSAGES, _id: `${n('A')}:analysis:1`, _score: 1, _source: (() => { const { text: _t, ...m } = CORPUS.find((p) => p.passage_id === `${n('A')}:analysis:1`)!; return m; })() };
    const cases: [string, (res: estypes.SearchResponse<Record<string, unknown>>) => void, RegExp][] = [
      ['a short answer', (res) => void res.hits.hits.pop(), /4 of the 5 passages/],
      ['a long answer', (res) => void res.hits.hits.push(res.hits.hits[0]!), /6 of the 5 passages/],
      ['a repeated id', (res) => void (res.hits.hits[1] = { ...res.hits.hits[0]! }), /returned twice/],
      ['a passage of another case', (res) => void (res.hits.hits[1] = other), /another case/],
      ['a passage without a score', (res) => void (res.hits.hits[1] = { ...res.hits.hits[1]!, _score: null }), /without a score/],
    ];
    for (const [what, change, message] of cases) {
      const f = fake({ tamper: { mapping: once(change) } });
      const err = await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query()).catch((e: unknown) => e);
      expect(err, what).toBeInstanceOf(IncompleteSearchError);
      expect(err, what).toMatchObject({ request: 'mapping', message: expect.stringMatching(message) });
      // Through the binding: a failed step, the embedding settled exactly once, no bundle.
      const g = fake({ tamper: { mapping: once(change) } });
      const seen: EmbeddingUsage[] = [];
      const failure = await createHybridRetriever({ es: g.es, embedder: createFakeEmbedder(DIMS, MODEL), retrieval: RETRIEVAL_V2, casesIndexOf: async () => CASES })
        .retrieve(evidenceQuery(), live(), (u) => seen.push(u))
        .catch((e: unknown) => e);
      expect(failure, what).toMatchObject({ kind: 'failed', embedding: 'none', reason: 'incomplete_search' });
      expect(seen, what).toHaveLength(1);
      expect(g.kinds(), what).not.toContain('fetch');
    }
  });

  it('a failed mapping request aborts every sibling mapping request', async () => {
    // D's count fails at once; L's count hangs until it is aborted.
    const f = fake({
      failIf: (kind, body) => (kind === 'count' && caseTermOf(body) === n('D') ? new Error('SENTINEL count failed') : undefined),
      hangIf: (kind, body) => kind === 'count' && caseTermOf(body) === n('L'),
    });
    await expect(retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query())).rejects.toThrow('SENTINEL count failed');
    const hanging = f.calls.find((c) => c.kind === 'count' && caseTermOf(c.body) === n('L'));
    expect(hanging?.signal?.aborted).toBe(true);
    // The kNN wave never started.
    expect(f.kinds()).not.toContain('mapping');
  });

  it('keeps each mapped case’s best passages by score, then passage id, whatever the order of the answer', async () => {
    // D's five passages: analysis 1 and 2 and the factual one tie for the best score.
    const tied = (p: FakePassage) => (p.ntsb_no === n('D') ? (p.section_kind === 'probable_cause' ? 0 : p.section_kind === 'analysis' && p.part === 3 ? 0.5 : 1) : 0);
    for (const order of ['as-is', 'reversed'] as const) {
      const f = fake({ similarity: tied, tamper: order === 'reversed' ? { mapping: (res) => void res.hits.hits.reverse() } : {} });
      const r = await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query());
      expect(r.cases.find((c) => c.ntsbNo === n('D'))!.passages.map((p) => p.id), order).toEqual([`${n('D')}:analysis:1`, `${n('D')}:analysis:2`, `${n('D')}:factual:1`]);
    }
  });

  it('bounds the mapping: the leading cases only, no case twice, and a documented mapping-size limit', async () => {
    const f = fake();
    const vector = Array.from(fakeVector('q', DIMS));
    const filter = compileFilters({}, { eventAircraftQualification: true }).bool.filter;
    const opts = { passagesPerCase: 3, maxPassagesPerCase: MAX_MAPPED_PASSAGES, maxCases: 12 };
    await expect(mapCasesToPassages(f.es, PASSAGES, filter, vector, [n('D'), n('D')], { timeoutMs: 1000 }, opts)).rejects.toThrow(/twice/);
    await expect(
      mapCasesToPassages(f.es, PASSAGES, filter, vector, Array.from({ length: 13 }, (_, i) => `X${i}00FA001`), { timeoutMs: 1000 }, opts),
    ).rejects.toThrow(/at most 12/);
    await expect(mapCasesToPassages(f.es, PASSAGES, filter, vector, [n('D')], { timeoutMs: 1000 }, { ...opts, maxPassagesPerCase: MAX_EXACT_CANDIDATES + 1 })).rejects.toThrow(/mapping-size limit/);
    // Over the limit: reported, no kNN sent, never packed; not an integrity failure.
    const huge = fake({ tamper: { count: (res) => void ((res.hits.total as { value: number }).value = MAX_MAPPED_PASSAGES + 1) } });
    const m = await mapCasesToPassages(huge.es, PASSAGES, filter, vector, [n('D')], { timeoutMs: 1000 }, opts);
    expect(m.cases).toEqual([{ ntsbNo: n('D'), status: 'unmapped', reason: 'too_many_passages', passagesUnderFilter: MAX_MAPPED_PASSAGES + 1, returned: 0 }]);
    expect(huge.kinds()).toEqual(['count']);
    expect(RETRIEVAL_V2.mapping?.maxPassagesPerCase).toBe(MAX_MAPPED_PASSAGES);
    // Only the leading packCandidates cases are ever mapped.
    const many = Array.from({ length: 20 }, (_, i) => `W${String(i).padStart(2, '0')}FA001`);
    const wide = fake({ corpus: [...CORPUS, ...many.flatMap((c) => casePassages(c, 1))], keyword: [`${n('A')}:analysis:1`], vector: [`${n('A')}:analysis:1`], cases: many });
    const r = await retrieveCaseCandidates(wide.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query());
    expect(r.mapping).toHaveLength(11);
    expect(wide.kinds().filter((k) => k === 'count')).toHaveLength(11);
  });

  it('refuses incomplete mapping answers', async () => {
    const f = fake({ tamper: { count: (res) => void (res.timed_out = true) } });
    await expect(retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query())).rejects.toMatchObject({ name: 'IncompleteSearchError', request: 'mapping' });
    const g = fake({ tamper: { mapping: (res) => void (res._shards.failed = 1) } });
    await expect(retrieveCaseCandidates(g.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2, query())).rejects.toBeInstanceOf(IncompleteSearchError);
  });

  it('searches findings_text only under the experimental NF version', async () => {
    const f = fake();
    await retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V2_NF, query());
    const cases = f.calls.find((c) => c.kind === 'cases')!.body;
    expect(JSON.stringify(cases.query)).toContain('findings_text');
    await expect(retrieveCaseCandidates(f.es, createFakeEmbedder(DIMS, MODEL), RETRIEVAL_V1, query())).rejects.toThrow(/not a case-level/);
  });
});

describe('case-level stage 1: contracts and failures', () => {
  it('checks both indexes before anything is embedded', async () => {
    const variants: Record<string, Record<string, unknown>>[] = [
      { ...META, [CASES]: { ...META[CASES], generation_id: 8 } },
      { ...META, [CASES]: { ...META[CASES], fingerprint: '0'.repeat(64) } },
      { ...META, [PASSAGES]: { ...META[PASSAGES], generation_id: 8 } },
      { [PASSAGES]: META[PASSAGES] as Record<string, unknown> },
    ];
    for (const [i, meta] of variants.entries()) {
      // Fresh index names each time: a passed check is remembered by name.
      const casesIndex = `${CASES}-refused-${i}`;
      const passagesIndex = `${PASSAGES}-refused-${i}`;
      const rename = (k: string) => (k === CASES ? casesIndex : k === PASSAGES ? passagesIndex : k);
      const f = fake({ passagesIndex, casesIndex, meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [rename(k), v])) });
      const embedder = createFakeEmbedder(DIMS, MODEL);
      const err = await retrieveCaseCandidates(f.es, embedder, RETRIEVAL_V2, query({ casesIndex, dataset: { generationId: 7, passagesIndex } })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetrievalUnavailableError);
      expect(embedder.calls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('a cases-channel failure while the embedding is in flight: aborts the other searches, waits, settles the embedding once', async () => {
    const f = fake({ fail: { cases: () => new Error('SENTINEL cases down') }, hold: ['keyword'] });
    const embedder = deferredEmbedder();
    const usages: QueryEmbeddingUsage[] = [];
    let settled = false;
    const pending = retrieveCaseCandidates(f.es, embedder, RETRIEVAL_V2, query({ onQueryEmbedding: (u) => usages.push(u) })).finally(() => (settled = true));
    pending.catch(() => undefined);
    await embedder.started;
    await f.arrived('cases');
    await f.arrived('keyword');
    await new Promise((r) => setTimeout(r, 10));
    // The cases channel failed; the keyword search was aborted at once; retrieval still waits for the paid embedding.
    expect(f.calls.find((c) => c.kind === 'keyword')?.signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(usages).toHaveLength(0);
    embedder.release();
    await expect(pending).rejects.toThrow('SENTINEL cases down');
    expect(usages).toHaveLength(1);
    // The kNN channel never ran: its searches were aborted before the vector arrived.
    expect(f.kinds()).not.toContain('vector');
  });

  it('through the binding: one embed line, a fixed failure, and a late callback ignored', async () => {
    const f = fake({ fail: { cases: () => new Error('SENTINEL cases down') } });
    const embedder = deferredEmbedder();
    const seen: EmbeddingUsage[] = [];
    const retriever = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => CASES });
    const pending = retriever.retrieve(evidenceQuery(), live(), (u) => seen.push(u));
    pending.catch(() => undefined);
    await f.arrived('cases');
    embedder.release();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetrievalFailure);
    expect(err).toMatchObject({ kind: 'failed', embedding: 'none', reason: 'other', message: 'retrieval failed: failed (other)' });
    expect(seen).toEqual([{ provider: 'openai', model: MODEL, tokens: expect.any(Number), usd: expect.any(Number), billing: 'reported' }]);
  });

  it('an embedding failure aborts the searches and is settled by its own billing', async () => {
    const f = fake({ hold: ['keyword', 'cases'] });
    const embedder = deferredEmbedder(() => new QueryEmbeddingError('SENTINEL', { kind: 'api', status: 500 }, 'usage', 11));
    const seen: EmbeddingUsage[] = [];
    const retriever = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => CASES });
    const pending = retriever.retrieve(evidenceQuery(), live(), (u) => seen.push(u));
    pending.catch(() => undefined);
    await f.arrived('keyword');
    await f.arrived('cases');
    embedder.release();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'failed', embedding: 'none', reason: 'embedding' });
    expect(seen).toEqual([{ provider: 'openai', model: MODEL, tokens: 11, usd: (11 * 0.02) / 1e6, billing: 'reported' }]);
    for (const c of f.calls) expect(c.signal?.aborted).toBe(true);
  });

  it('a cancel while everything is in flight stops every request; the embedding attempt is uncertain', async () => {
    const f = fake({ hold: ['keyword', 'cases'] });
    const base = deferredEmbedder();
    // An embedder that honours the signal (as the OpenAI query embedder does).
    const embedder = {
      ...base,
      embedWithSignal: async (texts: string[], signal?: AbortSignal) =>
        new Promise<EmbedResult>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          void base.embed(texts).then(resolve);
        }),
    };
    const controller = new AbortController();
    const seen: EmbeddingUsage[] = [];
    const retriever = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => CASES });
    const pending = retriever.retrieve(evidenceQuery(), controller.signal, (u) => seen.push(u));
    pending.catch(() => undefined);
    await f.arrived('keyword');
    await f.arrived('cases');
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'timeout', reason: 'aborted', embedding: 'uncertain' });
    expect(seen).toEqual([]);
    for (const c of f.calls) expect(c.signal?.aborted).toBe(true);
  });

  it('an incomplete cases answer fails retrieval after the embedding was reported, never a bundle from the other channels', async () => {
    for (const tamper of [(res: estypes.SearchResponse<Record<string, unknown>>) => void (res.timed_out = true), (res: estypes.SearchResponse<Record<string, unknown>>) => void (res._shards.successful = 0)]) {
      const f = fake({ tamper: { cases: tamper } });
      const seen: EmbeddingUsage[] = [];
      const retriever = createHybridRetriever({ es: f.es, embedder: createFakeEmbedder(DIMS, MODEL), retrieval: RETRIEVAL_V2, casesIndexOf: async () => CASES });
      const err = await retriever.retrieve(evidenceQuery(), live(), (u) => seen.push(u)).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'failed', embedding: 'none', reason: 'incomplete_search' });
      expect(seen).toHaveLength(1);
      expect(f.kinds()).not.toContain('fetch');
    }
  });
});

const evidenceQuery = (over: Partial<EvidenceQuery> = {}): EvidenceQuery => ({ dataset: DATASET, text: QUESTION, keywordText: KEYWORDS, filters: {}, ...over });
const live = () => new AbortController().signal;

describe('the binding under a case-level version', () => {
  it('needs the manifest’s cases index, resolved before anything is embedded', async () => {
    expect(() => createHybridRetriever({ es: fake().es, embedder: createFakeEmbedder(DIMS, MODEL), retrieval: RETRIEVAL_V2 })).toThrow(/casesIndexOf/);
    const embedder = createFakeEmbedder(DIMS, MODEL);
    const f = fake();
    const none = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => null });
    expect(none.version).toBe('retrieval.v2');
    const err = await none.retrieve(evidenceQuery(), live(), () => undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unavailable', embedding: 'none', reason: 'no_cases_index' });
    const broken = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => Promise.reject(new Error('SENTINEL db')) });
    expect(await broken.retrieve(evidenceQuery(), live(), () => undefined).catch((e: unknown) => e)).toMatchObject({ kind: 'failed', embedding: 'none', reason: 'cases_index_lookup' });
    const other = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => 'test-cases-missing' });
    expect(await other.retrieve(evidenceQuery(), live(), () => undefined).catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable', embedding: 'none', reason: 'index_mismatch' });
    expect(embedder.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it('bounds the manifest lookup: a stalled lookup ends the request, sanitized, before anything is embedded', async () => {
    // A lookup that only ends when its signal aborts, and one that ignores the signal entirely.
    const seenSignals: AbortSignal[] = [];
    const honours = (d: unknown, signal: AbortSignal) =>
      new Promise<string | null>((_, reject) => {
        seenSignals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const ignores = () => new Promise<string | null>(() => undefined);
    for (const casesIndexOf of [honours, ignores]) {
      const f = fake();
      const embedder = createFakeEmbedder(DIMS, MODEL);
      const make = () => createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf, checkTimeoutMs: 100, lookupTimeoutMs: 100 });
      // available(): false within its deadline.
      let t0 = performance.now();
      expect(await make().available(DATASET)).toBe(false);
      expect(performance.now() - t0).toBeLessThan(1_000);
      // retrieve(): the lookup's own bound elapsed; a sanitized timeout, nothing embedded or searched.
      t0 = performance.now();
      const timedOut = await make().retrieve(evidenceQuery(), live(), () => undefined).catch((e: unknown) => e);
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(timedOut).toBeInstanceOf(RetrievalFailure);
      expect(timedOut).toMatchObject({ kind: 'timeout', embedding: 'none', reason: 'cases_index_lookup', message: 'retrieval failed: timeout (cases_index_lookup)' });
      // retrieve(): cancelled while the lookup waits; the step's own timeout reason, nothing embedded.
      const controller = new AbortController();
      const pending = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf, lookupTimeoutMs: 60_000 }).retrieve(evidenceQuery(), controller.signal, () => undefined);
      setTimeout(() => controller.abort(), 20);
      t0 = performance.now();
      expect(await pending.catch((e: unknown) => e)).toMatchObject({ kind: 'timeout', embedding: 'none', reason: 'aborted' });
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(embedder.calls).toHaveLength(0);
      // The passages contract check ran for available(); no search was sent.
      expect(f.calls).toHaveLength(0);
    }
    // The resolver was told: every signal it got has aborted.
    expect(seenSignals.length).toBe(3);
    for (const s of seenSignals) expect(s.aborted).toBe(true);
  });

  it('a failing lookup is a sanitized failure, its own timeout a sanitized timeout', async () => {
    const f = fake();
    const embedder = createFakeEmbedder(DIMS, MODEL);
    const failing = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => Promise.reject(new Error('SENTINEL connection refused')) });
    expect(await failing.retrieve(evidenceQuery(), live(), () => undefined).catch((e: unknown) => e)).toMatchObject({ kind: 'failed', embedding: 'none', reason: 'cases_index_lookup', message: 'retrieval failed: failed (cases_index_lookup)' });
    const slow = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async () => Promise.reject(new BoundedReadTimeoutError(5)) });
    expect(await slow.retrieve(evidenceQuery(), live(), () => undefined).catch((e: unknown) => e)).toMatchObject({ kind: 'timeout', embedding: 'none', reason: 'cases_index_lookup' });
    expect(embedder.calls).toHaveLength(0);
  });

  it('is available only with a servable passages index and its paired, servable cases index', async () => {
    const f = fake();
    const make = (casesIndexOf: () => Promise<string | null>) => createHybridRetriever({ es: f.es, embedder: createFakeEmbedder(DIMS, MODEL), retrieval: RETRIEVAL_V2, casesIndexOf });
    expect(await make(async () => CASES).available(DATASET)).toBe(true);
    expect(await make(async () => null).available(DATASET)).toBe(false);
    expect(await make(async () => 'test-cases-missing').available(DATASET)).toBe(false);
    expect(await make(async () => CASES).available({ generationId: 7, passagesIndex: null })).toBe(false);
    const asked: unknown[] = [];
    await createHybridRetriever({ es: f.es, embedder: createFakeEmbedder(DIMS, MODEL), retrieval: RETRIEVAL_V1, casesIndexOf: async () => asked.push(1) as unknown as string }).available(DATASET);
    expect(asked).toEqual([]);
  });

  it('returns the bundle with the mapping counts; a re-pack fetches again and nothing else', async () => {
    const f = fake();
    const embedder = createFakeEmbedder(DIMS, MODEL);
    const seen: EmbeddingUsage[] = [];
    const retriever = createHybridRetriever({ es: f.es, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: async (d) => (d.passagesIndex === PASSAGES ? CASES : null) });
    const out = await retriever.retrieve(evidenceQuery(), live(), (u) => seen.push(u));
    expect(out.mapping).toEqual({ mapped: 3, unmapped: 1 });
    // The cases index the bundle read, for the step's private metadata.
    expect(out.casesIndex).toEqual({ name: CASES, version: CASES_INDEX_VERSION });
    expect(out.chunkerVersion).toBe('chunk-v2');
    expect(out.bundle.cases.length).toBeGreaterThan(0);
    for (const c of out.bundle.cases) {
      expect(c.passages.some((p) => p.reserved && p.rank !== null)).toBe(true);
      expect(c.passages.some((p) => p.role === 'probable_cause' && p.reserved)).toBe(true);
    }
    const before = f.calls.length;
    const smaller = await out.repack(Math.max(1, Math.floor(out.bundle.evidenceTokens / 2)), live());
    expect(f.kinds().slice(before)).toEqual(['fetch']);
    expect(smaller.evidenceTokens).toBeLessThanOrEqual(out.bundle.evidenceTokens);
    expect(embedder.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('keeps every event-scoped passage event-scoped, mapped or not', async () => {
    const event = [passage('V00FA001', 'analysis', 1, { event: true }), passage('V00FA001', 'probable_cause', 1, { event: true }), passage('V00FA001', 'probable_cause', 2, { event: true, section: 'probable_cause-2' })];
    const f = fake({ corpus: [...CORPUS, ...event], cases: ['V00FA001'] });
    const out = await createHybridRetriever({ es: f.es, embedder: createFakeEmbedder(DIMS, MODEL), retrieval: RETRIEVAL_V2, casesIndexOf: async () => CASES }).retrieve(evidenceQuery(), live(), () => undefined);
    const v = out.bundle.cases.find((c) => c.ntsbNo === 'V00FA001')!;
    expect(v.passages.map((p) => [p.scope, p.aircraftKey])).toEqual(v.passages.map(() => ['event', null]));
    // Every cause variant is attached.
    expect(v.passages.filter((p) => p.sectionKind === 'probable_cause')).toHaveLength(2);
  });
});
