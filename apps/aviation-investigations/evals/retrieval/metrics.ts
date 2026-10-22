/**
 * Retrieval metrics. Pure. Two parts:
 *
 * **1. The protocol metrics** (task 10c protocol v4, section 5), for the coded-reference
 * track (Track C) and, later, the model-judged track (Track N). A question's reference
 * grades cases 0 (not relevant), 1 (partially relevant) or 2 (fully relevant), or
 * leaves them `unknown`; unknown cases keep their ranks and stay in every denominator.
 * - **Recall@20** (candidate ranking, unique cases): fully relevant cases among the
 *   first 20 / all fully relevant cases. Every positive counts (never capped). It is a
 *   gate metric only when the reference is exhaustive, has no unknown label and holds
 *   1 to 20 fully relevant cases; otherwise it is a diagnostic with its ceiling
 *   `min(1, 20 / relevant)`. It has no unknown bounds.
 * - **Strict P@6** (the returned list, at most 6 cases): fully relevant cases / 6,
 *   unfilled positions counting as zero; **precision among returned cases** divides by
 *   the cases returned instead (null for an empty list). With unknowns: lower = known
 *   fully relevant, upper = known fully relevant + unknown, over the same denominator.
 * - **nDCG@6** with gains 0/1/2 → 0/1/3; the ideal DCG comes from the reference's
 *   labels; an empty list scores 0 and is kept. With unknowns, the bounds are
 *   conditional on assignments with a positive ideal DCG: every assignment of grades
 *   {0,1,2} to the unknowns that affect DCG or the ideal DCG is enumerated when there
 *   are at most 12 of them, and the sound relaxation is used beyond (upper 0 when the
 *   maximum DCG is 0, else 1 when the minimum ideal DCG is 0, else max DCG / min ideal
 *   DCG clamped to 1; lower min DCG / max ideal DCG). A question where some assignment
 *   leaves no relevant case is flagged "no-positive reference possible"; one whose
 *   ideal DCG is 0 under every assignment abstains (no bounds, out of the nDCG means).
 * - Verdicts: a bounded metric passes when its lower bound reaches the threshold,
 *   fails when its upper bound does not, and is inconclusive when the bounds straddle
 *   it; a no-positive-possible question is inconclusive for an nDCG gate unless its
 *   lower bound passes and the no-positive outcome is resolved separately.
 *
 * Recall and the narrow/broad class count fully relevant (grade 2) cases
 * (`RECALL_MIN_GRADE`). A coded reference (`codedReference`, Track C) grades its coded
 * positives 2 and every other case 0 meaning "not coded": absence of a code is not a
 * negative relevance judgement, so its precision is reported as coded precision.
 *
 * **2. Silver diagnostics** (amendment A13; the regex silver set, a diagnostic only).
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
 * - **nDCG@6**: the protocol nDCG with every expected case fully relevant (binary
 *   relevance), against an ideal bundle of `min(|expected|, 6)` expected cases.
 * Means are macro averages over the questions where a metric is defined.
 */
import { satisfiesTextCriterion, type Criteria } from './silver.js';

// ===========================================================================
// 1. Protocol metrics (task 10c protocol v4, section 5)

export const GRADES = [0, 1, 2] as const;
export type Grade = (typeof GRADES)[number];
/** A case's grade, or `unknown` (unjudgeable, unresolved or abstained: never dropped). */
export type Label = Grade | 'unknown';

/** nDCG gain per grade: 0/1/2 → 0/1/3 (grade 1 is partially relevant). */
export const GAIN: Readonly<Record<Grade, number>> = Object.freeze({ 0: 0, 1: 1, 2: 3 });
/** Recall and the narrow/broad class count fully relevant cases. */
export const RECALL_MIN_GRADE: Grade = 2;
export const RECALL_K = 20;
/** Recall@20 gates only exhaustively known questions with 1 to this many relevant cases. */
export const RECALL_GATE_MAX_RELEVANT = 20;
/** The Recall@20 target of gate-eligible questions. */
export const RECALL_TARGET = 0.9;
export const PRECISION_K = 6;
export const NDCG_K = 6;
/** nDCG bounds enumerate grade assignments exhaustively up to this many affecting unknowns. */
export const NDCG_ENUMERATION_LIMIT = 12;

