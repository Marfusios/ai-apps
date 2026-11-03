/**
 * Task 29: what a visitor gets after one click on "Apply these filters" (README.md).
 *
 * `preflight` is free: the dev target, both question sets' coded labels re-derived on the active
 * generation, the ranking identities, the worst-case size and the allowance. `run --confirm-cost`
 * runs the schedule through the production `rankEvidence` and spend gate, one search at a time,
 * every attempt journaled before dispatch. Only the question and the AI's own suggestion reach the
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
import { DatasetResolver, type PinnedDataset } from '../../server/dataset.js';
import { getActiveManifest } from '../../server/db/generations.js';
import { readIndexMeta } from '../../server/search/index-meta.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { evidenceReservation } from '../../server/evidence/pricing.js';
import type { LexicalSource } from '../../server/evidence/pipeline.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { loadCodedCorpus } from '../retrieval/coded/build-coded.js';
import { CodedDatasetSchema, CodedQuestionSpecSchema, indexCorpus, deriveQuestion, NARROW_MAX, type CorpusIndex } from '../retrieval/coded/coded.js';
import { evaluationSettings } from '../search-quality/config.js';
import { filterIdentity, productionPort } from '../search-quality/ab-production.js';
import { codedMetrics } from '../search-quality/ab-score.js';
import { appendDurable, EvaluationError } from '../search-quality/money.js';
import { fileSha, FROZEN_DIR } from '../search-quality/frozen.js';
import { ARM_IDS, type Arm, type ArmIdentity, type RankingQuestion, type SearchObservation, type SearchRequest } from '../search-quality/ab-types.js';
import type { ABDataset } from '../search-quality/types.js';
import { CappedAllocation, taskTotals, type TaskSpec } from '../langfuse/money.js';
import { opaqueId, sha256, stable } from '../langfuse/data.js';
import { ROWS, applyFiltersRequest, compareNarrowR20, crossGroupShares, fallbackRates, filterMatch, nextStreak,
  questionWorstCaseMicros, rowScores, stageMicros, type Row, type RowRanking, type Sample } from './plan.js';

export const TASK29: TaskSpec = { allocation: 'eval-task29', lockKey: 732900029, capMicros: 800_000, label: 'Task 29',
  probeStage: 'task29_preflight', applicationName: 'aircase-task29-evaluation' };
const TRACK_C = 'evals/retrieval/coded/dataset.json';
const TRACK_C_SHA256 = '5d1746bd04af8602c18babf2ae6cca6b3e1fd2760f6d72852df86ba240b8b3a4';
const CONFIRMATION = `${FROZEN_DIR}/confirmation.json`;
const CONFIG_ARMS = ['Q0', 'QH50'] as const;
/** The 21 Track C dev questions (the set that chose the reranker) three times; Task 24's 48 fresh confirmation questions once. */
export const SETS = [
  { name: 'trackc-dev', samples: [1, 2, 3] as readonly Sample[], count: 21 },
  { name: 'confirmation', samples: [1] as readonly Sample[], count: 48 },
] as const;
export type SetName = typeof SETS[number]['name'];
interface LabelChange { id: string; class: string; frozen: number; now: number; added: number; removed: number }
export interface QuestionSet { name: SetName; samples: readonly Sample[]; questions: RankingQuestion[]; keyFilters: Record<string, BriefFilters>;
  changes: LabelChange[]; sourceFileSha256: string; goldSha256: string; crossGroupShares: number }

interface Started { event: 'started'; key: string; set: SetName; row: Row; questionId: string; sample: number; at: string }
interface Recorded { event: 'result'; key: string; set: SetName; row: Row; questionId: string; sample: number; observation: SearchObservation }

/** Every attempt's durable result by key; refuses an attempt without one, or a repeated one (Task 30 reuses it with its own records). */
export function readJournal<R extends { event: 'result'; key: string } = Recorded>(path: string): Map<string, R> {
  if (!existsSync(path)) return new Map();
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { event: 'started'; key: string } | R);
  const started = rows.filter(r => r.event === 'started'), results = rows.filter((r): r is R => r.event === 'result');
  if (new Set(started.map(r => r.key)).size !== started.length || new Set(results.map(r => r.key)).size !== results.length
    || started.length !== results.length || started.some(s => !results.some(r => r.key === s.key))) {
    throw new EvaluationError('An attempt has no durable result or is repeated; reconcile without repeating providers');
  }
  return new Map(results.map(r => [r.key, r]));
}
export function freezeFile(path: string, value: unknown) {
  if (existsSync(path)) {
    if (stable(JSON.parse(readFileSync(path, 'utf8'))) !== stable(value)) throw new EvaluationError('Evaluation resume identity changed');
  } else writeFileSync(path, stable(value) + '\n', { flag: 'wx', mode: 0o600 });
}
export function codeIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (dirty) throw new EvaluationError('Commit the reviewed evaluator before preparation or paid calls');
  return commit;
}

