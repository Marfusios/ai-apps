/**
 * Case → passage mapping (`retrieval.v2`; the gate's condition 4). A case the cases
 * channel nominated that neither passage channel returned has no passage to pack it by.
 * Each such case among the leading `packCandidates` of the fused ranking gets its own
 * best passages by the request's query vector, the vector already in memory: nothing
 * on this path, or in re-packing, embeds again.
 *
 * - **Per case, never a global cut.** Every case gets its own requests: first the count
 *   of its passages under the request's passages filter (`n`), then a kNN restricted to
 *   that case under the same filter with `k` = `num_candidates` = `n`. A long case cannot
 *   take another case's slots, and every request and result is bounded: at most
 *   `2 × maxCases` searches, at most `maxMappablePassages` hits a case.
 * - **Exact, and verified.** With `num_candidates` at least the number of documents the
 *   filter admits, Lucene scores every one of the case's passages exactly (a filtered kNN
 *   whose filter cost does not exceed `k` runs the exact search, as Elasticsearch
 *   documents), so the response must hold exactly `n` distinct passages, all of that
 *   case, each with a score. Anything else (fewer or more hits, a repeated id, a passage
 *   of another case, a missing score) is an integrity failure: `IncompleteSearchError`
 *   ('mapping') fails the whole retrieval, like an incomplete channel (G5: never a bundle
 *   from part of the answer).
 * - **Cut by score, then id.** The best `passagesPerCase` of the `n` are kept by score,
 *   then passage id, so ties at the cut do not depend on the order of the response.
 * - **Two outcomes that are not failures**, reported per case and never packed:
 *   `no_passages` (none under the filter: an event without aircraft rows, for instance)
 *   and `too_many_passages` (more than `maxMappablePassages`, the documented mapping-size
 *   limit; the largest dev case holds 63).
 * - **Fail fast.** All requests share one controller with the caller's signal: the first
 *   failed request aborts the others, in both waves, so a failing mapping leaves nothing
 *   running against Elasticsearch. Both waves share a deadline and run at most eight requests at once.
 * - **Complete answers only**: `allow_partial_search_results: false` and the completeness
 *   check on every response (`IncompleteSearchError('mapping')`).
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { orderChannel } from './case-fusion.js';
import type { Query } from './filters.js';
import { HIT_FIELDS, IncompleteSearchError, assertCompleteResponse, toHit, transport, type PassageHit, type RetrievalParams } from './hybrid.js';

/** Elasticsearch's limit on `num_candidates`: the most passages one exact search can consider. */
export const MAX_EXACT_CANDIDATES = 10_000;
/** Transport concurrency only: candidate/ranking/mapping semantics are unchanged. */
export const MAPPING_CONCURRENCY = 8;

export type UnmappedReason = 'no_passages' | 'too_many_passages';

export interface CaseMappingEntry {
  ntsbNo: string;
  status: 'mapped' | 'unmapped';
  reason: UnmappedReason | null;
  /** The case's passages under the request's passages filter. */
  passagesUnderFilter: number;
  /** Passages the kNN returned and verified (0 when it was not sent). */
  returned: number;
}

export interface CaseMapping {
  /** Each mapped case's passages, best first (score, then passage id), at most `passagesPerCase`. */
  passages: Map<string, PassageHit[]>;
  /** Every case asked for, in the order asked. */
  cases: CaseMappingEntry[];
  /** Request bodies (query vectors left in; elide them before storing). */
  requests: estypes.SearchRequest[];
  ms: number;
}

const caseFilter = (filter: readonly Query[], ntsbNo: string): Query[] => [...filter, { term: { ntsb_no: ntsbNo } }];

/** The count of one case's passages under the passages filter. */
export function mappingCountBody(index: string, filter: readonly Query[], ntsbNo: string): estypes.SearchRequest {
  return {
    index,
    size: 0,
    track_total_hits: true,
    allow_partial_search_results: false,
    query: { bool: { filter: caseFilter(filter, ntsbNo) } },
  };
}

/** Every one of one case's `n` passages under the passages filter, scored by `vector` (an exact search). */
export function mappingKnnBody(index: string, vector: readonly number[], filter: readonly Query[], ntsbNo: string, n: number): estypes.SearchRequest {
  return {
    index,
    size: n,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: [...HIT_FIELDS],
    knn: { field: 'embedding', query_vector: [...vector], k: n, num_candidates: n, filter: { bool: { filter: caseFilter(filter, ntsbNo) } } },
  };
}

function exactTotal(res: estypes.SearchResponse<unknown>): number {
  const t = res.hits.total;
  if (typeof t === 'number') return t;
  if (!t || t.relation !== 'eq' || !Number.isSafeInteger(t.value)) throw new IncompleteSearchError('mapping', 'no exact passage count');
  return t.value;
}

