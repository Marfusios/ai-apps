/**
 * `pnpm eval:retrieval:experiments <command>`: the task 10d phase A retrieval
 * experiments, as registered in `grid.json` and `PREREG.md`. Read-only against the
 * target: Elasticsearch with the read key, PostgreSQL with the app role; the only
 * writes are the evaluation ledger's reservations for paid calls (`DATABASE_INGEST_URL`).
 *
 *   preflight [--split dev|holdout]
 *   scope     [--split dev|holdout] [--dev-results <file>] [--confirm-cost]
 *   dev       --scope-samples <file> [--confirm-cost]
 *   holdout   --dev-results <file> [--scope-samples <file>] [--confirm-cost]
 *
 * Common options: `--env-files a,b` (as the evaluation's), `--keys-file <file>` (only
 * `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are read from it, and never over a nonempty
 * process value), `--grid`, `--dataset`, `--out-dir` (default `data/work`).
 *
 * **Preflight** (every command, before anything is paid): the grid parses and its
 * baseline is the production baseline; the dataset file and specs are the frozen ones;
 * the active manifest still names the frozen passages and cases indices; the passages
 * index meets the passages contract with the frozen fingerprint; the cases index is a
 * servable version with the frozen fingerprint and generation; the generation identity
 * is the frozen one; every question's labels re-derived on the target equal the
 * dataset's (`codedPreflight`); and for every question the case channel's filter reaches
 * exactly the cases the passages filter reaches. Any problem stops the command.
 *
 * **Costs.** Query embeddings (on the ledger, `embedPlan`) and scope samples (each
 * attempt reserved and settled, `scope.ts`). Every paid step is appended to
 * `<out-dir>/spend.jsonl`; a step whose reservations would take the logged total above
 * the registered phase A limit refuses before anything is sent. Without
 * `--confirm-cost` a command prints its plan and pays nothing.
 *
 * **Holdout.** Runs once, for the configuration the dev run selected by the registered
 * rule (read from `--dev-results`), against the baseline; a second run is refused.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Client, estypes } from '@elastic/elasticsearch';
import { createAnthropicProvider } from '../../../server/ai/anthropic.js';
import { queryEmbeddingInput, type Embedder } from '../../../server/ai/embeddings.js';
import { closeDb, createDb, type Db } from '../../../server/db/client.js';
import { getActiveManifest } from '../../../server/db/generations.js';
import { createEsClient } from '../../../server/search/es.js';
import { compileFilters, type Query } from '../../../server/search/filters.js';
import { assertCompleteResponse } from '../../../server/search/hybrid.js';
import { readIndexMeta } from '../../../server/search/index-meta.js';
import { loadConfig, type AppConfig } from '../../../shared/config.js';
import { readDotenvAllowlisted } from '../../../shared/env-files.js';
import { APP_DIR, workerConfig } from '../../../worker/config.js';
import { describeWorkerError } from '../../../worker/errors.js';
import { isServableCasesIndex } from '../../../worker/index/cases-index.js';
import { createLedgerSpendGate } from '../../../worker/index/spend-gate.js';
import { DEFAULT_CODED_DATASET, rederiveCoded } from '../coded/build-coded.js';
import { REFERENCE, specSha256, type CodedItem } from '../coded/coded.js';
import { CODED_PARAPHRASES, CODED_QUESTIONS } from '../coded/questions.js';
import { codedPreflight, parseCodedDataset } from '../coded/run.js';
import { checkTarget, describePlan, embedPlan, indexReport, planQueryEmbeddings, resolveRunTarget, stamp, type RunTarget } from '../harness.js';
import { caseChannelFilter } from './cases-channel.js';
import { BASELINE_CONFIG, canonicalConfig, experimentConfig, type ExperimentConfig } from './config.js';
import { diagnoseQuestion, type QuestionDiagnosis } from './diagnose.js';
import {
  gridConfigs,
  pairedMetrics,
  latencyOf,
  armSummary,
  runConfigs,
  runKey,
  summarize,
  type ExperimentItem,
  type StoredRun,
} from './experiment.js';
import { loadGrid, sha256, type Grid } from './grid.js';
import { questionSha, runScopeSamples, scopeInventory, type ScopeRun } from './scope.js';

const USAGE =
  'usage: pnpm eval:retrieval:experiments <preflight|scope|dev|holdout> [--split dev|holdout] [--env-files <a,b>] [--keys-file <file>] ' +
  '[--grid <file>] [--dataset <file>] [--out-dir <dir>] [--scope-samples <file>] [--dev-results <file>] [--confirm-cost]';

export const DEFAULT_GRID = resolve(APP_DIR, 'evals/retrieval/experiments/grid.json');
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const CLI_OPTIONS = {
  split: { type: 'string' },
  'env-files': { type: 'string' },
  'keys-file': { type: 'string' },
  grid: { type: 'string' },
  dataset: { type: 'string' },
  'out-dir': { type: 'string' },
  'scope-samples': { type: 'string' },
  'dev-results': { type: 'string' },
  'confirm-cost': { type: 'boolean' },
} as const;

/** Configuration: the env files (or the worker default), plus only the two provider keys from `keysFile`, never over a nonempty process value. */
export function experimentAppConfig(envFiles: string | undefined, keysFile: string | undefined, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const merged: NodeJS.ProcessEnv = { ...env };
  if (keysFile) {
    const keys = readDotenvAllowlisted(resolve(keysFile), PROVIDER_KEYS);
    for (const [k, v] of Object.entries(keys)) if (!merged[k]) merged[k] = v;
  }
  if (envFiles === undefined) return workerConfig(merged);
  const files = envFiles
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => resolve(APP_DIR, f));
  if (files.length === 0) throw new Error('--env-files names no file');
  return loadConfig({ files, env: merged });
}

