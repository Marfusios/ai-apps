/**
 * Checker calibration metrics (`checker-metrics-v3`, Task 16e), computed offline from
 * recorded check outputs. Every output is judged by the production code (`judgeCheck`), and
 * every display figure comes from the production display projection (`projectDisplay`,
 * server/briefs/display.ts) over the batch's display plan.
 *
 * Two kinds of figures, never mixed (Task 16d; 16c review I2, gate):
 * - **Verdict figures** (`rawReport`): what the checker said. *Semantic detection* counts
 *   an error claim as detected only with an actual, unambiguous `contradicted` or
 *   `not_established` verdict (`claimState`; v3, the gate's 16d finding 4: v2 counted a
 *   missing verdict as a flag). Missing, repeated or invalid verdicts, and outputs whose
 *   verdict ids cannot be trusted to line up, are *blocked output*, reported apart; a call
 *   that failed detects nothing and is counted apart too. *False flags* are supported
 *   claims with an actual non-supported verdict. The figures named production withholding
 *   come from the projection (`productionWithholding`; `whole` mode is the production
 *   default).
 * - **Display figures** (`displayReport`, the pre-registered M1–M5 and exposure): what the
 *   server's projection displays (server-projection metrics; the web renders all of it).
 *   M1 and M2 are answer retention against the static floor (`oracleDisplay`): the
 *   deterministic rules' abstentions are reported apart (`static`), and the displayed
 *   retention beside them. A failed call or a structurally unusable output blocks
 *   everything (nothing displayed), which is never counted as detection.
 *
 * Labels `unknown` count nowhere; a brief with one is never "wholly supported". Disputed
 * labels (labels v3) count as labelled; `disputedAsUnknown` gives the sensitivity figures.
 * Intervals: Wilson 95% score intervals per trial, and clustered intervals by source bundle
 * (`clusteredRate`: a cluster bootstrap widened to at least the Wilson interval of one
 * observation per bundle), since repeated readings and variants of one bundle are not
 * independent. Calls that ran past the production timeout are censored to failed calls
 * (`censorTrials`) where a protocol measures latency with a longer transport timeout.
 */
export const METRICS_VERSION = 'checker-metrics-v3';
import type { CheckOutput, CheckVerdict } from '../../server/ai/provider.js';
import { dependencyGraph, dependencyViolations, oracleDisplay, projectDisplay, resolveGraph, type DisplayMode, type DisplayOutcome, type DisplayPlan } from '../../server/briefs/display.js';
import { judgeCheck, type CheckCode, type CheckJudgement } from '../../server/briefs/verdicts.js';
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
  /** The run manifest the trial belongs to (Task 16d runs). */
  manifest?: string;
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

/** A rate with its interval clustered by source bundle. */
export interface ClusteredRate extends Rate {
  clusters: number;
  /** Clustered 95% interval: the cluster bootstrap's percentile interval, widened to at least the Wilson interval with one observation per cluster. */
  clusterLow: number | null;
  clusterHigh: number | null;
}

/** A deterministic generator (mulberry32) for the cluster bootstrap. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_RESAMPLES = 10_000;

/** Σk / Σn over units, with Wilson and clustered intervals (clusters: source bundles). */
export function clusteredRate(units: readonly { cluster: string; k: number; n: number }[], seed = 16_4): ClusteredRate {
  const by = new Map<string, { k: number; n: number }>();
  for (const u of units) {
    const c = by.get(u.cluster) ?? { k: 0, n: 0 };
    c.k += u.k;
    c.n += u.n;
    by.set(u.cluster, c);
  }
  const clusters = [...by.values()].filter((c) => c.n > 0);
  const k = clusters.reduce((s, c) => s + c.k, 0);
  const n = clusters.reduce((s, c) => s + c.n, 0);
  const base = rate(k, n);
  if (n === 0) return { ...base, clusters: 0, clusterLow: null, clusterHigh: null };
  const random = prng(seed);
  const ratios: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b += 1) {
    let kk = 0;
    let nn = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const c = clusters[Math.floor(random() * clusters.length)]!;
      kk += c.k;
      nn += c.n;
    }
    ratios.push(nn === 0 ? 0 : kk / nn);
  }
  ratios.sort((x, y) => x - y);
  const at = (q: number) => ratios[Math.min(ratios.length - 1, Math.max(0, Math.floor(q * ratios.length)))]!;
  const floor = rate(Math.round(base.rate! * clusters.length), clusters.length);
  return {
    ...base,
    clusters: clusters.length,
    clusterLow: Math.min(at(0.025), floor.low!),
    clusterHigh: Math.max(at(0.975), floor.high!),
  };
}

/** A gate against a threshold: pass or fail only when the whole clustered interval is on one side; otherwise inconclusive. */
export function gateOf(r: ClusteredRate, threshold: number, direction: 'at_least' | 'at_most'): 'pass' | 'fail' | 'inconclusive' | 'no_data' {
  if (r.clusterLow === null || r.clusterHigh === null) return 'no_data';
  if (direction === 'at_least') return r.clusterLow >= threshold ? 'pass' : r.clusterHigh < threshold ? 'fail' : 'inconclusive';
  return r.clusterHigh <= threshold ? 'pass' : r.clusterLow > threshold ? 'fail' : 'inconclusive';
}

