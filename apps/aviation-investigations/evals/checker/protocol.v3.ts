/**
 * The checker calibration's protocol v3 (Task 16e; gate G6, the 16d verdict's "next
 * round"), pre-registered: committed before any paid 16e call and before the 16e held-out
 * set exists, with the complete candidate definitions, the frozen rule versions, the
 * sampling, the targets, the selection code, the held-out rules, the budget and the timeout
 * derivation. Any later change to this file is a new protocol version, disclosed in the
 * report; every run manifest records this file's sha256 (`PROTOCOL_V3_FILE`), so a run
 * refuses to resume across a change.
 *
 * **Candidates** are complete configurations, run through the production adapter with the
 * production prompt, schema, caps and maximum claim count (gate condition 4). Two are
 * frozen: `check.v9` at effort `low` and the same prompt at effort `medium` (the gate: more
 * thinking is a hypothesis to test, not a clearance criterion). No prompt revision is
 * planned; there is no round after the two development runs.
 *
 * **Frozen rules** (`FROZEN_RULES`): the validator's quotation rule and excerpt policy, the
 * ordinal rule, the timing rules, the display projection and its dependencies, the check
 * judgement, the metrics and the labels (`checker-labels-v3`: labels v2 with the errata
 * overlay `checker-errata-v1`). A run refuses when the code's versions differ.
 *
 * **Metrics** (display figures through the production projection, `claims` mode,
 * `displayReport`, `checker-metrics-v3`), every call over the production check timeout
 * counted as a timeout (`censorTrials`): M1 answer retention (supported claims displayed
 * over those the static floor displays) ≥ 90%; M2 answer retention (wholly supported brief
 * trials shown over those whose static floor is shown) ≥ 90%; M3 per family ≤ 5%; every
 * critical regression never displayed; M4 (one-error and mixed-error brief trials with an
 * error displayed) ≤ 5%; M5 = 0. The static abstentions (excerpt omissions, ordinal
 * uncertainty) are reported apart from answer retention (`m1Displayed`, `m2Displayed`,
 * `static`). Intervals are clustered by source bundle; a gate whose clustered interval
 * straddles its threshold is inconclusive.
 *
 * **Amendment v3.1** (before any paid call, before the held-out set was frozen): authoring
 * the held-out set showed that `ordinal-evidence-v1` took words that count no flights from
 * the maintenance as an explicit count ("had not flown in 22 years", "the previous two
 * flights"); `ordinal-evidence-v2` requires a count to state what it counts from. That
 * rule version is the only change; the protocol's name says v3.1 and the report discloses
 * it.
 *
 * **Held-out** (`HELDOUT_V3`): new `retrieval.v2` bundles whose cases are in no earlier
 * split, frozen (their split's own label hash in `dataset.v3.json`, committed) before any
 * checker output on them, and run once, for the frozen selection. It cannot reach the size
 * the targets need, so it is an explicitly inconclusive pilot for M3 and M4 and is never
 * called a pass.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Effort, ThinkingMode } from '../../server/ai/anthropic.js';
import { STAGE_EFFORT, STAGE_THINKING } from '../../server/ai/anthropic.js';
import { CHECK_JUDGEMENT_VERSION } from '../../server/briefs/verdicts.js';
import { CHRONOLOGY_RULES_VERSION } from '../../server/briefs/criteria.js';
import { DISPLAY_RULES_VERSION } from '../../server/briefs/display.js';
import { EXCERPT_CONTEXT_VERSION } from '../../server/briefs/excerpts.js';
import { ORDINAL_EVIDENCE_VERSION } from '../../server/briefs/ordinals.js';
import { QUOTE_MATCH_RULE_VERSION } from '../../server/briefs/validate.js';
import { PIPELINE_DEADLINE_MS } from '../../server/quota/policy.js';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { APP_DIR } from '../../worker/config.js';
import { ERRATA_VERSION, LABELS_V3_VERSION } from './labels.v3.js';
import { canonical } from './manifest.js';
import { METRICS_VERSION, type DisplayReport, type RawReport } from './metrics.js';
import { productionCheck } from './protocol.v2.js';

export const PROTOCOL_V3 = 'checker-cal-protocol-v3.1';
export const PROTOCOL_V3_FILE = resolve(APP_DIR, 'evals/checker/protocol.v3.ts');

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** This file's sha256: every v3 manifest records it. */
export function protocolV3Sha256(): string {
  return sha(readFileSync(PROTOCOL_V3_FILE, 'utf8'));
}

