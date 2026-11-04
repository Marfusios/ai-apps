/** Code is authoritative. Only static templates and schemas reach prompt management. */
import { z } from 'zod';
import type { AppConfig } from '../shared/config.js';
import { EVIDENCE_SCOPE_SYSTEM, EvidenceScopeWireOutputSchema, renderEvidenceScopeUser } from '../server/ai/prompts/scope.e1.js';
import { RERANK_SYSTEM, RERANK_USER_TEMPLATE, RerankOutputSchema } from '../server/ai/prompts/rerank.r1.js';
import { ATTRIBUTION_SYSTEM, AttributionWireOutputSchema, renderAttributionUser } from '../server/ai/prompts/attribution.a2.js';
import { canonicalRequestHash } from '../server/quota/policy.js';
import { LangfuseApiError, langfuseApi } from '../server/observability/langfuse.js';

/** The attribution user turn with its candidates as a template variable (the sample has no escaped characters). */
const ATTRIBUTION_SAMPLE = [{ id: 'state:OH', field: 'state' as const, value: 'Ohio (OH)' }];
const attributionUser = renderAttributionUser({ question: '{{question}}', candidates: ATTRIBUTION_SAMPLE })
  .replace(JSON.stringify(ATTRIBUTION_SAMPLE), '{{candidates_json}}');

export const MIRRORED_PROMPTS = [
  { name: 'aircase-scope.e3', system: EVIDENCE_SCOPE_SYSTEM, user: renderEvidenceScopeUser({ question: '{{question}}' }), schema: EvidenceScopeWireOutputSchema },
  { name: 'aircase-rerank.r1', system: RERANK_SYSTEM, user: `${RERANK_USER_TEMPLATE}{{input_json}}`, schema: RerankOutputSchema },
  { name: 'aircase-attr.a3', system: ATTRIBUTION_SYSTEM, user: attributionUser, schema: AttributionWireOutputSchema },
].map(({ name, system, user, schema }) => ({ name, type: 'chat' as const,
  prompt: [{ role: 'system', content: system }, { role: 'user', content: user }],
  config: { outputSchema: z.toJSONSchema(schema) },
}));

export async function syncLangfusePrompts(cfg: AppConfig, api = langfuseApi(cfg)) {
  const reports: { name: string; version: number; hash: string; created: boolean }[] = [];
  for (const expected of MIRRORED_PROMPTS) {
    const hash = canonicalRequestHash({ type: expected.type, prompt: expected.prompt, config: expected.config });
    let actual: unknown, created = false;
    try { actual = await api(`v2/prompts/${expected.name}?label=latest&resolve=false`); }
    catch (error) {
      if (!(error instanceof LangfuseApiError) || error.status !== 404) throw error;
      actual = await api('v2/prompts', { ...expected, labels: ['production'], tags: ['code-mirror'], commitMessage: `Frozen template ${hash}` });
      created = true;
    }
    const parsed = z.object({ name: z.string(), version: z.literal(1), type: z.literal('chat'), prompt: z.unknown(), config: z.unknown() }).safeParse(actual);
    if (!parsed.success || parsed.data.name !== expected.name || canonicalRequestHash({ type: parsed.data.type, prompt: parsed.data.prompt, config: parsed.data.config }) !== hash) {
      throw new Error(`Frozen prompt mirror mismatch: ${expected.name}; expected version 1 with the repository content`);
    }
    reports.push({ name: expected.name, version: 1, hash, created });
  }
  return reports;
}
