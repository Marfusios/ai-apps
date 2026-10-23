/**
 * `pnpm eval:retrieval:adoption <command>`: the task 10e validation of the case-level
 * retrieval version (`retrieval.v2`) against the deployed behaviour (`retrieval.v1`,
 * phase A's `p50-kt`), on the frozen phase A target and the Track C development split.
 * Read-only against the target (Elasticsearch with the read key, PostgreSQL with the
 * app role); the only writes are the evaluation ledger's reservations for the query
 * embeddings (`DATABASE_INGEST_URL`).
 *
 *   preflight --scope-samples <file>
 *   dev       --scope-samples <file> [--phase-a <dev run>] [--confirm-cost | --vectors <file>]
 *   load      --scope-samples <file> --vectors <file> [--concurrency 1,4,8] [--duration-ms n]
 *             [--max-requests n] [--embed-delay-ms n]
 *
 * Common options: `--env-files a,b`, `--keys-file <file>` (only the provider keys are
 * read from it), `--out-dir` (default `data/work`).
 *
 * **Preflight** (every command, nothing paid): the frozen target of phase A's
 * `grid.json` (dataset, generation identity, the active manifest's passages and cases
 * indexes, their versions and fingerprints, the embedding); every development
 * question's labels re-derived on the target; the cached scope samples are phase A's
 * for these questions (question text hashes, every sample answered); and for every
 * question's evaluation filters and every sample's inferred filters, the production
 * cases channel filter reaches exactly the cases the passages filter reaches.
 *
 * **dev** embeds each question once (about $0.00001; on the ledger, with
 * `--confirm-cost` after the free plan; the out-dir's spend log refuses anything above
 * $0.10), saves the vectors (the `load` input; identified by model, dimensions, input
 * template and input hash), runs every arm and filter mode (`validate.ts`) and writes
 * `adoption-dev-<UTC>.json`. With `--vectors <file>` it reuses a saved vector file
 * instead and pays nothing (the same query vectors as that run). **load** pays nothing
 * (`load.ts`). Both reports name the target (passages index, cases index and version).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Client, estypes } from '@elastic/elasticsearch';
import { QUERY_INPUT_TEMPLATE_VERSION, queryEmbeddingInput, type Embedder } from '../../../server/ai/embeddings.js';
import { closeDb, createDb, type Db } from '../../../server/db/client.js';
import { getActiveManifest, manifestCasesIndex } from '../../../server/db/generations.js';
import { casesChannelFilter } from '../../../server/search/cases-channel.js';
import { createEsClient } from '../../../server/search/es.js';
import { compileFilters, type Query, type RetrievalFilters } from '../../../server/search/filters.js';
import { assertCompleteResponse } from '../../../server/search/hybrid.js';
import { readIndexMeta } from '../../../server/search/index-meta.js';
import { RETRIEVAL_V1, RETRIEVAL_V2 } from '../../../server/search/retrieval-config.js';
import type { AppConfig } from '../../../shared/config.js';
import { APP_DIR } from '../../../worker/config.js';
import { describeWorkerError } from '../../../worker/errors.js';
import { isServableCasesIndex } from '../../../worker/index/cases-index.js';
import { DEFAULT_CODED_DATASET, rederiveCoded } from '../coded/build-coded.js';
import { REFERENCE, specSha256, type CodedItem } from '../coded/coded.js';
import { CODED_PARAPHRASES, CODED_QUESTIONS } from '../coded/questions.js';
import { codedPreflight, parseCodedDataset } from '../coded/run.js';
import { DEFAULT_GRID, experimentAppConfig } from '../experiments/cli.js';
import { BASELINE_CONFIG, canonicalConfig, experimentConfig } from '../experiments/config.js';
import type { ExperimentItem, StoredRun } from '../experiments/experiment.js';
import { loadGrid, sha256, type Grid } from '../experiments/grid.js';
import { questionSha, type ScopeRun } from '../experiments/scope.js';
import { checkTarget, describePlan, embedPlan, indexReport, planQueryEmbeddings, precomputedEmbedder, resolveRunTarget, stamp, type RunTarget } from '../harness.js';
import { DEFAULT_LOAD, runLoad, summarizeLoad, type LoadRequest } from './load.js';
import {
  ARMS,
  COMPARISON,
  FILTER_MODES,
  REGRESSION_CASES,
  armIdentities,
  armScores,
  deliveredEvidence,
  pairedArms,
  pipelineIntent,
  questionChanges,
  regressionRuns,
  runAdoption,
  type AdoptionRun,
  type Arm,
  type ScopeSampleUse,
} from './validate.js';

const USAGE =
  'usage: pnpm eval:retrieval:adoption <preflight|dev|load> --scope-samples <file> [--env-files <a,b>] [--keys-file <file>] [--out-dir <dir>] ' +
  '[--phase-a <file>] [--confirm-cost | --vectors <file>] [--concurrency 1,4,8] [--duration-ms n] [--max-requests n] [--embed-delay-ms n]';

const OPTIONS = {
  'env-files': { type: 'string' },
  'keys-file': { type: 'string' },
  'out-dir': { type: 'string' },
  'scope-samples': { type: 'string' },
  'phase-a': { type: 'string' },
  'confirm-cost': { type: 'boolean' },
  vectors: { type: 'string' },
  concurrency: { type: 'string' },
  'duration-ms': { type: 'string' },
  'max-requests': { type: 'string' },
  'embed-delay-ms': { type: 'string' },
} as const;

/** The most this validation may spend, whatever it is asked (the task brief's limit). */
export const MAX_SPEND_USD = 0.1;
const BOOT = { resamples: 10_000, seed: 20261023 };

