/**
 * Task 29: what a visitor gets after one click on "Apply these filters" (README.md).
 *
 * `preflight` is free: the dev target, the Track C dev labels re-derived on the active generation,
 * the ranking identities, the worst-case size and the allowance. `run --confirm-cost` runs the
 * schedule through the production `rankEvidence` and spend gate, one search at a time, every
 * attempt journaled before dispatch. Only the question and the AI's own suggestion reach the
 * pipeline; the answer key's filters are read after the run, for the match report only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Client } from '@elastic/elasticsearch';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { DatasetResolver } from '../../server/dataset.js';
import { readIndexMeta } from '../../server/search/index-meta.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { evidenceReservation } from '../../server/evidence/pricing.js';
import type { LexicalSource } from '../../server/evidence/pipeline.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { loadCodedCorpus } from '../retrieval/coded/build-coded.js';
import { CodedDatasetSchema, indexCorpus, deriveQuestion, NARROW_MAX } from '../retrieval/coded/coded.js';
import { evaluationSettings } from '../search-quality/config.js';
import { productionPort } from '../search-quality/ab-production.js';
import { appendDurable, EvaluationError } from '../search-quality/money.js';
import { fileSha } from '../search-quality/frozen.js';
import { ARM_IDS, type Arm, type ArmIdentity, type RankingQuestion, type SearchObservation, type SearchRequest } from '../search-quality/ab-types.js';
import { CappedAllocation, taskTotals, type TaskSpec } from '../langfuse/money.js';
import { opaqueId, sha256, stable } from '../langfuse/data.js';
import { ROWS, SAMPLES, applyFiltersRequest, compareNarrowR20, filterMatch, questionWorstCaseMicros, rowScores, type Row, type RowRanking } from './plan.js';

export const TASK29: TaskSpec = { allocation: 'eval-task29', lockKey: 732900029, capMicros: 600_000, label: 'Task 29',
  probeStage: 'task29_preflight', applicationName: 'aircase-task29-evaluation' };
const DATASET = 'evals/retrieval/coded/dataset.json';
const DATASET_SHA256 = '5d1746bd04af8602c18babf2ae6cca6b3e1fd2760f6d72852df86ba240b8b3a4';
const CONFIG_ARMS = ['Q0', 'QH50'] as const;

interface Started { event: 'started'; key: string; row: Row; questionId: string; sample: number; at: string }
interface Recorded { event: 'result'; key: string; row: Row; questionId: string; sample: number; observation: SearchObservation }

export function readJournal(path: string): Map<string, Recorded> {
  if (!existsSync(path)) return new Map();
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Started | Recorded);
  const started = rows.filter((r): r is Started => r.event === 'started'), results = rows.filter((r): r is Recorded => r.event === 'result');
  if (new Set(started.map(r => r.key)).size !== started.length || new Set(results.map(r => r.key)).size !== results.length
    || started.length !== results.length || started.some(s => !results.some(r => r.key === s.key))) {
    throw new EvaluationError('An attempt has no durable result or is repeated; reconcile without repeating providers');
  }
  return new Map(results.map(r => [r.key, r]));
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

/** The active dev generation and the 21 Track C dev questions with labels re-derived on it (read-only). */
export async function verifyTarget(db: Db, es: Client) {
  if (fileSha(DATASET) !== DATASET_SHA256) throw new EvaluationError('Track C dataset changed');
  const dataset = CodedDatasetSchema.parse(JSON.parse(readFileSync(DATASET, 'utf8')));
  const dev = dataset.questions.filter(q => q.split === 'dev');
  if (dev.length !== 21) throw new EvaluationError('Unexpected Track C dev membership');
  const pinned = await new DatasetResolver(db, es, { embedding: { model: 'text-embedding-3-small', dims: 1536 }, manifestTtlMs: 0 }).current();
  if (!pinned.passages?.servable || !pinned.manifest.passagesIndex) throw new EvaluationError('Development evidence indices unavailable');
  const client = await db.$client.connect();
  let loaded;
  try {
    if ((await client.query('select current_database() as name')).rows[0]?.name !== 'aviation_dev') throw new EvaluationError('Wrong target database');
    loaded = await loadCodedCorpus(client, pinned.manifest.generationId);
  } finally { client.release(); }
  const index = indexCorpus(loaded.corpus);
  const questions: RankingQuestion[] = [], changes: { id: string; class: string; frozen: number; now: number; added: number; removed: number }[] = [];
  for (const q of dev) {
    const relevant = deriveQuestion(index, q).relevant;
    const frozen = new Set(q.relevant), now = new Set(relevant);
    // Narrow questions are gated on 1 to 20 coded cases, broad ones on more; a generation may not move one across.
    if (q.class === 'narrow' ? relevant.length < 1 || relevant.length > NARROW_MAX : relevant.length <= NARROW_MAX) throw new EvaluationError(`Label class changed on this generation: ${q.id}`);
    questions.push({ id: q.id, question: q.question, group: q.group, class: q.class, area: q.area, relevant });
    changes.push({ id: q.id, class: q.class, frozen: frozen.size, now: now.size,
      added: relevant.filter(n => !frozen.has(n)).length, removed: q.relevant.filter(n => !now.has(n)).length });
  }
  const cases = await readIndexMeta(es, pinned.manifest.casesIndex, { timeoutMs: 5_000 });
  const passages = await readIndexMeta(es, pinned.manifest.passagesIndex, { timeoutMs: 5_000 });
  if (!cases.fingerprint || !passages.fingerprint || cases.generationId !== loaded.source.generationId || passages.generationId !== loaded.source.generationId) throw new EvaluationError('Unpinned index identity');
  const keyFilters = Object.fromEntries(dev.map(q => [q.id, q.filters as BriefFilters]));
  return { pinned, questions, changes, keyFilters, identity: { source: loaded.source, cases, passages, dataset: pinned.dataset,
    indexVersion: pinned.indexVersion, fieldNormalizationVersion: pinned.fieldNormalizationVersion, eligibleCases: loaded.corpus.cases.length } };
}

