/**
 * One retrieval experiment for one question (task 10d, phase A): the production
 * stages with the config's parameters, then the config's fusion.
 *
 * 1. Stage 1 runs the production `retrieveCandidates` (contract check, one compiled
 *    filter, passage BM25 and passage kNN in parallel, completeness checks) with the
 *    config's `perChannel`, `numCandidatesFactor` and `rrfK`, and, for `keywordText:
 *    scope`, the scope stage's keyword text as BM25 text. A case-level channel, when
 *    configured, runs in parallel with it (`cases-channel.ts`).
 * 2. Fusion. `passage`: weighted RRF over the passage lists, then each case at its best
 *    passage (`rankCases`, the production ranking; with equal weights the production
 *    `rrfFuse` itself). `case`: each channel's unique cases fused with case-level RRF
 *    (`caseRrfFuse`); each case keeps its passages in passage-fused order, and cases
 *    only the case channel found, among the first `packCandidates`, get passages from
 *    one mapping request.
 * 3. Packing: the production `fetchAndPack` over that ranking.
 *
 * With `BASELINE_CONFIG` this sends exactly the production request bodies and returns
 * the production ranking and bundle (a unit and an integration test hold it).
 * Timings exclude the query embedding, which every variant shares.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { queryEmbeddingInput, type Embedder } from '../../../server/ai/embeddings.js';
import type { RetrievalFilters } from '../../../server/search/filters.js';
import {
  elideVectors,
  fetchAndPack,
  retrieveCandidates,
  type CandidateResult,
  type PackedEvidence,
  type PassageHit,
  type RetrievalDataset,
} from '../../../server/search/hybrid.js';
import { rankCases, type CaseCandidate, type FusedHit } from '../../../server/search/rrf.js';
import { mapCasesToPassages, searchCaseChannel, type CaseChannelResult } from './cases-channel.js';
import { paramsOf, type ExperimentConfig } from './config.js';
import { candidatesFor, caseRrfFuse, passagesByCase, uniqueCaseOrder, weightedRrfFuse } from './fusion.js';

export interface VariantQuery {
  dataset: RetrievalDataset;
  /** The cases index of the same generation (case-level channel). */
  casesIndex: string;
  /** The question: embedded for kNN, and BM25 text unless `keywordText: scope`. */
  question: string;
  /** The scope stage's effective keyword text (`keywordText: scope`). */
  scopeKeywordText?: string;
  filters: RetrievalFilters;
  signal?: AbortSignal;
}

export interface VariantRun {
  /** Every candidate case, in ranking order (unique). */
  ranking: string[];
  /** Each channel's unique cases, in channel order. */
  channels: { keyword: string[]; vector: string[]; cases: string[] | null };
  packed: PackedEvidence;
  /** Request bodies, query vectors elided. */
  requests: {
    keyword: Record<string, unknown>;
    vector: Record<string, unknown>;
    cases: Record<string, unknown> | null;
    mapping: Record<string, unknown> | null;
    fetch: Record<string, unknown> | null;
  };
  /** Cases only the case channel found that needed mapped passages. */
  mappedCases: string[];
  timingsMs: { stage1: number; mapping: number; fetch: number; total: number };
}

/** The BM25 text of a query under a config. */
export function bm25Text(config: ExperimentConfig, q: Pick<VariantQuery, 'question' | 'scopeKeywordText'>): string {
  if (config.keywordText === 'question') return q.question;
  if (q.scopeKeywordText === undefined || q.scopeKeywordText.trim() === '') throw new Error('keywordText: scope needs the scope stage keyword text');
  return q.scopeKeywordText;
}

async function queryVector(embedder: Embedder, question: string): Promise<number[]> {
  const res = await embedder.embed([queryEmbeddingInput(question)]);
  const v = res.vectors[0];
  if (res.vectors.length !== 1 || !v || v.length !== embedder.dims) throw new Error('the query embedding has the wrong shape');
  return Array.from(v);
}

/** Run one config for one question (module comment). */
export async function runVariant(es: Client, embedder: Embedder, q: VariantQuery, config: ExperimentConfig): Promise<VariantRun> {
  const params = paramsOf(config);
  const text = bm25Text(config, q);
  const started = performance.now();
  const caseChannel = config.caseChannel;
  const [c, cases]: [CandidateResult, CaseChannelResult | null] = await Promise.all([
    retrieveCandidates(es, embedder, {
      dataset: q.dataset,
      text: q.question,
      ...(config.keywordText === 'scope' ? { keywordText: text } : {}),
      filters: q.filters,
      params,
      ...(q.signal ? { signal: q.signal } : {}),
    }),
    caseChannel ? searchCaseChannel(es, q.casesIndex, text, caseChannel, q.filters, params, q.signal) : Promise.resolve(null),
  ]);
  const stage1 = performance.now();

  const replace = caseChannel?.role === 'replace-keyword';
  const passageLists: (readonly PassageHit[])[] = replace ? [c.vector] : [c.keyword, c.vector];
  const passageWeights = replace ? [config.weights.vector] : [config.weights.keyword, config.weights.vector];
  const fused: FusedHit<PassageHit>[] = weightedRrfFuse(passageLists, passageWeights, params.rrfK);

  let candidates: CaseCandidate<PassageHit>[];
  let mappedCases: string[] = [];
  let mappingBody: estypes.SearchRequest | null = null;
  if (config.fusion === 'passage') {
    candidates = rankCases(fused, params.caseScoring);
  } else {
    const lists: string[][] = [];
    const weights: number[] = [];
    if (!replace) {
      lists.push(uniqueCaseOrder(c.keyword));
      weights.push(config.weights.keyword);
    }
    lists.push(uniqueCaseOrder(c.vector));
    weights.push(config.weights.vector);
    if (cases) {
      lists.push(cases.cases);
      weights.push(config.weights.cases);
    }
    const order = caseRrfFuse(lists, weights, params.rrfK);
    const byCase = passagesByCase(fused);
    mappedCases = order
      .slice(0, params.packCandidates)
      .map((x) => x.ntsbNo)
      .filter((n) => !byCase.has(n));
    let mapped = new Map<string, PassageHit[]>();
    if (mappedCases.length > 0) {
      const m = await mapCasesToPassages(es, c.index, c.filter, await queryVector(embedder, q.question), mappedCases, params, q.signal);
      mapped = m.passages;
      mappingBody = m.body;
    }
    candidates = candidatesFor(
      order.map((x) => x.ntsbNo),
      byCase,
      mapped,
      fused.length,
      new Map(order.map((x) => [x.ntsbNo, x.score])),
    );
  }
  const mapping = performance.now();
  const packed = await fetchAndPack(es, c.index, c.filter, candidates, params, q.signal);
  const done = performance.now();
  return {
    ranking: candidates.map((x) => x.ntsbNo),
    channels: { keyword: uniqueCaseOrder(c.keyword), vector: uniqueCaseOrder(c.vector), cases: cases?.cases ?? null },
    packed,
    requests: {
      keyword: c.requests.keyword,
      vector: c.requests.vector,
      cases: cases ? elideVectors(cases.body) : null,
      mapping: mappingBody ? elideVectors(mappingBody) : null,
      fetch: packed.request,
    },
    mappedCases,
    timingsMs: {
      stage1: Math.round(stage1 - started),
      mapping: Math.round(mapping - stage1),
      fetch: Math.round(done - mapping),
      total: Math.round(done - started),
    },
  };
}
