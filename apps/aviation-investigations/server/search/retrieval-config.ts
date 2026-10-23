/**
 * Versioned retrieval behaviour (task 10e; the gate's adoption conditions 2 and 5).
 * Every value a retrieval version uses is in one frozen object: channels and their
 * fields, depths and query form, the texts they search, fusion level, constant,
 * weights and tie order, case-to-passage mapping and packing. The operator setting
 * `AVIATION_RETRIEVAL_VERSION` picks one (shared/contracts/retrieval.ts); nothing else
 * changes retrieval behaviour, and the version is recorded wherever retrieval output
 * is (a brief step's `meta.retrievalVersion`, the `brief.retrieve` span, evaluation
 * reports). `retrievalConfigSha256` identifies a configuration by content.
 *
 * - **`retrieval.v1`, the rollback**: exactly the behaviour before task 10e
 *   (`RETRIEVAL_DEFAULTS`). Passage BM25 over `text` with the scope stage's keyword
 *   text and passage kNN with the question's embedding, 50 passages each, kNN
 *   `num_candidates` 200; passage-level reciprocal rank fusion, k = 60, equal weights;
 *   cases in the order of their best passage (`retrieveCandidates`, server/search/hybrid.ts).
 * - **`retrieval.v2`, the default**: the configuration task 10d phase A tested as
 *   `c200+n-kt`. Passage BM25 (200 passages), passage kNN (200 passages,
 *   `num_candidates` 800) and BM25 over the cases index's narratives (`probable_cause`,
 *   `analysis`, `factual`; 200 cases); both BM25 channels search the scope stage's
 *   keyword text, the kNN channel embeds the original effective question. Each channel
 *   is collapsed to its unique cases, then fused at case level: reciprocal rank fusion,
 *   k = 60, equal weights, compared exactly, with a total tie order
 *   (server/search/case-fusion.ts). Cases among the leading `packCandidates` that no
 *   passage channel returned get their passages from the same query vector
 *   (server/search/case-mapping.ts); packing is unchanged.
 * - **`retrieval.v2-nf`, experimental**: `retrieval.v2` with `findings_text` added to
 *   the cases channel's fields. Its coded-reference gain over `retrieval.v2` rests on
 *   the field the coded labels are built from, so it waits for the narrative-relevance
 *   track (Track N); operators may select it on `dev` only.
 *
 * **Cutoffs** (task 10e fix round 1). Candidate discovery and fusion are kept apart:
 * - the lexical channels (`cutoff: score-then-id`) ask Elasticsearch to sort by score,
 *   then passage id or case number, while it collects the top `size`, so which of several
 *   equal-score hits fill the last places is decided by the id, not by Lucene's document
 *   order. The scores come from the index's term statistics, so this fixes the cut for
 *   the scores an index gives, not the scores of a differently built copy;
 * - the kNN channel (`cutoff: approximate`) is approximate discovery: HNSW decides which
 *   candidates it finds and int8 quantization is computed per segment, so membership and
 *   scores belong to one index state and can differ on a rebuilt copy; no sort applies;
 * - the mapping (`selection`) scores every passage of a mapped case exactly and keeps the
 *   best by score, then passage id;
 * - fusion (`ranking`) is exact and totally ordered over whatever the channels returned.
 * `retrieval.v1` keeps Elasticsearch's own cut (`elasticsearch-order`), as before.
 *
 * Index mappings are unchanged by these versions: they are query behaviour.
 */
import { createHash } from 'node:crypto';
import type { RetrievalVersion } from '../../shared/contracts/retrieval.js';
import { RETRIEVAL_DEFAULTS, retrievalParams, type RetrievalParams } from './hybrid.js';

/** The cases-index text fields a cases channel searches, by content (`N`, `NF`). */
export const CASES_CHANNEL_FIELDS = {
  narratives: ['probable_cause', 'analysis', 'factual'],
  'narratives+findings': ['probable_cause', 'analysis', 'factual', 'findings_text'],
} as const;
export type CasesChannelContent = keyof typeof CASES_CHANNEL_FIELDS;

/** Every BM25 channel's query: `multi_match`, `best_fields`, operator `or`, the index's search analyzer. */
export const LEXICAL_QUERY = Object.freeze({ type: 'best_fields', operator: 'or' } as const);

/** How a channel's last places are filled (module comment). */
export type ChannelCutoff = 'score-then-id' | 'approximate' | 'elasticsearch-order';

export interface CasesChannelConfig {
  readonly index: 'cases';
  readonly content: CasesChannelContent;
  readonly fields: readonly string[];
  /** Unique cases the channel returns. */
  readonly size: number;
  readonly cutoff: 'score-then-id';
}

export interface MappingConfig {
  /** Which cases are mapped: those among the leading `params.packCandidates` with no passage from a passage channel. */
  readonly cases: 'leading-without-passages';
  /** Passages each mapped case gets: its best by the request's own query vector, under the passages filter. */
  readonly passagesPerCase: number;
  /**
   * The count of the case's passages under the filter, then an exact kNN over all of
   * them (`k` = `num_candidates` = the count; the response must hold exactly that many),
   * then the best `passagesPerCase` by score, then passage id.
   */
  readonly selection: 'count-then-exact-all-then-score-then-id';
  /** The documented mapping-size limit: a case with more passages under the filter is `too_many_passages`, never packed. */
  readonly maxPassagesPerCase: number;
}