// ---------------------------------------------------------------------------
// Judging and projecting one trial

/** The server's judgement of one trial. */
export interface JudgedTrial {
  trial: Trial;
  batch: CalibrationBatch;
  /** The call failed: nothing to judge (blocked output, never a detection). */
  failed: boolean;
  /** The judged output (null for a failed call). */
  judgement: CheckJudgement | null;
  /** Claim id → its first verdict (null: none, or the call failed). */
  verdicts: Map<string, CheckVerdict | null>;
  /** Claim id → its problem codes. */
  codes: Map<string, CheckCode[]>;
  chronologyMissed: string[];
  /** 16c's rule: every claim confirmed and no structural problem. */
  ok: boolean;
}

/** The meta `judgeCheck` reads, from the labels (a criterion claim's criterion and decision). */
const metaOf = (b: CalibrationBatch) =>
  b.input.claims.map((c) => {
    const l = b.labels.find((x) => x.claim === c.id);
    return { ...(l?.criterion ? { criterion: l.criterion } : {}), ...(l?.decision ? { decision: l.decision } : {}) };
  });

export function judgeTrial(batch: CalibrationBatch, trial: Trial): JudgedTrial {
  const codes = new Map<string, CheckCode[]>(batch.input.claims.map((c) => [c.id, []]));
  const verdicts = new Map<string, CheckVerdict | null>(batch.input.claims.map((c) => [c.id, null]));
  if (trial.output === null) return { trial, batch, failed: true, judgement: null, verdicts, codes, chronologyMissed: [], ok: false };
  const j = judgeCheck(batch.input, trial.output, metaOf(batch));
  for (const p of j.problems) {
    if (p.index < 0) continue;
    codes.get(batch.input.claims[p.index]!.id)!.push(p.code);
  }
  j.claims.forEach((c, i) => verdicts.set(batch.input.claims[i]!.id, c.verdict));
  return { trial, batch, failed: false, judgement: j, verdicts, codes, chronologyMissed: j.chronologyMissed.map((c) => c.claim), ok: j.ok };
}

/** The production display of a judged trial (`plan`: the batch's, or one rebuilt for a v1 batch). */
export function projectTrial(jt: JudgedTrial, mode: DisplayMode, plan: DisplayPlan | undefined = jt.batch.plan): DisplayOutcome {
  if (!plan) throw new Error(`batch ${jt.batch.id} has no display plan`);
  return projectDisplay(plan, jt.judgement ? { kind: 'judged', judgement: jt.judgement } : { kind: 'failed' }, mode);
}

/** Shown claims of a projection whose dependency is not shown (M5: always none). */
export function m5Violations(plan: DisplayPlan, jt: JudgedTrial): number {
  if (!jt.judgement || jt.judgement.structural.length > 0) return 0;
  const nodes = dependencyGraph(
    plan,
    jt.judgement.claims.map((c) => c.confirmed),
    jt.judgement.claims.map((c) => c.verdict === 'contradicted'),
  );
  return dependencyViolations(nodes, resolveGraph(nodes)).length;
}

const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};

const isError = (l: LabelledClaim) => l.label === 'not_supported';
const isControl = (l: LabelledClaim) => l.label === 'supported';
const isBrief = (b: CalibrationBatch, ...kinds: string[]) => b.kind === 'brief' && kinds.includes(b.brief ?? '');

// ---------------------------------------------------------------------------
// Verdict figures (what the checker said; Task 16e: only actual verdicts are detections)

/**
 * What the checker's output says about one claim (`checker-metrics-v3`; the gate's 16d
 * finding 4): `failed` (the call returned nothing), `blocked` (no usable verdict: missing,
 * repeated, invalid evidence or quote, or an output whose verdict ids cannot be trusted to
 * line up: a missing, repeated or unknown id anywhere), `outside` (a `supported` verdict
 * resting on a passage the claim does not cite: not confirmed, `check-judgement-v2`), or the
 * actual verdict. Only an actual `contradicted` or `not_established` verdict is a detection.
 */
export type ClaimState = 'failed' | 'blocked' | 'outside' | CheckVerdict;

const ID_PROBLEMS: ReadonlySet<CheckCode> = new Set(['check_missing_verdict', 'check_duplicate_verdict', 'check_unknown_claim']);
const CLAIM_BLOCKERS: ReadonlySet<CheckCode> = new Set(['check_missing_verdict', 'check_duplicate_verdict', 'check_invalid_evidence', 'check_invalid_quote']);

