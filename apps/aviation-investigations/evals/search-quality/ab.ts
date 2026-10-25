/** A/B CLI: dry by default; paid calls require a separately reviewed controller/gate certificate. */
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { evaluationSettings } from './config.js';
import { TaskAllocation, allocationTotals, EvaluationError } from './money.js';
import { readABManifest, requireRankingGate } from './ab-manifest.js';
import { verifyRankingTarget } from './ab-target.js';
import { productionPort } from './ab-production.js';
import { runSelection, runConfirmation, type BlockAdmission } from './ab-run.js';

export async function main() {
  const { values } = parseArgs({ options: { phase: { type: 'string' }, 'env-files': { type: 'string' }, 'keys-file': { type: 'string' },
    'out-dir': { type: 'string' }, 'selection-file': { type: 'string' }, 'gate-certificate': { type: 'string' }, 'gate-report': { type: 'string' },
    'confirm-cost': { type: 'boolean' } } });
  const { manifest, hash } = readABManifest();
  if (!values['confirm-cost']) {
    console.log(JSON.stringify({ paid: false, manifestSha256: hash, coreSearches: 378,
      coreWorstCaseUsd: manifest.coreWorstCaseUsd, confirmationSearchesIfQualified: 288, gate: 'required-before-payment' })); return;
  }
  requireRankingGate(values['gate-certificate'], values['gate-report'], manifest, hash);
  const phase = values.phase;
  if (phase !== 'selection' && phase !== 'confirmation' || !values['env-files']) throw new EvaluationError('Explicit A/B phase and development files required');
  if (phase === 'confirmation' && !values['selection-file']) throw new EvaluationError('Frozen selection required');
  const settings = evaluationSettings(values['env-files'], values['keys-file'], true);
  if (!settings.config.databaseUrl || !settings.config.ai.anthropic.apiKey || !settings.config.ai.openai.apiKey
    || settings.config.ai.anthropic.scopeModel !== 'claude-haiku-5-5'
    || settings.config.ai.openai.embeddingModel !== 'text-embedding-3-small' || settings.config.ai.openai.embeddingDimensions !== 1536) throw new EvaluationError('Frozen A/B provider configuration unavailable');
  const db = createDb(settings.config.databaseUrl, { max: 3, applicationName: 'aircase-task24-ranking-read' });
  const es = createEsClient(settings.config.elasticsearch, 'read');
  const directory = resolve(values['out-dir'] ?? `data/work/task24/${phase}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let allocation: TaskAllocation | undefined;
  try {
    const target = await verifyRankingTarget(db, es);
    if (JSON.stringify(target.identity) !== JSON.stringify(manifest.target)) throw new EvaluationError('Frozen target or coded membership changed');
    const start = { manifestSha256: hash, phase }, startPath = join(directory, 'start.json');
    if (existsSync(startPath)) {
      if (JSON.stringify(JSON.parse(readFileSync(startPath, 'utf8'))) !== JSON.stringify(start)) throw new EvaluationError('A/B resume identity changed');
    } else writeFileSync(startPath, JSON.stringify(start) + '\n', { flag: 'wx', mode: 0o600 });
    allocation = await TaskAllocation.open(settings, directory);
    const current = allocation;
    const admission: BlockAdmission = { assertBlock: amount => current.assertBlock(phase, amount),
      async canFit(amount) {
        try { await current.assertBlock(phase, amount); return true; }
        catch (e) {
          if (e instanceof EvaluationError && /cap would be exceeded|allowance cannot cover the complete block/.test(e.message)) return false;
          throw e;
        }
      } };
    const port = productionPort(settings, db, es, target.pinned, allocation, phase, hash, directory, manifest.arms);
    if (phase === 'selection') await runSelection(directory, target.selection, manifest.arms, port, admission, hash);
    else await runConfirmation(directory, values['selection-file']!, target.fresh.questions, manifest.arms, port, admission, hash);
    console.log(JSON.stringify({ phase, completed: true, ledger: await allocationTotals(allocation.db, phase) }));
  } finally {
    try { if (allocation) await allocation.close(); }
    finally { await es.close(); await closeDb(db); }
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch(e => { console.error(e instanceof EvaluationError ? e.message : 'A/B run stopped; raw exception details suppressed.'); process.exitCode = 1; });
}
