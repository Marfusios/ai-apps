/**
 * `pnpm eval:checker retrieve`: the calibration's real retrieval bundles (Task 16c).
 *
 * Read-only against the target: the active manifest (PostgreSQL as `aviation_app`), the
 * passages index (Elasticsearch with the read key), the canonical passages and case
 * summaries for `verifyBundle`. The only writes are the evaluation ledger's reservations
 * for the query embeddings (`DATABASE_INGEST_URL`, category `evaluation`). Without
 * `--confirm-cost` it prints the embedding plan and pays nothing.
 *
 * Each question is retrieved exactly as a brief retrieves (`createHybridRetriever` under
 * the configured retrieval version, `AVIATION_RETRIEVAL_VERSION`, recorded in the file's
 * `source.retrievalVersion`; no filters), the bundle is checked fail closed like the
 * pipeline's (`verifyBundle`), and the result is written to `evidence.json` (or `--out`).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { countTokens } from '../../server/ai/tokens.js';
import { createCaseCatalog } from '../../server/briefs/catalog.js';
import { verifyBundle } from '../../server/briefs/pipeline.js';
import { createHybridRetriever } from '../../server/briefs/retriever.js';
import { closeDb, createDb } from '../../server/db/client.js';
import { getActiveManifest, manifestCasesIndex } from '../../server/db/generations.js';
import { createEsClient } from '../../server/search/es.js';
import { retrievalConfig } from '../../server/search/retrieval-config.js';
import type { AppConfig } from '../../shared/config.js';
import { APP_DIR } from '../../worker/config.js';
import { batchByLimits, createOpenAIEmbedder, embeddingUsdPerMillion, reservationUsd } from '../../worker/index/embed.js';
import { createLedgerSpendGate } from '../../worker/index/spend-gate.js';
import { precomputedEmbedder } from '../retrieval/run.js';
import { EvidenceFileSchema, sha256, type EvidenceFile } from './evidence.js';
import { QUESTIONS, type CalibrationQuestion } from './questions.js';

export const DEFAULT_EVIDENCE = resolve(APP_DIR, 'evals/checker/evidence.json');

export async function retrieveEvidence(
  config: AppConfig,
  opts: { confirmCost: boolean; out: string; questions?: readonly CalibrationQuestion[]; log: (m: string) => void },
): Promise<number> {
  const questions = opts.questions ?? QUESTIONS;
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  const price = embeddingUsdPerMillion(model);
  const inputs = [...new Set(questions.map((q) => queryEmbeddingInput(q.question)))];
  const tokens = inputs.reduce((n, t) => n + countTokens(t), 0);
  const batches = batchByLimits(inputs, countTokens);
  const reserve = batches.reduce((sum, b) => sum + reservationUsd(b.reduce((n, t) => n + countTokens(t), 0), price), 0);
  opts.log(`${questions.length} questions, ${inputs.length} query embeddings, ${tokens} tokens with ${model}/${dims}: about $${((tokens * price) / 1e6).toFixed(6)} (reserve $${reserve.toFixed(6)})`);
  if (!opts.confirmCost) {
    opts.log('nothing embedded: run with --confirm-cost to retrieve the bundles');
    return 0;
  }
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the active manifest and canonical passages)');
  if (!config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-checker' });
  const ingest = createDb(config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-checker-ledger' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    const manifest = await getActiveManifest(app);
    if (!manifest?.passagesIndex) throw new Error('no active manifest with a passages index');
    const dataset = { generationId: manifest.generationId, passagesIndex: manifest.passagesIndex };
    const gate = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: 'openai', model, stage: 'embed' });
    const openai = createOpenAIEmbedder({ apiKey: config.ai.openai.apiKey ?? '', model, dims, gate, category: 'evaluation', purpose: 'eval-checker-bundles', log: opts.log });
    const vectors = new Map<string, Float32Array>();
    for (const batch of batches) {
      const res = await openai.embed(batch);
      batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
    }
    const retriever = createHybridRetriever({
      es,
      embedder: precomputedEmbedder({ model, dims, usdPerMillionTokens: price }, vectors),
      retrieval: retrievalConfig(config.retrieval.version),
      casesIndexOf: (d) => manifestCasesIndex(app, d.generationId, d.passagesIndex),
    });
    const catalog = createCaseCatalog(app);
    const bundles: EvidenceFile['bundles'] = [];
    let chunkerVersion = '';
    for (const q of questions) {
      const got = await retriever.retrieve(
        { dataset, text: q.question, keywordText: q.keywordText, filters: {} },
        AbortSignal.timeout(30_000),
        () => undefined,
      );
      chunkerVersion = got.chunkerVersion;
      const verified = await verifyBundle(catalog, dataset.generationId, got.bundle, got.chunkerVersion);
      const byId = new Map(got.bundle.cases.flatMap((c) => c.passages.map((p) => [p.passageId, p] as const)));
      bundles.push({
        question: q.id,
        split: q.split,
        cases: verified.map((vc) => ({
          ntsbNo: vc.ntsbNo,
          rank: vc.rank,
          aircraft: vc.summary.row.aircraft.map((a) => ({ aircraftKey: a.aircraftKey, make: a.make, model: a.model })),
          passages: vc.passages.map((p) => ({
            passageId: p.passageId,
            ntsbNo: vc.ntsbNo,
            role: p.role,
            reserved: p.reserved,
            rank: p.rank,
            sectionKind: p.allowed.sectionKind,
            scope: p.allowed.scope,
            aircraftKey: p.allowed.aircraftKey,
            sectionId: p.allowed.sectionId,
            revisionId: p.allowed.revisionId,
            sectionSha: p.allowed.sha,
            sectionStart: p.allowed.sectionStart,
            text: p.allowed.text,
            textSha: sha256(p.allowed.text),
          })),
        })),
      });
      if (!byId.size) throw new Error(`question ${q.id}: an empty bundle`);
      opts.log(`${q.id}: ${verified.map((c) => `${c.ntsbNo}(${c.passages.length})`).join(' ')}`);
    }
    const file: EvidenceFile = EvidenceFileSchema.parse({
      version: 'checker-evidence-v1',
      source: {
        generationId: dataset.generationId,
        passagesIndex: dataset.passagesIndex,
        chunkerVersion,
        retrievalVersion: retriever.version,
        retrievedAt: new Date().toISOString(),
        note: 'Public NTSB passages of real hybrid-retrieval bundles, checked like the brief pipeline checks them (verifyBundle).',
      },
      bundles,
    });
    writeFileSync(opts.out, `${JSON.stringify(file, null, 2)}\n`);
    opts.log(`wrote ${opts.out}`);
    return 0;
  } finally {
    await es.close();
    await closeDb(app);
    await closeDb(ingest);
  }
}
