/**
 * Running and scoring the retrieval experiments (task 10d, phase A).
 *
 * `runConfigs` runs every configuration for every question `repetitions` times,
 * interleaved (each repetition and question rotates the configuration order), so
 * latency is compared under the same conditions. Scores come from the first
 * repetition; later repetitions must return the same ranking and bundle (`stable`).
 * A configuration with `keywordText: scope` runs once per scope sample.
 *
 * `summarize` scores each run against the coded reference (`metrics.ts`): narrow
 * Recall@20 on the case ranking, broad strict P@6 and nDCG@6 on the packed bundle; a
 * question's value under a scope configuration is its mean over the samples. Each
 * variant is compared with the baseline by paired group bootstrap (`stats.ts`), its
 * latency is the per-question median of every repetition and sample, and the
 * registered rule is applied. Pools are scored by their oracle ceiling: the share of a
 * narrow question's coded positives the bounded pool holds (a reranker's best case).
 */
import type { Client } from '@elastic/elasticsearch';
import type { Embedder } from '../../../server/ai/embeddings.js';
import type { RetrievalFilters } from '../../../server/search/filters.js';
import type { RetrievalDataset } from '../../../server/search/hybrid.js';
import { codedReference, scoreQuestion, type ProtocolScore } from '../metrics.js';
import { BASELINE_CONFIG, canonicalConfig, changedKnobs, experimentConfig, type ExperimentConfig } from './config.js';
import { roundRobinCases } from './fusion.js';
import type { Grid, PoolSpec } from './grid.js';
import { GATE_METRICS, applyRule, clearsZero, median, nearestRank, pairedGroupBootstrap, type BootstrapResult, type GateMetric, type RuleOutcome, type VariantEvaluation } from './stats.js';
import { runVariant, type VariantRun } from './variant.js';

export interface ExperimentItem {
  id: string;
  split: 'dev' | 'holdout';
  group: string;
  class: 'narrow' | 'broad';
  area: string;
  paraphraseOf: string | null;
  question: string;
  filters: RetrievalFilters;
  relevant: readonly string[];
}

export interface ConfigEntry {
  key: string;
  config: ExperimentConfig;
}

/** A configuration's run for one question and scope sample: the first repetition's results and every repetition's timings. */
export interface StoredRun {
  config: string;
  question: string;
  /** Scope sample (1-based) for `keywordText: scope`; null otherwise. */
  sample: number | null;
  ranking: string[];
  channels: VariantRun['channels'];
  bundle: { ntsbNo: string; caseRank: number; coded: boolean; passages: { id: string; sectionKind: string; role: string; reserved: boolean; fusedRank: number | null; tokens: number }[] }[];
  skipped: VariantRun['packed']['skipped'];
  trimmed: number;
  passages: number;
  tokens: number;
  mappedCases: string[];
  requests: VariantRun['requests'];
  score: ProtocolScore;
  /** Total retrieval milliseconds (query embedding excluded), one per repetition. */
  totalMs: number[];
  stagesMs: VariantRun['timingsMs'][];
  /** Every repetition returned the same ranking and bundle. */
  stable: boolean;
  error: string | null;
}

export const runKey = (config: string, question: string, sample: number | null): string => `${config}|${question}|${sample ?? '-'}`;

const signature = (r: VariantRun) => JSON.stringify([r.ranking, r.packed.cases.map((c) => [c.ntsbNo, c.passages.map((p) => p.id)])]);

/** Every configuration the grid needs (baseline, variants, pools, single channels), deduplicated by canonical form. */
export function gridConfigs(grid: Grid): { entries: ConfigEntry[]; variantKeys: Map<string, string>; poolKeys: Map<string, string>; aloneKeys: Map<string, string> } {
  const entries = new Map<string, ExperimentConfig>();
  const add = (c: ExperimentConfig) => {
    const key = canonicalConfig(c);
    if (!entries.has(key)) entries.set(key, c);
    return key;
  };
  add(experimentConfig({}));
  const variantKeys = new Map(grid.variants.map((v) => [v.id, add(experimentConfig(v.config))]));
  const poolKeys = new Map(grid.pools.map((p) => [p.id, add(experimentConfig(p.config))]));
  const aloneKeys = new Map(
    grid.channelsAlone.map((a) => [
      a.id,
      add(
        a.channel === 'cases'
          ? experimentConfig({ fusion: 'case', perChannel: a.depth, caseChannel: a.caseChannel ?? null })
          : experimentConfig({ perChannel: a.depth }),
      ),
    ]),
  );
  return { entries: [...entries.entries()].map(([key, config]) => ({ key, config })), variantKeys, poolKeys, aloneKeys };
}

