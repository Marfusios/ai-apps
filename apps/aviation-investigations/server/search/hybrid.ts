/**
 * Hybrid evidence retrieval over the passages index (DESIGN §5; amendments A2, A3,
 * A11, A13). Task 16's retrieve stage calls `retrieveEvidence`; the retrieval
 * evaluation (`evals/retrieval/run.ts`) calls the two stages separately.
 *
 * **Stage 1, case candidates** (`retrieveCandidates`):
 * - The query is embedded once (`queryEmbeddingInput`, same model and dimensions as
 *   the index, checked against the index `_meta`).
 * - Two requests run in parallel with the same compiled filter (`compileFilters`):
 *   BM25 (`multi_match` over `text`, the filter as `bool.filter`) and kNN
 *   (`knn` on `embedding`, the same filter as its prefilter), `perChannel` passages
 *   each; kNN looks at `perChannel × numCandidatesFactor` candidates per shard. The
 *   filter is compiled once per request for the index's version: the contract of a
 *   `passages-v2` index turns on the event-level aircraft qualification (an
 *   event-scoped passage qualifies when every aircraft of its event satisfies the
 *   aircraft facets), a `passages-v1` index keeps event-scoped passages out.
 * - Reciprocal rank fusion in TypeScript (`rrfFuse`, k = 60), then the unique cases in
 *   fused order (`rankCases`). Evaluation measures case Recall@20 here.
 *
 * **Stage 2, packing** (`fetchAndPack`): one request fetches, under the same filter,
 * the text of each of the first `packCandidates` cases' best passages and every
 * probable-cause passage of those cases; `packEvidence` then builds the bundle (at
 * most 6 cases, 12 passages, 3 passages per case with the cause, the cause always
 * attached and counted, a token budget).
 *
 * Stage 2 fetches under that same compiled filter, so a case's cause variants are
 * attached exactly when its passages qualify, and an event-scoped passage stays
 * event-scoped (`scope: 'event'`, `aircraftKey: null`) whatever the filter.
 *
 * Nothing here falls back to keyword-only answers: without a published passages
 * index, or with an index that breaks the passages contract
 * (`server/search/passages-contract.ts`: generation, version, approved fingerprint,
 * embedding model and dimensions, chunker and input-template versions), retrieval
 * refuses with `RetrievalUnavailableError`. The contract is checked before the query
 * is embedded, under the request's deadline.
 *
 * Every search sets `allow_partial_search_results: false` and every response is
 * checked for completeness (not timed out, no failed shard, `successful` equal to
 * `total`; Elasticsearch counts pre-filter-skipped shards inside `successful`); an
 * incomplete channel or evidence fetch fails retrieval with `IncompleteSearchError`
 * instead of yielding a bundle from part of the index.
 *
 * Query embedding cost: retrieval embeds through the `Embedder` it is given and hands
 * the usage (model, tokens, USD, and whether the provider reported it) to
 * `RetrievalQuery.onQueryEmbedding` as soon as the embedding succeeds, before any
 * search, so an Elasticsearch or packing failure afterwards cannot lose a paid stage.
 * It never reserves money: the interactive request's admission reservation covers it
 * (Task 16 settles that reservation with an `embed` line from this usage, in full when
 * `billing` is `uncertain`), and the evaluation passes an embedder metered on the
 * ledger under `evaluation`.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import {
  QUERY_INPUT_TEMPLATE_VERSION,
  embeddingUsd,
  queryEmbeddingInput,
  type Embedder,
  type EmbedResult,
  type QueryEmbedder,
} from '../ai/embeddings.js';
import { MAX_CASES, MAX_PASSAGES } from '../ai/provider.js';
import { countTokens } from '../ai/tokens.js';
import { packEvidence, SECTION_ORDER, type PackOptions, type PackRole, type PassageKind, type SkipReason } from './evidence.js';
import { RetrievalFiltersSchema, compileFilters, type Query, type RetrievalFilters } from './filters.js';
import { IndexMetaError, abortAwareBackoff } from './index-meta.js';
import {
  PASSAGES_CONTRACTS,
  PassagesIndexIncompatibleError,
  checkPassagesIndex,
  type PassagesContract,
  type PassagesContracts,
} from './passages-contract.js';
import { RRF_K, asRanking, rankCases, rrfFuse, type CaseCandidate, type CaseScoring, type FusedHit } from './rrf.js';

/** Passages index versions this code reads, newest first (the worker builds the first: `PASSAGES_INDEX_VERSION`). */
export const SERVABLE_PASSAGES_VERSIONS: readonly string[] = PASSAGES_CONTRACTS.map((c) => c.indexVersion);