export function claimState(jt: JudgedTrial, claim: string): ClaimState {
  if (jt.failed || !jt.judgement) return 'failed';
  const codes = jt.codes.get(claim) ?? [];
  const verdict = jt.verdicts.get(claim) ?? null;
  if (verdict === null || codes.some((c) => CLAIM_BLOCKERS.has(c)) || jt.judgement.codes.some((c) => ID_PROBLEMS.has(c))) return 'blocked';
  if (codes.includes('supported_outside_citations')) return 'outside';
  return verdict;
}
const detects = (s: ClaimState) => s === 'contradicted' || s === 'not_established';

/**
 * Calls that ran past the production timeout, censored to what production would have
 * had: a failed call (`timeout`). The 16e runs measure latency with a longer transport
 * timeout (`protocol.v3.ts`, `measureTimeoutMs`) so the tail is seen, and their accuracy
 * figures read every call as production would.
 */
export function censorTrials(trials: readonly Trial[], timeoutMs: number): Trial[] {
  return trials.map((t) => (t.output !== null && t.latencyMs > timeoutMs ? { ...t, output: null, failure: 'timeout' } : t));
}

export interface RawReport {
  calls: number;
  failedCalls: Record<string, number>;
  /** Outputs with a structural problem (by code). */
  structuralCalls: Record<string, number>;
  /** Production withholding of wholly supported brief trials: not shown by the projection in `whole` mode (the production default), failed calls included. */
  wholeBriefWithholding: Rate;
  /** Semantic detection per family: error claims with an actual `contradicted` or `not_established` verdict, over error claims in calls that returned output. */
  semanticDetection: Record<Exclude<Family, 'control'>, Rate> & { all: Rate };
  /** Error claims in calls that returned output whose verdict was blocked (missing, repeated, invalid, or ids that cannot be trusted): neither detected nor missed. */
  blockedErrorClaims: Record<Exclude<Family, 'control'>, number> & { all: number };
  /** Production withholding of error claims, from the projection: not displayed in `whole` mode (production) and in `claims` mode. */
  productionWithholding: { whole: Record<Exclude<Family, 'control'>, Rate> & { all: Rate }; claims: Record<Exclude<Family, 'control'>, Rate> & { all: Rate } };
  /** Error claims in failed calls (neither detected nor missed). */
  failedErrorClaims: number;
  /** Critical regressions: an actual detection in every trial that returned output; trials with a blocked verdict listed apart. */
  critical: {
    items: number;
    flaggedEveryTrial: number;
    failures: { item: string; batch: string; sample: number; verdict: string | null }[];
    blocked: { item: string; batch: string; sample: number }[];
    failedCallTrials: number;
  };
  /** Supported claims with an actual non-supported verdict, over supported claims in calls that returned output. */
  falseFlags: Rate;
  falseFlagsByKind: Record<string, Rate>;
  /** Supported claims whose verdict was blocked, and supported claims resting on uncited passages (`outside`). */
  blockedSupported: number;
  outsideCitations: Rate;
  chronologyMissed: { trials: number; claims: number };
  verdicts: Record<string, number>;
  cost: { totalUsd: number; perCallUsd: number | null; perBriefUsd: number | null };
  latencyMs: { p50: number | null; p95: number | null; max: number | null; overTimeout: number; timeoutMs: number };
  thinkingTokens: { total: number; max: number; zeroThinkingCalls: number };
  outputTokens: { max: number };
}

const FAMILY_KEYS = FAMILIES.filter((f) => f !== 'control') as Exclude<Family, 'control'>[];

