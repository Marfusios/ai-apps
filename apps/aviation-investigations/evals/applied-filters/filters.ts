/** The site's filter merge, without web dependencies; tests/web/applied-filters-parity.test.ts keeps it equal to the page's. */
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters } from '../../shared/contracts/briefs.js';

/** Mirrors `withSuggestedFilters` in web/src/features/evidence/display.ts: what "Apply these filters" sends. */
export function withSuggestedFilters(applied: BriefFilters, suggested: BriefFilters): BriefFilters {
  const out = { ...applied } as Partial<Record<BriefFilterFacet, string[]>> & BriefFilters;
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = (suggested as Partial<Record<BriefFilterFacet, string[]>>)[facet] ?? [];
    if (values.length > 0) out[facet] = [...new Set([...(out[facet] ?? []), ...values])];
  }
  if (suggested.yearFrom !== undefined) out.yearFrom = suggested.yearFrom;
  if (suggested.yearTo !== undefined) out.yearTo = suggested.yearTo;
  return out;
}
