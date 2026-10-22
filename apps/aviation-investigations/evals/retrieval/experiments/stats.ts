/**
 * Uncertainty and the selection rule of the retrieval experiments (task 10d, phase A;
 * `PREREG.md`). Pure and deterministic.
 *
 * **Group bootstrap.** Paraphrases and questions sharing coded cases are not
 * independent, so resampling is by connected case group (the dataset's `group`): each
 * resample draws as many groups as there are, with replacement, keeps every question of
 * each drawn group (a group drawn twice counts twice), and takes the mean of the
 * per-question paired differences (variant minus baseline). The PRNG is mulberry32 with
 * the registered seed. Intervals are percentile intervals (linear interpolation between
 * order statistics); the rule uses the one-sided 95% lower bound (5th percentile).
 *
 * **Latency.** Per question, the median of the repetitions; the added latency is the
 * variant's median minus the baseline's; the p95 over questions is the nearest-rank
 * 95th percentile.
 *
 * **Rule** (`applyRule`): a variant qualifies when its paired improvement on its
 * declared target metric is at least `improvementPp` (point estimate) and the group
 * bootstrap's one-sided 95% lower bound of that improvement is above zero; no other gate
 * metric falls by more than `regressionTolerancePp` (point estimates); its p95 added and
 * total latency are within the limits; it adds no paid call per request; and none of its
 * runs failed. Among qualifying variants the largest narrow Recall@20 improvement wins;
 * variants within `tieWindowPp` of it are ordered by broad nDCG@6 improvement, then
 * lower p95 added latency, then fewer changed knobs, then id.
 */

/** mulberry32: a small deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile `p` in [0, 1] of ascending `sorted` values, linear interpolation between order statistics. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of no values');
  if (!(p >= 0 && p <= 1)) throw new Error(`invalid percentile ${p}`);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return (sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}

/** Nearest-rank percentile (latency): the ceil(p·n)-th smallest value. */
export function nearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of no values');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of no values');
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

export interface PairedValue {
  id: string;
  group: string;
  base: number;
  variant: number;
}

export interface BootstrapResult {
  questions: number;
  groups: number;
  base: number;
  variant: number;
  /** Mean paired difference (variant minus base). */
  delta: number;
  ci95: [number, number];
  /** One-sided 95% lower bound: the 5th percentile of the resampled differences. */
  lower95: number;
  resamples: number;
  seed: number;
}

/** Paired group bootstrap of the mean difference (module comment). */
export function pairedGroupBootstrap(values: readonly PairedValue[], resamples: number, seed: number): BootstrapResult {
  if (values.length === 0) throw new Error('no values to bootstrap');
  if (!Number.isSafeInteger(resamples) || resamples < 1) throw new Error('invalid resample count');
  const byGroup = new Map<string, number[]>();
  for (const v of values) {
    if (!Number.isFinite(v.base) || !Number.isFinite(v.variant)) throw new Error(`${v.id}: non-finite value`);
    byGroup.set(v.group, [...(byGroup.get(v.group) ?? []), v.variant - v.base]);
  }
  const groups = [...byGroup.keys()].sort().map((g) => byGroup.get(g) as number[]);
  const rand = mulberry32(seed);
  const stats: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[Math.floor(rand() * groups.length)] as number[];
      for (const d of g) sum += d;
      n += g.length;
    }
    stats.push(sum / n);
  }
  stats.sort((a, b) => a - b);
  return {
    questions: values.length,
    groups: groups.length,
    base: mean(values.map((v) => v.base)),
    variant: mean(values.map((v) => v.variant)),
    delta: mean(values.map((v) => v.variant - v.base)),
    ci95: [percentile(stats, 0.025), percentile(stats, 0.975)],
    lower95: percentile(stats, 0.05),
    resamples,
    seed,
  };
}

export const GATE_METRICS = ['narrowRecall20', 'broadStrictP6', 'broadNdcg6'] as const;
export type GateMetric = (typeof GATE_METRICS)[number];

