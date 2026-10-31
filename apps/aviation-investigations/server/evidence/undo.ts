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

export function canUndo(parent: EvidenceRow, edit: Extract<CreateEvidenceRequest, { kind: 'edited' }>, now: Date): boolean {
  if (parent.data.version !== EVIDENCE_CONTRACT_VERSION || parent.status !== 'results' || parent.expiresAt <= now || parent.data.edited || parent.freeUndoReservationId != null || edit.terms !== undefined) return false;
  const query = disclosedQuery(parent.data);
  if (query.source !== 'question') return false;
  const removedTerms = edit.keywords === 'question' && query.keywords.kind !== 'question';
  if (edit.keywords !== undefined && !removedTerms) return false;
  const automatic = parent.data.automaticFilters;
  let removedState = false;
  if (!equal(edit.filters, parent.data.appliedFilters)) {
    // Removing an OR member narrows the search; undo removes the entire automatic state constraint.
    if (!automatic?.state.length || !equal({ state: automatic.state }, { state: parent.data.appliedFilters.state })) return false;
    const { state: _state, ...rest } = parent.data.appliedFilters;
    if (!equal(edit.filters, rest)) return false;
    removedState = true;
  }
  return removedState || removedTerms;
}
