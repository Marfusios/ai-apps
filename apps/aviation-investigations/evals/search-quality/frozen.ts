import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { EVIDENCE_SCOPE_SYSTEM, EvidenceScopeWireOutputSchema, EVIDENCE_SCOPE_VERSION } from '../../server/ai/prompts/scope.e1.js';
import { outputJsonSchema, STAGE_EFFORT, STAGE_THINKING } from '../../server/ai/anthropic.js';
import { EVIDENCE_SCOPE_CAPS, stageWorstCaseUsd, llmPrice } from '../../server/ai/pricing.js';
import { ceilUsd } from '../../worker/index/spend-gate.js';
import { STATE_GUARD_VERSION } from '../../shared/state-eligibility.js';
import { EvaluationError } from './money.js';

export const FROZEN_DIR = 'evals/search-quality/frozen';
export const SCOPE_MODEL = 'claude-haiku-5-5';
export const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const fileSha = (path: string) => sha(readFileSync(path));
export const FIELD_SOURCE_FILES = [
  'evals/search-quality/fields.ts', 'evals/search-quality/field-score.ts', 'evals/search-quality/frozen.ts',
  'evals/search-quality/money.ts', 'evals/search-quality/config.ts', 'evals/search-quality/types.ts',
  'shared/state-eligibility.ts', 'shared/vocab.ts', 'shared/codes.ts', 'shared/contracts/briefs.ts',
  'shared/contracts/evidence.ts', 'shared/contracts/search.ts', 'shared/contracts/common.ts', 'shared/config.ts',
  'server/ai/anthropic.ts', 'server/ai/provider.ts', 'server/ai/pricing.ts',
  'server/ai/prompts/scope.e1.ts', 'server/ai/prompts/untrusted.ts',
  'worker/index/spend-gate.ts', 'server/quota/spend.ts', 'server/quota/settle.ts', 'server/quota/pacing.ts',
  'server/quota/policy.ts', 'server/quota/hold.ts', 'server/db/client.ts', 'pnpm-lock.yaml',
] as const;
export function fieldSettings() {
  return { model: SCOPE_MODEL, version: EVIDENCE_SCOPE_VERSION, systemSha256: sha(EVIDENCE_SCOPE_SYSTEM),
    wireSha256: sha(JSON.stringify(outputJsonSchema(EvidenceScopeWireOutputSchema))), caps: EVIDENCE_SCOPE_CAPS,
    timeoutMs: 10_000, thinking: STAGE_THINKING.scope, effort: STAGE_EFFORT.scope, retries: 0,
    price: llmPrice(SCOPE_MODEL), worstCaseUsd: stageWorstCaseUsd(SCOPE_MODEL, EVIDENCE_SCOPE_CAPS),
    reservationUsd: ceilUsd(stageWorstCaseUsd(SCOPE_MODEL, EVIDENCE_SCOPE_CAPS)), guard: STATE_GUARD_VERSION };
}
export interface FieldManifest {
  version: 'task24-field-freeze-v1'; frozenAt: string; codeCommit: string;
  settings: ReturnType<typeof fieldSettings>;
  files: Record<string, string>;
  freePreflight: { measured: { id: string; tokens: number }[]; pricesChecked: string; priceSource: string; ledger: unknown };
}
export function verifyFieldManifest(path = `${FROZEN_DIR}/field-manifest.json`): { manifest: FieldManifest; hash: string } {
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes.toString()) as FieldManifest;
  if (manifest.version !== 'task24-field-freeze-v1' || JSON.stringify(manifest.settings) !== JSON.stringify(fieldSettings())) throw new EvaluationError('Frozen field settings changed');
  if (manifest.settings.version !== 'scope.e3' || manifest.settings.systemSha256 !== '901abbf596ebd86ea32afb5c241c51cace149d89958ab1a8a75398930c041b04'
    || manifest.settings.wireSha256 !== 'cb20cf6bc65ecd99328518c75e1513e716b92b59a272f5d86a9f022d8ddc85c9') throw new EvaluationError('Scope.e3 differs from the cleared 23E2 prompt/schema');
  for (const [file, hash] of Object.entries(manifest.files)) if (fileSha(resolve(file)) !== hash) throw new EvaluationError(`Frozen file changed: ${file}`);
  if (!manifest.freePreflight.measured.length || manifest.freePreflight.measured.some(m => m.tokens > manifest.settings.caps.input)) throw new EvaluationError('Missing or failed free token preflight');
  return { manifest, hash: sha(bytes) };
}
