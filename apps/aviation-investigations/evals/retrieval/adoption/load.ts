/**
 * Retrieval latency under concurrent load (task 10e; the gate's condition 6): tail
 * percentiles over individual requests, never over per-question medians.
 *
 * Every request is a real brief retrieval through the production binding
 * (`createHybridRetriever`: the manifest lookup in PostgreSQL, the index checks, every
 * channel, the mapping, the evidence fetch and packing), read-only against the target,
 * for a question, scope sample and filter mode of the development set. The query
 * embedding is not paid again: vectors computed once (the validation run's) are
 * answered after `embedDelayMs`, so the embedding's own provider latency is out of the
 * measurement unless a delay stands in for it.
 *
 * - **Cells.** Each arm (retrieval version) at each concurrency (at most 8 workers),
 *   until `maxRequests` requests finished or `durationMs` passed, whichever first;
 *   the arms of a concurrency run one after the other.
 * - **Cold.** Before the cells, one pass over every distinct request in a fresh process,
 *   one at a time, with the remembered index checks forgotten for each arm: no index
 *   check cached in the process and no request seen before in it. Elasticsearch's and
 *   the operating system's caches cannot be cleared read-only; they may be warm.
 * - **Cancellation.** A share of requests is aborted after a random delay; the time from
 *   the abort to the request's end is recorded.
 * - **Partial failures.** A share of requests has one search fail (the cases channel,
 *   or for a passage-level arm passage BM25) while the embedding is still in flight
 *   (`failEmbedDelayMs`); the time to the failure and the number of embedding
 *   settlements (exactly one) are recorded.
 * - **Mapping at its bound.** For a share of case-level requests the mapping of all the
 *   leading `packCandidates` cases (as if no passage channel had returned any) runs
 *   right after, under the same load, and is timed apart.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { countTokens } from '../../../server/ai/tokens.js';
import { queryEmbeddingInput, type Embedder, type EmbedResult } from '../../../server/ai/embeddings.js';
import { RetrievalFailure, type EvidenceDataset } from '../../../server/briefs/evidence.js';
import { createHybridRetriever } from '../../../server/briefs/retriever.js';
import { retrieveCandidatesWith } from '../../../server/search/case-retrieval.js';
import { mapCasesToPassages } from '../../../server/search/case-mapping.js';
import { forgetCasesIndexChecks } from '../../../server/search/cases-channel.js';
import type { RetrievalFilters } from '../../../server/search/filters.js';
import { forgetPassagesIndexChecks } from '../../../server/search/hybrid.js';
import type { RetrievalConfig } from '../../../server/search/retrieval-config.js';
import { mulberry32, nearestRank } from '../experiments/stats.js';

export interface LoadRequest {
  /** Question, sample and filter mode, e.g. `occ-midair-nevada|s2|inferred`. */
  id: string;
  question: string;
  keywordText: string;
  filters: RetrievalFilters;
}

export interface LoadOptions {
  concurrency: readonly number[];
  durationMs: number;
  maxRequests: number;
  cancelShare: number;
  failShare: number;
  mappingShare: number;
  embedDelayMs: number;
  failEmbedDelayMs: number;
  seed: number;
}

export const DEFAULT_LOAD: Readonly<LoadOptions> = Object.freeze({
  concurrency: [1, 4, 8],
  durationMs: 30_000,
  maxRequests: 400,
  cancelShare: 0.1,
  failShare: 0.05,
  mappingShare: 0.1,
  embedDelayMs: 0,
  failEmbedDelayMs: 150,
  seed: 20261024,
});

export type SampleKind = 'normal' | 'cancel' | 'fail' | 'mapping-bound';

export interface LoadSample {
  arm: string;
  concurrency: number;
  cold: boolean;
  kind: SampleKind;
  request: string;
  /** Request start to its end (for `cancel`: abort to end in `afterAbortMs`). */
  ms: number;
  afterAbortMs: number | null;
  outcome: 'ok' | 'failed' | 'cancelled';
  reason: string | null;
  /** Embedding settlements the request reported (exactly one when the embedder was called and answered). */
  settlements: number;
  mapped: number;
  unmapped: number;
}

/** An embedder answering from precomputed vectors after `delayMs`, honouring an abort. */
export function delayedEmbedder(vectors: ReadonlyMap<string, Float32Array>, base: Pick<Embedder, 'model' | 'dims' | 'usdPerMillionTokens'>, delayMs: number) {
  const answer = async (texts: string[], signal?: AbortSignal): Promise<EmbedResult> => {
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    }
    signal?.throwIfAborted();
    const out = texts.map((t) => {
      const v = vectors.get(t);
      if (!v) throw new Error('a load-test query has no precomputed vector');
      return v;
    });
    return { vectors: out, tokens: texts.reduce((n, t) => n + countTokens(t), 0) };
  };
  return { ...base, embed: (texts: string[]) => answer(texts), embedWithSignal: (texts: string[], signal?: AbortSignal) => answer(texts, signal) };
}

