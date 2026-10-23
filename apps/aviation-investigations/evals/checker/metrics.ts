/**
 * Checker calibration metrics (Task 16c; gate G6), computed offline from recorded check
 * outputs. Every output is judged by the production code (`judgeCheck`), so a claim
 * counts as passed only when the server would have shown it: one valid `supported`
 * verdict, no invalid evidence or quote. A call that failed (truncated, refused,
 * unparseable, timed out) withholds every claim of its input, as in production.
 *
 * - **Whole-brief false withholding**: the share of trials of wholly supported briefs
 *   that the server would have withheld (the primary target, ≤ 10%).
 * - **Detection** per family: the share of not-supported claims withheld, over every
 *   trial (claim batches and briefs with one known error; target ≥ 95% provisional).
 * - **Critical regressions**: each must be withheld in every trial.
 * - **False flags**: supported claims withheld (claim level), and per brief trial.
 * Labels `unknown` count nowhere. Intervals are Wilson 95% score intervals.
 */
import type { CheckOutput } from '../../server/ai/provider.js';
import { judgeCheck, type CheckCode } from '../../server/briefs/verdicts.js';
import type { CalibrationBatch, LabelledClaim } from './build.js';
import { FAMILIES, type Family } from './types.js';

/** One check call of the calibration: the batch, the sample, and what came back. */
export interface Trial {
  batch: string;
  sample: number;
  /** The parsed output, or null when the call failed. */
  output: CheckOutput | null;
  /** The failure category when the call failed (`truncated`, `refusal`, `timeout`, ...). */
  failure?: string;
  stopReason?: string | null;
  latencyMs: number;
  costUsd: number;
  usage?: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; thinkingTokens?: number };
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  /** Wilson 95% score interval. */
  low: number | null;
  high: number | null;
}

/** k of n with its Wilson 95% interval. */
export function rate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** The server's judgement of one trial, per claim: passed (shown) or withheld, with the codes. */
export interface JudgedTrial {
  trial: Trial;
  batch: CalibrationBatch;
  /** The server would show the brief (every claim passed). */
  ok: boolean;
  /** Claim id → the problem codes for it (empty: passed). */
  codes: Map<string, CheckCode[]>;
  verdicts: Map<string, string>;
  chronologyMissed: string[];
  /** The call failed: every claim is withheld. */
  structural: boolean;
}

export function judgeTrial(batch: CalibrationBatch, trial: Trial): JudgedTrial {
  const codes = new Map<string, CheckCode[]>(batch.input.claims.map((c) => [c.id, []]));
  const verdicts = new Map<string, string>();
  if (trial.output === null) {
    for (const c of batch.input.claims) codes.set(c.id, ['check_missing_verdict']);
    return { trial, batch, ok: false, codes, verdicts, chronologyMissed: [], structural: true };
  }
  const meta = batch.input.claims.map((c) => {
    const l = batch.labels.find((x) => x.claim === c.id);
    return { ...(l?.criterion ? { criterion: l.criterion } : {}), ...(l?.decision ? { decision: l.decision } : {}) };
  });
  const j = judgeCheck(batch.input, trial.output, meta);
  for (const p of j.problems) {
    if (p.index < 0) continue;
    const id = batch.input.claims[p.index]!.id;
    codes.get(id)!.push(p.code);
  }
  for (const v of trial.output.verdicts) if (!verdicts.has(v.claim)) verdicts.set(v.claim, v.verdict);
  // An unknown claim id withholds the brief (`ok`) without belonging to any claim.
  return { trial, batch, ok: j.ok, codes, verdicts, chronologyMissed: j.chronologyMissed.map((c) => c.claim), structural: false };
}

const withheld = (jt: JudgedTrial, claim: string) => (jt.codes.get(claim)?.length ?? 0) > 0 || jt.structural;

export interface ClaimOutcome {
  batch: string;
  sample: number;
  label: LabelledClaim;
  withheld: boolean;
  verdict: string | null;
  codes: CheckCode[];
}

export function claimOutcomes(judged: readonly JudgedTrial[]): ClaimOutcome[] {
  return judged.flatMap((jt) =>
    jt.batch.labels.map((l) => ({
      batch: jt.batch.id,
      sample: jt.trial.sample,
      label: l,
      withheld: withheld(jt, l.claim),
      verdict: jt.verdicts.get(l.claim) ?? null,
      codes: jt.codes.get(l.claim) ?? [],
    })),
  );
}

const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};

