/** Advisory evidence search: only the question and explicit user edits control retrieval.
 * Suggestions are unapplied, untrusted text. Render them as labelled text, never HTML.
 * Every surface keeps EVIDENCE_NOTICE. Canonical paragraphs and cause variants are unchanged.
 */
import { z } from 'zod';
import { BRIEF_FILTER_FACETS, BriefFiltersSchema, IdempotencyKeySchema, QuestionSchema, ScopeReplySchema, TurnstileTokenSchema } from './briefs.js';
import { ReportLinkSchema } from './cases.js';
import { NtsbNoSchema, Sha256Schema } from './common.js';
import { CaseRowSchema, SectionKindSchema, SpanSchema } from './search.js';

export const EVIDENCE_CONTRACT_VERSION = 'evidence.v2';
export const EVIDENCE_PAGE_SIZE = 10;
/** Retrieval ranks at most this many cases for one search (10 pages). */
export const EVIDENCE_CANDIDATE_CEILING = 100;
export const EVIDENCE_TTL_MS = 24 * 60 * 60_000;
/** Excerpts shown per case: the retrieved passages' paragraphs, best first. */
export const MAX_EXCERPTS_PER_CASE = 3;
export const MAX_TERMS_CHARS = 300;

// ---------------------------------------------------------------------------
// Copy shown on every result surface (sheet, drawer, Compare, print). Fixed text, never model text.

export const EVIDENCE_HEADING = 'Investigations retrieved for your search';
export const EVIDENCE_NOTICE =
  'AirCase matched your words and filters. It has not checked timing, causes or things that did not happen: read the excerpts.';

/** Required label beside model suggestions; accepting filters never accepts terms. */
export const EVIDENCE_SUGGESTION_LABEL = 'Suggested filters and terms — not applied';
export const EvidenceSearchIdSchema = z.uuid();
export type EvidenceSearchId = z.infer<typeof EvidenceSearchIdSchema>;
export const EvidenceSuggestionSchema = z.strictObject({
  filters: BriefFiltersSchema,
  terms: z.string().min(1).max(MAX_TERMS_CHARS).regex(/\S/, 'the search terms are empty'),
});
export type EvidenceSuggestion = z.infer<typeof EvidenceSuggestionSchema>;
export const EvidenceQuerySchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('question') }),
  z.strictObject({ source: z.literal('edited'), terms: EvidenceSuggestionSchema.shape.terms }),
]);
export type EvidenceQuery = z.infer<typeof EvidenceQuerySchema>;
export const EvidenceHintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('corpus_statistics'), filters: BriefFiltersSchema }),
  z.strictObject({ kind: z.literal('case_comparison'), found: z.array(NtsbNoSchema).max(4), notFound: z.array(NtsbNoSchema).max(4) }),
]);
export type EvidenceHint = z.infer<typeof EvidenceHintSchema>;

/** Edited filters are exact. Omitted terms retain the parent's executed query; supplied
 * terms are explicit user acceptance. No scope call runs on edits. Paging is free. */
export const CreateEvidenceRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('question'),
    question: QuestionSchema,
    idempotencyKey: IdempotencyKeySchema,
    turnstileToken: TurnstileTokenSchema,
  }),
  z.strictObject({
    kind: z.literal('edited'),
    from: EvidenceSearchIdSchema,
    filters: BriefFiltersSchema,
    terms: EvidenceSuggestionSchema.shape.terms.optional(),
    idempotencyKey: IdempotencyKeySchema,
    turnstileToken: TurnstileTokenSchema,
  }),
]);
export type CreateEvidenceRequest = z.infer<typeof CreateEvidenceRequestSchema>;

/** `GET /api/evidence/:id?page=n` (1-based; `n` at most `pages`). */
export const EvidencePageQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(EVIDENCE_CANDIDATE_CEILING / EVIDENCE_PAGE_SIZE).default(1),
});

// ---------------------------------------------------------------------------
// Results

const SectionKeySchema = z.string().regex(/^[a-z_]+\/(event|aircraft)-\d+$/);

/** A highlighted query term in an excerpt: a literal occurrence, or a match of the analyzer's synonyms. */
export const EvidenceHighlightSchema = SpanSchema.extend({ match: z.enum(['literal', 'synonym']) });

/**
 * One whole paragraph of a canonical section, as stored. `paragraph` locates it in the section text
 * (the case page's section `key` and `revision`), so "show the full section" opens the section at
 * this paragraph. `seed` is the retrieved passage that led to it, also in section offsets.
 */