export interface RuleThresholds {
  /** Minimum improvement on the target metric, in percentage points. */
  improvementPp: number;
  /** Largest allowed fall of any other gate metric, in percentage points. */
  regressionTolerancePp: number;
  p95AddedLatencyMs: number;
  p95TotalLatencyMs: number;
  maxAddedPaidCallsPerRequest: number;
  /** Variants this close (pp) to the best narrow Recall@20 improvement are tie-broken. */
  tieWindowPp: number;
}

export interface VariantEvaluation {
  id: string;
  target: GateMetric;
  /** Paired bootstrap per gate metric (fractions). */
  metrics: Record<GateMetric, BootstrapResult>;
  latency: { p95AddedMs: number; p95TotalMs: number };
  addedPaidCallsPerRequest: number;
  changedKnobs: number;
  failures: number;
}

export interface RuleVerdict {
  id: string;
  qualifies: boolean;
  /** Why it does not qualify (empty when it does). */
  reasons: string[];
}

export interface RuleOutcome {
  verdicts: RuleVerdict[];
  /** Qualifying variants in selection order. */
  order: string[];
  /** The selected variant, or null: the baseline stays. */
  selected: string | null;
}

const pp = (x: number) => (x * 100).toFixed(1);

/** The registered selection rule (module comment). */
export function applyRule(evals: readonly VariantEvaluation[], t: RuleThresholds): RuleOutcome {
  const verdicts: RuleVerdict[] = evals.map((e) => {
    const reasons: string[] = [];
    const target = e.metrics[e.target];
    if (target.delta * 100 < t.improvementPp) reasons.push(`target ${e.target} improves ${pp(target.delta)} pp (< ${t.improvementPp})`);
    if (!(target.lower95 > 0)) reasons.push(`target ${e.target} one-sided 95% group-bootstrap lower bound ${pp(target.lower95)} pp is not above 0`);
    for (const m of GATE_METRICS) {
      if (m === e.target) continue;
      if (e.metrics[m].delta * 100 < -t.regressionTolerancePp) reasons.push(`${m} falls ${pp(-e.metrics[m].delta)} pp (> ${t.regressionTolerancePp})`);
    }
    if (e.latency.p95AddedMs > t.p95AddedLatencyMs) reasons.push(`p95 added latency ${e.latency.p95AddedMs} ms (> ${t.p95AddedLatencyMs})`);
    if (e.latency.p95TotalMs > t.p95TotalLatencyMs) reasons.push(`p95 total latency ${e.latency.p95TotalMs} ms (> ${t.p95TotalLatencyMs})`);
    if (e.addedPaidCallsPerRequest > t.maxAddedPaidCallsPerRequest) reasons.push(`adds ${e.addedPaidCallsPerRequest} paid call(s) per request`);
    if (e.failures > 0) reasons.push(`${e.failures} failed run(s)`);
    return { id: e.id, qualifies: reasons.length === 0, reasons };
  });
  const qualifying = evals.filter((e) => verdicts.find((v) => v.id === e.id)?.qualifies);
  if (qualifying.length === 0) return { verdicts, order: [], selected: null };
  const best = Math.max(...qualifying.map((e) => e.metrics.narrowRecall20.delta));
  const inWindow = (e: VariantEvaluation) => (best - e.metrics.narrowRecall20.delta) * 100 <= t.tieWindowPp + 1e-9;
  const order = [...qualifying]
    .sort(
      (a, b) =>
        Number(inWindow(b)) - Number(inWindow(a)) ||
        (inWindow(a) && inWindow(b) ? 0 : b.metrics.narrowRecall20.delta - a.metrics.narrowRecall20.delta) ||
        b.metrics.broadNdcg6.delta - a.metrics.broadNdcg6.delta ||
        a.latency.p95AddedMs - b.latency.p95AddedMs ||
        a.changedKnobs - b.changedKnobs ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((e) => e.id);
  return { verdicts, order, selected: order[0] ?? null };
}
