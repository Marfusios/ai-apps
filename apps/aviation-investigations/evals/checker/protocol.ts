/**
 * The checker calibration's protocol (Task 16c; gate G6), frozen with the labels before
 * any checker output was compared: the configurations, the trials, the targets and the
 * rule that picks the configuration. The held-out split confirms the frozen choice once
 * (`selection.json`) and is never used to tune.
 */
import type { ThinkingMode } from '../../server/ai/anthropic.js';

export const PROTOCOL_VERSION = 'checker-cal-protocol-v1';

/** The configurations compared on the development split. */
export const CONFIGS: Readonly<Record<string, { model: string; thinking: ThinkingMode; note: string }>> = {
  haiku: { model: 'claude-haiku-5-5', thinking: 'off', note: 'Haiku 5.5, thinking disabled, effort low (the v3 checker’s model).' },
  'haiku-think': {
    model: 'claude-haiku-5-5',
    thinking: 'adaptive',
    note: 'Haiku 5.5, adaptive thinking at effort low; the thinking allowance is the room the check output cap leaves above the visible output.',
  },
  sonnet: { model: 'claude-sonnet-5-5', thinking: 'off', note: 'Sonnet 5.5, thinking off (`between_tools`), effort low.' },
};

/**
 * Trials per split and configuration: every claim batch and every brief with one known
 * error once; every wholly supported brief `SUPPORTED_SAMPLES` times (the primary figure
 * is per trial, and repeats show how stable a verdict is).
 */
export const SUPPORTED_SAMPLES = 3;

/** Targets (gate G6): frozen before any comparison. */
export const TARGETS = {
  /** Whole-brief false withholding on wholly supported briefs, point estimate, at most. */
  wholeBriefFalseWithholding: 0.1,
  /** Detection per family (timing, attribution, contradiction, unsupported addition), provisional, at least. */
  familyDetection: 0.95,
  /** Every known critical regression withheld in every trial. */
  criticalRegressions: 'all',
} as const;

/**
 * The selection rule, applied to the development figures only:
 *
 * 1. A configuration is eligible when it withholds every critical regression in every
 *    trial, detects at least 95% of each family, and its whole-brief false withholding
 *    is at most 10%.
 * 2. Among eligible configurations: the lowest whole-brief false withholding; within one
 *    trial of it, the lowest cost per brief; then the lowest p95 latency.
 * 3. If none is eligible: the one with the most critical regressions withheld in every
 *    trial, then the highest lowest-family detection, then the lowest whole-brief false
 *    withholding; the report states which targets it misses.
 * 4. Tuning (development only): if no configuration is eligible, the check prompt may be
 *    revised (a new prompt version; the labels never change) and the development split
 *    re-run, at most twice, within the spend limit. Then the choice is frozen in
 *    `selection.json` (configuration, prompt version, dataset label hash) and committed
 *    before the held-out split runs once with it.
 */
export const SELECTION_RULE = [
  'eligible: every critical regression withheld in every trial; each family detected >= 95%; whole-brief false withholding <= 10% (dev point estimates)',
  'among eligible: lowest whole-brief false withholding; within one trial, lowest cost per brief; then lowest p95 latency',
  'none eligible: most critical regressions passed, then highest lowest-family detection, then lowest false withholding; report the missed targets',
  'tuning on dev only: a revised check prompt version, at most two re-runs, within the spend limit; freeze selection.json and commit before the held-out run',
] as const;

/** Total spend limit of the calibration (every paid step, logged), USD. */
export const CALIBRATION_LIMIT_USD = 3;

/** Wall-clock bound of one calibration check call; production's check timeout is reported against. */
export const CALL_TIMEOUT_MS = 120_000;
