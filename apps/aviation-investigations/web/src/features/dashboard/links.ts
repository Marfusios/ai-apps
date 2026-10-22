import {
  DEFAULT_COMPLETION,
  defaultSearchRequest,
  searchRequestToParams,
  type FacetKey,
  type SearchRequest,
} from '../../../../shared/contracts/search';
import type { DashboardRequest } from '../../../../shared/contracts/dashboard';

type Cohort = DashboardRequest['cohort'];

/**
 * Explore URL that reproduces a dashboard figure: the same cohort (default, or
 * every record) with one facet value or year applied.
 */
export function exploreHref(cohort: Cohort, change: { facet: FacetKey; value: string } | { year: number } | null = null): string {
  const request: SearchRequest = { ...defaultSearchRequest(), completion: cohort === 'all' ? [] : [...DEFAULT_COMPLETION] };
  if (change && 'facet' in change) (request[change.facet] as string[]) = [change.value];
  if (change && 'year' in change) {
    request.yearFrom = change.year;
    request.yearTo = change.year;
  }
  const qs = searchRequestToParams(request).toString();
  return qs ? `/explore?${qs}` : '/explore';
}
