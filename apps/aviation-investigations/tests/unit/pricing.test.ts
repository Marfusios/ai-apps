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
    expect(PRICE_TABLE['gpt-5.6-luna']).toMatchObject({ provider: 'openai', input: 0.2, output: 1.2 });
    expect(PRICE_TABLE['gpt-5.4-mini-2026-03-17']).toMatchObject({ provider: 'openai', input: 0.75, output: 4.5 });
  });

  it('holds the hard caps and reservations', () => {
    expect(STAGE_CAPS).toEqual({
      scope: { input: 2_600, output: 400 },
      answer: { input: 16_000, output: 3_000 },
      check: { input: 18_000, output: 600 },
      embed: { input: 1_000, output: 0 },
    });
    expect(CACHED_PREFIX_MAX).toBe(4_000);
    expect(RESERVATIONS).toEqual({ [OPUS]: 0.14, [SONNET]: 0.07, [HAIKU]: 0.01 });
  });

  it('keeps every stage below the Haiku long-context threshold', () => {
    const threshold = (PRICE_TABLE[HAIKU] as { longContext: { thresholdTokens: number } }).longContext.thresholdTokens;
    for (const caps of Object.values(STAGE_CAPS)) expect(caps.input).toBeLessThanOrEqual(threshold);
  });
});

describe('worstCaseRequestUsd', () => {
  it('opus worst case ≈ 0.1307 and fits 0.14', () => {
    const usd = worstCaseRequestUsd(withAnswer(OPUS));
    expect(usd).toBeCloseTo(0.1307, 4);
    // $0.12658 uncached + $0.004 answer prefix + Haiku prefixes: check 4,000 and
    // scope 2,600 tokens (its whole input cap) at the $0.025/M write premium.
    expect(usd).toBeCloseTo(0.130745, 9);
    expect(usd).toBeLessThanOrEqual(0.14);
    expect(() => assertReservationCovers(withAnswer(OPUS), 0.14)).not.toThrow();
  });

  it('sonnet ≈ 0.0667 fits 0.07', () => {
    const usd = worstCaseRequestUsd(withAnswer(SONNET));
    expect(usd).toBeCloseTo(0.0667, 4);
    expect(usd).toBeCloseTo(0.066745, 9);
    expect(() => assertReservationCovers(withAnswer(SONNET), 0.07)).not.toThrow();
  });

  it('haiku ≈ 0.0059 fits 0.01', () => {
    const usd = worstCaseRequestUsd(withAnswer(HAIKU));
    expect(usd).toBeCloseTo(0.0059, 4);
    expect(usd).toBeCloseTo(0.005945, 9);
    expect(() => assertReservationCovers(withAnswer(HAIKU), 0.01)).not.toThrow();
  });

  it('sums every stage at its caps plus the cache-write premium on its prefix', () => {
    // The cached prefix is part of the input, so it never exceeds the stage's input cap.
    expect(stageWorstCaseUsd(OPUS, STAGE_CAPS.answer)).toBeCloseTo(0.064 + 0.06 + 0.004, 12);
    expect(stageWorstCaseUsd(HAIKU, STAGE_CAPS.scope)).toBeCloseTo(0.00026 + 0.0002 + 0.000065, 12);
    expect(stageWorstCaseUsd(HAIKU, STAGE_CAPS.check)).toBeCloseTo(0.0018 + 0.0003 + 0.0001, 12);
    expect(stageWorstCaseUsd(OPUS, STAGE_CAPS.answer, 0)).toBeCloseTo(0.124, 12);
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
    expect(() => assertReservationCovers(withAnswer(OPUS), 0.13)).toThrow(/exceeds the \$0\.13 reservation/);
    expect(() => assertReservationCovers(withAnswer(OPUS), 0.07)).toThrow(PricingError);
    expect(() => assertReservationCovers(withAnswer(HAIKU), 0.005)).toThrow(PricingError);
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
    expect(check.reservationUsd).toBe(0.14);
    expect(check.worstCaseUsd).toBeCloseTo(0.130745, 9);
  });

  it('uses the answer model reservation', () => {
    const check = startupAiCheck(config({ ...keys, ANTHROPIC_ANSWER_MODEL: SONNET }));
    expect(check).toMatchObject({ enabled: true, reservationUsd: 0.07 });
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
    expect(startupAiCheck(fake)).toMatchObject({ enabled: true, provider: 'fake', reservationUsd: 0.14 });
    const forced: Pick<AppConfig, 'nodeEnv' | 'ai'> = { ...fake, nodeEnv: 'production' };
    expect(startupAiCheck(forced).enabled).toBe(false);
  });
});