/** One set's questions with labels re-derived on the snapshot; the class guard keeps narrow at 1 to 20 cases and broad above. */
function deriveSet(name: SetName, samples: readonly Sample[], sourceFileSha256: string, index: CorpusIndex,
  items: readonly { id: string; question: string; group: string; class: 'narrow' | 'broad'; area: string; relevant: string[]; filters: unknown; codeSet: unknown }[]): QuestionSet {
  const questions: RankingQuestion[] = [], changes: LabelChange[] = [], keyFilters: Record<string, BriefFilters> = {};
  for (const q of items) {
    const spec = CodedQuestionSpecSchema.parse({ id: q.id, question: q.question, area: q.area, class: q.class, filters: q.filters,
      codeSet: q.codeSet, wording: ['coded predicate'], note: 'Task 29 label re-derivation.' });
    const relevant = deriveQuestion(index, spec).relevant;
    if (q.class === 'narrow' ? relevant.length < 1 || relevant.length > NARROW_MAX : relevant.length <= NARROW_MAX) throw new EvaluationError(`Label class changed on this generation: ${q.id}`);
    const frozen = new Set(q.relevant), now = new Set(relevant);
    questions.push({ id: q.id, question: q.question, group: q.group, class: q.class, area: q.area, relevant });
    keyFilters[q.id] = spec.filters as BriefFilters;
    changes.push({ id: q.id, class: q.class, frozen: frozen.size, now: now.size,
      added: relevant.filter(n => !frozen.has(n)).length, removed: q.relevant.filter(n => !now.has(n)).length });
  }
  return { name, samples, questions, keyFilters, changes, sourceFileSha256, crossGroupShares: crossGroupShares(questions),
    goldSha256: sha256(stable(questions.map(q => ({ id: q.id, class: q.class, relevant: q.relevant })))) };
}

/** The active dev generation and both question sets with labels re-derived on it (read-only). */
export async function verifyTarget(db: Db, es: Client) {
  if (fileSha(TRACK_C) !== TRACK_C_SHA256) throw new EvaluationError('Track C dataset changed');
  const confirmationSha = JSON.parse(readFileSync(`${FROZEN_DIR}/ab-manifest.json`, 'utf8')).files[CONFIRMATION] as string;
  if (fileSha(CONFIRMATION) !== confirmationSha) throw new EvaluationError('Task 24 confirmation set changed');
  const trackC = CodedDatasetSchema.parse(JSON.parse(readFileSync(TRACK_C, 'utf8'))).questions.filter(q => q.split === 'dev');
  const confirmation = (JSON.parse(readFileSync(CONFIRMATION, 'utf8')) as ABDataset).questions;
  for (const [set, items] of [[SETS[0], trackC], [SETS[1], confirmation]] as const) {
    if (items.length !== set.count || new Set(items.map(q => q.id)).size !== set.count) throw new EvaluationError(`Unexpected ${set.name} membership`);
  }
  const pinned = await new DatasetResolver(db, es, { embedding: { model: 'text-embedding-3-small', dims: 1536 }, manifestTtlMs: 0 }).current();
  if (!pinned.passages?.servable || !pinned.manifest.passagesIndex) throw new EvaluationError('Development evidence indices unavailable');
  const client = await db.$client.connect();
  let loaded;
  try {
    if ((await client.query('select current_database() as name')).rows[0]?.name !== 'aviation_dev') throw new EvaluationError('Wrong target database');
    loaded = await loadCodedCorpus(client, pinned.manifest.generationId);
  } finally { client.release(); }
  const index = indexCorpus(loaded.corpus);
  const sets = [deriveSet('trackc-dev', SETS[0].samples, TRACK_C_SHA256, index, trackC),
    deriveSet('confirmation', SETS[1].samples, confirmationSha, index, confirmation)];
  const cases = await readIndexMeta(es, pinned.manifest.casesIndex, { timeoutMs: 5_000 });
  const passages = await readIndexMeta(es, pinned.manifest.passagesIndex, { timeoutMs: 5_000 });
  if (!cases.fingerprint || !passages.fingerprint || cases.generationId !== loaded.source.generationId || passages.generationId !== loaded.source.generationId) throw new EvaluationError('Unpinned index identity');
  // Aircraft filters reach multi-aircraft events only through passages-v2's event qualification, which the labels assume.
  if (passages.indexVersion !== 'passages-v2') throw new EvaluationError('Development passages index is not passages-v2');
  return { pinned, sets, identity: { source: loaded.source, cases, passages, dataset: pinned.dataset,
    indexVersion: pinned.indexVersion, fieldNormalizationVersion: pinned.fieldNormalizationVersion, eligibleCases: loaded.corpus.cases.length } };
}

