/**
 * The hard caps against the requests they bound, sized offline: the fixed part of each
 * stage (system prompt and the structured-output schema the adapter sends) with the local
 * `cl100k_base` tokenizer times `OFFLINE_FIXED_FACTOR`, plus its user turn times
 * `OFFLINE_TEXT_FACTOR` (both measured against the provider's counter; worker/ai-preflight.ts).
 * The requests are the same synthetic worst cases `pnpm worker ai-preflight` counts with
 * the provider. A prompt or schema that grows past its cap fails here before any paid run.
 */
import { EvidenceScopeInputSchema, EvidenceScopeWireOutputSchema, EVIDENCE_SCOPE_SYSTEM, renderEvidenceScopeUser } from '../../server/ai/prompts/scope.e1.js';
import { evidencePreflightRequests } from '../../worker/ai-preflight.js';
import { describe, expect, it } from 'vitest';
import { outputJsonSchema } from '../../server/ai/anthropic.js';
import { CACHED_PREFIX_MAX, STAGE_CAPS } from '../../server/ai/pricing.js';
import { CHECK_SYSTEM, renderCheckUser } from '../../server/ai/prompts/check.v9.js';
import { COMPOSE_SYSTEM, renderComposeUser } from '../../server/ai/prompts/compose.v7.js';
import { renderScopeUser, SCOPE_SYSTEM } from '../../server/ai/prompts/scope.v2.js';
import {
  CheckInputSchema,
  CheckOutputSchema,
  ComposeInputSchema,
  MAX_CHECK_CLAIMS,
  ScopeInputSchema,
  ScopeOutputSchema,
  type LlmProvider,
  type LlmStage,
  type StageModels,
} from '../../server/ai/provider.js';
import { countTokens } from '../../server/ai/tokens.js';
import { ComposeOutputSchema } from '../../shared/contracts/briefs.js';
import {
  CHECK_THINKING_ALLOWANCE,
  OFFLINE_FIXED_FACTOR,
  OFFLINE_TEXT_FACTOR,
  THINKING_ALLOWANCE,
  preflightRequests,
  runAiPreflight,
} from '../../worker/ai-preflight.js';

const r = preflightRequests();
const fixed = (system: string, schema: Parameters<typeof outputJsonSchema>[0]) =>
  Math.ceil((countTokens(system) + countTokens(JSON.stringify(outputJsonSchema(schema)))) * OFFLINE_FIXED_FACTOR);
const text = (s: string) => Math.ceil(countTokens(s) * OFFLINE_TEXT_FACTOR);

