/**
 * Stage 1 under a frozen retrieval configuration (server/search/retrieval-config.ts):
 * `retrieveCandidatesWith` runs `retrieval.v1` through `retrieveCandidates`
 * (server/search/hybrid.ts, unchanged) and a case-level version (`retrieval.v2`,
 * `retrieval.v2-nf`) through `retrieveCaseCandidates`. The brief binding
 * (server/briefs/retriever.ts) and the evaluations call this one function, then stage
 * 2 (`fetchAndPack`, unchanged).
 *
 * **`retrieveCaseCandidates`**, in order:
 * 1. **Contracts first**, before anything is embedded: the passages index against its
 *    contract (`assertServablePassagesIndex`) and the cases index against the same
 *    generation and a validated cases version (`assertServableCasesIndex` with the
 *    configuration's `indexVersions`), both bounded by the request's timeout and signal.
 *    The passages contract's version decides the aircraft semantics of both filters
 *    (`compileFilters`, `casesChannelFilter`).
 * 2. **Embedding and the lexical channels at once.** The query embedding (the effective
 *    question, `onQueryEmbedding` called as soon as it returns), passage BM25 and the
 *    cases channel (both on the keyword text) start together; passage kNN starts when
 *    the vector arrives. A failed search aborts the other searches at once, but never the
 *    embedding: a paid attempt is always awaited, so its usage reaches the caller
 *    exactly once (through `onQueryEmbedding`, or as the embedding's own error), and only
 *    then does retrieval fail. The error thrown is the embedding's when it failed (its
 *    billing decides the settlement), otherwise the first search failure.
 * 3. **Discovery, then fusion.** The channels discover candidates; what each returns is
 *    fixed by its cutoff policy (`retrieval-config.ts`): the lexical channels' cut is by
 *    score, then id, inside Elasticsearch (the tie-break sort), and the kNN channel's is
 *    approximate. Fusion (server/search/case-fusion.ts) is then exact and totally ordered
 *    over what was returned: each channel in a total order (score, then id), collapsed to
 *    unique cases, exact reciprocal rank fusion with a total tie order; each case's
 *    passages in exact passage-level fusion order.
 * 4. **Mapping** (server/search/case-mapping.ts): the leading `packCandidates` cases
 *    that no passage channel returned get their passages from the same in-memory vector:
 *    every passage of the case scored exactly, the best kept by score then id; a case
 *    with none, or over the mapping-size limit, is reported unmapped; an inconsistent
 *    answer fails retrieval.
 *
 * Every search refuses partial results and is checked for completeness; no channel's
 * failure is ever replaced by a bundle from the others.
 */
import type { Client } from '@elastic/elasticsearch';
import type { Embedder, QueryEmbedder } from '../ai/embeddings.js';
import type { RetrievalVersion } from '../../shared/contracts/retrieval.js';
import { asFusedHits, caseCandidates, exactRrf, orderChannel, passagesByCase, uniqueCases, type ExactFused } from './case-fusion.js';
import { mapCasesToPassages, type CaseMappingEntry } from './case-mapping.js';
import { assertServableCasesIndex, casesChannelBody, casesChannelFilter, casesOf, type CaseHit } from './cases-channel.js';
import { RetrievalFiltersSchema, compileFilters, type Query } from './filters.js';
import {
  assertCompleteResponse,
  assertServablePassagesIndex,
  elideVectors,
  embedQuery,
  keywordChannelBody,
  numCandidates,
  retrieveCandidates,
  toHit,
  transport,
  vectorChannelBody,
  type CandidateResult,
  type PassageHit,
  type QueryEmbeddingUsage,
  type RetrievalParams,
  type RetrievalQuery,
} from './hybrid.js';
import type { RetrievalConfig } from './retrieval-config.js';
import type { CaseCandidate, FusedHit } from './rrf.js';
import type { estypes } from '@elastic/elasticsearch';

export interface CaseRetrievalQuery extends Omit<RetrievalQuery, 'params'> {
  /** The cases index the dataset's manifest pairs with its passages index. */
  casesIndex: string;
}

export interface CaseCandidateResult {
  version: RetrievalVersion;
  index: string;
  indexVersion: string;
  chunkerVersion: string;
  eventAircraftQualification: boolean;
  params: RetrievalParams;
  /** The passages filter: BM25, kNN, mapping and the stage 2 fetch. */
  filter: Query[];
  casesIndex: string;
  casesIndexVersion: string;
  casesFilter: Query[];
  /** Each channel in its total order. */
  keyword: PassageHit[];
  vector: PassageHit[];
  casesChannel: CaseHit[];
  /** Each channel's unique cases, in channel order. */
  channelCases: { keyword: string[]; vector: string[]; cases: string[] };
  /** Exact passage-level fusion of the two passage lists. */
  fusedPassages: FusedHit<PassageHit>[];
  /** Exact case-level fusion; `ranks` are [keyword, vector, cases]. */
  fusedCases: ExactFused<string>[];
  /** The case ranking as packing candidates. */
  cases: CaseCandidate<PassageHit>[];
  mapping: CaseMappingEntry[];
  queryEmbedding: QueryEmbeddingUsage;
  /** Request bodies, query vectors elided. */
  requests: { keyword: Record<string, unknown>; vector: Record<string, unknown>; cases: Record<string, unknown>; mapping: Record<string, unknown>[] };
  timingsMs: { checks: number; embed: number; channels: number; mapping: number; total: number };
}

