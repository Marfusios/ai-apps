/**
 * `pnpm eval:retrieval`: the retrieval evaluation (amendment A13; review gate G5).
 *
 *   pnpm eval:retrieval [--env-files <a,b>] [--dataset <file>] [--sizes 50,100]
 *     [--split all|dev|holdout] [--passages-index <name>] [--out-dir <dir>]
 *     [--confirm-cost | --fake-embedder]
 *
 * - Evaluates the active manifest's passages index, or `--passages-index` (an index
 *   not yet published; its generation comes from its `_meta`).
 * - Embeds each question once with the configured model (`OPENAI_EMBEDDING_MODEL`,
 *   `OPENAI_EMBEDDING_DIMENSIONS`), in requests of at most 96 inputs, metered on the
 *   ledger under `evaluation` (the indexing and evaluation allowance). Without
 *   `--confirm-cost` it prints the token count and the estimated cost and stops: no
 *   paid request. `--fake-embedder` uses free deterministic vectors (a pipeline check:
 *   its vector and hybrid numbers mean nothing).
 * - Writes `data/work/eval-retrieval-<UTC timestamp>.json` with every metric, ranking,
 *   bundle and Elasticsearch body (query vectors elided), and prints Recall@20 and
 *   evidence coverage for keyword, vector and hybrid at each size.
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
import { closeDb, createDb } from '../../server/db/client.js';
import { getActiveManifest } from '../../server/db/generations.js';
import { createEsClient } from '../../server/search/es.js';
import { CANDIDATE_STAGE_PER_CHANNEL, RETRIEVAL_DEFAULTS, numCandidates, type RetrievalDataset } from '../../server/search/hybrid.js';
import { readIndexMeta } from '../../server/search/index-meta.js';
import { countTokens } from '../../server/ai/tokens.js';
import { APP_DIR } from '../../worker/config.js';
import { batchByLimits, createFakeEmbedder, createOpenAIEmbedder, embeddingUsdPerMillion, reservationUsd } from '../../worker/index/embed.js';
import { createLedgerSpendGate } from '../../worker/index/spend-gate.js';
import { describeWorkerError } from '../../worker/errors.js';
import { DEFAULT_DATASET } from './build-silver.js';
import { evalConfig } from './config.js';
import { MODES, evaluateRetrieval, type EvaluationResult } from './evaluate.js';
import { DatasetSchema, datasetProblems, type Dataset } from './silver.js';

const USAGE =
  'usage: pnpm eval:retrieval [--env-files <a,b>] [--dataset <file>] [--sizes 50,100] [--split all|dev|holdout] ' +
  '[--passages-index <name>] [--out-dir <dir>] [--confirm-cost | --fake-embedder]';

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

function pct(x: number | undefined): string {
  return x === undefined ? '   -  ' : `${(x * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(r: EvaluationResult): void {
  for (const group of ['all', 'dev', 'holdout']) {
    const n = r.summary[String(r.sizes[0])]?.hybrid[group]?.questions ?? 0;
    if (n === 0) continue;
    console.log(`\n${group} (${n} questions)`);
    console.log('  per channel  mode      R@20    R@10    R@6     full@20  bundle: cases  causes  any');
    for (const size of r.sizes) {
      for (const mode of MODES) {
        const a = r.summary[String(size)]?.[mode][group];
        if (!a) continue;
        console.log(
          `  ${String(size).padStart(11)}  ${mode.padEnd(8)} ${pct(a.recallAt20)} ${pct(a.recallAt10)} ${pct(a.recallAt6)} ${pct(a.fullRecallAt20)}  ${pct(a.coverageCases)}      ${pct(a.coverageCauses)} ${pct(a.anyInBundle)}`,
        );
      }
    }
  }
  const largest = String(r.sizes.at(-1));
  const tags = Object.keys(r.summary[largest]?.hybrid ?? {}).filter((g) => g.startsWith('tag:'));
  if (tags.length > 0) {
    console.log(`\nby tag, ${largest} per channel (R@20 keyword / vector / hybrid; hybrid bundle coverage)`);
    for (const tag of tags) {
      const s = r.summary[largest];
      console.log(
        `  ${tag.slice(4).padEnd(20)} ${String(s?.hybrid[tag]?.questions).padStart(3)}  ${pct(s?.keyword[tag]?.recallAt20)} ${pct(s?.vector[tag]?.recallAt20)} ${pct(s?.hybrid[tag]?.recallAt20)}  ${pct(s?.hybrid[tag]?.coverageCases)}`,
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

  const config = evalConfig(values['env-files']);
  const datasetPath = values.dataset ? resolve(values.dataset) : DEFAULT_DATASET;
  const raw = readFileSync(datasetPath, 'utf8');
  const dataset: Dataset = DatasetSchema.parse(JSON.parse(raw));
  for (const p of datasetProblems(dataset)) console.warn(`dataset: ${p}`);
  const items = dataset.questions.filter((q) => split === 'all' || q.split === split);

  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  const price = embeddingUsdPerMillion(model);
  const inputs = [...new Set(items.map((q) => queryEmbeddingInput(q.question)))];
  const inputTokens = inputs.reduce((n, t) => n + countTokens(t), 0);
  const batches = batchByLimits(inputs, countTokens);
  const reserve = batches.reduce((sum, b) => sum + reservationUsd(b.reduce((n, t) => n + countTokens(t), 0), price), 0);
  console.log(
    `${items.length} questions (${split}), ${inputs.length} query embeddings, ${inputTokens} tokens with ${model}/${dims}: ` +
      `about $${((inputTokens * price) / 1e6).toFixed(6)} (reserve $${reserve.toFixed(6)}), ${batches.length} request(s)`,
  );
  if (!values['confirm-cost'] && !values['fake-embedder']) {
    console.log('nothing embedded: run with --confirm-cost to evaluate (or --fake-embedder for a free pipeline check)');
    return 0;
  }

  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the active manifest)');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-retrieval' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
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
    const meta = await readIndexMeta(es, target.passagesIndex as string);
    if (target.generationId !== dataset.source.generationId) {
      console.warn(`warning: the silver set was built from generation ${dataset.source.generationId}; evaluating generation ${target.generationId}`);
    }

    const started = new Date();
    const vectors = new Map<string, Float32Array>();
    let embedder: Embedder;
    let billed = { tokens: 0, usd: 0, requests: 0 };
    if (values['fake-embedder']) {
      // Named like the index's model so the index check passes; the vectors are noise.
      const fake = createFakeEmbedder(dims, meta.embeddingModel ?? model);
      for (const batch of batches) {
        const res = await fake.embed(batch);
        batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
      }
      embedder = precomputedEmbedder({ model: fake.model, dims, usdPerMillionTokens: 0 }, vectors);
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
          billed = { tokens: billed.tokens + res.tokens, usd: billed.usd + (res.tokens * price) / 1e6, requests: billed.requests + 1 };
        }
      } finally {
        await closeDb(ingest);
      }
      embedder = precomputedEmbedder({ model, dims, usdPerMillionTokens: price }, vectors);
    }

    const result = await evaluateRetrieval(es, embedder, target, items, { sizes, log: (m) => console.error(m) });
    const finished = new Date();
    const report = {
      kind: 'eval-retrieval',
      version: 1,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      dataset: {
        file: datasetPath.startsWith(APP_DIR) ? datasetPath.slice(APP_DIR.length + 1) : 'external',
        sha256: createHash('sha256').update(raw).digest('hex'),
        version: dataset.version,
        builtFromGeneration: dataset.source.generationId,
        rulesSha256: dataset.source.rulesSha256,
        split,
        questions: items.length,
        adjudication: dataset.adjudication,
      },
      index: {
        passagesIndex: target.passagesIndex,
        generationId: target.generationId,
        indexVersion: meta.indexVersion,
        fingerprint: meta.fingerprint,
        buildId: meta.buildId,
        embeddingModel: meta.embeddingModel,
        embeddingDims: meta.embeddingDims,
      },
      embedder: {
        kind: values['fake-embedder'] ? 'fake' : 'openai',
        model: embedder.model,
        dims,
        inputs: inputs.length,
        countedTokens: inputTokens,
        billed,
      },
      params: {
        live: { ...RETRIEVAL_DEFAULTS, numCandidates: numCandidates(RETRIEVAL_DEFAULTS) },
        sizes: sizes.map((s) => ({ perChannel: s, numCandidates: numCandidates({ perChannel: s, numCandidatesFactor: RETRIEVAL_DEFAULTS.numCandidatesFactor }) })),
        candidateStage: CANDIDATE_STAGE_PER_CHANNEL,
      },
      metrics: {
        recall: 'case recall@k on the case-candidate ranking: expected cases in the first k unique cases / min(|expected|, k)',
        coverage: 'bundle coverage: expected cases with a passage in the packed bundle (cases) and with their probable cause too (causes), / min(|expected|, maxCases)',
      },
      summary: result.summary,
      questions: result.questions,
    };
    const outDir = values['out-dir'] ? resolve(values['out-dir']) : resolve(APP_DIR, 'data/work');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `eval-retrieval-${stamp(started)}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(result);
    console.log(`\nquery embeddings: ${billed.requests} request(s), ${billed.tokens} billed tokens, $${billed.usd.toFixed(6)}`);
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