export interface Reference {
  /** The grade, or `unknown`, of every labelled case. */
  readonly labels: ReadonlyMap<string, Label>;
  /**
   * The label of every other case: 0 where the reference decides it (Track C: "not
   * coded"; a fully judged cohort: outside it), `unknown` where it does not.
   */
  readonly unlisted: 0 | 'unknown';
  /** The relevant set is exhaustively known for the question's cohort. */
  readonly exhaustive: boolean;
}

export function makeReference(labels: Iterable<readonly [string, Label]>, opts: { unlisted: 0 | 'unknown'; exhaustive: boolean }): Reference {
  if (opts.exhaustive && opts.unlisted !== 0) throw new Error('an exhaustive reference decides every case: unlisted cases are 0');
  const map = new Map<string, Label>();
  for (const [ntsbNo, label] of labels) {
    if (label !== 'unknown' && !(GRADES as readonly number[]).includes(label)) throw new Error(`invalid grade for ${ntsbNo}`);
    if (map.has(ntsbNo)) throw new Error(`${ntsbNo} is labelled twice`);
    map.set(ntsbNo, label);
  }
  return { labels: map, unlisted: opts.unlisted, exhaustive: opts.exhaustive };
}

/**
 * A coded reference (Track C): the coded positives are fully relevant (2) and every
 * other case is 0, meaning "not coded", never a judged negative. Exhaustive (exact
 * membership over the cohort), without unknowns.
 */
export function codedReference(positives: readonly string[]): Reference {
  return makeReference(
    positives.map((n) => [n, 2] as const),
    { unlisted: 0, exhaustive: true },
  );
}

export const labelOf = (ref: Reference, ntsbNo: string): Label => ref.labels.get(ntsbNo) ?? ref.unlisted;

/** The first `k` distinct entries of `list`, in order: depth counts unique cases. */
export function uniqueTop(list: readonly string[], k: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of list) {
    if (out.length >= k) break;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export interface Bounds {
  lower: number;
  upper: number;
}

const fullyRelevant = (ref: Reference): string[] =>
  [...ref.labels].filter(([, l]) => l !== 'unknown' && l >= RECALL_MIN_GRADE).map(([n]) => n);
const hasUnknown = (ref: Reference): boolean => ref.unlisted === 'unknown' || [...ref.labels.values()].includes('unknown');

export type RecallIneligibility = 'not-exhaustive' | 'unknown-labels' | 'no-relevant' | 'more-than-20';

export interface RecallScore {
  /** Fully relevant cases among the first 20 unique cases / all fully relevant cases (never capped); null without one. */
  value: number | null;
  found: number;
  relevant: number;
  /** The most any ranking can reach: min(1, 20 / relevant); null without a relevant case. */
  ceiling: number | null;
  /** `eligible`: the question is gated on Recall@20; `diagnostic`: reported with its ceiling only. */
  gate: 'eligible' | 'diagnostic';
  /** Why the question is not gated on recall; null when it is. */
  reason: RecallIneligibility | null;
}

/** Recall@20 of a candidate case ranking. No unknown bounds: an unknown label makes it a diagnostic. */
export function recallAt20(ranking: readonly string[], ref: Reference): RecallScore {
  const relevant = fullyRelevant(ref);
  const top = new Set(uniqueTop(ranking, RECALL_K));
  const found = relevant.filter((n) => top.has(n)).length;
  const reason: RecallIneligibility | null = !ref.exhaustive
    ? 'not-exhaustive'
    : hasUnknown(ref)
      ? 'unknown-labels'
      : relevant.length === 0
        ? 'no-relevant'
        : relevant.length > RECALL_GATE_MAX_RELEVANT
          ? 'more-than-20'
          : null;
  return {
    value: relevant.length === 0 ? null : found / relevant.length,
    found,
    relevant: relevant.length,
    ceiling: relevant.length === 0 ? null : Math.min(1, RECALL_K / relevant.length),
    gate: reason === null ? 'eligible' : 'diagnostic',
    reason,
  };
}

export interface PrecisionScore {
  /** Strict P@6: fully relevant cases among the first 6 / 6, unfilled positions counting as zero. */
  strict: Bounds;
  /** Fully relevant cases among the returned ones (at most 6) / returned; null for an empty list. */
  amongReturned: Bounds | null;
  returned: number;
  /** Unknown-grade cases among the returned. */
  unknown: number;
}

/** Strict P@6 and precision among returned cases, with exact bounds over the unknowns. */
export function precisionAt6(returned: readonly string[], ref: Reference): PrecisionScore {
  const top = uniqueTop(returned, PRECISION_K);
  let full = 0;
  let unknown = 0;
  for (const n of top) {
    const label = labelOf(ref, n);
    if (label === 'unknown') unknown += 1;
    else if (label === 2) full += 1;
  }
  return {
    strict: { lower: full / PRECISION_K, upper: (full + unknown) / PRECISION_K },
    amongReturned: top.length === 0 ? null : { lower: full / top.length, upper: (full + unknown) / top.length },
    returned: top.length,
    unknown,
  };
}

const discount = (i: number): number => 1 / Math.log2(i + 2);

/** DCG of gains in rank order, first `k`. */
function dcgOf(gains: readonly number[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, gains.length); i += 1) sum += (gains[i] as number) * discount(i);
  return sum;
}