/** `es` with one kind of search failing: the cases channel (a case-level arm) or passage BM25. */
export function failingClient(es: Client, casesIndex: string, target: 'cases' | 'keyword'): Client {
  return new Proxy(es, {
    get(t, prop) {
      if (prop === 'search') {
        return async (body: estypes.SearchRequest, opts?: unknown) => {
          const isCases = body.index === casesIndex;
          const isKeyword = !isCases && !body.knn && Boolean(body.query?.bool?.must);
          if ((target === 'cases' && isCases) || (target === 'keyword' && isKeyword)) {
            await new Promise((r) => setTimeout(r, 5));
            throw Object.assign(new Error('injected search failure'), { name: 'ConnectionError' });
          }
          return t.search(body, opts as never);
        };
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

export interface LoadContext {
  es: Client;
  dataset: EvidenceDataset;
  casesIndex: string;
  casesIndexOf: (d: EvidenceDataset) => Promise<string | null>;
  vectors: ReadonlyMap<string, Float32Array>;
  embedding: Pick<Embedder, 'model' | 'dims' | 'usdPerMillionTokens'>;
}

async function oneRequest(ctx: LoadContext, config: RetrievalConfig, req: LoadRequest, kind: SampleKind, o: LoadOptions, rand: () => number, meta: { concurrency: number; cold: boolean }): Promise<LoadSample[]> {
  const failing = kind === 'fail';
  const es = failing ? failingClient(ctx.es, ctx.casesIndex, config.channels.cases ? 'cases' : 'keyword') : ctx.es;
  const embedder = delayedEmbedder(ctx.vectors, ctx.embedding, failing ? o.failEmbedDelayMs : o.embedDelayMs);
  const retriever = createHybridRetriever({ es, embedder, retrieval: config, casesIndexOf: ctx.casesIndexOf });
  const controller = new AbortController();
  let settlements = 0;
  let abortedAt: number | null = null;
  const started = performance.now();
  if (kind === 'cancel') {
    const after = Math.floor(rand() * 40);
    setTimeout(() => {
      abortedAt = performance.now();
      controller.abort();
    }, after);
  }
  const base = { arm: config.version, concurrency: meta.concurrency, cold: meta.cold, request: req.id };
  const out: LoadSample[] = [];
  try {
    const got = await retriever.retrieve({ dataset: ctx.dataset, text: req.question, keywordText: req.keywordText, filters: req.filters }, controller.signal, () => (settlements += 1));
    const ended = performance.now();
    out.push({ ...base, kind, ms: ended - started, afterAbortMs: abortedAt === null ? null : ended - abortedAt, outcome: 'ok', reason: null, settlements, mapped: got.mapping?.mapped ?? 0, unmapped: got.mapping?.unmapped ?? 0 });
  } catch (err) {
    const ended = performance.now();
    const f = err instanceof RetrievalFailure ? err : null;
    out.push({
      ...base,
      kind,
      ms: ended - started,
      afterAbortMs: abortedAt === null ? null : ended - abortedAt,
      outcome: f?.kind === 'timeout' ? 'cancelled' : 'failed',
      reason: f?.reason ?? 'unexpected',
      settlements,
      mapped: 0,
      unmapped: 0,
    });
  }
  // The mapping at its bound, under the same load: every leading case mapped by the same vector.
  if (kind === 'normal' && config.channels.cases && config.mapping && rand() < o.mappingShare) {
    const vector = Array.from(ctx.vectors.get(queryEmbeddingInput(req.question)) as Float32Array);
    const stage = await retrieveCandidatesWith(ctx.es, embedder, config, { dataset: ctx.dataset, casesIndex: ctx.casesIndex, text: req.question, keywordText: req.keywordText, filters: req.filters });
    const leading = stage.cases.slice(0, stage.params.packCandidates).map((c) => c.ntsbNo);
    const t0 = performance.now();
    const m = await mapCasesToPassages(ctx.es, stage.index, stage.filter, vector, leading, stage.params, { passagesPerCase: config.mapping.passagesPerCase, maxCases: stage.params.packCandidates });
    const mapped = m.cases.filter((c) => c.status === 'mapped').length;
    out.push({ ...base, kind: 'mapping-bound', ms: performance.now() - t0, afterAbortMs: null, outcome: 'ok', reason: null, settlements: 0, mapped, unmapped: m.cases.length - mapped });
  }
  return out;
}

/** One cell: `concurrency` workers until `maxRequests` finished or `durationMs` passed. */
async function cell(ctx: LoadContext, config: RetrievalConfig, requests: readonly LoadRequest[], concurrency: number, o: LoadOptions, rand: () => number): Promise<LoadSample[]> {
  const out: LoadSample[] = [];
  const deadline = performance.now() + o.durationMs;
  let issued = 0;
  const worker = async () => {
    while (issued < o.maxRequests && performance.now() < deadline) {
      issued += 1;
      const req = requests[Math.floor(rand() * requests.length)] as LoadRequest;
      const r = rand();
      const kind: SampleKind = r < o.cancelShare ? 'cancel' : r < o.cancelShare + o.failShare ? 'fail' : 'normal';
      out.push(...(await oneRequest(ctx, config, req, kind, o, rand, { concurrency, cold: false })));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

/** The cold pass, then every cell (module comment). */
export async function runLoad(ctx: LoadContext, configs: readonly RetrievalConfig[], requests: readonly LoadRequest[], o: LoadOptions, log: (m: string) => void = () => undefined): Promise<LoadSample[]> {
  if (o.concurrency.some((c) => !Number.isSafeInteger(c) || c < 1 || c > 8)) throw new Error('concurrency is 1 to 8');
  const rand = mulberry32(o.seed);
  const samples: LoadSample[] = [];
  for (const config of configs) {
    forgetPassagesIndexChecks();
    forgetCasesIndexChecks();
    for (const req of requests) samples.push(...(await oneRequest(ctx, config, req, 'normal', { ...o, mappingShare: 0 }, rand, { concurrency: 1, cold: true })));
    log(`cold pass ${config.version}: ${requests.length} requests`);
  }
  for (const concurrency of o.concurrency) {
    for (const config of configs) {
      const got = await cell(ctx, config, requests, concurrency, o, rand);
      samples.push(...got);
      log(`${config.version} at ${concurrency} concurrent: ${got.length} samples`);
    }
  }
  return samples;
}

export interface Percentiles {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const r = (p: number) => Math.round(nearestRank(values, p));
  return { n: values.length, p50: r(0.5), p95: r(0.95), p99: r(0.99), max: Math.round(Math.max(...values)) };
}

export interface LoadSummaryRow {
  arm: string;
  concurrency: number | 'cold';
  ok: Percentiles;
  cancelAfterAbort: Percentiles;
  failure: Percentiles;
  mappingBound: Percentiles;
  /** Requests whose leading cases needed the mapping, and cases left unmapped. */
  mappedRequests: number;
  unmappedCases: number;
  /** Requests by outcome, and any request whose embedding was settled other than exactly once. */
  outcomes: Record<string, number>;
  settlementProblems: number;
}

export function summarizeLoad(samples: readonly LoadSample[]): LoadSummaryRow[] {
  const keys = new Map<string, { arm: string; concurrency: number | 'cold' }>();
  for (const s of samples) {
    const concurrency = s.cold ? ('cold' as const) : s.concurrency;
    keys.set(`${s.arm}|${concurrency}`, { arm: s.arm, concurrency });
  }
  return [...keys.values()].map(({ arm, concurrency }) => {
    const mine = samples.filter((s) => s.arm === arm && (concurrency === 'cold' ? s.cold : !s.cold && s.concurrency === concurrency));
    const requests = mine.filter((s) => s.kind !== 'mapping-bound');
    const outcomes: Record<string, number> = {};
    for (const s of requests) outcomes[`${s.kind}:${s.outcome}`] = (outcomes[`${s.kind}:${s.outcome}`] ?? 0) + 1;
    return {
      arm,
      concurrency,
      ok: percentiles(requests.filter((s) => s.kind === 'normal' && s.outcome === 'ok').map((s) => s.ms)),
      cancelAfterAbort: percentiles(requests.filter((s) => s.kind === 'cancel' && s.afterAbortMs !== null).map((s) => s.afterAbortMs as number)),
      failure: percentiles(requests.filter((s) => s.kind === 'fail').map((s) => s.ms)),
      mappingBound: percentiles(mine.filter((s) => s.kind === 'mapping-bound').map((s) => s.ms)),
      mappedRequests: requests.filter((s) => s.mapped > 0).length,
      unmappedCases: requests.reduce((n, s) => n + s.unmapped, 0),
      outcomes,
      // Every answered or failed-after-embedding request settles exactly once; a cancel may settle none (uncertain).
      settlementProblems: requests.filter((s) => (s.kind === 'cancel' ? s.settlements > 1 : s.settlements !== 1)).length,
    };
  });
}
