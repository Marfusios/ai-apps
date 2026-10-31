/** Operator-only ranking selection. Not part of the public evidence.v3 contract. */
export const EVIDENCE_RANKING_VERSIONS = [
  'er-q-v1', 'er-t-v1', 'er-qt-v1',
  'er-q-h50-v1', 'er-t-h50-v1', 'er-qt-h50-v1',
  'er-q-h100-v1', 'er-t-h100-v1', 'er-qt-h100-v1',
  'er-t-s50-v1', 'er-qt-s50-v1',
] as const;
export type EvidenceRankingVersion = typeof EVIDENCE_RANKING_VERSIONS[number];
export const DEFAULT_EVIDENCE_RANKING: EvidenceRankingVersion = 'er-q-v1';
/**
 * Rankings live may run. The baseline, plus the Haiku rerank of the top 50 (`er-q-h50-v1`) by the
 * owner's decision of 31 October 2026: its Task 24 confirmation was inconclusive (every endpoint
 * positive, intervals too wide), not negative, and it only reorders retrieved cases.
 */
export const LIVE_EVIDENCE_RANKINGS: readonly EvidenceRankingVersion[] = Object.freeze(['er-q-v1', 'er-q-h50-v1']);
