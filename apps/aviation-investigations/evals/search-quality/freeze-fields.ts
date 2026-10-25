/** Free-only: pin scope.e3, guard, exact gold, source files, token counts and allocation preflight. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { evidenceScopeCtx } from '../../server/ai/provider.js';
import { evaluationSettings } from './config.js';
import { TaskAllocation, allocationTotals, EvaluationError } from './money.js';
import { fieldSettings, FIELD_SOURCE_FILES, fileSha, FROZEN_DIR, SCOPE_MODEL, verifyFieldManifest, type FieldManifest } from './frozen.js';
import type { FieldDataset } from './types.js';

async function main() {
  const { values } = parseArgs({ options: { 'env-files': { type: 'string' }, 'keys-file': { type: 'string' } } });
  if (!values['env-files']) throw new EvaluationError('Explicit development files required');
  if (existsSync(`${FROZEN_DIR}/field-manifest.json`)) throw new EvaluationError('Field manifest already frozen; never overwrite a paid-run identity');
  if (execFileSync('git', ['status', '--porcelain', '--', 'server', 'shared', 'worker', 'evals/search-quality', 'tests/unit/state-eligibility.test.ts', 'tests/unit/task24-fields.test.ts', 'tests/unit/task24-allocation.test.ts'], { encoding: 'utf8' }).trim()) {
    throw new EvaluationError('Commit the reviewed code and constructed datasets before freezing');
  }
  const dataset = JSON.parse(readFileSync(`${FROZEN_DIR}/fields.json`, 'utf8')) as FieldDataset;
  const verification = JSON.parse(readFileSync(`${FROZEN_DIR}/gold-verification.json`, 'utf8'));
  const leakage = JSON.parse(readFileSync(`${FROZEN_DIR}/leakage.json`, 'utf8'));
  if (!verification.passed || verification.fieldQuestions !== 1040 || leakage.checks.some((c: any) => c.priorMatches.length)) throw new EvaluationError('Gold or leakage preflight incomplete');
  const settings = evaluationSettings(values['env-files'], values['keys-file']);
  if (!settings.config.ai.anthropic.apiKey || settings.config.ai.anthropic.scopeModel !== SCOPE_MODEL) throw new EvaluationError('Frozen scope model/key unavailable');
  const scope = fieldSettings();
  if (scope.systemSha256 !== '901abbf596ebd86ea32afb5c241c51cace149d89958ab1a8a75398930c041b04'
    || scope.wireSha256 !== 'cb20cf6bc65ecd99328518c75e1513e716b92b59a272f5d86a9f022d8ddc85c9') throw new EvaluationError('Cleared scope.e3 prompt/schema changed');
  const provider = createAnthropicProvider({ apiKey: settings.config.ai.anthropic.apiKey, models: { scope: SCOPE_MODEL, answer: SCOPE_MODEL, check: SCOPE_MODEL } });
  const longest = [...dataset.questions].sort((a, b) => Buffer.byteLength(b.question) - Buffer.byteLength(a.question) || a.id.localeCompare(b.id)).slice(0, 5);
  const measured = [];
  for (const q of longest) {
    const tokens = await provider.countEvidenceScopeTokens!({ question: q.question }, evidenceScopeCtx(AbortSignal.timeout(10_000), 10_000));
    if (tokens > scope.caps.input) throw new EvaluationError('Free count exceeds scope input cap');
    measured.push({ id: q.id, tokens });
  }
  const allocation = await TaskAllocation.open(settings, 'data/work/task24/preflight');
  let ledger;
  try {
    await allocation.assertBlock('fields', dataset.questions.length * Math.round(scope.reservationUsd * 1e6));
    ledger = { total: await allocationTotals(allocation.db), fields: await allocationTotals(allocation.db, 'fields'),
      monthlyIngestionUsd: allocation.config.ai.budgets.ingestionMonthlyUsd };
  } finally { await allocation.close(); }
  const dataFiles = ['confirmation.json', 'fields.json', 'exclusions.json', 'leakage.json', 'gold-verification.json', 'construction.json', 'construction-review.json'].map(f => `${FROZEN_DIR}/${f}`);
  const manifest: FieldManifest = { version: 'task24-field-freeze-v1', frozenAt: new Date().toISOString(),
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), settings: scope,
    files: Object.fromEntries([...FIELD_SOURCE_FILES, 'evals/search-quality/freeze-fields.ts', 'evals/search-quality/verify-data.ts',
      'evals/search-quality/construct.py', 'evals/search-quality/exclusions.py', 'evals/search-quality/snapshot.ts', ...dataFiles].map(f => [f, fileSha(f)])),
    freePreflight: { measured, ledger, pricesChecked: '2026-10-25', priceSource: 'https://platform.claude.com/docs/en/models/haiku-5-5/overview' } };
  writeFileSync(`${FROZEN_DIR}/field-manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const frozen = verifyFieldManifest();
  console.log(JSON.stringify({ paidCalls: 0, frozen: frozen.hash, questions: dataset.questions.length, measured,
    worstCaseBlockUsd: dataset.questions.length * scope.reservationUsd, ledger }));
}
main().catch(e => { console.error(e instanceof EvaluationError ? e.message : 'Free field freeze failed; exception details suppressed.'); process.exitCode = 1; });