export interface RetrievalParams extends PackOptions {
  /** RRF constant. */
  rrfK: number;
  /** Passages each channel returns. */
  perChannel: number;
  /** kNN `num_candidates` = `perChannel × numCandidatesFactor` (at most 10,000). */
  numCandidatesFactor: number;
  /** How the case ranking orders cases: by their best passage, or by the sum of their passages. */
  caseScoring: CaseScoring;
  /** Leading candidate cases whose passages and causes are fetched for packing. */
  packCandidates: number;
  /** Per Elasticsearch request. */
  timeoutMs: number;
}

/**
 * Live retrieval defaults (DESIGN §5, amendments A11/A13). Every value is a starting
 * point for review gate G5, not a tuned result.
 */
export const RETRIEVAL_DEFAULTS: Readonly<RetrievalParams> = Object.freeze({
  rrfK: RRF_K,
  perChannel: 50,
  numCandidatesFactor: 4,
  caseScoring: 'best',
  maxCases: MAX_CASES,
  maxPassages: MAX_PASSAGES,
  retrievedPerCase: 2,
  maxPassagesPerCase: 3,
  maxEvidenceTokens: 10_000,
  packCandidates: 2 * MAX_CASES,
  timeoutMs: 5_000,
});

/** The evaluation's case-candidate stage (amendment A13): 100 passages per channel. */
export const CANDIDATE_STAGE_PER_CHANNEL = 100;

const MAX_PER_CHANNEL = 200;
const MAX_NUM_CANDIDATES = 10_000;

/** Defaults overridden by `over`, checked against the hard limits fixed in code. */
export function retrievalParams(over: Partial<RetrievalParams> = {}): RetrievalParams {
  const p: RetrievalParams = { ...RETRIEVAL_DEFAULTS, ...over };
  const int = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
  const problems: string[] = [];
  if (!(Number.isFinite(p.rrfK) && p.rrfK >= 0 && p.rrfK <= 1000)) problems.push('rrfK');
  if (!int(p.perChannel, 1, MAX_PER_CHANNEL)) problems.push('perChannel');
  if (!int(p.numCandidatesFactor, 1, 50) || p.perChannel * p.numCandidatesFactor > MAX_NUM_CANDIDATES) problems.push('numCandidatesFactor');
  if (p.caseScoring !== 'best' && p.caseScoring !== 'sum') problems.push('caseScoring');
  if (!int(p.maxCases, 1, MAX_CASES)) problems.push('maxCases');
  if (!int(p.maxPassages, 1, MAX_PASSAGES)) problems.push('maxPassages');
  if (!int(p.retrievedPerCase, 1, MAX_PASSAGES)) problems.push('retrievedPerCase');
  if (!int(p.maxPassagesPerCase, 1, MAX_PASSAGES)) problems.push('maxPassagesPerCase');
  if (!int(p.maxEvidenceTokens, 1, 16_000)) problems.push('maxEvidenceTokens');
  if (!int(p.packCandidates, p.maxCases, 10 * MAX_CASES)) problems.push('packCandidates');
  if (!int(p.timeoutMs, 100, 60_000)) problems.push('timeoutMs');
  if (problems.length > 0) throw new Error(`invalid retrieval parameters: ${problems.join(', ')}`);
  return p;
}

export const numCandidates = (p: Pick<RetrievalParams, 'perChannel' | 'numCandidatesFactor'>): number =>
  p.perChannel * p.numCandidatesFactor;

