/**
 * Where the baseline loses coded positives (task 10d, phase A, diagnostics). Every
 * coded positive of a question is placed in one class, from the baseline run (hybrid,
 * production defaults):
 *
 * - `excluded_by_filters`: no passage of the case matches the question's compiled
 *   passages filter (by construction of the coded labels this should never happen);
 * - `absent_from_representation`: outside the candidate pool, and the heuristic below
 *   finds no text in any passage or case field that a lexical or semantic match could
 *   plausibly use;
 * - `outside_pool`: outside the candidate pool (neither channel returned a passage of
 *   it), but representable: `via` says whether through the narrative passages (BM25 or
 *   cosine) or only through the coded findings text of the cases index;
 * - `ranked_below_20`: in the pool, case rank above 20;
 * - Recall@20 hits: `lost_in_packing` (the packer passed over it: no cause, or over
 *   budget), `beyond_bundle` (ranked 7 to 20 behind six packed cases) or `delivered`.
 *
 * **Representability heuristic.** Three signals per case, each compared with the same
 * signal over a random background of non-positive cases reachable under the same
 * filters (`backgroundSample` cases, seeded): (1) narrative BM25: the best score of the
 * case's passages for the production BM25 query (the question, the passages filter);
 * (2) narrative cosine: the best similarity of the case's passages to the question's
 * embedding (exact kNN restricted to the cases); (3) findings BM25: the question
 * against the case's `findings_text` in the cases index. A case is representable when
 * some signal is above zero and at least the background's `percentile` (registered:
 * the 90th); `sensitivity` percentiles are reported too. In words: some text of the case
 * looks more like the question, to BM25 or to the embedding, than that of nine in ten
 * random eligible cases under the same filters.
 *
 * Limits: the threshold is relative (a small cohort's top decile may still be beyond any
 * practical depth); the BM25 signals use the whole question, filter words and generic
 * words included; "looks like the question" is not "states the coded fact"; the
 * background is a sample. The heuristic is checked against in-pool positives, which
 * retrieval did find and which it should therefore call representable.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import type { Query, RetrievalFilters } from '../../../server/search/filters.js';
import { assertCompleteResponse, keywordChannelBody } from '../../../server/search/hybrid.js';
import { caseChannelFilter } from './cases-channel.js';
import { percentile } from './stats.js';

export const MISS_CLASSES = [
  'excluded_by_filters',
  'absent_from_representation',
  'outside_pool',
  'ranked_below_20',
  'lost_in_packing',
  'beyond_bundle',
  'delivered',
] as const;
export type MissClass = (typeof MISS_CLASSES)[number];
export const RECALL_MISSES: readonly MissClass[] = ['excluded_by_filters', 'absent_from_representation', 'outside_pool', 'ranked_below_20'];

export interface Signals {
  bm25: number;
  cosine: number;
  findings: number;
}

export interface Thresholds {
  percentile: number;
  bm25: number;
  cosine: number;
  findings: number;
}

export type Via = 'narrative' | 'findings_only' | null;

/** Which signals make a case representable at `t` (above zero and at least the threshold). */
export function representableVia(s: Signals, t: Thresholds): Via {
  const bm25 = s.bm25 > 0 && s.bm25 >= t.bm25;
  const cosine = s.cosine > 0 && s.cosine >= t.cosine;
  const findings = s.findings > 0 && s.findings >= t.findings;
  if (bm25 || cosine) return 'narrative';
  if (findings) return 'findings_only';
  return null;
}

/** Background thresholds at percentile `p` of each signal. */
export function thresholdsOf(background: readonly Signals[], p: number): Thresholds {
  const at = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), p);
  return {
    percentile: p,
    bm25: at(background.map((s) => s.bm25)),
    cosine: at(background.map((s) => s.cosine)),
    findings: at(background.map((s) => s.findings)),
  };
}

export interface PositiveDiagnosis {
  ntsbNo: string;
  class: MissClass;
  /** Case rank in the baseline ranking; null outside the pool. */
  rank: number | null;
  inKeyword: boolean;
  inVector: boolean;
  /** Packer skip reason (`lost_in_packing`). */
  skipReason: string | null;
  reachable: boolean;
  signals: Signals;
  /** Representability at the registered percentile, and at each sensitivity percentile. */
  via: Via;
  viaAt: Record<string, Via>;
}

