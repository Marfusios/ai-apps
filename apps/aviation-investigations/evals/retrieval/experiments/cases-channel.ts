/**
 * Case-level lexical retrieval over the existing cases index (task 10d, phase A; the
 * reviewer's "case-level lexical retrieval" and "E5 on the existing field"). No new
 * index: BM25 over the cases index's narrative fields, alone or with `findings_text`
 * (one value per distinct finding description).
 *
 * **Filter.** The case channel must reach exactly the cases the passages channels can
 * reach, so it is composed from the shared compiler (`server/search/filters.ts`):
 * - `filterClauses('cases', ...)` without its aircraft clause: `country: USA`, the event
 *   facets and the years, exactly as for keyword search; plus `answer_eligible: true`,
 *   the passages index's compulsory clause (AI evidence is the answer-eligible cohort);
 * - with an aircraft facet, the passages-v2 event-level qualification restated on the
 *   cases index's nested `aircraft` (which holds every aircraft of the event, verified
 *   at build): a single-aircraft event qualifies when its aircraft meets the facets
 *   (`aircraftInner`, where `blank` matches a missing value, as the passages
 *   own-aircraft branch); an event with two or more aircraft qualifies when it has
 *   aircraft and none fails the full conjunction of the active facets (a missing value
 *   fails, `blank` is dropped, and a facet whose only value is `blank` leaves this
 *   branch out), as the passages event branch. The keyword-search "some aircraft
 *   matches" semantics of the cases index would reach mixed events retrieval cannot.
 *   The preflight checks on the target that both filters reach the same cases for every
 *   question.
 *
 * **Query.** `multi_match` `best_fields`, operator `or`, over the field set: the
 * passage BM25 channel's query form; the index's search analyzer applies.
 *
 * **Mapping to passages.** Packing needs passages. A case only this channel found gets
 * its passages from one kNN request restricted to those cases under the passages
 * filter (`num_candidates` above the passages they hold, so the search is exact): each
 * case's passages in cosine order. The existing fetch then attaches every probable
 * cause and packs as usual.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { BLANK } from '../../../shared/contracts/search.js';
import {
  AIRCRAFT_FACET_FIELD,
  AIRCRAFT_FACET_KEYS,
  RetrievalFiltersSchema,
  aircraftInner,
  aircraftSelectionOf,
  filterClauses,
  type AircraftSelection,
  type Query,
  type RetrievalFilters,
} from '../../../server/search/filters.js';
import { HIT_FIELDS, assertCompleteResponse, toHit, type PassageHit, type RetrievalParams } from '../../../server/search/hybrid.js';
import { CASE_FIELD_SETS, type CaseChannel, type CaseFieldSet } from './config.js';

const CASE_NO = /^[A-Z0-9]{6,16}$/;

/** The conjunction one aircraft of a multi-aircraft event must meet, on the nested `aircraft`; null when unsatisfiable (a blank-only facet). */
export function caseAircraftConjunction(selection: AircraftSelection): Query[] | null {
  const out: Query[] = [];
  for (const facet of AIRCRAFT_FACET_KEYS) {
    const values = selection[facet];
    if (!values || values.length === 0) continue;
    const codes = values.filter((v) => v !== BLANK);
    if (codes.length === 0) return null;
    out.push({ terms: { [AIRCRAFT_FACET_FIELD[facet]]: codes } });
  }
  return out.length > 0 ? out : null;
}

/** The passages-v2 aircraft qualification on the cases index; null without an aircraft facet. */
export function caseAircraftClause(selection: AircraftSelection): Query | null {
  const inner = aircraftInner(selection);
  if (inner.length === 0) return null;
  const single: Query = {
    bool: { filter: [{ term: { aircraft_count: 1 } }, { nested: { path: 'aircraft', query: { bool: { filter: inner } } } }] },
  };
  const conjunction = caseAircraftConjunction(selection);
  if (!conjunction) return single;
  const several: Query = {
    bool: {
      filter: [{ range: { aircraft_count: { gte: 2 } } }, { nested: { path: 'aircraft', query: { match_all: {} } } }],
      must_not: [{ nested: { path: 'aircraft', query: { bool: { must_not: [{ bool: { filter: conjunction } }] } } } }],
    },
  };
  return { bool: { should: [single, several], minimum_should_match: 1 } };
}

/** The case channel's filter clauses (module comment). */
export function caseChannelFilter(filters: RetrievalFilters): Query[] {
  const selection = RetrievalFiltersSchema.parse(filters);
  const out: Query[] = [...filterClauses('cases', selection, { except: { aircraft: true } }), { term: { answer_eligible: true } }];
  const aircraft = caseAircraftClause(aircraftSelectionOf(selection));
  if (aircraft) out.push(aircraft);
  return out;
}

