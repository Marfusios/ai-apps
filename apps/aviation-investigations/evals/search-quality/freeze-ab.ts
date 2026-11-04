/** Free-only A/B construction: read-only corpus checks, free provider counts and immutable pins. */
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { evidenceScopeCtx } from '../../server/ai/provider.js';
import { queryEmbeddingInput, MAX_QUERY_INPUT_TOKENS } from '../../server/ai/embeddings.js';
import { countTokens } from '../../server/ai/tokens.js';
import { vectorText } from '../../server/evidence/pipeline.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { evidenceReservation } from '../../server/evidence/pricing.js';
import { rerankPreflightRequests, RERANK_PREFLIGHT_CONFIGS } from '../../worker/rerank-preflight.js';
import { evaluationSettings } from './config.js';
import { verifyRankingTarget } from './ab-target.js';
import { AB_MANIFEST_PATH, readABManifest, type ABManifest } from './ab-manifest.js';
import { ARM_IDS, CORE_ARMS, type Arm, type ArmIdentity } from './ab-types.js';
import { fileSha, sha, FROZEN_DIR } from './frozen.js';
import { allocationTotals, TaskAllocation, EvaluationError } from './money.js';

async function main() {
  const { values } = parseArgs({ options: { 'env-files': { type: 'string' }, 'keys-file': { type: 'string' },
    protocol: { type: 'string' }, 'field-design': { type: 'string' }, 'server-commit': { type: 'string' } } });
  if (!values['env-files'] || !values.protocol || !values['field-design'] || !values['server-commit']
    || !/^[a-f0-9]{40}$/.test(values['server-commit'])) throw new EvaluationError('Free freeze requires development files, registered documents and full server commit');
  if (existsSync(AB_MANIFEST_PATH)) throw new EvaluationError('A/B manifest already frozen');
  if (execFileSync('git', ['status', '--porcelain', '--', 'server', 'shared', 'worker', 'evals/search-quality', 'tests/unit/task24-ab.test.ts', 'tests/unit/task24-production-port.test.ts'], { encoding: 'utf8' }).trim()) throw new EvaluationError('Commit construction before freezing A/B');
  execFileSync('git', ['merge-base', '--is-ancestor', values['server-commit'], 'HEAD']);
  // OpenAI is not needed for a free preflight; do not read its shared key.
  const settings = evaluationSettings(values['env-files'], undefined, true);
  const countSettings = evaluationSettings(values['env-files'], values['keys-file']);
  if (!settings.config.databaseUrl || !countSettings.config.ai.anthropic.apiKey) throw new EvaluationError('Development reader or Anthropic free token counter is not configured');
  const db = createDb(settings.config.databaseUrl, { max: 2, applicationName: 'aircase-task24-freeze-read' });
  const es = createEsClient(settings.config.elasticsearch, 'read');
  try {
    const target = await verifyRankingTarget(db, es);
    const arms = Object.fromEntries(Object.entries(ARM_IDS).map(([alias, version]) => {
      const c = evidenceRankingConfig(version), price = evidenceReservation(c.scope.model, c.embedding.model, c);
      return [alias, { alias, ...evidenceRankingIdentity(c), reservationUsd: price.reservationUsd,
        changedKnobs: Number(c.lexicalText !== 'question') + Number(c.rerank !== null), depth: c.rerank?.depth ?? 0 }];
    })) as Record<Arm, ArmIdentity>;
    const coreWorstCaseUsd = Math.round(CORE_ARMS.reduce((n, a) => n + arms[a].reservationUsd * 63, 0) * 1e6) / 1e6;
    if (coreWorstCaseUsd > 9) throw new EvaluationError('The complete six-arm core cannot fit its allocation');
    const provider = createAnthropicProvider({ apiKey: countSettings.config.ai.anthropic.apiKey, models: {
      scope: 'claude-haiku-5-5', answer: 'claude-haiku-5-5', check: 'claude-haiku-5-5' } });
    const counts: { stage: string; configuration: string; request: string; tokens: number; limit: number }[] = [];
    for (const q of [...target.selection, ...target.fresh.questions]) {
      const tokens = countTokens(queryEmbeddingInput(vectorText(q.question)));
      counts.push({ stage: 'embed-local-count', configuration: 'text-embedding-3-small', request: q.id, tokens, limit: MAX_QUERY_INPUT_TOKENS });
      if (tokens > MAX_QUERY_INPUT_TOKENS) throw new EvaluationError('Local embedding count exceeds its cap');
    }
    for (const version of RERANK_PREFLIGHT_CONFIGS) {
      const configuration = evidenceRankingConfig(version), c = configuration.rerank!, requests = rerankPreflightRequests(c);
      for (const request of [{ label: 'fixed', input: requests.fixed }, ...requests.worst, { label: 'typical', input: requests.typical }]) {
        const tokens = await provider.countRerankTokens!(request.input, { signal: AbortSignal.timeout(30_000), timeoutMs: 30_000,
          maxInputTokens: c.caps.input, maxOutputTokens: c.caps.output }, configuration);
        counts.push({ stage: 'rerank', configuration: version, request: request.label, tokens, limit: c.caps.input });
        if (tokens > c.caps.input) throw new EvaluationError('Free rerank count exceeds the frozen server cap');
      }
    }
    const questions = [...target.selection, ...target.fresh.questions].sort((a, b) => Buffer.byteLength(b.question) - Buffer.byteLength(a.question) || a.id.localeCompare(b.id)).slice(0, 5);
    for (const q of questions) {
      const c = evidenceRankingConfig().scope;
      const tokens = await provider.countEvidenceScopeTokens!({ question: q.question }, evidenceScopeCtx(AbortSignal.timeout(10_000), 10_000));
      counts.push({ stage: 'scope', configuration: 'scope.e3', request: q.id, tokens, limit: c.caps.input });
      if (tokens > c.caps.input) throw new EvaluationError('Free scope count exceeds the frozen server cap');
    }
    const allocation = await TaskAllocation.open(settings, 'data/work/task24/ab-preflight');
    let ledger;
    try {
      await allocation.assertBlock('selection', Math.round(coreWorstCaseUsd * 1e6));
      ledger = { total: await allocationTotals(allocation.db), selection: await allocationTotals(allocation.db, 'selection') };
    } finally { await allocation.close(); }
    const files = execFileSync('git', ['ls-files', '-z', '--', 'server', 'shared', 'worker', 'evals/search-quality', 'evals/retrieval/coded',
      'evals/retrieval/experiments/stats.ts', 'evals/retrieval/generation.ts', 'evals/retrieval/narrative',
      'pnpm-lock.yaml', 'package.json', 'tests/unit/task24-ab.test.ts', 'tests/unit/task24-production-port.test.ts'], { encoding: 'utf8' })
      .split('\0').filter(Boolean).filter(p => p !== AB_MANIFEST_PATH);
    const manifest: ABManifest = { version: 'task24-ab-freeze-v1', frozenAt: new Date().toISOString(),
      codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), serverCommit: values['server-commit'],
      protocolSha256: sha(readFileSync(values.protocol)), fieldDesignSha256: sha(readFileSync(values['field-design'])),
      files: Object.fromEntries(files.map(p => [p, fileSha(p)])), arms, target: target.identity, coreWorstCaseUsd,
      seeds: { order: 2026102502, bootstrap: 2026102503, resamples: 10000, samples: 3 }, modelPreflight: { paidCalls: 0, counts, ledger },
      gateStatus: 'pending-controller-review' };
    writeFileSync(AB_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    const frozen = readABManifest();
    console.log(JSON.stringify({ paidCalls: 0, frozen: frozen.hash, coreWorstCaseUsd, serverCommit: manifest.serverCommit, counts: counts.length }));
  } finally { await es.close(); await closeDb(db); }
}
main().catch(e => { console.error(e instanceof EvaluationError ? e.message : 'Free A/B freeze failed; exception details suppressed.'); process.exitCode = 1; });