function abortError(): Error {
  const e = new Error('the request was aborted');
  e.name = 'AbortError';
  return e;
}

/** Stage 1 of a case-level version (module comment). */
export async function retrieveCaseCandidates(es: Client, embedder: Embedder | QueryEmbedder, config: RetrievalConfig, q: CaseRetrievalQuery): Promise<CaseCandidateResult> {
  const cases = config.channels.cases;
  const mappingConfig = config.mapping;
  if (config.fusion.level !== 'case' || !cases || !mappingConfig) throw new Error(`${config.version} is not a case-level retrieval version`);
  const params = config.params;
  const filters = RetrievalFiltersSchema.parse(q.filters ?? {});
  const keywordText = (q.keywordText ?? q.text).replace(/\s+/gu, ' ').trim();
  if (keywordText === '') throw new Error('the query is empty');
  const started = performance.now();

  const bound = { timeoutMs: params.timeoutMs, ...(q.signal ? { signal: q.signal } : {}) };
  const [passages, casesIndex] = await Promise.all([
    assertServablePassagesIndex(es, q.dataset, embedder, { ...bound, ...(q.contracts ? { contracts: q.contracts } : {}) }),
    assertServableCasesIndex(es, q.casesIndex, q.dataset.generationId, { ...bound, versions: cases.indexVersions }),
  ]);
  const { index, contract } = passages;
  const qualification = { eventAircraftQualification: contract.eventAircraftQualification };
  const filter = compileFilters(filters, qualification).bool.filter;
  const casesFilter = casesChannelFilter(filters, qualification);
  const checked = performance.now();

  // Searches share one controller: the first failure aborts the others. The embedding never does.
  const searches = new AbortController();
  const searchSignal = q.signal ? AbortSignal.any([q.signal, searches.signal]) : searches.signal;
  const opts = transport(params, searchSignal);
  const failures: unknown[] = [];
  const failFast = <T>(p: Promise<T>): Promise<T> =>
    p.catch((error: unknown) => {
      failures.push(error);
      searches.abort();
      throw error;
    });

  const keywordBody = keywordChannelBody(index, keywordText, filter, params.perChannel, { tiebreak: config.channels.keyword.cutoff === 'score-then-id' });
  const casesBody = casesChannelBody(casesIndex.index, keywordText, cases.fields, casesFilter, cases.size);
  const sent: { vector?: estypes.SearchRequest; embeddedAt?: number } = {};
  const embedding = embedQuery(embedder, q.text, q.signal, q.onQueryEmbedding).then((r) => {
    sent.embeddedAt = performance.now();
    return r;
  });
  const vectorSearch = failFast(
    embedding.then(async ({ vector }) => {
      if (searchSignal.aborted) throw abortError();
      const body = vectorChannelBody(index, vector, filter, params.perChannel, numCandidates(params));
      sent.vector = body;
      const res = await es.search<Record<string, unknown>>(body, opts);
      assertCompleteResponse(res, 'vector');
      return res;
    }),
  );
  const keywordSearch = failFast(
    es.search<Record<string, unknown>>(keywordBody, opts).then((res) => {
      assertCompleteResponse(res, 'keyword');
      return res;
    }),
  );
  const casesSearch = failFast(es.search<Record<string, unknown>>(casesBody, opts).then(casesOf));
  const [emb, kw, vec, cs] = await Promise.allSettled([embedding, keywordSearch, vectorSearch, casesSearch]);
  // The embedding settled (reported or failed) before anything is thrown.
  if (emb.status === 'rejected') throw emb.reason;
  if (kw.status === 'rejected' || vec.status === 'rejected' || cs.status === 'rejected') throw failures[0];
  const channelsDone = performance.now();
  const { vector, usage } = emb.value;

  const ordered = (res: estypes.SearchResponse<Record<string, unknown>>) =>
    orderChannel(
      res.hits.hits.map((h) => ({ hit: toHit(String(h._id), h._source), score: h._score })),
      (h) => h.hit.id,
      (h) => (typeof h.score === 'number' ? h.score : Number.NaN),
    ).map((h) => h.hit);
  const keyword = ordered(kw.value);
  const vectorHits = ordered(vec.value);
  const casesChannel = orderChannel(cs.value, (h) => h.ntsbNo, (h) => h.score);
  const channelCases = { keyword: uniqueCases(keyword), vector: uniqueCases(vectorHits), cases: casesChannel.map((h) => h.ntsbNo) };
  const w = config.fusion.weights;
  const fusedPassages = asFusedHits(exactRrf([keyword, vectorHits], (p) => p.id, [w.keyword, w.vector], config.fusion.k));
  const fusedCases = exactRrf([channelCases.keyword, channelCases.vector, channelCases.cases], (n) => n, [w.keyword, w.vector, w.cases], config.fusion.k);
  const byCase = passagesByCase(fusedPassages);

  const toMap = fusedCases
    .slice(0, params.packCandidates)
    .map((c) => c.id)
    .filter((n) => !byCase.has(n));
  const mapping = await mapCasesToPassages(es, index, filter, vector, toMap, params, {
    passagesPerCase: mappingConfig.passagesPerCase,
    maxPassagesPerCase: mappingConfig.maxPassagesPerCase,
    maxCases: params.packCandidates,
    ...(q.signal ? { signal: q.signal } : {}),
  });
  const done = performance.now();

  return {
    version: config.version,
    index,
    indexVersion: contract.indexVersion,
    chunkerVersion: contract.chunkerVersion,
    eventAircraftQualification: contract.eventAircraftQualification,
    params,
    filter,
    casesIndex: casesIndex.index,
    casesIndexVersion: casesIndex.indexVersion,
    casesFilter,
    keyword,
    vector: vectorHits,
    casesChannel,
    channelCases,
    fusedPassages,
    fusedCases,
    cases: caseCandidates(fusedCases, byCase, mapping.passages, fusedPassages.length, 2),
    mapping: mapping.cases,
    queryEmbedding: usage,
    requests: {
      keyword: elideVectors(keywordBody),
      vector: elideVectors(sent.vector as estypes.SearchRequest),
      cases: elideVectors(casesBody),
      mapping: mapping.requests.map(elideVectors),
    },
    timingsMs: {
      checks: Math.round(checked - started),
      embed: Math.round((sent.embeddedAt ?? channelsDone) - checked),
      channels: Math.round(channelsDone - checked),
      mapping: Math.round(done - channelsDone),
      total: Math.round(done - started),
    },
  };
}

