/**
 * `pnpm eval:retrieval`: the retrieval evaluation (amendment A13; review gate G5).
 *
 *   pnpm eval:retrieval [--env-files <a,b>] [--dataset <file>] [--sizes 50,100]
 *     [--split all|dev|holdout] [--passages-index <name>] [--out-dir <dir>]
 *     [--confirm-cost | --fake-embedder] [--exploratory]
 *
 * **Fails closed.** Before anything is embedded it validates the dataset
 * (`datasetProblems`), resolves the target (the active manifest's passages index, or
 * `--passages-index`, whose generation comes from its `_meta`), requires that the
 * target generation is the one the silver set was built from, and checks the passages
 * contract for the configured embedding model and dimensions. Any problem stops the
 * run (exit 1) with nothing paid. `--exploratory` continues past dataset problems and
 * a generation mismatch, and the report is then marked `gating: false`; an index that
 * breaks the contract always stops the run (retrieval would refuse it). A
 * `--fake-embedder` run is never gating either.
 *
 * - Embeds each RAG question once with the configured model (`OPENAI_EMBEDDING_MODEL`,
 *   `OPENAI_EMBEDDING_DIMENSIONS`), in requests of at most 96 inputs, metered on the
 *   ledger under `evaluation`. Without `--confirm-cost` it prints the token count and
 *   the estimated cost after the checks and stops: no paid request. `--fake-embedder`
 *   uses free deterministic vectors (a pipeline check: its vector and hybrid numbers
 *   mean nothing).
 * - Questions of the `structured` section are not run (they belong to a structured or
 *   combined evaluation).
 * - Writes `data/work/eval-retrieval-<UTC timestamp>.json` with every metric, ranking,
 *   bundle and Elasticsearch body (query vectors elided), and prints candidate recall
 *   and the bundle metrics for keyword, vector and hybrid at each size.
 *
 * Connects with `DATABASE_URL` (the active manifest), `ELASTICSEARCH_READ_API_KEY`
 * and, for paid embeddings, `DATABASE_INGEST_URL` (the ledger). Values are never
 * printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { queryEmbeddingInput, type Embedder } from '../../server/ai/embeddings.js';
import { countTokens } from '../../server/ai/tokens.js';
import { closeDb, createDb } from '../../server/db/client.js';
import { getActiveManifest } from '../../server/db/generations.js';
import { createEsClient } from '../../server/search/es.js';
import { CANDIDATE_STAGE_PER_CHANNEL, RETRIEVAL_DEFAULTS, numCandidates, type RetrievalDataset } from '../../server/search/hybrid.js';
import { IndexMetaError, readIndexMeta, type IndexMeta } from '../../server/search/index-meta.js';
import { PassagesIndexIncompatibleError, checkPassagesIndex } from '../../server/search/passages-contract.js';
import { APP_DIR } from '../../worker/config.js';
import { describeWorkerError } from '../../worker/errors.js';
import { batchByLimits, createFakeEmbedder, createOpenAIEmbedder, embeddingUsdPerMillion, reservationUsd } from '../../worker/index/embed.js';
import { createLedgerSpendGate } from '../../worker/index/spend-gate.js';
import { DEFAULT_DATASET } from './build-silver.js';
import { evalConfig } from './config.js';
import { MODES, evaluateRetrieval, type EvaluationResult } from './evaluate.js';
import { DatasetSchema, datasetProblems, type Dataset } from './silver.js';

const USAGE =
  'usage: pnpm eval:retrieval [--env-files <a,b>] [--dataset <file>] [--sizes 50,100] [--split all|dev|holdout] ' +
  '[--passages-index <name>] [--out-dir <dir>] [--confirm-cost | --fake-embedder] [--exploratory]';

/** An embedder answering from vectors computed up front (each question is embedded once). */
export function precomputedEmbedder(base: Pick<Embedder, 'model' | 'dims' | 'usdPerMillionTokens'>, vectors: ReadonlyMap<string, Float32Array>): Embedder {
  return {
    model: base.model,
    dims: base.dims,
    usdPerMillionTokens: base.usdPerMillionTokens,
    async embed(texts) {
      const out = texts.map((t) => {
        const v = vectors.get(t);
        if (!v) throw new Error('a query was not embedded up front');
        return v;
      });
      // Usage was paid (and reported) when the batch was embedded; per query it is its token count.
      return { vectors: out, tokens: texts.reduce((n, t) => n + countTokens(t), 0) };
    },
  };
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function pct(x: number | null | undefined): string {
  return x === undefined || x === null ? '    -  ' : `${(x * 100).toFixed(1).padStart(6)}%`;
}

function printSummary(r: EvaluationResult): void {
  for (const group of ['all', 'dev', 'holdout', 'tag:paraphrase']) {
    const n = r.summary[String(r.sizes[0])]?.hybrid[group]?.questions ?? 0;
    if (n === 0) continue;
    console.log(`\n${group === 'tag:paraphrase' ? 'paraphrases only' : group} (${n} questions)`);
    console.log('  per channel  mode      candidates:  R@20     R@10     R@6  | bundle: cases evidence  precision  nDCG@6   any   causes(structural)');
    for (const size of r.sizes) {
      for (const mode of MODES) {
        const a = r.summary[String(size)]?.[mode][group];
        if (!a) continue;
        console.log(
          `  ${String(size).padStart(11)}  ${mode.padEnd(8)}          ${pct(a.recallAt20)} ${pct(a.recallAt10)} ${pct(a.recallAt6)} |  ${pct(a.coverageCases)} ${pct(a.coverageEvidence)} ${pct(a.bundlePrecision)} ${pct(a.ndcg6)} ${pct(a.anyInBundle)} ${pct(a.coverageCausesStructural)}`,
        );
      }
    }
  }
  for (const size of r.sizes.map(String)) {
    const tags = Object.keys(r.summary[size]?.hybrid ?? {}).filter((g) => g.startsWith('tag:'));
    if (tags.length === 0) continue;
    console.log(`\nby tag, ${size} per channel: R@20 keyword / vector / hybrid; hybrid bundle cases / evidence`);
    for (const tag of tags) {
      const s = r.summary[size];
      console.log(
        `  ${tag.slice(4).padEnd(20)} ${String(s?.hybrid[tag]?.questions).padStart(3)}  ${pct(s?.keyword[tag]?.recallAt20)} ${pct(s?.vector[tag]?.recallAt20)} ${pct(s?.hybrid[tag]?.recallAt20)}  ${pct(s?.hybrid[tag]?.coverageCases)} ${pct(s?.hybrid[tag]?.coverageEvidence)}`,
      );
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'env-files': { type: 'string' },
      dataset: { type: 'string' },
      sizes: { type: 'string' },
      split: { type: 'string' },
      'passages-index': { type: 'string' },
      'out-dir': { type: 'string' },
      'confirm-cost': { type: 'boolean' },
      'fake-embedder': { type: 'boolean' },
      exploratory: { type: 'boolean' },
    },
    strict: true,
  });
  if (values['confirm-cost'] && values['fake-embedder']) {
    console.error(USAGE);
    return 2;
  }
  const sizes = (values.sizes ?? `${RETRIEVAL_DEFAULTS.perChannel},${CANDIDATE_STAGE_PER_CHANNEL}`).split(',').map((s) => Number(s.trim()));
  if (sizes.length === 0 || sizes.some((s) => !Number.isSafeInteger(s) || s < 1 || s > 200)) {
    console.error(USAGE);
    return 2;
  }
  const split = values.split ?? 'all';
  if (!['all', 'dev', 'holdout'].includes(split)) {
    console.error(USAGE);
    return 2;
  }
  const exploratory = values.exploratory === true;
  const fake = values['fake-embedder'] === true;

  const config = evalConfig(values['env-files']);
  const datasetPath = values.dataset ? resolve(values.dataset) : DEFAULT_DATASET;
  const raw = readFileSync(datasetPath, 'utf8');
  const parsed = DatasetSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 20)) console.error(`dataset: ${i.path.join('.')}: ${i.message}`);
    console.error('the dataset does not parse; nothing embedded');
    return 1;
  }
  const dataset: Dataset = parsed.data;
  const problems = datasetProblems(dataset).map((p) => `dataset: ${p}`);
  const items = dataset.questions.filter((q) => q.section === 'rag' && (split === 'all' || q.split === split));
  const structured = dataset.questions.filter((q) => q.section === 'structured').length;
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;

  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the active manifest)');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-retrieval' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    // Target and passages contract, before anything is embedded.
    let target: RetrievalDataset;
    if (values['passages-index']) {
      const meta = await readIndexMeta(es, values['passages-index']);
      if (meta.generationId === null) throw new Error(`${meta.index} records no generation`);
      target = { generationId: meta.generationId, passagesIndex: meta.index };
    } else {
      const manifest = await getActiveManifest(app);
      if (!manifest) throw new Error('no dataset manifest is active; pass --passages-index');
      if (!manifest.passagesIndex) throw new Error(`the active manifest (generation ${manifest.generationId}) has no passages index; pass --passages-index`);
      target = { generationId: manifest.generationId, passagesIndex: manifest.passagesIndex };
    }
    const index = target.passagesIndex as string;
    let meta: IndexMeta;
    try {
      meta = await checkPassagesIndex(es, index, { generationId: target.generationId, model, dims }, { timeoutMs: 30_000 });
    } catch (err) {
      if (err instanceof PassagesIndexIncompatibleError || err instanceof IndexMetaError) {
        console.error(`${err.message}; nothing embedded`);
        return 1;
      }
      throw err;
    }
    if (target.generationId !== dataset.source.generationId) {
      problems.push(`generation: the silver set was built from generation ${dataset.source.generationId}; the target is generation ${target.generationId}`);
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      if (!exploratory) {
        console.error('the run would not be a valid gate run; nothing embedded (--exploratory runs anyway, marked non-gating)');
        return 1;
      }
    }
    const gating = !exploratory && !fake && problems.length === 0;
    const reasons = [...problems, ...(exploratory ? ['--exploratory'] : []), ...(fake ? ['--fake-embedder'] : [])];
    if (!gating) console.warn(`NON-GATING run (${reasons.join('; ')}): its numbers cannot lock retrieval defaults`);

    const price = embeddingUsdPerMillion(model);
    const inputs = [...new Set(items.map((q) => queryEmbeddingInput(q.question)))];
    const inputTokens = inputs.reduce((n, t) => n + countTokens(t), 0);
    const batches = batchByLimits(inputs, countTokens);
    const reserve = batches.reduce((sum, b) => sum + reservationUsd(b.reduce((n, t) => n + countTokens(t), 0), price), 0);
    console.log(
      `${items.length} RAG questions (${split}; ${structured} structured questions not run), ${inputs.length} query embeddings, ` +
        `${inputTokens} tokens with ${model}/${dims}: about $${((inputTokens * price) / 1e6).toFixed(6)} (reserve $${reserve.toFixed(6)}), ` +
        `${batches.length} request(s); index ${index} (generation ${target.generationId}) meets the passages contract`,
    );
    if (!values['confirm-cost'] && !fake) {
      console.log('nothing embedded: run with --confirm-cost to evaluate (or --fake-embedder for a free, non-gating pipeline check)');
      return 0;
    }

    const started = new Date();
    const vectors = new Map<string, Float32Array>();
    let embedder: Embedder;
    let billed = { tokens: 0, usd: 0, requests: 0, uncertain: 0 };
    if (fake) {
      const f = createFakeEmbedder(dims, model);
      for (const batch of batches) {
        const res = await f.embed(batch);
        batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
      }
      embedder = precomputedEmbedder({ model, dims, usdPerMillionTokens: 0 }, vectors);
      console.warn('warning: fake embeddings; vector and hybrid numbers are meaningless');
    } else {
      if (!config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
      const ingest = createDb(config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-retrieval-ledger' });
      try {
        const gate = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: 'openai', model, stage: 'embed' });
        const openai = createOpenAIEmbedder({
          apiKey: config.ai.openai.apiKey ?? '',
          model,
          dims,
          gate,
          category: 'evaluation',
          purpose: `eval-retrieval-${stamp(started)}`,
          log: (m) => console.error(m),
        });
        for (const batch of batches) {
          const res = await openai.embed(batch);
          batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
          billed = {
            tokens: billed.tokens + res.tokens,
            usd: billed.usd + (res.tokens * price) / 1e6,
            requests: billed.requests + 1,
            uncertain: billed.uncertain + (res.usageUncertain ? 1 : 0),
          };
        }
      } finally {
        await closeDb(ingest);
      }
      embedder = precomputedEmbedder({ model, dims, usdPerMillionTokens: price }, vectors);
    }

    const result = await evaluateRetrieval(es, embedder, target, items, { sizes, log: (m) => console.error(m) });
    const finished = new Date();
    const groups = new Map<string, number>();
    for (const q of dataset.questions) groups.set(q.group, (groups.get(q.group) ?? 0) + 1);
    const report = {
      kind: 'eval-retrieval',
      version: 2,
      gating,
      nonGatingReasons: gating ? [] : reasons,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      dataset: {
        file: datasetPath.startsWith(APP_DIR) ? datasetPath.slice(APP_DIR.length + 1) : 'external',
        sha256: createHash('sha256').update(raw).digest('hex'),
        version: dataset.version,
        builtFromGeneration: dataset.source.generationId,
        rulesSha256: dataset.source.rulesSha256,
        split,
        ragQuestions: items.length,
        structuredQuestionsNotRun: structured,
        paraphrases: items.filter((q) => q.paraphrase_of !== undefined).length,
        groups: Object.fromEntries([...groups.entries()].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))),
        adjudication: dataset.adjudication,
      },
      index: {
        passagesIndex: index,
        generationId: target.generationId,
        indexVersion: meta.indexVersion,
        fingerprint: meta.fingerprint,
        buildId: meta.buildId,
        chunkerVersion: meta.chunkerVersion,
        inputTemplateVersion: meta.inputTemplateVersion,
        embeddingModel: meta.embeddingModel,
        embeddingDims: meta.embeddingDims,
      },
      embedder: { kind: fake ? 'fake' : 'openai', model, dims, inputs: inputs.length, countedTokens: inputTokens, billed },
      params: {
        live: { ...RETRIEVAL_DEFAULTS, numCandidates: numCandidates(RETRIEVAL_DEFAULTS) },
        sizes: sizes.map((s) => ({ perChannel: s, numCandidates: numCandidates({ perChannel: s, numCandidatesFactor: RETRIEVAL_DEFAULTS.numCandidatesFactor }) })),
        candidateStage: CANDIDATE_STAGE_PER_CHANNEL,
      },
      metrics: {
        recall: 'candidate case recall@k: expected cases in the first k unique cases / min(|expected|, k)',
        coverageCases: 'bundle: expected cases with a passage in the bundle / min(|expected|, maxCases)',
        coverageEvidence:
          'bundle: expected cases whose bundle passages satisfy the question\'s own text criterion (every text rule matched by a passage of its section kinds) / min(|expected|, maxCases); questions without a text criterion are left out',
        coverageCausesStructural: 'bundle: expected cases with their probable cause in the bundle; equals case coverage while packing attaches every cause',
        bundlePrecision: 'bundle cases that are expected / bundle cases',
        ndcg6: 'binary-relevance nDCG over the bundle cases in rank order, ideal = min(|expected|, 6) expected cases',
      },
      summary: result.summary,
      questions: result.questions,
    };
    const outDir = values['out-dir'] ? resolve(values['out-dir']) : resolve(APP_DIR, 'data/work');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `eval-retrieval-${stamp(started)}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(result);
    console.log(`\nquery embeddings: ${billed.requests} request(s), ${billed.tokens} billed tokens, $${billed.usd.toFixed(6)}${billed.uncertain ? ` (${billed.uncertain} without a usage report: charged in full)` : ''}`);
    if (!gating) console.warn(`NON-GATING report (${reasons.join('; ')})`);
    console.log(`report: ${file}`);
    return 0;
  } finally {
    await es.close();
    await closeDb(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/retrieval/run.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(describeWorkerError(err));
      process.exit(1);
    },
  );
}
