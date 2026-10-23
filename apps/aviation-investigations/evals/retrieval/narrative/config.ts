/**
 * The Track N judge configuration (task 10c protocol v4, section 3): which models judge,
 * with which thinking or reasoning settings and output caps, and the run limits. The
 * models are pilot candidates, approved through calibration, never by name: the
 * calibration run measures them, and a failed calibration escalates the judge model.
 * The settings are part of each judge's identity in the judgment cache, so changing one
 * re-judges.
 *
 * - Judge A: `claude-haiku-5-5`, adaptive thinking at effort `low` (the setting the
 *   checker calibration found necessary for Haiku to read evidence carefully; Task 16c).
 * - Judge B: `gpt-5.6-luna`, reasoning effort `low`.
 * - Adjudicator: `claude-sonnet-5-5`, thinking off (`between_tools`) at effort `low`:
 *   it runs twice per escalation, and thinking would roughly double its cost (open
 *   design choice in the review package).
 *
 * Output caps hold the visible verdict (a few hundred tokens) plus the thinking or
 * reasoning room; input caps hold the largest judge input (a long case is chunked at
 * `CASE_TOKEN_BUDGET` cl100k tokens, about 20,000 provider tokens with the prompt).
 */
import type { JudgeModelConfig } from './clients.js';

export const JUDGES_VERSION = 'track-n-judges-v1';

export const JUDGE_A: JudgeModelConfig = Object.freeze({
  role: 'judge-a',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  settings: Object.freeze({ thinking: 'adaptive', effort: 'low' }),
  maxOutputTokens: 8_000,
  maxInputTokens: 32_000,
}) as JudgeModelConfig;

export const JUDGE_B: JudgeModelConfig = Object.freeze({
  role: 'judge-b',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  settings: Object.freeze({ reasoning: 'low' }),
  maxOutputTokens: 8_000,
  maxInputTokens: 32_000,
}) as JudgeModelConfig;

export const ADJUDICATOR: JudgeModelConfig = Object.freeze({
  role: 'adjudicator',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  settings: Object.freeze({ thinking: 'off', effort: 'low' }),
  maxOutputTokens: 3_000,
  maxInputTokens: 40_000,
}) as JudgeModelConfig;

/** Per-attempt wall-clock bound of a judge call. */
export const JUDGE_TIMEOUT_MS = 120_000;
export const DEFAULT_CONCURRENCY = 6;

/**
 * Run limits (USD) per paid run, over that run's own spend, enforced before each
 * reservation on top of the allocation's cap and the ledger's remaining evaluation
 * allowance. The calibration limit covers one split with every item adjudicated
 * (about $2.72 for the holdout), so a holdout run is not cut short by its own limit.
 */
export const RUN_LIMITS_USD = Object.freeze({ pools: 0.25, calibration: 3, relevance: 15, answerability: 2.5 });

/**
 * Expected output per call for the cost estimate (not a limit): the visible verdict, and
 * the thinking or reasoning tokens. Haiku's figure comes from the checker calibration's
 * adaptive-thinking trials (mean 2,210 thinking tokens on 8,400-token multi-claim inputs);
 * a one-case grade is assumed to need less, and the estimate keeps it at 1,500.
 */
export const EXPECTED_OUTPUT = Object.freeze({
  'judge-a': { visible: 300, reasoning: 1_500 },
  'judge-b': { visible: 300, reasoning: 1_500 },
  adjudicator: { visible: 400, reasoning: 0 },
});