describe('the stage caps against the requests they bound (offline sizing)', () => {
  it('the synthetic worst cases are valid stage inputs at the server bounds', () => {
    for (const w of r.worst.scope) expect(ScopeInputSchema.safeParse(w.input).success, w.label).toBe(true);
    expect(ComposeInputSchema.safeParse(r.worst.compose).success).toBe(true);
    expect(CheckInputSchema.safeParse(r.worst.check).success).toBe(true);
    expect(ScopeOutputSchema.safeParse(JSON.parse(r.outputs.scope)).success).toBe(true);
    expect(CheckOutputSchema.safeParse(JSON.parse(r.outputs.check)).success).toBe(true);
    expect(ComposeOutputSchema.safeParse(JSON.parse(r.outputs.compose)).success).toBe(true);
    // A full bundle: 12 passages within the 10,000-token evidence budget; the model reads aliases.
    expect(r.facts.passages).toBe(12);
    expect(r.facts.evidenceTokens).toBeLessThanOrEqual(10_000);
    expect(r.facts.evidenceTokens).toBeGreaterThan(9_000);
    expect(r.worst.compose.cases.flatMap((c) => c.passages.map((p) => p.passageId))).toEqual(Array.from({ length: 12 }, (_, i) => `P${i + 1}`));
    // The check input at the claim maximum (Task 16d: 60), with every passage of the bundle.
    expect(r.facts.claims).toBe(MAX_CHECK_CLAIMS);
  });

  it('scope: the fixed part and the longest refinement fit the input cap', () => {
    const base = fixed(SCOPE_SYSTEM, ScopeOutputSchema);
    expect(base + text(renderScopeUser(r.fixed.scope))).toBeLessThanOrEqual(STAGE_CAPS.scope.input);
    for (const w of r.worst.scope.filter((x) => x.latin)) {
      expect(base + text(renderScopeUser(w.input)), w.label).toBeLessThanOrEqual(STAGE_CAPS.scope.input);
    }
    expect(text(r.outputs.scope)).toBeLessThanOrEqual(STAGE_CAPS.scope.output);
  });

  it('answer: the fixed part and a full bundle fit the input cap without re-packing', () => {
    const base = fixed(COMPOSE_SYSTEM, ComposeOutputSchema);
    expect(base + text(renderComposeUser(r.fixed.compose))).toBeLessThanOrEqual(STAGE_CAPS.answer.input);
    expect(base + text(renderComposeUser(r.worst.compose))).toBeLessThanOrEqual(STAGE_CAPS.answer.input);
    // A composition at its schema bounds, with room for thinking, fits the output cap.
    expect(text(r.outputs.compose) + THINKING_ALLOWANCE).toBeLessThanOrEqual(STAGE_CAPS.answer.output);
  });

  it('check: the fixed part and a full bundle’s complete evidence with its claims fit the input cap', () => {
    const base = fixed(CHECK_SYSTEM, CheckOutputSchema);
    expect(base + text(renderCheckUser(r.fixed.check))).toBeLessThanOrEqual(STAGE_CAPS.check.input);
    expect(base + text(renderCheckUser(r.worst.check))).toBeLessThanOrEqual(STAGE_CAPS.check.input);
    // A verdict for each of the most claims at its bounds, with room for thinking.
    expect(text(r.outputs.check) + CHECK_THINKING_ALLOWANCE).toBeLessThanOrEqual(STAGE_CAPS.check.output);
  });

  it('every frozen prefix (system prompt and schema) fits the cached-prefix bound', async () => {
    const { CACHED_PREFIX_MAX } = await import('../../server/ai/pricing.js');
    for (const [system, schema] of [
      [SCOPE_SYSTEM, ScopeOutputSchema],
      [COMPOSE_SYSTEM, ComposeOutputSchema],
      [CHECK_SYSTEM, CheckOutputSchema],
    ] as const) {
      expect(fixed(system, schema)).toBeLessThanOrEqual(CACHED_PREFIX_MAX);
    }
  });
});