/** The rule versions the calibration measures (a run refuses when the code's differ). */
export const FROZEN_RULES = {
  quoteMatch: 'quote-ws-v2',
  excerptContext: 'excerpt-context-v1',
  ordinalEvidence: 'ordinal-evidence-v2',
  chronology: 'chronology-rules-v3',
  display: 'display-deps-v2',
  judgement: 'check-judgement-v2',
  metrics: 'checker-metrics-v3',
  labels: 'checker-labels-v3',
  errata: 'checker-errata-v1',
  dataset: 'checker-cal-v3',
} as const;

/** The code's rule versions now. */
export function codeRules(): Record<keyof typeof FROZEN_RULES, string> {
  return {
    quoteMatch: QUOTE_MATCH_RULE_VERSION,
    excerptContext: EXCERPT_CONTEXT_VERSION,
    ordinalEvidence: ORDINAL_EVIDENCE_VERSION,
    chronology: CHRONOLOGY_RULES_VERSION,
    display: DISPLAY_RULES_VERSION,
    judgement: CHECK_JUDGEMENT_VERSION,
    metrics: METRICS_VERSION,
    labels: LABELS_V3_VERSION,
    errata: ERRATA_VERSION,
    dataset: 'checker-cal-v3',
  };
}

export interface CandidateV3 {
  model: string;
  thinking: ThinkingMode;
  effort: Effort;
  prompt: { version: string; systemSha256: string };
  outputSchema: { version: string; sha256: string };
  caps: { input: number; output: number };
  /** The production check timeout the figures are censored at (`censorTrials`). */
  timeoutMs: number;
  /** The run's own transport timeout: long enough to measure the latency past `timeoutMs`. */
  measureTimeoutMs: number;
  maxClaims: number;
  /** Expected output tokens per call, for pricing only (not a limit). */
  expectedOutputTokens: number;
  note: string;
}

const FIXED = {
  model: 'claude-haiku-5-5',
  thinking: 'adaptive' as ThinkingMode,
  prompt: { version: 'check.v9', systemSha256: '4ad9e6509962e8109a196a73378a9958649ab41f0818b8d31197025935c5b956' },
  outputSchema: { version: 'check-output-v2', sha256: '390156050c874dd4b41951e426b3459fe7304f161495355f43591b48ff574fe4' },
  caps: { input: 40_000, output: 24_500 },
  timeoutMs: 45_000,
  measureTimeoutMs: 90_000,
  maxClaims: 60,
};

/** The frozen candidate set, in round order. */
export const CANDIDATES_V3: Readonly<Record<string, CandidateV3>> = {
  'haiku-think-v9-low': {
    ...FIXED,
    effort: 'low',
    // The 16d calls' mean output (3,822 tokens, thinking included, 291 calls at effort low).
    expectedOutputTokens: 3_822,
    note: 'Haiku 5.5, adaptive thinking at effort low, check.v9, check-output-v2, the production caps, timeout and maximum claim count. Round 1.',
  },
  'haiku-think-v9-medium': {
    ...FIXED,
    effort: 'medium',
    // An assumption for pricing: twice the low-effort mean.
    expectedOutputTokens: 7_644,
    note: 'The same prompt, schema, caps, timeout and maximum claim count at effort medium (Haiku 5.5’s default). Round 2, on the same slots.',
  },
};