/** Ideal DCG: the gains in descending order. */
const idcgOf = (gains: readonly number[], k: number): number => dcgOf([...gains].sort((a, b) => b - a), k);

export interface NdcgScore {
  /** Null when the question abstains; equal bounds when no unknown affects either term. */
  bounds: Bounds | null;
  /** `exact`: no affecting unknown; `enumeration`: every assignment (≤ 12 affecting unknowns); `relaxation`: beyond. */
  method: 'exact' | 'enumeration' | 'relaxation';
  /** Unknowns that affect DCG (returned within the first 6) or the ideal DCG. */
  affectingUnknowns: number;
  /** Some assignment of the unknowns leaves no relevant case (ideal DCG 0): "no-positive reference possible". */
  noPositivePossible: boolean;
  /** The ideal DCG is 0 under every assignment: no bounds; listed as an abstention, out of the nDCG means. */
  abstention: boolean;
}

/**
 * nDCG@6 with gains 0/1/3 over `returned` in rank order; the ideal DCG comes from the
 * reference's labels. With unknowns, the bounds are conditional on assignments with a
 * positive ideal DCG (module comment). The enumeration is exhaustive: an unknown that
 * is not returned within the first `k` enters only the ideal DCG, through how many such
 * unknowns get each grade, so every assignment is covered by enumerating the grades of
 * the returned unknowns and those counts. With six or more known fully relevant cases
 * the ideal DCG is at its maximum whatever the unknowns, so unknowns that are not
 * returned affect neither term.
 */
