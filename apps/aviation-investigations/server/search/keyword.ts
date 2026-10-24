/**
 * Keyword search over the active manifest's cases index (UI_DESIGN §4.2, amendments
 * A2, A6, A14).
 *
 * Text: the words of `q` must all occur in the report (`multi_match`, `cross_fields`,
 * operator `and`, over the allowlisted text fields, with the index's search analyzer:
 * aviation synonyms, negations kept, light stemming). Each "quoted phrase" is a
 * `match_phrase` that must occur within one section value. The text is never parsed
 * as a query language: no `query_string`, wildcards, regular expressions or scripts,
 * so Lucene syntax is just text the analyzer splits into words. "Mentioned in the
 * probable cause" applies the same clauses to `probable_cause` only.
 *
 * One Elasticsearch request returns the page, the highlights, every facet, the
 * `mentionedIn` totals, the year chart, the multi-aircraft count and the "remove one
 * filter" totals. The query carries only the text; every filter is a `post_filter`,
 * and each count is an aggregation filtered by the filters it keeps (disjunctive
 * facets). Rows are read from PostgreSQL for the same generation.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import {
  FACET_KEYS,
  SearchResponseSchema,
  type CaseRow,
  type FacetKey,
  type RelaxationDrop,
  type SearchRequest,
  type SearchResponse,
  type SectionKind,
  type Snippet,
} from '../../shared/contracts/search.js';
import { excerptSnippet, mergeSpans, previewSnippet, type Span } from '../../shared/snippet.js';
import type { Db } from '../db/client.js';
import { readCaseRows } from '../db/queries/case-views.js';
import type { PinnedDataset } from '../dataset.js';
import { facetAggs, facetBuckets, facetCounts } from './facets.js';
import { RequestFilters, bool, type Except, type Query } from './filters.js';
import { SEARCH_TIMEOUT, assertComplete } from './timeout.js';

/** Narrative fields a snippet can come from, by kind. */
export const SECTION_FIELDS = ['probable_cause', 'analysis', 'factual'] as const satisfies readonly SectionKind[];
/** Every text field "anywhere in the report" searches. */
export const TEXT_FIELDS = [...SECTION_FIELDS, 'findings_text'] as const;

/** At most this many quoted phrases become phrase clauses; the rest are plain words. */
const MAX_PHRASES = 8;

/** Highlight markers: private-use characters that never occur in NTSB text. */
const MARK_START = '\uE000';
const MARK_END = '\uE001';

/**
 * Analysis and factual sections can be tens of kilobytes: Elasticsearch returns one
 * best-scoring passage of about this many characters (sentence boundaries) instead of
 * the whole value. The probable cause is short and comes whole.
 */
export const FRAGMENT_SIZE = 300;

export interface ParsedQuery {
  words: string;
  phrases: string[];
}

/** Split `q` into its quoted phrases and the remaining words (quotes removed). */
export function parseQuery(q: string): ParsedQuery {
  const phrases: string[] = [];
  let words = q.replace(/"([^"]*)"/g, (whole, inner: string) => {
    if (inner.trim() !== '' && phrases.length < MAX_PHRASES) {
      phrases.push(inner.trim());
      return ' ';
    }
    return ` ${inner} `;
  });
  words = words.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  return { words, phrases };
}

/** The text clause over `fields`, or null for an empty query. */
export function textQuery(q: string, fields: readonly string[]): Query | null {
  const { words, phrases } = parseQuery(q);
  const must: Query[] = [];
  if (words !== '') {
    must.push({
      multi_match: { query: words, fields: [...fields], type: 'cross_fields', operator: 'and', zero_terms_query: 'all' },
    });
  }
  for (const phrase of phrases) {
    const clauses: Query[] = fields.map((field) => ({ match_phrase: { [field]: { query: phrase, zero_terms_query: 'all' } } }));
    must.push(clauses.length === 1 ? (clauses[0] as Query) : { bool: { should: clauses, minimum_should_match: 1 } });
  }
  if (must.length === 0) return null;
  return must.length === 1 ? (must[0] as Query) : { bool: { must } };
}

