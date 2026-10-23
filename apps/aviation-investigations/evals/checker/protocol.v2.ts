/**
 * The checker calibration's protocol v2 (Task 16d; gate G6), pre-registered: committed
 * before any paid 16d call, with the complete candidate definitions and the selection code
 * (16c review I1, gate condition 1: the 16c selection code was rewritten after its
 * development runs, a procedural deviation). Any later change to this file is a new
 * protocol version, disclosed in the report.
 *
 * **Candidates** are complete configurations: model × thinking × effort × check prompt
 * (version and system-prompt hash) × output schema (version and JSON-schema hash) × caps ×
 * call timeout × maximum claim count. They are the production settings (gate condition 4:
 * calibrate what will actually run): the runs use the production adapter with the
 * production caps (`STAGE_CAPS.check`), the production check timeout
 * (`STAGE_TIMEOUTS.check`) and `MAX_CHECK_CLAIMS`, and a unit test ties production to the
 * frozen selection (`selection.v2.json`). `haiku-think-v8` is the one development revision
 * the brief allows (at most two development prompt rounds): its prompt is written after
 * round 1 from development errors only, and its hash is recorded when it is written; all
 * else is fixed here.
 *
 * **Metrics** (display figures through the production projection, `claims` mode,
 * evals/checker/metrics.ts `displayReport`): M1 supported-claim retention ≥ 90%, M2 wholly
 * supported brief trials shown with minimum useful content ≥ 90%, M3 per family erroneous
 * claims displayed ≤ 5% and every critical regression never displayed, M4 one-error and
 * mixed-error brief trials with an error displayed ≤ 5%, M5 no displayed claim whose
 * dependency was removed (0, and deterministic tests), and the exposure figures (unsupported
 * among displayed claims; displayed briefs with any unsupported claim), reported with the
 * verdict figures (semantic detection, failures apart). Intervals are clustered by source
 * bundle; a gate is **inconclusive** when the clustered interval straddles its threshold.
 * The thresholds of the display rules (more than a third of the summary removed, two
 * contradictions) are pre-registered experimental usability defaults in
 * server/briefs/display.ts (`display-deps-v1`).
 *
 * **Held-out pilot.** About 73 independent zero-miss trials per family are needed for a
 * Wilson upper bound under 5% (`HELDOUT_V2.independentTrialsFor5pct`); repeated readings
 * and variants of one bundle are not independent. The budget cannot buy that, so the
 * held-out run is an explicitly inconclusive pilot for M3 and M4 and is never called a pass.
 */
import { createHash } from 'node:crypto';
import type { ThinkingMode } from '../../server/ai/anthropic.js';
import { outputJsonSchema } from '../../server/ai/anthropic.js';
import { STAGE_CAPS } from '../../server/ai/pricing.js';
import { CHECK_PROMPT_VERSION, CHECK_SYSTEM } from '../../server/ai/prompts/check.v7.js';
import { CHECK_OUTPUT_SCHEMA_VERSION, CheckOutputSchema, MAX_CHECK_CLAIMS } from '../../server/ai/provider.js';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { canonical } from './manifest.js';
import type { DisplayReport, RawReport } from './metrics.js';

export const PROTOCOL_V2 = 'checker-cal-protocol-v2';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface CandidateV2 {
  model: string;
  thinking: ThinkingMode;
  effort: 'low';
  prompt: { version: string; systemSha256: string | null };
  outputSchema: { version: string; sha256: string };
  caps: { input: number; output: number };
  timeoutMs: number;
  maxClaims: number;
  round: 1 | 2;
  note: string;
}

const FIXED = {
  model: 'claude-haiku-5-5',
  thinking: 'adaptive' as ThinkingMode,
  effort: 'low' as const,
  outputSchema: { version: 'check-output-v2', sha256: '390156050c874dd4b41951e426b3459fe7304f161495355f43591b48ff574fe4' },
  caps: { input: 40_000, output: 24_500 },
  timeoutMs: 45_000,
  maxClaims: 60,
};