/** Round order: the low-effort candidate first, then the medium one, on the same slots. */
export const ROUNDS_V3 = ['haiku-think-v9-low', 'haiku-think-v9-medium'] as const;

/** Why the code cannot run a candidate as defined (empty: it can). Effort is the candidate's own (an adapter override in the runs). */
export function candidateMismatchV3(name: string): string[] {
  const c = CANDIDATES_V3[name];
  if (!c) return [`unknown candidate '${name}' (${Object.keys(CANDIDATES_V3).join(', ')})`];
  const p = productionCheck();
  const out: string[] = [];
  if (c.prompt.version !== p.prompt.version) out.push(`the production check prompt is ${p.prompt.version}, the candidate's ${c.prompt.version}`);
  else if (c.prompt.systemSha256 !== p.prompt.systemSha256) out.push(`the ${c.prompt.version} system prompt is not the frozen text`);
  if (c.outputSchema.version !== p.outputSchema.version || c.outputSchema.sha256 !== p.outputSchema.sha256) out.push('the output schema is not the frozen one');
  if (canonical(c.caps) !== canonical(p.caps)) out.push('the check caps are not the frozen ones');
  if (c.maxClaims !== p.maxClaims) out.push('the maximum claim count is not the frozen one');
  if (STAGE_THINKING.check !== c.thinking) out.push('the check stage does not think adaptively');
  const rules = codeRules();
  for (const [k, v] of Object.entries(FROZEN_RULES) as [keyof typeof FROZEN_RULES, string][]) if (rules[k] !== v) out.push(`rule ${k} is ${rules[k]}, frozen ${v}`);
  return out;
}

/** Whether production runs a candidate exactly (prompt, schema, caps, claims, effort, timeout); empty: it does. */
export function productionMismatchV3(name: string, timeoutMs: number): string[] {
  const c = CANDIDATES_V3[name];
  if (!c) return [`unknown candidate '${name}'`];
  const out = candidateMismatchV3(name);
  if (STAGE_EFFORT.check !== c.effort) out.push(`production checks at effort ${STAGE_EFFORT.check}, the candidate at ${c.effort}`);
  if (STAGE_TIMEOUTS.check !== timeoutMs) out.push(`the production check timeout is ${STAGE_TIMEOUTS.check} ms, the selection's ${timeoutMs} ms`);
  return out;
}

/**
 * Trials per batch and split. Development: briefs without a known error (wholly supported
 * or unresolved) twice, the maximum-size inputs (latency and structure at 60 claims, kept
 * out of the accuracy figures) twice, error briefs and claim batches once; both candidates
 * on the same slots. Held-out: briefs without a known error twice, everything else once.
 */
export const SAMPLES_V3 = {
  dev: { briefWithoutError: 2, maxSize: 2, other: 1 },
  holdout: { briefWithoutError: 2, maxSize: 1, other: 1 },
} as const;

/** Pre-registered targets (display figures, `claims` mode, censored at the production timeout). */
export const TARGETS_V3 = {
  m1: { threshold: 0.9, direction: 'at_least' },
  m2: { threshold: 0.9, direction: 'at_least' },
  m3: { threshold: 0.05, direction: 'at_most' },
  m4: { threshold: 0.05, direction: 'at_most' },
  critical: 'never displayed',
  m5: 0,
} as const;

/**
 * The money (gate: "price the experiment against the remaining allocation"). Every paid 16e
 * step is charged to the named allocation `checker-16e-2026-10` (its log in the 16e work
 * directory, one run at a time under its lock), at most `limitUsd` in all; every call
 * reserves its worst case on the evaluation ledger first, and a call whose reservation
 * would take the allocation over its limit, or the ledger's remaining evaluation allowance
 * below `protectedUsd` (Track N's allocation `track-n-2026-10`, which this task must not
 * consume, taken as unspent), is not sent: the run stops and says so.
 */