// ---------------------------------------------------------------------------
// Spend log

interface SpendEntry {
  at: string;
  step: string;
  purpose: string;
  reservedUsd: number;
  chargedUsd: number;
}

const spendFile = (outDir: string) => resolve(outDir, 'spend.jsonl');

export function spentUsd(outDir: string): number {
  const f = spendFile(outDir);
  if (!existsSync(f)) return 0;
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .reduce((n, l) => n + (JSON.parse(l) as SpendEntry).chargedUsd, 0);
}

function logSpend(outDir: string, e: SpendEntry): void {
  appendFileSync(spendFile(outDir), `${JSON.stringify(e)}\n`);
}

function checkCap(outDir: string, grid: Grid, reserveUsd: number, what: string): void {
  const spent = spentUsd(outDir);
  if (spent + reserveUsd > grid.cost.phaseAUsd + 1e-12) {
    throw new Error(`${what}: reserving $${reserveUsd.toFixed(6)} on top of $${spent.toFixed(6)} spent would exceed the phase A limit of $${grid.cost.phaseAUsd}; stopped before sending anything`);
  }
}

// ---------------------------------------------------------------------------
// Preflight

export interface CaseSetCheck {
  questions: string[];
  filters: unknown;
  passagesCases: number;
  casesIndexCases: number;
  onlyPassages: string[];
  onlyCasesIndex: string[];
}

/** Every case number under `filter` in `index` (composite aggregation, paged). */
async function caseSet(es: Client, index: string, filter: Query[]): Promise<Set<string>> {
  const out = new Set<string>();
  let after: Record<string, estypes.FieldValue> | undefined;
  for (;;) {
    const res = await es.search(
      {
        index,
        size: 0,
        allow_partial_search_results: false,
        query: { bool: { filter } },
        aggs: { cases: { composite: { size: 5_000, sources: [{ n: { terms: { field: 'ntsb_no' } } }], ...(after ? { after } : {}) } } },
      },
      { requestTimeout: 60_000 },
    );
    assertCompleteResponse(res, 'fetch');
    const agg = res.aggregations?.cases as estypes.AggregationsCompositeAggregate;
    const buckets = agg.buckets as estypes.AggregationsCompositeBucket[];
    for (const b of buckets) out.add(String(b.key.n));
    if (!agg.after_key || buckets.length === 0) break;
    after = agg.after_key as Record<string, estypes.FieldValue>;
  }
  return out;
}

