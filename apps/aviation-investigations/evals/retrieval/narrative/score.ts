/**
 * Track N metrics and diagnostics (task 10c protocol v4, section 5). Every score here is
 * **model-judged**; none is expert-adjudicated.
 *
 * **References.** A family's judged labels (`relevanceLabels`) become a `Reference` of the
 * protocol metric module (`metrics.ts`): a bounded cohort lists every cohort case (a
 * case without a judgment is `unknown`), cases outside it are outside the filters (0),
 * and it is exhaustive, so Recall@20 is a gate metric exactly when the cohort holds no
 * unknown and 1 to 20 fully relevant cases; a broad question lists its pool and leaves
 * every other case `unknown` (not exhaustive). Unknown cases keep their ranks and stay in
 * every denominator.
 *
 * **Per run** (member, method, scope sample): Recall@20 on the ranking, strict P@6 and
 * nDCG@6 (gains 0/1/3, ideal from the versioned judgments, bounds over the unknowns by
 * enumeration or the sound relaxation) on the delivered bundle, and **supported P@6**:
 * bundle cases that are fully relevant on the complete record *and* whose delivered
 * passages establish it (bundle answerability 2), over 6, with exact bounds (a case with
 * an unknown in either judgment counts in the upper bound only). Per question the value
 * is the mean over the scope samples, as in phase A.
 *
 * **Comparisons.** Paired group bootstrap by connected case group (`stats.ts`), on the
 * lower and the upper bounds separately.
 *
 * **Diagnostics.** Judged coverage of each pool and bounded cohort (known, unresolved
 * and not yet judged); discovery as depth grows; method-exclusive relevant cases; the tail
 * samples' relevant share with Wilson intervals scaled to their strata (coverage, never a
 * bound); judge-judge Cohen's kappa (unweighted and linear-weighted) with group-bootstrap
 * intervals, agreement with Wilson intervals and confusion matrices, per tag and per
 * grade; judge-adjudicator agreement; calibration accuracy against the frozen labels;
 * and candidate code-narrative discrepancies (logged, never applied to any label).
 *
 * **Audit samples.** Two disjoint samples of judged pairs, one for the AI audit and one
 * for the non-expert owner audit, each stratified by tag, final label and agreement
 * class (agreements as well as disagreements), with the stratum sizes so findings can be
 * weighted back. They audit model-judged labels (do the cited quotes entail the grade?);
 * neither audit is expert adjudication.
 *
 * **Diagnostics** (task 10c-2 round 4), reported apart from the benchmark: a regression
 * diagnostic under the comparison rules frozen with its question (`regressionDiagnostic`:
 * each variant against the base per sample and on the mean, the conclusion on the primary
 * metric only, the displaced and admitted cases, the coded values set against the ones
 * that first showed the regression); the retrieval runs' own mapping (`ordinaryMapping`);
 * and the labelled, forced mapping diagnostic (`mappingDiagnosticReport`: its outcomes,
 * relevance on the complete record against the delivered bundle's answerability, and
 * whether a supported bundle rests on a mapped passage or only on the attached cause).
 */
import { codedReference, makeReference, scoreQuestion, uniqueTop, type Bounds, type Label, type ProtocolScore, type Reference } from '../metrics.js';
import { ZERO_TOLERANCE, mulberry32, pairedGroupBootstrap, percentile, type BootstrapResult } from '../experiments/stats.js';
import { itemFamily, itemKey, seededSample, type CalibrationItem } from './calibration.js';
import { CALIBRATION_CRITERIA } from './criteria.js';
import type { NarrativeDataset, NarrativeItem } from './dataset.js';
import type { PairRecord } from './judging.js';
import { bundleKeyOf } from './judging.js';
import type { FamilyPool, PoolRun } from './pool.js';
import { GRADES, REFERENCE, type Grade } from './spec.js';

export { REFERENCE };

// ---------------------------------------------------------------------------
// Labels and references

/** The relevance label of every judged case, per family. */
export function relevanceLabels(records: readonly PairRecord[]): Map<string, Map<string, Label>> {
  const out = new Map<string, Map<string, Label>>();
  for (const r of records) {
    if (r.kind !== 'relevance') continue;
    const m = out.get(r.family) ?? new Map<string, Label>();
    m.set(r.ntsbNo, r.label);
    out.set(r.family, m);
  }
  return out;
}

/** The answerability label of every judged delivered case, per family, by `ntsbNo|bundleKey`. */
export function answerabilityLabels(records: readonly PairRecord[]): Map<string, Map<string, Label>> {
  const out = new Map<string, Map<string, Label>>();
  for (const r of records) {
    if (r.kind !== 'answerability' || r.bundleKey === null) continue;
    const m = out.get(r.family) ?? new Map<string, Label>();
    m.set(`${r.ntsbNo}|${r.bundleKey}`, r.label);
    out.set(r.family, m);
  }
  return out;
}

/** A family's reference (module comment). */
export function familyReference(pool: Pick<FamilyPool, 'type' | 'cases'> & { cohort?: readonly string[] | null }, labels: ReadonlyMap<string, Label>): Reference {
  if (pool.type === 'bounded-cohort') {
    const cohort = pool.cohort ?? pool.cases.map((c) => c.ntsbNo);
    return makeReference(
      cohort.map((n) => [n, labels.get(n) ?? 'unknown'] as const),
      { unlisted: 0, exhaustive: true },
    );
  }
  return makeReference(
    pool.cases.map((c) => [c.ntsbNo, labels.get(c.ntsbNo) ?? 'unknown'] as const),
    { unlisted: 'unknown', exhaustive: false },
  );
}

// ---------------------------------------------------------------------------
// Runs

export interface RunScore {
  member: string;
  method: string;
  sample: number;
  protocol: ProtocolScore;
  /** Supported P@6 (module comment). */
  supported: Bounds;
}

/** Strict supported P@6 of one bundle with exact bounds. */
export function supportedAt6(bundle: PoolRun['bundle'], relevance: (n: string) => Label, answerable: (n: string, key: string) => Label): Bounds {
  let lower = 0;
  let upper = 0;
  for (const b of bundle.slice(0, 6)) {
    const r = relevance(b.ntsbNo);
    const a = answerable(b.ntsbNo, bundleKeyOf(b.passages));
    if (r === 2 && a === 2) lower += 1;
    if ((r === 2 || r === 'unknown') && (a === 2 || a === 'unknown')) upper += 1;
  }
  return { lower: lower / 6, upper: upper / 6 };
}

export function scoreRuns(pool: FamilyPool, ref: Reference, answerability: ReadonlyMap<string, Label>): RunScore[] {
  const label = (n: string): Label => ref.labels.get(n) ?? ref.unlisted;
  return pool.runs.map((run) => ({
    member: run.member,
    method: run.method,
    sample: run.sample,
    protocol: scoreQuestion(run.ranking, run.bundle.map((b) => b.ntsbNo), ref),
    supported: supportedAt6(run.bundle, label, (n, key) => answerability.get(`${n}|${key}`) ?? 'unknown'),
  }));
}