/** What the classification reads from the baseline run. */
export interface BaselineRun {
  /** The candidate case ranking. */
  ranking: readonly string[];
  /** Each channel's unique cases (the candidate pool is their union). */
  channels: { keyword: readonly string[]; vector: readonly string[] };
  /** The packed bundle's cases. */
  bundle: readonly string[];
  /** Cases the packer passed over, with the reason. */
  skipped: readonly { ntsbNo: string; reason: string }[];
}

/** Pure: the class of each positive, given the baseline run and the representability results. */
export function classify(
  positives: readonly string[],
  run: BaselineRun,
  facts: { reachable: ReadonlySet<string>; signals: ReadonlyMap<string, Signals>; thresholds: Thresholds; sensitivity: readonly Thresholds[] },
): PositiveDiagnosis[] {
  const rankOf = new Map(run.ranking.map((n, i) => [n, i + 1]));
  const kw = new Set(run.channels.keyword);
  const vec = new Set(run.channels.vector);
  const bundled = new Set(run.bundle);
  const skipped = new Map(run.skipped.map((s) => [s.ntsbNo, s.reason]));
  return positives.map((ntsbNo) => {
    const signals = facts.signals.get(ntsbNo) ?? { bm25: 0, cosine: 0, findings: 0 };
    const via = representableVia(signals, facts.thresholds);
    const viaAt = Object.fromEntries(facts.sensitivity.map((t) => [String(t.percentile), representableVia(signals, t)]));
    const rank = rankOf.get(ntsbNo) ?? null;
    const reachable = facts.reachable.has(ntsbNo);
    let cls: MissClass;
    let skipReason: string | null = null;
    if (!reachable) cls = 'excluded_by_filters';
    else if (rank === null) cls = via === null ? 'absent_from_representation' : 'outside_pool';
    else if (rank > 20) cls = 'ranked_below_20';
    else if (bundled.has(ntsbNo)) cls = 'delivered';
    else if (skipped.has(ntsbNo)) {
      cls = 'lost_in_packing';
      skipReason = skipped.get(ntsbNo) ?? null;
    } else cls = 'beyond_bundle';
    return { ntsbNo, class: cls, rank, inKeyword: kw.has(ntsbNo), inVector: vec.has(ntsbNo), skipReason, reachable, signals, via, viaAt };
  });
}

// ---------------------------------------------------------------------------
// Elasticsearch facts (read-only)

const transport = { requestTimeout: 30_000 };
const BATCH = 100;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Cases among `cases` with at least one passage under `filter`. */
export async function reachableCases(es: Client, passagesIndex: string, filter: Query[], cases: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const batch of chunks(cases, BATCH)) {
    const res = await es.search(
      {
        index: passagesIndex,
        size: 0,
        allow_partial_search_results: false,
        query: { bool: { filter: [...filter, { terms: { ntsb_no: batch } }] } },
        aggs: { cases: { terms: { field: 'ntsb_no', size: batch.length } } },
      },
      transport,
    );
    assertCompleteResponse(res, 'fetch');
    const buckets = (res.aggregations!.cases as estypes.AggregationsStringTermsAggregate).buckets as estypes.AggregationsStringTermsBucket[];
    for (const b of buckets) out.add(String(b.key));
  }
  return out;
}

/** A seeded random sample of cases reachable under `filters`, positives excluded (the cases index, case-channel filter). */
export async function backgroundSample(es: Client, casesIndex: string, filters: RetrievalFilters, exclude: readonly string[], size: number, seed: number): Promise<string[]> {
  const res = await es.search<Record<string, unknown>>(
    {
      index: casesIndex,
      size,
      allow_partial_search_results: false,
      _source: ['ntsb_no'],
      query: {
        function_score: {
          query: { bool: { filter: caseChannelFilter(filters), must_not: [{ terms: { ntsb_no: [...exclude] } }] } },
          functions: [{ random_score: { seed, field: '_seq_no' } }],
          boost_mode: 'replace',
        },
      },
    },
    transport,
  );
  assertCompleteResponse(res, 'fetch');
  return res.hits.hits.map((h) => String(h._source?.ntsb_no));
}

const maxByCase = (hits: readonly estypes.SearchHit<Record<string, unknown>>[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const h of hits) {
    const n = String(h._source?.ntsb_no);
    const s = h._score ?? 0;
    if (s > (out.get(n) ?? Number.NEGATIVE_INFINITY)) out.set(n, s);
  }
  return out;
};