export function ndcgAt6(returned: readonly string[], ref: Reference, k = NDCG_K): NdcgScore {
  const top = uniqueTop(returned, k);
  const listed = new Set(top);
  let knownDcg = 0;
  const unknownPositions: number[] = [];
  top.forEach((n, i) => {
    const label = labelOf(ref, n);
    if (label === 'unknown') unknownPositions.push(i);
    else knownDcg += GAIN[label] * discount(i);
  });
  const knownGains: number[] = [];
  let fully = 0;
  let unknownElsewhere = 0;
  for (const [n, label] of ref.labels) {
    if (label === 'unknown') {
      if (!listed.has(n)) unknownElsewhere += 1;
    } else {
      if (label > 0) knownGains.push(GAIN[label]);
      if (label === 2) fully += 1;
    }
  }
  const elsewhere = fully >= k ? 0 : unknownElsewhere;
  const affectingUnknowns = unknownPositions.length + elsewhere;
  const noPositivePossible = knownGains.length === 0;
  const abstention = noPositivePossible && unknownPositions.length + unknownElsewhere === 0;
  if (abstention) return { bounds: null, method: 'exact', affectingUnknowns: 0, noPositivePossible, abstention };
  if (affectingUnknowns === 0) {
    const value = knownDcg / idcgOf(knownGains, k);
    return { bounds: { lower: value, upper: value }, method: 'exact', affectingUnknowns, noPositivePossible, abstention };
  }
  if (affectingUnknowns <= NDCG_ENUMERATION_LIMIT) {
    let lower = Number.POSITIVE_INFINITY;
    let upper = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < 3 ** unknownPositions.length; a += 1) {
      let dcg = knownDcg;
      const listedGains: number[] = [];
      let rest = a;
      for (const position of unknownPositions) {
        const gain = GAIN[(rest % 3) as Grade];
        rest = Math.floor(rest / 3);
        dcg += gain * discount(position);
        if (gain > 0) listedGains.push(gain);
      }
      for (let full = 0; full <= Math.min(elsewhere, k); full += 1) {
        for (let partial = 0; partial <= Math.min(elsewhere - full, k); partial += 1) {
          const gains = [...knownGains, ...listedGains, ...Array<number>(full).fill(GAIN[2]), ...Array<number>(partial).fill(GAIN[1])];
          const ideal = idcgOf(gains, k);
          if (ideal <= 0) continue;
          lower = Math.min(lower, dcg / ideal);
          upper = Math.max(upper, dcg / ideal);
        }
      }
    }
    return { bounds: { lower, upper }, method: 'enumeration', affectingUnknowns, noPositivePossible, abstention };
  }
  const maxDcg = knownDcg + unknownPositions.reduce((sum, position) => sum + GAIN[2] * discount(position), 0);
  const minIdcg = idcgOf(knownGains, k);
  const maxIdcg = idcgOf([...knownGains, ...Array<number>(Math.min(affectingUnknowns, k)).fill(GAIN[2])], k);
  const upper = maxDcg === 0 ? 0 : minIdcg === 0 ? 1 : Math.min(1, maxDcg / minIdcg);
  return { bounds: { lower: knownDcg / maxIdcg, upper }, method: 'relaxation', affectingUnknowns, noPositivePossible, abstention };
}

export type Verdict = 'pass' | 'fail' | 'inconclusive';

/** A bounded metric against a threshold: pass when the lower bound reaches it, fail when the upper bound does not. */
export function boundedVerdict(b: Bounds, threshold: number): Verdict {
  if (b.lower >= threshold) return 'pass';
  if (b.upper < threshold) return 'fail';
  return 'inconclusive';
}

/**
 * An nDCG@6 gate: null for an abstention (not gated); a no-positive-possible question is
 * inconclusive unless its conditional lower bound passes and the no-positive outcome is
 * resolved separately.
 */
export function ndcgVerdict(s: NdcgScore, threshold: number, noPositiveResolved = false): Verdict | null {
  if (s.abstention || s.bounds === null) return null;
  if (s.noPositivePossible) return s.bounds.lower >= threshold && noPositiveResolved ? 'pass' : 'inconclusive';
  return boundedVerdict(s.bounds, threshold);
}

/** The Recall@20 gate: null unless the question is eligible. */
export function recallVerdict(r: RecallScore, target = RECALL_TARGET): Verdict | null {
  if (r.gate !== 'eligible' || r.value === null) return null;
  return r.value >= target ? 'pass' : 'fail';
}