export interface QuestionValue {
  member: string;
  family: string;
  method: string;
  /** Mean over samples; null unless the question is eligible for the recall gate. */
  recallGate: number | null;
  recallDiagnostic: number | null;
  p6: Bounds;
  /** Null when the question abstains under every assignment (in any sample). */
  ndcg6: Bounds | null;
  /** In some sample an assignment of the unknowns leaves no relevant case: "no-positive reference possible", inconclusive for an nDCG gate unless resolved. */
  noPositivePossible: boolean;
  /** In some sample the ideal DCG is 0 under every assignment: out of the nDCG means, listed in the abstention table. */
  abstention: boolean;
  supported: Bounds;
}

const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanBounds = (bs: readonly Bounds[]): Bounds => ({ lower: meanOf(bs.map((b) => b.lower)), upper: meanOf(bs.map((b) => b.upper)) });

/** Each member's value per method: the mean of its scope samples. */
export function questionValues(pool: FamilyPool, runs: readonly RunScore[]): QuestionValue[] {
  const out: QuestionValue[] = [];
  for (const member of pool.members) {
    for (const method of [...new Set(runs.map((r) => r.method))]) {
      const mine = runs.filter((r) => r.member === member && r.method === method);
      if (mine.length === 0) continue;
      const recalls = mine.map((r) => r.protocol.recall);
      const eligible = recalls.every((r) => r.gate === 'eligible' && r.value !== null);
      const ndcgs = mine.map((r) => r.protocol.ndcg.bounds);
      out.push({
        member,
        family: pool.family,
        method,
        recallGate: eligible ? meanOf(recalls.map((r) => r.value as number)) : null,
        recallDiagnostic: recalls.every((r) => r.value !== null) ? meanOf(recalls.map((r) => r.value as number)) : null,
        p6: meanBounds(mine.map((r) => r.protocol.precision.strict)),
        ndcg6: ndcgs.every((b): b is Bounds => b !== null) ? meanBounds(ndcgs as Bounds[]) : null,
        noPositivePossible: mine.some((r) => r.protocol.ndcg.noPositivePossible),
        abstention: mine.some((r) => r.protocol.ndcg.abstention),
        supported: meanBounds(mine.map((r) => r.supported)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparisons: bounds on the improvement, then a group bootstrap

export type CompareMetric = 'p6' | 'supported' | 'ndcg6' | 'recallGate';

/** Bounds on one question's improvement of method `b` over method `a` (mean over scope samples). */
export interface DifferenceBounds {
  member: string;
  family: string;
  lower: number;
  upper: number;
  /** `joint`: optimised over the unknown labels the two methods share; `cross-endpoint`: b's lower minus a's upper, and b's upper minus a's lower; `exact`: no unknown. */
  method: 'joint' | 'cross-endpoint' | 'exact';
}

const topSix = (run: PoolRun) => uniqueTop(run.bundle.map((x) => x.ntsbNo), 6);
const bundleKeyIn = (run: PoolRun, n: string) => {
  const b = run.bundle.find((x) => x.ntsbNo === n);
  return b ? bundleKeyOf(b.passages) : '';
};

/** Strict (or supported) P@6 improvement bounds, jointly over the unknowns: each case and each delivered bundle is one independent unknown. */
function jointP6(member: string, runsA: readonly PoolRun[], runsB: readonly PoolRun[], label: (n: string) => Label, answerable: ((n: string, key: string) => Label) | null): { lower: number; upper: number; unknowns: number } {
  // Coefficient of each case (and bundle key) in b's mean P@6 minus a's.
  const coef = new Map<string, Map<string, number>>();
  const addRuns = (runs: readonly PoolRun[], sign: 1 | -1) => {
    for (const run of runs) {
      for (const n of topSix(run)) {
        const key = answerable ? bundleKeyIn(run, n) : '';
        const m = coef.get(n) ?? new Map<string, number>();
        m.set(key, (m.get(key) ?? 0) + sign / (6 * runs.length));
        coef.set(n, m);
      }
    }
  };
  addRuns(runsB, 1);
  addRuns(runsA, -1);
  let lower = 0;
  let upper = 0;
  let unknowns = 0;
  for (const [n, keys] of coef) {
    const rel = label(n);
    const r: readonly number[] = rel === 'unknown' ? [0, 1] : [rel === 2 ? 1 : 0];
    if (rel === 'unknown') unknowns += 1;
    let minA = 0;
    let maxA = 0;
    for (const [key, c] of keys) {
      const ans = answerable ? answerable(n, key) : 2;
      if (ans === 'unknown') {
        unknowns += 1;
        minA += Math.min(0, c);
        maxA += Math.max(0, c);
      } else {
        const a = ans === 2 ? 1 : 0;
        minA += c * a;
        maxA += c * a;
      }
    }
    lower += Math.min(...r.map((x) => x * minA));
    upper += Math.max(...r.map((x) => x * maxA));
  }
  return { lower, upper, unknowns };
}

/** Per-question improvement bounds of `b` over `a` for one metric (module comment of `DifferenceBounds`). */
export function methodDifferences(pool: FamilyPool, ref: Reference, answerability: ReadonlyMap<string, Label>, values: readonly QuestionValue[], a: string, b: string, metric: CompareMetric): DifferenceBounds[] {
  const out: DifferenceBounds[] = [];
  const label = (n: string): Label => ref.labels.get(n) ?? ref.unlisted;
  for (const member of pool.members) {
    const runsA = pool.runs.filter((r) => r.member === member && r.method === a);
    const runsB = pool.runs.filter((r) => r.member === member && r.method === b);
    if (runsA.length === 0 || runsB.length === 0) continue;
    if (metric === 'p6' || metric === 'supported') {
      const j = jointP6(member, runsA, runsB, label, metric === 'supported' ? (n, key) => answerability.get(`${n}|${key}`) ?? 'unknown' : null);
      out.push({ member, family: pool.family, lower: j.lower, upper: j.upper, method: j.unknowns > 0 ? 'joint' : 'exact' });
      continue;
    }
    const va = values.find((v) => v.member === member && v.method === a);
    const vb = values.find((v) => v.member === member && v.method === b);
    if (!va || !vb) continue;
    if (metric === 'recallGate') {
      if (va.recallGate === null || vb.recallGate === null) continue;
      out.push({ member, family: pool.family, lower: vb.recallGate - va.recallGate, upper: vb.recallGate - va.recallGate, method: 'exact' });
      continue;
    }
    if (va.ndcg6 === null || vb.ndcg6 === null) continue;
    const exact = va.ndcg6.lower === va.ndcg6.upper && vb.ndcg6.lower === vb.ndcg6.upper;
    out.push({ member, family: pool.family, lower: vb.ndcg6.lower - va.ndcg6.upper, upper: vb.ndcg6.upper - va.ndcg6.lower, method: exact ? 'exact' : 'cross-endpoint' });
  }
  return out;
}

export interface Comparison {
  questions: number;
  /** Group bootstrap of the questions' lower improvement bounds, and of their upper bounds. */
  lower: BootstrapResult | null;
  upper: BootstrapResult | null;
  /** `b-better` only when the lower bounds' one-sided 95% lower bound is above zero; `a-better` only when the upper bounds' one-sided 95% upper bound is below zero (`ZERO_TOLERANCE`). */
  conclusion: 'b-better' | 'a-better' | 'inconclusive';
}

/** Group bootstrap of improvement bounds (never of endpoint scores alone): a winner only when the whole interval clears zero. */
export function compareMethods(diffs: readonly DifferenceBounds[], groupOf: (member: string) => string, boot: { resamples: number; seed: number }): Comparison {
  if (diffs.length === 0) return { questions: 0, lower: null, upper: null, conclusion: 'inconclusive' };
  const run = (side: 'lower' | 'upper') => pairedGroupBootstrap(diffs.map((d) => ({ id: d.member, group: groupOf(d.member), base: 0, variant: d[side] })), boot.resamples, boot.seed);
  const lower = run('lower');
  const upper = run('upper');
  // One-sided 95% upper bound of the upper bounds: the 95th percentile, mirrored from lower95 by symmetry of the procedure.
  const upper95 = -pairedGroupBootstrap(diffs.map((d) => ({ id: d.member, group: groupOf(d.member), base: 0, variant: -d.upper })), boot.resamples, boot.seed).lower95;
  const conclusion = lower.lower95 > ZERO_TOLERANCE ? 'b-better' : upper95 < -ZERO_TOLERANCE ? 'a-better' : 'inconclusive';
  return { questions: diffs.length, lower, upper, conclusion };
}

/** Connected groups of questions: a family with its paraphrases, joined with any family sharing a fully relevant case. */
export function questionGroups(d: NarrativeDataset, labels: ReadonlyMap<string, ReadonlyMap<string, Label>>): Map<string, string> {
  const parent = new Map(d.questions.map((q) => [q.family, q.family]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const owner = new Map<string, string>();
  for (const [family, m] of [...labels.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [n, l] of m) {
      if (l !== 2) continue;
      const o = owner.get(n);
      if (o === undefined) owner.set(n, family);
      else if (find(o) !== find(family)) parent.set(find(family), find(o));
    }
  }
  return new Map(d.questions.map((q) => [q.id, find(q.family)]));
}

// ---------------------------------------------------------------------------
// Pool diagnostics

/** Fully relevant cases found by the union of the methods' first `d` cases, and how many each depth adds. */
export function discoveryByDepth(pool: FamilyPool, labels: ReadonlyMap<string, Label>, depths: readonly number[] = [10, 20, 30, 50, 75, 100]): { depth: number; relevant: number; added: number }[] {
  let previous = 0;
  return depths.map((depth) => {
    const found = new Set<string>();
    for (const run of pool.runs) for (const n of uniqueTop(run.ranking, depth)) if (labels.get(n) === 2) found.add(n);
    const added = found.size - previous;
    previous = found.size;
    return { depth, relevant: found.size, added };
  });
}

/** Fully relevant cases only one method retrieved within `depth` (any member and sample). */
export function methodExclusive(pool: FamilyPool, labels: ReadonlyMap<string, Label>, depth = 100): Record<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const run of pool.runs) for (const n of uniqueTop(run.ranking, depth)) if (labels.get(n) === 2) by.set(n, (by.get(n) ?? new Set()).add(run.method));
  const out: Record<string, string[]> = {};
  for (const [n, methods] of by) {
    if (methods.size !== 1) continue;
    const m = [...methods][0] as string;
    out[m] = [...(out[m] ?? []), n].sort();
  }
  return out;
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
}

/** Wilson 95% interval of `k` of `n`. */
export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n === 0) return { k, n, rate: null, lower: null, upper: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, lower: Math.max(0, c - h), upper: Math.min(1, c + h) };
}

/** The tail samples' relevant share, scaled to their strata (a coverage diagnostic; unknown samples are reported, not guessed). */
export function tailEstimate(pool: FamilyPool, labels: ReadonlyMap<string, Label>): { stratum: 'near' | 'far'; size: number; sampled: number; unknown: number; relevant: Rate; estimatedMissed: [number, number] | null }[] {
  return (['near', 'far'] as const).map((stratum) => {
    const sample = pool.tail[stratum];
    const size = stratum === 'near' ? pool.tail.nearSize : pool.tail.farSize;
    const known = sample.filter((n) => labels.get(n) !== undefined && labels.get(n) !== 'unknown');
    const relevant = wilson(known.filter((n) => labels.get(n) === 2).length, known.length);
    return {
      stratum,
      size,
      sampled: sample.length,
      unknown: sample.length - known.length,
      relevant,
      estimatedMissed: relevant.lower === null || relevant.upper === null ? null : [Math.round(relevant.lower * size), Math.round(relevant.upper * size)],
    };
  });
}

export interface Coverage {
  cases: number;
  /** A grade 0, 1 or 2. */
  known: number;
  /** Judged but unresolved (unjudgeable, abstained, escalation budget exhausted, uncovered). */
  unresolved: number;
  /** No judgment yet (a stopped or partial run): unknown as well. */
  notJudged: number;
}

/**
 * The units of coverage: every pool case is a case–question-family pair (a case judged for one
 * question family), and one investigation in several families counts once per family. The
 * distinct investigations behind the pairs are counted alongside.
 */
export function coverageUnits(pools: readonly Pick<FamilyPool, 'family' | 'cases'>[]): { pairs: number; investigations: number } {
  return { pairs: pools.reduce((n, p) => n + p.cases.length, 0), investigations: new Set(pools.flatMap((p) => p.cases.map((c) => c.ntsbNo))).size };
}

/** Judged coverage of a family's pool and, for a bounded cohort, of its cohort (protocol section 4: reported with every score). */
export function judgedCoverage(pool: Pick<FamilyPool, 'cases'>, labels: ReadonlyMap<string, Label>, cohort: readonly string[] | null): { pool: Coverage; cohort: Coverage | null } {
  const of = (cases: readonly string[]): Coverage => {
    const known = cases.filter((n) => { const l = labels.get(n); return l !== undefined && l !== 'unknown'; }).length;
    const judged = cases.filter((n) => labels.has(n)).length;
    return { cases: cases.length, known, unresolved: judged - known, notJudged: cases.length - judged };
  };
  return { pool: of(pool.cases.map((c) => c.ntsbNo)), cohort: cohort === null ? null : of(cohort) };
}

// ---------------------------------------------------------------------------
// Agreement

export type Confusion = number[][];

const emptyConfusion = (): Confusion => GRADES.map(() => GRADES.map(() => 0));

/** Cohen's kappa over grade pairs: unweighted and linear-weighted (ordinal 0/1/2). Null when undefined. */
export function cohenKappa(pairs: readonly (readonly [Grade, Grade])[]): { kappa: number | null; weighted: number | null } {
  const n = pairs.length;
  if (n === 0) return { kappa: null, weighted: null };
  const m = emptyConfusion();
  for (const [a, b] of pairs) (m[a] as number[])[b] = ((m[a] as number[])[b] as number) + 1;
  const row = m.map((r) => r.reduce((x, y) => x + y, 0) / n);
  const col = GRADES.map((_, j) => m.reduce((x, r) => x + (r[j] as number), 0) / n);
  let po = 0;
  let pe = 0;
  let wo = 0;
  let we = 0;
  for (const i of GRADES) {
    for (const j of GRADES) {
      const obs = ((m[i] as number[])[j] as number) / n;
      const exp = (row[i] as number) * (col[j] as number);
      const w = 1 - Math.abs(i - j) / 2;
      if (i === j) {
        po += obs;
        pe += exp;
      }
      wo += w * obs;
      we += w * exp;
    }
  }
  return { kappa: pe === 1 ? null : (po - pe) / (1 - pe), weighted: we === 1 ? null : (wo - we) / (1 - we) };
}

/** Investigation thresholds (protocol section 3): below either, the tag's judged scores are low-confidence and the cause is investigated. Never a validation claim above them. */
export const INVESTIGATION_THRESHOLDS = Object.freeze({ kappa: 0.7, agreement: 0.8 });

export interface AgreementCell {
  n: number;
  /** Kappa below 0.7 or agreement below 0.8 (or either undefined): the scores of this cell are low-confidence. */
  lowConfidence: boolean;
  agreement: Rate;
  kappa: number | null;
  weightedKappa: number | null;
  /** 95% group-bootstrap interval of the unweighted kappa (resampling question families). */
  kappaInterval: [number, number] | null;
  /** Rows: judge A's grade; columns: judge B's grade. */
  confusion: Confusion;
}

function agreementCell(pairs: readonly { group: string; a: Grade; b: Grade }[], boot: { resamples: number; seed: number }): AgreementCell {
  const m = emptyConfusion();
  for (const p of pairs) (m[p.a] as number[])[p.b] = ((m[p.a] as number[])[p.b] as number) + 1;
  const k = cohenKappa(pairs.map((p) => [p.a, p.b] as const));
  let interval: [number, number] | null = null;
  const groups = [...new Set(pairs.map((p) => p.group))].sort();
  if (groups.length >= 2 && k.kappa !== null) {
    const byGroup = new Map(groups.map((g) => [g, pairs.filter((p) => p.group === g)]));
    const rand = mulberry32(boot.seed);
    const stats: number[] = [];
    for (let i = 0; i < boot.resamples; i += 1) {
      const sample: (readonly [Grade, Grade])[] = [];
      for (let j = 0; j < groups.length; j += 1) for (const p of byGroup.get(groups[Math.floor(rand() * groups.length)] as string) as typeof pairs) sample.push([p.a, p.b]);
      const s = cohenKappa(sample).kappa;
      if (s !== null) stats.push(s);
    }
    stats.sort((x, y) => x - y);
    if (stats.length > 0) interval = [percentile(stats, 0.025), percentile(stats, 0.975)];
  }
  const agreement = wilson(pairs.filter((p) => p.a === p.b).length, pairs.length);
  const lowConfidence = k.kappa === null || agreement.rate === null || k.kappa < INVESTIGATION_THRESHOLDS.kappa || agreement.rate < INVESTIGATION_THRESHOLDS.agreement;
  return { n: pairs.length, lowConfidence, agreement, kappa: k.kappa, weightedKappa: k.weighted, kappaInterval: interval, confusion: m };
}

export interface AgreementReport {
  /** Pairs where both judges gave a valid grade. */
  judgeJudge: { all: AgreementCell; byTag: Record<string, AgreementCell>; byGrade: Record<string, AgreementCell> };
  /** Adjudicated pairs: the adjudicator's final grade against each judge, and against its own blind first grade; overall and per tag. */
  judgeAdjudicator: JudgeAdjudicator & { byTag: Record<string, JudgeAdjudicator> };
  statuses: Record<string, number>;
}

export interface JudgeAdjudicator {
  adjudicated: number;
  withA: Rate;
  withB: Rate;
  changedFromInitial: Rate;
  abstained: number;
}

function judgeAdjudicator(records: readonly PairRecord[]): JudgeAdjudicator {
  const adjudicated = records.filter((r) => r.adjudication !== null && (r.status === 'adjudicated' || r.status === 'abstained'));
  const final = adjudicated.filter((r) => r.status === 'adjudicated');
  const agreeWith = (i: 0 | 1) => {
    const usable = final.filter((r) => r.judges[i]?.grade !== null && r.judges[i]?.grade !== undefined);
    return wilson(usable.filter((r) => r.judges[i]?.grade === r.label).length, usable.length);
  };
  return {
    adjudicated: adjudicated.length,
    withA: agreeWith(0),
    withB: agreeWith(1),
    changedFromInitial: wilson(final.filter((r) => r.adjudication?.initial !== null && r.adjudication?.initial !== r.label).length, final.filter((r) => r.adjudication?.initial !== null).length),
    abstained: adjudicated.length - final.length,
  };
}

/** The agreement diagnostics of a set of pair records (protocol section 3: diagnostics, never validation). */
export function agreementReport(records: readonly PairRecord[], tagsOf: (family: string) => readonly string[], boot = { resamples: 2_000, seed: 20261023 }): AgreementReport {
  const pairs = records.flatMap((r) => {
    const [a, b] = r.judges;
    return a?.grade !== null && a?.grade !== undefined && b?.grade !== null && b?.grade !== undefined ? [{ r, group: r.family, a: a.grade, b: b.grade }] : [];
  });
  const byTag: Record<string, AgreementCell> = {};
  for (const tag of [...new Set(records.flatMap((r) => tagsOf(r.family)))].sort()) byTag[tag] = agreementCell(pairs.filter((p) => tagsOf(p.r.family).includes(tag)), boot);
  const byGrade: Record<string, AgreementCell> = {};
  for (const g of [...GRADES.map(String), 'unknown']) byGrade[g] = agreementCell(pairs.filter((p) => String(p.r.label) === g), boot);
  const statuses: Record<string, number> = {};
  for (const r of records) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const adjByTag: Record<string, JudgeAdjudicator> = {};
  for (const tag of Object.keys(byTag)) adjByTag[tag] = judgeAdjudicator(records.filter((r) => tagsOf(r.family).includes(tag)));
  return { judgeJudge: { all: agreementCell(pairs, boot), byTag, byGrade }, judgeAdjudicator: { ...judgeAdjudicator(records), byTag: adjByTag }, statuses };
}

// ---------------------------------------------------------------------------
// Calibration and discrepancies

// Calibration: the calculations and the frozen pass criteria are in criteria.ts.

export interface JudgeCalibration {
  /** Valid grades, of them equal to the constructed label; unusable outcomes (unjudgeable, failed, uncovered); items without a record. */
  valid: number;
  correct: number;
  failed: number;
  missing: number;
  /** Correct over expected: unusable outcomes and missing records count as wrong. */
  accuracy: Rate;
  /** Unusable outcomes and missing records over expected. */
  failureRate: Rate;
  /** Diagnostic only, never a criterion: correct over valid grades. */
  conditionalAccuracy: Rate;
}

export interface CalibrationCell {
  expected: number;
  /** Items with a record; with a finished one (not incomplete, not stopped before its escalation). */
  recorded: number;
  finished: number;
  /** Final labels known (a grade), and of them equal to the constructed label. */
  known: number;
  correct: number;
  /** Correct over expected: unknown labels and missing records count as wrong. */
  accuracy: Rate;
  /** Known final labels over expected. */
  coverage: Rate;
  /** Diagnostic only, never a criterion: correct over known final labels. */
  conditionalAccuracy: Rate;
  judgeA: JudgeCalibration;
  judgeB: JudgeCalibration;
  /** Rows: the constructed label 0, 1, 2; columns: the final label 0, 1, 2, unknown, no record. */
  confusion: number[][];
}

export interface CalibrationCheck {
  name: string;
  value: number | null;
  threshold: number;
  ok: boolean;
}

export interface CalibrationVerdict {
  criteria: string;
  /** `incomplete` cannot pass: some holdout item has no finished record. `not-run`: no holdout item was judged. */
  status: 'pass' | 'fail' | 'incomplete' | 'not-run';
  checks: CalibrationCheck[];
  reasons: string[];
}

export interface CalibrationReport {
  /** Cells by `split|set|family`, with totals `split|set|*` and `split|*|*`. */
  cells: Record<string, CalibrationCell>;
  /** Totals by `split|kind` (relevance and answerability items). */
  byKind: Record<string, CalibrationCell>;
  verdict: CalibrationVerdict;
  /** Records of the calibration set that match no frozen item. */
  unmatched: number;
}

const FINISHED_STATUSES: ReadonlySet<PairRecord['status']> = new Set(['agreed', 'adjudicated', 'abstained', 'adjudication-unjudgeable', 'unjudgeable', 'uncovered']);

function judgeCalibration(rows: readonly { item: CalibrationItem; r: PairRecord | undefined }[], i: 0 | 1): JudgeCalibration {
  let valid = 0;
  let correct = 0;
  let failed = 0;
  let missing = 0;
  for (const { item, r } of rows) {
    const j = r?.judges[i];
    if (!r || !j) {
      missing += 1;
      continue;
    }
    if (j.grade === null) {
      failed += 1;
      continue;
    }
    valid += 1;
    if (j.grade === item.label) correct += 1;
  }
  return { valid, correct, failed, missing, accuracy: wilson(correct, rows.length), failureRate: wilson(failed + missing, rows.length), conditionalAccuracy: wilson(correct, valid) };
}

function calibrationCell(rows: readonly { item: CalibrationItem; r: PairRecord | undefined }[]): CalibrationCell {
  const confusion = GRADES.map(() => [0, 0, 0, 0, 0]);
  let recorded = 0;
  let finished = 0;
  let known = 0;
  let correct = 0;
  for (const { item, r } of rows) {
    const row = confusion[item.label] as number[];
    if (!r) {
      row[4] = (row[4] as number) + 1;
      continue;
    }
    recorded += 1;
    if (FINISHED_STATUSES.has(r.status)) finished += 1;
    if (r.label === 'unknown') {
      row[3] = (row[3] as number) + 1;
      continue;
    }
    row[r.label] = (row[r.label] as number) + 1;
    known += 1;
    if (r.label === item.label) correct += 1;
  }
  return {
    expected: rows.length,
    recorded,
    finished,
    known,
    correct,
    accuracy: wilson(correct, rows.length),
    coverage: wilson(known, rows.length),
    conditionalAccuracy: wilson(correct, known),
    judgeA: judgeCalibration(rows, 0),
    judgeB: judgeCalibration(rows, 1),
    confusion,
  };
}

/** Calibration figures per split, set and family, and the frozen verdict on the holdout (criteria.ts). Labels are constructed, never expert. */
export function calibrationReport(items: readonly CalibrationItem[], records: readonly PairRecord[], criteria = CALIBRATION_CRITERIA): CalibrationReport {
  const byKey = new Map(records.map((r) => [`${r.kind}|${r.family}|${r.ntsbNo}|${r.bundleKey ?? ''}`, r]));
  const rows = items.map((item) => ({ item, r: byKey.get(itemKey(item)) }));
  const matched = new Set(items.map(itemKey));
  const unmatched = records.filter((r) => !matched.has(`${r.kind}|${r.family}|${r.ntsbNo}|${r.bundleKey ?? ''}`)).length;
  const groups = new Map<string, typeof rows>();
  const add = (key: string, row: (typeof rows)[number]) => groups.set(key, [...(groups.get(key) ?? []), row]);
  const kinds = new Map<string, typeof rows>();
  for (const row of rows) {
    const { split, set } = row.item;
    add(`${split}|${set}|${itemFamily(row.item)}`, row);
    add(`${split}|${set}|*`, row);
    add(`${split}|*|*`, row);
    kinds.set(`${split}|${row.item.kind}`, [...(kinds.get(`${split}|${row.item.kind}`) ?? []), row]);
  }
  const cells: Record<string, CalibrationCell> = {};
  for (const key of [...groups.keys()].sort()) cells[key] = calibrationCell(groups.get(key) as typeof rows);
  const byKind: Record<string, CalibrationCell> = {};
  for (const key of [...kinds.keys()].sort()) byKind[key] = calibrationCell(kinds.get(key) as typeof rows);
  return { cells, byKind, verdict: calibrationVerdict(cells, criteria), unmatched };
}

/** The verdict of the frozen criteria on the holdout split (criteria.ts). */
export function calibrationVerdict(cells: Readonly<Record<string, CalibrationCell>>, criteria = CALIBRATION_CRITERIA): CalibrationVerdict {
  const total = cells[`${criteria.split}|*|*`];
  const base = { criteria: criteria.version };
  if (!total || total.recorded === 0) return { ...base, status: 'not-run', checks: [], reasons: ['no holdout item has a record'] };
  if (total.finished < total.expected) {
    return { ...base, status: 'incomplete', checks: [], reasons: [`${total.expected - total.finished} of ${total.expected} holdout items have no finished record (missing, incomplete, or stopped before their escalation): an incomplete holdout cannot pass`] };
  }
  const checks: CalibrationCheck[] = [];
  const at = (name: string, value: number | null, threshold: number, atMost = false) => checks.push({ name, value, threshold, ok: value !== null && (atMost ? value <= threshold + 1e-12 : value >= threshold - 1e-12) });
  at('final labels: accuracy, Wilson 95% lower bound', total.accuracy.lower, criteria.overall.finalAccuracyLower);
  for (const [name, j] of [['judge A', total.judgeA], ['judge B', total.judgeB]] as const) {
    at(`${name}: accuracy, Wilson 95% lower bound`, j.accuracy.lower, criteria.overall.judgeAccuracyLower);
    at(`${name}: failure rate`, j.failureRate.rate, criteria.overall.judgeFailureRate, true);
  }
  for (const [key, c] of Object.entries(cells)) {
    const [split, set, family] = key.split('|');
    if (split !== criteria.split || set === '*' || family === '*') continue;
    at(`${set}/${family}: holdout items`, c.expected, criteria.perFamily.minItems);
    at(`${set}/${family}: final labels accuracy`, c.accuracy.rate, criteria.perFamily.finalAccuracy);
    at(`${set}/${family}: judge A accuracy`, c.judgeA.accuracy.rate, criteria.perFamily.judgeAccuracy);
    at(`${set}/${family}: judge B accuracy`, c.judgeB.accuracy.rate, criteria.perFamily.judgeAccuracy);
  }
  const failed = checks.filter((c) => !c.ok);
  return { ...base, status: failed.length === 0 ? 'pass' : 'fail', checks, reasons: failed.map((c) => `${c.name}: ${c.value === null ? 'undefined' : c.value.toFixed(3)} against ${c.threshold}`) };
}

export interface Discrepancy {
  family: string;
  ntsbNo: string;
  /** `coded-not-relevant`: a related-code positive graded 0; `relevant-not-coded`: graded 2 without the related code. */
  kind: 'coded-not-relevant' | 'relevant-not-coded';
  /** Whose grade disagrees with the code: the final label, or one judge's own grade. */
  by: 'final' | 'judge-a' | 'judge-b';
  grade: Grade;
}

/**
 * Candidate code-narrative discrepancies of the families with related codes (protocol
 * section 3): the final labels and each judge's grade against the related codes. Logged,
 * never applied to any label and never waived from any accuracy figure.
 */
export function discrepancies(d: NarrativeDataset, records: readonly PairRecord[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const positives = new Map(d.questions.filter((q) => q.relatedCodes !== undefined && q.paraphrase_of === undefined).map((q) => [q.family, new Set(q.relatedPositives)]));
  for (const r of records) {
    if (r.kind !== 'relevance') continue;
    const coded = positives.get(r.family);
    if (!coded) continue;
    const grades: [Discrepancy['by'], Grade | 'unknown' | null][] = [
      ['final', r.label],
      ['judge-a', r.judges[0]?.grade ?? null],
      ['judge-b', r.judges[1]?.grade ?? null],
    ];
    for (const [by, g] of grades) {
      if (g === null || g === 'unknown') continue;
      if (coded.has(r.ntsbNo) && g === 0) out.push({ family: r.family, ntsbNo: r.ntsbNo, kind: 'coded-not-relevant', by, grade: g });
      if (!coded.has(r.ntsbNo) && g === 2) out.push({ family: r.family, ntsbNo: r.ntsbNo, kind: 'relevant-not-coded', by, grade: g });
    }
  }
  const order = { final: 0, 'judge-a': 1, 'judge-b': 2 };
  return out.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.ntsbNo < b.ntsbNo ? -1 : a.ntsbNo > b.ntsbNo ? 1 : order[a.by] - order[b.by]));
}

// ---------------------------------------------------------------------------
// Audit samples

/** The audit sampling rule (module comment): one pair per stratum per auditor. */
export const AUDIT_RULE = Object.freeze({ version: 'track-n-audit-v1', perStratum: 1, seed: 'track-n-audit' });

export type AgreementClass = 'agreed' | 'disagreed' | 'judge-missing';

/** Both judges' valid grades equal (`agreed`), differ (`disagreed`), or a judge gave none (`judge-missing`). */
export function agreementClass(r: PairRecord): AgreementClass {
  const [a, b] = r.judges;
  if (a?.grade === null || a?.grade === undefined || b?.grade === null || b?.grade === undefined) return 'judge-missing';
  return a.grade === b.grade ? 'agreed' : 'disagreed';
}

export interface AuditStratum {
  tag: string;
  label: string;
  agreement: AgreementClass;
  /** Pairs in the stratum (a pair counts once for each of its family's tags) and sampled from it. */
  population: number;
  sampled: number;
}

export interface AuditSample {
  auditor: 'ai' | 'owner';
  rule: typeof AUDIT_RULE;
  reference: typeof REFERENCE;
  note: string;
  strata: AuditStratum[];
  /** The sampled pairs whole: grades, adjudication and the validated verdicts with their canonical quotes. */
  rows: (PairRecord & { stratum: { tag: string; label: string; agreement: AgreementClass } })[];
}

const pairId = (r: PairRecord) => `${r.kind}|${r.family}|${r.ntsbNo}|${r.bundleKey ?? ''}`;

/** The AI-audit and owner-audit samples of a set of pair records (module comment). Deterministic for a rule. */
export function auditSamples(records: readonly PairRecord[], tagsOf: (family: string) => readonly string[], rule = AUDIT_RULE): { ai: AuditSample; owner: AuditSample } {
  const strata = new Map<string, PairRecord[]>();
  for (const r of [...records].sort((x, y) => (pairId(x) < pairId(y) ? -1 : 1))) {
    for (const tag of tagsOf(r.family)) {
      const key = `${tag}|${String(r.label)}|${agreementClass(r)}`;
      strata.set(key, [...(strata.get(key) ?? []), r]);
    }
  }
  const keys = [...strata.keys()].sort();
  const taken = new Set<string>();
  const draw = (auditor: 'ai' | 'owner'): AuditSample => {
    const rows: AuditSample['rows'] = [];
    const counts: AuditStratum[] = [];
    for (const key of keys) {
      const [tag, label, agreement] = key.split('|') as [string, string, AgreementClass];
      const members = strata.get(key) as PairRecord[];
      const picks = seededSample(members.filter((r) => !taken.has(pairId(r))), rule.perStratum, `${rule.seed}|${auditor}|${key}`);
      for (const r of picks) {
        taken.add(pairId(r));
        rows.push({ ...r, stratum: { tag, label, agreement } });
      }
      counts.push({ tag, label, agreement, population: members.length, sampled: picks.length });
    }
    return {
      auditor,
      rule,
      reference: REFERENCE,
      note: `${auditor === 'ai' ? 'AI audit' : 'Non-expert owner audit'} sample of model-judged labels, stratified by tag, final label and agreement class (agreements as well as disagreements); disjoint from the other audit's sample. Not expert adjudication.`,
      strata: counts,
      rows,
    };
  };
  const ai = draw('ai');
  return { ai, owner: draw('owner') };
}

// ---------------------------------------------------------------------------
// Diagnostics (task 10c-2 round 4): reported apart from the benchmark aggregate

export type RegressionConclusion = 'regression' | 'no-regression' | 'inconclusive';

/** The frozen rule's conclusion from the primary metric's mean difference (variant minus base): regression only when its upper bound is below zero (`ZERO_TOLERANCE`). */
export const regressionConclusion = (d: { lower: number; upper: number } | null): RegressionConclusion =>
  d === null ? 'inconclusive' : d.upper < -ZERO_TOLERANCE ? 'regression' : d.lower >= -ZERO_TOLERANCE ? 'no-regression' : 'inconclusive';

export interface RegressionMethodValue {
  ndcg6: Bounds | null;
  p6: Bounds;
  supported: Bounds;
  /** On the related codes' positives (the regression as first measured), exact. */
  codedNdcg6: number | null;
}

export interface RegressionBundleCase {
  ntsbNo: string;
  caseRank: number;
  label: Label;
  coded: boolean;
  mapped: boolean;
  channels: PoolRun['bundle'][number]['channels'];
}

export interface RegressionDiagnosticReport {
  family: string;
  question: string;
  origin: string;
  /** The comparison rules frozen with the question. */
  comparison: NonNullable<NarrativeItem['diagnostic']>['comparison'];
  scope: string | null;
  coverage: ReturnType<typeof judgedCoverage>;
  /** Each retrieval version's means over the scope samples. */
  methods: Record<string, RegressionMethodValue>;
  reproduction: { metric: 'coded-ndcg6'; expected: Record<string, number>; observed: Record<string, number | null>; tolerance: number; reproduced: boolean; source: string };
  /** Each variant against the base: the difference bounds per reported metric and the conclusion on the primary. */
  comparisons: Record<string, { conclusion: RegressionConclusion; metrics: Record<string, { lower: number; upper: number; method: DifferenceBounds['method'] } | null> }>;
  perSample: {
    sample: number;
    methods: Record<string, RegressionMethodValue & { bundle: RegressionBundleCase[] }>;
    differences: Record<string, Record<string, { lower: number; upper: number; method: DifferenceBounds['method'] } | null>>;
    /** In the base's bundle, not in the variant's. */
    displaced: Record<string, RegressionBundleCase[]>;
    /** In the variant's bundle, not in the base's. */
    admitted: Record<string, RegressionBundleCase[]>;
  }[];
}

const metricOf = (v: QuestionValue, m: string): Bounds | null => (m === 'ndcg6' ? v.ndcg6 : m === 'p6' ? v.p6 : m === 'supported' ? v.supported : null);

/** One regression diagnostic under its frozen comparison rules (module section comment; `NarrativeDiagnosticSchema`). */
export function regressionDiagnostic(pool: FamilyPool, family: NarrativeItem, labels: ReadonlyMap<string, Label>, answerability: ReadonlyMap<string, Label>): RegressionDiagnosticReport {
  const def = family.diagnostic;
  if (!def) throw new Error(`${family.id} is not a diagnostic`);
  const c = def.comparison;
  const ref = familyReference({ type: pool.type, cases: pool.cases, cohort: family.cohort.cases }, labels);
  const label = (n: string): Label => ref.labels.get(n) ?? ref.unlisted;
  const coded = codedReference(family.relatedPositives);
  const codedSet = new Set(family.relatedPositives);
  const methods = [c.base, ...c.variants];
  const codedOf = (run: PoolRun): number | null => scoreQuestion(run.ranking, run.bundle.map((b) => b.ntsbNo), coded).ndcg.bounds?.lower ?? null;
  const valuesOf = (p: FamilyPool) => questionValues(p, scoreRuns(p, ref, answerability));
  const valueOf = (p: FamilyPool, values: readonly QuestionValue[], m: string): RegressionMethodValue | null => {
    const v = values.find((x) => x.member === family.id && x.method === m);
    if (!v) return null;
    const codes = p.runs.filter((r) => r.member === family.id && r.method === m).map(codedOf);
    return { ndcg6: v.ndcg6, p6: v.p6, supported: v.supported, codedNdcg6: codes.every((x): x is number => x !== null) && codes.length > 0 ? meanOf(codes) : null };
  };
  const differencesOf = (p: FamilyPool, values: readonly QuestionValue[]) =>
    Object.fromEntries(
      c.variants.map((variant) => [
        variant,
        Object.fromEntries(
          c.reported.map((metric) => {
            const d = methodDifferences(p, ref, answerability, values, c.base, variant, metric).find((x) => x.member === family.id);
            return [metric, d ? { lower: d.lower, upper: d.upper, method: d.method } : null];
          }),
        ),
      ]),
    ) as Record<string, Record<string, { lower: number; upper: number; method: DifferenceBounds['method'] } | null>>;
  const values = valuesOf(pool);
  const means = Object.fromEntries(methods.flatMap((m) => {
    const v = valueOf(pool, values, m);
    return v ? [[m, v]] : [];
  })) as Record<string, RegressionMethodValue>;
  const differences = differencesOf(pool, values);
  const observed = Object.fromEntries(Object.keys(c.reproduction.expected).map((m) => [m, means[m]?.codedNdcg6 ?? null]));
  const bundleOf = (run: PoolRun | undefined): RegressionBundleCase[] =>
    (run?.bundle ?? []).map((b) => ({ ntsbNo: b.ntsbNo, caseRank: b.caseRank, label: label(b.ntsbNo), coded: codedSet.has(b.ntsbNo), mapped: b.mapped, channels: b.channels }));
  const samples = [...new Set(pool.runs.filter((r) => r.member === family.id).map((r) => r.sample))].sort((a, b) => a - b);
  return {
    family: family.id,
    question: family.question,
    origin: def.origin,
    comparison: c,
    scope: def.scope?.source ?? null,
    coverage: judgedCoverage(pool, labels, family.cohort.cases),
    methods: means,
    reproduction: {
      metric: c.reproduction.metric,
      expected: c.reproduction.expected,
      observed,
      tolerance: c.reproduction.tolerance,
      reproduced: Object.entries(c.reproduction.expected).every(([m, want]) => {
        const got = observed[m];
        return got !== null && got !== undefined && Math.abs(got - want) <= c.reproduction.tolerance;
      }),
      source: c.reproduction.source,
    },
    comparisons: Object.fromEntries(c.variants.map((v) => [v, { conclusion: regressionConclusion(differences[v]?.[c.primary] ?? null), metrics: differences[v] ?? {} }])),
    perSample: samples.map((sample) => {
      const sub: FamilyPool = { ...pool, runs: pool.runs.filter((r) => r.sample === sample) };
      const subValues = valuesOf(sub);
      const runOf = (m: string) => sub.runs.find((r) => r.member === family.id && r.method === m);
      const base = bundleOf(runOf(c.base));
      return {
        sample,
        methods: Object.fromEntries(methods.flatMap((m) => {
          const v = valueOf(sub, subValues, m);
          return v ? [[m, { ...v, bundle: bundleOf(runOf(m)) }]] : [];
        })),
        differences: differencesOf(sub, subValues),
        displaced: Object.fromEntries(c.variants.map((v) => {
          const mine = new Set(bundleOf(runOf(v)).map((b) => b.ntsbNo));
          return [v, base.filter((b) => !mine.has(b.ntsbNo))];
        })),
        admitted: Object.fromEntries(c.variants.map((v) => {
          const theirs = new Set(base.map((b) => b.ntsbNo));
          return [v, bundleOf(runOf(v)).filter((b) => !theirs.has(b.ntsbNo))];
        })),
      };
    }),
  };
}

/** The retrieval runs' own mapping, per version: how often a run needed it, and its outcomes (the pools as built, no labels). */
export function ordinaryMapping(pools: readonly Pick<FamilyPool, 'family' | 'runs'>[]): Record<string, { runs: number; runsWithMapping: number; mapped: number; unmapped: Record<string, number>; deliveredMapped: number; questions: string[] }> {
  const out: Record<string, { runs: number; runsWithMapping: number; mapped: number; unmapped: Record<string, number>; deliveredMapped: number; questions: string[] }> = {};
  for (const p of pools) {
    for (const r of p.runs) {
      const v = (out[r.method] ??= { runs: 0, runsWithMapping: 0, mapped: 0, unmapped: {}, deliveredMapped: 0, questions: [] });
      v.runs += 1;
      const entries = r.mapping ?? [];
      if (entries.length > 0) {
        v.runsWithMapping += 1;
        if (!v.questions.includes(r.member)) v.questions.push(r.member);
      }
      for (const e of entries) {
        if (e.status === 'mapped') v.mapped += 1;
        else v.unmapped[e.reason ?? 'unknown'] = (v.unmapped[e.reason ?? 'unknown'] ?? 0) + 1;
      }
      v.deliveredMapped += r.bundle.filter((b) => b.mapped).length;
    }
  }
  for (const v of Object.values(out)) v.questions.sort();
  return out;
}

const tally = (labels: readonly Label[]): Record<string, number> => {
  const out: Record<string, number> = { '2': 0, '1': 0, '0': 0, unknown: 0 };
  for (const l of labels) out[String(l)] = (out[String(l)] ?? 0) + 1;
  return out;
};

export interface MappingDiagnosticReport {
  note: string;
  runs: number;
  /** Distinct (family, case) pairs forced through the mapping, and their outcomes. */
  forced: number;
  mapped: number;
  unmapped: Record<string, number>;
  /** Distinct delivered (family, case, passages) bundles: the answerability pairs. */
  delivered: number;
  /** Each delivered bundle's case relevance on its complete record, and the bundle's answerability. */
  relevance: Record<string, number>;
  answerability: Record<string, number>;
  /** Relevance (rows) by answerability (columns), unknown included. */
  crossTab: Record<string, Record<string, number>>;
  /** Of the fully relevant mapped cases, how many bundles establish it (answerability 2); unknowns left out and counted. */
  supportedAmongRelevant: Rate & { unknown: number };
  /** Of the bundles judged answerable (2), how many rest on a mapped passage rather than only on the attached probable cause. */
  restsOnMappedPassage: { answerable: number; mappedPassage: number; causeOnly: number; unread: number };
  perFamily: { family: string; forced: number; mapped: number; delivered: number; relevant: number; supported: number }[];
}

/** The labelled mapping diagnostic (pool.ts module comment): what the production mapping delivered for real questions, judged. */
export function mappingDiagnosticReport(
  pools: readonly Pick<FamilyPool, 'family' | 'mappingDiagnostic'>[],
  labels: ReadonlyMap<string, ReadonlyMap<string, Label>>,
  answerability: ReadonlyMap<string, ReadonlyMap<string, Label>>,
  records: readonly PairRecord[],
): MappingDiagnosticReport {
  const byPair = new Map(records.filter((r) => r.kind === 'answerability').map((r) => [`${r.family}|${r.ntsbNo}|${r.bundleKey ?? ''}`, r]));
  const rel: Label[] = [];
  const ans: Label[] = [];
  const crossTab: Record<string, Record<string, number>> = {};
  const unmapped: Record<string, number> = {};
  const rests = { answerable: 0, mappedPassage: 0, causeOnly: 0, unread: 0 };
  let relevant = 0;
  let supported = 0;
  let unknownRelevant = 0;
  let runs = 0;
  let forced = 0;
  let mapped = 0;
  let delivered = 0;
  const perFamily: MappingDiagnosticReport['perFamily'] = [];
  for (const p of pools) {
    runs += p.mappingDiagnostic.length;
    const outcome = new Map<string, { status: string; reason: string | null }>();
    for (const r of p.mappingDiagnostic) for (const e of r.mapping) outcome.set(e.ntsbNo, { status: e.status, reason: e.reason });
    const famMapped = [...outcome.values()].filter((o) => o.status === 'mapped').length;
    forced += outcome.size;
    mapped += famMapped;
    for (const o of outcome.values()) if (o.status !== 'mapped') unmapped[o.reason ?? 'unknown'] = (unmapped[o.reason ?? 'unknown'] ?? 0) + 1;
    const pairs = bundlePairsOf(p.mappingDiagnostic);
    delivered += pairs.length;
    let famRelevant = 0;
    let famSupported = 0;
    for (const x of pairs) {
      const r = labels.get(p.family)?.get(x.ntsbNo) ?? 'unknown';
      const a = answerability.get(p.family)?.get(`${x.ntsbNo}|${x.key}`) ?? 'unknown';
      rel.push(r);
      ans.push(a);
      const row = (crossTab[String(r)] ??= {});
      row[String(a)] = (row[String(a)] ?? 0) + 1;
      if (r === 2) {
        if (a === 'unknown') unknownRelevant += 1;
        else {
          relevant += 1;
          famRelevant += 1;
          if (a === 2) {
            supported += 1;
            famSupported += 1;
          }
        }
      }
      if (a === 2) {
        rests.answerable += 1;
        const rec = byPair.get(`${p.family}|${x.ntsbNo}|${x.key}`);
        const mappedIds = new Set(x.passages.filter((q) => q.role !== 'probable_cause').map((q) => q.passageId));
        const deciding = rec ? (rec.adjudication?.final !== null && rec.adjudication !== null ? rec.verdicts.filter((v) => v.role === 'adjudicator-final') : rec.verdicts.filter((v) => v.role === 'judge-a' || v.role === 'judge-b')) : [];
        if (deciding.length === 0) rests.unread += 1;
        else if (deciding.some((v) => v.verdict.evidence.some((e) => e.passageId !== undefined && mappedIds.has(e.passageId)))) rests.mappedPassage += 1;
        else rests.causeOnly += 1;
      }
    }
    perFamily.push({ family: p.family, forced: outcome.size, mapped: famMapped, delivered: pairs.length, relevant: famRelevant, supported: famSupported });
  }
  return {
    note: 'Labelled diagnostic, forced: each case-level run\'s first cases that only the cases channel returned were mapped (`mapCasesToPassages`) and packed (`fetchAndPack`) by the production code as leading candidates. It measures what the mapping delivers for real questions, not how often production maps. Model-judged; reported apart from the benchmark.',
    runs,
    forced,
    mapped,
    unmapped,
    delivered,
    relevance: tally(rel),
    answerability: tally(ans),
    crossTab,
    supportedAmongRelevant: { ...wilson(supported, relevant), unknown: unknownRelevant },
    restsOnMappedPassage: rests,
    perFamily,
  };
}

/** The distinct delivered (case, passages) bundles of mapping diagnostic runs. */
function bundlePairsOf(runs: FamilyPool['mappingDiagnostic']): { ntsbNo: string; key: string; passages: PoolRun['bundle'][number]['passages'] }[] {
  const out = new Map<string, { ntsbNo: string; key: string; passages: PoolRun['bundle'][number]['passages'] }>();
  for (const r of runs) {
    for (const b of r.bundle) {
      const key = bundleKeyOf(b.passages);
      out.set(`${b.ntsbNo}|${key}`, { ntsbNo: b.ntsbNo, key, passages: b.passages });
    }
  }
  return [...out.values()].sort((a, b) => (a.ntsbNo < b.ntsbNo ? -1 : a.ntsbNo > b.ntsbNo ? 1 : a.key < b.key ? -1 : 1));
}