/**
 * The verified hits of one case's exact kNN: exactly `n` distinct passages of `ntsbNo`,
 * each with a finite score; any other response is an integrity failure.
 */
export function verifiedMappingHits(res: estypes.SearchResponse<Record<string, unknown>>, ntsbNo: string, n: number): { hit: PassageHit; score: number }[] {
  assertCompleteResponse(res, 'mapping');
  const hits = res.hits.hits.map((h) => ({ hit: toHit(String(h._id), h._source), score: h._score }));
  if (hits.length !== n) throw new IncompleteSearchError('mapping', `${hits.length} of the ${n} passages a mapped case holds under the filter`);
  const ids = new Set<string>();
  for (const h of hits) {
    if (h.hit.ntsbNo !== ntsbNo) throw new IncompleteSearchError('mapping', 'a passage of another case');
    if (ids.has(h.hit.id)) throw new IncompleteSearchError('mapping', 'a passage returned twice');
    if (typeof h.score !== 'number' || !Number.isFinite(h.score)) throw new IncompleteSearchError('mapping', 'a passage without a score');
    ids.add(h.hit.id);
  }
  return hits as { hit: PassageHit; score: number }[];
}

export interface MappingOptions {
  passagesPerCase: number;
  /**
   * The mapping-size limit: a case with more passages under the filter is not mapped
   * (`MappingConfig.maxPassagesPerCase` in the frozen configuration; not the packing limit
   * `RetrievalParams.maxPassagesPerCase`).
   */
  maxMappablePassages: number;
  /** The most cases one request may map (`packCandidates`). */
  maxCases: number;
  signal?: AbortSignal;
}

/** Map `cases` to their passages (module comment). */
export async function mapCasesToPassages(
  es: Client,
  index: string,
  filter: readonly Query[],
  vector: readonly number[],
  cases: readonly string[],
  params: Pick<RetrievalParams, 'timeoutMs'>,
  opts: MappingOptions,
): Promise<CaseMapping> {
  if (new Set(cases).size !== cases.length) throw new Error('a case is asked to be mapped twice');
  if (cases.length > opts.maxCases) throw new Error(`${cases.length} cases to map, at most ${opts.maxCases}`);
  if (!Number.isSafeInteger(opts.passagesPerCase) || opts.passagesPerCase < 1) throw new Error('invalid passages per mapped case');
  if (!Number.isSafeInteger(opts.maxMappablePassages) || opts.maxMappablePassages < opts.passagesPerCase || opts.maxMappablePassages > MAX_EXACT_CANDIDATES) {
    throw new Error('invalid mapping-size limit');
  }
  if (cases.length === 0) return { passages: new Map(), cases: [], requests: [], ms: 0 };
  const started = Date.now();
  // One controller for every mapping request: the first failure aborts the others.
  const siblings = new AbortController();
  const signal = AbortSignal.any([siblings.signal, AbortSignal.timeout(params.timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
  const t = transport(params, signal);
  const failFast = <T>(p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      siblings.abort();
      throw err;
    });
  const requests: estypes.SearchRequest[] = [];

  const wave = async <T, R>(values: readonly T[], task: (value: T) => Promise<R>): Promise<R[]> => {
    const answers = Array.from<R>({ length: values.length });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MAPPING_CONCURRENCY, values.length) }, async () => {
      while (next < values.length) {
        signal.throwIfAborted();
        const index = next++;
        answers[index] = await failFast(task(values[index]!));
      }
    }));
    return answers;
  };
  const counts = await wave(cases, async (ntsbNo) => {
    const body = mappingCountBody(index, filter, ntsbNo);
    requests.push(body);
    const res = await es.search(body, t);
    assertCompleteResponse(res, 'mapping');
    return exactTotal(res);
  });

  const entries: CaseMappingEntry[] = cases.map((ntsbNo, i) => ({ ntsbNo, status: 'unmapped', reason: 'no_passages', passagesUnderFilter: counts[i] as number, returned: 0 }));
  const passages = new Map<string, PassageHit[]>();
  await wave(entries, async (e) => {
    const n = e.passagesUnderFilter;
    if (n === 0) return;
    if (n > opts.maxMappablePassages) {
      e.reason = 'too_many_passages';
      return;
    }
    const body = mappingKnnBody(index, vector, filter, e.ntsbNo, n);
    requests.push(body);
    const res = await es.search<Record<string, unknown>>(body, t);
    const hits = verifiedMappingHits(res, e.ntsbNo, n);
    e.returned = hits.length;
    const best = orderChannel(hits, (h) => h.hit.id, (h) => h.score)
      .slice(0, opts.passagesPerCase).map((h) => h.hit);
    passages.set(e.ntsbNo, best);
    e.status = 'mapped';
    e.reason = null;
  });
  return { passages, cases: entries, requests, ms: Date.now() - started };
}
