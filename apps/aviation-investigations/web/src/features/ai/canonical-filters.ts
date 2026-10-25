/**
 * Filters as the server hashes and compares them (server/briefs/intent.ts `canonicalFilters`):
 * for the retry keys of AI requests (web/src/features/ai/unsettled.ts) and an evidence search's
 * free undo (web/src/features/evidence/undo.ts). Free of the browser and of the brief and
 * evidence contracts' values, so the home page can load it and Node tests can import it (hence
 * the `.js` specifiers).
 */
import type { BriefFilterFacet, BriefFilters } from '../../../../shared/contracts/briefs.js';
import { FACET_VALUES } from '../../../../shared/contracts/search.js';

/**
 * `BRIEF_FILTER_FACETS`, in its order. Listed here so the home page does not load the brief
 * contracts (they arrive with the first AI request); a test holds the two lists together.
 */
export const FILTER_FACETS = ['phase', 'injury', 'conditions', 'light', 'category', 'engine', 'far_part', 'purpose', 'state'] as const satisfies readonly BriefFilterFacet[];

/** Facets in a fixed order, values in vocabulary order, empty facets dropped, years kept. */
export function canonicalFilters(f: BriefFilters): BriefFilters {
  const out: Record<string, unknown> = {};
  for (const facet of FILTER_FACETS) {
    const values = f[facet] as readonly string[] | undefined;
    if (!values || values.length === 0) continue;
    out[facet] = (FACET_VALUES[facet] as readonly string[]).filter((v) => values.includes(v));
  }
  if (f.yearFrom !== undefined) out.yearFrom = f.yearFrom;
  if (f.yearTo !== undefined) out.yearTo = f.yearTo;
  return out as BriefFilters;
}
