/** Deterministic permission to apply scope's event-state field, never its other facets. */
import { createHash } from 'node:crypto';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { EvidenceAutomaticFiltersSchema, type EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
import { eligibleEmittedStates, STATE_GUARD_VERSION, type StateEligibility } from '../../shared/state-eligibility.js';
import { DEFAULT_EVIDENCE_AUTO_FILTERS, type EvidenceAutoFilterVersion } from '../../shared/evidence-auto-filters.js';
import { canonicalConfig } from '../search/retrieval-config.js';

const policies = Object.freeze({
  none: Object.freeze({ version: 'none', guard: null, field: null, appliesTo: 'question-case-search' }),
  'state-explicit.v1.1': Object.freeze({ version: 'state-explicit.v1.1', guard: STATE_GUARD_VERSION, field: 'state', appliesTo: 'question-case-search' }),
} as const);
export type EvidenceAutoFilterPolicy = typeof policies[EvidenceAutoFilterVersion];
export const autoFilterPolicy = (version: EvidenceAutoFilterVersion = DEFAULT_EVIDENCE_AUTO_FILTERS): EvidenceAutoFilterPolicy => {
  const policy = policies[version];
  if (!policy) throw new Error('unknown evidence automatic filter policy');
  return policy;
};
export const autoFilterIdentity = (policy: EvidenceAutoFilterPolicy) => ({ version: policy.version,
  sha256: createHash('sha256').update(canonicalConfig(policy)).digest('hex') });
export type AutoFilterReason = StateEligibility['reason'] | 'disabled' | 'edited' | 'scope_unavailable' | 'non_search';
export function automaticState(policy: EvidenceAutoFilterPolicy, question: string, emitted: BriefFilters | null,
  edited: boolean, nonSearch: boolean): { filters: EvidenceAutomaticFilters | null; reason: AutoFilterReason } {
  if (canonicalConfig(policy) !== canonicalConfig(autoFilterPolicy(policy.version))) throw new Error('unregistered evidence automatic filter policy');
  if (policy.version === 'none') return { filters: null, reason: 'disabled' };
  if (edited) return { filters: null, reason: 'edited' };
  if (!emitted) return { filters: null, reason: nonSearch ? 'non_search' : 'scope_unavailable' };
  const decision = eligibleEmittedStates(question, emitted.state ?? []);
  return { filters: decision.states.length ? EvidenceAutomaticFiltersSchema.parse({ state: decision.states }) : null, reason: decision.reason };
}
