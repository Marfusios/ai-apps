import { describe, expect, it } from 'vitest';
import {
  assertReservationCovers,
  CACHED_PREFIX_MAX,
  PRICE_TABLE,
  PricingError,
  RESERVATIONS,
  STAGE_CAPS,
  stageCostUsd,
  stageWorstCaseUsd,
  startupAiCheck,
  worstCaseRequestUsd,
} from '../../server/ai/pricing.js';
import { loadConfig, type AppConfig } from '../../shared/config.js';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const withAnswer = (answer: string) => ({ scope: HAIKU, answer, check: HAIKU });

describe('PRICE_TABLE and caps', () => {
  it('holds the DESIGN §9 prices in USD per million tokens', () => {
    expect(PRICE_TABLE[HAIKU]).toMatchObject({
      kind: 'llm',
      input: 0.1,
      output: 0.5,
      cacheWrite: 0.125,
      cacheRead: 0.01,
    });
    expect(PRICE_TABLE[SONNET]).toMatchObject({ kind: 'llm', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 });
    expect(PRICE_TABLE[OPUS]).toMatchObject({ kind: 'llm', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
    expect(PRICE_TABLE['text-embedding-3-small']).toEqual({ kind: 'embedding', provider: 'openai', input: 0.02 });
    expect(PRICE_TABLE['gpt-5.6-luna']).toMatchObject({ provider: 'openai', input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 });
    expect((PRICE_TABLE['gpt-5.6-luna'] as { longContext?: unknown }).longContext).toEqual({ thresholdTokens: 272_000, input: 0.4, output: 1.8, cacheWrite: 0.5, cacheRead: 0.04 });
    expect(PRICE_TABLE['gpt-5.4-mini-2026-03-17']).toMatchObject({ provider: 'openai', input: 0.75, output: 4.5 });
  });

  it('holds the hard caps and reservations (calibrated with the provider counter, DESIGN §9)', () => {
    expect(STAGE_CAPS).toEqual({
      scope: { input: 6_500, output: 600 },
      answer: { input: 28_000, output: 11_000 },
      check: { input: 40_000, output: 21_500 },
      embed: { input: 1_000, output: 0 },
    });
    expect(CACHED_PREFIX_MAX).toBe(6_500);
    expect(RESERVATIONS).toEqual({ [OPUS]: 0.36, [SONNET]: 0.19, [HAIKU]: 0.03 });
  });

  it('keeps every stage below the Haiku long-context threshold', () => {
    const threshold = (PRICE_TABLE[HAIKU] as { longContext: { thresholdTokens: number } }).longContext.thresholdTokens;
    for (const caps of Object.values(STAGE_CAPS)) expect(caps.input).toBeLessThanOrEqual(threshold);
  });
});

describe('worstCaseRequestUsd', () => {
  it('opus worst case ≈ 0.3545 and fits 0.36', () => {
    const usd = worstCaseRequestUsd(withAnswer(OPUS));
    expect(usd).toBeCloseTo(0.3545, 4);
    // Answer $0.112 input + $0.22 output + $0.0065 prefix premium (6,500 × $1/M); Haiku scope
    // $0.00065 + $0.0003 + $0.0001625 and check $0.004 + $0.01075 (21,500 output tokens,
    // thinking included) + $0.0001625; embedding $0.00002.
    expect(usd).toBeCloseTo(0.354545, 9);
    expect(usd).toBeLessThanOrEqual(0.36);
    expect(() => assertReservationCovers(withAnswer(OPUS), 0.36)).not.toThrow();
    // Eight worst-case briefs fit the $3/day cap.
    expect(Math.floor(3 / RESERVATIONS[OPUS]!)).toBe(8);
  });

  it('sonnet ≈ 0.1853 fits 0.19', () => {
    const usd = worstCaseRequestUsd(withAnswer(SONNET));
    expect(usd).toBeCloseTo(0.1853, 4);
    expect(usd).toBeCloseTo(0.185295, 9);
    expect(() => assertReservationCovers(withAnswer(SONNET), 0.19)).not.toThrow();
  });

  it('haiku ≈ 0.0245 fits 0.03', () => {
    const usd = worstCaseRequestUsd(withAnswer(HAIKU));
    expect(usd).toBeCloseTo(0.0245, 4);
    expect(usd).toBeCloseTo(0.0245075, 9);
    expect(() => assertReservationCovers(withAnswer(HAIKU), 0.03)).not.toThrow();
  });

  it('a Sonnet checker needs more than the Opus reservation holds (G6 #6)', () => {
    const usd = worstCaseRequestUsd({ scope: HAIKU, answer: OPUS, check: SONNET });
    expect(usd).toBeCloseTo(0.637883, 6);
    expect(() => assertReservationCovers({ scope: HAIKU, answer: OPUS, check: SONNET }, RESERVATIONS[OPUS]!)).toThrow(PricingError);
  });

  it('sums every stage at its caps plus the cache-write premium on its prefix', () => {
    // The cached prefix is part of the input, so it never exceeds the stage's input cap.
    expect(stageWorstCaseUsd(OPUS, STAGE_CAPS.answer)).toBeCloseTo(0.112 + 0.22 + 0.0065, 12);
    expect(stageWorstCaseUsd(HAIKU, STAGE_CAPS.scope)).toBeCloseTo(0.00065 + 0.0003 + 0.0001625, 12);
    expect(stageWorstCaseUsd(HAIKU, STAGE_CAPS.check)).toBeCloseTo(0.004 + 0.01075 + 0.0001625, 12);
    expect(stageWorstCaseUsd(OPUS, STAGE_CAPS.answer, 0)).toBeCloseTo(0.332, 12);
    expect(stageWorstCaseUsd(HAIKU, { input: 3_000, output: 0 })).toBeCloseTo((3_000 * 0.1 + 3_000 * 0.025) / 1e6, 12);
    expect(worstCaseRequestUsd(withAnswer(OPUS))).toBeCloseTo(
      stageWorstCaseUsd(HAIKU, STAGE_CAPS.scope) +
        stageWorstCaseUsd(OPUS, STAGE_CAPS.answer) +
        stageWorstCaseUsd(HAIKU, STAGE_CAPS.check) +
        (1_000 * 0.02) / 1e6,
      12,
    );
  });

  it('uses the long-context rates when a cap is above the threshold', () => {
    expect(stageWorstCaseUsd(HAIKU, { input: 120_000, output: 1_000 }, 0)).toBeCloseTo(0.06 + 0.0025, 12);
  });

  it('unknown model throws', () => {
    for (const models of [
      { scope: 'claude-haiku-9', answer: OPUS, check: HAIKU },
      { scope: HAIKU, answer: 'claude-opus-4-8', check: HAIKU },
      { scope: HAIKU, answer: OPUS, check: 'gpt-4o' },
      { scope: HAIKU, answer: OPUS, check: HAIKU, embed: 'text-embedding-3-large' },
      { scope: HAIKU, answer: 'toString', check: HAIKU },
    ]) {
      expect(() => worstCaseRequestUsd(models)).toThrow(PricingError);
      expect(() => assertReservationCovers(models, 1)).toThrow(PricingError);
    }
  });

  it('rejects a model priced for the wrong kind of stage', () => {
    expect(() => worstCaseRequestUsd(withAnswer('text-embedding-3-small'))).toThrow(/not priced as a language model/);
    expect(() => worstCaseRequestUsd({ ...withAnswer(OPUS), embed: HAIKU })).toThrow(/not priced as an embedding/);
  });
});

describe('assertReservationCovers', () => {
  it('throws when the sum exceeds the reservation', () => {
    expect(() => assertReservationCovers(withAnswer(OPUS), 0.34)).toThrow(/exceeds the \$0\.34 reservation/);
    expect(() => assertReservationCovers(withAnswer(OPUS), 0.16)).toThrow(PricingError);
    expect(() => assertReservationCovers(withAnswer(HAIKU), 0.01)).toThrow(PricingError);
  });

  it('rejects a reservation that is not a positive amount', () => {
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertReservationCovers(withAnswer(HAIKU), r)).toThrow(PricingError);
    }
  });
});

