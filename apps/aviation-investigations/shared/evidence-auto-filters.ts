/** Operator-only automatic filtering; independent of the evaluated ranking configurations. */
export const EVIDENCE_AUTO_FILTER_VERSIONS = ['none', 'state-explicit.v1.3'] as const;
export type EvidenceAutoFilterVersion = typeof EVIDENCE_AUTO_FILTER_VERSIONS[number];
export const DEFAULT_EVIDENCE_AUTO_FILTERS: EvidenceAutoFilterVersion = 'none';
export const LIVE_EVIDENCE_AUTO_FILTERS: readonly EvidenceAutoFilterVersion[] = Object.freeze(['none', 'state-explicit.v1.3']);
