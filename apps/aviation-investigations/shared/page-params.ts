/**
 * What the Explore and Compare pages read from their query strings, shared by the web client
 * (web/src/features/explore/url-state.ts) and the server, which titles those pages exactly as
 * the client does (shared/page-titles.ts, server/seo/head.ts) on every request, without a rate
 * limit. So the work is bounded by the vocabularies, not by the URL: a facet's list is reduced
 * to its valid values in one pass of set lookups before the contract parses anything, and the
 * contract is parsed a fixed number of times, never once per item.
 */
import { NTSB_NO_PATTERN } from './contracts/common.js';
import {
  ANY_COMPLETION,
  FACET_KEYS,
  FACET_VALUES,
  SearchRequestSchema,
  defaultSearchRequest,
  paramsToQuery,
  type SearchRequest,
} from './contracts/search.js';

export const CASES_PARAM = 'cases';
export const COMPARE_LIMIT = 4;

/** The query-string keys of a `SearchRequest`. */
export const SEARCH_KEYS: ReadonlySet<string> = new Set<string>([
  'q',
  'mentionedIn',
  ...FACET_KEYS,
  'yearFrom',
  'yearTo',
  'sort',
  'page',
  'pageSize',
]);

/** What each facet's list may name: its values, and `any` for completion. */
const FACET_ITEMS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  FACET_KEYS.map((facet) => [facet, new Set<string>(facet === 'completion' ? [...FACET_VALUES.completion, ANY_COMPLETION] : FACET_VALUES[facet])]),
);

/**
 * A facet's valid values from its lists (`a,b` and repeated keys alike): trimmed, each once, in
 * the order given, stopping once every value of the facet is in. Null when the lists name only
 * values the facet does not have (the facet is then ignored); a list that names nothing stays an
 * empty selection.
 */
function facetValues(allowed: ReadonlySet<string>, value: string | readonly string[]): string[] | null {
  const kept = new Set<string>();
  let named = false;
  for (const part of typeof value === 'string' ? [value] : value) {
    for (const raw of part.split(',')) {
      const item = raw.trim();
      if (item === '') continue;
      named = true;
      if (!allowed.has(item)) continue;
      kept.add(item);
      if (kept.size === allowed.size) return [...kept];
    }
  }
  return kept.size > 0 || !named ? [...kept] : null;
}

/**
 * Reads the search request from URL parameters, leniently: a value the contract rejects (a
 * mistyped facet value, an out-of-range page) is dropped instead of breaking the page, and a
 * year range that ends before it starts is dropped as a whole.
 */
export function readSearchRequest(params: URLSearchParams): SearchRequest {
  const query = paramsToQuery(params);
  for (const [facet, allowed] of FACET_ITEMS) {
    const value = query[facet];
    if (value === undefined) continue;
    const values = facetValues(allowed, value);
    if (values === null) delete query[facet];
    else query[facet] = values;
  }
  const strict = SearchRequestSchema.safeParse(query);
  if (strict.success) return strict.data;
  const kept: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (SEARCH_KEYS.has(key) && SearchRequestSchema.safeParse({ [key]: value }).success) kept[key] = value;
  }
  const lenient = SearchRequestSchema.safeParse(kept);
  if (lenient.success) return lenient.data;
  const { yearFrom: _from, yearTo: _to, ...rest } = kept;
  return SearchRequestSchema.safeParse(rest).data ?? defaultSearchRequest();
}

/** The compared case numbers (`cases`): valid numbers, upper case, each once, the first four. */
export function readCompare(params: URLSearchParams): string[] {
  const list = new Set<string>();
  for (const raw of (params.get(CASES_PARAM) ?? '').split(',')) {
    const ntsbNo = raw.trim().toUpperCase();
    if (!NTSB_NO_PATTERN.test(ntsbNo)) continue;
    list.add(ntsbNo);
    if (list.size === COMPARE_LIMIT) break;
  }
  return [...list];
}