// ---------------------------------------------------------------------------
// Spend log

const spendFile = (outDir: string) => resolve(outDir, 'adoption-spend.jsonl');

function spentUsd(outDir: string): number {
  const f = spendFile(outDir);
  if (!existsSync(f)) return 0;
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .reduce((n, l) => n + (JSON.parse(l) as { chargedUsd: number }).chargedUsd, 0);
}

function writeJson(outDir: string, name: string, body: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

function gitState(): { commit: string | null; dirty: boolean | null } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: APP_DIR, encoding: 'utf8' });
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim() !== '' : null };
}

// ---------------------------------------------------------------------------
// Scope samples

interface ScopeFile {
  kind: 'eval-retrieval-experiments-scope';
  split: 'dev' | 'holdout';
  gridSha256: string;
  run: ScopeRun;
}

/** Each question's cached scope samples as the pipeline uses them (phase A's dev file, checked). */
export function loadScopeUses(file: string, gridSha: string, items: readonly ExperimentItem[], samples: number): Map<string, ScopeSampleUse[]> {
  const f = JSON.parse(readFileSync(resolve(file), 'utf8')) as ScopeFile;
  if (f.kind !== 'eval-retrieval-experiments-scope' || f.gridSha256 !== gridSha || f.split !== 'dev') throw new Error('the scope samples file is not phase A’s development file of the frozen grid');
  const out = new Map<string, ScopeSampleUse[]>();
  for (const q of items) {
    const mine = f.run.samples.filter((s) => s.id === q.id).sort((a, b) => a.sample - b.sample);
    if (mine.length !== samples) throw new Error(`${q.id}: ${mine.length} scope samples, expected ${samples}`);
    out.set(
      q.id,
      mine.map((s) => {
        if (s.status !== 'ok') throw new Error(`${q.id}: scope sample ${s.sample} failed`);
        if (s.questionSha256 !== questionSha(q.question)) throw new Error(`${q.id}: the scope samples were taken for another question text`);
        const intent = pipelineIntent(q.question, s);
        if (intent.keywordText !== s.keywordText) throw new Error(`${q.id}: sample ${s.sample}'s keyword text does not resolve as recorded`);
        return { sample: s.sample, intent: intent.intent, keywordText: intent.keywordText, inferredFilters: intent.filters, plannerFilters: s.plannerFilters };
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preflight

interface Context {
  config: AppConfig;
  grid: Grid;
  gridSha256: string;
  items: ExperimentItem[];
  uses: Map<string, ScopeSampleUse[]>;
  es: Client;
  app: Db;
  run: RunTarget;
  casesIndex: string;
  preflight: Record<string, unknown>;
}

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

async function preflight(opts: { envFiles?: string; keysFile?: string; scopeSamples: string }): Promise<Context> {
  const config = experimentAppConfig(opts.envFiles, opts.keysFile);
  const { grid, sha256: gridSha256 } = loadGrid(DEFAULT_GRID, BASELINE_CONFIG);
  const raw = readFileSync(DEFAULT_CODED_DATASET, 'utf8');
  const parsed = parseCodedDataset(raw);
  if ('issues' in parsed) throw new Error(`the coded dataset does not parse: ${parsed.issues.join('; ')}`);
  const dataset = parsed.dataset;
  const problems: string[] = [];
  if (sha256(raw) !== grid.frozen.dataset.sha256) problems.push('dataset: the file is not the frozen one');
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  if (model !== grid.frozen.embedding.model || dims !== grid.frozen.embedding.dims) problems.push(`embedding: configured ${model}/${dims}, frozen ${grid.frozen.embedding.model}/${grid.frozen.embedding.dims}`);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const app = createDb(config.databaseUrl, { max: 8, applicationName: 'aviation-eval-adoption' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    const manifest = await getActiveManifest(app);
    if (manifest?.passagesIndex !== grid.frozen.passagesIndex.name) problems.push(`target: the active manifest's passages index is ${manifest?.passagesIndex ?? 'none'}, frozen ${grid.frozen.passagesIndex.name}`);
    if (manifest?.casesIndex !== grid.frozen.casesIndex.name) problems.push(`target: the active manifest's cases index is ${manifest?.casesIndex ?? 'none'}, frozen ${grid.frozen.casesIndex.name}`);
    const run = await resolveRunTarget(es, app, grid.frozen.passagesIndex.name, { model, dims });
    if ('refused' in run) throw new Error(`${run.refused}; nothing paid`);
    if (run.meta.fingerprint !== grid.frozen.passagesIndex.fingerprint) problems.push('target: the passages index fingerprint is not the frozen one');
    // The production lookup: the cases index this generation's manifest pairs with the passages index.
    const casesIndex = await manifestCasesIndex(app, run.target.generationId, run.index, { timeoutMs: 10_000 });
    if (casesIndex !== grid.frozen.casesIndex.name) problems.push(`target: the manifest pairs ${run.index} with ${casesIndex ?? 'no cases index'}`);
    const casesMeta = await readIndexMeta(es, grid.frozen.casesIndex.name);
    if (!isServableCasesIndex(casesMeta.indexVersion, casesMeta.fingerprint) || casesMeta.fingerprint !== grid.frozen.casesIndex.fingerprint) problems.push('target: the cases index is not the frozen servable version');
    if (casesMeta.generationId !== run.target.generationId) problems.push(`target: the cases index records generation ${casesMeta.generationId}`);
    const target = await checkTarget(config.databaseUrl, run.target.generationId, (client) => rederiveCoded(client, run.target.generationId, dataset));
    const g = target.source;
    const f = grid.frozen.generation;
    if (g.archiveSha256 !== f.archiveSha256 || g.mappingVersion !== f.mappingVersion || g.fieldNormalizationVersion !== f.fieldNormalizationVersion || g.citationTextVersion !== f.citationTextVersion) {
      problems.push('generation: the target identity is not the frozen one');
    }
    const pre = codedPreflight(dataset, { split: 'dev', eventAircraftQualification: run.contract.eventAircraftQualification, specSha256: specSha256(CODED_QUESTIONS, CODED_PARAPHRASES), target });
    problems.push(...pre.problems);
    const items = pre.items.map(toItem);
    const uses = loadScopeUses(opts.scopeSamples, gridSha256, items, grid.scope.samples);

    // Cohort parity of the production cases filter, for every filter the validation applies.
    const qualification = { eventAircraftQualification: run.contract.eventAircraftQualification };
    const filters = new Map<string, RetrievalFilters>();
    for (const q of items) filters.set(JSON.stringify(q.filters), q.filters);
    for (const list of uses.values()) for (const u of list) filters.set(JSON.stringify(u.inferredFilters), u.inferredFilters);
    const parity: { filters: RetrievalFilters; passagesCases: number; casesIndexCases: number; onlyPassages: string[]; onlyCasesIndex: string[] }[] = [];
    for (const f of filters.values()) {
      const passages = await caseSet(es, run.index, compileFilters(f, qualification).bool.filter);
      const cases = await caseSet(es, grid.frozen.casesIndex.name, casesChannelFilter(f, qualification));
      const row = { filters: f, passagesCases: passages.size, casesIndexCases: cases.size, onlyPassages: [...passages].filter((n) => !cases.has(n)).sort(), onlyCasesIndex: [...cases].filter((n) => !passages.has(n)).sort() };
      parity.push(row);
      if (row.onlyPassages.length > 0 || row.onlyCasesIndex.length > 0) problems.push(`filters ${JSON.stringify(f)}: cases channel ${cases.size} cases, passages filter ${passages.size} (+${row.onlyCasesIndex.length} / -${row.onlyPassages.length})`);
    }
    if (problems.length > 0) throw new Error(`preflight failed; nothing paid:\n  ${problems.join('\n  ')}`);
    return {
      config,
      grid,
      gridSha256,
      items,
      uses,
      es,
      app,
      run,
      casesIndex: grid.frozen.casesIndex.name,
      preflight: {
        questions: items.length,
        narrow: items.filter((q) => q.class === 'narrow').length,
        broad: items.filter((q) => q.class === 'broad').length,
        target: { source: target.source, questionsRederived: target.labels.size, warnings: target.warnings },
        index: indexReport(run),
        casesIndex: casesMeta,
        filterParity: parity,
        scopeSamples: { file: sha256(readFileSync(resolve(opts.scopeSamples), 'utf8')), perQuestion: grid.scope.samples },
      },
    };
  } catch (err) {
    await es.close();
    await closeDb(app);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Vectors (the `load` input)

interface VectorFile {
  kind: 'eval-retrieval-adoption-vectors';
  model: string;
  dims: number;
  inputTemplate: string;
  vectors: { sha256: string; input: string; vector: string }[];
}

function saveVectors(outDir: string, embedder: Embedder, inputs: readonly string[]): Promise<string> {
  return (async () => {
    const vectors: VectorFile['vectors'] = [];
    for (const input of inputs) {
      const v = (await embedder.embed([input])).vectors[0] as Float32Array;
      vectors.push({ sha256: sha256(input), input, vector: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') });
    }
    return writeJson(outDir, `adoption-vectors-dev-${stamp(new Date())}.json`, { kind: 'eval-retrieval-adoption-vectors', model: embedder.model, dims: embedder.dims, inputTemplate: QUERY_INPUT_TEMPLATE_VERSION, vectors } satisfies VectorFile);
  })();
}

function loadVectors(file: string, model: string, dims: number): Map<string, Float32Array> {
  const f = JSON.parse(readFileSync(resolve(file), 'utf8')) as VectorFile;
  if (f.kind !== 'eval-retrieval-adoption-vectors' || f.model !== model || f.dims !== dims || f.inputTemplate !== QUERY_INPUT_TEMPLATE_VERSION) throw new Error('the vectors file is not for the configured embedding and input template');
  const out = new Map<string, Float32Array>();
  for (const v of f.vectors) {
    if (sha256(v.input) !== v.sha256) throw new Error('a cached vector’s input does not match its hash');
    const buf = Buffer.from(v.vector, 'base64');
    const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (vec.length !== dims) throw new Error('a cached vector has the wrong dimensions');
    out.set(v.input, Float32Array.from(vec));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands

/** The indexes a run read: the passages index, and the cases index with its version (its retrieval identity beside the arms'). */
function targetIdentity(ctx: Context): Record<string, unknown> {
  const cases = ctx.preflight.casesIndex as { index: string; indexVersion: string | null; fingerprint: string | null };
  return {
    generationId: ctx.run.target.generationId,
    passagesIndex: { name: ctx.run.index, version: ctx.run.meta.indexVersion, fingerprint: ctx.run.meta.fingerprint },
    casesIndex: { name: cases.index, version: cases.indexVersion, fingerprint: cases.fingerprint },
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;

async function cmdDev(ctx: Context, outDir: string, confirm: boolean, phaseA: string | undefined, vectorsFile: string | undefined): Promise<number> {
  const { embeddingModel: model, embeddingDimensions: dims } = ctx.config.ai.openai;
  const plan = planQueryEmbeddings(ctx.items.map((q) => q.question), model, dims);
  const runs = ctx.items.length * ctx.grid.scope.samples * FILTER_MODES.length * Object.keys(ARMS).length;
  console.log(`${ctx.items.length} development questions x ${ctx.grid.scope.samples} cached scope samples x ${FILTER_MODES.length} filter modes x ${Object.keys(ARMS).length} arms = ${runs} retrievals`);
  let embedder: Embedder;
  let billed: unknown;
  let vectors: string;
  if (vectorsFile) {
    // The saved vectors of an earlier run: identical query vectors, nothing paid.
    const cached = loadVectors(vectorsFile, model, dims);
    for (const input of plan.inputs) if (!cached.has(input)) throw new Error('the vectors file lacks a question of this run');
    embedder = precomputedEmbedder({ model, dims, usdPerMillionTokens: 0 }, cached);
    billed = { cached: true, requests: 0, usd: 0 };
    vectors = resolve(vectorsFile);
    console.log(`query vectors: ${plan.inputs.length} from the saved file; nothing embedded`);
  } else {
    console.log(`query embeddings: ${describePlan(plan)}`);
    const spent = spentUsd(outDir);
    if (spent + plan.reserveUsd > MAX_SPEND_USD) throw new Error(`reserving $${plan.reserveUsd.toFixed(6)} on top of $${spent.toFixed(6)} would exceed $${MAX_SPEND_USD}; nothing sent`);
    if (!confirm) {
      console.log('nothing embedded: run with --confirm-cost (or --vectors <saved file>)');
      return 0;
    }
    const purpose = `eval-10e-dev-${stamp(new Date())}`;
    const paid = await embedPlan(plan, { fake: false, config: ctx.config, purpose, log: (m) => console.error(m) });
    embedder = paid.embedder;
    billed = paid.billed;
    appendFileSync(spendFile(outDir), `${JSON.stringify({ at: new Date().toISOString(), step: 'embed-dev', purpose, reservedUsd: plan.reserveUsd, chargedUsd: paid.billed.usd })}\n`);
    vectors = await saveVectors(outDir, embedder, plan.inputs);
  }
  const started = new Date();
  const target = { dataset: ctx.run.target, casesIndex: ctx.casesIndex };
  const all = await runAdoption(ctx.es, embedder, target, ctx.items, ctx.uses, { log: (m) => console.error(m) });
  const finished = new Date();

  const summary = Object.fromEntries(
    FILTER_MODES.map((mode) => [
      mode,
      {
        arms: Object.fromEntries((Object.keys(ARMS) as Arm[]).map((arm) => [arm, armScores(all, arm, mode, ctx.items)])),
        nVsP50kt: pairedArms(all, COMPARISON.base, COMPARISON.variant, mode, ctx.items, BOOT),
        nfVsP50kt: pairedArms(all, 'p50-kt', 'NF', mode, ctx.items, BOOT),
        nfVsN: pairedArms(all, 'N', 'NF', mode, ctx.items, BOOT),
        perQuestion: questionChanges(all, COMPARISON.base, COMPARISON.variant, mode, ctx.items),
        delivered: { N: deliveredEvidence(all, 'N', mode), 'p50-kt': deliveredEvidence(all, 'p50-kt', mode) },
        regressions: Object.fromEntries(REGRESSION_CASES.map((r) => [r.id, regressionRuns(all, COMPARISON.base, COMPARISON.variant, mode, r.id)])),
      },
    ]),
  );
  const phaseAComparison = phaseA ? comparePhaseA(phaseA, ctx, all) : null;
  const file = writeJson(outDir, `adoption-dev-${stamp(started)}.json`, {
    kind: 'eval-retrieval-adoption-dev',
    reference: REFERENCE,
    git: gitState(),
    gridSha256: ctx.gridSha256,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    preflight: ctx.preflight,
    target: targetIdentity(ctx),
    arms: armIdentities(),
    comparison: COMPARISON,
    regressionCases: REGRESSION_CASES,
    embedder: billed,
    vectors: { file: vectors },
    bootstrap: BOOT,
    summary,
    phaseA: phaseAComparison,
    runs: [...all.values()],
  });
  for (const mode of FILTER_MODES) {
    const s = summary[mode] as unknown as { arms: Record<Arm, ReturnType<typeof armScores>>; nVsP50kt: ReturnType<typeof pairedArms> };
    console.log(`\n${REFERENCE}, dev, ${mode} filters:`);
    for (const arm of Object.keys(ARMS) as Arm[]) {
      const a = s.arms[arm];
      console.log(`  ${arm.padEnd(7)} narrow R@20 ${pct(a.narrowRecall20)} (>=90%: ${pct(a.narrowAtTarget)}), broad P@6 ${pct(a.broadStrictP6)}, nDCG@6 ${pct(a.broadNdcg6)}; delivered coded ${a.deliveredCoded.toFixed(2)} of ${a.deliveredCases.toFixed(2)}; failures ${a.failures}`);
    }
    const m = s.nVsP50kt;
    console.log(`  N - p50-kt: narrow R@20 ${pp(m.narrowRecall20.delta)} [${pp(m.narrowRecall20.ci95[0])}, ${pp(m.narrowRecall20.ci95[1])}], P@6 ${pp(m.broadStrictP6.delta)} [${pp(m.broadStrictP6.ci95[0])}, ${pp(m.broadStrictP6.ci95[1])}], nDCG@6 ${pp(m.broadNdcg6.delta)} [${pp(m.broadNdcg6.ci95[0])}, ${pp(m.broadNdcg6.ci95[1])}]`);
  }
  console.log(`report: ${file}`);
  console.log(`vectors (load input): ${vectors}`);
  return 0;
}

/**
 * Phase A's stored runs of `p50-kt` and `c200+n-kt` against these (fixed filters): the
 * stored scores, and how often the top 20 and the bundle agree per question and sample.
 */
function comparePhaseA(file: string, ctx: Context, all: Map<string, AdoptionRun>) {
  const dev = JSON.parse(readFileSync(resolve(file), 'utf8')) as { kind: string; gridSha256: string; summary: { variants: { id: string; arm: Record<string, number> }[] }; runs: StoredRun[]; variantKeys: Record<string, string> };
  if (dev.kind !== 'eval-retrieval-experiments-dev' || dev.gridSha256 !== ctx.gridSha256) throw new Error('--phase-a is not the phase A development run of the frozen grid');
  const pairs = [
    ['p50-kt', 'p50-kt'],
    ['N', 'c200+n-kt'],
    ['NF', 'c200+nf-kt'],
  ] as const;
  return pairs.map(([arm, variant]) => {
    const key = dev.variantKeys[variant] ?? canonicalConfig(experimentConfig(ctx.grid.variants.find((v) => v.id === variant)!.config));
    const stored = dev.runs.filter((r) => r.config === key);
    let top20 = 0;
    let bundles = 0;
    let n = 0;
    for (const r of stored) {
      const mine = all.get(`${arm}|fixed|${r.question}|${r.sample}`);
      if (!mine) continue;
      n += 1;
      const a = new Set(r.ranking.slice(0, 20));
      const b = mine.ranking.slice(0, 20);
      top20 += b.filter((x) => a.has(x)).length / Math.max(1, Math.max(a.size, b.length));
      if (JSON.stringify(r.bundle.map((c) => c.ntsbNo)) === JSON.stringify(mine.bundle.map((c) => c.ntsbNo))) bundles += 1;
    }
    return { arm, variant, storedArm: dev.summary.variants.find((v) => v.id === variant)?.arm ?? null, runs: n, meanTop20Overlap: n ? top20 / n : null, sameBundle: n ? bundles / n : null };
  });
}

async function cmdLoad(ctx: Context, outDir: string, values: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof values.vectors !== 'string') throw new Error('--vectors (from the dev run) is required');
  const { embeddingModel: model, embeddingDimensions: dims } = ctx.config.ai.openai;
  const vectors = loadVectors(values.vectors, model, dims);
  for (const q of ctx.items) if (!vectors.has(queryEmbeddingInput(q.question))) throw new Error(`${q.id}: no cached vector`);
  const num = (k: string, d: number) => (typeof values[k] === 'string' ? Number(values[k]) : d);
  const o = {
    ...DEFAULT_LOAD,
    concurrency: typeof values.concurrency === 'string' ? values.concurrency.split(',').map(Number) : DEFAULT_LOAD.concurrency,
    durationMs: num('duration-ms', DEFAULT_LOAD.durationMs),
    maxRequests: num('max-requests', DEFAULT_LOAD.maxRequests),
    embedDelayMs: num('embed-delay-ms', DEFAULT_LOAD.embedDelayMs),
  };
  const requests: LoadRequest[] = ctx.items.flatMap((q) =>
    (ctx.uses.get(q.id) ?? []).flatMap((u) =>
      FILTER_MODES.map((mode) => ({ id: `${q.id}|s${u.sample}|${mode}`, question: q.question, keywordText: u.keywordText, filters: mode === 'fixed' ? q.filters : u.inferredFilters })),
    ),
  );
  console.log(`${requests.length} distinct requests; concurrency ${o.concurrency.join(', ')}; each cell at most ${o.maxRequests} requests or ${o.durationMs} ms; embedding delay ${o.embedDelayMs} ms`);
  const started = new Date();
  const samples = await runLoad(
    {
      es: ctx.es,
      dataset: { generationId: ctx.run.target.generationId, passagesIndex: ctx.run.index },
      casesIndex: ctx.casesIndex,
      casesIndexOf: (d, signal) => manifestCasesIndex(ctx.app, d.generationId, d.passagesIndex, { timeoutMs: 2_000, signal }),
      vectors,
      embedding: { model, dims, usdPerMillionTokens: 0 },
    },
    [RETRIEVAL_V1, RETRIEVAL_V2],
    requests,
    o,
    (m) => console.error(m),
  );
  const summary = summarizeLoad(samples);
  const file = writeJson(outDir, `adoption-load-${stamp(started)}.json`, {
    kind: 'eval-retrieval-adoption-load',
    git: gitState(),
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    options: o,
    target: targetIdentity(ctx),
    arms: armIdentities(),
    summary,
    samples,
  });
  for (const r of summary) {
    console.log(
      `  ${r.arm.padEnd(13)} ${String(r.concurrency).padStart(4)}  ok n=${r.ok.n} p50 ${r.ok.p50} p95 ${r.ok.p95} p99 ${r.ok.p99} max ${r.ok.max} ms | cancel->end p95 ${r.cancelAfterAbort.p95} | failure p95 ${r.failure.p95} | mapping(12) p95 ${r.mappingBound.p95} | settlement problems ${r.settlementProblems}`,
    );
  }
  console.log(`report: ${file}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const command = positionals[0];
  if (!command || !['preflight', 'dev', 'load'].includes(command) || !values['scope-samples']) {
    console.error(USAGE);
    return 2;
  }
  const outDir = values['out-dir'] ? resolve(values['out-dir']) : resolve(APP_DIR, 'data/work');
  const ctx = await preflight({
    ...(values['env-files'] ? { envFiles: values['env-files'] } : {}),
    ...(values['keys-file'] ? { keysFile: values['keys-file'] } : {}),
    scopeSamples: values['scope-samples'],
  });
  try {
    if (command === 'preflight') {
      const file = writeJson(outDir, `adoption-preflight-${stamp(new Date())}.json`, { kind: 'eval-retrieval-adoption-preflight', git: gitState(), gridSha256: ctx.gridSha256, preflight: ctx.preflight });
      console.log(`preflight passed: ${ctx.items.length} questions; the cases channel reaches the passages filter's cases for every evaluation and inferred filter`);
      console.log(`report: ${file}`);
      return 0;
    }
    if (command === 'dev') return await cmdDev(ctx, outDir, values['confirm-cost'] === true, values['phase-a'], typeof values.vectors === 'string' ? values.vectors : undefined);
    return await cmdLoad(ctx, outDir, values);
  } finally {
    await ctx.es.close();
    await closeDb(ctx.app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/retrieval/adoption/cli.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(describeWorkerError(err));
      process.exit(1);
    },
  );
}
