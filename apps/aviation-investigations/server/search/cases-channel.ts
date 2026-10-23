/**
 * The cases-index channel of AI retrieval (`retrieval.v2`, task 10e): BM25 over each
 * case's narratives in the cases index, one document per event. It only nominates
 * cases: its hits carry no text and are never evidence. A case it finds reaches a bundle
 * only through its own passages from the passages index, under the passages filter
 * (server/search/case-mapping.ts), with every probable-cause variant attached by packing.
 *
 * **Same dataset.** The cases index must be the one the brief's manifest pairs with its
 * passages index (the binding resolves it from `dataset_manifests` by generation and
 * passages index), built for that generation, and a servable cases version and
 * fingerprint (`isServableCasesIndex`: cases-v3, or cases-v2 with identical fields).
 * `assertServableCasesIndex` checks it before anything is embedded and remembers a pass
 * (never a failure), as the passages check does.
 *
 * **Same cohort, by the AI evidence rule.** `casesChannelFilter` reaches exactly the
 * cases the passages filter can reach (an integration test compares them on real indexes
 * with an independent reference, selection by selection):
 * - the passages index's compulsory clauses, `country: USA` and `answer_eligible: true`
 *   (both fields exist in the cases index): AI evidence is the answer-eligible cohort;
 * - at least one aircraft row (`aircraft_count >= 1`): a passage is attributed to one
 *   aircraft or to an event of two or more, so an event without aircraft rows has no
 *   passages (none in the 2026-10-16 snapshot) and is never nominated;
 * - the event facets and the year range exactly as the passages compiler emits them
 *   (same fields, same values, `blank` matching a missing value);
 * - with any aircraft facet, the passages contract's aircraft semantics restated on the
 *   cases index's nested `aircraft`, which holds every aircraft row of the event. A
 *   single-aircraft event's passages are its aircraft's own, so that aircraft must meet
 *   every active facet (`blank` matching a missing value). A multi-aircraft event's
 *   passages are all event-scoped: on a `passages-v2` index (event-level qualification)
 *   the event qualifies when it has aircraft and none fails the full conjunction of the
 *   active facets (a missing value fails, `blank` is dropped, a facet whose only value is
 *   `blank` leaves the branch out); on a `passages-v1` index (exclusion) it never does.
 *   An event without aircraft rows has no passages and never qualifies.
 *   The keyword-search rule of the cases index ("some aircraft matches", plus the "no
 *   aircraft" branch for `blank`) is never used here: it would reach mixed events and
 *   facets met by different aircraft, which the passages filter excludes.
 *
 * **Query.** `multi_match`, `best_fields`, operator `or` over the configured fields, the
 * scope stage's keyword text, the index's search analyzer; `allow_partial_search_results:
 * false`, and an incomplete response fails retrieval (`IncompleteSearchError`).
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { BLANK } from '../../shared/contracts/search.js';
import { SERVABLE_CASES_VERSIONS, isServableCasesIndex } from '../../worker/index/cases-index.js';
import {
  AIRCRAFT_FACET_FIELD,
  AIRCRAFT_FACET_KEYS,
  COMPULSORY_FILTERS,
  EVENT_FACETS,
  EVENT_FACET_FIELD,
  RetrievalFiltersSchema,
  aircraftInner,
  aircraftSelectionOf,
  valuesClause,
  yearsClause,
  type AircraftSelection,
  type Query,
  type RetrievalFilters,
} from './filters.js';
import { IncompleteSearchError, RetrievalUnavailableError, assertCompleteResponse } from './hybrid.js';
import { IndexMetaError, readIndexMeta } from './index-meta.js';
import { LEXICAL_QUERY } from './retrieval-config.js';

/** An event-level case number as the cases index stores it (`NtsbNoSchema`'s pattern). */
const CASE_NO = /^[A-Z0-9]{5,20}$/;

// ---------------------------------------------------------------------------
// The index

export interface ServableCasesIndex {
  index: string;
  indexVersion: string;
}

/** Cases indexes that passed, by index and generation (bounded; failures are never kept). */
const verified = new Map<string, string>();

/** Forget every remembered pass, so the next check reads the index again (evaluation: a cold start). */
export function forgetCasesIndexChecks(): void {
  verified.clear();
}

/**
 * Refuse (`RetrievalUnavailableError`, `index_mismatch`) unless `index` exists, is a
 * concrete index built for `generationId`, and is a servable cases version with its
 * approved fingerprint. Bounded by `timeoutMs` and `signal`; a pass is remembered.
 */