/** The case channel's filter reaches exactly the cases the passages filter reaches, per distinct question filter. */
export async function filterConsistency(es: Client, t: { passagesIndex: string; casesIndex: string; qualification: boolean }, items: readonly ExperimentItem[]): Promise<CaseSetCheck[]> {
  const byFilter = new Map<string, ExperimentItem[]>();
  for (const q of items) byFilter.set(JSON.stringify(q.filters), [...(byFilter.get(JSON.stringify(q.filters)) ?? []), q]);
  const out: CaseSetCheck[] = [];
  for (const [json, qs] of byFilter) {
    const filters = (qs[0] as ExperimentItem).filters;
    const passages = await caseSet(es, t.passagesIndex, compileFilters(filters, { eventAircraftQualification: t.qualification }).bool.filter);
    const cases = await caseSet(es, t.casesIndex, caseChannelFilter(filters));
    out.push({
      questions: qs.map((q) => q.id),
      filters: JSON.parse(json),
      passagesCases: passages.size,
      casesIndexCases: cases.size,
      onlyPassages: [...passages].filter((n) => !cases.has(n)).sort(),
      onlyCasesIndex: [...cases].filter((n) => !passages.has(n)).sort(),
    });
  }
  return out;
}

interface Context {
  config: AppConfig;
  grid: Grid;
  gridSha256: string;
  gridFile: string;
  datasetSha256: string;
  items: ExperimentItem[];
  es: Client;
  app: Db;
  run: RunTarget;
  casesIndex: string;
  preflight: Record<string, unknown>;
}

const toItem = (q: CodedItem): ExperimentItem => ({
  id: q.id,
  split: q.split,
  group: q.group,
  class: q.class,
  area: q.area,
  paraphraseOf: q.paraphrase_of ?? null,
  question: q.question,
  filters: q.filters,
  relevant: q.relevant,
});

function gitState(): { commit: string | null; dirty: boolean | null } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: APP_DIR, encoding: 'utf8' });
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim() !== '' : null };
}

/** Load, check and connect (module comment). Throws with every problem; nothing is paid. */
async function preflight(opts: { envFiles?: string; keysFile?: string; gridFile: string; datasetFile: string; split: 'dev' | 'holdout' }): Promise<Context> {
  const config = experimentAppConfig(opts.envFiles, opts.keysFile);
  const { grid, sha256: gridSha256 } = loadGrid(opts.gridFile, BASELINE_CONFIG);
  const raw = readFileSync(opts.datasetFile, 'utf8');
  const parsed = parseCodedDataset(raw);
  if ('issues' in parsed) throw new Error(`the coded dataset does not parse: ${parsed.issues.join('; ')}`);
  const dataset = parsed.dataset;
  const problems: string[] = [];
  const datasetSha256 = sha256(raw);
  if (datasetSha256 !== grid.frozen.dataset.sha256) problems.push('dataset: the file is not the frozen one (sha256 differs)');
  if (dataset.source.specSha256 !== grid.frozen.dataset.specSha256) problems.push('dataset: built from other specs than the frozen ones');
  const { model, dims } = { model: config.ai.openai.embeddingModel, dims: config.ai.openai.embeddingDimensions };
  if (model !== grid.frozen.embedding.model || dims !== grid.frozen.embedding.dims) problems.push(`embedding: configured ${model}/${dims}, frozen ${grid.frozen.embedding.model}/${grid.frozen.embedding.dims}`);

  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-experiments' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    const manifest = await getActiveManifest(app);
    if (manifest?.passagesIndex !== grid.frozen.passagesIndex.name) problems.push(`target: the active manifest's passages index is ${manifest?.passagesIndex ?? 'none'}, frozen ${grid.frozen.passagesIndex.name}`);
    if (manifest?.casesIndex !== grid.frozen.casesIndex.name) problems.push(`target: the active manifest's cases index is ${manifest?.casesIndex ?? 'none'}, frozen ${grid.frozen.casesIndex.name}`);
    const run = await resolveRunTarget(es, app, grid.frozen.passagesIndex.name, { model, dims });
    if ('refused' in run) throw new Error(`${run.refused}; nothing paid`);
    if (run.meta.fingerprint !== grid.frozen.passagesIndex.fingerprint || run.meta.indexVersion !== grid.frozen.passagesIndex.version) problems.push('target: the passages index is not the frozen version and fingerprint');
    if (run.target.generationId !== grid.frozen.generation.id) problems.push(`target: generation ${run.target.generationId}, frozen ${grid.frozen.generation.id}`);
    const casesMeta = await readIndexMeta(es, grid.frozen.casesIndex.name);
    if (!isServableCasesIndex(casesMeta.indexVersion, casesMeta.fingerprint)) problems.push('target: the cases index is not a servable version and fingerprint');
    if (casesMeta.fingerprint !== grid.frozen.casesIndex.fingerprint || casesMeta.indexVersion !== grid.frozen.casesIndex.version) problems.push('target: the cases index is not the frozen version and fingerprint');
    if (casesMeta.generationId !== run.target.generationId) problems.push(`target: the cases index records generation ${casesMeta.generationId}`);

    const target = await checkTarget(config.databaseUrl, run.target.generationId, (client) => rederiveCoded(client, run.target.generationId, dataset));
    const g = target.source;
    const f = grid.frozen.generation;
    if (g.archiveSha256 !== f.archiveSha256 || g.mappingVersion !== f.mappingVersion || g.fieldNormalizationVersion !== f.fieldNormalizationVersion || g.citationTextVersion !== f.citationTextVersion) {
      problems.push('generation: the target identity is not the frozen one');
    }
    const pre = codedPreflight(dataset, {
      split: opts.split,
      eventAircraftQualification: run.contract.eventAircraftQualification,
      specSha256: specSha256(CODED_QUESTIONS, CODED_PARAPHRASES),
      target,
    });
    problems.push(...pre.problems);
    const items = pre.items.map(toItem);
    const consistency = await filterConsistency(es, { passagesIndex: run.index, casesIndex: grid.frozen.casesIndex.name, qualification: run.contract.eventAircraftQualification }, items);
    for (const c of consistency) {
      if (c.onlyPassages.length > 0 || c.onlyCasesIndex.length > 0) {
        problems.push(`filters ${JSON.stringify(c.filters)}: the case channel reaches ${c.casesIndexCases} cases, the passages filter ${c.passagesCases} (+${c.onlyCasesIndex.length} / -${c.onlyPassages.length})`);
      }
    }
    if (problems.length > 0) throw new Error(`preflight failed; nothing paid:\n  ${problems.join('\n  ')}`);
    return {
      config,
      grid,
      gridSha256,
      gridFile: opts.gridFile,
      datasetSha256,
      items,
      es,
      app,
      run,
      casesIndex: grid.frozen.casesIndex.name,
      preflight: {
        split: opts.split,
        questions: items.length,
        narrow: items.filter((q) => q.class === 'narrow').length,
        broad: items.filter((q) => q.class === 'broad').length,
        groups: [...new Set(items.map((q) => q.group))].sort(),
        target: { source: target.source, questionsRederived: target.labels.size, warnings: target.warnings, ms: target.ms },
        index: indexReport(run),
        casesIndex: casesMeta,
        filterConsistency: consistency,
      },
    };
  } catch (err) {
    await es.close();
    await closeDb(app);
    throw err;
  }
}