function armIdentities(): Record<Arm, ArmIdentity> {
  const arms = JSON.parse(readFileSync('evals/search-quality/frozen/ab-manifest.json', 'utf8')).arms as Record<Arm, ArmIdentity>;
  for (const arm of CONFIG_ARMS) {
    const c = evidenceRankingConfig(ARM_IDS[arm]);
    if (evidenceRankingIdentity(c).sha256 !== arms[arm].sha256
      || evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c).reservationUsd !== arms[arm].reservationUsd) throw new EvaluationError('Registered ranking identity or reservation changed');
  }
  return arms;
}

function summarize(questions: readonly RankingQuestion[], journal: Map<string, Recorded>, keyFilters: Record<string, BriefFilters>) {
  const recorded = [...journal.values()];
  const rankings: RowRanking[] = [];
  for (const q of questions) {
    const of = (row: Row, sample: number) => recorded.find(r => r.row === row && r.questionId === q.id && r.sample === sample);
    const q0 = of('Q0', 1);
    if (!q0) throw new EvaluationError(`Incomplete schedule: ${q.id}`);
    rankings.push({ row: 'Q0', questionId: q.id, sample: 1, ranking: q0.observation.ranking });
    for (const sample of SAMPLES) {
      const live = of('QH50', sample);
      if (!live) throw new EvaluationError(`Incomplete schedule: ${q.id}`);
      rankings.push({ row: 'QH50', questionId: q.id, sample, ranking: live.observation.ranking });
      // No button means the visitor keeps the search they have.
      const edit = of('QH50+F', sample), plain = of('Q0+F', sample);
      rankings.push({ row: 'QH50+F', questionId: q.id, sample, ranking: (edit ?? live).observation.ranking });
      rankings.push({ row: 'Q0+F', questionId: q.id, sample, ranking: (plain ?? q0).observation.ranking });
    }
  }
  const scores = Object.fromEntries(ROWS.map(row => [row, rowScores(questions, rankings, row)])) as Record<Row, ReturnType<typeof rowScores>>;
  const lives = recorded.filter(r => r.row === 'QH50');
  const offered = lives.map(r => ({ id: r.questionId, kind: questions.find(q => q.id === r.questionId)!.class,
    match: filterMatch(r.observation.failure ? null : applyFiltersRequest(r.observation.lexicalSource as LexicalSource, r.observation.addedTerms ?? null, r.observation.suggestion ?? null), keyFilters[r.questionId]!) }));
  const count = (kind: string) => Object.fromEntries(['exact', 'includes', 'other', 'none'].map(m => [m, offered.filter(o => o.kind === kind && o.match === m).length]));
  const by = (row: Row) => recorded.filter(r => r.row === row);
  const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map(k => [k, xs.filter(x => x === k).length]));
  return {
    rows: Object.fromEntries(ROWS.map(row => [row, { narrowR20: scores[row].narrowR20, narrowR10: scores[row].narrowR10,
      broadP10: scores[row].broadP10, broadNdcg10: scores[row].broadNdcg10, searches: by(row).length,
      usd: by(row).reduce((s, r) => s + r.observation.actualUsd, 0),
      scopeOutcomes: tally(by(row).map(r => r.observation.scopeOutcome)), rerankOutcomes: tally(by(row).map(r => r.observation.rerankOutcome)) }])),
    perQuestion: Object.fromEntries(ROWS.map(row => [row, scores[row].questions])),
    narrowR20Differences: { 'QH50 - Q0': compareNarrowR20(scores.Q0, scores.QH50), 'QH50+F - QH50': compareNarrowR20(scores.QH50, scores['QH50+F']),
      'QH50+F - Q0': compareNarrowR20(scores.Q0, scores['QH50+F']), 'QH50+F - Q0+F': compareNarrowR20(scores['Q0+F'], scores['QH50+F']) },
    suggestedFilters: { narrow: count('narrow'), broad: count('broad') },
  };
}

