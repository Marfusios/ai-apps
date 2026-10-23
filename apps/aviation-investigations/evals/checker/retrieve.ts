/**
 * `pnpm eval:checker retrieve`: the calibration's real retrieval bundles (Tasks 16c, 16d),
 * and `pnpm eval:checker headers`: the case headers of every calibration case (Task 16d).
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
 * pipeline's (`verifyBundle`), and the result is written to `evidence.json` (`--questions
 * v1`, Task 16c, frozen) or into `evidence-16d.json` (`--questions 16d`: the bundles, with
 * each case's header line from `caseHeader`). A 16d bundle with a case of a 16c split is
 * reported: the held-out set must not use it. Both frozen files were retrieved before
 * retrieval versions existed (no `source.retrievalVersion`: `retrieval.v1`); reproducing
 * them needs `AVIATION_RETRIEVAL_VERSION=retrieval.v1`.
 *
 * `--questions 16e` (Task 16e, `retrieveEvidenceV3`): the 16e questions under `retrieval.v2`
 * only (refused under any other configured version), through the stages the brief
 * retriever runs (`retrieveCandidatesWith`, then `fetchAndPack`), so that each case's
 * channel ranks (keyword, vector, cases index) and whether its passages were mapped are
 * recorded with it, into `evidence-16e.json` (`checker-evidence-v3`). A case of any earlier
 * split is reported (the builder refuses such a bundle for the held-out set). The query
 * embeddings are charged to the 16e allocation (`run.v3.ts`) as well as the ledger.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { countTokens } from '../../server/ai/tokens.js';
import { createCaseCatalog } from '../../server/briefs/catalog.js';
import { verifyBundle } from '../../server/briefs/pipeline.js';
import { checkHeader } from '../../server/briefs/render.js';
import { createHybridRetriever, fitQueryText, toEvidenceBundle } from '../../server/briefs/retriever.js';
import { retrieveCandidatesWith } from '../../server/search/case-retrieval.js';
import { fetchAndPack } from '../../server/search/hybrid.js';
import { closeDb, createDb } from '../../server/db/client.js';
import { getActiveManifest, manifestCasesIndex } from '../../server/db/generations.js';
import { createEsClient } from '../../server/search/es.js';
import { retrievalConfig } from '../../server/search/retrieval-config.js';
import type { AppConfig } from '../../shared/config.js';
import { APP_DIR } from '../../worker/config.js';
import { batchByLimits, createOpenAIEmbedder, embeddingUsdPerMillion, reservationUsd } from '../../worker/index/embed.js';
import { createLedgerSpendGate } from '../../worker/index/spend-gate.js';
import { precomputedEmbedder } from '../retrieval/run.js';
import { EvidenceFileSchema, EvidenceV2FileSchema, EvidenceV3FileSchema, sha256, type EvidenceFile, type EvidenceV2File, type EvidenceV3File } from './evidence.js';
import { QUESTIONS, QUESTIONS_16D, QUESTIONS_16E, type CalibrationQuestion } from './questions.js';
import { appendAllocation, lockAllocation } from './run.v3.js';

export const DEFAULT_EVIDENCE = {
  v1: resolve(APP_DIR, 'evals/checker/evidence.json'),
  '16d': resolve(APP_DIR, 'evals/checker/evidence-16d.json'),
  '16e': resolve(APP_DIR, 'evals/checker/evidence-16e.json'),
} as const;

/** The 16d evidence file, or an empty one. */
function readV2(path: string, source: EvidenceV2File['source']): EvidenceV2File {
  if (!existsSync(path)) return { version: 'checker-evidence-v2', source, headers: {}, bundles: [] };
  return EvidenceV2FileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Write the 16d evidence file with sorted headers. */
function writeV2(path: string, file: EvidenceV2File): void {
  const headers = Object.fromEntries(Object.entries(file.headers).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify(EvidenceV2FileSchema.parse({ ...file, headers }), null, 2)}\n`);
}

/**
 * `headers`: the check header (`checkHeader`: aircraft, place and date) of every case of the calibration evidence (the
 * 16c bundles and the 16d ones), from the canonical case summaries of the evidence's
 * generation, read-only, into `evidence-16d.json`.
 */
export async function headersCommand(config: AppConfig, opts: { out?: string; log: (m: string) => void }): Promise<number> {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the canonical case summaries)');
  const v1 = EvidenceFileSchema.parse(JSON.parse(readFileSync(DEFAULT_EVIDENCE.v1, 'utf8')));
  const out = opts.out ?? DEFAULT_EVIDENCE['16d'];
  const v2 = readV2(out, { ...v1.source, retrievedAt: new Date().toISOString(), note: 'Case headers (caseHeader of the canonical case summaries) and the Task 16d bundles.' });
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-checker' });
  try {
    const catalog = createCaseCatalog(app);
    const headers: Record<string, string> = { ...v2.headers };
    for (const [generation, numbers] of [
      [v1.source.generationId, v1.bundles.flatMap((b) => b.cases.map((c) => c.ntsbNo))],
      [v2.source.generationId, v2.bundles.flatMap((b) => b.cases.map((c) => c.ntsbNo))],
    ] as const) {
      if (numbers.length === 0) continue;
      const summaries = await catalog.summaries(generation, numbers);
      for (const n of numbers) {
        const s = summaries.get(n);
        if (!s) throw new Error(`no case summary for ${n} in generation ${generation}`);
        headers[n] = checkHeader(s);
      }
    }
    writeV2(out, { ...v2, headers });
    opts.log(`${Object.keys(headers).length} case headers in ${out}`);
    return 0;
  } finally {
    await closeDb(app);
  }
}

export async function retrieveEvidence(
  config: AppConfig,
  opts: { confirmCost: boolean; set?: 'v1' | '16d' | '16e'; out: string; questions?: readonly CalibrationQuestion[]; log: (m: string) => void },
): Promise<number> {
  const set = opts.set ?? 'v1';
  if (set === '16e') return retrieveEvidenceV3(config, { ...opts, questions: opts.questions ?? QUESTIONS_16E });
  const questions = opts.questions ?? (set === 'v1' ? QUESTIONS : QUESTIONS_16D);
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
      casesIndexOf: (d, signal) => manifestCasesIndex(app, d.generationId, d.passagesIndex, { timeoutMs: 5_000, signal }),
    });
    const catalog = createCaseCatalog(app);
    const bundles: EvidenceFile['bundles'] = [];
    const headers: Record<string, string> = {};
    const v1Cases = new Set(
      EvidenceFileSchema.parse(JSON.parse(readFileSync(DEFAULT_EVIDENCE.v1, 'utf8'))).bundles.flatMap((b) => b.cases.map((c) => c.ntsbNo)),
    );
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
      for (const vc of verified) headers[vc.ntsbNo] = vc.checkHeader;
      const seen = verified.filter((vc) => v1Cases.has(vc.ntsbNo)).map((vc) => vc.ntsbNo);
      opts.log(`${q.id}: ${verified.map((c) => `${c.ntsbNo}(${c.passages.length})`).join(' ')}${set === '16d' && seen.length ? `; in a 16c split: ${seen.join(' ')}` : ''}`);
    }
    if (set === '16d') {
      const source = { generationId: dataset.generationId, passagesIndex: dataset.passagesIndex, chunkerVersion, retrievalVersion: retriever.version, retrievedAt: new Date().toISOString(), note: 'Case headers (caseHeader of the canonical case summaries) and the Task 16d bundles: public NTSB passages of real hybrid-retrieval bundles, checked like the brief pipeline checks them (verifyBundle).' };
      const prior = readV2(opts.out, source);
      writeV2(opts.out, { ...prior, source, headers: { ...prior.headers, ...headers }, bundles });
      opts.log(`wrote ${bundles.length} bundles into ${opts.out}`);
      return 0;
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

/** The 16e bundles under `retrieval.v2`, with each case's channel provenance (module comment). */
async function retrieveEvidenceV3(config: AppConfig, opts: { confirmCost: boolean; out: string; questions: readonly CalibrationQuestion[]; log: (m: string) => void }): Promise<number> {
  const retrieval = retrievalConfig(config.retrieval.version);
  if (retrieval.version !== 'retrieval.v2' || !retrieval.channels.cases) throw new Error(`the 16e bundles are retrieval.v2 bundles; the configured version is ${retrieval.version}`);
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  const price = embeddingUsdPerMillion(model);
  const inputs = [...new Set(opts.questions.map((q) => queryEmbeddingInput(q.question)))];
  const tokens = inputs.reduce((n, t) => n + countTokens(t), 0);
  const batches = batchByLimits(inputs, countTokens);
  const reserve = batches.reduce((sum, b) => sum + reservationUsd(b.reduce((n, t) => n + countTokens(t), 0), price), 0);
  opts.log(`${opts.questions.length} questions, ${inputs.length} query embeddings, ${tokens} tokens with ${model}/${dims}: about $${((tokens * price) / 1e6).toFixed(6)} (reserve $${reserve.toFixed(6)})`);
  if (!opts.confirmCost) {
    opts.log('nothing embedded: run with --confirm-cost to retrieve the bundles');
    return 0;
  }
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the active manifest and canonical passages)');
  if (!config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  const earlier = new Set(
    [
      ...EvidenceFileSchema.parse(JSON.parse(readFileSync(DEFAULT_EVIDENCE.v1, 'utf8'))).bundles,
      ...EvidenceV2FileSchema.parse(JSON.parse(readFileSync(DEFAULT_EVIDENCE['16d'], 'utf8'))).bundles,
    ].flatMap((b) => b.cases.map((c) => c.ntsbNo)),
  );
  const lock = lockAllocation('retrieve-16e');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-checker' });
  const ingest = createDb(config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-checker-ledger' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    const manifest = await getActiveManifest(app);
    if (!manifest?.passagesIndex) throw new Error('no active manifest with a passages index');
    const dataset = { generationId: manifest.generationId, passagesIndex: manifest.passagesIndex };
    const casesIndex = await manifestCasesIndex(app, dataset.generationId, dataset.passagesIndex, { timeoutMs: 5_000 });
    if (!casesIndex) throw new Error('the active manifest has no cases index');
    const gate = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: 'openai', model, stage: 'embed' });
    const openai = createOpenAIEmbedder({ apiKey: config.ai.openai.apiKey ?? '', model, dims, gate, category: 'evaluation', purpose: 'eval-checker-bundles-16e', log: opts.log });
    const vectors = new Map<string, Float32Array>();
    try {
      for (const batch of batches) {
        const res = await openai.embed(batch);
        batch.forEach((t, j) => vectors.set(t, res.vectors[j] as Float32Array));
      }
    } finally {
      // The embeddings' reservations, charged to the allocation at their upper bound.
      appendAllocation({ step: 'embed', usd: reserve, reservedUsd: reserve, model });
    }
    const embedder = precomputedEmbedder({ model, dims, usdPerMillionTokens: price }, vectors);
    const catalog = createCaseCatalog(app);
    const bundles: EvidenceV3File['bundles'] = [];
    const headers: Record<string, string> = {};
    let chunkerVersion = '';
    let casesIndexVersion = '';
    for (const q of opts.questions) {
      const s = await retrieveCandidatesWith(es, embedder, retrieval, {
        dataset,
        text: fitQueryText(q.question),
        keywordText: q.keywordText,
        filters: {},
        signal: AbortSignal.timeout(30_000),
        casesIndex,
      });
      if (s.detail.level !== 'case' || !s.casesIndex) throw new Error(`question ${q.id}: not a case-level retrieval`);
      chunkerVersion = s.chunkerVersion;
      casesIndexVersion = s.casesIndex.version;
      const bundle = toEvidenceBundle(await fetchAndPack(es, s.index, s.filter, s.cases, s.params, AbortSignal.timeout(30_000)));
      if (bundle.cases.length === 0) throw new Error(`question ${q.id}: an empty bundle`);
      const verified = await verifyBundle(catalog, dataset.generationId, bundle, s.chunkerVersion);
      const ranks = new Map(s.detail.result.fusedCases.map((c) => [c.id, c.ranks]));
      const mapped = new Set(s.detail.result.mapping.filter((m) => m.status === 'mapped').map((m) => m.ntsbNo));
      bundles.push({
        question: q.id,
        split: q.split,
        cases: verified.map((vc) => {
          const r = ranks.get(vc.ntsbNo) ?? [null, null, null];
          return {
            ntsbNo: vc.ntsbNo,
            rank: vc.rank,
            aircraft: vc.summary.row.aircraft.map((a) => ({ aircraftKey: a.aircraftKey, make: a.make, model: a.model })),
            channels: { keyword: r[0] ?? null, vector: r[1] ?? null, cases: r[2] ?? null },
            mapped: mapped.has(vc.ntsbNo),
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
          };
        }),
      });
      for (const vc of verified) headers[vc.ntsbNo] = vc.checkHeader;
      const seen = verified.filter((vc) => earlier.has(vc.ntsbNo)).map((vc) => vc.ntsbNo);
      const viaCases = verified.filter((vc) => (ranks.get(vc.ntsbNo)?.[2] ?? null) !== null).length;
      opts.log(`${q.id}: ${verified.map((c) => `${c.ntsbNo}(${c.passages.length}${mapped.has(c.ntsbNo) ? ', mapped' : ''})`).join(' ')}; ${viaCases} nominated by the cases channel${seen.length ? `; in an earlier split: ${seen.join(' ')}` : ''}`);
    }
    const file: EvidenceV3File = EvidenceV3FileSchema.parse({
      version: 'checker-evidence-v3',
      source: {
        generationId: dataset.generationId,
        passagesIndex: dataset.passagesIndex,
        chunkerVersion,
        retrievalVersion: 'retrieval.v2',
        casesIndexVersion,
        retrievedAt: new Date().toISOString(),
        note: 'Task 16e bundles: public NTSB passages of real retrieval.v2 bundles (keyword, vector and cases-index channels, exact case-level fusion, mapping), checked like the brief pipeline checks them (verifyBundle), with each case header (checkHeader) and channel ranks.',
      },
      headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
      bundles,
    });
    writeFileSync(opts.out, `${JSON.stringify(file, null, 2)}\n`);
    opts.log(`wrote ${bundles.length} bundles into ${opts.out}`);
    return 0;
  } finally {
    lock.release();
    await es.close();
    await closeDb(app);
    await closeDb(ingest);
  }
}