export interface RunOptions {
  repetitions: number;
  /** Effective scope keyword texts per question, one per sample. */
  scopeTexts?: ReadonlyMap<string, readonly string[]>;
  log?: (message: string) => void;
}

/** Run every configuration for every question (module comment). Failures are recorded, never retried. */
export async function runConfigs(
  es: Client,
  embedder: Embedder,
  target: { dataset: RetrievalDataset; casesIndex: string },
  items: readonly ExperimentItem[],
  configs: readonly ConfigEntry[],
  opts: RunOptions,
): Promise<Map<string, StoredRun>> {
  const log = opts.log ?? (() => undefined);
  const out = new Map<string, StoredRun>();
  const firstSignature = new Map<string, string>();
  for (let rep = 0; rep < opts.repetitions; rep += 1) {
    for (const [qi, item] of items.entries()) {
      const shift = (rep * 7 + qi) % configs.length;
      const order = [...configs.slice(shift), ...configs.slice(0, shift)];
      for (const entry of order) {
        const texts = entry.config.keywordText === 'scope' ? opts.scopeTexts?.get(item.id) : undefined;
        if (entry.config.keywordText === 'scope' && (!texts || texts.length === 0)) throw new Error(`no scope keyword text for ${item.id}`);
        const samples: (number | null)[] = texts ? texts.map((_, i) => i + 1) : [null];
        for (const sample of samples) {
          const key = runKey(entry.key, item.id, sample);
          let run: VariantRun | null = null;
          let error: string | null = null;
          try {
            run = await runVariant(es, embedder, {
              dataset: target.dataset,
              casesIndex: target.casesIndex,
              question: item.question,
              ...(sample !== null ? { scopeKeywordText: (texts as readonly string[])[sample - 1] as string } : {}),
              filters: item.filters,
            }, entry.config);
          } catch (err) {
            error = err instanceof Error ? `${err.name}: ${err.message.slice(0, 300)}` : String(err);
          }
          const stored = out.get(key);
          if (!stored) {
            const coded = new Set(item.relevant);
            out.set(key, {
              config: entry.key,
              question: item.id,
              sample,
              ranking: run?.ranking ?? [],
              channels: run?.channels ?? { keyword: [], vector: [], cases: null },
              bundle: (run?.packed.cases ?? []).map((c) => ({
                ntsbNo: c.ntsbNo,
                caseRank: c.caseRank,
                coded: coded.has(c.ntsbNo),
                passages: c.passages.map((p) => ({ id: p.id, sectionKind: p.sectionKind, role: p.role, reserved: p.reserved, fusedRank: p.fusedRank, tokens: p.tokens })),
              })),
              skipped: run?.packed.skipped ?? [],
              trimmed: run?.packed.trimmed.length ?? 0,
              passages: run?.packed.passages ?? 0,
              tokens: run?.packed.tokens ?? 0,
              mappedCases: run?.mappedCases ?? [],
              requests: run?.requests ?? { keyword: {}, vector: {}, cases: null, mapping: null, fetch: null },
              score: scoreQuestion(run?.ranking ?? [], (run?.packed.cases ?? []).map((c) => c.ntsbNo), codedReference(item.relevant)),
              totalMs: run ? [run.timingsMs.total] : [],
              stagesMs: run ? [run.timingsMs] : [],
              stable: run !== null,
              error,
            });
            if (run) firstSignature.set(key, signature(run));
          } else {
            if (run) {
              stored.totalMs.push(run.timingsMs.total);
              stored.stagesMs.push(run.timingsMs);
              if (firstSignature.get(key) !== signature(run)) stored.stable = false;
            } else {
              stored.stable = false;
              stored.error ??= error;
            }
          }
        }
      }
      log(`repetition ${rep + 1}/${opts.repetitions}: ${qi + 1}/${items.length} ${item.id}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring

export const CLASS_OF: Readonly<Record<GateMetric, 'narrow' | 'broad'>> = { narrowRecall20: 'narrow', broadStrictP6: 'broad', broadNdcg6: 'broad' };

/** A gate metric's value for one scored run. Track C has no unknowns, so lower bounds are the values. */
export function metricValue(metric: GateMetric, s: ProtocolScore): number {
  switch (metric) {
    case 'narrowRecall20':
      return s.recall.value ?? 0;
    case 'broadStrictP6':
      return s.precision.strict.lower;
    case 'broadNdcg6':
      return s.ndcg.bounds?.lower ?? 0;
  }
}

/** The runs of one configuration and question: every sample's. */
function runsOf(runs: ReadonlyMap<string, StoredRun>, config: string, question: string): StoredRun[] {
  const one = runs.get(runKey(config, question, null));
  if (one) return [one];
  const out: StoredRun[] = [];
  for (let s = 1; ; s += 1) {
    const r = runs.get(runKey(config, question, s));
    if (!r) break;
    out.push(r);
  }
  if (out.length === 0) throw new Error(`no run of ${question} under ${config}`);
  return out;
}

/** A question's value under a configuration: the mean over its samples. */
export function questionValue(runs: ReadonlyMap<string, StoredRun>, config: string, item: ExperimentItem, metric: GateMetric): number {
  const rs = runsOf(runs, config, item.id);
  return rs.reduce((n, r) => n + metricValue(metric, r.score), 0) / rs.length;
}

export interface LatencySummary {
  /** Per question: median total milliseconds over every repetition and sample. */
  perQuestion: Record<string, number>;
  p95TotalMs: number;
  /** Variant minus baseline, per question medians. */
  p95AddedMs: number;
  medianAddedMs: number;
}

export function latencyOf(runs: ReadonlyMap<string, StoredRun>, config: string, baseline: string, items: readonly ExperimentItem[]): LatencySummary {
  const med = (key: string, item: ExperimentItem) => median(runsOf(runs, key, item.id).flatMap((r) => r.totalMs));
  const perQuestion: Record<string, number> = {};
  const added: number[] = [];
  for (const item of items) {
    const v = med(config, item);
    perQuestion[item.id] = v;
    added.push(v - med(baseline, item));
  }
  return {
    perQuestion,
    p95TotalMs: nearestRank(Object.values(perQuestion), 0.95),
    p95AddedMs: nearestRank(added, 0.95),
    medianAddedMs: median(added),
  };
}

export interface ArmSummary {
  narrowRecall20: number;
  narrowAtTarget: number;
  broadStrictP6: number;
  broadNdcg6: number;
  narrowQuestions: number;
  broadQuestions: number;
}

export function armSummary(runs: ReadonlyMap<string, StoredRun>, config: string, items: readonly ExperimentItem[]): ArmSummary {
  const narrow = items.filter((q) => q.class === 'narrow');
  const broad = items.filter((q) => q.class === 'broad');
  const avg = (qs: readonly ExperimentItem[], m: GateMetric) => (qs.length === 0 ? Number.NaN : qs.reduce((n, q) => n + questionValue(runs, config, q, m), 0) / qs.length);
  return {
    narrowRecall20: avg(narrow, 'narrowRecall20'),
    narrowAtTarget: narrow.length === 0 ? Number.NaN : narrow.filter((q) => questionValue(runs, config, q, 'narrowRecall20') >= 0.9).length / narrow.length,
    broadStrictP6: avg(broad, 'broadStrictP6'),
    broadNdcg6: avg(broad, 'broadNdcg6'),
    narrowQuestions: narrow.length,
    broadQuestions: broad.length,
  };
}

/** Paired group bootstrap of each gate metric, variant against baseline, over the metric's questions. */
export function pairedMetrics(
  runs: ReadonlyMap<string, StoredRun>,
  config: string,
  baseline: string,
  items: readonly ExperimentItem[],
  boot: { resamples: number; seed: number },
): Record<GateMetric, BootstrapResult> {
  const out = {} as Record<GateMetric, BootstrapResult>;
  for (const metric of GATE_METRICS) {
    const qs = items.filter((q) => q.class === CLASS_OF[metric]);
    out[metric] = pairedGroupBootstrap(
      qs.map((q) => ({ id: q.id, group: q.group, base: questionValue(runs, baseline, q, metric), variant: questionValue(runs, config, q, metric) })),
      boot.resamples,
      boot.seed,
    );
  }
  return out;
}

/** The cases of a pool spec for one question, from its configuration's (first sample's) run. */
export function poolCases(spec: PoolSpec, run: StoredRun): string[] {
  if (spec.method === 'ranking') return run.ranking.slice(0, spec.size);
  const lists = (spec.channels ?? []).map((ch) => (ch === 'cases' ? (run.channels.cases ?? []) : run.channels[ch]));
  return roundRobinCases(lists, spec.size);
}

/** Share of the question's coded positives inside `pool` (the oracle ceiling a reranker of the pool could reach, for 1 to 20 positives). */
export function poolCeiling(pool: readonly string[], relevant: readonly string[]): number {
  const p = new Set(pool);
  return relevant.filter((n) => p.has(n)).length / relevant.length;
}

export interface VariantSummary {
  id: string;
  family: string;
  target: GateMetric;
  description: string;
  config: ExperimentConfig;
  changedKnobs: string[];
  arm: ArmSummary;
  metrics: Record<GateMetric, BootstrapResult>;
  latency: LatencySummary;
  failures: number;
  unstable: number;
  mappedCases: number;
  perQuestion: Record<string, { base: number; variant: number; metric: GateMetric }>;
}

export interface PoolSummary {
  id: string;
  description: string;
  size: number;
  method: PoolSpec['method'];
  /** Mean oracle ceiling over the narrow questions. */
  ceiling: number;
  perQuestion: Record<string, number>;
  /** Paired against the registered baseline pool. */
  versusBaselinePool: BootstrapResult | null;
  recommended: boolean;
}

export interface ExperimentSummary {
  baseline: { key: string; arm: ArmSummary; latency: LatencySummary };
  variants: VariantSummary[];
  pools: PoolSummary[];
  /** Each single channel: its own Recall@20, and the share of positives anywhere in what it returns. */
  channelsAlone: { id: string; channel: string; depth: number; narrowRecall20: number; ceiling: number }[];
  /** Per depth: the share of positives anywhere in the union of the passage channels, and with each case channel. */
  unions: { depth: number; channels: string[]; ceiling: number; perQuestion: Record<string, number> }[];
  rule: RuleOutcome;
}

/** A pool is recommended when its oracle-ceiling gain over the baseline pool reaches the registered size and its one-sided lower bound clears zero (`clearsZero`). */
export const poolRecommended = (versus: BootstrapResult | null, poolImprovementPp: number): boolean =>
  versus !== null && versus.delta * 100 >= poolImprovementPp && clearsZero(versus.lower95);

/** Everything the report needs from the runs (module comment). */
export function summarize(
  grid: Grid,
  runs: ReadonlyMap<string, StoredRun>,
  items: readonly ExperimentItem[],
  keys: ReturnType<typeof gridConfigs>,
  opts: {
    baselinePool: string | null;
    /** Paid calls a configuration adds per production request (phase A: none). */
    addedPaidCalls?: (c: ExperimentConfig) => number;
    /** Failures outside the runs, e.g. scope samples that failed for a scope configuration. */
    extraFailures?: (c: ExperimentConfig) => number;
  },
): ExperimentSummary {
  const baselineKey = canonicalConfig(BASELINE_CONFIG);
  const boot = { resamples: grid.bootstrap.resamples, seed: grid.bootstrap.seed };
  const variants: VariantSummary[] = grid.variants.map((v) => {
    const key = keys.variantKeys.get(v.id) as string;
    const config = experimentConfig(v.config);
    const metrics = pairedMetrics(runs, key, baselineKey, items, boot);
    const all = items.flatMap((q) => runsOf(runs, key, q.id));
    const perQuestion: VariantSummary['perQuestion'] = {};
    for (const q of items) {
      const metric: GateMetric = q.class === 'narrow' ? 'narrowRecall20' : 'broadNdcg6';
      perQuestion[q.id] = { metric, base: questionValue(runs, baselineKey, q, metric), variant: questionValue(runs, key, q, metric) };
    }
    return {
      id: v.id,
      family: v.family,
      target: v.target,
      description: v.description,
      config,
      changedKnobs: changedKnobs(config),
      arm: armSummary(runs, key, items),
      metrics,
      latency: latencyOf(runs, key, baselineKey, items),
      failures: all.filter((r) => r.error !== null).length + (opts.extraFailures?.(config) ?? 0),
      unstable: all.filter((r) => !r.stable).length,
      mappedCases: all.reduce((n, r) => n + r.mappedCases.length, 0),
      perQuestion,
    };
  });
  const evaluations: VariantEvaluation[] = variants.map((v) => ({
    id: v.id,
    target: v.target,
    metrics: v.metrics,
    latency: { p95AddedMs: v.latency.p95AddedMs, p95TotalMs: v.latency.p95TotalMs },
    addedPaidCallsPerRequest: opts.addedPaidCalls?.(v.config) ?? 0,
    changedKnobs: v.changedKnobs.length,
    failures: v.failures,
  }));
  const rule = applyRule(evaluations, {
    improvementPp: grid.rule.improvementPp,
    regressionTolerancePp: grid.rule.regressionTolerancePp,
    p95AddedLatencyMs: grid.latency.p95AddedMs,
    p95TotalLatencyMs: grid.latency.p95TotalMs,
    maxAddedPaidCallsPerRequest: grid.cost.maxAddedPaidCallsPerRequest,
    tieWindowPp: grid.rule.tieWindowPp,
  });

  const narrow = items.filter((q) => q.class === 'narrow');
  const ceilings = (spec: PoolSpec) =>
    Object.fromEntries(
      narrow.map((q) => {
        const run = runsOf(runs, keys.poolKeys.get(spec.id) as string, q.id)[0] as StoredRun;
        return [q.id, poolCeiling(poolCases(spec, run), q.relevant)];
      }),
    ) as Record<string, number>;
  const basePoolSpec = opts.baselinePool ? grid.pools.find((p) => p.id === opts.baselinePool) : undefined;
  const baseCeilings = basePoolSpec ? ceilings(basePoolSpec) : null;
  const pools: PoolSummary[] = grid.pools.map((spec) => {
    const perQuestion = ceilings(spec);
    const versus =
      baseCeilings && spec.id !== opts.baselinePool
        ? pairedGroupBootstrap(
            narrow.map((q) => ({ id: q.id, group: q.group, base: baseCeilings[q.id] as number, variant: perQuestion[q.id] as number })),
            boot.resamples,
            boot.seed,
          )
        : null;
    return {
      id: spec.id,
      description: spec.description,
      size: spec.size,
      method: spec.method,
      ceiling: narrow.length === 0 ? Number.NaN : Object.values(perQuestion).reduce((a, b) => a + b, 0) / narrow.length,
      perQuestion,
      versusBaselinePool: versus,
      recommended: poolRecommended(versus, grid.rule.poolImprovementPp),
    };
  });

  const aloneList = (id: string, q: ExperimentItem): string[] => {
    const a = grid.channelsAlone.find((x) => x.id === id) as Grid['channelsAlone'][number];
    const run = runsOf(runs, keys.aloneKeys.get(id) as string, q.id)[0] as StoredRun;
    return a.channel === 'cases' ? (run.channels.cases ?? []) : run.channels[a.channel];
  };
  const avg = (xs: number[]) => (xs.length === 0 ? Number.NaN : xs.reduce((x, y) => x + y, 0) / xs.length);
  const channelsAlone = grid.channelsAlone.map((a) => ({
    id: a.id,
    channel: a.caseChannel ? `cases:${a.caseChannel.fields}` : a.channel,
    depth: a.depth,
    narrowRecall20: avg(narrow.map((q) => scoreQuestion(aloneList(a.id, q), [], codedReference(q.relevant)).recall.value ?? 0)),
    ceiling: avg(narrow.map((q) => poolCeiling(aloneList(a.id, q), q.relevant))),
  }));
  const unions: ExperimentSummary['unions'] = [];
  for (const depth of [...new Set(grid.channelsAlone.map((a) => a.depth))].sort((x, y) => x - y)) {
    const atDepth = grid.channelsAlone.filter((a) => a.depth === depth);
    const passage = atDepth.filter((a) => a.channel !== 'cases');
    const sets = [passage, ...atDepth.filter((a) => a.channel === 'cases').map((c) => [...passage, c])];
    for (const set of sets) {
      if (set.length === 0) continue;
      const perQuestion = Object.fromEntries(narrow.map((q) => [q.id, poolCeiling(set.flatMap((a) => aloneList(a.id, q)), q.relevant)])) as Record<string, number>;
      unions.push({ depth, channels: set.map((a) => a.id), ceiling: avg(Object.values(perQuestion)), perQuestion });
    }
  }

  return {
    baseline: { key: baselineKey, arm: armSummary(runs, baselineKey, items), latency: latencyOf(runs, baselineKey, baselineKey, items) },
    variants,
    pools,
    channelsAlone,
    unions,
    rule,
  };
}