export interface CalibrationReport {
  calls: number;
  failedCalls: Record<string, number>;
  /** Primary: trials of wholly supported briefs the server would withhold. */
  wholeBriefFalseWithholding: Rate;
  supportedBriefs: { id: string; trials: number; withheld: number; codes: Record<string, number> }[];
  /** Briefs with one known error: trials withheld at all, and with the error claim itself withheld. */
  errorBriefs: { withheld: Rate; errorClaimWithheld: Rate };
  detection: Record<Exclude<Family, 'control'>, Rate> & { all: Rate };
  /** Detection by mutation (counts only). */
  mutations: Record<string, Rate>;
  critical: { items: number; passedEveryTrial: number; failures: { item: string; batch: string; sample: number; verdict: string | null }[] };
  /** Supported claims withheld (claim level), all trials. */
  falseFlags: Rate;
  falseFlagsByKind: Record<string, Rate>;
  chronologyMissed: { trials: number; claims: number };
  verdicts: Record<string, number>;
  cost: { totalUsd: number; perCallUsd: number | null; perBriefUsd: number | null };
  latencyMs: { p50: number | null; p95: number | null; max: number | null; overTimeout: number; timeoutMs: number };
  thinkingTokens: { total: number; max: number };
  outputTokens: { max: number };
}

/** The calibration figures of one configuration over a set of trials. */
export function report(batches: readonly CalibrationBatch[], trials: readonly Trial[], timeoutMs: number): CalibrationReport {
  const byId = new Map(batches.map((b) => [b.id, b]));
  const judged = trials.map((t) => {
    const b = byId.get(t.batch);
    if (!b) throw new Error(`trial of unknown batch ${t.batch}`);
    return judgeTrial(b, t);
  });
  const outcomes = claimOutcomes(judged);
  const failedCalls: Record<string, number> = {};
  for (const t of trials) if (t.output === null) failedCalls[t.failure ?? 'failed'] = (failedCalls[t.failure ?? 'failed'] ?? 0) + 1;

  const supportedTrials = judged.filter((j) => j.batch.kind === 'brief' && j.batch.brief === 'supported');
  const supportedBriefs = [...new Set(supportedTrials.map((j) => j.batch.id))].map((id) => {
    const ts = supportedTrials.filter((j) => j.batch.id === id);
    const codes: Record<string, number> = {};
    for (const j of ts) for (const cs of j.codes.values()) for (const c of cs) codes[c] = (codes[c] ?? 0) + 1;
    return { id, trials: ts.length, withheld: ts.filter((j) => !j.ok).length, codes };
  });
  const errorTrials = judged.filter((j) => j.batch.kind === 'brief' && j.batch.brief === 'one_error');
  const errorClaimWithheld = errorTrials.filter((j) => j.batch.labels.some((l) => l.label === 'not_supported' && withheld(j, l.claim))).length;

  const negatives = outcomes.filter((o) => o.label.label === 'not_supported');
  const fam = (f: Family) => negatives.filter((o) => o.label.family === f);
  const detection = Object.fromEntries(
    FAMILIES.filter((f) => f !== 'control').map((f) => [f, rate(fam(f).filter((o) => o.withheld).length, fam(f).length)]),
  ) as CalibrationReport['detection'];
  detection.all = rate(negatives.filter((o) => o.withheld).length, negatives.length);
  const mutations: Record<string, Rate> = {};
  for (const m of [...new Set(negatives.map((o) => `${o.label.family}/${o.label.mutation}`))].sort()) {
    const os = negatives.filter((o) => `${o.label.family}/${o.label.mutation}` === m);
    mutations[m] = rate(os.filter((o) => o.withheld).length, os.length);
  }

  const criticalOutcomes = negatives.filter((o) => o.label.critical);
  const criticalItems = [...new Set(criticalOutcomes.map((o) => `${o.batch}/${o.label.item}`))];
  const failures = criticalOutcomes
    .filter((o) => !o.withheld)
    .map((o) => ({ item: o.label.item, batch: o.batch, sample: o.sample, verdict: o.verdict }));
  const failedItems = new Set(failures.map((f) => `${f.batch}/${f.item}`));

  const positives = outcomes.filter((o) => o.label.label === 'supported');
  const falseFlagsByKind: Record<string, Rate> = {};
  for (const kind of [...new Set(positives.map((o) => o.label.kind))].sort()) {
    const os = positives.filter((o) => o.label.kind === kind);
    falseFlagsByKind[kind] = rate(os.filter((o) => o.withheld).length, os.length);
  }
  const verdicts: Record<string, number> = {};
  for (const o of outcomes) verdicts[o.verdict ?? 'none'] = (verdicts[o.verdict ?? 'none'] ?? 0) + 1;

  const briefCalls = trials.filter((t) => byId.get(t.batch)?.kind === 'brief');
  const latencies = trials.map((t) => t.latencyMs);
  const totalUsd = trials.reduce((s, t) => s + t.costUsd, 0);
  return {
    calls: trials.length,
    failedCalls,
    wholeBriefFalseWithholding: rate(supportedTrials.filter((j) => !j.ok).length, supportedTrials.length),
    supportedBriefs,
    errorBriefs: { withheld: rate(errorTrials.filter((j) => !j.ok).length, errorTrials.length), errorClaimWithheld: rate(errorClaimWithheld, errorTrials.length) },
    detection,
    mutations,
    critical: { items: criticalItems.length, passedEveryTrial: criticalItems.filter((i) => !failedItems.has(i)).length, failures },
    falseFlags: rate(positives.filter((o) => o.withheld).length, positives.length),
    falseFlagsByKind,
    chronologyMissed: { trials: judged.filter((j) => j.chronologyMissed.length > 0).length, claims: judged.reduce((s, j) => s + j.chronologyMissed.length, 0) },
    verdicts,
    cost: {
      totalUsd,
      perCallUsd: trials.length ? totalUsd / trials.length : null,
      perBriefUsd: briefCalls.length ? briefCalls.reduce((s, t) => s + t.costUsd, 0) / briefCalls.length : null,
    },
    latencyMs: {
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
      overTimeout: latencies.filter((l) => l > timeoutMs).length,
      timeoutMs,
    },
    thinkingTokens: {
      total: trials.reduce((s, t) => s + (t.usage?.thinkingTokens ?? 0), 0),
      max: Math.max(0, ...trials.map((t) => t.usage?.thinkingTokens ?? 0)),
    },
    outputTokens: { max: Math.max(0, ...trials.map((t) => t.usage?.outputTokens ?? 0)) },
  };
}

