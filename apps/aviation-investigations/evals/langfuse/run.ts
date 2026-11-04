import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { loadConfig } from '../../shared/config.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { evidenceReservation } from '../../server/evidence/pricing.js';
import { toMicros } from '../../server/quota/pacing.js';
import { evaluationSettings } from '../search-quality/config.js';
import { verifyRankingTarget } from '../search-quality/ab-target.js';
import { productionPort } from '../search-quality/ab-production.js';
import { appendDurable, EvaluationError } from '../search-quality/money.js';
import { ARM_IDS, type Arm, type ArmIdentity, type SearchObservation, type RankingQuestion } from '../search-quality/ab-types.js';
import { EVALUATOR_VERSION, TASK_CAP_MICROS, datasetItem, loadDatasets, itemScores, meanScores, opaqueId, sha256, stable,
  type EvaluationDataset, type ScoreName } from './data.js';
import { LangfuseApi, LangfuseError, cursorRows, syncDataset, syncScoreConfigs, publishScores, scorePayload } from './api.js';
import { Task25Allocation, taskTotals } from './money.js';
import { experimentTracing, type TraceIdentity, type ExperimentContext } from './tracing.js';

const ARMS = ['Q0', 'QH50'] as const;
interface Recorded extends TraceIdentity { event: 'result'; key: string; dataset: string; experimentId: string; timestamp: string; observation: SearchObservation }
export function readResults(path: string): Recorded[] {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const started = rows.filter(r => r.event === 'started'), results = rows.filter(r => r.event === 'result') as Recorded[];
  if (new Set(started.map(r => r.key)).size !== started.length || new Set(results.map(r => r.key)).size !== results.length
    || started.length !== results.length || started.some(s => !results.some(r => r.key === s.key && r.traceId === s.traceId && r.observationId === s.observationId))) {
    throw new EvaluationError('An attempt has no durable result or is repeated; reconcile without repeating providers');
  }
  return results;
}
function freezeFile(path: string, value: unknown) {
  if (existsSync(path)) {
    if (stable(JSON.parse(readFileSync(path, 'utf8'))) !== stable(value)) throw new EvaluationError('Evaluation resume identity changed');
  } else writeFileSync(path, stable(value) + '\n', { flag: 'wx', mode: 0o600 });
}
function codeIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (dirty) throw new EvaluationError('Commit the reviewed evaluator before preparation or paid calls');
  return commit;
}
export async function waitFor(check: () => Promise<boolean>, label: string, ms = 120_000) {
  const end = Date.now() + ms;
  do { if (await check()) return; await delay(2000); } while (Date.now() < end);
  throw new LangfuseError(`${label} is incomplete; never repeat inference to repair an upload`);
}
export async function verifyTrace(api: LangfuseApi, row: TraceIdentity) {
  const observations = await cursorRows(api, `/api/public/v2/observations?traceId=${row.traceId}&fields=core,basic,io,metadata,model,usage,trace_context`);
  if (!observations.some(o => o.id === row.observationId && o.name === 'evidence.request')) return false;
  for (const o of observations) {
    if (o.input != null || o.output != null || o.statusMessage) throw new LangfuseError('Unexpected content in evaluation trace');
    if (o.environment !== 'dev') throw new LangfuseError('Unexpected trace environment');
  }
  return true;
}
async function publish(api: LangfuseApi, directory: string, datasets: EvaluationDataset[], configs: Record<ScoreName, string>,
  manifest: any, rows: Recorded[]) {
  const summaries: any[] = [];
  for (const dataset of datasets) for (const arm of ARMS) {
    const expected = dataset.questions.length;
    const found = rows.filter(r => r.dataset === dataset.name && r.observation.arm === arm);
    if (!found.length) continue;
    if (found.length !== expected || new Set(found.map(r => r.observation.questionId)).size !== expected) throw new EvaluationError('Incomplete experiment; no aggregate score may be published');
    const experiment = manifest.experiments[dataset.name][arm];
    const scores = found.flatMap(row => {
      const question = dataset.questions.find(q => q.id === row.observation.questionId)!;
      return Object.entries(itemScores(question, row.observation.ranking)).map(([name, value]) =>
        scorePayload(name as ScoreName, value, configs[name as ScoreName], row.timestamp, { traceId: row.traceId, observationId: row.observationId }));
    });
    for (const row of found) await waitFor(() => verifyTrace(api, row), 'Trace export');
    await publishScores(api, scores);
    const means = meanScores(found.map(r => itemScores(dataset.questions.find(q => q.id === r.observation.questionId)!, r.observation.ranking)));
    const averages = Object.entries(means).map(([name, m]) => scorePayload(name as ScoreName, m.value,
      configs[name as ScoreName], manifest.startedAt, { datasetRunId: experiment.id }));
    await publishScores(api, averages);
    const since = encodeURIComponent(manifest.startedAt);
    let items: any[] = [], runs: any[] = [];
    await waitFor(async () => {
      items = await cursorRows(api, `/api/public/experiment-items?experimentId=${experiment.id}&fromStartTime=${since}&fields=core,dataset,scores&scoreLimit=20`);
      runs = await cursorRows(api, `/api/public/experiments?id=${experiment.id}&fromStartTime=${since}&fields=core,metadata,scores&scoreLimit=20`);
      if (items.length !== expected || runs.length !== 1 || runs[0].itemCount !== expected || runs[0].scores?.length !== 4) return false;
      for (const row of found) {
        const item = items.find(i => i.traceId === row.traceId && i.id === row.observationId);
        if (!item || item.experimentItemId !== datasetItem(dataset, dataset.questions.find(q => q.id === row.observation.questionId)!).id) return false;
        const desired = scores.filter(s => s.traceId === row.traceId);
        if (item.scores?.length !== desired.length || desired.some(s => !item.scores.some((v: any) => v.id === s.id && Math.abs(v.value - s.value) < 1e-12))) return false;
      }
      return averages.every(s => runs[0].scores.some((v: any) => v.id === s.id && Math.abs(v.value - s.value) < 1e-12));
    }, 'Experiment items and scores');
    const summary = { dataset: dataset.name, configuration: ARM_IDS[arm], experimentId: experiment.id, experimentName: experiment.name,
      searches: found.length, itemScores: scores.length, runScores: averages.length, means,
      usd: found.reduce((s, r) => s + r.observation.actualUsd, 0),
      failures: found.filter(r => r.observation.failure).length,
      rerankOutcomes: Object.fromEntries([...new Set(found.map(r => r.observation.rerankOutcome))].map(k => [k, found.filter(r => r.observation.rerankOutcome === k).length])),
      verified: true };
    summaries.push(summary);
    console.log(JSON.stringify({ event: 'experiment-verified', ...summary }));
  }
  writeFileSync(join(directory, 'verified.json'), JSON.stringify({ checkedAt: new Date().toISOString(), summaries }, null, 2) + '\n', { mode: 0o600 });
  return summaries;
}
export async function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'prepare' }, 'env-files': { type: 'string', default: '.env.local' },
    'keys-file': { type: 'string' }, 'langfuse-env': { type: 'string' }, 'out-dir': { type: 'string', default: 'data/work/task25' },
    'run-label': { type: 'string', default: new Date().toISOString().slice(0, 10) }, 'include-confirmation': { type: 'boolean', default: false } } });
  if (!['prepare', 'run', 'publish'].includes(values.mode!) || !/^[a-zA-Z0-9-]{1,40}$/.test(values['run-label']!)) throw new EvaluationError('Invalid evaluator mode or run label');
  const directory = resolve(values['out-dir']!);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const datasets = loadDatasets();
  const selected = values['include-confirmation'] ? datasets : datasets.slice(0, 1);
  const api = LangfuseApi.fromEnvironment(process.env);
  const project = await api.assertDevelopment();
  const uploaded = new Map<string, Awaited<ReturnType<typeof syncDataset>>>();
  for (const d of selected) uploaded.set(d.name, await syncDataset(api, d));
  const scoreConfigs = await syncScoreConfigs(api);
  console.log(JSON.stringify({ event: 'datasets-verified', project: project.name, datasets: selected.map(d => ({ name: d.name, items: d.questions.length, created: uploaded.get(d.name)!.createdItems })) }));
  const manifestPath = join(directory, 'manifest.json'), resultsPath = join(directory, 'results.jsonl');
  if (values.mode === 'publish') {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    await publish(api, directory, selected, scoreConfigs, manifest, readResults(resultsPath));
    return;
  }
  const codeCommit = codeIdentity();
  const settings = evaluationSettings(values['env-files']!, values['keys-file'], true);
  if (!settings.config.databaseUrl || !settings.config.ai.anthropic.apiKey || !settings.config.ai.openai.apiKey
    || settings.config.ai.anthropic.scopeModel !== 'claude-haiku-5-5' || settings.config.ai.openai.embeddingModel !== 'text-embedding-3-small'
    || settings.config.ai.openai.embeddingDimensions !== 1536 || settings.config.elasticsearch.indexPrefix !== 'ai-aviation-dev') throw new EvaluationError('Expected development provider and index configuration required');
  const tracingConfig = loadConfig({ env: { ...settings.env, AVIATION_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY } });
  const db = createDb(settings.config.databaseUrl, { max: 3, applicationName: 'aircase-task25-ranking-read' });
  const es = createEsClient(settings.config.elasticsearch, 'read');
  let allocation: Task25Allocation | undefined, tracing: ReturnType<typeof experimentTracing> | undefined;
  try {
    const target = await verifyRankingTarget(db, es);
    const arms = JSON.parse(readFileSync('evals/search-quality/frozen/ab-manifest.json', 'utf8')).arms as Record<Arm, ArmIdentity>;
    for (const arm of ARMS) if (evidenceRankingIdentity(evidenceRankingConfig(ARM_IDS[arm])).sha256 !== arms[arm].sha256
      || evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', evidenceRankingConfig(ARM_IDS[arm])).reservationUsd !== arms[arm].reservationUsd) throw new EvaluationError('Registered ranking identity or reservation changed');
    const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined;
    const manifest = { version: 'task25-langfuse-v1', codeCommit, startedAt: prior?.startedAt ?? new Date().toISOString(),
      label: values['run-label'], capMicros: TASK_CAP_MICROS, evaluatorVersion: EVALUATOR_VERSION, projectId: project.id, target: target.identity,
      configurations: ARMS.map(a => arms[a]), datasets: selected.map(d => ({ name: d.name, datasetSha256: d.datasetSha256, goldSha256: d.goldSha256, count: d.questions.length })),
      samples: 1, automaticFilters: 'none', optionalRule: 'Complete core first; include entire 96-search confirmation only if its worst-case reservations fit remaining task/category/global caps.',
      experiments: Object.fromEntries(selected.map(d => [d.name, Object.fromEntries(ARMS.map(arm => [arm, {
        id: opaqueId('task25-experiment', values['run-label']!, d.name, ARM_IDS[arm]),
        name: `${ARM_IDS[arm]}-${values['run-label']}-${d.phase === 'selection' ? 'core' : 'confirmation'}` }]))])) };
    freezeFile(manifestPath, manifest);
    const hash = sha256(stable(manifest));
    console.log(JSON.stringify({ event: 'prepared', manifestSha256: hash, codeCommit, coreSearches: 42, coreWorstCaseMicros: 21 * 11500,
      optionalSearches: values['include-confirmation'] ? 96 : 0, optionalWorstCaseMicros: 48 * 11500, capMicros: TASK_CAP_MICROS }));
    if (values.mode === 'prepare') return;
    let rows = readResults(resultsPath);
    allocation = await Task25Allocation.open(settings, directory);
    tracing = experimentTracing(tracingConfig, join(directory, 'spans.jsonl'));
    for (const d of selected) {
      const remaining = d.questions.flatMap(q => ARMS.filter(arm => !rows.some(r => r.dataset === d.name && r.observation.questionId === q.id && r.observation.arm === arm)));
      if (!remaining.length) continue;
      const reserveMicros = remaining.reduce((sum, arm) => sum + toMicros(arms[arm].reservationUsd), 0);
      try { await allocation.assertBlock(reserveMicros); }
      catch (e) {
        if (d.phase === 'confirmation' && e instanceof EvaluationError && /cap would be exceeded|allowance cannot cover/.test(e.message)) {
          appendDurable(join(directory, 'decisions.jsonl'), { event: 'optional-omitted', reason: 'complete-block-does-not-fit', reserveMicros });
          console.log(JSON.stringify({ event: 'optional-omitted', reason: 'complete-block-does-not-fit', reserveMicros })); break;
        }
        throw e;
      }
      const out = join(directory, d.phase); mkdirSync(out, { recursive: true, mode: 0o700 });
      const port = productionPort(settings, db, es, target.pinned, allocation, d.phase, hash, out, arms);
      for (const [index, q] of d.questions.entries()) for (const arm of index % 2 ? [...ARMS].reverse() : ARMS) {
        const key = opaqueId(d.name, q.id, arm, values['run-label']!);
        if (rows.some(r => r.key === key)) continue;
        const c = evidenceRankingConfig(ARM_IDS[arm]);
        const item = uploaded.get(d.name)!.items.find(i => i.id === datasetItem(d, q).id)!;
        const experiment = manifest.experiments[d.name]![arm]!;
        const meta: ExperimentContext = { experimentId: experiment.id, experimentName: experiment.name, datasetId: uploaded.get(d.name)!.id,
          itemId: item.id, ...(item.version ? { itemVersion: item.version } : {}), configuration: c.version, configurationSha256: arms[arm].sha256,
          datasetSha256: d.datasetSha256, goldSha256: d.goldSha256, codeCommit, corpusRevision: target.pinned.dataset.revision,
          scopeVersion: c.scope.version, scopeSha256: c.scope.sha256, rerankVersion: c.rerank?.prompt.version ?? 'disabled', rerankSha256: c.rerank?.prompt.sha256 ?? 'none' };
        let row!: Recorded;
        await tracing.run(meta, async identity => {
          const timestamp = new Date().toISOString();
          appendDurable(resultsPath, { event: 'started', key, ...identity, timestamp });
          const observation = await port.run({ key, questionId: q.id, arm, sample: 1 }, q);
          row = { event: 'result', key, dataset: d.name, experimentId: experiment.id, timestamp, ...identity, observation };
          appendDurable(resultsPath, row);
          if (observation.safetyFaults.length || ['spend', 'unexpected'].includes(observation.failure ?? '')) throw new EvaluationError('Ranking or accounting integrity failure; stop');
        });
        rows.push(row);
        console.log(JSON.stringify({ event: 'search-completed', dataset: d.name, configuration: c.version, completed: rows.length,
          chargedMicros: toMicros(row.observation.actualUsd), failure: row.observation.failure, rerank: row.observation.rerankOutcome }));
        if (rows.filter(r => r.dataset === d.name && r.observation.arm === arm).length === 1) await waitFor(() => verifyTrace(api, row), 'First experiment trace');
      }
    }
    await tracing.handle.shutdown(); tracing = undefined;
    const ledger = await taskTotals(allocation.db);
    const summaries = await publish(api, directory, selected, scoreConfigs, manifest, rows);
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ manifestSha256: hash, ledger, summaries }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ event: 'complete', ledger, searches: rows.length }));
  } finally {
    try { await tracing?.handle.shutdown(); if (allocation) await allocation.close(); }
    finally { await es.close(); await closeDb(db); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e instanceof EvaluationError || e instanceof LangfuseError ? e.message : 'Evaluation stopped; raw exception details suppressed. Inspect the durable journal.'); process.exitCode = 1;
});