export const BUDGET_V3 = {
  allocation: 'checker-16e-2026-10',
  limitUsd: 2.5,
  protectedUsd: 12,
  protectedFor: 'track-n-2026-10',
} as const;

/**
 * The held-out set and pilot (pre-registered; built after this file is committed):
 * - **Bundles**: the 16e questions (`QUESTIONS_16E`) retrieved under `retrieval.v2` (the
 *   cases-index channel included; each case's channel ranks and whether it was mapped are
 *   recorded in `evidence-16e.json`). Bundles holding a case of any earlier split are not
 *   used (the builder refuses them); of the rest, the first `bundles` in question order with
 *   at least four cases make the set.
 * - **Items, as in 16d** (`HELDOUT_V2`): per bundle one brief as compose.v8 would write it
 *   (model-reviewed against every supplied passage), one-error variants spread over the
 *   four families, two mixed-error variants, reading variants where the timing allows, and a
 *   claim batch of controls and mutations by family; each critical timing mutation in at
 *   least `minimumBundlesPerTimingMutation` bundles.
 * - **Frozen** (the held-out split's label hash in a committed `dataset.v3.json`) before any
 *   checker output on it; the development runs run on that same file.
 * - **Runs once**, for the frozen selection, every held-out slot (`SAMPLES_V3.holdout`) in
 *   the order briefs without error, error briefs, claim batches; when the allocation cannot
 *   cover a call, the run stops there and is reported as a partial pilot.
 * - **Pilot**: about 73 independent zero-miss trials per family are needed for a Wilson
 *   upper bound under 5%; repeated readings and variants of one bundle are not independent.
 *   M3 and M4 are reported as an inconclusive pilot whatever they show.
 */
export const HELDOUT_V3 = {
  bundles: 9,
  minimumCases: 4,
  retrievalVersion: 'retrieval.v2',
  independentTrialsFor5pct: 73,
  cluster: 'bundle',
  runs: 1,
  criticalTimingMutations: ['zero_interval', 'previous_day_hours', 'before_after', 'first_flight_window', 'wrong_ordinal', 'settled_as_unknown'],
  minimumBundlesPerTimingMutation: 2,
} as const;

/**
 * The production check timeout, derived from the selected candidate's development latency
 * (maximum-size inputs included): 1.25 times the slowest call, rounded up to 5 seconds, at
 * least 30 s and at most 45 s, the most the step's deadline allows (scope 10 s + retrieve
 * 8 s + compose 35 s + check ≤ `PIPELINE_DEADLINE_MS` − 2 s). Calls over the bound count as
 * timeouts in every figure, as in production.
 */
export const TIMEOUT_V3 = { factor: 1.25, stepMs: 5_000, minMs: 30_000, maxMs: 45_000 } as const;

export function derivedTimeoutMs(latenciesMs: readonly number[]): number {
  const deadlineBound = PIPELINE_DEADLINE_MS - 2_000 - (STAGE_TIMEOUTS.scope + STAGE_TIMEOUTS.retrieve + STAGE_TIMEOUTS.compose);
  const max = Math.min(TIMEOUT_V3.maxMs, deadlineBound);
  if (latenciesMs.length === 0) return max;
  const raw = Math.ceil((TIMEOUT_V3.factor * Math.max(...latenciesMs)) / TIMEOUT_V3.stepMs) * TIMEOUT_V3.stepMs;
  return Math.min(max, Math.max(TIMEOUT_V3.minMs, raw));
}

/** What the selection reads from a development run. */
export interface DevRunV3 {
  protocol: string;
  candidate: string;
  split: 'dev' | 'holdout';
  complete: boolean;
  manifest: string;
  display: DisplayReport;
  raw: RawReport;
}

const familyMax = (d: DisplayReport) => Math.max(...(['timing', 'attribution', 'contradiction', 'unsupported_addition'] as const).map((f) => d.m3[f].rate ?? 1));
const val = (r: { rate: number | null }, missing: number) => r.rate ?? missing;
const effortRank = (name: string) => (CANDIDATES_V3[name]!.effort === 'low' ? 0 : 1);