export const EvidenceExcerptSchema = z
  .strictObject({
    sectionKey: SectionKeySchema,
    section: SectionKindSchema,
    label: z.string().min(1).max(40),
    scope: z.enum(['event', 'aircraft']),
    aircraftKey: z.number().int().nonnegative().nullable(),
    revision: Sha256Schema,
    paragraph: SpanSchema,
    seed: SpanSchema,
    /** The paragraph's text: exactly the section text in `paragraph`. */
    text: z.string().min(1).max(200_000),
    /** Offsets into `text`, sorted and non-overlapping. */
    highlights: z.array(EvidenceHighlightSchema).max(200),
  })
  .superRefine((excerpt, ctx) => {
    if (excerpt.paragraph.end - excerpt.paragraph.start !== excerpt.text.length) {
      ctx.addIssue({ code: 'custom', message: 'paragraph span and text length differ' });
    }
    let previous = 0;
    for (const span of excerpt.highlights) {
      if (span.start < previous || span.end <= span.start || span.end > excerpt.text.length) {
        ctx.addIssue({ code: 'custom', message: 'highlights must be sorted, non-overlapping and inside text' });
        return;
      }
      previous = span.end;
    }
  });
export type EvidenceExcerpt = z.infer<typeof EvidenceExcerptSchema>;

/** A probable-cause statement as published, with its scope (multi-aircraft events can have several). */
export const ProbableCauseVariantSchema = z.strictObject({
  sectionKey: SectionKeySchema,
  scope: z.enum(['event', 'aircraft']),
  aircraftKey: z.number().int().nonnegative().nullable(),
  revision: Sha256Schema,
  text: z.string().min(1).max(200_000),
});
export type ProbableCauseVariant = z.infer<typeof ProbableCauseVariantSchema>;

/**
 * Why a case is listed, in checkable facts only: the applied filters it satisfies (from coded
 * fields), the suggested terms (or executed query words) counted in the excerpts shown (literal occurrences and synonym matches
 * separately), and which retrieval channels found it. Never a model-written reason.
 */
export const EvidenceRelevanceSchema = z.strictObject({
  filters: z.array(z.enum([...BRIEF_FILTER_FACETS, 'years'])).max(BRIEF_FILTER_FACETS.length + 1),
  terms: z
    .array(
      z.strictObject({
        term: z.string().min(1).max(80),
        literal: z.number().int().nonnegative(),
        synonym: z.number().int().nonnegative(),
      }),
    )
    .max(20),
  channels: z.array(z.enum(['keyword', 'similarity', 'narrative'])).min(1).max(3),
});
export type EvidenceRelevance = z.infer<typeof EvidenceRelevanceSchema>;

export const EvidenceCaseSchema = z.strictObject({
  /** 1-based position in the pinned ranking. */
  rank: z.number().int().min(1).max(EVIDENCE_CANDIDATE_CEILING),
  case: CaseRowSchema.omit({ snippet: true }),
  report: ReportLinkSchema,
  /** Every probable-cause statement of the case, from canonical data, in section order. */
  probableCauses: z.array(ProbableCauseVariantSchema).max(16),
  excerpts: z.array(EvidenceExcerptSchema).max(MAX_EXCERPTS_PER_CASE),
  relevance: EvidenceRelevanceSchema,
});
export type EvidenceCase = z.infer<typeof EvidenceCaseSchema>;

/** One page of a stored search. */
export const EvidencePageSchema = z.strictObject({
  version: z.literal(EVIDENCE_CONTRACT_VERSION),
  id: EvidenceSearchIdSchema,
  /** The question as asked (an edited search keeps its original question). */
  question: QuestionSchema,
  query: EvidenceQuerySchema,
  appliedFilters: BriefFiltersSchema,
  suggestion: EvidenceSuggestionSchema.nullable(),
  hint: EvidenceHintSchema.nullable(),
  /** The dataset generation the ranking is pinned to. */
  generation: z.string().min(1).max(80),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Cases ranked for this search (0 when nothing matched). */
  total: z.number().int().min(0).max(EVIDENCE_CANDIDATE_CEILING),
  page: z.number().int().min(1),
  pages: z.number().int().min(0).max(EVIDENCE_CANDIDATE_CEILING / EVIDENCE_PAGE_SIZE),
  cases: z.array(EvidenceCaseSchema).max(EVIDENCE_PAGE_SIZE),
});
export type EvidencePage = z.infer<typeof EvidencePageSchema>;

/** The scope replies an evidence search can get instead of results (static server templates; no AI search used). */
// Keep the inferred TypeScript union as narrow as the runtime contract.
export const EvidenceScopeReplySchema = z.discriminatedUnion('kind', [
  ScopeReplySchema.options[0], // out_of_scope
  ScopeReplySchema.options[1], // operational_advice
]);

/** `POST /api/evidence` → 201 `results` (page 1 of the new search) or 200 `scope_reply`. */
export const CreateEvidenceResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('results'), search: EvidencePageSchema }),
  z.strictObject({ kind: z.literal('scope_reply'), reply: EvidenceScopeReplySchema }),
]);
export type CreateEvidenceResponse = z.infer<typeof CreateEvidenceResponseSchema>;
