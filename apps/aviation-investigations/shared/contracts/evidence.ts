/**
 * The AI evidence view, contract `evidence.v1` (Task 23; owner decision of 2026-10-24; Astra's
 * conditions 1-7 for the narrower G6, recorded in the implementation ledger).
 *
 * A question becomes an editable search interpretation (scope stage `scope.e1`: validated
 * filters, search terms, and readings AirCase cannot check, which stay visible and are never
 * applied). Production retrieval (`retrieval.v2`) ranks completed investigations once, and the
 * ranked list is pinned and paged without further paid calls. Results are NTSB text and coded
 * data only: no AI-written prose ever reaches a result surface.
 *
 * - One search costs one scope call and one query embedding; an edited interpretation skips the
 *   scope call. Every created search counts as one AI search; paging is free.
 * - A stored search is private to its owner (the trial or the account that created it), expires
 *   24 hours after creation, moves to the account at sign-in like a brief, is deleted with the
 *   account and is never in a backup.
 * - Excerpts are whole paragraphs of canonical section text. Offsets are UTF-16 code units,
 *   validated against the stored section; highlights never change text.
 * - Every result surface shows `EVIDENCE_NOTICE`; unchecked readings supplement it, never
 *   replace it.
 */
import { z } from 'zod';
import { BRIEF_FILTER_FACETS, BriefFiltersSchema, IdempotencyKeySchema, QuestionSchema, ScopeReplySchema, TurnstileTokenSchema } from './briefs.js';
import { ReportLinkSchema } from './cases.js';
import { IsoDateTimeSchema, Sha256Schema } from './common.js';
import { CaseRowSchema, SectionKindSchema, SpanSchema } from './search.js';

export const EVIDENCE_CONTRACT_VERSION = 'evidence.v1';
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

/** Readings of a question that AirCase cannot check against the data: shown with the chips, never applied. */
export const UNCHECKED_KINDS = ['timing', 'causation', 'absence', 'sequence', 'unsupported_filter', 'ambiguous'] as const;
export type UncheckedKind = (typeof UNCHECKED_KINDS)[number];
export const UNCHECKED_LABEL: Readonly<Record<UncheckedKind, string>> = {
  timing: 'AirCase cannot check timing',
  causation: 'AirCase cannot check what caused what',
  absence: 'AirCase cannot check that something did not happen',
  sequence: 'AirCase cannot check the order of events',
  unsupported_filter: 'AirCase has no filter for this',
  ambiguous: 'Unclear, so not applied',
};

// ---------------------------------------------------------------------------
// Requests

export const EvidenceSearchIdSchema = z.uuid();
export type EvidenceSearchId = z.infer<typeof EvidenceSearchIdSchema>;

export const UncheckedReadingSchema = z.strictObject({
  kind: z.enum(UNCHECKED_KINDS),
  /** The words of the question this reading comes from, verbatim (a substring of the question). */
  quote: z.string().min(1).max(300),
});
export type UncheckedReading = z.infer<typeof UncheckedReadingSchema>;

/** The editable search interpretation: filters Explore can apply, and the search terms. */
export const EvidenceInterpretationSchema = z.strictObject({
  filters: BriefFiltersSchema,
  /** Search terms for keyword and similarity retrieval: plain text, shown and editable. */
  terms: z.string().min(1).max(MAX_TERMS_CHARS).regex(/\S/, 'the search terms are empty'),
  /** Readings that were not applied, always shown beside the chips. */
  unchecked: z.array(UncheckedReadingSchema).max(8),
});
export type EvidenceInterpretation = z.infer<typeof EvidenceInterpretationSchema>;

/**
 * `POST /api/evidence`. `question`: the scope stage reads the question. `edited`: the user changed
 * the chips or terms of an earlier search they own; no scope call, the edits are taken as given
 * (a removed filter stays removed), and the earlier search's question and unchecked readings carry
 * over. Both count as one AI search and take the usual Turnstile and sign-in checks.
 */
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
    terms: EvidenceInterpretationSchema.shape.terms,
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
    text: z.string().min(1).max(20_000),
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
  text: z.string().min(1).max(20_000),
});
export type ProbableCauseVariant = z.infer<typeof ProbableCauseVariantSchema>;

/**
 * Why a case is listed, in checkable facts only: the applied filters it satisfies (from coded
 * fields), the query terms counted in the excerpts shown (literal occurrences and synonym matches
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
  interpretation: EvidenceInterpretationSchema,
  /** The interpretation is the user's edit, not the scope stage's reading. */
  edited: z.boolean(),
  /** The dataset generation the ranking is pinned to. */
  generation: z.string().min(1).max(80),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  /** Cases ranked for this search (0 when nothing matched). */
  total: z.number().int().min(0).max(EVIDENCE_CANDIDATE_CEILING),
  page: z.number().int().min(1),
  pages: z.number().int().min(0).max(EVIDENCE_CANDIDATE_CEILING / EVIDENCE_PAGE_SIZE),
  cases: z.array(EvidenceCaseSchema).max(EVIDENCE_PAGE_SIZE),
});
export type EvidencePage = z.infer<typeof EvidencePageSchema>;

/** The scope replies an evidence search can get instead of results (static server templates; no AI search used). */
export const EvidenceScopeReplySchema = ScopeReplySchema.refine((reply) => reply.kind !== 'needs_clarification', {
  message: 'ambiguity becomes an unchecked reading, never a clarification round',
});

/** `POST /api/evidence` → 201 `results` (page 1 of the new search) or 200 `scope_reply`. */
export const CreateEvidenceResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('results'), search: EvidencePageSchema }),
  z.strictObject({ kind: z.literal('scope_reply'), reply: EvidenceScopeReplySchema }),
]);
export type CreateEvidenceResponse = z.infer<typeof CreateEvidenceResponseSchema>;
