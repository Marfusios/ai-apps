/**
 * What the Explore and Compare pages read from their query strings, shared by the web client
 * (web/src/features/explore/url-state.ts) and the server, which titles those pages exactly as
 * the client does (shared/page-titles.ts, server/seo/head.ts).
 */
import { NtsbNoSchema } from './contracts/common.js';
import { FACET_KEYS, SearchRequestSchema, defaultSearchRequest, paramsToQuery, type SearchRequest } from './contracts/search.js';

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

/**
 * Reads the search request from URL parameters, leniently: a value the contract
 * rejects (a mistyped facet value, an out-of-range page) is dropped instead of
 * breaking the page.
 */
export function readSearchRequest(params: URLSearchParams): SearchRequest {
  const query = paramsToQuery(params);
  const strict = SearchRequestSchema.safeParse(query);
  if (strict.success) return strict.data;
  const kept: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!SEARCH_KEYS.has(key)) continue;
    if (SearchRequestSchema.safeParse({ [key]: value }).success) {
      kept[key] = value;
      continue;
    }
    // Keep the valid members of a list.
    const items = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(','));
    const valid = items.filter((item) => SearchRequestSchema.safeParse({ [key]: item }).success);
    if (valid.length > 0 && FACET_KEYS.includes(key as (typeof FACET_KEYS)[number])) kept[key] = valid;
  }
  const lenient = SearchRequestSchema.safeParse(kept);
  if (lenient.success) return lenient.data;
  const { yearFrom: _from, yearTo: _to, ...rest } = kept;
  return SearchRequestSchema.safeParse(rest).data ?? defaultSearchRequest();
}

/** The compared case numbers (`cases`): valid numbers, upper case, each once, at most four. */
export function readCompare(params: URLSearchParams): string[] {
  const raw = params.get(CASES_PARAM) ?? '';
  const list = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => NtsbNoSchema.safeParse(s).success);
  return [...new Set(list)].slice(0, COMPARE_LIMIT);
}
