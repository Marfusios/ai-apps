/**
 * The coded-reference evaluation (Track C, task 10c protocol v4): for every question and
 * channel size, stage 1 runs once (both channels, the question's filters) and yields the
 * keyword (BM25 alone), vector (kNN alone) and hybrid (RRF) case rankings; each ranking
 * is packed with the live packing rules. Scores follow the protocol metrics
 * (`metrics.ts`, section 5) against a coded reference: the question's coded positives
 * are fully relevant and every other case is "not coded", never a judged negative.
 * - Recall@20 on the candidate ranking: gated for narrow questions (1 to 20 coded
 *   cases), a diagnostic with its ceiling for broad ones.
 * - Strict P@6 (coded), coded precision among the returned cases and nDCG@6 on the
 *   bundle's cases in rank order.
 * Track C has no unknown grades: every bound collapses to its value. Every
 * Elasticsearch body is kept, query vectors elided.
 */
import type { Client } from '@elastic/elasticsearch';
import type { Embedder } from '../../../server/ai/embeddings.js';
import {
  fetchAndPack,
  rankingOf,
  retrieveCandidates,
  retrievalParams,
  type RetrievalDataset,
  type RetrievalParams,
} from '../../../server/search/hybrid.js';
import { MODES, type Mode } from '../evaluate.js';
import { aggregateProtocol, codedReference, scoreQuestion, type ProtocolAggregate, type ProtocolScore } from '../metrics.js';
import { AREAS, type CodedItem } from './coded.js';

/** Depth (unique candidate cases) within which the ranks of coded cases are recorded. */
export const RANK_DEPTH = 100;

export interface CodedBundle {
  cases: {
    ntsbNo: string;
    caseRank: number;
    /** The case carries the question's code set (it is one of the coded positives). */
    coded: boolean;
    passages: { id: string; sectionKind: string; role: string; reserved: boolean; fusedRank: number | null; tokens: number }[];
  }[];
  passages: number;
  tokens: number;
  skipped: { ntsbNo: string; caseRank: number; reason: string }[];
  trimmed: number;
}

export interface CodedModeResult {
  score: ProtocolScore;
  /** The first 20 cases of the ranking. */
  top20: string[];
  /** Coded cases ranked within the first 100 candidate cases, with their 1-based rank. */
  codedRanks: Record<string, number>;
  bundle: CodedBundle;
  /** The stage 2 fetch body. */
  fetch: Record<string, unknown> | null;
}

export interface CodedSizeResult {
  candidates: { keyword: number; vector: number; fused: number; cases: number };
  modes: Record<Mode, CodedModeResult>;
  requests: { keyword: Record<string, unknown>; vector: Record<string, unknown> };
  timingsMs: { embed: number; channels: number };
}

export interface CodedQuestionResult {
  id: string;
  split: 'dev' | 'holdout';
  group: string;
  class: CodedItem['class'];
  area: CodedItem['area'];
  paraphraseOf: string | null;
  tags: readonly string[];
  question: string;
  filters: CodedItem['filters'];
  relevant: number;
  sizes: Record<string, CodedSizeResult>;
}

export type CodedSummary = Record<string, Record<Mode, Record<string, ProtocolAggregate>>>;

export interface CodedTableRow {
  id: string;
  split: 'dev' | 'holdout';
  class: CodedItem['class'];
  area: CodedItem['area'];
  relevant: number;
  size: number;
  mode: Mode;
  recallAt20: number | null;
  recallGate: 'eligible' | 'diagnostic';
  recallCeiling: number | null;
  strictP6: number;
  codedPrecision: number | null;
  ndcg6: number | null;
  returned: number;
}

export interface CodedEvaluation {
  sizes: number[];
  params: RetrievalParams;
  questions: CodedQuestionResult[];
  /**
   * summary[size][mode][group]; groups: all, dev, holdout, narrow, broad, <split>/<class>,
   * area:<area> and tag:<tag>, each also per class (area:<area>/<class>, tag:<tag>/<class>).
   * A group with no question is left out.
   */
  summary: CodedSummary;
  table: CodedTableRow[];
  queryEmbedding: { tokens: number; usd: number };
}