/** Text with the highlight markers removed, and the marked spans in it. */
export function unmark(marked: string): { text: string; spans: Span[] } | null {
  let text = '';
  const spans: Span[] = [];
  let open = -1;
  for (const ch of marked) {
    if (ch === MARK_START) {
      if (open !== -1) return null;
      open = text.length;
    } else if (ch === MARK_END) {
      if (open === -1) return null;
      if (text.length > open) spans.push({ start: open, end: text.length });
      open = -1;
    } else {
      text += ch;
    }
  }
  return open === -1 ? { text, spans } : null;
}

/**
 * The row snippet from a hit's highlights: the probable cause when the words match
 * there (the whole value, windowed like the mock API), otherwise the analysis or
 * factual passage with the most marks (analysis first on a tie). A passage is part of
 * a longer section whose bounds the highlighter does not report, so it is marked as
 * truncated on both sides. Null when no narrative section matched (e.g. only a
 * finding did).
 */
export function snippetFromHighlights(highlight: Record<string, string[]> | undefined): Snippet | null {
  if (!highlight) return null;
  for (const value of highlight.probable_cause ?? []) {
    const parsed = unmark(value);
    if (parsed && parsed.spans.length > 0) {
      return excerptSnippet('probable_cause', parsed.text, mergeSpans(parsed.spans, parsed.text), true);
    }
  }
  let best: { kind: SectionKind; text: string; spans: Span[] } | null = null;
  for (const kind of ['analysis', 'factual'] as const) {
    for (const value of highlight[kind] ?? []) {
      const parsed = unmark(value);
      if (!parsed || parsed.spans.length === 0) continue;
      const spans = mergeSpans(parsed.spans, parsed.text);
      if (!best || spans.length > best.spans.length) best = { kind, text: parsed.text, spans };
    }
  }
  if (!best) return null;
  return { ...excerptSnippet(best.kind, best.text, best.spans, true), truncatedStart: true, truncatedEnd: true };
}

function sortOf(sort: SearchRequest['sort']): estypes.SortCombinations[] {
  const byDate = (order: 'asc' | 'desc'): estypes.SortCombinations => ({ ev_date: { order, missing: '_last' } });
  const tie: estypes.SortCombinations = { ntsb_no: { order: 'asc' } };
  if (sort === 'oldest') return [byDate('asc'), tie];
  if (sort === 'relevance') return [{ _score: { order: 'desc' } }, byDate('desc'), tie];
  return [byDate('desc'), tie];
}

const relaxName = (drop: RelaxationDrop): string => `relax_${drop}`;

function relaxExcept(drop: RelaxationDrop): Except {
  if (drop === 'mentionedIn') return { mentionedIn: true };
  if (drop === 'years') return { years: true };
  return { facet: drop as FacetKey };
}

export interface SearchBody {
  body: estypes.SearchRequest;
  filters: RequestFilters;
  hasText: boolean;
}

/** The Elasticsearch request for one `SearchRequest` (pure; exported for tests). */
export function buildSearchBody(index: string, request: SearchRequest): SearchBody {
  const anywhere = textQuery(request.q, TEXT_FIELDS);
  const inCause = textQuery(request.q, ['probable_cause']);
  const f = new RequestFilters(request, inCause);
  const hasText = anywhere !== null;
  const query: Query = {
    bool: {
      filter: [{ term: { country: 'USA' } }],
      ...(anywhere && inCause ? { must: [anywhere], should: [{ bool: { must: [inCause], boost: 2 } }] } : {}),
    },
  };
  const aggs: Record<string, estypes.AggregationsAggregationContainer> = {
    ...facetAggs(f, FACET_KEYS),
    mentioned: {
      filter: bool(f.filters({ mentionedIn: true })),
      aggs: { probable_cause: { filter: inCause ?? { match_all: {} } } },
    },
    years: {
      filter: bool(f.filters({ years: true, completion: true })),
      aggs: {
        by_year: {
          terms: { field: 'ev_year', size: 300 },
          aggs: { completed: { filter: { term: { completed_with_cause: true } } } },
        },
      },
    },
    multi_aircraft: { filter: bool([...f.filters(), { range: { aircraft_count: { gte: 2 } } }]) },
  };
  for (const drop of f.activeDrops()) aggs[relaxName(drop)] = { filter: bool(f.filters(relaxExcept(drop))) };

  const sections = request.mentionedIn === 'probable_cause' ? (['probable_cause'] as const) : SECTION_FIELDS;
  const body: estypes.SearchRequest = {
    index,
    from: (request.page - 1) * request.pageSize,
    size: request.pageSize,
    timeout: SEARCH_TIMEOUT,
    allow_partial_search_results: false,
    track_total_hits: true,
    query,
    post_filter: bool(f.filters()),
    sort: sortOf(request.sort),
    _source: hasText ? false : ['probable_cause'],
    aggs,
    ...(hasText
      ? {
          highlight: {
            type: 'unified',
            pre_tags: [MARK_START],
            post_tags: [MARK_END],
            encoder: 'default',
            require_field_match: true,
            fields: Object.fromEntries(
              sections.map((s) => [
                s,
                s === 'probable_cause'
                  ? { number_of_fragments: 0 }
                  : { number_of_fragments: 1, fragment_size: FRAGMENT_SIZE, boundary_scanner: 'sentence', order: 'score' },
              ]),
            ),
          },
        }
      : {}),
  };
  return { body, filters: f, hasText };
}