export async function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'preflight' }, 'env-files': { type: 'string', default: '.env.local' },
    'keys-file': { type: 'string' }, 'out-dir': { type: 'string', default: 'data/work/task29' }, 'run-label': { type: 'string' },
    'confirm-cost': { type: 'boolean', default: false } } });
  if (!['preflight', 'run'].includes(values.mode!) || !/^[a-zA-Z0-9-]{1,40}$/.test(values['run-label'] ?? '')) throw new EvaluationError('Invalid mode or run label (--run-label required)');
  if (values.mode === 'run' && !values['confirm-cost']) throw new EvaluationError('Paid run requires --confirm-cost');
  const label = values['run-label']!, directory = resolve(values['out-dir']!);
  const codeCommit = codeIdentity();
  const settings = evaluationSettings(values['env-files']!, values['keys-file'], true);
  if (!settings.config.databaseUrl || !settings.config.ai.anthropic.apiKey || !settings.config.ai.openai.apiKey
    || settings.config.ai.anthropic.scopeModel !== 'claude-haiku-5-5' || settings.config.ai.openai.embeddingModel !== 'text-embedding-3-small'
    || settings.config.ai.openai.embeddingDimensions !== 1536 || settings.config.elasticsearch.indexPrefix !== 'ai-aviation-dev') throw new EvaluationError('Expected development provider and index configuration required');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = createDb(settings.config.databaseUrl, { max: 3, applicationName: 'aircase-task29-ranking-read' });
  const es = createEsClient(settings.config.elasticsearch, 'read');
  let allocation: CappedAllocation | undefined;
  try {
    const target = await verifyTarget(db, es);
    const arms = armIdentities();
    const configs = { Q0: evidenceRankingConfig(ARM_IDS.Q0), QH50: evidenceRankingConfig(ARM_IDS.QH50) };
    const perQuestion = questionWorstCaseMicros(configs.Q0, configs.QH50);
    const prior = existsSync(join(directory, 'manifest.json')) ? JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) : undefined;
    const manifest = { version: 'task29-applied-filters-v1', codeCommit, startedAt: prior?.startedAt ?? new Date().toISOString(), label,
      task: TASK29, target: target.identity, datasetSha256: DATASET_SHA256,
      goldSha256: sha256(stable(target.questions.map(q => ({ id: q.id, class: q.class, relevant: q.relevant })))),
      questions: target.questions.map(q => q.id), configurations: CONFIG_ARMS.map(a => arms[a]), rows: ROWS, samples: SAMPLES.length,
      automaticFilters: 'none', worstCaseMicrosPerQuestion: perQuestion };
    const hash = sha256(stable(manifest));
    console.log(JSON.stringify({ event: 'preflight', generation: target.identity.source.generationId, revision: target.identity.dataset.revision,
      eligibleCases: target.identity.eligibleCases, labelChanges: target.changes.filter(c => c.added || c.removed),
      worstCaseMicros: perQuestion * target.questions.length, capMicros: TASK29.capMicros, manifestSha256: hash }));
    allocation = await CappedAllocation.open(settings, directory, TASK29);
    // The first question's block must fit before anything is frozen; every later one is checked again before it starts.
    await allocation.assertBlock(perQuestion);
    console.log(JSON.stringify({ event: 'allowance', task: await taskTotals(allocation.db, TASK29), firstBlockMicros: perQuestion }));
    if (values.mode === 'preflight') return;

    freezeFile(join(directory, 'manifest.json'), manifest);
    const journalPath = join(directory, 'results.jsonl');
    const keyOf = (q: RankingQuestion, row: Row, sample: number) => opaqueId('task29', label, q.id, row, String(sample));
    const journal = readJournal(journalPath);
    const port = productionPort(settings, db, es, target.pinned, allocation, 'selection', hash, directory, arms);
    const search = async (row: Row, configArm: 'Q0' | 'QH50', q: RankingQuestion, sample: 1 | 2 | 3, request: SearchRequest) => {
      const key = keyOf(q, row, sample);
      let observation = journal.get(key)?.observation;
      if (!observation) {
        appendDurable(journalPath, { event: 'started', key, row, questionId: q.id, sample, at: new Date().toISOString() } satisfies Started);
        observation = await port.run({ key, questionId: q.id, arm: configArm, sample }, q, request);
        const recorded: Recorded = { event: 'result', key, row, questionId: q.id, sample, observation };
        appendDurable(journalPath, recorded); journal.set(key, recorded);
        console.log(JSON.stringify({ event: 'search', row, questionId: q.id, sample, chargedMicros: Math.round(observation.actualUsd * 1e6),
          scope: observation.scopeOutcome, rerank: observation.rerankOutcome, failure: observation.failure, cases: observation.ranking.length }));
      }
      // A failed search is never scored or repeated under this label, including on resume.
      if (observation.failure || observation.safetyFaults.length) throw new EvaluationError(`Search failed (${observation.failure ?? observation.safetyFaults.join(',')}); stop and inspect the journal`);
      return observation;
    };
    for (const q of target.questions) {
      // A question starts only when its whole worst case fits; the gate still checks every stage.
      if (!journal.has(keyOf(q, 'Q0', 1)) || SAMPLES.some(s => !journal.has(keyOf(q, 'QH50', s)))) await allocation.assertBlock(perQuestion);
      const q0 = await search('Q0', 'Q0', q, 1, { filters: {}, skipScope: true });
      for (const sample of SAMPLES) {
        const live = await search('QH50', 'QH50', q, sample, { filters: {} });
        const filters = applyFiltersRequest(live.lexicalSource as LexicalSource, live.addedTerms ?? null, live.suggestion ?? null);
        if (!filters) continue;
        await search('QH50+F', 'QH50', q, sample, { filters, edited: { executed: live.executed!, lexicalSource: live.lexicalSource as LexicalSource, addedTerms: live.addedTerms ?? null } });
        await search('Q0+F', 'Q0', q, sample, { filters, edited: { executed: q0.executed!, lexicalSource: q0.lexicalSource as LexicalSource, addedTerms: q0.addedTerms ?? null } });
      }
    }
    const closing = allocation; allocation = undefined;
    const ledger = await closing.close();
    const summary = { manifestSha256: hash, ledger, labelChanges: target.changes, ...summarize(target.questions, journal, target.keyFilters) };
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    for (const row of ROWS) {
      const r = summary.rows[row]!;
      console.log(`${row.padEnd(7)} narrow R@20 ${pct(r.narrowR20).padStart(6)}  R@10 ${pct(r.narrowR10).padStart(6)}  broad P@10 ${pct(r.broadP10).padStart(6)}  nDCG@10 ${pct(r.broadNdcg10).padStart(6)}  searches ${String(r.searches).padStart(3)}  $${r.usd.toFixed(4)}`);
    }
    console.log(JSON.stringify({ event: 'complete', ledger, differences: summary.narrowR20Differences, suggestedFilters: summary.suggestedFilters }));
  } finally {
    try { if (allocation) await allocation.close(); }
    finally { await es.close(); await closeDb(db); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e instanceof EvaluationError ? e.message : 'Evaluation stopped; raw exception details suppressed. Inspect the durable journal.'); process.exitCode = 1;
});