export async function assertServableCasesIndex(
  es: Client,
  index: string,
  generationId: number,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ServableCasesIndex> {
  const key = JSON.stringify([index, generationId, SERVABLE_CASES_VERSIONS]);
  const known = verified.get(key);
  if (known) return { index, indexVersion: known };
  let meta;
  try {
    meta = await readIndexMeta(es, index, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof IndexMetaError) throw new RetrievalUnavailableError('index_mismatch', err.message);
    throw err;
  }
  if (meta.generationId !== generationId) {
    throw new RetrievalUnavailableError('index_mismatch', `${index} was built for generation ${meta.generationId ?? 'unknown'}, not ${generationId}`);
  }
  if (meta.indexVersion === null || !isServableCasesIndex(meta.indexVersion, meta.fingerprint)) {
    throw new RetrievalUnavailableError('index_mismatch', `${index} is not a servable cases index (${SERVABLE_CASES_VERSIONS.join(' or ')} with its fingerprint)`);
  }
  if (verified.size >= 16) verified.clear();
  verified.set(key, meta.indexVersion);
  return { index, indexVersion: meta.indexVersion };
}

// ---------------------------------------------------------------------------
// The filter

/**
 * The conjunction one aircraft of a multi-aircraft event must meet, on the cases index's
 * nested `aircraft`: every active facet, each on its concrete values only (a missing
 * value fails). Null when an active facet has no value but `blank`.
 */
export function casesAircraftConjunction(selection: AircraftSelection): Query[] | null {
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

/**
 * The aircraft clause of the cases channel (module comment), null without an aircraft
 * facet. `eventAircraftQualification` is the served passages contract's.
 */
export function casesAircraftClause(selection: AircraftSelection, opts: { eventAircraftQualification: boolean }): Query | null {
  const inner = aircraftInner(selection);
  if (inner.length === 0) return null;
  const single: Query = {
    bool: { filter: [{ term: { aircraft_count: 1 } }, { nested: { path: 'aircraft', query: { bool: { filter: inner } } } }] },
  };
  const conjunction = opts.eventAircraftQualification ? casesAircraftConjunction(selection) : null;
  if (!conjunction) return single;
  const several: Query = {
    bool: {
      filter: [{ range: { aircraft_count: { gte: 2 } } }, { nested: { path: 'aircraft', query: { match_all: {} } } }],
      must_not: [{ nested: { path: 'aircraft', query: { bool: { must_not: [{ bool: { filter: conjunction } }] } } } }],
    },
  };
  return { bool: { should: [single, several], minimum_should_match: 1 } };
}

/** Events with at least one aircraft row: the only ones that can have passages. */
export const HAS_AIRCRAFT: Query = { range: { aircraft_count: { gte: 1 } } };

/**
 * The cases channel's filter clauses (module comment), in the passages compiler's order:
 * compulsory (and "has aircraft"), event facets, aircraft, years.
 */
export function casesChannelFilter(filters: RetrievalFilters, opts: { eventAircraftQualification: boolean }): Query[] {
  const selection = RetrievalFiltersSchema.parse(filters);
  const out: Query[] = [...COMPULSORY_FILTERS.passages, HAS_AIRCRAFT];
  for (const facet of EVENT_FACETS) {
    const values = selection[facet] ?? [];
    if (values.length > 0) out.push(valuesClause(EVENT_FACET_FIELD[facet], values));
  }
  const aircraft = casesAircraftClause(aircraftSelectionOf(selection), opts);
  if (aircraft) out.push(aircraft);
  const years = yearsClause(selection.yearFrom, selection.yearTo);
  if (years) out.push(years);
  return out;
}

// ---------------------------------------------------------------------------
// The search

/** BM25 over `fields` of the cases index, the filter as `bool.filter`; only `ntsb_no` is returned. */
export function casesChannelBody(index: string, text: string, fields: readonly string[], filter: Query[], size: number): estypes.SearchRequest {
  return {
    index,
    size,
    track_total_hits: false,
    allow_partial_search_results: false,
    _source: ['ntsb_no'],
    query: {
      bool: {
        must: [{ multi_match: { query: text, fields: [...fields], type: LEXICAL_QUERY.type, operator: LEXICAL_QUERY.operator } }],
        filter,
      },
    },
  };
}

/** One cases-channel hit: the case and its BM25 score. */
export interface CaseHit {
  ntsbNo: string;
  score: number;
}

/**
 * The hits of a cases-channel response, checked: complete, each with a valid case
 * number and a finite score, no case twice (one document per event).
 */
export function casesOf(res: estypes.SearchResponse<Record<string, unknown>>): CaseHit[] {
  assertCompleteResponse(res, 'cases');
  const seen = new Set<string>();
  return res.hits.hits.map((h) => {
    const n = h._source?.ntsb_no;
    const score = h._score;
    if (typeof n !== 'string' || !CASE_NO.test(n)) throw new IncompleteSearchError('cases', 'a hit without a valid case number');
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new IncompleteSearchError('cases', 'a hit without a score');
    if (seen.has(n)) throw new IncompleteSearchError('cases', 'a case returned twice');
    seen.add(n);
    return { ntsbNo: n, score };
  });
}