/**
 * The selection rule (frozen code). Over complete development runs of the frozen
 * candidates, one per candidate:
 * 1. eligible: every critical regression never displayed; M3 at most 5% in every family;
 *    M4 at most 5%; M1 and M2 at least 90%; no M5 violation (development point estimates);
 * 2. among eligible: the highest M2, then the highest M1, then the lowest highest-family
 *    M3, then the lowest M4, then effort `low`;
 * 3. none eligible: the most critical regressions never displayed, then the lowest M4,
 *    then the lowest highest-family M3, then the highest M2, then the highest M1, then
 *    effort `low`; the reason names the missed targets.
 */
export function selectV3(runs: readonly DevRunV3[]): { candidate: string; eligible: string[]; reason: string } {
  const ok = runs.filter((r) => r.protocol === PROTOCOL_V3 && r.split === 'dev' && r.complete && CANDIDATES_V3[r.candidate]);
  if (ok.length === 0) throw new Error('no complete development run of a frozen candidate');
  if (new Set(ok.map((r) => r.candidate)).size !== ok.length) throw new Error('one development run per candidate');
  const criticalOk = (r: DevRunV3) => r.display.critical.neverDisplayed === r.display.critical.items;
  const m1 = (r: DevRunV3) => val(r.display.m1, 0);
  const m2 = (r: DevRunV3) => val(r.display.m2, 0);
  const m4 = (r: DevRunV3) => val(r.display.m4, 1);
  const eligible = ok.filter((r) => criticalOk(r) && familyMax(r.display) <= 0.05 && m4(r) <= 0.05 && m1(r) >= 0.9 && m2(r) >= 0.9 && r.display.m5.violations === 0);
  if (eligible.length > 0) {
    const pick = [...eligible].sort(
      (a, b) => m2(b) - m2(a) || m1(b) - m1(a) || familyMax(a.display) - familyMax(b.display) || m4(a) - m4(b) || effortRank(a.candidate) - effortRank(b.candidate),
    )[0]!;
    return { candidate: pick.candidate, eligible: eligible.map((r) => r.candidate), reason: `eligible: ${eligible.map((r) => r.candidate).join(', ')}; highest M2 ${(100 * m2(pick)).toFixed(1)}%` };
  }
  const pick = [...ok].sort(
    (a, b) =>
      b.display.critical.neverDisplayed - a.display.critical.neverDisplayed ||
      m4(a) - m4(b) ||
      familyMax(a.display) - familyMax(b.display) ||
      m2(b) - m2(a) ||
      m1(b) - m1(a) ||
      effortRank(a.candidate) - effortRank(b.candidate),
  )[0]!;
  const missed = [
    ...(criticalOk(pick) ? [] : ['critical regressions']),
    ...(familyMax(pick.display) <= 0.05 ? [] : ['M3 ≤ 5% in every family']),
    ...(m4(pick) <= 0.05 ? [] : ['M4 ≤ 5%']),
    ...(m1(pick) >= 0.9 ? [] : ['M1 ≥ 90%']),
    ...(m2(pick) >= 0.9 ? [] : ['M2 ≥ 90%']),
    ...(pick.display.m5.violations === 0 ? [] : ['M5']),
  ];
  return {
    candidate: pick.candidate,
    eligible: [],
    reason: `no candidate eligible (${ok.length} development runs); by the fallback order: ${pick.candidate}, critical ${pick.display.critical.neverDisplayed}/${pick.display.critical.items}, M4 ${(100 * m4(pick)).toFixed(1)}%, highest-family M3 ${(100 * familyMax(pick.display)).toFixed(1)}%, M2 ${(100 * m2(pick)).toFixed(1)}%, M1 ${(100 * m1(pick)).toFixed(1)}%; missing ${missed.join(', ') || 'nothing'}`,
  };
}