async function close(ctx: Context): Promise<void> {
  await ctx.es.close();
  await closeDb(ctx.app);
}

// ---------------------------------------------------------------------------
// Scope samples

interface ScopeFile {
  kind: 'eval-retrieval-experiments-scope';
  split: 'dev' | 'holdout';
  gridSha256: string;
  run: ScopeRun;
}

/** Effective keyword texts per question (one per sample) from a scope samples file of the same grid and split. */
function loadScopeTexts(file: string, grid: Grid, gridSha: string, items: readonly ExperimentItem[], split: string): Map<string, string[]> & { failed: number } {
  const f = JSON.parse(readFileSync(resolve(file), 'utf8')) as ScopeFile;
  if (f.kind !== 'eval-retrieval-experiments-scope' || f.gridSha256 !== gridSha || f.split !== split) throw new Error('the scope samples file is not of this grid and split');
  const out = Object.assign(new Map<string, string[]>(), { failed: 0 });
  for (const q of items) {
    const samples = f.run.samples.filter((s) => s.id === q.id).sort((a, b) => a.sample - b.sample);
    if (samples.length !== grid.scope.samples) throw new Error(`${q.id}: ${samples.length} scope samples, registered ${grid.scope.samples}`);
    if (samples.some((s) => s.questionSha256 !== questionSha(q.question))) throw new Error(`${q.id}: the scope samples were taken for another question text`);
    out.failed += samples.filter((s) => s.status !== 'ok').length;
    out.set(q.id, samples.map((s) => s.keywordText));
  }
  return out;
}

const usesScope = (c: ExperimentConfig) => c.keywordText === 'scope';

// ---------------------------------------------------------------------------
// Output

