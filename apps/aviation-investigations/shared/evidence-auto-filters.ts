/** Operator-only automatic filtering; independent of the evaluated ranking configurations. */
export const EVIDENCE_AUTO_FILTER_VERSIONS = ['none', 'state-explicit.v1.3', 'attributed.v1', 'attributed.v1-state', 'attributed.v1-state-years'] as const;
export type EvidenceAutoFilterVersion = typeof EVIDENCE_AUTO_FILTER_VERSIONS[number];
export const DEFAULT_EVIDENCE_AUTO_FILTERS: EvidenceAutoFilterVersion = 'none';
/**
 * Policies live may run: only variants whose fields the Task 30 confirmation cleared. Of the
 * `attributed.v1` subsets only the state one is live. `attributed.v1-state-years` is dev-only: the
 * years passed the forced rule, but end to end both locks read "nothing after 2010" as 2011 onwards.
 * `attributed.v1` is dev-only because its category field failed, so years and the category stay
 * suggestions. `state-explicit.v1.3` is dev-only: the 2026-10-25 security re-check found wordings it
 * still applies wrongly ("aircraft maintained within Alaska").
 */
export const LIVE_EVIDENCE_AUTO_FILTERS: readonly EvidenceAutoFilterVersion[] = Object.freeze(['none', 'attributed.v1-state']);