/** Run every item against one passages index at each channel size. */
export async function evaluateCoded(
  es: Client,
  embedder: Embedder,
  dataset: RetrievalDataset,
  items: readonly CodedItem[],
  opts: { sizes: readonly number[]; params?: Partial<RetrievalParams>; log?: (message: string) => void },
): Promise<CodedEvaluation> {
  const log = opts.log ?? (() => undefined);
  const questions: CodedQuestionResult[] = [];
  let tokens = 0;
  let usd = 0;
  for (const [i, q] of items.entries()) {
    const ref = codedReference(q.relevant);
    const coded = new Set(q.relevant);
    const sizes: Record<string, CodedSizeResult> = {};
    for (const size of opts.sizes) {
      const params = retrievalParams({ ...opts.params, perChannel: size });
      const c = await retrieveCandidates(es, embedder, { dataset, text: q.question, filters: q.filters, params });
      tokens += c.queryEmbedding.tokens;
      usd += c.queryEmbedding.usd;
      const modes = {} as Record<Mode, CodedModeResult>;
      for (const mode of MODES) {
        const ranking = rankingOf(c, mode);
        const order = ranking.map((x) => x.ntsbNo);
        const packed = await fetchAndPack(es, c.index, c.filter, ranking, params);
        const codedRanks: Record<string, number> = {};
        order.slice(0, RANK_DEPTH).forEach((n, k) => {
          if (coded.has(n)) codedRanks[n] = k + 1;
        });
        modes[mode] = {
          score: scoreQuestion(
            order,
            packed.cases.map((x) => x.ntsbNo),
            ref,
          ),
          top20: order.slice(0, 20),
          codedRanks,
          bundle: {
            cases: packed.cases.map((x) => ({
              ntsbNo: x.ntsbNo,
              caseRank: x.caseRank,
              coded: coded.has(x.ntsbNo),
              passages: x.passages.map((p) => ({
                id: p.id,
                sectionKind: p.sectionKind,
                role: p.role,
                reserved: p.reserved,
                fusedRank: p.fusedRank,
                tokens: p.tokens,
              })),
            })),
            passages: packed.passages,
            tokens: packed.tokens,
            skipped: packed.skipped,
            trimmed: packed.trimmed.length,
          },
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
    questions.push({
      id: q.id,
      split: q.split,
      group: q.group,
      class: q.class,
      area: q.area,
      paraphraseOf: q.paraphrase_of ?? null,
      tags: q.tags,
      question: q.question,
      filters: q.filters,
      relevant: q.relevant.length,
      sizes,
    });
    log(`${i + 1}/${items.length} ${q.id}`);
  }
  return {
    sizes: [...opts.sizes],
    params: retrievalParams(opts.params),
    questions,
    summary: summarizeCoded(questions, opts.sizes),
    table: codedTable(questions, opts.sizes),
    queryEmbedding: { tokens, usd },
  };
}

const CLASS_AND_AREA_TAGS = new Set<string>(['narrow', 'broad', ...AREAS]);

/** Macro averages per size, mode and group (`CodedEvaluation.summary`). */
export function summarizeCoded(questions: readonly CodedQuestionResult[], sizes: readonly number[]): CodedSummary {
  const groups = new Map<string, (q: CodedQuestionResult) => boolean>([
    ['all', () => true],
    ['dev', (q) => q.split === 'dev'],
    ['holdout', (q) => q.split === 'holdout'],
    ['narrow', (q) => q.class === 'narrow'],
    ['broad', (q) => q.class === 'broad'],
  ]);
  for (const split of ['dev', 'holdout'] as const) {
    for (const cls of ['narrow', 'broad'] as const) groups.set(`${split}/${cls}`, (q) => q.split === split && q.class === cls);
  }
  const withClasses = (name: string, member: (q: CodedQuestionResult) => boolean) => {
    groups.set(name, member);
    for (const cls of ['narrow', 'broad'] as const) groups.set(`${name}/${cls}`, (q) => member(q) && q.class === cls);
  };
  for (const area of AREAS) withClasses(`area:${area}`, (q) => q.area === area);
  for (const tag of [...new Set(questions.flatMap((q) => q.tags))].filter((t) => !CLASS_AND_AREA_TAGS.has(t)).sort()) {
    withClasses(`tag:${tag}`, (q) => q.tags.includes(tag));
  }
  const out: CodedSummary = {};
  for (const size of sizes) {
    const bySize = {} as Record<Mode, Record<string, ProtocolAggregate>>;
    for (const mode of MODES) {
      bySize[mode] = {};
      for (const [name, member] of groups) {
        const scores = questions
          .filter(member)
          .map((q) => q.sizes[String(size)]?.modes[mode]?.score)
          .filter((s): s is ProtocolScore => s !== undefined);
        if (scores.length > 0 || name === 'all') bySize[mode][name] = aggregateProtocol(scores);
      }
    }
    out[String(size)] = bySize;
  }
  return out;
}

/** One row per question, size and mode: the per-question table of the report. */
export function codedTable(questions: readonly CodedQuestionResult[], sizes: readonly number[]): CodedTableRow[] {
  const rows: CodedTableRow[] = [];
  for (const q of questions) {
    for (const size of sizes) {
      for (const mode of MODES) {
        const s = q.sizes[String(size)]?.modes[mode]?.score;
        if (!s) continue;
        rows.push({
          id: q.id,
          split: q.split,
          class: q.class,
          area: q.area,
          relevant: q.relevant,
          size,
          mode,
          recallAt20: s.recall.value,
          recallGate: s.recall.gate,
          recallCeiling: s.recall.ceiling,
          // Track C has no unknowns: lower and upper bounds are equal.
          strictP6: s.precision.strict.lower,
          codedPrecision: s.precision.amongReturned?.lower ?? null,
          ndcg6: s.ndcg.bounds?.lower ?? null,
          returned: s.precision.returned,
        });
      }
    }
  }
  return rows;
}