function armIdentities(): Record<Arm, ArmIdentity> {
  const arms = JSON.parse(readFileSync(`${FROZEN_DIR}/ab-manifest.json`, 'utf8')).arms as Record<Arm, ArmIdentity>;
  for (const arm of CONFIG_ARMS) {
    const c = evidenceRankingConfig(ARM_IDS[arm]);
    if (evidenceRankingIdentity(c).sha256 !== arms[arm].sha256
      || evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c).reservationUsd !== arms[arm].reservationUsd) throw new EvaluationError('Registered ranking identity or reservation changed');
  }
  return arms;
}

const editRequest = (filters: BriefFilters, parent: SearchObservation): SearchRequest =>
  ({ filters, edited: { executed: parent.executed!, lexicalSource: parent.lexicalSource as LexicalSource, addedTerms: parent.addedTerms ?? null } });
const buttonFilters = (live: SearchObservation) => applyFiltersRequest(live.lexicalSource as LexicalSource, live.addedTerms ?? null, live.suggestion ?? null);

/** One set's scores and checks; refuses a schedule that is incomplete or whose edits disagree with their buttons. */
export function summarizeSet(set: QuestionSet, journal: Map<string, Recorded>) {
  const recorded = [...journal.values()].filter(r => r.set === set.name);
  const of = (row: Row, q: RankingQuestion, sample: number) => recorded.find(r => r.row === row && r.questionId === q.id && r.sample === sample)?.observation;
  const rankings: RowRanking[] = [];
  let fusedMismatches = 0, editFusedMismatches = 0, offered = 0;
  const clicked = new Map<string, { qh50: number[]; edit: number[] }>();
  const matches: { kind: string; match: string }[] = [];
  for (const q of set.questions) {
    const q0 = of('Q0', q, 1);
    if (!q0) throw new EvaluationError(`Incomplete schedule: ${set.name} ${q.id}`);
    rankings.push({ row: 'Q0', questionId: q.id, sample: 1, ranking: q0.ranking });
    for (const sample of set.samples) {
      const live = of('QH50', q, sample), edit = of('QH50+F', q, sample), plain = of('Q0+F', q, sample);
      if (!live) throw new EvaluationError(`Incomplete schedule: ${set.name} ${q.id}`);
      const filters = buttonFilters(live);
      // An edit exists exactly when the page showed the button, and ran exactly its filters, on the right configuration.
      if (Boolean(filters) !== Boolean(edit) || Boolean(filters) !== Boolean(plain)) throw new EvaluationError(`Edit does not match its button: ${q.id}`);
      if (filters && edit && plain) {
        for (const [o, version] of [[edit, ARM_IDS.QH50], [plain, ARM_IDS.Q0]] as const) {
          if (!o.edited || o.configuration.version !== version || filterIdentity(o.appliedFilters ?? {}) !== filterIdentity(filters)) throw new EvaluationError(`Edit ran other filters: ${q.id}`);
        }
        offered += 1;
        const m = (o: SearchObservation) => codedMetrics(o.ranking, q.relevant).narrowR20;
        if (q.class === 'narrow') {
          const c = clicked.get(q.id) ?? { qh50: [], edit: [] };
          c.qh50.push(m(live)); c.edit.push(m(edit)); clicked.set(q.id, c);
        }
        if (plain.ranking.join('\n') !== edit.fused.join('\n')) editFusedMismatches += 1;
      }
      if (q0.ranking.join('\n') !== live.fused.join('\n')) fusedMismatches += 1;
      matches.push({ kind: q.class, match: filterMatch(filters, set.keyFilters[q.id]!) });
      // No button means the visitor keeps the search they have.
      rankings.push({ row: 'QH50', questionId: q.id, sample, ranking: live.ranking });
      rankings.push({ row: 'QH50+F', questionId: q.id, sample, ranking: (edit ?? live).ranking });
      rankings.push({ row: 'Q0+F', questionId: q.id, sample, ranking: (plain ?? q0).ranking });
    }
  }
  const scores = Object.fromEntries(ROWS.map(row => [row, rowScores(set.questions, rankings, row)])) as Record<Row, ReturnType<typeof rowScores>>;
  const by = (row: Row) => recorded.filter(r => r.row === row).map(r => r.observation);
  const rates = Object.fromEntries(ROWS.map(row => [row, fallbackRates(by(row))]));
  // The bootstrap resamples connected groups as independent: a case shared across groups would make its intervals optimistic.
  const publishable = set.crossGroupShares === 0 && Object.values(rates).every(r => r.scopeRate <= 0.05 + 1e-9 && r.rerankRate <= 0.05 + 1e-9);
  const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map(k => [k, xs.filter(x => x === k).length]));
  const narrowSamples = matches.filter(m => m.kind === 'narrow').length;
  const clickedNarrow = matches.filter(m => m.kind === 'narrow' && m.match !== 'none').length;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const perClicked = [...clicked.values()].map(c => ({ qh50: avg(c.qh50), edit: avg(c.edit) }));
  return {
    set: set.name, questions: set.questions.length, narrow: set.questions.filter(q => q.class === 'narrow').length,
    groups: new Set(set.questions.map(q => q.group)).size, narrowGroups: new Set(set.questions.filter(q => q.class === 'narrow').map(q => q.group)).size,
    samples: set.samples.length, publishable, fallbacks: rates,
    rows: Object.fromEntries(ROWS.map(row => [row, { narrowR20: scores[row].narrowR20, narrowR10: scores[row].narrowR10,
      broadP10: scores[row].broadP10, broadNdcg10: scores[row].broadNdcg10, searches: by(row).length,
      usd: by(row).reduce((s, o) => s + o.actualUsd, 0), scopeOutcomes: tally(by(row).map(o => o.scopeOutcome)),
      rerankOutcomes: tally(by(row).map(o => o.rerankOutcome)) }])),
    narrowR20Differences: { 'QH50 - Q0': compareNarrowR20(scores.Q0, scores.QH50), 'QH50+F - QH50': compareNarrowR20(scores.QH50, scores['QH50+F']),
      'QH50+F - Q0': compareNarrowR20(scores.Q0, scores['QH50+F']), 'QH50+F - Q0+F': compareNarrowR20(scores['Q0+F'], scores['QH50+F']) },
    button: { samples: matches.length, offered, narrowSamples, narrowOffered: clickedNarrow,
      // Narrow questions with at least one button: per-question means over their clicked samples, then the mean over those questions.
      clickedNarrowR20: perClicked.length ? { questions: perClicked.length, QH50: avg(perClicked.map(c => c.qh50)), 'QH50+F': avg(perClicked.map(c => c.edit)) } : null },
    answerKeyMatch: { narrow: tally(matches.filter(m => m.kind === 'narrow').map(m => m.match)), broad: tally(matches.filter(m => m.kind === 'broad').map(m => m.match)) },
    determinism: { q0VsQh50Fused: fusedMismatches, q0fVsQh50fFused: editFusedMismatches },
    labels: { changed: set.changes.filter(c => c.added || c.removed), crossGroupShares: set.crossGroupShares },
    perQuestion: Object.fromEntries(ROWS.map(row => [row, scores[row].questions])),
  };
}