/** BM25 over the field set's cases-index fields, the case filter as `bool.filter`. */
export function caseChannelBody(index: string, text: string, fields: CaseFieldSet, filter: Query[], size: number): estypes.SearchRequest {
  return {
    index,
    size,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: ['ntsb_no'],
    query: {
      bool: {
        must: [{ multi_match: { query: text, fields: [...CASE_FIELD_SETS[fields]], type: 'best_fields', operator: 'or' } }],
        filter,
      },
    },
  };
}

const transport = (p: Pick<RetrievalParams, 'timeoutMs'>, signal?: AbortSignal) => ({ requestTimeout: p.timeoutMs, ...(signal ? { signal } : {}) });

function caseNumbers(res: estypes.SearchResponse<Record<string, unknown>>): string[] {
  return res.hits.hits.map((h) => {
    const n = h._source?.ntsb_no;
    if (typeof n !== 'string' || !CASE_NO.test(n)) throw new Error(`a cases-index hit has an invalid ntsb_no (${String(h._id)})`);
    return n;
  });
}

export interface CaseChannelResult {
  /** Unique cases in BM25 order. */
  cases: string[];
  body: estypes.SearchRequest;
  ms: number;
}

/** Run the case channel for `text` under `filters`. */
export async function searchCaseChannel(
  es: Client,
  index: string,
  text: string,
  channel: CaseChannel,
  filters: RetrievalFilters,
  params: Pick<RetrievalParams, 'timeoutMs'>,
  signal?: AbortSignal,
): Promise<CaseChannelResult> {
  const query = text.replace(/\s+/gu, ' ').trim();
  if (query === '') throw new Error('the case channel query is empty');
  const body = caseChannelBody(index, query, channel.fields, caseChannelFilter(filters), channel.depth);
  const started = Date.now();
  const res = await es.search<Record<string, unknown>>(body, transport(params, signal));
  assertCompleteResponse(res, 'keyword');
  const cases = caseNumbers(res);
  if (new Set(cases).size !== cases.length) throw new Error('the cases index returned a case twice');
  return { cases, body, ms: Date.now() - started };
}

/** kNN `k` and `num_candidates` of the mapping request: above the passages of the cases it maps. */
export const MAPPING_CANDIDATES = 2_000;

/** kNN restricted to `cases` under the passages filter. */
export function caseMappingBody(index: string, vector: readonly number[], filter: Query[], cases: readonly string[], k = MAPPING_CANDIDATES): estypes.SearchRequest {
  return {
    index,
    size: k,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: [...HIT_FIELDS],
    knn: {
      field: 'embedding',
      query_vector: [...vector],
      k,
      num_candidates: k,
      filter: { bool: { filter: [...filter, { terms: { ntsb_no: [...cases] } }] } },
    },
  };
}

export interface MappingResult {
  /** Each case's passages under the filter, in cosine order. */
  passages: Map<string, PassageHit[]>;
  body: estypes.SearchRequest | null;
  ms: number;
}

/** The passages of case-channel-only cases, best first (module comment). */
export async function mapCasesToPassages(
  es: Client,
  passagesIndex: string,
  filter: Query[],
  vector: readonly number[],
  cases: readonly string[],
  params: Pick<RetrievalParams, 'timeoutMs'>,
  signal?: AbortSignal,
): Promise<MappingResult> {
  if (cases.length === 0) return { passages: new Map(), body: null, ms: 0 };
  const started = Date.now();
  const body = caseMappingBody(passagesIndex, vector, filter, cases);
  const res = await es.search<Record<string, unknown>>(body, transport(params, signal));
  assertCompleteResponse(res, 'vector');
  if (res.hits.hits.length >= MAPPING_CANDIDATES) throw new Error(`the mapping request filled all ${MAPPING_CANDIDATES} candidates; raise MAPPING_CANDIDATES`);
  const wanted = new Set(cases);
  const passages = new Map<string, PassageHit[]>();
  for (const h of res.hits.hits) {
    const hit = toHit(String(h._id), h._source);
    if (!wanted.has(hit.ntsbNo)) throw new Error(`the mapping request returned a passage of ${hit.ntsbNo}, which was not asked for`);
    passages.set(hit.ntsbNo, [...(passages.get(hit.ntsbNo) ?? []), hit]);
  }
  return { passages, body, ms: Date.now() - started };
}