interface Aggs {
  mentioned: { doc_count: number; probable_cause: { doc_count: number } };
  years: { by_year: { buckets: { key: number; doc_count: number; completed: { doc_count: number } }[] } };
  multi_aircraft: { doc_count: number };
  [name: string]: unknown;
}

export interface KeywordSearchDeps {
  es: Client;
  db: Db;
  /** Facet values outside the vocabulary (left out of the buckets) are reported here once. */
  onUnknownFacetValue?: (facet: FacetKey, value: string) => void;
}

export async function keywordSearch(deps: KeywordSearchDeps, pinned: PinnedDataset, request: SearchRequest): Promise<SearchResponse> {
  const { body, filters, hasText } = buildSearchBody(pinned.manifest.casesIndex, request);
  const res = await deps.es.search<{ probable_cause?: string[] }>(body);
  assertComplete(res);
  const aggs = res.aggregations as unknown as Aggs;
  const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);

  const hits = res.hits.hits;
  const ntsbNos = hits.map((h) => h._id as string);
  const rowsByNo = await readCaseRows(deps.db, pinned.manifest.generationId, ntsbNos, {
    mappingVerified: pinned.manifest.mappingVerified,
  });
  const rows: CaseRow[] = hits.map((hit) => {
    const base = rowsByNo.get(hit._id as string);
    if (!base) throw new Error(`case ${hit._id} of the cases index is missing from generation ${pinned.manifest.generationId}`);
    const snippet = hasText
      ? snippetFromHighlights(hit.highlight)
      : (() => {
          const cause = hit._source?.probable_cause?.[0];
          return cause ? previewSnippet(cause) : null;
        })();
    return { ...base, snippet };
  });

  const facets = Object.fromEntries(
    FACET_KEYS.map((facet) => [
      facet,
      facetBuckets(facet, facetCounts(filters, facet, aggs), request[facet] as readonly string[], deps.onUnknownFacetValue),
    ]),
  ) as SearchResponse['facets'];

  const perYear = new Map(aggs.years.by_year.buckets.map((b) => [Number(b.key), b]));
  const years: SearchResponse['years'] = [];
  for (let year = pinned.years.from; year <= pinned.years.to; year++) {
    const b = perYear.get(year);
    const completed = b?.completed.doc_count ?? 0;
    years.push({ year, completed, other: (b?.doc_count ?? 0) - completed });
  }

  const relaxations: SearchResponse['relaxations'] =
    total === 0
      ? filters.activeDrops().map((drop) => ({ drop, count: (aggs[relaxName(drop)] as { doc_count: number }).doc_count }))
      : [];

  return SearchResponseSchema.parse({
    dataset: pinned.dataset,
    total,
    page: request.page,
    pageSize: request.pageSize,
    rows,
    facets,
    mentionedIn: { anywhere: aggs.mentioned.doc_count, probable_cause: aggs.mentioned.probable_cause.doc_count },
    years,
    multiAircraft: aggs.multi_aircraft.doc_count,
    relaxations,
  } satisfies SearchResponse);
}
