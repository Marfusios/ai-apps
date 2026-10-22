/**
 * The retrieval evaluation (amendment A13): for every question and every channel size,
 * stage 1 runs once (both channels, the question's filters) and yields three case
 * rankings: keyword (BM25 alone), vector (kNN alone) and hybrid (RRF). Case recall is
 * measured on each ranking; each ranking is then packed with the live packing rules
 * and evidence coverage is measured on the bundle. Every Elasticsearch body is kept,
 * query vectors elided, for review gate G5.
 */
import type { Client } from '@elastic/elasticsearch';
import type { Embedder } from '../../server/ai/embeddings.js';
import {
  fetchAndPack,
  rankingOf,
  retrieveCandidates,
  retrievalParams,
  type RetrievalDataset,
  type RetrievalParams,
} from '../../server/search/hybrid.js';
import { aggregate, scoreMode, type Aggregate, type ModeScore } from './metrics.js';
import type { DatasetItem, Tag } from './silver.js';

export const MODES = ['keyword', 'vector', 'hybrid'] as const;
export type Mode = (typeof MODES)[number];

export interface BundleSummary {
  cases: { ntsbNo: string; caseRank: number; passages: { id: string; sectionKind: string; role: string; fusedRank: number | null; tokens: number }[] }[];
  passages: number;
  tokens: number;
  skipped: { ntsbNo: string; caseRank: number; reason: string }[];
  trimmed: number;
}

export interface ModeResult extends ModeScore {
  /** The first 20 cases of the ranking. */
  top20: string[];
  /** Expected cases ranked within the first 100 candidate cases, with their rank. */
  expectedRanks: Record<string, number | null>;
  bundle: BundleSummary;
  /** The stage 2 fetch body. */
  fetch: Record<string, unknown> | null;
}

export interface SizeResult {
  candidates: { keyword: number; vector: number; fused: number; cases: number };
  modes: Record<Mode, ModeResult>;
  requests: { keyword: Record<string, unknown>; vector: Record<string, unknown> };
  timingsMs: { embed: number; channels: number };
}

export interface QuestionResult {
  id: string;
  split: 'dev' | 'holdout';
  tags: readonly Tag[];
  question: string;
  filters: DatasetItem['filters'];
  expected: string[];
  sizes: Record<string, SizeResult>;
}

export type Summary = Record<string, Record<Mode, Record<string, Aggregate>>>;

export interface EvaluationResult {
  sizes: number[];
  /** Packing and fusion parameters (live defaults); `perChannel` is each size in turn. */
  params: RetrievalParams;
  questions: QuestionResult[];
  /** summary[size][mode][group], group: all, dev, holdout, tag:<tag>. */
  summary: Summary;
  queryEmbedding: { tokens: number; usd: number };
}

export interface EvaluateOptions {
  sizes: readonly number[];
  params?: Partial<RetrievalParams>;
  log?: (message: string) => void;
}

/** Run the evaluation over `items` against one passages index. */
export async function evaluateRetrieval(
  es: Client,
  embedder: Embedder,
  dataset: RetrievalDataset,
  items: readonly DatasetItem[],
  opts: EvaluateOptions,
): Promise<EvaluationResult> {
  const log = opts.log ?? (() => undefined);
  const base = retrievalParams(opts.params);
  const questions: QuestionResult[] = [];
  let tokens = 0;
  let usd = 0;
  for (const [i, q] of items.entries()) {
    const sizes: Record<string, SizeResult> = {};
    for (const size of opts.sizes) {
      const params = retrievalParams({ ...opts.params, perChannel: size });
      const c = await retrieveCandidates(es, embedder, { dataset, text: q.question, filters: q.filters, params });
      tokens += c.queryEmbedding.tokens;
      usd += c.queryEmbedding.usd;
      const modes = {} as Record<Mode, ModeResult>;
      for (const mode of MODES) {
        const ranking = rankingOf(c, mode);
        const order = ranking.map((x) => x.ntsbNo);
        const packed = await fetchAndPack(es, c.index, c.filter, ranking, params);
        const bundle: BundleSummary = {
          cases: packed.cases.map((x) => ({
            ntsbNo: x.ntsbNo,
            caseRank: x.caseRank,
            passages: x.passages.map((p) => ({ id: p.id, sectionKind: p.sectionKind, role: p.role, fusedRank: p.fusedRank, tokens: p.tokens })),
          })),
          passages: packed.passages,
          tokens: packed.tokens,
          skipped: packed.skipped,
          trimmed: packed.trimmed.length,
        };
        const rankOf = new Map(order.slice(0, 100).map((n, k) => [n, k + 1]));
        modes[mode] = {
          ...scoreMode(q.expected, order, bundle.cases, params.maxCases),
          top20: order.slice(0, 20),
          expectedRanks: Object.fromEntries(q.expected.map((n) => [n, rankOf.get(n) ?? null])),
          bundle,
          fetch: packed.request,
        };
      }
      sizes[String(size)] = {
        candidates: { keyword: c.keyword.length, vector: c.vector.length, fused: c.fused.length, cases: c.cases.length },
        modes,
        requests: c.requests,
        timingsMs: c.timingsMs,
      };
    }
    questions.push({ id: q.id, split: q.split, tags: q.tags, question: q.question, filters: q.filters, expected: [...q.expected], sizes });
    log(`${i + 1}/${items.length} ${q.id}`);
  }
  return { sizes: [...opts.sizes], params: base, questions, summary: summarize(questions, opts.sizes), queryEmbedding: { tokens, usd } };
}

export function summarize(questions: readonly QuestionResult[], sizes: readonly number[]): Summary {
  const groups = new Map<string, (q: QuestionResult) => boolean>([
    ['all', () => true],
    ['dev', (q) => q.split === 'dev'],
    ['holdout', (q) => q.split === 'holdout'],
  ]);
  for (const tag of [...new Set(questions.flatMap((q) => q.tags))].sort()) groups.set(`tag:${tag}`, (q) => q.tags.includes(tag));
  const out: Summary = {};
  for (const size of sizes) {
    const bySize = {} as Record<Mode, Record<string, Aggregate>>;
    for (const mode of MODES) {
      bySize[mode] = {};
      for (const [name, member] of groups) {
        const scores = questions.filter(member).map((q) => q.sizes[String(size)]?.modes[mode]).filter((s): s is ModeResult => s !== undefined);
        bySize[mode][name] = aggregate(scores);
      }
    }
    out[String(size)] = bySize;
  }
  return out;
}
