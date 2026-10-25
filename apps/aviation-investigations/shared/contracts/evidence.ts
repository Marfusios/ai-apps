/** Evidence search with explicit disclosures of applied state, keywords, ordering and marks.
 * Remaining suggestions are unapplied, untrusted text. Render them as labelled text, never HTML.
 * Every surface keeps EVIDENCE_NOTICE. Canonical paragraphs and cause variants are unchanged.
 */
import { z } from 'zod';
import { BRIEF_FILTER_FACETS, BriefFiltersSchema, IdempotencyKeySchema, QuestionSchema, TurnstileTokenSchema } from './briefs.js';
import { US_STATE_CODES } from '../vocab.js';
import { ReportLinkSchema } from './cases.js';
import { NtsbNoSchema, Sha256Schema } from './common.js';
import { CaseRowSchema, SectionKindSchema, SpanSchema } from './search.js';

export const EVIDENCE_CONTRACT_VERSION = 'evidence.v3';
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
/**
 * The research-only boundary (gate answer 2: unconditional, like EVIDENCE_NOTICE): shown with the
 * notice on every surface that shows an evidence search's results, whatever the scope stage did.
 */
export const EVIDENCE_BOUNDARY =
  'AirCase is a research tool for published NTSB investigations, not a source of operational flight or maintenance advice.';

/** Required label beside model suggestions; accepting filters never accepts terms. */
export const EVIDENCE_SUGGESTION_LABEL = 'Suggested filters and terms — not applied';

/**
 * Capability notes (gate answer 2, 2026-10-25): a validated scope intent may select one of these
 * fixed, generally true reminders, shown above the results. They are never model text, never a claim
 * about the particular question, and never affect retrieval, ranking, filters, pages, admission or
 * accounting; their absence means nothing. Nothing in the evidence view blocks a search.
 */
export const EVIDENCE_NOTE_KINDS = ['scope', 'operational_advice'] as const;
export const EvidenceNoteSchema = z.enum(EVIDENCE_NOTE_KINDS);
export type EvidenceNote = z.infer<typeof EvidenceNoteSchema>;
export const EVIDENCE_NOTE_TEXT: Readonly<Record<EvidenceNote, string>> = {
  scope: 'AirCase searches published NTSB aviation investigations only. The investigations below were retrieved for your words.',
  operational_advice:
    'AirCase is a research tool, not a source of operational flight or maintenance advice. For a flight in progress, contact ATC; for airworthiness, use your aircraft’s approved data and a certificated mechanic.',
};
export const EvidenceSearchIdSchema = z.uuid();
export type EvidenceSearchId = z.infer<typeof EvidenceSearchIdSchema>;
export const EvidenceTermsSchema = z.string().min(1).max(MAX_TERMS_CHARS).regex(/\S/, 'the search terms are empty');
/** Frozen model-facing shape: scope.e3 is evaluated independently of the public contract. */
export const EvidenceScopeSuggestionSchema = z.strictObject({ filters: BriefFiltersSchema, terms: EvidenceTermsSchema });
export type EvidenceScopeSuggestion = z.infer<typeof EvidenceScopeSuggestionSchema>;
export const EvidenceSuggestionSchema = z.strictObject({ filters: BriefFiltersSchema, terms: EvidenceTermsSchema.nullable() });
export const EvidenceAutomaticFiltersSchema = z.strictObject({ state: z.array(z.enum(US_STATE_CODES)).min(1).max(US_STATE_CODES.length) });
export type EvidenceAutomaticFilters = z.infer<typeof EvidenceAutomaticFiltersSchema>;
export const EvidenceKeywordsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question') }),
  z.strictObject({ kind: z.literal('question+terms'), terms: EvidenceTermsSchema }),
  z.strictObject({ kind: z.literal('terms'), terms: EvidenceTermsSchema }),
]);
export type EvidenceSuggestion = z.infer<typeof EvidenceSuggestionSchema>;
export const EvidenceQuerySchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('question'), keywords: EvidenceKeywordsSchema }),
  z.strictObject({ source: z.literal('edited'), terms: EvidenceTermsSchema }),
]);
export type EvidenceQuery = z.infer<typeof EvidenceQuerySchema>;
export const EvidenceHintSchema = z.discriminatedUnion('kind', [
  /** An explicit request for counts or trends: the UI links to the dashboard. */
  z.strictObject({ kind: z.literal('corpus_statistics') }),
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
    terms: EvidenceTermsSchema.optional(),
    keywords: z.literal('question').optional(),
    idempotencyKey: IdempotencyKeySchema,
    turnstileToken: TurnstileTokenSchema,
  }).refine(v => v.terms === undefined || v.keywords === undefined, { message: 'terms and keywords cannot be combined', path: ['keywords'] }),
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
  automaticFilters: EvidenceAutomaticFiltersSchema.nullable(),
  order: z.enum(['ai_relevance', 'match']),
  marks: z.enum(['suggested_terms', 'search_words']),
  freeUndo: z.boolean(),
  /** Current one-use undo hint, recomputed on read; admission remains authoritative. */
  undo: z.enum(['available', 'used', 'none']),
  suggestion: EvidenceSuggestionSchema.nullable(),
  hint: EvidenceHintSchema.nullable(),
  /** A fixed capability reminder selected by the validated scope intent, or null (also for edits). */
  note: EvidenceNoteSchema.nullable(),
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

/** `POST /api/evidence` → 201 `results` (page 1 of the new search). Nothing blocks a search: policy
 * intents only select a capability note (`note`). */
export const CreateEvidenceResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('results'), search: EvidencePageSchema }),
]);
export type CreateEvidenceResponse = z.infer<typeof CreateEvidenceResponseSchema>;
