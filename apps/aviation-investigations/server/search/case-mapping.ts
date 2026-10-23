/**
 * Case → passage mapping (`retrieval.v2`; the gate's condition 4). A case the cases
 * channel nominated that neither passage channel returned has no passage to pack it by.
 * Each such case among the leading `packCandidates` of the fused ranking gets its own
 * best passages by the request's query vector, the vector already in memory: nothing
 * on this path, or in re-packing, embeds again.
 *
 * - **Per case, never a global cut.** Every case gets its own requests: first the count
 *   of its passages under the request's passages filter (`n`), then a kNN restricted to
 *   that case under the same filter, `k = min(passagesPerCase, n)` and `num_candidates =
 *   n`. A long case cannot take another case's slots, and every request and result is
 *   bounded: at most `2 × maxCases` searches, at most `passagesPerCase` passages a case.
 * - **Exhaustive by construction, verified.** With `num_candidates` at least the number
 *   of documents the filter admits, Lucene scores every one of the case's passages
 *   exactly (a filtered kNN whose filter cost does not exceed `k` runs the exact search),
 *   so the kNN must return exactly `min(passagesPerCase, n)` passages, all of that case;
 *   the count is what proves it, not a large `num_candidates`. Every case asked for is
 *   reported: `mapped` with its passages (best first: score, then passage id), or
 *   `unmapped` with a fixed reason: `no_passages` (none under the filter, e.g. an event
 *   without aircraft rows) or `incomplete` (a kNN that did not return what the count
 *   requires, or more passages than one exact search can consider). An unmapped case is
 *   never packed (packing skips a case without a retrieved passage).
 * - **Complete answers only**: `allow_partial_search_results: false` and the completeness
 *   check on every response (`IncompleteSearchError('mapping')`).
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { orderChannel } from './case-fusion.js';
import type { Query } from './filters.js';
import { HIT_FIELDS, IncompleteSearchError, assertCompleteResponse, toHit, transport, type PassageHit, type RetrievalParams } from './hybrid.js';

/** Elasticsearch's limit on `num_candidates`: a case with more passages cannot be searched exactly. */
export const MAX_EXACT_CANDIDATES = 10_000;

export type UnmappedReason = 'no_passages' | 'incomplete';

export interface CaseMappingEntry {
  ntsbNo: string;
  status: 'mapped' | 'unmapped';
  reason: UnmappedReason | null;
  /** The case's passages under the request's passages filter. */
  passagesUnderFilter: number;
  /** Passages the kNN returned (0 when it was not sent). */
  returned: number;
}

export interface CaseMapping {
  /** Each mapped case's passages, best first. */
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

/** One case's best `k` passages by `vector` under the passages filter, considering all `candidates` of them. */
export function mappingKnnBody(index: string, vector: readonly number[], filter: readonly Query[], ntsbNo: string, k: number, candidates: number): estypes.SearchRequest {
  return {
    index,
    size: k,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: [...HIT_FIELDS],
    knn: { field: 'embedding', query_vector: [...vector], k, num_candidates: candidates, filter: { bool: { filter: caseFilter(filter, ntsbNo) } } },
  };
}

function exactTotal(res: estypes.SearchResponse<unknown>): number {
  const t = res.hits.total;
  if (typeof t === 'number') return t;
  if (!t || t.relation !== 'eq' || !Number.isSafeInteger(t.value)) throw new IncompleteSearchError('mapping', 'no exact passage count');
  return t.value;
}

export interface MappingOptions {
  passagesPerCase: number;
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
  if (cases.length === 0) return { passages: new Map(), cases: [], requests: [], ms: 0 };
  const started = Date.now();
  const t = transport(params, opts.signal);
  const requests: estypes.SearchRequest[] = [];

  const counts = await Promise.all(
    cases.map(async (ntsbNo) => {
      const body = mappingCountBody(index, filter, ntsbNo);
      requests.push(body);
      const res = await es.search(body, t);
      assertCompleteResponse(res, 'mapping');
      return exactTotal(res);
    }),
  );

  const entries: CaseMappingEntry[] = cases.map((ntsbNo, i) => ({ ntsbNo, status: 'unmapped', reason: 'no_passages', passagesUnderFilter: counts[i] as number, returned: 0 }));
  const passages = new Map<string, PassageHit[]>();
  await Promise.all(
    entries.map(async (e) => {
      const n = e.passagesUnderFilter;
      if (n === 0) return;
      if (n > MAX_EXACT_CANDIDATES) {
        e.reason = 'incomplete';
        return;
      }
      const k = Math.min(opts.passagesPerCase, n);
      const body = mappingKnnBody(index, vector, filter, e.ntsbNo, k, n);
      requests.push(body);
      const res = await es.search<Record<string, unknown>>(body, t);
      assertCompleteResponse(res, 'mapping');
      const hits = res.hits.hits.map((h) => ({ hit: toHit(String(h._id), h._source), score: h._score }));
      e.returned = hits.length;
      const ids = new Set(hits.map((h) => h.hit.id));
      if (hits.length !== k || ids.size !== hits.length || hits.some((h) => h.hit.ntsbNo !== e.ntsbNo || typeof h.score !== 'number')) {
        e.reason = 'incomplete';
        return;
      }
      const ordered = orderChannel(hits, (h) => h.hit.id, (h) => h.score as number).map((h) => h.hit);
      passages.set(e.ntsbNo, ordered);
      e.status = 'mapped';
      e.reason = null;
    }),
  );
  return { passages, cases: entries, requests, ms: Date.now() - started };
}