export function rawReport(batches: readonly CalibrationBatch[], trials: readonly Trial[], timeoutMs: number, opts: { plans?: ReadonlyMap<string, DisplayPlan> } = {}): RawReport {
  const byId = new Map(batches.map((b) => [b.id, b]));
  const judged = trials.map((t) => {
    const b = byId.get(t.batch);
    if (!b) throw new Error(`trial of unknown batch ${t.batch}`);
    return judgeTrial(b, t);
  });
  const failedCalls: Record<string, number> = {};
  for (const j of judged) if (j.failed) failedCalls[j.trial.failure ?? 'failed'] = (failedCalls[j.trial.failure ?? 'failed'] ?? 0) + 1;
  const structuralCalls: Record<string, number> = {};
  for (const j of judged) for (const c of j.judgement?.structural ?? []) structuralCalls[c] = (structuralCalls[c] ?? 0) + 1;

  const projections = judged.map((j) => {
    const plan = opts.plans?.get(j.batch.id) ?? j.batch.plan;
    if (!plan) throw new Error(`batch ${j.batch.id} has no display plan`);
    return { whole: projectTrial(j, 'whole', plan), claims: projectTrial(j, 'claims', plan) };
  });
  const outcomes = judged.flatMap((j, ji) =>
    j.batch.labels.map((l) => {
      const i = j.batch.input.claims.findIndex((c) => c.id === l.claim);
      const state = claimState(j, l.claim);
      return { j, l, state, verdict: j.verdicts.get(l.claim) ?? null, shownWhole: projections[ji]!.whole.displayed[i] === true, shownClaims: projections[ji]!.claims.displayed[i] === true };
    }),
  );
  const errors = outcomes.filter((o) => isError(o.l));
  const answered = errors.filter((o) => o.state !== 'failed');
  const fam = <T extends { l: LabelledClaim }>(xs: readonly T[], f: Family) => xs.filter((x) => x.l.family === f);
  const perFamily = (xs: readonly (typeof outcomes)[number][], k: (o: (typeof outcomes)[number]) => boolean) => {
    const r = Object.fromEntries(FAMILY_KEYS.map((f) => [f, rate(fam(xs, f).filter(k).length, fam(xs, f).length)])) as Record<Exclude<Family, 'control'>, Rate> & { all: Rate };
    r.all = rate(xs.filter(k).length, xs.length);
    return r;
  };
  const semanticDetection = perFamily(answered, (o) => detects(o.state));
  const blockedErrorClaims = Object.fromEntries(FAMILY_KEYS.map((f) => [f, fam(answered, f).filter((o) => o.state === 'blocked').length])) as RawReport['blockedErrorClaims'];
  blockedErrorClaims.all = answered.filter((o) => o.state === 'blocked').length;
  const productionWithholding = { whole: perFamily(errors, (o) => !o.shownWhole), claims: perFamily(errors, (o) => !o.shownClaims) };

  const critical = errors.filter((o) => o.l.critical);
  const criticalItems = [...new Set(critical.map((o) => `${o.j.batch.id}/${o.l.item}`))];
  const notFlagged = critical.filter((o) => o.state !== 'failed' && !detects(o.state));
  const unflagged = new Set(notFlagged.map((o) => `${o.j.batch.id}/${o.l.item}`));

  const positives = outcomes.filter((o) => isControl(o.l) && o.state !== 'failed');
  const falseFlagsByKind: Record<string, Rate> = {};
  for (const kind of [...new Set(positives.map((o) => o.l.kind))].sort()) {
    const xs = positives.filter((o) => o.l.kind === kind);
    falseFlagsByKind[kind] = rate(xs.filter((o) => detects(o.state)).length, xs.length);
  }
  const verdicts: Record<string, number> = {};
  for (const o of outcomes) {
    const key = o.state === 'failed' ? 'failed_call' : o.state === 'blocked' ? 'blocked' : o.state === 'outside' ? 'supported_outside_citations' : o.state;
    verdicts[key] = (verdicts[key] ?? 0) + 1;
  }

  const supportedTrials = judged.map((j, ji) => ({ j, d: projections[ji]!.whole })).filter(({ j }) => isBrief(j.batch, 'supported'));
  const briefCalls = trials.filter((t) => byId.get(t.batch)?.kind === 'brief');
  const latencies = trials.map((t) => t.latencyMs);
  const totalUsd = trials.reduce((s, t) => s + t.costUsd, 0);
  return {
    calls: trials.length,
    failedCalls,
    structuralCalls,
    wholeBriefWithholding: rate(supportedTrials.filter(({ d }) => !d.shown).length, supportedTrials.length),
    semanticDetection,
    blockedErrorClaims,
    productionWithholding,
    failedErrorClaims: errors.filter((o) => o.state === 'failed').length,
    critical: {
      items: criticalItems.length,
      flaggedEveryTrial: criticalItems.filter((i) => !unflagged.has(i)).length,
      failures: notFlagged.filter((o) => o.state !== 'blocked').map((o) => ({ item: o.l.item, batch: o.j.batch.id, sample: o.j.trial.sample, verdict: o.verdict })),
      blocked: notFlagged.filter((o) => o.state === 'blocked').map((o) => ({ item: o.l.item, batch: o.j.batch.id, sample: o.j.trial.sample })),
      failedCallTrials: critical.filter((o) => o.state === 'failed').length,
    },
    falseFlags: rate(positives.filter((o) => detects(o.state)).length, positives.length),
    falseFlagsByKind,
    blockedSupported: positives.filter((o) => o.state === 'blocked').length,
    outsideCitations: rate(positives.filter((o) => o.state === 'outside').length, positives.length),
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
      zeroThinkingCalls: trials.filter((t) => t.usage !== undefined && (t.usage.thinkingTokens ?? 0) === 0).length,
    },
    outputTokens: { max: Math.max(0, ...trials.map((t) => t.usage?.outputTokens ?? 0)) },
  };
}

// ---------------------------------------------------------------------------
// Display figures (pre-registered; Task 16d `protocol.v2.ts`, Task 16e `protocol.v3.ts`)

/**
 * The display figures are **server-projection metrics** (the gate's 16d finding 3): what
 * the server's projection lets through to the response, which the web renders in full
 * (Task 16e, tests/web). Two views of retention (`checker-metrics-v3`):
 * - **answer retention** (M1, M2): against the static floor, the projection under a checker
 *   that confirms everything (`oracleDisplay`): what the checker and the dependency rules
 *   removed of what the deterministic rules allow. Static abstentions (excerpts that need
 *   their context, ordinals without explicit evidence) and their cascade are reported apart
 *   (`static`).
 * - **displayed retention** (`m1Displayed`, `m2Displayed`): against every supported claim
 *   and wholly supported brief, static abstentions included.
 * An abstention-shaped brief is shown only with a gap note shown when it has any (16d
 * review m5). The safety figures (M3, M4, E1, E2) are what the projection displays, static
 * rules included.
 */