// ---------------------------------------------------------------------------
// Errors

/**
 * `no_passages_index`: the dataset publishes none; `no_cases_index`: a version with the
 * cases channel finds no cases index paired with the dataset's passages index;
 * `index_mismatch`: an index breaks its contract (passages, or cases: generation, servable version).
 */
export type RetrievalUnavailableReason = 'no_passages_index' | 'no_cases_index' | 'index_mismatch';

/** Retrieval cannot serve evidence for this dataset; AI answers must stay off (no keyword fallback). */
export class RetrievalUnavailableError extends Error {
  constructor(
    readonly reason: RetrievalUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'RetrievalUnavailableError';
  }
}

/** A search answered for part of the index only: timed out, failed shards or missing shards (or, for the cases channel and mapping, a malformed answer). */
export class IncompleteSearchError extends Error {
  constructor(
    readonly request: 'keyword' | 'vector' | 'fetch' | 'cases' | 'mapping',
    reason: string,
  ) {
    super(`the ${request} search was incomplete: ${reason}`);
    this.name = 'IncompleteSearchError';
  }
}

/**
 * Throw unless `res` covers the whole index: not timed out, no failed shard, and
 * `successful === total`. Elasticsearch counts shards skipped by the pre-filter (they
 * hold no match) inside `successful`, so `skipped` is a subset of `successful` and is
 * never added to it; a report with more skipped than successful shards is refused.
 */
export function assertCompleteResponse(res: Pick<estypes.SearchResponse<unknown>, 'timed_out' | '_shards'>, request: IncompleteSearchError['request']): void {
  if (res.timed_out !== false) throw new IncompleteSearchError(request, res.timed_out ? 'timed out' : 'no timed_out flag');
  const s = res._shards;
  if (!s || typeof s.total !== 'number') throw new IncompleteSearchError(request, 'no shard report');
  const failed = Math.max(s.failed ?? 0, s.failures?.length ?? 0);
  if (failed > 0) throw new IncompleteSearchError(request, `${failed} shard(s) failed`);
  const skipped = s.skipped ?? 0;
  if (s.successful !== s.total || skipped > s.successful) {
    throw new IncompleteSearchError(request, `${s.successful} of ${s.total} shard(s) successful (${skipped} of them skipped)`);
  }
}

// ---------------------------------------------------------------------------
// Passages as retrieval reads them

/** A passage's identity and attribution (the index `_source` minus text and vector). */
export interface PassageHit {
  readonly id: string;
  readonly ntsbNo: string;
  readonly sectionId: string;
  readonly revisionId: string;
  readonly sectionKind: PassageKind;
  readonly scope: 'aircraft' | 'event';
  readonly aircraftSpecific: boolean;
  /** The aircraft of an aircraft-scoped passage; null when event-scoped. */
  readonly aircraftKey: number | null;
  readonly start: number;
  readonly end: number;
  readonly part: number;
  readonly parts: number;
  readonly continuation: boolean;
}

export interface PassageWithText extends PassageHit {
  readonly text: string;
}

/** `_source` fields of a channel hit: no text, never the vector. */
export const HIT_FIELDS = [
  'passage_id',
  'ntsb_no',
  'section_id',
  'revision_id',
  'section_kind',
  'scope',
  'aircraft_specific',
  'aircraft_key',
  'start',
  'end',
  'part',
  'parts',
  'continuation',
] as const;

export class MalformedPassageError extends Error {
  constructor(id: string, field: string) {
    super(`passage ${id} in the passages index has an invalid ${field}`);
    this.name = 'MalformedPassageError';
  }
}

