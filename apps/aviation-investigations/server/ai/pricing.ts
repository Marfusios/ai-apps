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
  // Rows for the future OpenAI adapter (not implemented). Cache rates are not
  // verified, so they are priced at the full input rate as an upper bound.
  'gpt-5.6-luna': { kind: 'llm', provider: 'openai', input: 0.2, output: 1.2, cacheWrite: 0.2, cacheRead: 0.2 },
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

/** Hard caps in provider tokens. Output includes thinking. */
export const STAGE_CAPS: Readonly<Record<CapStage, { readonly input: number; readonly output: number }>> = {
  scope: { input: 2_600, output: 400 },
  answer: { input: 16_000, output: 3_000 },
  check: { input: 18_000, output: 600 },
  embed: { input: 1_000, output: 0 },
};

/** Largest frozen system prefix any stage caches (5-minute TTL). */
export const CACHED_PREFIX_MAX = 4_000;

/** Per-request reservation in USD, keyed by the answer model (DESIGN §9). */
export const RESERVATIONS: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 0.14,
  'claude-sonnet-5-5': 0.07,
  'claude-haiku-5-5': 0.01,
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
  // The cached prefix is part of the input, so it is bounded by the input cap too
  // (scope: 2,600 tokens, not 4,000).
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