export interface DisplayReport {
  mode: DisplayMode;
  /** M1 answer retention: supported claims displayed, over those the static floor displays (wholly supported brief trials). */
  m1: ClusteredRate;
  m1ByKind: Record<string, Rate>;
  /** Displayed retention: supported claims displayed over every supported claim (static abstentions included). */
  m1Displayed: ClusteredRate;
  /** M2 answer retention: wholly supported brief trials shown, over those whose static floor is shown. */
  m2: ClusteredRate;
  /** Displayed: wholly supported brief trials shown, over every one (static withholding included). */
  m2Displayed: ClusteredRate;
  /** The deterministic rules: claims they abstain from (by rule), supported claims and error claims their floor removes, wholly supported briefs it withholds. */
  static: {
    abstained: Record<string, number>;
    supportedRemoved: number;
    supported: number;
    errorsRemoved: number;
    errors: number;
    briefsWithheld: number;
    briefs: number;
  };
  /** M3: error claims displayed per family, over every trial carrying errors (claim batches and error briefs). */
  m3: Record<Exclude<Family, 'control'>, ClusteredRate> & { all: ClusteredRate };
  /** Critical regressions: displayed in no trial. */
  critical: { items: number; neverDisplayed: number; displayed: { item: string; batch: string; sample: number }[] };
  /** M4: one-error and mixed-error brief trials in which any error claim is displayed. */
  m4: ClusteredRate;
  m4ByCategory: Record<'one_error' | 'mixed_error', Rate>;
  /** M5: displayed claims whose encoded dependency was removed (must be 0): consistency with the encoded dependencies, not their completeness. */
  m5: { violations: number; trials: number };
  /** Exposure: displayed claims labelled not supported, over displayed claims with a known label (every brief trial). */
  e1: ClusteredRate;
  /** Exposure: displayed briefs (summary shown) with any displayed unsupported claim. */
  e2: ClusteredRate;
  /** Why wholly supported brief trials were withheld: blocked output (a failed or structurally unusable call) apart from the display rules. */
  withheld: { trials: number; blocked: Record<string, number>; rules: Record<string, number> };
  /** Error-brief trials whose summary was shown, and how many of them showed an error. */
  errorBriefsShown: Rate;
  /** Labels left unknown: claims, and briefs that therefore are not wholly supported. */
  unknown: { claims: number; of: number; unresolvedBriefs: number; briefs: number };
  /** Trials of each brief category. */
  trials: Record<string, number>;
}

/** The labels with every disputed one read as `unknown`, and brief categories to match (the sensitivity figures). */
export function disputedAsUnknown(batches: readonly CalibrationBatch[]): CalibrationBatch[] {
  return batches.map((b) => {
    if (!b.labels.some((l) => l.disputed)) return b;
    const labels = b.labels.map((l) => (l.disputed ? { ...l, label: 'unknown' as const, family: 'control' as const } : l));
    const errors = labels.filter((l) => l.label === 'not_supported').length;
    const brief = b.kind !== 'brief' ? b.brief : errors >= 2 ? 'mixed_error' : errors === 1 ? 'one_error' : labels.some((l) => l.label === 'unknown') ? 'unresolved' : 'supported';
    return { ...b, labels, ...(brief ? { brief } : {}) };
  });
}

/** A projection shows a brief: an answer by its own rules; an abstention only with a gap note shown when it has any (16d review m5). */
function briefShown(plan: DisplayPlan, d: DisplayOutcome): boolean {
  if (!d.shown) return false;
  if (plan.shape !== 'abstention') return true;
  const gaps = plan.claims.map((c, i) => ({ c, i })).filter(({ c }) => c.kind === 'gap');
  return gaps.length === 0 || gaps.some(({ i }) => d.displayed[i]);
}

