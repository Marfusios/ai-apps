/**
 * Retrieval metrics of the evaluation (amendment A13). Pure.
 *
 * - **Case recall@k** on the case-candidate ranking: expected cases among the first
 *   `k` unique cases, divided by `min(|expected|, k)` (so a question with more than `k`
 *   expected cases can still reach 1). The silver set keeps `|expected| <= 20`, so
 *   recall@20 is the plain recall.
 * - **Evidence coverage** on the packed bundle: expected cases with at least one
 *   passage in the bundle (`cases`), and those whose probable-cause passage is in the
 *   bundle too (`causes`), each divided by `min(|expected|, maxCases)`.
 * Means are macro averages over questions.
 */

export const RECALL_KS = [6, 10, 20] as const;
export type RecallK = (typeof RECALL_KS)[number];

export function recallAt(expected: readonly string[], ranking: readonly string[], k: number): number {
  if (expected.length === 0) throw new Error('a question needs at least one expected case');
  const top = new Set(ranking.slice(0, k));
  const found = expected.filter((n) => top.has(n)).length;
  return found / Math.min(expected.length, k);
}

/** 1-based rank of the first expected case, or null. */
export function firstHitRank(expected: readonly string[], ranking: readonly string[]): number | null {
  const want = new Set(expected);
  const i = ranking.findIndex((n) => want.has(n));
  return i === -1 ? null : i + 1;
}

export interface BundleCase {
  ntsbNo: string;
  passages: readonly { sectionKind: string }[];
}

export interface Coverage {
  /** Expected cases with a passage in the bundle. */
  cases: number;
  /** Of those, cases whose probable cause is in the bundle. */
  causes: number;
  /** `min(|expected|, maxCases)`. */
  denominator: number;
  caseRatio: number;
  causeRatio: number;
}

export function bundleCoverage(expected: readonly string[], bundle: readonly BundleCase[], maxCases: number): Coverage {
  if (expected.length === 0) throw new Error('a question needs at least one expected case');
  const want = new Set(expected);
  const hit = bundle.filter((c) => want.has(c.ntsbNo) && c.passages.length > 0);
  const cases = hit.length;
  const causes = hit.filter((c) => c.passages.some((p) => p.sectionKind === 'probable_cause')).length;
  const denominator = Math.min(expected.length, maxCases);
  return { cases, causes, denominator, caseRatio: cases / denominator, causeRatio: causes / denominator };
}

export interface ModeScore {
  recall: Record<`at${RecallK}`, number>;
  firstHitRank: number | null;
  coverage: Coverage;
}

export interface Aggregate {
  questions: number;
  recallAt6: number;
  recallAt10: number;
  recallAt20: number;
  /** Share of questions with recall@20 = 1. */
  fullRecallAt20: number;
  /** Share of questions with at least one expected case in the bundle. */
  anyInBundle: number;
  coverageCases: number;
  coverageCauses: number;
}

const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (x: number) => Math.round(x * 10_000) / 10_000;

export function aggregate(scores: readonly ModeScore[]): Aggregate {
  return {
    questions: scores.length,
    recallAt6: round(mean(scores.map((s) => s.recall.at6))),
    recallAt10: round(mean(scores.map((s) => s.recall.at10))),
    recallAt20: round(mean(scores.map((s) => s.recall.at20))),
    fullRecallAt20: round(mean(scores.map((s) => (s.recall.at20 === 1 ? 1 : 0)))),
    anyInBundle: round(mean(scores.map((s) => (s.coverage.cases > 0 ? 1 : 0)))),
    coverageCases: round(mean(scores.map((s) => s.coverage.caseRatio))),
    coverageCauses: round(mean(scores.map((s) => s.coverage.causeRatio))),
  };
}

export function scoreMode(expected: readonly string[], ranking: readonly string[], bundle: readonly BundleCase[], maxCases: number): ModeScore {
  return {
    recall: { at6: recallAt(expected, ranking, 6), at10: recallAt(expected, ranking, 10), at20: recallAt(expected, ranking, 20) },
    firstHitRank: firstHitRank(expected, ranking),
    coverage: bundleCoverage(expected, bundle, maxCases),
  };
}
