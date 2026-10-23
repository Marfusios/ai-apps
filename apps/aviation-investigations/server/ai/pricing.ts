/**
 * Allowlisted model prices, hard token caps and the per-request reservation check
 * (DESIGN §9). Recalculate the expected sums in the tests whenever a model, price,
 * cap, cache TTL, cached-prefix size or retry policy changes.
 */
import type { AppConfig } from '../../shared/config.js';
import type { StageModels, StageUsage } from './provider.js';

/** USD per million tokens at one price tier. */
export interface TokenRates {
  readonly input: number;
  readonly output: number;
  /** 5-minute cache write, the only TTL the adapters use. */
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

export interface LlmPriceRow extends TokenRates {
  readonly kind: 'llm';
  readonly provider: 'anthropic' | 'openai';
  /**
   * Higher rates for prompts over `thresholdTokens`, counting uncached input, cache
   * writes and cache reads together (Claude Haiku 5.5 above 100K tokens).
   */
  readonly longContext?: TokenRates & { readonly thresholdTokens: number };
}

export interface EmbeddingPriceRow {
  readonly kind: 'embedding';
  readonly provider: 'openai';
  readonly input: number;
}

export type PriceRow = LlmPriceRow | EmbeddingPriceRow;

/**
 * Anthropic first-party prices, checked on 2026-10-22 at standard global routing.
 * Requests never set `inference_geo` (US-only inference costs 1.1x) or fast mode.
 */
export const PRICE_TABLE: Readonly<Record<string, PriceRow>> = {
  'claude-haiku-5-5': {
    kind: 'llm',
    provider: 'anthropic',
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    longContext: { thresholdTokens: 100_000, input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  'claude-sonnet-5-5': { kind: 'llm', provider: 'anthropic', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-opus-5-5': { kind: 'llm', provider: 'anthropic', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  // OpenAI rows. No production adapter uses them (the OpenAI language-model adapter is
  // not implemented); the Track N evaluation judge does (evals/retrieval/narrative).
  // gpt-5.6-luna checked on 2026-10-23 against OpenAI's published standard-tier prices:
  // input $0.20, cached input $0.02, cache write $0.25 (30-minute lifetime, the default:
  // 1.25 times the input rate), output $1.20 (reported output tokens include reasoning); above
  // 272K input tokens $0.40 / $0.04 / $0.50 / $1.80. gpt-5.4-mini's cache rates are not
  // verified for this dated snapshot, so they stay at the full input rate (an upper bound).
  'gpt-5.6-luna': {
    kind: 'llm',
    provider: 'openai',
    input: 0.2,
    output: 1.2,
    cacheWrite: 0.25,
    cacheRead: 0.02,
    longContext: { thresholdTokens: 272_000, input: 0.4, output: 1.8, cacheWrite: 0.5, cacheRead: 0.04 },
  },
  'gpt-5.4-mini-2026-03-17': {
    kind: 'llm',
    provider: 'openai',
    input: 0.75,
    output: 4.5,
    cacheWrite: 0.75,
    cacheRead: 0.75,
  },
  'text-embedding-3-small': { kind: 'embedding', provider: 'openai', input: 0.02 },
};

export type CapStage = 'scope' | 'answer' | 'check' | 'embed';

/**
 * Hard caps in provider tokens. Output includes thinking. Calibrated with the
 * provider's own counter (`messages.countTokens`, free) against real shared-dev passages
 * (DESIGN §9 "Hard caps"; `pnpm worker ai-preflight` re-measures):
 *
 * - scope input: fixed part (system prompt + structured-output schema) 3,204; worst
 *   refinement (prior question and refinement, every filter, readings, case numbers)
 *   5,074 → 6,500.
 * - answer input: fixed part 5,007 (`compose.v6`); a synthetic full bundle (12 passages at
 *   9,403 `cl100k` evidence tokens, 400-character headers, the longest question and
 *   refinement) 22,547; the 10,000-token evidence budget at 1.75 Claude tokens per
 *   `cl100k` token bounds it near 25,600 → 28,000: the measured stress cases fit without
 *   re-packing.
 * - check input: fixed part 3,421 (`check.v5`); complete evidence of a full bundle with 91
 *   claims at their longest 30,987 → 40,000 (gate G6 ruling 5: the evidence is never cut
 *   to fit).
 * - outputs, counted as text at their schema bounds: scope 445 → 600; a composition at
 *   every bound (six cases, each with four chronology facts naming their anchors) 8,000
 *   plus 1,500 for thinking (Opus cannot turn it off) → 11,000 (the offline sizing, at
 *   1.8 tokens per `cl100k` token, puts it at 10,612); a check with a verdict for each of
 *   100 claims, each naming four passages, and eight 200-character quotes 4,320, plus the
 *   calibrated checker's thinking allowance (`CHECK_THINKING_ALLOWANCE` 15,000,
 *   worker/ai-preflight.ts; Haiku 5.5 thinks adaptively, Task 16c) → 21,500 (the offline
 *   sizing, at 1.8 tokens per `cl100k` token, puts it at 21,052).
 */
export const STAGE_CAPS: Readonly<Record<CapStage, { readonly input: number; readonly output: number }>> = {
  scope: { input: 6_500, output: 600 },
  answer: { input: 28_000, output: 11_000 },
  check: { input: 40_000, output: 21_500 },
  embed: { input: 1_000, output: 0 },
};

/**
 * Largest frozen prefix any stage caches (5-minute TTL): its system prompt with the
 * structured-output schema, measured at 4,883 tokens (`compose.v6`, the preflight).
 */
export const CACHED_PREFIX_MAX = 6_500;

/**
 * Per-request reservation in USD, keyed by the answer model: the worst case rounded up
 * (DESIGN §9), with the check model the calibration froze (`claude-haiku-5-5`, adaptive
 * thinking, evals/checker/selection.json). A check on Sonnet costs more: with it the
 * startup check refuses these reservations.
 */
export const RESERVATIONS: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 0.36,
  'claude-sonnet-5-5': 0.19,
  'claude-haiku-5-5': 0.03,
};

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/** The models one request can reach. `embed` defaults to `DEFAULT_EMBEDDING_MODEL`. */
export interface RequestModels extends StageModels {
  readonly embed?: string;
}

export class PricingError extends Error {
  override readonly name = 'PricingError';
}

const PER_MILLION = 1_000_000;

function row(model: string): PriceRow {
  const r = Object.hasOwn(PRICE_TABLE, model) ? PRICE_TABLE[model] : undefined;
  if (!r) throw new PricingError(`Model '${model}' has no price row`);
  return r;
}

export function llmPrice(model: string): LlmPriceRow {
  const r = row(model);
  if (r.kind !== 'llm') throw new PricingError(`Model '${model}' is not priced as a language model`);
  return r;
}

export function embeddingPrice(model: string): EmbeddingPriceRow {
  const r = row(model);
  if (r.kind !== 'embedding') throw new PricingError(`Model '${model}' is not priced as an embedding model`);
  return r;
}

function ratesFor(price: LlmPriceRow, promptTokens: number): TokenRates {
  return price.longContext && promptTokens > price.longContext.thresholdTokens ? price.longContext : price;
}

/**
 * Worst-case cost of one language-model stage: every input and output token at
 * the applicable rate, plus the cache-write premium on the cached prefix.
 */
export function stageWorstCaseUsd(
  model: string,
  caps: { readonly input: number; readonly output: number },
  cachedPrefixTokens = CACHED_PREFIX_MAX,
): number {
  const rates = ratesFor(llmPrice(model), caps.input);
  // The cached prefix is part of the input, so it is bounded by the input cap too.
  const prefix = Math.min(cachedPrefixTokens, caps.input);
  const premium = Math.max(0, rates.cacheWrite - rates.input);
  return (caps.input * rates.input + caps.output * rates.output + prefix * premium) / PER_MILLION;
}

/** Sum over all stages of one request at its hard caps (DESIGN §9). */
export function worstCaseRequestUsd(models: RequestModels): number {
  const embed = embeddingPrice(models.embed ?? DEFAULT_EMBEDDING_MODEL);
  return (
    stageWorstCaseUsd(models.scope, STAGE_CAPS.scope) +
    stageWorstCaseUsd(models.answer, STAGE_CAPS.answer) +
    stageWorstCaseUsd(models.check, STAGE_CAPS.check) +
    (STAGE_CAPS.embed.input * embed.input) / PER_MILLION
  );
}

/** Throws unless every model is priced and the worst case fits the reservation. */
export function assertReservationCovers(models: RequestModels, reservationUsd: number): void {
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0) {
    throw new PricingError('The reservation must be a positive amount');
  }
  const worst = worstCaseRequestUsd(models);
  if (worst > reservationUsd) {
    throw new PricingError(
      `Worst-case request cost $${worst.toFixed(4)} exceeds the $${reservationUsd.toFixed(2)} reservation`,
    );
  }
}

/** Actual cost of one language-model call from normalized usage. */
export function stageCostUsd(model: string, usage: StageUsage): number {
  const promptTokens = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const rates = ratesFor(llmPrice(model), promptTokens);
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.cacheReadTokens * rates.cacheRead) /
    PER_MILLION
  );
}