export function displayReport(
  batches: readonly CalibrationBatch[],
  trials: readonly Trial[],
  opts: { mode?: DisplayMode; plans?: ReadonlyMap<string, DisplayPlan> } = {},
): DisplayReport {
  const mode = opts.mode ?? 'claims';
  const byId = new Map(batches.map((b) => [b.id, b]));
  const floors = new Map<string, DisplayOutcome>();
  const rows = trials.map((t) => {
    const b = byId.get(t.batch);
    if (!b) throw new Error(`trial of unknown batch ${t.batch}`);
    const j = judgeTrial(b, t);
    const plan = opts.plans?.get(b.id) ?? b.plan;
    if (!plan) throw new Error(`batch ${b.id} has no display plan`);
    const d = projectTrial(j, mode, plan);
    if (!floors.has(b.id)) floors.set(b.id, oracleDisplay(plan, mode));
    const floor = floors.get(b.id)!;
    return {
      b,
      j,
      d,
      plan,
      floor,
      cluster: b.bundle,
      displayed: new Map(b.input.claims.map((c, i) => [c.id, d.displayed[i] === true])),
      allowed: new Map(b.input.claims.map((c, i) => [c.id, floor.displayed[i] === true])),
    };
  });
  const supported = rows.filter((r) => isBrief(r.b, 'supported'));
  const m1Units = supported.map((r) => {
    const ls = r.b.labels.filter((l) => isControl(l) && r.allowed.get(l.claim));
    return { cluster: r.cluster, k: ls.filter((l) => r.displayed.get(l.claim)).length, n: ls.length };
  });
  const m1DisplayedUnits = supported.map((r) => {
    const ls = r.b.labels.filter(isControl);
    return { cluster: r.cluster, k: ls.filter((l) => r.displayed.get(l.claim)).length, n: ls.length };
  });
  const m1ByKind: Record<string, Rate> = {};
  for (const kind of [...new Set(supported.flatMap((r) => r.b.labels.filter(isControl).map((l) => l.kind)))].sort()) {
    const xs = supported.flatMap((r) => r.b.labels.filter((l) => isControl(l) && l.kind === kind && r.allowed.get(l.claim)).map((l) => r.displayed.get(l.claim) === true));
    m1ByKind[kind] = rate(xs.filter(Boolean).length, xs.length);
  }
  const errorRows = rows.flatMap((r) => r.b.labels.filter(isError).map((l) => ({ r, l, shown: r.displayed.get(l.claim) === true })));
  const m3 = Object.fromEntries(
    FAMILY_KEYS.map((f) => [f, clusteredRate(errorRows.filter((e) => e.l.family === f).map((e) => ({ cluster: e.r.cluster, k: e.shown ? 1 : 0, n: 1 })))]),
  ) as DisplayReport['m3'];
  m3.all = clusteredRate(errorRows.map((e) => ({ cluster: e.r.cluster, k: e.shown ? 1 : 0, n: 1 })));
  const critical = errorRows.filter((e) => e.l.critical);
  const criticalItems = [...new Set(critical.map((e) => `${e.r.b.id}/${e.l.item}`))];
  const shownCritical = critical.filter((e) => e.shown);
  const errorBriefs = rows.filter((r) => isBrief(r.b, 'one_error', 'mixed_error'));
  const anyError = (r: (typeof rows)[number]) => r.b.labels.some((l) => isError(l) && r.displayed.get(l.claim));
  const briefs = rows.filter((r) => r.b.kind === 'brief');
  const e1Units = briefs.map((r) => {
    const shown = r.b.labels.filter((l) => l.label !== 'unknown' && r.displayed.get(l.claim));
    return { cluster: r.cluster, k: shown.filter(isError).length, n: shown.length };
  });
  const shownBriefs = briefs.filter((r) => r.d.shown);
  const withheld = { trials: supported.filter((r) => !briefShown(r.plan, r.d)).length, blocked: {} as Record<string, number>, rules: {} as Record<string, number> };
  for (const r of supported.filter((x) => !briefShown(x.plan, x.d))) {
    const codes = r.d.shown ? ['display_gap_notes'] : r.d.withheld;
    for (const c of codes) {
      const into = c === 'check_failed' || c === 'check_structural' ? withheld.blocked : withheld.rules;
      const key = c === 'check_failed' ? `check_failed:${r.j.trial.failure ?? 'failed'}` : c === 'check_structural' ? `check_structural:${(r.j.judgement?.structural ?? []).join('+')}` : c;
      into[key] = (into[key] ?? 0) + 1;
    }
  }
  const abstained: Record<string, number> = {};
  for (const b of new Set(rows.map((r) => r.b))) for (const c of (opts.plans?.get(b.id) ?? b.plan)?.claims ?? []) if (c.abstain) abstained[c.abstain] = (abstained[c.abstain] ?? 0) + 1;
  const floorSupported = supported.flatMap((r) => r.b.labels.filter(isControl).map((l) => r.allowed.get(l.claim) === true));
  const floorErrors = rows.flatMap((r) => r.b.labels.filter(isError).map((l) => r.allowed.get(l.claim) === true));
  const allLabels = batches.flatMap((b) => b.labels);
  const briefBatches = batches.filter((b) => b.kind === 'brief');
  const trialsByCategory: Record<string, number> = {};
  for (const r of rows) {
    const k = r.b.kind === 'claims' ? 'claims' : (r.b.brief ?? 'brief');
    trialsByCategory[k] = (trialsByCategory[k] ?? 0) + 1;
  }
  const floorShown = (r: (typeof rows)[number]) => briefShown(r.plan, r.floor);
  return {
    mode,
    m1: clusteredRate(m1Units),
    m1ByKind,
    m1Displayed: clusteredRate(m1DisplayedUnits),
    m2: clusteredRate(supported.filter(floorShown).map((r) => ({ cluster: r.cluster, k: briefShown(r.plan, r.d) ? 1 : 0, n: 1 }))),
    m2Displayed: clusteredRate(supported.map((r) => ({ cluster: r.cluster, k: briefShown(r.plan, r.d) ? 1 : 0, n: 1 }))),
    static: {
      abstained,
      supportedRemoved: floorSupported.filter((x) => !x).length,
      supported: floorSupported.length,
      errorsRemoved: floorErrors.filter((x) => !x).length,
      errors: floorErrors.length,
      briefsWithheld: supported.filter((r) => !floorShown(r)).length,
      briefs: supported.length,
    },
    m3,
    critical: { items: criticalItems.length, neverDisplayed: criticalItems.length - new Set(shownCritical.map((e) => `${e.r.b.id}/${e.l.item}`)).size, displayed: shownCritical.map((e) => ({ item: e.l.item, batch: e.r.b.id, sample: e.r.j.trial.sample })) },
    m4: clusteredRate(errorBriefs.map((r) => ({ cluster: r.cluster, k: anyError(r) ? 1 : 0, n: 1 }))),
    m4ByCategory: {
      one_error: rate(errorBriefs.filter((r) => r.b.brief === 'one_error' && anyError(r)).length, errorBriefs.filter((r) => r.b.brief === 'one_error').length),
      mixed_error: rate(errorBriefs.filter((r) => r.b.brief === 'mixed_error' && anyError(r)).length, errorBriefs.filter((r) => r.b.brief === 'mixed_error').length),
    },
    m5: { violations: rows.reduce((s, r) => s + m5Violations(r.plan, r.j), 0), trials: rows.length },
    e1: clusteredRate(e1Units),
    e2: clusteredRate(shownBriefs.map((r) => ({ cluster: r.cluster, k: r.b.labels.some((l) => isError(l) && r.displayed.get(l.claim)) ? 1 : 0, n: 1 }))),
    withheld,
    errorBriefsShown: rate(errorBriefs.filter((r) => r.d.shown).length, errorBriefs.length),
    unknown: {
      claims: allLabels.filter((l) => l.label === 'unknown').length,
      of: allLabels.length,
      unresolvedBriefs: briefBatches.filter((b) => b.brief === 'unresolved').length,
      briefs: briefBatches.length,
    },
    trials: trialsByCategory,
  };
}

