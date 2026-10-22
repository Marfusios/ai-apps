/**
 * The ports the brief pipeline reads evidence through.
 *
 * `EvidenceRetriever` is the narrow interface to hybrid retrieval (Task 10's
 * `retrieveCandidates` and `fetchAndPack`, bound in server/briefs/retriever.ts). It
 * fits two properties of that code:
 * - query-embedding usage is reported through the caller's `onEmbeddingUsage` callback
 *   as soon as the embedding succeeds, so a later Elasticsearch or packing failure
 *   cannot lose a paid stage; a failed embedding is reported by `RetrievalFailure`'s
 *   `embedding` billing;
 * - a bundle holds at most 6 cases and 12 passages, where every case has its best
 *   retrieved passage and all its probable-cause variants, marked `reserved`. `repack`
 *   packs the same candidates again under a smaller evidence-token budget (no new
 *   embedding), for the 16,000-token compose cap (amendment A11), which is measured
 *   with the language model's own token counter.
 *
 * The pipeline trusts none of it: `CaseCatalog` reads the dataset in PostgreSQL (case
 * summaries for the cards, and the canonical `passages` rows with their section
 * revisions), and every passage is checked against its canonical row and every case
 * against its complete cause set before anything is quoted (gate G6 #2, #4; a broken
 * bundle fails the step instead of losing evidence).
 */
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import type { ReportLink } from '../../shared/contracts/cases.js';
import type { CaseRow, SectionKind } from '../../shared/contracts/search.js';
import type { CanonicalPassage } from './validate.js';

export interface EvidenceDataset {
  generationId: number;
  passagesIndex: string;
}

export interface EvidenceQuery {
  dataset: EvidenceDataset;
  /** Text embedded for the dense channel: the question and the text refinement in effect. */
  text: string;
  /** Text for the keyword (BM25) channel: the scope stage's `keywordText`. */
  keywordText: string;
  /** Validated filters; retrieval adds its compulsory clauses (US, answer-eligible). */
  filters: BriefFilters;
}

/** One query embedding, reported once it is paid for. */
export interface EmbeddingUsage {
  provider: 'openai';
  model: string;
  tokens: number;
  usd: number;
  /** `uncertain`: the provider reported no usable usage; settlement charges the stage in full. */
  billing: 'reported' | 'uncertain';
}

/** A retrieved passage, with the attribution and offsets retrieval read from the index. */
export interface EvidencePassage {
  passageId: string;
  ntsbNo: string;
  sectionId: string;
  revisionId: string;
  sectionKind: SectionKind;
  scope: 'aircraft' | 'event';
  /** The aircraft of an aircraft-scoped passage; null when event-scoped. */
  aircraftKey: number | null;
  /** UTF-16 offsets into the section's citation text. */
  start: number;
  end: number;
  text: string;
  /** Why it is in the bundle: the case's retrieved passages, its causes, or room-filling extras. */
  role: 'retrieved' | 'probable_cause' | 'fill';
  /** Part of the case's justification: its best retrieved passage or one of its causes; never dropped. */
  reserved: boolean;
  /** 1-based fused rank; null for an attached cause. */
  rank: number | null;
}

export interface EvidenceCase {
  ntsbNo: string;
  /** 1-based rank of the case among the candidates. */
  rank: number;
  /** Reading order: factual, analysis, probable cause. */
  passages: EvidencePassage[];
}

export interface EvidenceBundle {
  cases: EvidenceCase[];
  /** Passages in the bundle (at most 12). */
  passages: number;
  /** `cl100k_base` tokens of the passage text (retrieval's own budget unit). */
  evidenceTokens: number;
}

export interface RetrievedEvidence {
  bundle: EvidenceBundle;
  /** Pack the same candidates again under a smaller evidence-token budget. */
  repack(maxEvidenceTokens: number, signal: AbortSignal): Promise<EvidenceBundle>;
}

export type RetrievalFailureKind = 'unavailable' | 'timeout' | 'failed';

/** Why retrieval failed, as a fixed category for the step's record (never an error message). */
export type RetrievalFailureReason =
  | 'no_passages_index'
  | 'index_mismatch'
  | 'aborted'
  | 'query_too_long'
  | 'embedding'
  | 'incomplete_search'
  | 'malformed_passage'
  | 'search'
  | 'other';

/**
 * Retrieval did not produce a bundle. `embedding` says whether a failed embedding may
 * have been billed. The message is fixed text: it reaches no client, but it must not
 * carry index names, contract values or upstream text either.
 */
export class RetrievalFailure extends Error {
  override readonly name = 'RetrievalFailure';
  constructor(
    readonly kind: RetrievalFailureKind,
    /** `none`: no embedding was billed by this failure (or it was reported through the callback first). */
    readonly embedding: 'none' | 'uncertain',
    message = `retrieval failed: ${kind}`,
    readonly reason?: RetrievalFailureReason,
  ) {
    super(message);
  }
}

export interface EvidenceRetriever {
  /** Whether the dataset can serve evidence: a published, compatible passages index. */
  available(dataset: { generationId: number; passagesIndex: string | null }): Promise<boolean>;
  /**
   * Retrieve one bundle. Calls `onEmbeddingUsage` once, as soon as the query embedding
   * is paid for. Throws `RetrievalFailure` (or rejects when `signal` aborts).
   */
  retrieve(query: EvidenceQuery, signal: AbortSignal, onEmbeddingUsage: (usage: EmbeddingUsage) => void): Promise<RetrievedEvidence>;
}

/** NTSB fields of a case for its card. */
export interface CaseSummary {
  row: Omit<CaseRow, 'snippet'>;
  report: ReportLink;
  /** Suffixed numbers of its aircraft (`SEA08LA057A`), allowlisted alongside the event number. */
  aircraftNumbers: string[];
}

export interface CaseCatalog {
  /** Summaries of the given cases in one generation; unknown numbers are absent. */
  summaries(generationId: number, ntsbNos: readonly string[]): Promise<Map<string, CaseSummary>>;
  /** Canonical `passages` rows of one generation and chunker by passage id, with their section text and sha256. */
  passages(generationId: number, chunkerVersion: string, passageIds: readonly string[]): Promise<Map<string, CanonicalPassage>>;
  /** Every probable-cause passage id of the given cases (one generation and chunker), by case. */
  causePassageIds(generationId: number, chunkerVersion: string, ntsbNos: readonly string[]): Promise<Map<string, string[]>>;
}
