/**
 * Steps every retrieval evaluation track shares (`run.ts`): resolving the target
 * passages index and its contract, and re-deriving the dataset's labels on the target
 * generation (`checkTarget`), before anything is embedded; planning the query
 * embeddings, and embedding them up front, free (`--fake-embedder`) or metered on the
 * ledger under `evaluation`. Configuration values are never printed.
 */
import type { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import type { AppConfig } from '../../shared/config.js';
import { queryEmbeddingInput, type Embedder } from '../../server/ai/embeddings.js';
import { countTokens } from '../../server/ai/tokens.js';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { getActiveManifest } from '../../server/db/generations.js';
import type { RetrievalDataset } from '../../server/search/hybrid.js';
import { RETRIEVAL_V1, retrievalConfig, retrievalIdentity } from '../../server/search/retrieval-config.js';
import { IndexMetaError, readIndexMeta, type IndexMeta } from '../../server/search/index-meta.js';
import { PassagesIndexIncompatibleError, checkPassagesIndex, type PassagesContract } from '../../server/search/passages-contract.js';
import { batchByLimits, createFakeEmbedder, createOpenAIEmbedder, embeddingUsdPerMillion, reservationUsd } from '../../worker/index/embed.js';
import { createLedgerSpendGate } from '../../worker/index/spend-gate.js';
import { readGenerationSource, type QuestionLabels, type TargetCheck } from './generation.js';

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

export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function pct(x: number | null | undefined): string {
  return x === undefined || x === null ? '    -  ' : `${(x * 100).toFixed(1).padStart(6)}%`;
}

export interface RunTarget {
  target: RetrievalDataset;
  index: string;
  meta: IndexMeta;
  contract: PassagesContract;
}

/**
 * The passages index to evaluate (the active manifest's, or `passagesIndex` with the
 * generation its `_meta` records) and its contract for the configured embedding.
 * `{ refused }` when the index breaks the contract: the run must stop, nothing embedded.
 */
export async function resolveRunTarget(
  es: Client,
  app: Db,
  passagesIndex: string | undefined,
  embedding: { model: string; dims: number },
): Promise<RunTarget | { refused: string }> {
  let target: RetrievalDataset;
  if (passagesIndex) {
    const meta = await readIndexMeta(es, passagesIndex);
    if (meta.generationId === null) throw new Error(`${meta.index} records no generation`);
    target = { generationId: meta.generationId, passagesIndex: meta.index };
  } else {
    const manifest = await getActiveManifest(app);
    if (!manifest) throw new Error('no dataset manifest is active; pass --passages-index');
    if (!manifest.passagesIndex) throw new Error(`the active manifest (generation ${manifest.generationId}) has no passages index; pass --passages-index`);
    target = { generationId: manifest.generationId, passagesIndex: manifest.passagesIndex };
  }
  const index = target.passagesIndex as string;
  try {
    const { meta, contract } = await checkPassagesIndex(es, index, { generationId: target.generationId, ...embedding }, { timeoutMs: 30_000 });
    return { target, index, meta, contract };
  } catch (err) {
    if (err instanceof PassagesIndexIncompatibleError || err instanceof IndexMetaError) return { refused: err.message };
    throw err;
  }
}

/**
 * The target generation's identity and every question's labels re-derived there by
 * `rederive` (its own read-only snapshot), read with `databaseUrl` (the app role).
 * `targetProblems` compares them with the dataset; nothing is written.
 */
export async function checkTarget(
  databaseUrl: string,
  generationId: number,
  rederive: (client: pg.ClientBase) => Promise<{ labels: ReadonlyMap<string, QuestionLabels>; warnings?: string[] }>,
): Promise<TargetCheck & { ms: number }> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'aviation-eval-verify' });
  await client.connect();
  const started = Date.now();
  try {
    const source = await readGenerationSource(client, generationId);
    const { labels, warnings } = await rederive(client);
    return { source, labels, warnings: warnings ?? [], ms: Date.now() - started };
  } finally {
    await client.end();
  }
}

export interface EmbeddingPlan {
  model: string;
  dims: number;
  usdPerMillionTokens: number;
  /** Distinct query embedding inputs. */
  inputs: string[];
  inputTokens: number;
  batches: string[][];
  /** The reservations the ledger takes, all requests together. */
  reserveUsd: number;
}