/** Latency by claim count, and for the maximum-size inputs (gate condition 4). */
export function latencyReport(batches: readonly CalibrationBatch[], trials: readonly Trial[], timeoutMs: number) {
  const byId = new Map(batches.map((b) => [b.id, b]));
  const pts = trials.map((t) => ({ n: byId.get(t.batch)!.input.claims.length, ms: t.latencyMs, failure: t.failure ?? null, max: byId.get(t.batch)!.maxSize === true }));
  const bucket = (n: number) => (n <= 10 ? '1-10' : n <= 20 ? '11-20' : n <= 30 ? '21-30' : n <= 40 ? '31-40' : n <= 50 ? '41-50' : '51+');
  const buckets: Record<string, { calls: number; p50: number | null; p95: number | null; max: number | null }> = {};
  for (const k of [...new Set(pts.map((p) => bucket(p.n)))].sort()) {
    const xs = pts.filter((p) => bucket(p.n) === k).map((p) => p.ms);
    buckets[k] = { calls: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: Math.max(...xs) };
  }
  const maxSize = pts.filter((p) => p.max);
  const all = pts.map((p) => p.ms);
  return {
    timeoutMs,
    calls: pts.length,
    p50: quantile(all, 0.5),
    p95: quantile(all, 0.95),
    max: all.length ? Math.max(...all) : null,
    timeouts: pts.filter((p) => p.failure === 'timeout').length,
    overTimeout: pts.filter((p) => p.ms > timeoutMs).length,
    byClaims: buckets,
    maxSize: { calls: maxSize.length, claims: maxSize.map((p) => p.n), ms: maxSize.map((p) => p.ms), timeouts: maxSize.filter((p) => p.failure === 'timeout').length },
  };
}

const pct = (r: Rate) => (r.rate === null ? 'n/a' : `${(100 * r.rate).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(100 * r.low!).toFixed(1)}–${(100 * r.high!).toFixed(1)}%)`);
const cpct = (r: ClusteredRate) =>
  r.rate === null ? 'n/a' : `${(100 * r.rate).toFixed(1)}% (${r.k}/${r.n}; ${r.clusters} bundles; clustered 95% ${(100 * r.clusterLow!).toFixed(1)}–${(100 * r.clusterHigh!).toFixed(1)}%)`;