const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function writeJson(outDir: string, name: string, body: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

async function embedItems(ctx: Context, outDir: string, label: string, confirm: boolean): Promise<{ embedder: Embedder; billed: unknown } | null> {
  const { embeddingModel: model, embeddingDimensions: dims } = ctx.config.ai.openai;
  const plan = planQueryEmbeddings(ctx.items.map((q) => q.question), model, dims);
  console.log(`query embeddings: ${describePlan(plan)}`);
  if (!confirm) return null;
  checkCap(outDir, ctx.grid, plan.reserveUsd, 'query embeddings');
  const purpose = `eval-10d-${label}-${stamp(new Date())}`;
  const { embedder, billed } = await embedPlan(plan, { fake: false, config: ctx.config, purpose, log: (m) => console.error(m) });
  logSpend(outDir, { at: new Date().toISOString(), step: `embed-${label}`, purpose, reservedUsd: plan.reserveUsd, chargedUsd: billed.usd });
  return { embedder, billed };
}

async function vectorOf(embedder: Embedder, question: string): Promise<number[]> {
  const res = await embedder.embed([queryEmbeddingInput(question)]);
  return Array.from(res.vectors[0] as Float32Array);
}

function serializeRuns(runs: ReadonlyMap<string, StoredRun>): StoredRun[] {
  return [...runs.values()];
}

// ---------------------------------------------------------------------------
// Commands

async function cmdPreflight(ctx: Context, outDir: string): Promise<number> {
  const file = writeJson(outDir, `experiments-preflight-${ctx.preflight.split as string}-${stamp(new Date())}.json`, { kind: 'eval-retrieval-experiments-preflight', git: gitState(), gridSha256: ctx.gridSha256, datasetSha256: ctx.datasetSha256, preflight: ctx.preflight });
  console.log(`preflight passed: ${ctx.items.length} questions; the case channel reaches the passages filter's cases for every question filter`);
  console.log(`report: ${file}`);
  return 0;
}

async function cmdScope(ctx: Context, outDir: string, split: 'dev' | 'holdout', confirm: boolean, devResults: string | undefined): Promise<number> {
  if (split === 'holdout') {
    const selected = readSelected(devResults, ctx.gridSha256);
    const variant = ctx.grid.variants.find((v) => v.id === selected);
    if (!variant || !usesScope(experimentConfig(variant.config))) throw new Error('holdout scope samples are taken only when the selected configuration uses the scope keyword text');
  }
  const a = ctx.config.ai.anthropic;
  if (a.scopeModel !== ctx.grid.frozen.scope.model) throw new Error(`scope model ${a.scopeModel}, frozen ${ctx.grid.frozen.scope.model}`);
  const provider = createAnthropicProvider({ apiKey: a.apiKey, models: { scope: a.scopeModel, answer: a.answerModel, check: a.checkModel } });
  const items = ctx.items.map((q) => ({ id: q.id, question: q.question }));
  const inventory = await scopeInventory(provider, items, ctx.grid.scope.samples, ctx.grid.scope.timeoutMs);
  console.log(`scope dry run (${inventory.model}, prompt ${ctx.grid.frozen.scope.promptVersion}): ${items.length} questions x ${inventory.samples} samples = ${inventory.calls} calls`);
  for (const r of inventory.rows) console.log(`  ${r.id.padEnd(52)} ${String(r.inputTokens).padStart(5)} input tokens  <= $${r.upperUsd.toFixed(6)} per call`);
  console.log(`  total ${inventory.inputTokens} input tokens; at most $${inventory.upperUsd.toFixed(6)} at the output cap; reservations $${inventory.reserveUsd.toFixed(6)} ($${inventory.perCallReserveUsd.toFixed(6)} per attempt, before retries)`);
  const plan = writeJson(outDir, `experiments-scope-plan-${split}-${stamp(new Date())}.json`, { kind: 'eval-retrieval-experiments-scope-plan', gridSha256: ctx.gridSha256, split, inventory });
  console.log(`plan: ${plan}`);
  if (!confirm) {
    console.log('nothing sent: run with --confirm-cost to take the samples');
    return 0;
  }
  const maxUsd = Math.min(ctx.grid.scope.maxUsd, ctx.grid.cost.phaseAUsd - spentUsd(outDir));
  checkCap(outDir, ctx.grid, inventory.reserveUsd, 'scope samples');
  if (!ctx.config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  const ingest = createDb(ctx.config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-experiments-ledger' });
  const purpose = `eval-10d-scope-${split}-${stamp(new Date())}`;
  let run: ScopeRun;
  try {
    const gate = createLedgerSpendGate(ingest, { budgets: ctx.config.ai.budgets, provider: 'anthropic', model: a.scopeModel, stage: 'scope' });
    run = await runScopeSamples(provider, gate, items, { samples: ctx.grid.scope.samples, retries: ctx.grid.scope.retries, maxUsd, purpose, timeoutMs: ctx.grid.scope.timeoutMs, log: (m) => console.error(m) });
  } finally {
    await closeDb(ingest);
  }
  logSpend(outDir, { at: new Date().toISOString(), step: `scope-${split}`, purpose, reservedUsd: run.reservedUsd, chargedUsd: run.chargedUsd });
  if (run.promptVersion !== null && run.promptVersion !== ctx.grid.frozen.scope.promptVersion) throw new Error(`the scope stage answered with prompt ${run.promptVersion}, frozen ${ctx.grid.frozen.scope.promptVersion}`);
  const file = writeJson(outDir, `experiments-scope-${split}-${stamp(new Date())}.json`, { kind: 'eval-retrieval-experiments-scope', split, gridSha256: ctx.gridSha256, run } satisfies ScopeFile);
  const failed = run.samples.filter((s) => s.status !== 'ok').length;
  console.log(`scope samples: ${run.samples.length} (${failed} failed), ${run.attempts} attempts, charged $${run.chargedUsd.toFixed(6)} (reserved $${run.reservedUsd.toFixed(6)})`);
  console.log(`samples: ${file}`);
  return 0;
}

function readSelected(devResults: string | undefined, gridSha: string): string {
  if (!devResults) throw new Error('--dev-results is required');
  const dev = JSON.parse(readFileSync(resolve(devResults), 'utf8')) as { kind?: string; gridSha256?: string; summary?: { rule?: { selected?: string | null } } };
  if (dev.kind !== 'eval-retrieval-experiments-dev' || dev.gridSha256 !== gridSha) throw new Error('--dev-results is not a dev run of this grid');
  const selected = dev.summary?.rule?.selected ?? null;
  if (!selected) throw new Error('the dev run selected no configuration under the registered rule: there is nothing to confirm on the holdout');
  return selected;
}

async function cmdDev(ctx: Context, outDir: string, confirm: boolean, scopeSamples: string | undefined): Promise<number> {
  const keys = gridConfigs(ctx.grid);
  const scopeTexts = keys.entries.some((e) => usesScope(e.config))
    ? scopeSamples
      ? loadScopeTexts(scopeSamples, ctx.grid, ctx.gridSha256, ctx.items, 'dev')
      : null
    : Object.assign(new Map<string, string[]>(), { failed: 0 });
  if (scopeTexts === null) throw new Error('the grid has scope keyword-text variants: pass --scope-samples from `scope --split dev --confirm-cost`');
  console.log(`${keys.entries.length} distinct configurations (${ctx.grid.variants.length} variants, ${ctx.grid.pools.length} pools, ${ctx.grid.channelsAlone.length} single channels) x ${ctx.items.length} dev questions x ${ctx.grid.latency.repetitions} repetitions`);
  const embedded = await embedItems(ctx, outDir, 'dev', confirm);
  if (!embedded) {
    console.log('nothing embedded: run with --confirm-cost to run the experiments');
    return 0;
  }
  const started = new Date();
  const runs = await runConfigs(ctx.es, embedded.embedder, { dataset: ctx.run.target, casesIndex: ctx.casesIndex }, ctx.items, keys.entries, {
    repetitions: ctx.grid.latency.repetitions,
    scopeTexts,
    log: (m) => console.error(m),
  });
  const baselineKey = canonicalConfig(BASELINE_CONFIG);
  const baselinePool = ctx.grid.pools.find((p) => p.method === 'ranking' && canonicalConfig(experimentConfig(p.config)) === baselineKey && p.size === 50)?.id ?? null;
  // Phase A adds no paid call to a request: E3 reuses the keyword text every brief's scope stage already produces.
  // A scope sample that failed (after its retry) counts as a failure of every scope configuration.
  const summary = summarize(ctx.grid, runs, ctx.items, keys, {
    baselinePool,
    addedPaidCalls: () => 0,
    extraFailures: (c) => (usesScope(c) ? scopeTexts.failed : 0),
  });

  // Diagnostics: every coded positive of the narrow questions, against the baseline run.
  const diagnostics: QuestionDiagnosis[] = [];
  for (const q of ctx.items.filter((x) => x.class === 'narrow')) {
    const run = runs.get(runKey(baselineKey, q.id, null)) as StoredRun;
    diagnostics.push(
      await diagnoseQuestion(
        ctx.es,
        { passagesIndex: ctx.run.index, casesIndex: ctx.casesIndex },
        {
          id: q.id,
          question: q.question,
          vector: await vectorOf(embedded.embedder, q.question),
          filter: compileFilters(q.filters, { eventAircraftQualification: ctx.run.contract.eventAircraftQualification }).bool.filter,
          filters: q.filters,
          positives: q.relevant,
        },
        { ranking: run.ranking, channels: run.channels, bundle: run.bundle.map((c) => c.ntsbNo), skipped: run.skipped },
        ctx.grid.diagnostics,
      ),
    );
    console.error(`diagnosed ${q.id}`);
  }

  const finished = new Date();
  const file = writeJson(outDir, `experiments-dev-${stamp(started)}.json`, {
    kind: 'eval-retrieval-experiments-dev',
    reference: REFERENCE,
    git: gitState(),
    gridSha256: ctx.gridSha256,
    datasetSha256: ctx.datasetSha256,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    preflight: ctx.preflight,
    embedder: embedded.billed,
    scopeSamples: scopeSamples ? { file: 'scope samples file', sha256: sha256(readFileSync(resolve(scopeSamples), 'utf8')) } : null,
    questions: ctx.items,
    configs: keys.entries,
    variantKeys: Object.fromEntries(keys.variantKeys),
    poolKeys: Object.fromEntries(keys.poolKeys),
    aloneKeys: Object.fromEntries(keys.aloneKeys),
    summary,
    diagnostics,
    runs: serializeRuns(runs),
  });

  const b = summary.baseline.arm;
  console.log(`\n${REFERENCE}, dev: baseline narrow R@20 ${pct(b.narrowRecall20)} (>=90%: ${pct(b.narrowAtTarget)}), broad coded P@6 ${pct(b.broadStrictP6)}, nDCG@6 ${pct(b.broadNdcg6)}; p95 latency ${summary.baseline.latency.p95TotalMs} ms`);
  console.log('variant              d narrow R@20 [95% CI] (1-sided lb)   d P@6    d nDCG@6   p95 +ms  verdict');
  for (const v of summary.variants) {
    const m = v.metrics;
    const verdict = summary.rule.verdicts.find((x) => x.id === v.id);
    console.log(
      `  ${v.id.padEnd(18)} ${pp(m.narrowRecall20.delta).padStart(6)} [${pp(m.narrowRecall20.ci95[0])}, ${pp(m.narrowRecall20.ci95[1])}] (${pp(m.narrowRecall20.lower95)})  ${pp(m.broadStrictP6.delta).padStart(6)}  ${pp(m.broadNdcg6.delta).padStart(6)}  ${String(v.latency.p95AddedMs).padStart(7)}  ${verdict?.qualifies ? 'QUALIFIES' : (verdict?.reasons[0] ?? '')}`,
    );
  }
  console.log(`selected: ${summary.rule.selected ?? 'none (the baseline stays)'}`);
  console.log(`report: ${file}`);
  return 0;
}

async function cmdHoldout(ctx: Context, outDir: string, confirm: boolean, devResults: string | undefined, scopeSamples: string | undefined): Promise<number> {
  const selected = readSelected(devResults, ctx.gridSha256);
  const marker = resolve(outDir, 'holdout-confirmation.lock');
  if (existsSync(marker)) throw new Error('the holdout confirmation already ran once for this grid; it is never repeated');
  const variant = ctx.grid.variants.find((v) => v.id === selected);
  if (!variant) throw new Error(`the selected configuration ${selected} is not in the grid`);
  const config = experimentConfig(variant.config);
  const baselineKey = canonicalConfig(BASELINE_CONFIG);
  const entries = [
    { key: baselineKey, config: experimentConfig({}) },
    { key: canonicalConfig(config), config },
  ];
  const scopeTexts = usesScope(config)
    ? scopeSamples
      ? loadScopeTexts(scopeSamples, ctx.grid, ctx.gridSha256, ctx.items, 'holdout')
      : null
    : Object.assign(new Map<string, string[]>(), { failed: 0 });
  if (scopeTexts === null) throw new Error('the selected configuration uses the scope keyword text: pass --scope-samples from `scope --split holdout --confirm-cost`');
  console.log(`holdout confirmation of ${selected} against the baseline: ${ctx.items.length} holdout questions x ${ctx.grid.latency.repetitions} repetitions`);
  const embedded = await embedItems(ctx, outDir, 'holdout', confirm);
  if (!embedded) {
    console.log('nothing embedded: run with --confirm-cost to run the confirmation');
    return 0;
  }
  writeFileSync(marker, `${new Date().toISOString()} ${selected}\n`);
  const started = new Date();
  const runs = await runConfigs(ctx.es, embedded.embedder, { dataset: ctx.run.target, casesIndex: ctx.casesIndex }, ctx.items, entries, {
    repetitions: ctx.grid.latency.repetitions,
    scopeTexts,
    log: (m) => console.error(m),
  });
  const key = canonicalConfig(config);
  const boot = { resamples: ctx.grid.bootstrap.resamples, seed: ctx.grid.bootstrap.seed };
  const metrics = pairedMetrics(runs, key, baselineKey, ctx.items, boot);
  const latency = latencyOf(runs, key, baselineKey, ctx.items);
  const all = [...runs.values()];
  const summary = {
    selected,
    config,
    baseline: armSummary(runs, baselineKey, ctx.items),
    variant: armSummary(runs, key, ctx.items),
    metrics,
    latency,
    baselineLatency: latencyOf(runs, baselineKey, baselineKey, ctx.items),
    failures: all.filter((r) => r.error !== null).length,
    scopeSampleFailures: scopeTexts.failed,
    unstable: all.filter((r) => !r.stable).length,
  };
  const file = writeJson(outDir, `experiments-holdout-${stamp(started)}.json`, {
    kind: 'eval-retrieval-experiments-holdout',
    reference: REFERENCE,
    note: 'One-time confirmation of the configuration the dev run selected; not a selection and not the release evaluation.',
    git: gitState(),
    gridSha256: ctx.gridSha256,
    datasetSha256: ctx.datasetSha256,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    preflight: ctx.preflight,
    embedder: embedded.billed,
    questions: ctx.items,
    configs: entries,
    summary,
    runs: serializeRuns(runs),
  });
  console.log(`\nholdout (${ctx.items.length} questions): baseline narrow R@20 ${pct(summary.baseline.narrowRecall20)}, ${selected} ${pct(summary.variant.narrowRecall20)} (${pp(metrics.narrowRecall20.delta)} pp [${pp(metrics.narrowRecall20.ci95[0])}, ${pp(metrics.narrowRecall20.ci95[1])}])`);
  console.log(`  broad coded P@6 ${pct(summary.baseline.broadStrictP6)} -> ${pct(summary.variant.broadStrictP6)}; nDCG@6 ${pct(summary.baseline.broadNdcg6)} -> ${pct(summary.variant.broadNdcg6)}; p95 added ${latency.p95AddedMs} ms`);
  console.log(`report: ${file}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true });
  const command = positionals[0];
  const split = (values.split ?? (command === 'holdout' ? 'holdout' : 'dev')) as 'dev' | 'holdout';
  if (!command || !['preflight', 'scope', 'dev', 'holdout'].includes(command) || positionals.length > 1 || (split !== 'dev' && split !== 'holdout')) {
    console.error(USAGE);
    return 2;
  }
  if ((command === 'dev' && split !== 'dev') || (command === 'holdout' && split !== 'holdout')) {
    console.error(`${command} runs on the ${command === 'dev' ? 'dev' : 'holdout'} split only`);
    return 2;
  }
  const outDir = resolve(values['out-dir'] ?? resolve(APP_DIR, 'data/work'));
  const ctx = await preflight({
    ...(values['env-files'] ? { envFiles: values['env-files'] } : {}),
    ...(values['keys-file'] ? { keysFile: values['keys-file'] } : {}),
    gridFile: resolve(values.grid ?? DEFAULT_GRID),
    datasetFile: resolve(values.dataset ?? DEFAULT_CODED_DATASET),
    split,
  });
  try {
    const confirm = values['confirm-cost'] === true;
    switch (command) {
      case 'preflight':
        return await cmdPreflight(ctx, outDir);
      case 'scope':
        return await cmdScope(ctx, outDir, split, confirm, values['dev-results']);
      case 'dev':
        return await cmdDev(ctx, outDir, confirm, values['scope-samples']);
      default:
        return await cmdHoldout(ctx, outDir, confirm, values['dev-results'], values['scope-samples']);
    }
  } finally {
    await close(ctx);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/retrieval/experiments/cli.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(describeWorkerError(err));
      process.exit(1);
    },
  );
}