const pct = (r: Rate) => (r.rate === null ? 'n/a' : `${(100 * r.rate).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(100 * r.low!).toFixed(1)}–${(100 * r.high!).toFixed(1)}%)`);

/** The report as plain lines (no claim or passage text). */
export function reportLines(name: string, r: CalibrationReport): string[] {
  return [
    `== ${name}: ${r.calls} calls${Object.keys(r.failedCalls).length ? `, failed ${JSON.stringify(r.failedCalls)}` : ''}`,
    `whole-brief false withholding: ${pct(r.wholeBriefFalseWithholding)}`,
    ...r.supportedBriefs.map((b) => `  ${b.id}: withheld ${b.withheld}/${b.trials} ${JSON.stringify(b.codes)}`),
    `error briefs withheld: ${pct(r.errorBriefs.withheld)}; with the error claim withheld: ${pct(r.errorBriefs.errorClaimWithheld)}`,
    ...Object.entries(r.detection).map(([f, d]) => `detection ${f}: ${pct(d)}`),
    ...Object.entries(r.mutations).map(([m, d]) => `  ${m}: ${d.k}/${d.n}`),
    `critical regressions passed in every trial: ${r.critical.passedEveryTrial}/${r.critical.items}${r.critical.failures.length ? ` (missed: ${r.critical.failures.map((f) => `${f.item}#${f.sample}=${f.verdict}`).join(', ')})` : ''}`,
    `false flags on supported claims: ${pct(r.falseFlags)}`,
    ...Object.entries(r.falseFlagsByKind).map(([k, d]) => `  ${k}: ${d.k}/${d.n}`),
    `chronology_missed: ${r.chronologyMissed.claims} claims in ${r.chronologyMissed.trials} trials; verdicts ${JSON.stringify(r.verdicts)}`,
    `cost: $${r.cost.totalUsd.toFixed(4)} total, $${(r.cost.perCallUsd ?? 0).toFixed(4)} per call, $${(r.cost.perBriefUsd ?? 0).toFixed(4)} per brief`,
    `latency: p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, max ${r.latencyMs.max} ms, ${r.latencyMs.overTimeout} over ${r.latencyMs.timeoutMs} ms`,
    `thinking tokens: ${r.thinkingTokens.total} total, ${r.thinkingTokens.max} max; output tokens max ${r.outputTokens.max}`,
  ];
}