describe('runAiPreflight with a stub counter', () => {
  const models: StageModels = { scope: 'claude-haiku-5-5', answer: 'claude-opus-5-5', check: 'claude-haiku-5-5' };
  const key = (x: unknown) => JSON.stringify(x);
  /** The provider's count of each stage's fixed request (the preflight's measurements with compose.v7 and check.v8); 1,000 for anything else. */
  const fixedCounts: Record<LlmStage, number> = { scope: 3_204, compose: 5_007, check: 3_421 };
  const fixedInputs = new Map<string, LlmStage>([
    [key(r.fixed.scope), 'scope'],
    [key(r.fixed.compose), 'compose'],
    [key(r.fixed.check), 'check'],
  ]);
  const provider = {
    name: 'anthropic',
    models,
    countInputTokens: async (stage: LlmStage, input: unknown) => (fixedInputs.get(key(input)) === stage ? fixedCounts[stage] : 1_000),
    scope: () => Promise.reject(new Error('never generates')),
    compose: () => Promise.reject(new Error('never generates')),
    check: () => Promise.reject(new Error('never generates')),
  } as unknown as LlmProvider;
  /** Each fixed request's user turn counted on its own (so the prefixes come out as the preflight measured them); any other text counts 10. */
  const userTurns = new Map([
    [renderScopeUser(r.fixed.scope), 22],
    [renderComposeUser(r.fixed.compose), 124],
    [renderCheckUser(r.fixed.check), 133],
  ]);
  const countText = async (_model: string, text: string) => userTurns.get(text) ?? 10;
  const prefixRows = async () => (await runAiPreflight(provider, countText, models)).filter((row) => row.request.startsWith('cached prefix'));

  it('validates the actual reservation and configured embedder before counting, and reports an oversized evidence output', async () => {
    const evidenceProvider = { ...provider, countEvidenceScopeTokens: async () => 100 };
    await expect(runAiPreflight(evidenceProvider, countText, models)).rejects.toThrow('configured embedding');
    await expect(runAiPreflight(evidenceProvider, countText, models, { embeddingModel: 'text-embedding-3-small', reservationUsd: 0 })).rejects.toThrow('reservation too small');
    // A configured model without an approved price row cannot silently use the small price.
    await expect(runAiPreflight(evidenceProvider, countText, models, { embeddingModel: 'text-embedding-3-large', reservationUsd: 0.0012 })).rejects.toThrow('has no price row');
    const rows = await runAiPreflight(evidenceProvider, async (_m, t) => text(t), models,
      { embeddingModel: 'text-embedding-3-small', reservationUsd: 0.0012 });
    expect(rows.find((r) => r.request === 'scope.e2: output at its schema bounds')).toMatchObject({ ok: false, limit: STAGE_CAPS.scope.output });
  });

  it('reports each stage’s cached prefix as its fixed request less its user turn, against CACHED_PREFIX_MAX', async () => {
    const row = (stage: 'scope' | 'answer' | 'check', tokens: number) => ({
      stage,
      model: models[stage],
      request: 'cached prefix (system prompt + schema)',
      tokens,
      limit: CACHED_PREFIX_MAX,
      ok: true,
    });
    expect(await prefixRows()).toEqual([row('scope', 3_182), row('answer', 4_883), row('check', 3_288)]);
  });

  it('a prefix over the bound fails the preflight even when its request fits the stage cap', async () => {
    const saved = fixedCounts.compose;
    fixedCounts.compose = CACHED_PREFIX_MAX + 124 + 1;
    try {
      const rows = await runAiPreflight(provider, countText, models);
      expect(rows.find((x) => x.stage === 'answer' && x.request.startsWith('fixed'))).toMatchObject({ ok: true });
      expect(rows.find((x) => x.stage === 'answer' && x.request.startsWith('cached prefix'))).toMatchObject({ tokens: CACHED_PREFIX_MAX + 1, ok: false });
      expect(rows.filter((x) => !x.ok)).toHaveLength(1);
    } finally {
      fixedCounts.compose = saved;
    }
  });
});


describe('evidence scope preflight (offline)', () => {
  it('sizes the actual prompt/schema, longest Latin question and every output field at its schema bound', () => {
    const e = evidencePreflightRequests();
    const base = fixed(EVIDENCE_SCOPE_SYSTEM, EvidenceScopeWireOutputSchema);
    expect(base).toBeLessThanOrEqual(CACHED_PREFIX_MAX);
    for (const w of e.worst) {
      expect(EvidenceScopeInputSchema.safeParse(w.input).success).toBe(true);
      if (w.latin) expect(base + text(renderEvidenceScopeUser(w.input))).toBeLessThanOrEqual(STAGE_CAPS.scope.input);
    }
    expect(EvidenceScopeWireOutputSchema.safeParse(JSON.parse(e.output)).success).toBe(true);
    const out = JSON.parse(e.output).result;
    expect(out.terms).toHaveLength(300); expect(out.unchecked).toHaveLength(8);
    expect(out.unchecked.every((r: { quote: string }) => r.quote.length === 300)).toBe(true);
    // The existing 600-token cap does not cover every legal output. Preflight must say so.
    expect(text(e.output)).toBeGreaterThan(STAGE_CAPS.scope.output);
  });
});