export interface ProtocolScore {
  recall: RecallScore;
  precision: PrecisionScore;
  ndcg: NdcgScore;
}

/** One question: Recall@20 on the candidate `ranking`; P@6 and nDCG@6 on the `returned` list (rank order). */
export function scoreQuestion(ranking: readonly string[], returned: readonly string[], ref: Reference): ProtocolScore {
  return { recall: recallAt20(ranking, ref), precision: precisionAt6(returned, ref), ndcg: ndcgAt6(returned, ref) };
}

export interface ProtocolAggregate {
  questions: number;
  /** Gate-eligible questions: mean Recall@20 and the share at or above the target. */
  recallGate: { questions: number; mean: number | null; atTarget: number | null };
  /** Every other question with a relevant case: mean Recall@20 and mean ceiling (diagnostic). */
  recallDiagnostic: { questions: number; mean: number | null; ceiling: number | null };
  /** Mean strict P@6 bounds over every question. */
  strictP6: Bounds | null;
  /** Mean precision among returned cases, over the questions that returned a case. */
  precisionReturned: (Bounds & { questions: number }) | null;
  /** Mean nDCG@6 bounds; abstentions are left out, empty lists count 0. */
  ndcg6: (Bounds & { questions: number }) | null;
  abstentions: number;
  noPositivePossible: number;
  emptyResults: number;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const meanOf = (xs: readonly number[]): number | null => (xs.length === 0 ? null : round4(xs.reduce((a, b) => a + b, 0) / xs.length));
const meanBounds = (bs: readonly Bounds[]): Bounds | null =>
  bs.length === 0 ? null : { lower: meanOf(bs.map((b) => b.lower)) as number, upper: meanOf(bs.map((b) => b.upper)) as number };

/** Macro averages; a mean of lower (upper) bounds bounds the mean from below (above). */
export function aggregateProtocol(scores: readonly ProtocolScore[]): ProtocolAggregate {
  const gated = scores.filter((s) => s.recall.gate === 'eligible');
  const diagnostic = scores.filter((s) => s.recall.gate === 'diagnostic' && s.recall.value !== null);
  const returned = scores.map((s) => s.precision.amongReturned).filter((b): b is Bounds => b !== null);
  const ndcg = scores.map((s) => s.ndcg.bounds).filter((b): b is Bounds => b !== null);
  const precision = meanBounds(returned);
  const ndcgMean = meanBounds(ndcg);
  return {
    questions: scores.length,
    recallGate: {
      questions: gated.length,
      mean: meanOf(gated.map((s) => s.recall.value as number)),
      atTarget: meanOf(gated.map((s) => (recallVerdict(s.recall) === 'pass' ? 1 : 0))),
    },
    recallDiagnostic: {
      questions: diagnostic.length,
      mean: meanOf(diagnostic.map((s) => s.recall.value as number)),
      ceiling: meanOf(diagnostic.map((s) => s.recall.ceiling as number)),
    },
    strictP6: meanBounds(scores.map((s) => s.precision.strict)),
    precisionReturned: precision && { ...precision, questions: returned.length },
    ndcg6: ndcgMean && { ...ndcgMean, questions: ndcg.length },
    abstentions: scores.filter((s) => s.ndcg.abstention).length,
    noPositivePossible: scores.filter((s) => s.ndcg.noPositivePossible).length,
    emptyResults: scores.filter((s) => s.precision.returned === 0).length,
  };
}

// ===========================================================================
// 2. Silver diagnostics (amendment A13)

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

/** nDCG@k with binary relevance over `ranked` (bundle cases in rank order): the protocol nDCG, every expected case fully relevant. */
export function ndcgAt(expected: readonly string[], ranked: readonly string[], k = NDCG_K): number {
  if (expected.length === 0) throw new Error('a question needs at least one expected case');
  return (ndcgAt6(ranked, codedReference(uniqueTop(expected, expected.length)), k).bounds as Bounds).lower;
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
const round = round4;
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
