/** Free sizing of the actual preparation + structured-output request, not a prompt-only estimate. */
import { buildRerankInput, type RerankSourceCase } from '../server/evidence/rerank.js';
import { evidenceRankingConfig, type RerankConfig } from '../server/evidence/ranking-config.js';
import { vectorText } from '../server/evidence/pipeline.js';
import { renderRerankUser } from '../server/ai/prompts/rerank.r1.js';
import type { LlmProvider, StageCtx } from '../server/ai/provider.js';
import type { PreflightRow, TextCounter } from './ai-preflight.js';

export const RERANK_PREFLIGHT_CONFIGS = ['er-q-h50-v1', 'er-q-h100-v1', 'er-t-s50-v1'] as const;
const prose = 'The pilot reported a loss of engine power during the climb. Examination of the engine did not establish the reason for the loss of power. The maintenance records documented an inspection before the accident flight. ';
export function rerankPreflightRequests(config: RerankConfig) {
  const source = (text: string, variants: number): RerankSourceCase => ({
    case: { date: '2019-12-31',
      aircraft: Array.from({ length: 3 }, () => ({ category: { code: 'AIR', label: 'Airplane' }, make: 'Experimental amateur built aircraft manufacturer', model: 'Twin engine model with multiple modifications' })),
      definingPhases: ['standing', 'taxi', 'takeoff', 'initial_climb', 'en_route', 'emergency_descent', 'approach', 'landing', 'maneuvering', 'other', 'unknown'] },
    probableCauses: Array.from({ length: variants }, () => ({ text })),
    excerpts: Array.from({ length: 3 }, () => ({ text })),
  });
  const minimal = source('Engine power was lost.', 1);
  const fixed = buildRerankInput('Find engine power loss investigations.', [minimal], config);
  const typical = buildRerankInput('Find completed investigations of engine power loss shortly after maintenance.', Array.from({ length: config.depth }, () => source(prose, 1)), config);
  const question = vectorText(prose.repeat(20).slice(0, 1500));
  const worst = [
    { label: 'Latin maximum fields', input: buildRerankInput(question, Array.from({ length: config.depth }, () => source(prose.repeat(400), 1)), config) },
    { label: 'maximum cause variants', input: buildRerankInput(question, Array.from({ length: config.depth }, () => source('Power loss. '.repeat(2000), 16)), config) },
    { label: 'dense text maximum fields', input: buildRerankInput(vectorText('整備後に発動機の出力が低下した。'.repeat(100).slice(0, 1500)), Array.from({ length: config.depth }, () => source('整備後に発動機の出力が低下した。'.repeat(2000), 1)), config) },
  ];
  return { fixed, typical, worst, output: JSON.stringify({ grades: typical.cases.map(c => ({ id: c.id, grade: 3 })) }) };
}

export async function runRerankPreflight(provider: LlmProvider, countText: TextCounter): Promise<PreflightRow[]> {
  if (!provider.countRerankTokens) throw new Error('rerank token counter unavailable');
  const rows: PreflightRow[] = [];
  for (const name of RERANK_PREFLIGHT_CONFIGS) {
    const c = evidenceRankingConfig(name).rerank!, r = rerankPreflightRequests(c);
    const ctx = (): StageCtx => ({ signal: AbortSignal.timeout(30_000), timeoutMs: 30_000, maxInputTokens: c.caps.input, maxOutputTokens: c.caps.output });
    const add = (request: string, tokens: number, limit: number) => rows.push({ stage: 'rerank', model: c.model, request: `${name}: ${request}`, tokens, limit, ok: tokens <= limit });
    const fixed = await provider.countRerankTokens(r.fixed, ctx(), c);
    add('fixed prompt + schema', fixed, c.caps.input);
    add('cached prefix', Math.max(0, fixed - await countText(c.model, renderRerankUser(r.fixed))), c.cachePrefixTokens);
    for (const w of r.worst) add(w.label, await provider.countRerankTokens(w.input, ctx(), c), c.caps.input);
    add('representative full-depth input (cost estimate)', await provider.countRerankTokens(r.typical, ctx(), c), c.caps.input);
    add('output at full depth', (await countText(c.model, r.output)) - (await countText(c.model, '.')) + 1, c.caps.output);
  }
  return rows;
}