/** The three signals of every case (module comment); cases without a match score 0. */
export async function caseSignals(
  es: Client,
  t: { passagesIndex: string; casesIndex: string },
  q: { question: string; vector: readonly number[]; filter: Query[]; filters: RetrievalFilters },
  cases: readonly string[],
): Promise<Map<string, Signals>> {
  const bm25 = new Map<string, number>();
  const cosine = new Map<string, number>();
  const findings = new Map<string, number>();
  for (const batch of chunks(cases, BATCH)) {
    const restrict: Query[] = [...q.filter, { terms: { ntsb_no: batch } }];
    // (1) the production BM25 query over the batch's passages.
    const lexical = { ...keywordChannelBody(t.passagesIndex, q.question, restrict, 10_000), _source: ['ntsb_no'] };
    const lex = await es.search<Record<string, unknown>>(lexical, transport);
    assertCompleteResponse(lex, 'keyword');
    if (lex.hits.hits.length >= 10_000) throw new Error('the lexical signal filled 10,000 hits; lower the batch size');
    for (const [n, s] of maxByCase(lex.hits.hits)) bm25.set(n, s);
    // (2) exact kNN over the batch's passages: num_candidates covers every passage.
    const count = (await es.count({ index: t.passagesIndex, query: { bool: { filter: restrict } } }, transport)).count;
    if (count > 10_000) throw new Error('the semantic signal needs more than 10,000 candidates; lower the batch size');
    if (count > 0) {
      const sem = await es.search<Record<string, unknown>>(
        {
          index: t.passagesIndex,
          size: count,
          allow_partial_search_results: false,
          _source: ['ntsb_no'],
          knn: { field: 'embedding', query_vector: [...q.vector], k: count, num_candidates: count, filter: { bool: { filter: restrict } } },
        },
        transport,
      );
      assertCompleteResponse(sem, 'vector');
      for (const [n, s] of maxByCase(sem.hits.hits)) cosine.set(n, s);
    }
    // (3) the question against the coded findings text.
    const fin = await es.search<Record<string, unknown>>(
      {
        index: t.casesIndex,
        size: batch.length,
        allow_partial_search_results: false,
        _source: ['ntsb_no'],
        query: {
          bool: {
            must: [{ match: { findings_text: { query: q.question, operator: 'or' } } }],
            filter: [...caseChannelFilter(q.filters), { terms: { ntsb_no: batch } }],
          },
        },
      },
      transport,
    );
    assertCompleteResponse(fin, 'keyword');
    for (const [n, s] of maxByCase(fin.hits.hits)) findings.set(n, s);
  }
  return new Map(cases.map((n) => [n, { bm25: bm25.get(n) ?? 0, cosine: cosine.get(n) ?? 0, findings: findings.get(n) ?? 0 }]));
}

export interface QuestionDiagnosis {
  id: string;
  positives: PositiveDiagnosis[];
  background: { cases: number; thresholds: Thresholds; sensitivity: Thresholds[] };
  counts: Record<MissClass, number>;
  /** Positives outside the pool, by how they are representable. */
  outsideVia: { narrative: number; findings_only: number };
}

export function countClasses(ps: readonly PositiveDiagnosis[]): Record<MissClass, number> {
  const out = Object.fromEntries(MISS_CLASSES.map((c) => [c, 0])) as Record<MissClass, number>;
  for (const p of ps) out[p.class] += 1;
  return out;
}

/** Diagnose one question's positives against its baseline run (read-only requests). */
export async function diagnoseQuestion(
  es: Client,
  t: { passagesIndex: string; casesIndex: string },
  q: { id: string; question: string; vector: readonly number[]; filter: Query[]; filters: RetrievalFilters; positives: readonly string[] },
  run: BaselineRun,
  opts: { backgroundSample: number; percentile: number; sensitivity: readonly number[]; seed: number },
): Promise<QuestionDiagnosis> {
  const reachable = await reachableCases(es, t.passagesIndex, q.filter, q.positives);
  const background = await backgroundSample(es, t.casesIndex, q.filters, q.positives, opts.backgroundSample, opts.seed);
  const signals = await caseSignals(es, t, q, [...q.positives, ...background]);
  const bg = background.map((n) => signals.get(n) as Signals);
  const thresholds = thresholdsOf(bg, opts.percentile);
  const sensitivity = opts.sensitivity.map((p) => thresholdsOf(bg, p));
  const positives = classify(q.positives, run, { reachable, signals, thresholds, sensitivity });
  const outside = positives.filter((p) => p.class === 'outside_pool');
  return {
    id: q.id,
    positives,
    background: { cases: background.length, thresholds, sensitivity },
    counts: countClasses(positives),
    outsideVia: { narrative: outside.filter((p) => p.via === 'narrative').length, findings_only: outside.filter((p) => p.via === 'findings_only').length },
  };
}