describe('stageCostUsd', () => {
  it('prices uncached input, output, cache writes and cache reads separately', () => {
    const usage = { inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 4_000, cacheReadTokens: 2_000 };
    expect(stageCostUsd(OPUS, usage)).toBeCloseTo((4_000 + 2_000 + 20_000 + 400) / 1e6, 12);
    expect(stageCostUsd(HAIKU, usage)).toBeCloseTo((100 + 50 + 500 + 20) / 1e6, 12);
  });

  it('applies Haiku long-context rates when the whole prompt is over 100K tokens', () => {
    const usage = { inputTokens: 90_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 20_000 };
    expect(stageCostUsd(HAIKU, usage)).toBeCloseTo((90_000 * 0.5 + 1_000 * 2.5 + 20_000 * 0.05) / 1e6, 12);
  });
});

describe('startupAiCheck', () => {
  const keys = { ANTHROPIC_API_KEY: 'test-anthropic-key', OPENAI_API_KEY: 'test-openai-key' };
  const config = (env: Record<string, string>) => loadConfig({ env, files: [] });

  it('enables AI with the default models and the Opus reservation', () => {
    const check = startupAiCheck(config(keys));
    expect(check.enabled).toBe(true);
    expect(check.reason).toBeUndefined();
    expect(check.models).toEqual({ scope: HAIKU, answer: OPUS, check: HAIKU, embed: 'text-embedding-3-small' });
    expect(check.reservationUsd).toBe(0.36);
    expect(check.worstCaseUsd).toBeCloseTo(0.354545, 9);
  });

  it('uses the answer model reservation', () => {
    const check = startupAiCheck(config({ ...keys, ANTHROPIC_ANSWER_MODEL: SONNET }));
    expect(check).toMatchObject({ enabled: true, reservationUsd: 0.19 });
  });

  it('stays disabled without provider keys, naming the setting but not its value', () => {
    const noAnthropic = startupAiCheck(config({ OPENAI_API_KEY: 'test-openai-key' }));
    expect(noAnthropic).toEqual({ enabled: false, reason: 'ANTHROPIC_API_KEY is not set' });
    const noOpenai = startupAiCheck(config({ ANTHROPIC_API_KEY: 'test-anthropic-key' }));
    expect(noOpenai.enabled).toBe(false);
    expect(noOpenai.reason).toMatch(/OPENAI_API_KEY/);
    expect(noOpenai.reason).not.toMatch(/test-anthropic-key/);
  });

  it('stays disabled for the unimplemented OpenAI adapter', () => {
    const check = startupAiCheck(config({ ...keys, AI_LLM_PROVIDER: 'openai' }));
    expect(check.enabled).toBe(false);
    expect(check.reason).toMatch(/not implemented/);
  });

  it('stays disabled when a reachable model is unpriced or from another provider', () => {
    expect(startupAiCheck(config({ ...keys, ANTHROPIC_ANSWER_MODEL: 'claude-opus-4-8' }))).toEqual({
      enabled: false,
      reason: "Model 'claude-opus-4-8' has no price row",
    });
    expect(startupAiCheck(config({ ...keys, ANTHROPIC_CHECK_MODEL: 'gpt-5.6-luna' })).reason).toMatch(
      /not an Anthropic model/,
    );
    expect(startupAiCheck(config({ ...keys, OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large' })).enabled).toBe(false);
  });

  it('allows the fake provider only under NODE_ENV=test, without keys', () => {
    const fake = config({ AI_LLM_PROVIDER: 'fake', NODE_ENV: 'test' });
    expect(startupAiCheck(fake)).toMatchObject({ enabled: true, provider: 'fake', reservationUsd: 0.36 });
    const forced: Pick<AppConfig, 'nodeEnv' | 'ai'> = { ...fake, nodeEnv: 'production' };
    expect(startupAiCheck(forced).enabled).toBe(false);
  });
});