export async function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'preflight' }, 'env-files': { type: 'string', default: '.env.local' },
    'keys-file': { type: 'string' }, 'out-dir': { type: 'string', default: 'data/work/task29' }, 'run-label': { type: 'string' },
    'confirm-cost': { type: 'boolean', default: false } } });
  if (!['preflight', 'run', 'summarize'].includes(values.mode!) || !/^[a-zA-Z0-9-]{1,40}$/.test(values['run-label'] ?? '')) throw new EvaluationError('Invalid mode or run label (--run-label required)');
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
    const stages = stageMicros(evidenceRankingConfig(ARM_IDS.Q0), evidenceRankingConfig(ARM_IDS.QH50));
    const worstCase = (set: QuestionSet) => questionWorstCaseMicros(stages, set.samples.length) * set.questions.length;
    const prior = existsSync(join(directory, 'manifest.json')) ? JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) : undefined;
    const manifest = { version: 'task29-applied-filters-v2', codeCommit, startedAt: prior?.startedAt ?? new Date().toISOString(), label,
      task: TASK29, target: target.identity, configurations: CONFIG_ARMS.map(a => arms[a]), rows: ROWS, automaticFilters: 'none', stages,
      sets: target.sets.map(s => ({ name: s.name, samples: s.samples.length, sourceFileSha256: s.sourceFileSha256, goldSha256: s.goldSha256,
        questions: s.questions.map(q => q.id) })) };
    const hash = sha256(stable(manifest));
    console.log(JSON.stringify({ event: 'preflight', generation: target.identity.source.generationId, revision: target.identity.dataset.revision,
      passages: target.identity.passages.indexVersion, eligibleCases: target.identity.eligibleCases,
      sets: target.sets.map(s => ({ name: s.name, questions: s.questions.length, samples: s.samples.length, labelChanges: s.changes.filter(c => c.added || c.removed),
        crossGroupShares: s.crossGroupShares, worstCaseMicros: worstCase(s) })),
      note: 'worst cases are gated one question at a time against the cap; expected charge is about 6,000 microdollars per sample',
      capMicros: TASK29.capMicros, manifestSha256IfStartedNow: hash }));
    if (values.mode === 'summarize') {
      // Free: the frozen run's identity, then whatever each set's journal completed. Nothing is reserved or dispatched.
      const frozen = join(directory, 'manifest.json');
      if (!existsSync(frozen) || stable(JSON.parse(readFileSync(frozen, 'utf8'))) !== stable(manifest)) throw new EvaluationError('No frozen run with this identity to summarize');
      const journal = readJournal(join(directory, 'results.jsonl'));
      for (const set of target.sets) {
        try { reportSet(directory, hash, target.identity, summarizeSet(set, journal)); }
        catch (e) { if (!(e instanceof EvaluationError && /^Incomplete schedule/.test(e.message))) throw e; console.log(JSON.stringify({ event: 'incomplete', set: set.name })); }
      }
      return;
    }
    allocation = await CappedAllocation.open(settings, directory, TASK29);
    if (values.mode === 'preflight') {
      await allocation.assertBlock(questionWorstCaseMicros(stages, 3));
      console.log(JSON.stringify({ event: 'allowance', task: await taskTotals(allocation.db, TASK29), firstBlockMicros: questionWorstCaseMicros(stages, 3) }));
      return;
    }

    freezeFile(join(directory, 'manifest.json'), manifest);
    const journalPath = join(directory, 'results.jsonl');
    const journal = readJournal(journalPath);
    const keyOf = (set: SetName, q: RankingQuestion, row: Row, sample: number) => opaqueId('task29', label, set, q.id, row, String(sample));
    const port = productionPort(settings, db, es, target.pinned, allocation, 'selection', hash, directory, arms);
    let streak = 0;
    const search = async (set: SetName, row: Row, configArm: 'Q0' | 'QH50', q: RankingQuestion, sample: Sample, request: SearchRequest) => {
      const key = keyOf(set, q, row, sample);
      let observation = journal.get(key)?.observation;
      if (!observation) {
        await assertTarget(db, target.pinned);
        appendDurable(journalPath, { event: 'started', key, set, row, questionId: q.id, sample, at: new Date().toISOString() } satisfies Started);
        observation = await port.run({ key, questionId: q.id, arm: configArm, sample }, q, request);
        const recorded: Recorded = { event: 'result', key, set, row, questionId: q.id, sample, observation };
        appendDurable(journalPath, recorded); journal.set(key, recorded);
        console.log(JSON.stringify({ event: 'search', set, row, questionId: q.id, sample, chargedMicros: Math.round(observation.actualUsd * 1e6),
          scope: observation.scopeOutcome, rerank: observation.rerankOutcome, failure: observation.failure, cases: observation.ranking.length }));
      }
      // A failed search is never scored or repeated under this label, including on resume.
      if (observation.failure || observation.safetyFaults.length) throw new EvaluationError(`Search failed (${observation.failure ?? observation.safetyFaults.join(',')}); stop and inspect the journal`);
      streak = nextStreak(streak, configArm, observation);
      if (streak >= 3) throw new EvaluationError('Three consecutive provider infrastructure outcomes; stopped, incomplete, no retries');
      return observation;
    };
    // What a question still needs, at worst; a question starts only when that fits. The gate still checks every stage.
    const remainingMicros = (set: QuestionSet, q: RankingQuestion) => {
      let n = journal.has(keyOf(set.name, q, 'Q0', 1)) ? 0 : stages.embed;
      for (const sample of set.samples) {
        const live = journal.get(keyOf(set.name, q, 'QH50', sample))?.observation;
        const edits = !live ? true : !live.failure && Boolean(buttonFilters(live));
        if (!live) n += stages.scope + stages.embed + stages.rerank;
        if (edits && !journal.has(keyOf(set.name, q, 'QH50+F', sample))) n += stages.embed + stages.rerank;
        if (edits && !journal.has(keyOf(set.name, q, 'Q0+F', sample))) n += stages.embed;
      }
      return n;
    };
    const summaries: ReturnType<typeof summarizeSet>[] = [];
    for (const set of target.sets) {
      for (const q of set.questions) {
        const needed = remainingMicros(set, q);
        if (needed) await allocation.assertBlock(needed);
        const q0 = await search(set.name, 'Q0', 'Q0', q, 1, { filters: {}, skipScope: true });
        for (const sample of set.samples) {
          const live = await search(set.name, 'QH50', 'QH50', q, sample, { filters: {} });
          const filters = buttonFilters(live);
          if (!filters) continue;
          await search(set.name, 'QH50+F', 'QH50', q, sample, editRequest(filters, live));
          await search(set.name, 'Q0+F', 'Q0', q, sample, editRequest(filters, q0));
        }
      }
      // Each set is summarized as soon as it completes, so a stop in a later set keeps this one's result.
      summaries.push(summarizeSet(set, journal));
      reportSet(directory, hash, target.identity, summaries.at(-1)!);
    }
    const closing = allocation; allocation = undefined;
    const ledger = await closing.close();
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ manifestSha256: hash, generation: target.identity.source.generationId,
      revision: target.identity.dataset.revision, ledger, summaries }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ event: 'complete', ledger }));
  } finally {
    try { if (allocation) await allocation.close(); }
    finally { await es.close(); await closeDb(db); }
  }
}
/** Writes `summary-<set>.json` and prints the set's table, fallbacks and checks. */
function reportSet(directory: string, manifestSha256: string, identity: { source: { generationId: number }; dataset: { revision: string } },
  s: ReturnType<typeof summarizeSet>) {
  writeFileSync(join(directory, `summary-${s.set}.json`), JSON.stringify({ manifestSha256, generation: identity.source.generationId,
    revision: identity.dataset.revision, summary: s }, null, 2) + '\n', { mode: 0o600 });
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`${s.set}: ${s.questions} questions (${s.narrow} narrow in ${s.narrowGroups} groups), ${s.samples} sample(s), publishable ${s.publishable}`);
  for (const row of ROWS) {
    const r = s.rows[row]!, f = s.fallbacks[row]!;
    console.log(`  ${row.padEnd(7)} narrow R@20 ${pct(r.narrowR20).padStart(6)}  R@10 ${pct(r.narrowR10).padStart(6)}  broad P@10 ${pct(r.broadP10).padStart(6)}  nDCG@10 ${pct(r.broadNdcg10).padStart(6)}  searches ${String(r.searches).padStart(3)}  $${r.usd.toFixed(4)}  scope fail ${f.scopeFailures}/${f.scopeAttempts}  rerank fallback ${f.rerankFallbacks}/${f.rerankAttempts}`);
  }
  console.log(JSON.stringify({ set: s.set, differences: Object.fromEntries(Object.entries(s.narrowR20Differences).map(([k, v]) => [k, { delta: v.delta, ci95: v.ci95 }])),
    button: s.button, answerKeyMatch: s.answerKeyMatch, determinism: s.determinism, labels: s.labels }));
}
/** The port checks this too; checking before the journal line keeps a refused attempt from ending the label. */
export async function assertTarget(db: Db, pinned: PinnedDataset) {
  const active = await getActiveManifest(db);
  if (!active || active.generationId !== pinned.manifest.generationId || active.casesIndex !== pinned.manifest.casesIndex
    || active.passagesIndex !== pinned.manifest.passagesIndex) throw new EvaluationError('Active target changed before dispatch');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e instanceof EvaluationError ? e.message : 'Evaluation stopped; raw exception details suppressed. Inspect the durable journal.'); process.exitCode = 1;
});