export interface RetrievalConfig {
  readonly version: RetrievalVersion;
  /** `production`: the default; `rollback`: kept to switch back to; `experimental`: dev only. */
  readonly status: 'production' | 'rollback' | 'experimental';
  /** Passage channel depth, kNN candidates factor, RRF constant, packing limits and the per-request timeout. */
  readonly params: Readonly<RetrievalParams>;
  /** BM25 channels search the request's keyword text (the scope stage's); kNN embeds the effective question. */
  readonly text: { readonly lexical: 'keyword-text'; readonly vector: 'question' };
  readonly lexicalQuery: typeof LEXICAL_QUERY;
  readonly channels: {
    readonly keyword: { readonly index: 'passages'; readonly fields: readonly ['text']; readonly size: number; readonly cutoff: 'score-then-id' | 'elasticsearch-order' };
    readonly vector: { readonly index: 'passages'; readonly field: 'embedding'; readonly k: number; readonly numCandidates: number; readonly cutoff: 'approximate' };
    readonly cases: CasesChannelConfig | null;
  };
  readonly fusion: {
    /** `passage`: RRF over the passage lists, cases at their best passage; `case`: RRF over each channel's unique cases. */
    readonly level: 'passage' | 'case';
    readonly k: number;
    readonly weights: { readonly keyword: number; readonly vector: number; readonly cases: number };
    /** How fused scores compare and ties break (server/search/rrf.ts; server/search/case-fusion.ts). */
    readonly ranking: string;
  };
  readonly mapping: MappingConfig | null;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const V1_PARAMS = retrievalParams({ ...RETRIEVAL_DEFAULTS });
/**
 * The mapping-size limit: every passage of a mapped case is returned and scored, so a case
 * may hold at most this many under the filter (the largest dev case holds 63).
 */
export const MAX_MAPPED_PASSAGES = 1_000;
const V2_PARAMS = retrievalParams({ ...RETRIEVAL_DEFAULTS, perChannel: 200 });

const passageChannels = (p: RetrievalParams, keywordCutoff: 'score-then-id' | 'elasticsearch-order') =>
  ({
    keyword: { index: 'passages', fields: ['text'], size: p.perChannel, cutoff: keywordCutoff },
    vector: { index: 'passages', field: 'embedding', k: p.perChannel, numCandidates: p.perChannel * p.numCandidatesFactor, cutoff: 'approximate' },
  }) as const;

const CASE_RANKING =
  'exact rational RRF over what the channels returned; each channel ordered by score then id before it is collapsed to unique cases; ties: best channel rank, then the channel ranks in channel order (keyword, vector, cases), then the case number';

export const RETRIEVAL_V1: RetrievalConfig = deepFreeze({
  version: 'retrieval.v1',
  status: 'rollback',
  params: V1_PARAMS,
  text: { lexical: 'keyword-text', vector: 'question' },
  lexicalQuery: LEXICAL_QUERY,
  channels: { ...passageChannels(V1_PARAMS, 'elasticsearch-order'), cases: null },
  fusion: {
    level: 'passage',
    k: V1_PARAMS.rrfK,
    weights: { keyword: 1, vector: 1, cases: 0 },
    ranking: 'floating-point RRF over the passage lists; ties: best rank, then passage id; cases at their best passage',
  },
  mapping: null,
} as RetrievalConfig);

const v2 = (version: 'retrieval.v2' | 'retrieval.v2-nf', content: CasesChannelContent): RetrievalConfig =>
  deepFreeze({
    version,
    status: version === 'retrieval.v2' ? 'production' : 'experimental',
    params: V2_PARAMS,
    text: { lexical: 'keyword-text', vector: 'question' },
    lexicalQuery: LEXICAL_QUERY,
    channels: {
      ...passageChannels(V2_PARAMS, 'score-then-id'),
      cases: { index: 'cases', content, fields: [...CASES_CHANNEL_FIELDS[content]], size: 200, cutoff: 'score-then-id' },
    },
    fusion: { level: 'case', k: V2_PARAMS.rrfK, weights: { keyword: 1, vector: 1, cases: 1 }, ranking: CASE_RANKING },
    mapping: {
      cases: 'leading-without-passages',
      passagesPerCase: V2_PARAMS.maxPassagesPerCase,
      selection: 'count-then-exact-all-then-score-then-id',
      maxPassagesPerCase: MAX_MAPPED_PASSAGES,
    },
  } as RetrievalConfig);

export const RETRIEVAL_V2: RetrievalConfig = v2('retrieval.v2', 'narratives');
export const RETRIEVAL_V2_NF: RetrievalConfig = v2('retrieval.v2-nf', 'narratives+findings');

export const RETRIEVAL_CONFIGS: Readonly<Record<RetrievalVersion, RetrievalConfig>> = Object.freeze({
  'retrieval.v1': RETRIEVAL_V1,
  'retrieval.v2': RETRIEVAL_V2,
  'retrieval.v2-nf': RETRIEVAL_V2_NF,
});

export function retrievalConfig(version: RetrievalVersion): RetrievalConfig {
  const c = RETRIEVAL_CONFIGS[version];
  if (!c) throw new Error(`unknown retrieval version ${String(version)}`);
  return c;
}

/** Canonical JSON (sorted keys) of a configuration: equal exactly when the behaviour is. */
export function canonicalRetrievalConfig(c: RetrievalConfig): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(c));
}

/** sha256 of the canonical configuration: the identity evaluation reports and caches record with the version. */
export const retrievalConfigSha256 = (c: RetrievalConfig): string => createHash('sha256').update(canonicalRetrievalConfig(c)).digest('hex');

/** What a report records about the retrieval it measured. */
export const retrievalIdentity = (c: RetrievalConfig): { version: RetrievalVersion; status: RetrievalConfig['status']; sha256: string } => ({
  version: c.version,
  status: c.status,
  sha256: retrievalConfigSha256(c),
});
