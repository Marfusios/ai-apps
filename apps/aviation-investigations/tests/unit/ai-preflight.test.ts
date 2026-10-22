/**
 * The hard caps against the requests they bound, sized offline: the fixed part of each
 * stage (system prompt and the structured-output schema the adapter sends) with the local
 * `cl100k_base` tokenizer times `OFFLINE_FIXED_FACTOR`, plus its user turn times
 * `OFFLINE_TEXT_FACTOR` (both measured against the provider's counter; worker/ai-preflight.ts).
 * The requests are the same synthetic worst cases `pnpm worker ai-preflight` counts with
 * the provider. A prompt or schema that grows past its cap fails here before any paid run.
 */
import { describe, expect, it } from 'vitest';
import { outputJsonSchema } from '../../server/ai/anthropic.js';
import { STAGE_CAPS } from '../../server/ai/pricing.js';
import { CHECK_SYSTEM, renderCheckUser } from '../../server/ai/prompts/check.v3.js';
import { COMPOSE_SYSTEM, renderComposeUser } from '../../server/ai/prompts/compose.v3.js';
import { renderScopeUser, SCOPE_SYSTEM } from '../../server/ai/prompts/scope.v2.js';
import { CheckInputSchema, CheckOutputSchema, ComposeInputSchema, ScopeInputSchema, ScopeOutputSchema } from '../../server/ai/provider.js';
import { countTokens } from '../../server/ai/tokens.js';
import { ComposeOutputSchema } from '../../shared/contracts/briefs.js';
import { OFFLINE_FIXED_FACTOR, OFFLINE_TEXT_FACTOR, THINKING_ALLOWANCE, preflightRequests } from '../../worker/ai-preflight.js';

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
    expect(r.facts.claims).toBeGreaterThan(80);
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
    expect(text(r.outputs.check)).toBeLessThanOrEqual(STAGE_CAPS.check.output);
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
