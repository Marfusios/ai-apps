/** A free undo removes original automatic additions; it cannot change anything else. */
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { EVIDENCE_CONTRACT_VERSION, type CreateEvidenceRequest } from '../../shared/contracts/evidence.js';
import { canonicalConfig } from '../search/retrieval-config.js';
import { disclosedQuery } from './disclosure.js';
import type { EvidenceRow } from './store.js';

// Facets are sets. Empty lists are no constraint, like omitted lists, but new values are never allowed.
const normalized = (filters: BriefFilters) => Object.fromEntries(Object.entries(filters)
  .filter(([, v]) => v !== undefined && (!Array.isArray(v) || v.length > 0))
  .map(([k, v]) => [k, Array.isArray(v) ? [...new Set(v)].sort() : v]));
const equal = (a: BriefFilters, b: BriefFilters) => canonicalConfig(normalized(a)) === canonicalConfig(normalized(b));

/** An expiry checked by the database clock, not a generic immutable-claim refusal.
 * Only inspect fixed driver metadata; never copy a query or its values to the response. */
export function isExpiredUndoClaim(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (pg.code === '55000' && pg.constraint === 'evidence_undo_parent_unexpired') return true;
    e = pg.cause;
  }
  return false;
}

/**
 * What the policy added on its own, as whole facets of the parent's applied filters: the state set,
 * both year bounds (one facet, even when one bound is open), the category set. A facet counts only
 * while the parent's applied value is exactly the automatic one.
 */
function automaticFacets(parent: EvidenceRow): (keyof BriefFilters)[][] {
  const automatic = parent.data.automaticFilters, applied = parent.data.appliedFilters;
  if (!automatic) return [];
  const facets: (keyof BriefFilters)[][] = [];
  if (automatic.state?.length && equal({ state: automatic.state }, { state: applied.state })) facets.push(['state']);
  if ((automatic.yearFrom !== undefined || automatic.yearTo !== undefined)
    && applied.yearFrom === automatic.yearFrom && applied.yearTo === automatic.yearTo) facets.push(['yearFrom', 'yearTo']);
  if (automatic.category?.length && equal({ category: automatic.category }, { category: applied.category })) facets.push(['category']);
  return facets;
}

export function canUndo(parent: EvidenceRow, edit: Extract<CreateEvidenceRequest, { kind: 'edited' }>, now: Date): boolean {
  if (parent.data.version !== EVIDENCE_CONTRACT_VERSION || parent.status !== 'results' || parent.expiresAt <= now || parent.data.edited || parent.freeUndoReservationId != null || edit.terms !== undefined) return false;
  const query = disclosedQuery(parent.data);
  if (query.source !== 'question') return false;
  const removedTerms = edit.keywords === 'question' && query.keywords.kind !== 'question';
  if (edit.keywords !== undefined && !removedTerms) return false;
  if (equal(edit.filters, parent.data.appliedFilters)) return removedTerms;
  // Undo removes one or more entire automatic facets and nothing else. Removing an OR member, one
  // of two automatic year bounds or changing an endpoint narrows or changes the search: paid.
  const facets = automaticFacets(parent);
  for (let mask = 1; mask < 1 << facets.length; mask++) {
    const removed = new Set(facets.filter((_, i) => mask & 1 << i).flat());
    const rest = Object.fromEntries(Object.entries(parent.data.appliedFilters).filter(([key]) => !removed.has(key as keyof BriefFilters)));
    if (equal(edit.filters, rest)) return true;
  }
  return false;
}