/** What every version's stage 1 hands to packing, with the full result for evaluations. */
export interface StageOne {
  version: RetrievalVersion;
  index: string;
  chunkerVersion: string;
  filter: Query[];
  params: RetrievalParams;
  cases: CaseCandidate<PassageHit>[];
  queryEmbedding: QueryEmbeddingUsage;
  /** Case-level versions: how many of the leading cases were mapped to passages, and how many could not be. */
  mapping: { mapped: number; unmapped: number } | null;
  /** Case-level versions: the cases index the cases channel read (name and `_meta` version). */
  casesIndex: { name: string; version: string } | null;
  detail: { level: 'passage'; result: CandidateResult } | { level: 'case'; result: CaseCandidateResult };
}

export interface VersionedQuery extends Omit<RetrievalQuery, 'params'> {
  /** Required by a case-level version: the cases index the dataset's manifest pairs with its passages index. */
  casesIndex?: string;
}

/** Stage 1 under `config` (module comment). */
export async function retrieveCandidatesWith(es: Client, embedder: Embedder | QueryEmbedder, config: RetrievalConfig, q: VersionedQuery): Promise<StageOne> {
  if (config.fusion.level === 'passage') {
    if (config.channels.cases || config.mapping) throw new Error(`${config.version}: a passage-level version has no cases channel`);
    const { casesIndex: _unused, ...query } = q;
    const r = await retrieveCandidates(es, embedder, { ...query, params: config.params });
    return { version: config.version, index: r.index, chunkerVersion: r.chunkerVersion, filter: r.filter, params: r.params, cases: r.cases, queryEmbedding: r.queryEmbedding, mapping: null, casesIndex: null, detail: { level: 'passage', result: r } };
  }
  if (!q.casesIndex) throw new Error(`${config.version} needs the dataset's cases index`);
  const r = await retrieveCaseCandidates(es, embedder, config, { ...q, casesIndex: q.casesIndex });
  const mapped = r.mapping.filter((m) => m.status === 'mapped').length;
  return {
    version: config.version,
    index: r.index,
    chunkerVersion: r.chunkerVersion,
    filter: r.filter,
    params: r.params,
    cases: r.cases,
    queryEmbedding: r.queryEmbedding,
    mapping: { mapped, unmapped: r.mapping.length - mapped },
    casesIndex: { name: r.casesIndex, version: r.casesIndexVersion },
    detail: { level: 'case', result: r },
  };
}