/** The frozen candidate set. */
export const CANDIDATES_V2: Readonly<Record<string, CandidateV2>> = {
  'haiku-think-v7': {
    ...FIXED,
    prompt: { version: 'check.v7', systemSha256: '7368beddb15d7329f0daf1508a76c438af35ce859a5acd4f507bbcc79da8edfb' },
    round: 1,
    note: 'Haiku 5.5, adaptive thinking at effort low, check.v7, check-output-v2, the production caps, timeout and maximum claim count.',
  },
  'haiku-think-v8': {
    ...FIXED,
    prompt: { version: 'check.v8', systemSha256: null },
    round: 2,
    note: 'The one development revision of check.v7 (written after round 1 from development errors only; its hash is recorded when written). Everything else as haiku-think-v7.',
  },
};

/** The production check configuration as the code has it now (for manifests and the production-equality test). */
export function productionCheck(): { prompt: { version: string; systemSha256: string }; outputSchema: { version: string; sha256: string }; caps: { input: number; output: number }; timeoutMs: number; maxClaims: number } {
  return {
    prompt: { version: CHECK_PROMPT_VERSION, systemSha256: sha(CHECK_SYSTEM) },
    outputSchema: { version: CHECK_OUTPUT_SCHEMA_VERSION, sha256: sha(canonical(outputJsonSchema(CheckOutputSchema))) },
    caps: { ...STAGE_CAPS.check },
    timeoutMs: STAGE_TIMEOUTS.check,
    maxClaims: MAX_CHECK_CLAIMS,
  };
}

/** Why the code cannot run a candidate as defined (empty: it can). */
export function candidateMismatch(name: string): string[] {
  const c = CANDIDATES_V2[name];
  if (!c) return [`unknown candidate '${name}' (${Object.keys(CANDIDATES_V2).join(', ')})`];
  const p = productionCheck();
  const out: string[] = [];
  if (c.prompt.version !== p.prompt.version) out.push(`the production check prompt is ${p.prompt.version}, the candidate's ${c.prompt.version}`);
  else if (c.prompt.systemSha256 !== p.prompt.systemSha256) out.push(`the ${c.prompt.version} system prompt is not the frozen text`);
  if (c.outputSchema.version !== p.outputSchema.version || c.outputSchema.sha256 !== p.outputSchema.sha256) out.push('the output schema is not the frozen one');
  if (canonical(c.caps) !== canonical(p.caps)) out.push('the check caps are not the frozen ones');
  if (c.timeoutMs !== p.timeoutMs) out.push('the check timeout is not the frozen one');
  if (c.maxClaims !== p.maxClaims) out.push('the maximum claim count is not the frozen one');
  return out;
}

/**
 * Trials per batch: briefs without a known error (wholly supported or unresolved) three
 * times; the maximum-size inputs (60 claims; latency, output size and timeouts at the
 * largest checks, kept out of the accuracy figures) twice; error briefs and claim batches
 * once.
 */
export const SAMPLES_V2 = { briefWithoutError: 3, maxSize: 2, other: 1 } as const;

/** Pre-registered targets (display figures, `claims` mode). */
export const TARGETS_V2 = {
  m1: { threshold: 0.9, direction: 'at_least' },
  m2: { threshold: 0.9, direction: 'at_least' },
  m3: { threshold: 0.05, direction: 'at_most' },
  m4: { threshold: 0.05, direction: 'at_most' },
  critical: 'never displayed',
  m5: 0,
} as const;

/** The spend limit of every paid 16d step (the evaluation ledger and `spend-16d.jsonl`), USD. */
export const BUDGET_V2_USD = 1.5;

/**
 * The held-out set and pilot (pre-registered). The set is built and its labels frozen (the
 * held-out split's own label hash in `dataset.v2.json`) before any 16d checker output is
 * seen: new real retrieval bundles (`QUESTIONS_16D`) whose cases are in neither 16c split
 * (the builder refuses any), each with one wholly supported brief as compose.v7 would write
 * it, one-error variants spread over the four families, at least one mixed-error variant,
 * reading variants where the bundle's timing allows, and a claim batch of controls by family
 * that covers each critical timing mutation (`criticalTimingMutations`) in at least
 * `minimumBundlesPerTimingMutation` bundles (16c review M8). It is priced first (free
 * inventory): the pilot runs only when its worst case fits the budget left after the
 * development rounds; otherwise the held-out batches are run in the order supported briefs,
 * error briefs, claim batches until the reservation limit stops it (reported as a partial
 * pilot). It runs once, for the selected candidate. It cannot reach the size the targets
 * need (`independentTrialsFor5pct` independent zero-miss trials per family), so M3 and M4
 * are reported as an inconclusive pilot whatever they show, and nothing here is called a
 * pass.
 */