/** A passage hit from an index document's id and `_source` (validated; exported for the retrieval experiments). */
export function toHit(id: string, s: Record<string, unknown> | undefined): PassageHit {
  const src = s ?? {};
  const str = (k: string): string => {
    const v = src[k];
    if (typeof v !== 'string' || v === '') throw new MalformedPassageError(id, k);
    return v;
  };
  const int = (k: string): number => {
    const v = src[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new MalformedPassageError(id, k);
    return v;
  };
  const bool = (k: string): boolean => {
    const v = src[k];
    if (typeof v !== 'boolean') throw new MalformedPassageError(id, k);
    return v;
  };
  if (str('passage_id') !== id) throw new MalformedPassageError(id, 'passage_id');
  const kind = str('section_kind');
  if (!Object.hasOwn(SECTION_ORDER, kind)) throw new MalformedPassageError(id, 'section_kind');
  const scope = str('scope');
  if (scope !== 'aircraft' && scope !== 'event') throw new MalformedPassageError(id, 'scope');
  const aircraftSpecific = bool('aircraft_specific');
  const key = src.aircraft_key;
  if (aircraftSpecific !== (scope === 'aircraft')) throw new MalformedPassageError(id, 'aircraft_specific');
  if (aircraftSpecific ? typeof key !== 'number' || !Number.isSafeInteger(key) : key !== null && key !== undefined) {
    throw new MalformedPassageError(id, 'aircraft_key');
  }
  return {
    id,
    ntsbNo: str('ntsb_no'),
    sectionId: str('section_id'),
    revisionId: str('revision_id'),
    sectionKind: kind as PassageKind,
    scope,
    aircraftSpecific,
    aircraftKey: aircraftSpecific ? (key as number) : null,
    start: int('start'),
    end: int('end'),
    part: int('part'),
    parts: int('parts'),
    continuation: bool('continuation'),
  };
}

function hitsOf(res: estypes.SearchResponse<Record<string, unknown>>): PassageHit[] {
  return res.hits.hits.map((h) => toHit(String(h._id), h._source));
}

// ---------------------------------------------------------------------------
// Request bodies (pure; exported for tests and the evaluation report)

/**
 * The sort that makes a lexical channel's cut deterministic (task 10e fix round 1): score,
 * then the id, applied by Elasticsearch while it collects the top `size`, so equal-score
 * hits at the cut are chosen by the id, not by Lucene's document order.
 */
export const PASSAGE_TIEBREAK_SORT: estypes.SortCombinations[] = [{ _score: { order: 'desc' } }, { passage_id: { order: 'asc' } }];

/**
 * The BM25 channel: `multi_match` over the passage text, the compiled filter as
 * `bool.filter`. `tiebreak` (case-level versions) adds `PASSAGE_TIEBREAK_SORT`;
 * `retrieval.v1` sends the body without it, as before.
 */
export function keywordChannelBody(index: string, text: string, filter: Query[], size: number, opts: { tiebreak?: boolean } = {}): estypes.SearchRequest {
  return {
    index,
    size,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: [...HIT_FIELDS],
    query: {
      bool: {
        must: [{ multi_match: { query: text, fields: ['text'], type: 'best_fields', operator: 'or' } }],
        filter,
      },
    },
    ...(opts.tiebreak ? { sort: PASSAGE_TIEBREAK_SORT.map((x) => ({ ...(x as object) }) as estypes.SortCombinations) } : {}),
  };
}

/** The kNN channel: approximate kNN on `embedding` with the compiled filter as its prefilter. */
export function vectorChannelBody(
  index: string,
  vector: readonly number[],
  filter: Query[],
  k: number,
  candidates: number,
): estypes.SearchRequest {
  return {
    index,
    size: k,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: [...HIT_FIELDS],
    knn: { field: 'embedding', query_vector: [...vector], k, num_candidates: candidates, filter: { bool: { filter } } },
  };
}

/** Stage 2's fetch: given passages by id and every probable cause of the given cases, under the same filter. */
export function evidenceFetchBody(index: string, filter: Query[], ids: readonly string[], causeCases: readonly string[], size: number): estypes.SearchRequest {
  const wanted: Query[] = [];
  if (ids.length > 0) wanted.push({ ids: { values: [...ids] } });
  if (causeCases.length > 0) {
    wanted.push({ bool: { filter: [{ terms: { ntsb_no: [...causeCases] } }, { term: { section_kind: 'probable_cause' } }] } });
  }
  return {
    index,
    size,
    track_total_hits: true,
    allow_partial_search_results: false,
    _source: [...HIT_FIELDS, 'text'],
    query: { bool: { filter: [...filter, { bool: { should: wanted, minimum_should_match: 1 } }] } },
    sort: [{ ntsb_no: { order: 'asc' } }, { section_id: { order: 'asc' } }, { part: { order: 'asc' } }],
  };
}

/** A copy of a request body with every query vector replaced by a note (reports, traces, review). */
export function elideVectors(body: estypes.SearchRequest): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const knns = copy.knn === undefined ? [] : Array.isArray(copy.knn) ? copy.knn : [copy.knn];
  for (const k of knns as Record<string, unknown>[]) {
    if (Array.isArray(k.query_vector)) k.query_vector = `<${k.query_vector.length}-dimension query vector elided>`;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// The passages index of a dataset

export interface RetrievalDataset {
  generationId: number;
  /** From the active `dataset_manifests` row; null on a keyword-only manifest. */
  passagesIndex: string | null;
}

/** Indexes that passed the contract, per generation, embedding and accepted contracts (bounded), with their version's contract. */
const verified = new Map<string, PassagesContract>();

/** Forget every remembered pass, so the next check reads the index again (evaluation: a cold start). */
export function forgetPassagesIndexChecks(): void {
  verified.clear();
}

export interface IndexCheckOptions {
  /** The accepted contracts (tests and future versions); default `PASSAGES_CONTRACTS`. */
  contracts?: PassagesContracts;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A dataset's passages index that meets the contract of its version. */
export interface ServableIndex {
  index: string;
  /** Its version's contract: decides the event-level aircraft qualification. */
  contract: PassagesContract;
}

/**
 * Refuse unless the dataset names a passages index that meets the passages contract
 * of its version for its generation and the embedder's model and dimensions. The
 * metadata lookup is bounded by `timeoutMs` and `signal`; a passed check is
 * remembered per index, generation, embedding and accepted contracts (failures and
 * aborted lookups are not).
 */
export async function assertServablePassagesIndex(
  es: Client,
  dataset: RetrievalDataset,
  embedder: Pick<Embedder, 'model' | 'dims'>,
  opts: IndexCheckOptions = {},
): Promise<ServableIndex> {
  const index = dataset.passagesIndex;
  if (!index) {
    throw new RetrievalUnavailableError('no_passages_index', `generation ${dataset.generationId} has no published passages index`);
  }
  const contracts = opts.contracts ?? PASSAGES_CONTRACTS;
  const key = JSON.stringify([index, dataset.generationId, embedder.model, embedder.dims, contracts]);
  const known = verified.get(key);
  if (known) return { index, contract: known };
  let contract: PassagesContract;
  try {
    ({ contract } = await checkPassagesIndex(es, index, { generationId: dataset.generationId, model: embedder.model, dims: embedder.dims }, {
      contracts,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }));
  } catch (err) {
    if (err instanceof PassagesIndexIncompatibleError || err instanceof IndexMetaError) {
      throw new RetrievalUnavailableError('index_mismatch', err.message);
    }
    throw err;
  }
  if (verified.size >= 16) verified.clear();
  verified.set(key, contract);
  return { index, contract };
}

// ---------------------------------------------------------------------------
// Stage 1: case candidates

export interface RetrievalQuery {
  dataset: RetrievalDataset;
  /** The question; embedded for the kNN channel (at most `MAX_QUERY_INPUT_TOKENS`). */
  text: string;
  /** BM25 text when it differs from `text` (e.g. the scope stage's terms); default `text`. */
  keywordText?: string;
  /** Validated filters (`RetrievalFiltersSchema`); parsed again here. */
  filters?: RetrievalFilters;
  params?: Partial<RetrievalParams>;
  signal?: AbortSignal;
  /**
   * Called once, as soon as the embedder returns and before the vector is checked or
   * any search runs: the caller records the paid stage here, so a later failure cannot
   * lose it.
   */
  onQueryEmbedding?: (usage: QueryEmbeddingUsage) => void;
  /** The accepted passages contracts (tests and future versions); default `PASSAGES_CONTRACTS`. */
  contracts?: PassagesContracts;
}

export interface QueryEmbeddingUsage {
  model: string;
  dims: number;
  inputTemplate: string;
  /** Provider-reported billed tokens, or the counted input when `billing` is `uncertain`. */
  tokens: number;
  usd: number;
  /** `uncertain`: the provider reported no usable usage; settle the stage in full. */
  billing: 'reported' | 'uncertain';
}

export interface RetrievalRequests {
  keyword: Record<string, unknown>;
  /** The kNN body with its query vector elided. */
  vector: Record<string, unknown>;
  fetch: Record<string, unknown> | null;
}

export interface CandidateResult {
  index: string;
  /** The index's version (its contract decided the filter). */
  indexVersion: string;
  /** The chunker version of the index's contract: the canonical `passages` rows its passages come from. */
  chunkerVersion: string;
  /** Whether the filter lets event-scoped passages of qualifying events satisfy aircraft facets. */
  eventAircraftQualification: boolean;
  params: RetrievalParams;
  /** The compiled filter of both channels; stage 2 fetches under the same clauses. */
  filter: Query[];
  keyword: PassageHit[];
  vector: PassageHit[];
  fused: FusedHit<PassageHit>[];
  cases: CaseCandidate<PassageHit>[];
  queryEmbedding: QueryEmbeddingUsage;
  requests: Omit<RetrievalRequests, 'fetch'>;
  timingsMs: { embed: number; channels: number };
}

/** Transport options of one retrieval request: the per-request timeout, the request's signal, and no retry wait once it aborted. */
export const transport = (p: Pick<RetrievalParams, 'timeoutMs'>, signal?: AbortSignal) => ({
  requestTimeout: p.timeoutMs,
  ...(signal ? { signal, retryBackoff: abortAwareBackoff(signal) } : {}),
});

/**
 * Embed the query and report its usage through `onUsage` as soon as the embedder
 * returns, before the vector is checked: a paid embedding is reported even when its
 * vector turns out unusable.
 */
export async function embedQuery(
  embedder: Embedder | QueryEmbedder,
  text: string,
  signal: AbortSignal | undefined,
  onUsage: ((usage: QueryEmbeddingUsage) => void) | undefined,
): Promise<{ vector: number[]; usage: QueryEmbeddingUsage }> {
  const input = queryEmbeddingInput(text);
  const res: EmbedResult =
    'embedWithSignal' in embedder ? await embedder.embedWithSignal([input], signal) : await embedder.embed([input]);
  const usage: QueryEmbeddingUsage = {
    model: embedder.model,
    dims: embedder.dims,
    inputTemplate: QUERY_INPUT_TEMPLATE_VERSION,
    tokens: res.tokens,
    usd: embeddingUsd(res.tokens, embedder.usdPerMillionTokens),
    billing: res.usageUncertain ? 'uncertain' : 'reported',
  };
  onUsage?.(usage);
  const v = res.vectors[0];
  if (res.vectors.length !== 1 || !v || v.length !== embedder.dims) throw new Error('the query embedding has the wrong shape');
  return { vector: Array.from(v), usage };
}

/** Stage 1: both channels with one filter, fused, deduplicated to cases. */
export async function retrieveCandidates(es: Client, embedder: Embedder | QueryEmbedder, q: RetrievalQuery): Promise<CandidateResult> {
  const params = retrievalParams(q.params);
  const filters = RetrievalFiltersSchema.parse(q.filters ?? {});
  const keywordText = (q.keywordText ?? q.text).replace(/\s+/gu, ' ').trim();
  if (keywordText === '') throw new Error('the query is empty');
  const { index, contract } = await assertServablePassagesIndex(es, q.dataset, embedder, {
    timeoutMs: params.timeoutMs,
    ...(q.contracts ? { contracts: q.contracts } : {}),
    ...(q.signal ? { signal: q.signal } : {}),
  });
  const filter = compileFilters(filters, { eventAircraftQualification: contract.eventAircraftQualification }).bool.filter;

  const t0 = Date.now();
  const { vector, usage } = await embedQuery(embedder, q.text, q.signal, q.onQueryEmbedding);
  const t1 = Date.now();
  const keywordBody = keywordChannelBody(index, keywordText, filter, params.perChannel);
  const vectorBody = vectorChannelBody(index, vector, filter, params.perChannel, numCandidates(params));
  const opts = transport(params, q.signal);
  const [kw, vec] = await Promise.all([
    es.search<Record<string, unknown>>(keywordBody, opts),
    es.search<Record<string, unknown>>(vectorBody, opts),
  ]);
  assertCompleteResponse(kw, 'keyword');
  assertCompleteResponse(vec, 'vector');
  const keyword = hitsOf(kw);
  const vectorHits = hitsOf(vec);
  const fused = rrfFuse([keyword, vectorHits], params.rrfK);
  return {
    index,
    indexVersion: contract.indexVersion,
    chunkerVersion: contract.chunkerVersion,
    eventAircraftQualification: contract.eventAircraftQualification,
    params,
    filter,
    keyword,
    vector: vectorHits,
    fused,
    cases: rankCases(fused, params.caseScoring),
    queryEmbedding: usage,
    requests: { keyword: elideVectors(keywordBody), vector: elideVectors(vectorBody) },
    timingsMs: { embed: t1 - t0, channels: Date.now() - t1 },
  };
}

/** The case ranking of one channel alone or of the fusion (evaluation baselines). */
export function rankingOf(c: Pick<CandidateResult, 'keyword' | 'vector' | 'fused' | 'params'>, mode: 'keyword' | 'vector' | 'hybrid'): CaseCandidate<PassageHit>[] {
  const fused = mode === 'hybrid' ? c.fused : asRanking(mode === 'keyword' ? c.keyword : c.vector, c.params.rrfK);
  return rankCases(fused, c.params.caseScoring);
}

// ---------------------------------------------------------------------------
// Stage 2: packing

export interface EvidencePassage extends PassageWithText {
  role: PackRole;
  /** The case's justification (its best retrieved passage, its causes): never trimmed. */
  reserved: boolean;
  /** `cl100k_base` tokens of `text`. */
  tokens: number;
  /** 1-based rank in the ranking the bundle was packed from; null for an attached cause. */
  fusedRank: number | null;
  fusedScore: number | null;
}

export interface EvidenceCase {
  ntsbNo: string;
  caseRank: number;
  caseScore: number;
  /** Reading order: factual, analysis, probable cause. */
  passages: EvidencePassage[];
}

export interface PackedEvidence {
  cases: EvidenceCase[];
  passages: number;
  tokens: number;
  skipped: { ntsbNo: string; caseRank: number; reason: SkipReason }[];
  trimmed: { id: string; ntsbNo: string; fusedRank: number }[];
  /** The fetch body (no vectors). */
  request: Record<string, unknown> | null;
  timingMs: number;
}

/** Stage 2: fetch the leading cases' passages and causes under `filter`, then pack. */
export async function fetchAndPack(
  es: Client,
  index: string,
  filter: Query[],
  ranking: readonly CaseCandidate<PassageHit>[],
  params: RetrievalParams,
  signal?: AbortSignal,
): Promise<PackedEvidence> {
  const started = Date.now();
  const leading = ranking.slice(0, params.packCandidates);
  if (leading.length === 0) return { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: [], request: null, timingMs: 0 };
  const ids = leading.flatMap((c) =>
    c.passages.filter((h) => h.item.sectionKind !== 'probable_cause').slice(0, params.maxPassagesPerCase).map((h) => h.id),
  );
  const causeCases = leading.map((c) => c.ntsbNo);
  // Room for every id plus generous room for causes (one per aircraft and continuation part).
  const size = ids.length + 20 * causeCases.length;
  const body = evidenceFetchBody(index, filter, ids, causeCases, size);
  const res = await es.search<Record<string, unknown>>(body, transport(params, signal));
  assertCompleteResponse(res, 'fetch');
  const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
  // More matched than fit the fetch (a case with more cause passages than the room): fail
  // closed as an incomplete search (the step records `incomplete_search`), never pack a part.
  if (total > res.hits.hits.length) throw new IncompleteSearchError('fetch', `matched ${total} passages but returned ${res.hits.hits.length}`);

  const texts = new Map<string, PassageWithText>();
  const causes = new Map<string, PassageWithText[]>();
  for (const h of res.hits.hits) {
    const hit = toHit(String(h._id), h._source);
    const text = h._source?.text;
    if (typeof text !== 'string' || text === '') throw new MalformedPassageError(hit.id, 'text');
    const p: PassageWithText = { ...hit, text };
    texts.set(p.id, p);
    if (p.sectionKind === 'probable_cause') causes.set(p.ntsbNo, [...(causes.get(p.ntsbNo) ?? []), p]);
  }
  // Pack only fetched passages (each case's best non-cause passages and its causes).
  const cases: CaseCandidate<PassageWithText>[] = leading.map((c) => ({
    ntsbNo: c.ntsbNo,
    rank: c.rank,
    score: c.score,
    passages: c.passages.flatMap((h) => {
      const p = texts.get(h.id);
      return p ? [{ ...h, item: p }] : [];
    }),
  }));
  const tokenCache = new Map<string, number>();
  const tokensOf = (p: PassageWithText) => {
    let n = tokenCache.get(p.id);
    if (n === undefined) {
      n = countTokens(p.text);
      tokenCache.set(p.id, n);
    }
    return n;
  };
  const packed = packEvidence({ cases, probableCauses: causes, tokensOf }, params);
  return {
    cases: packed.cases.map((c) => ({
      ntsbNo: c.ntsbNo,
      caseRank: c.caseRank,
      caseScore: c.caseScore,
      passages: c.passages.map((p) => ({
        ...p.passage,
        role: p.role,
        reserved: p.reserved,
        tokens: p.tokens,
        fusedRank: p.fusedRank,
        fusedScore: p.fusedScore,
      })),
    })),
    passages: packed.passages,
    tokens: packed.tokens,
    skipped: packed.skipped,
    trimmed: packed.trimmed,
    request: elideVectors(body),
    timingMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Both stages

export interface RetrievalResult {
  generationId: number;
  passagesIndex: string;
  params: RetrievalParams;
  cases: EvidenceCase[];
  passages: number;
  tokens: number;
  candidates: { keyword: number; vector: number; fused: number; cases: number };
  skipped: PackedEvidence['skipped'];
  trimmed: PackedEvidence['trimmed'];
  queryEmbedding: QueryEmbeddingUsage;
  requests: RetrievalRequests;
  timingsMs: { embed: number; channels: number; fetch: number };
}

/**
 * Retrieve the evidence bundle for one question: case candidates from both channels
 * (`perChannel` each), then packing. Refuses with `RetrievalUnavailableError` when
 * the dataset has no servable passages index.
 */
export async function retrieveEvidence(es: Client, embedder: Embedder | QueryEmbedder, q: RetrievalQuery): Promise<RetrievalResult> {
  const c = await retrieveCandidates(es, embedder, q);
  const packed = await fetchAndPack(es, c.index, c.filter, c.cases, c.params, q.signal);
  return {
    generationId: q.dataset.generationId,
    passagesIndex: c.index,
    params: c.params,
    cases: packed.cases,
    passages: packed.passages,
    tokens: packed.tokens,
    candidates: { keyword: c.keyword.length, vector: c.vector.length, fused: c.fused.length, cases: c.cases.length },
    skipped: packed.skipped,
    trimmed: packed.trimmed,
    queryEmbedding: c.queryEmbedding,
    requests: { ...c.requests, fetch: packed.request },
    timingsMs: { ...c.timingsMs, fetch: packed.timingMs },
  };
}
