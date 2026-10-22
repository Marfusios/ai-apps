/**
 * Retrieval metrics of the evaluation (amendment A13; review gate G5). Pure.
 *
 * Candidate ranking (stage 1):
 * - **Case recall@k**: expected cases among the first `k` unique cases, divided by
 *   `min(|expected|, k)`. The silver set keeps `|expected| <= 20` (rules, never
 *   capping), so recall@20 is the plain recall.
 *
 * Packed bundle (stage 2), all divided by `min(|expected|, maxCases)` unless noted:
 * - **Case coverage**: expected cases with at least one passage in the bundle.
 * - **Evidence coverage** (question-specific): expected cases whose bundle passages,
 *   retrieved or attached, satisfy the question's own text criterion (every text rule
 *   of its derivation matched by a passage of the rule's section kinds). Null for a
 *   question whose rule has no text part.
 * - **Cause coverage (structural)**: expected cases whose probable-cause passage is in
 *   the bundle. Packing attaches every selected case's cause, so this equals case
 *   coverage by construction; it is kept as a structural check only.
 * - **Bundle precision**: the share of bundle cases that are expected (null for an
 *   empty bundle).
 * - **nDCG@6**: binary relevance over the bundle's cases in rank order, against an
 *   ideal bundle of `min(|expected|, 6)` expected cases.
 * Means are macro averages over the questions where a metric is defined.
 */
import { satisfiesTextCriterion, type Criteria } from './silver.js';

export const RECALL_KS = [6, 10, 20] as const;
export type RecallK = (typeof RECALL_KS)[number];
export const NDCG_K = 6;

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
  passages: readonly { sectionKind: string; text: string }[];
}

export interface Coverage {
  /** Expected cases with a passage in the bundle. */
  cases: number;
  /** Of those, cases whose passages satisfy the question's text criterion; null without one. */
  evidence: number | null;
  /** Of those, cases whose probable cause is in the bundle (structural). */
  causes: number;
  /** `min(|expected|, maxCases)`. */
  denominator: number;
  caseRatio: number;
  evidenceRatio: number | null;
  causeRatio: number;
}

export function bundleCoverage(expected: readonly string[], bundle: readonly BundleCase[], maxCases: number, criteria?: Criteria): Coverage {
  if (expected.length === 0) throw new Error('a question needs at least one expected case');
  const want = new Set(expected);
  const hit = bundle.filter((c) => want.has(c.ntsbNo) && c.passages.length > 0);
  const cases = hit.length;
  const causes = hit.filter((c) => c.passages.some((p) => p.sectionKind === 'probable_cause')).length;
  const hasText = criteria !== undefined && (criteria.text ?? []).length > 0;
  const evidence = hasText ? hit.filter((c) => satisfiesTextCriterion(criteria, c.passages) === true).length : null;
  const denominator = Math.min(expected.length, maxCases);
  return {
    cases,
    evidence,
    causes,
    denominator,
    caseRatio: cases / denominator,
    evidenceRatio: evidence === null ? null : evidence / denominator,
    causeRatio: causes / denominator,
  };
}

/** Share of bundle cases that are expected; null for an empty bundle. */
export function bundlePrecision(expected: readonly string[], bundleCases: readonly string[]): number | null {
  if (bundleCases.length === 0) return null;
  const want = new Set(expected);
  return bundleCases.filter((n) => want.has(n)).length / bundleCases.length;
}

/** nDCG@k with binary relevance over `ranked` (bundle cases in rank order). */
export function ndcgAt(expected: readonly string[], ranked: readonly string[], k = NDCG_K): number {
  if (expected.length === 0) throw new Error('a question needs at least one expected case');
  const want = new Set(expected);
  const gain = (i: number) => 1 / Math.log2(i + 2);
  const dcg = ranked.slice(0, k).reduce((sum, n, i) => sum + (want.has(n) ? gain(i) : 0), 0);
  let ideal = 0;
  for (let i = 0; i < Math.min(expected.length, k); i += 1) ideal += gain(i);
  return dcg / ideal;
}

export interface ModeScore {
  recall: Record<`at${RecallK}`, number>;
  firstHitRank: number | null;
  coverage: Coverage;
  precision: number | null;
  ndcg6: number;
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
  /** Question-specific evidence coverage, over `evidenceQuestions` questions. */
  coverageEvidence: number | null;
  evidenceQuestions: number;
  /** Structural: equals case coverage while every selected case gets its cause. */
  coverageCausesStructural: number;
  bundlePrecision: number | null;
  ndcg6: number;
}

const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (x: number) => Math.round(x * 10_000) / 10_000;
const defined = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

export function aggregate(scores: readonly ModeScore[]): Aggregate {
  const evidence = defined(scores.map((s) => s.coverage.evidenceRatio));
  const precision = defined(scores.map((s) => s.precision));
  return {
    questions: scores.length,
    recallAt6: round(mean(scores.map((s) => s.recall.at6))),
    recallAt10: round(mean(scores.map((s) => s.recall.at10))),
    recallAt20: round(mean(scores.map((s) => s.recall.at20))),
    fullRecallAt20: round(mean(scores.map((s) => (s.recall.at20 === 1 ? 1 : 0)))),
    anyInBundle: round(mean(scores.map((s) => (s.coverage.cases > 0 ? 1 : 0)))),
    coverageCases: round(mean(scores.map((s) => s.coverage.caseRatio))),
    coverageEvidence: evidence.length === 0 ? null : round(mean(evidence)),
    evidenceQuestions: evidence.length,
    coverageCausesStructural: round(mean(scores.map((s) => s.coverage.causeRatio))),
    bundlePrecision: precision.length === 0 ? null : round(mean(precision)),
    ndcg6: round(mean(scores.map((s) => s.ndcg6))),
  };
}

export function scoreMode(
  expected: readonly string[],
  ranking: readonly string[],
  bundle: readonly BundleCase[],
  maxCases: number,
  criteria?: Criteria,
): ModeScore {
  const bundleCases = bundle.map((c) => c.ntsbNo);
  return {
    recall: { at6: recallAt(expected, ranking, 6), at10: recallAt(expected, ranking, 10), at20: recallAt(expected, ranking, 20) },
    firstHitRank: firstHitRank(expected, ranking),
    coverage: bundleCoverage(expected, bundle, maxCases, criteria),
    precision: bundlePrecision(expected, bundleCases),
    ndcg6: ndcgAt(expected, bundleCases, NDCG_K),
  };
}