/** The verdict figures as plain lines (no claim or passage text). */
export function rawLines(name: string, r: RawReport): string[] {
  const fams = (x: Record<string, Rate>) => Object.entries(x).map(([f, d]) => `${f} ${d.k}/${d.n}`).join(', ');
  return [
    `== ${name} (verdicts): ${r.calls} calls${Object.keys(r.failedCalls).length ? `, failed ${JSON.stringify(r.failedCalls)}` : ''}${Object.keys(r.structuralCalls).length ? `, structural ${JSON.stringify(r.structuralCalls)}` : ''}`,
    ...Object.entries(r.semanticDetection).map(([f, d]) => `semantic detection ${f} (actual contradicted or not_established verdicts): ${pct(d)}`),
    `blocked error claims (no usable verdict: neither detected nor missed): ${JSON.stringify(r.blockedErrorClaims)}; error claims in failed calls: ${r.failedErrorClaims}`,
    `production withholding of error claims (the projection): whole mode ${fams(r.productionWithholding.whole)}; claims mode ${fams(r.productionWithholding.claims)}`,
    `wholly supported brief trials withheld in whole mode (the projection, failed calls included): ${pct(r.wholeBriefWithholding)}`,
    `critical regressions with an actual detection in every answered trial: ${r.critical.flaggedEveryTrial}/${r.critical.items}${r.critical.failures.length ? ` (missed: ${r.critical.failures.map((f) => `${f.item}#${f.sample}=${f.verdict}`).join(', ')})` : ''}${r.critical.blocked.length ? `; blocked: ${r.critical.blocked.map((f) => `${f.item}#${f.sample}`).join(', ')}` : ''}${r.critical.failedCallTrials ? `; ${r.critical.failedCallTrials} in failed calls` : ''}`,
    `false flags on supported claims (actual verdicts, answered calls): ${pct(r.falseFlags)}; blocked ${r.blockedSupported}; supported outside their citations ${pct(r.outsideCitations)}`,
    ...Object.entries(r.falseFlagsByKind).map(([k, d]) => `  ${k}: ${d.k}/${d.n}`),
    `chronology_missed: ${r.chronologyMissed.claims} claims in ${r.chronologyMissed.trials} trials; verdicts ${JSON.stringify(r.verdicts)}`,
    `cost: $${r.cost.totalUsd.toFixed(4)} total, $${(r.cost.perCallUsd ?? 0).toFixed(4)} per call, $${(r.cost.perBriefUsd ?? 0).toFixed(4)} per brief`,
    `latency: p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, max ${r.latencyMs.max} ms, ${r.latencyMs.overTimeout} over ${r.latencyMs.timeoutMs} ms`,
    `thinking tokens: ${r.thinkingTokens.total} total, ${r.thinkingTokens.max} max, ${r.thinkingTokens.zeroThinkingCalls} calls without thinking; output tokens max ${r.outputTokens.max}`,
  ];
}

/** The display figures as plain lines (server-projection metrics). */
export function displayLines(name: string, r: DisplayReport): string[] {
  return [
    `== ${name} (display, server projection, ${r.mode}): trials ${JSON.stringify(r.trials)}`,
    `M1 answer retention (against the static floor): ${cpct(r.m1)}`,
    ...Object.entries(r.m1ByKind).map(([k, d]) => `  ${k}: ${d.k}/${d.n}`),
    `M1 displayed (every supported claim): ${cpct(r.m1Displayed)}`,
    `M2 answer retention (briefs the static floor shows): ${cpct(r.m2)}; withheld ${r.withheld.trials}: blocked ${JSON.stringify(r.withheld.blocked)}, rules ${JSON.stringify(r.withheld.rules)}`,
    `M2 displayed (every wholly supported brief trial): ${cpct(r.m2Displayed)}`,
    `static rules: abstained ${JSON.stringify(r.static.abstained)}; supported claims removed ${r.static.supportedRemoved}/${r.static.supported}; error claims removed ${r.static.errorsRemoved}/${r.static.errors}; wholly supported brief trials withheld ${r.static.briefsWithheld}/${r.static.briefs}`,
    ...Object.entries(r.m3).map(([f, d]) => `M3 ${f} errors displayed: ${cpct(d)}`),
    `critical regressions never displayed: ${r.critical.neverDisplayed}/${r.critical.items}${r.critical.displayed.length ? ` (displayed: ${r.critical.displayed.map((x) => `${x.batch}/${x.item}#${x.sample}`).join(', ')})` : ''}`,
    `M4 error-brief trials with an error displayed: ${cpct(r.m4)}; one-error ${pct(r.m4ByCategory.one_error)}, mixed ${pct(r.m4ByCategory.mixed_error)}; error briefs shown ${pct(r.errorBriefsShown)}`,
    `M5 dependency violations (consistency with the encoded dependencies): ${r.m5.violations} in ${r.m5.trials} projected trials`,
    `E1 unsupported among displayed claims: ${cpct(r.e1)}`,
    `E2 displayed briefs with an unsupported claim: ${cpct(r.e2)}`,
    `unknown labels: ${r.unknown.claims}/${r.unknown.of} claims; ${r.unknown.unresolvedBriefs}/${r.unknown.briefs} briefs unresolved`,
  ];
}