export const HELDOUT_V2 = {
  /** Wilson 95% upper bound of 0 misses in n independent trials is below 5% from n = 73. */
  independentTrialsFor5pct: 73,
  /** The unit of independence: a source bundle (its cases, readings and variants are one cluster). */
  cluster: 'bundle',
  /** Runs once, for the selected candidate, every held-out batch at `SAMPLES_V2`. */
  runs: 1,
  criticalTimingMutations: ['zero_interval', 'previous_day_hours', 'before_after', 'first_flight_window', 'wrong_ordinal', 'settled_as_unknown'],
  minimumBundlesPerTimingMutation: 2,
  /** Development rounds come first: round 1 (`haiku-think-v7`) on every development slot, then at most one round 2. */
  developmentRounds: 2,
} as const;

/** What the selection reads from a development run. */
export interface DevRunV2 {
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

/**
 * The selection rule (frozen code). Over complete development runs of the frozen
 * candidates, one per candidate:
 * 1. eligible: every critical regression never displayed; M3 at most 5% in every family;
 *    M1 and M2 at least 90%; no M5 violation (development point estimates);
 * 2. among eligible: the highest M2, then the highest M1, then the lowest highest-family
 *    M3, then the earlier round;
 * 3. none eligible: the most critical regressions never displayed, then the lowest
 *    highest-family M3, then the highest M2, then the highest M1, then the earlier round;
 *    the reason names the missed targets.
 */
export function selectV2(runs: readonly DevRunV2[]): { candidate: string; eligible: string[]; reason: string } {
  const ok = runs.filter((r) => r.protocol === PROTOCOL_V2 && r.split === 'dev' && r.complete && CANDIDATES_V2[r.candidate]);
  if (ok.length === 0) throw new Error('no complete development run of a frozen candidate');
  if (new Set(ok.map((r) => r.candidate)).size !== ok.length) throw new Error('one development run per candidate');
  const criticalOk = (r: DevRunV2) => r.display.critical.neverDisplayed === r.display.critical.items;
  const m1 = (r: DevRunV2) => val(r.display.m1, 0);
  const m2 = (r: DevRunV2) => val(r.display.m2, 0);
  const round = (r: DevRunV2) => CANDIDATES_V2[r.candidate]!.round;
  const eligible = ok.filter((r) => criticalOk(r) && familyMax(r.display) <= 0.05 && m1(r) >= 0.9 && m2(r) >= 0.9 && r.display.m5.violations === 0);
  if (eligible.length > 0) {
    const pick = [...eligible].sort((a, b) => m2(b) - m2(a) || m1(b) - m1(a) || familyMax(a.display) - familyMax(b.display) || round(a) - round(b))[0]!;
    return { candidate: pick.candidate, eligible: eligible.map((r) => r.candidate), reason: `eligible: ${eligible.map((r) => r.candidate).join(', ')}; highest M2 ${(100 * m2(pick)).toFixed(1)}%` };
  }
  const pick = [...ok].sort(
    (a, b) =>
      b.display.critical.neverDisplayed - a.display.critical.neverDisplayed ||
      familyMax(a.display) - familyMax(b.display) ||
      m2(b) - m2(a) ||
      m1(b) - m1(a) ||
      round(a) - round(b),
  )[0]!;
  const missed = [
    ...(criticalOk(pick) ? [] : ['critical regressions']),
    ...(familyMax(pick.display) <= 0.05 ? [] : ['M3 ≤ 5% in every family']),
    ...(m1(pick) >= 0.9 ? [] : ['M1 ≥ 90%']),
    ...(m2(pick) >= 0.9 ? [] : ['M2 ≥ 90%']),
    ...(pick.display.m5.violations === 0 ? [] : ['M5']),
  ];
  return {
    candidate: pick.candidate,
    eligible: [],
    reason: `no candidate eligible (${ok.length} development runs); by the fallback order: ${pick.candidate}, critical ${pick.display.critical.neverDisplayed}/${pick.display.critical.items}, highest-family M3 ${(100 * familyMax(pick.display)).toFixed(1)}%, M2 ${(100 * m2(pick)).toFixed(1)}%, M1 ${(100 * m1(pick)).toFixed(1)}%; missing ${missed.join(', ') || 'nothing'}`,
  };
}
