/**
 * A brief's filters (`BriefFilters`: Explore's facets without completion, plus years)
 * in both directions: from an Explore request (Ask AI with these filters) and to an
 * Explore link (the free "Show keyword results"), plus the chip wording.
 */
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters } from '../../../../shared/contracts/briefs';
import {
  FACET_TITLE,
  defaultSearchRequest,
  facetValueLabel,
  searchRequestToParams,
  type SearchRequest,
} from '../../../../shared/contracts/search';

type FacetLists = Partial<Record<BriefFilterFacet, string[]>>;

/** Explore's filters as a brief's filters (completion is not a brief filter: AI answers use completed cases). */
export function briefFiltersOf(request: SearchRequest): BriefFilters {
  const lists: FacetLists = {};
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = request[facet] as readonly string[];
    if (values.length > 0) lists[facet] = [...values];
  }
  return {
    ...(lists as BriefFilters),
    ...(request.yearFrom !== undefined ? { yearFrom: request.yearFrom } : {}),
    ...(request.yearTo !== undefined ? { yearTo: request.yearTo } : {}),
  };
}

/** Explore with exactly these filters over the default cohort (free). */
export function exploreHref(filters: BriefFilters, q = ''): string {
  const request: SearchRequest = { ...defaultSearchRequest(), q };
  const lists = request as unknown as Record<string, string[]>;
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = (filters as FacetLists)[facet];
    if (values && values.length > 0) lists[facet] = [...values];
  }
  if (filters.yearFrom !== undefined) request.yearFrom = filters.yearFrom;
  if (filters.yearTo !== undefined) request.yearTo = filters.yearTo;
  const qs = searchRequestToParams(request).toString();
  return `/explore${qs ? `?${qs}` : ''}`;
}

export interface FilterChip {
  key: string;
  label: string;
  /** The filters without this one. */
  without: BriefFilters;
}

/** One chip per filter value, plus one for the year range. */
export function filterChips(filters: BriefFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const facet of BRIEF_FILTER_FACETS) {
    for (const value of (filters as FacetLists)[facet] ?? []) {
      const rest = ((filters as FacetLists)[facet] ?? []).filter((v) => v !== value);
      const without = { ...filters } as FacetLists & BriefFilters;
      if (rest.length > 0) without[facet] = rest;
      else delete without[facet];
      chips.push({ key: `${facet}:${value}`, label: `${FACET_TITLE[facet]}: ${facetValueLabel(facet, value)}`, without });
    }
  }
  return chips;
}

/** Filters with one more value (the "+ Filter" picker). */
export function withFilter(filters: BriefFilters, facet: BriefFilterFacet, value: string): BriefFilters {
  const lists = filters as FacetLists;
  const current = lists[facet] ?? [];
  return { ...filters, [facet]: current.includes(value) ? current : [...current, value] } as BriefFilters;
}

/** The query's filters in words, for the no-results state. */
export function filtersInWords(filters: BriefFilters): string[] {
  const words = filterChips(filters).map((c) => c.label);
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    words.push(filters.yearFrom === filters.yearTo ? `in ${filters.yearFrom}` : `${filters.yearFrom ?? 'any year'} to ${filters.yearTo ?? 'now'}`);
  }
  return words;
}