export function embeddingCostUsd(model: string, tokens: number): number {
  return (tokens * embeddingPrice(model).input) / PER_MILLION;
}

export interface AiStartupCheck {
  enabled: boolean;
  /** Why AI stays disabled. Names settings only, never their values. */
  reason?: string;
  provider?: AppConfig['ai']['llmProvider'];
  models?: Required<RequestModels>;
  reservationUsd?: number;
  worstCaseUsd?: number;
}

/**
 * Run once at server start. AI is enabled only when the configured provider has an
 * adapter, its keys are present, every reachable model is priced for that provider,
 * and the worst-case request fits the answer model's reservation.
 */
export function startupAiCheck(config: Pick<AppConfig, 'nodeEnv' | 'ai'>): AiStartupCheck {
  const ai = config.ai;
  const off = (reason: string): AiStartupCheck => ({ enabled: false, reason });

  if (ai.llmProvider === 'openai') return off('The OpenAI language-model adapter is not implemented');
  if (ai.llmProvider === 'fake' && config.nodeEnv !== 'test') {
    return off("AI_LLM_PROVIDER 'fake' is allowed only when NODE_ENV=test");
  }
  if (ai.llmProvider === 'anthropic') {
    if (!ai.anthropic.apiKey) return off('ANTHROPIC_API_KEY is not set');
    if (!ai.openai.apiKey) return off('OPENAI_API_KEY is not set (query embeddings)');
  }

  // The fake provider reports the configured Anthropic models so the same gate applies.
  const models: Required<RequestModels> = {
    scope: ai.anthropic.scopeModel,
    answer: ai.anthropic.answerModel,
    check: ai.anthropic.checkModel,
    embed: ai.openai.embeddingModel,
  };
  try {
    for (const model of [models.scope, models.answer, models.check]) {
      if (llmPrice(model).provider !== 'anthropic') {
        return off(`Model '${model}' is not an Anthropic model`);
      }
    }
    embeddingPrice(models.embed);
  } catch (err) {
    return off(err instanceof PricingError ? err.message : 'Model pricing could not be resolved');
  }

  const reservationUsd = Object.hasOwn(RESERVATIONS, models.answer) ? RESERVATIONS[models.answer] : undefined;
  if (reservationUsd === undefined) return off(`No reservation is defined for answer model '${models.answer}'`);
  try {
    assertReservationCovers(models, reservationUsd);
  } catch (err) {
    return off(err instanceof PricingError ? err.message : 'The reservation check failed');
  }
  return {
    enabled: true,
    provider: ai.llmProvider,
    models,
    reservationUsd,
    worstCaseUsd: worstCaseRequestUsd(models),
  };
}
