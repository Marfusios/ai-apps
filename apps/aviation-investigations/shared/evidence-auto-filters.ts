/** Operator-only automatic filtering; independent of the evaluated ranking configurations. */
export const EVIDENCE_AUTO_FILTER_VERSIONS = ['none', 'state-explicit.v1.3', 'attributed.v1'] as const;
export type EvidenceAutoFilterVersion = typeof EVIDENCE_AUTO_FILTER_VERSIONS[number];
export const DEFAULT_EVIDENCE_AUTO_FILTERS: EvidenceAutoFilterVersion = 'none';
/**
 * Policies live may run. `state-explicit.v1.3` is dev-only: the 2026-10-25 security re-check found
 * wordings it still applies wrongly ("aircraft maintained within Alaska"), so it is not cleared.
 */
export const LIVE_EVIDENCE_AUTO_FILTERS: readonly EvidenceAutoFilterVersion[] = Object.freeze(['none', 'attributed.v1']);