/** Each distinct question embedded once, in requests within the provider limits. */
export function planQueryEmbeddings(questions: readonly string[], model: string, dims: number): EmbeddingPlan {
  const usdPerMillionTokens = embeddingUsdPerMillion(model);
  const inputs = [...new Set(questions.map((q) => queryEmbeddingInput(q)))];
  const batches = batchByLimits(inputs, countTokens);
  return {
    model,
    dims,
    usdPerMillionTokens,
    inputs,
    inputTokens: inputs.reduce((n, t) => n + countTokens(t), 0),
    batches,
    reserveUsd: batches.reduce((sum, b) => sum + reservationUsd(b.reduce((n, t) => n + countTokens(t), 0), usdPerMillionTokens), 0),
  };
}

/** "N query embeddings, T tokens with model/dims: about $x (reserve $y), B request(s)". */
export function describePlan(p: EmbeddingPlan): string {
  return (
    `${p.inputs.length} query embeddings, ${p.inputTokens} tokens with ${p.model}/${p.dims}: ` +
    `about $${((p.inputTokens * p.usdPerMillionTokens) / 1e6).toFixed(6)} (reserve $${p.reserveUsd.toFixed(6)}), ${p.batches.length} request(s)`
  );
}

export interface Billed {
  tokens: number;
  usd: number;
  requests: number;
  /** Requests without a usage report, charged in full. */
  uncertain: number;
}

/**
 * Embed every planned input up front: fake vectors (free, `fake`), or the configured
 * OpenAI model metered on the ledger under `evaluation` (`DATABASE_INGEST_URL`) with
 * `purpose`. Returns an embedder that answers from those vectors.
 */
export async function embedPlan(
  plan: EmbeddingPlan,
  opts: { fake: boolean; config: AppConfig; purpose: string; log: (message: string) => void },
): Promise<{ embedder: Embedder; billed: Billed }> {
  const vectors = new Map<string, Float32Array>();
  let billed: Billed = { tokens: 0, usd: 0, requests: 0, uncertain: 0 };
  if (opts.fake) {
    const f = createFakeEmbedder(plan.dims, plan.model);
    for (const batch of plan.batches) {
      const res = await f.embed(batch);
      batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
    }
    return { embedder: precomputedEmbedder({ model: plan.model, dims: plan.dims, usdPerMillionTokens: 0 }, vectors), billed };
  }
  if (!opts.config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  const ingest = createDb(opts.config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-retrieval-ledger' });
  try {
    const gate = createLedgerSpendGate(ingest, { budgets: opts.config.ai.budgets, provider: 'openai', model: plan.model, stage: 'embed' });
    const openai = createOpenAIEmbedder({
      apiKey: opts.config.ai.openai.apiKey ?? '',
      model: plan.model,
      dims: plan.dims,
      gate,
      category: 'evaluation',
      purpose: opts.purpose,
      log: opts.log,
    });
    for (const batch of plan.batches) {
      const res = await openai.embed(batch);
      batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
      billed = {
        tokens: billed.tokens + res.tokens,
        usd: billed.usd + (res.tokens * plan.usdPerMillionTokens) / 1e6,
        requests: billed.requests + 1,
        uncertain: billed.uncertain + (res.usageUncertain ? 1 : 0),
      };
    }
  } finally {
    await closeDb(ingest);
  }
  return { embedder: precomputedEmbedder({ model: plan.model, dims: plan.dims, usdPerMillionTokens: plan.usdPerMillionTokens }, vectors), billed };
}

/** The index metadata a report records. */
export function indexReport(t: RunTarget): Record<string, unknown> {
  return {
    passagesIndex: t.index,
    generationId: t.target.generationId,
    indexVersion: t.meta.indexVersion,
    eventAircraftQualification: t.contract.eventAircraftQualification,
    fingerprint: t.meta.fingerprint,
    buildId: t.meta.buildId,
    chunkerVersion: t.meta.chunkerVersion,
    inputTemplateVersion: t.meta.inputTemplateVersion,
    embeddingModel: t.meta.embeddingModel,
    embeddingDims: t.meta.embeddingDims,
  };
}

/**
 * What a report records about retrieval (task 10e): the keyword, vector and hybrid modes
 * of these evaluations are built on `retrieval.v1`'s passage channels and passage-level
 * fusion, but with BM25 on the question text (not the scope stage's keyword text) and the
 * passages per channel in `params.sizes`, so they are not that frozen configuration and
 * carry no sha256 of their own: `measured.basedOn` names the version they derive from.
 * `configured` is the version the settings select (`AVIATION_RETRIEVAL_VERSION`).
 */
export function retrievalReport(config: AppConfig): Record<string, unknown> {
  return {
    measured: {
      basedOn: retrievalIdentity(RETRIEVAL_V1),
      stage: 'passage channels and passage-level fusion',
      keywordText: 'question',
      passagesPerChannel: 'params.sizes',
    },
    configured: retrievalIdentity(retrievalConfig(config.retrieval.version)),
  };
}
