/** The site's filter merge and button condition, without web dependencies; tests/web/applied-filters-parity.test.ts keeps both equal to the page's. */
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

/** True when the page shows at least one filter chip, and so the "Apply these filters" button (SearchPanel.tsx). */
export const hasFilters = (f: BriefFilters): boolean => Object.values(f).some(v => Array.isArray(v) ? v.length > 0 : v !== undefined);
