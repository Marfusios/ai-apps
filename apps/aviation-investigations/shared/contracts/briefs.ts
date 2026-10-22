/**
 * AI briefs (DESIGN §2, §3, §5, §6; UI_DESIGN §4.3–§4.6, §5): one question plus at
 * most three refinements, each a metered step through scope, retrieval, composition
 * and validation. Every route under `/api/briefs` is per visitor and `no-store`, and
 * only the brief's read owner can read it.
 *
 * | Endpoint | Request | Response |
 * | --- | --- | --- |
 * | `POST /api/briefs` | `CreateBriefRequest` | `StartBriefResponse` |
 * | `POST /api/briefs/:id/refine` | `RefinementRequest` | `StartBriefResponse` |
 * | `GET /api/briefs/:id?step=n` | — | `BriefStepResponse` (latest step without `step`) |
 * | `POST /api/briefs/:id/cancel` | — | 204 |
 * | `GET /api/briefs/:id/steps/:n/cases/:ntsbNo` | — | `CaseContextResponse` |
 *
 * Nothing a language model writes is shown without validation: case numbers come
 * from server-owned fields, quotes are exact passage substrings, labels, chips,
 * clarification readings and static replies are server templates. The schema of the
 * composition the answer model must return (`ComposeOutputSchema`) is here too, so
 * the reviewed shape and the rendered shape sit side by side.
 */
import { z } from 'zod';
import { ReportLinkSchema } from './cases.js';
import { NtsbNoSchema } from './common.js';
import { CaseRowSchema, FACET_VALUES, SectionKindSchema, SpanSchema } from './search.js';

// ---------------------------------------------------------------------------
// Limits

export const QUESTION_MAX_CHARS = 1_500;
/** The question plus three refinements (DESIGN §2). */
export const MAX_BRIEF_STEPS = 4;
export const MAX_REFINEMENTS = MAX_BRIEF_STEPS - 1;
/** Retrieval bounds (DESIGN §5): at most six cases and twelve passages per step. */
export const MAX_BRIEF_CASES = 6;
export const MAX_BRIEF_PASSAGES = 12;
/** Briefs live inside the 24-hour temporary-processing window (DESIGN §7). */
export const BRIEF_TTL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Vocabularies

/**
 * Where a step is. The first four are the running pipeline stages, in order (the
 * checklist rows of UI_DESIGN §4.4); `done` and `failed` are final.
 */
export const BRIEF_STAGES = ['scope', 'retrieve', 'compose', 'validate', 'done', 'failed'] as const;
export type BriefStage = (typeof BRIEF_STAGES)[number];
export const RUNNING_STAGES = ['scope', 'retrieve', 'compose', 'validate'] as const satisfies readonly BriefStage[];

/**
 * Mechanical evidence (DESIGN §3), the evidence glyphs of UI_DESIGN §2.4, in the order
 * groups are shown: causal fault established; defect found, causal link not
 * established; no fault identified; insufficient or conflicting evidence.
 */
export const GLYPH_KINDS = ['causal', 'defect_not_causal', 'no_fault', 'insufficient'] as const;
export type GlyphKind = (typeof GLYPH_KINDS)[number];
/** `examples`: one relevance-ordered list for questions that are not about a mechanical cause. */
export const GROUP_KINDS = [...GLYPH_KINDS, 'examples'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

/** Whose words a quote gives (DESIGN §3 "Attribution"). Section labels stay deterministic. */
export const SPEAKERS = ['investigators', 'pilot', 'witness'] as const;
export type Speaker = (typeof SPEAKERS)[number];

/** Maintenance relationship (DESIGN §3). */
export const MAINTENANCE_RELATIONS = [
  'investigator_attributed',
  'preceding_not_established',
  'no_evidence',
  'unknown',
] as const;
export type MaintenanceRelation = (typeof MAINTENANCE_RELATIONS)[number];

/** Symptom (DESIGN §3). `other`: a symptom outside this list. */
export const SYMPTOMS = ['total_power_loss', 'partial_power_loss', 'rough_running', 'failure_to_climb', 'other'] as const;
export type Symptom = (typeof SYMPTOMS)[number];
/** The failure readings a clarification or interpretation can pin. */
export const FAILURE_TYPES = ['total_power_loss', 'partial_power_loss', 'rough_running', 'failure_to_climb'] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

/** Timing since the relevant maintenance (DESIGN §3). Unknown timing is left out. */
export const TIMING_BASES = ['flight_hours', 'calendar_days', 'first_flight', 'subsequent_flight', 'qualitative'] as const;
export type TimingBasis = (typeof TIMING_BASES)[number];
export const TIMING_BOUNDS = ['exact', 'about', 'at_most', 'at_least'] as const;
export type TimingBound = (typeof TIMING_BOUNDS)[number];

// ---------------------------------------------------------------------------
// Shared pieces

/** Brief ids are random UUIDs. */
export const BriefIdSchema = z.uuid();
export const StepNumberSchema = z.number().int().min(1).max(MAX_BRIEF_STEPS);
/** Client idempotency key, scoped to the visitor (DESIGN §8). */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'expected 8-128 of A-Z a-z 0-9 _ -');
/** The Turnstile widget's token; the anonymous gate validates it (server/identity/gate.ts). */
export const TurnstileTokenSchema = z.string().max(2_048).nullable().optional();
export const QuestionSchema = z.string().min(1).max(QUESTION_MAX_CHARS).regex(/\S/, 'the question is empty');
const IsoInstant = z.iso.datetime();

/** Facets a brief can filter on: Explore's facets without `completion` (AI answers use completed cases only). */
export const BRIEF_FILTER_FACETS = [
  'phase',
  'injury',
  'conditions',
  'light',
  'category',
  'engine',
  'far_part',
  'purpose',
  'state',
] as const;
export type BriefFilterFacet = (typeof BRIEF_FILTER_FACETS)[number];

function facetList<const F extends BriefFilterFacet>(facet: F) {
  const values = FACET_VALUES[facet] as readonly string[];
  return z
    .array(z.enum(values as [string, ...string[]]))
    .max(values.length)
    .optional();
}

const FilterYear = z.number().int().min(1900).max(2100);

/** The validated filter object Explore uses, as JSON (UI_DESIGN §4.3). Values are Explore's facet values. */
export const BriefFiltersSchema = z
  .strictObject({
    phase: facetList('phase'),
    injury: facetList('injury'),
    conditions: facetList('conditions'),
    light: facetList('light'),
    category: facetList('category'),
    engine: facetList('engine'),
    far_part: facetList('far_part'),
    purpose: facetList('purpose'),
    state: facetList('state'),
    yearFrom: FilterYear.optional(),
    yearTo: FilterYear.optional(),
  })
  .refine((f) => f.yearFrom === undefined || f.yearTo === undefined || f.yearFrom <= f.yearTo, {
    message: 'yearFrom must not be after yearTo',
    path: ['yearFrom'],
  });
export type BriefFilters = z.infer<typeof BriefFiltersSchema>;

/** A calendar-day and/or flight-hour window, e.g. "within 30 days or 10 flight hours". */
export const TimingWindowSchema = z
  .strictObject({
    days: z.number().int().min(1).max(365).nullable(),
    flightHours: z.number().int().min(1).max(500).nullable(),
  })
  .refine((w) => w.days !== null || w.flightHours !== null, { message: 'set days, flight hours or both' });
export type TimingWindow = z.infer<typeof TimingWindowSchema>;

/** Readings a visitor can edit or pin (UI_DESIGN §4.3 "interpretation chips"). */
export const INTERPRETATION_FIELDS = ['timing_window', 'first_flight_only', 'failure_type'] as const;
export type InterpretationField = (typeof INTERPRETATION_FIELDS)[number];

// ---------------------------------------------------------------------------
// Requests

/** `POST /api/briefs`. `turnstileToken` is required for anonymous visitors (every request). */
export const CreateBriefRequestSchema = z.strictObject({
  question: QuestionSchema,
  filters: BriefFiltersSchema.optional(),
  turnstileToken: TurnstileTokenSchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type CreateBriefRequest = z.infer<typeof CreateBriefRequestSchema>;

const TextChange = z.strictObject({ kind: z.literal('text'), text: QuestionSchema });

const InterpretationChange = z
  .strictObject({
    kind: z.literal('interpretation'),
    field: z.enum(INTERPRETATION_FIELDS),
    value: z.union([TimingWindowSchema, z.boolean(), z.enum(FAILURE_TYPES)]),
  })
  .superRefine((c, ctx) => {
    const ok =
      c.field === 'timing_window'
        ? typeof c.value === 'object'
        : c.field === 'first_flight_only'
          ? typeof c.value === 'boolean'
          : typeof c.value === 'string';
    if (!ok) ctx.addIssue({ code: 'custom', message: `value does not fit ${c.field}`, path: ['value'] });
  });

const FiltersChange = z.strictObject({ kind: z.literal('filters'), filters: BriefFiltersSchema });

/**
 * One bounded refinement (DESIGN §2): free `text`, an allowlisted `interpretation`
 * edit, or a `filters` replacement. Every variant runs the full pipeline again,
 * scope check included, and counts as one refinement.
 */
export const RefinementChangeSchema = z.discriminatedUnion('kind', [TextChange, InterpretationChange, FiltersChange]);
export type RefinementChange = z.infer<typeof RefinementChangeSchema>;

const Transport = { turnstileToken: TurnstileTokenSchema, idempotencyKey: IdempotencyKeySchema };

/** `POST /api/briefs/:id/refine`: a `RefinementChange` plus the request's Turnstile token and idempotency key. */
export const RefinementRequestSchema = z.discriminatedUnion('kind', [
  TextChange.extend(Transport),
  InterpretationChange.extend(Transport),
  FiltersChange.extend(Transport),
]);
export type RefinementRequest = z.infer<typeof RefinementRequestSchema>;

/** The refinement part of a request, without its transport fields. */
export function refinementChange(r: RefinementRequest): RefinementChange {
  switch (r.kind) {
    case 'text':
      return { kind: 'text', text: r.text };
    case 'interpretation':
      return { kind: 'interpretation', field: r.field, value: r.value };
    case 'filters':
      return { kind: 'filters', filters: r.filters };
  }
}

// ---------------------------------------------------------------------------
// Static scope replies (server templates; never model text)

const Line = z.string().min(1).max(300);

/** A keyword search the reply offers (free): Explore with this text and these filters. */
export const KeywordSuggestionSchema = z.strictObject({
  label: z.string().min(1).max(80),
  q: z.string().max(200),
  filters: BriefFiltersSchema,
});

/** A server-rendered reading of an ambiguous term; picking it posts `refinement` (1 search). */
export const ReadingSchema = z.strictObject({
  label: z.string().min(1).max(120),
  refinement: RefinementChangeSchema,
});
export type Reading = z.infer<typeof ReadingSchema>;

/** What a scope outcome other than a case search shows (UI_DESIGN §4.3 "Scope outcomes", §5). None uses a free search. */
export const ScopeReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('out_of_scope'),
    lines: z.array(Line).min(1).max(3),
    keywordSearchLabel: z.string().min(1).max(60),
  }),
  z.strictObject({
    kind: z.literal('operational_advice'),
    title: Line,
    lines: z.array(Line).min(1).max(3),
    suggestionsLabel: Line,
    suggestions: z.array(KeywordSuggestionSchema).length(2),
  }),
  z.strictObject({
    kind: z.literal('corpus_statistics'),
    lines: z.array(Line).min(1).max(2),
    /** The planner's filters after validation, for the dashboard and Explore links. */
    filters: BriefFiltersSchema,
  }),
  z.strictObject({
    kind: z.literal('case_comparison'),
    /** Case numbers from the question that exist in the dataset, in question order. */
    found: z.array(NtsbNoSchema).max(4),
    /** Case-number-shaped tokens from the question with no case in the dataset ("not found"). */
    notFound: z.array(NtsbNoSchema).max(4),
  }),
  z.strictObject({
    kind: z.literal('needs_clarification'),
    label: z.string().min(1).max(60),
    line: Line,
    readings: z.array(ReadingSchema).min(2).max(3),
  }),
]);
export type ScopeReply = z.infer<typeof ScopeReplySchema>;

// ---------------------------------------------------------------------------
// Responses

/**
 * `POST /api/briefs` and `/refine`. `started`: the question is in scope and the
 * pipeline is running (or a retry of a request already running); poll `GET`.
 * `scope_reply`: the question got a static reply and nothing more runs; it does not
 * use a free search (UI_DESIGN §5 counting rules).
 */
export const StartBriefResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), briefId: BriefIdSchema, step: StepNumberSchema, stage: z.enum(BRIEF_STAGES) }),
  z.strictObject({ kind: z.literal('scope_reply'), briefId: BriefIdSchema, step: StepNumberSchema, reply: ScopeReplySchema }),
]);
export type StartBriefResponse = z.infer<typeof StartBriefResponseSchema>;

/**
 * Checklist results (UI_DESIGN §4.4), filled in as stages complete. The server sends
 * stage status and counts only, never partial answer text.
 */
export const ChecklistSchema = z.strictObject({
  /** Question → IN SCOPE. */
  question: z.literal('in_scope').optional(),
  /** Search → "6 CASES · 12 PASSAGES". */
  searched: z
    .strictObject({
      cases: z.number().int().min(0).max(MAX_BRIEF_CASES),
      passages: z.number().int().min(0).max(MAX_BRIEF_PASSAGES),
    })
    .optional(),
  /** Write answer → done. */
  written: z.literal(true).optional(),
  /** Verify every quote → passed, or withheld (the summary is not shown). */
  verified: z.enum(['passed', 'withheld']).optional(),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

/** An interpretation chip: a server-rendered reading, editable as a refinement (1 search). */
export const InterpretationChipSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('timing_window'), value: TimingWindowSchema, label: z.string().min(1).max(120), pinned: z.boolean() }),
  z.strictObject({ field: z.literal('first_flight_only'), value: z.boolean(), label: z.string().min(1).max(120), pinned: z.boolean() }),
  z.strictObject({ field: z.literal('failure_type'), value: z.enum(FAILURE_TYPES), label: z.string().min(1).max(120), pinned: z.boolean() }),
]);
export type InterpretationChip = z.infer<typeof InterpretationChipSchema>;

/** A timing chip: typed value plus its server-rendered label ("5.1 FH", "≤ 17 DAYS", "1ST FLIGHT"). */
export const TimingChipSchema = z.strictObject({
  basis: z.enum(TIMING_BASES),
  value: z.number().min(0).max(100_000).nullable(),
  bound: z.enum(TIMING_BOUNDS),
  label: z.string().min(1).max(24),
});
export type TimingChip = z.infer<typeof TimingChipSchema>;

/**
 * A validated quote: the exact text of the cited passage at `span` (UTF-16 offsets
 * into the passage text) and at `sectionSpan` (offsets into the section's citation
 * text, `sectionId` at `revisionId`). `sectionRevision` is the sha256 of that section
 * text, the `revision` the case page reports for the section, so the drawer can check
 * it highlights the same text. `speaker` is the brief's reading of whose words they
 * are; the section label is deterministic.
 */
export const BriefQuoteSchema = z.strictObject({
  passageId: z.string().min(1).max(80),
  section: SectionKindSchema,
  scope: z.enum(['aircraft', 'event']),
  aircraftKey: z.number().int().nonnegative().nullable(),
  /** `<ntsbNo>:<section key>`; the key is the case page's section `key`. */
  sectionId: z.string().min(1).max(80),
  revisionId: z.string().regex(/^[0-9a-f]{64}$/),
  sectionRevision: z.string().regex(/^[0-9a-f]{64}$/),
  text: z.string().min(1).max(1_200),
  span: SpanSchema,
  sectionSpan: SpanSchema,
  speaker: z.enum(SPEAKERS),
});
export type BriefQuote = z.infer<typeof BriefQuoteSchema>;

/** An excerpt of NTSB text shown on a plain card (for example when the summary is withheld). */
export const NtsbExcerptSchema = z.strictObject({
  passageId: z.string().min(1).max(80),
  section: SectionKindSchema,
  text: z.string().min(1).max(1_200),
  truncatedStart: z.boolean(),
  truncatedEnd: z.boolean(),
});
export type NtsbExcerpt = z.infer<typeof NtsbExcerptSchema>;

/**
 * The evidence's aircraft: the aircraft of an aircraft-scoped passage, or the event
 * as a whole. In a multi-aircraft event, event-scoped evidence gets the caution
 * "Applies to the event; aircraft not stated" and no glyph (UI_DESIGN §4.3).
 */
export const EvidenceAttributionSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('aircraft'), aircraftKey: z.number().int().nonnegative() }),
  z.strictObject({ scope: z.literal('event'), multiAircraft: z.boolean() }),
]);

/** The AI's reading of one case. Absent on plain cards. */
export const CaseReadingSchema = z.strictObject({
  /** Null for a non-mechanical brief, or when attribution to one aircraft is ambiguous. */
  glyph: z.enum(GLYPH_KINDS).nullable(),
  /** WHY IT MATCHED: one validated, evidence-checked line. */
  why: z.string().min(1).max(300),
  timing: TimingChipSchema.nullable(),
  quotes: z.array(BriefQuoteSchema).min(1).max(3),
  evidence: EvidenceAttributionSchema,
});
export type CaseReading = z.infer<typeof CaseReadingSchema>;

/** A case on the briefing sheet: NTSB fields from the dataset, plus the AI reading when one passed validation. */
export const CaseCardSchema = z.strictObject({
  case: CaseRowSchema.omit({ snippet: true }),
  report: ReportLinkSchema,
  /** The case's best retrieved NTSB passage. */
  excerpt: NtsbExcerptSchema,
  reading: CaseReadingSchema.nullable(),
});
export type CaseCard = z.infer<typeof CaseCardSchema>;

export const EvidenceGroupSchema = z.strictObject({
  kind: z.enum(GROUP_KINDS),
  caseNumbers: z.array(NtsbNoSchema).max(MAX_BRIEF_CASES),
});

/** Summary text with case citations as server-owned case numbers (rendered as blue mono citations). */
export const SummarySegmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(1_500) }),
  z.strictObject({ kind: z.literal('case'), ntsbNo: NtsbNoSchema }),
]);
export type SummarySegment = z.infer<typeof SummarySegmentSchema>;

export const GapSchema = z.strictObject({ ntsbNo: NtsbNoSchema, text: z.string().min(1).max(300) });

/** Why a summary was withheld. Every variant still returns the case cards. */
export const WITHHELD_REASONS = [
  /** A quote, citation or case number failed the code checks (validateComposition). */
  'citation_check',
  /** The evidence checker reported a problem or was inconclusive. */
  'evidence_check',
  /** The answer model refused, was cut off, timed out or returned unusable output. */
  'compose_failed',
] as const;

const resultContext = {
  interpretations: z.array(InterpretationChipSchema).max(3),
  filters: BriefFiltersSchema,
};

/** The outcome of a finished step. */
export const BriefResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('answer'),
    ...resultContext,
    grouping: z.enum(['mechanical', 'examples']),
    summary: z.array(SummarySegmentSchema).min(1).max(120),
    /** Mechanical: the four evidence groups in display order, empty ones included. Examples: one group. */
    groups: z.array(EvidenceGroupSchema).min(1).max(GLYPH_KINDS.length),
    cases: z.array(CaseCardSchema).min(1).max(MAX_BRIEF_CASES),
    gaps: z.array(GapSchema).max(2),
  }),
  z.strictObject({
    kind: z.literal('withheld'),
    ...resultContext,
    reason: z.enum(WITHHELD_REASONS),
    cases: z.array(CaseCardSchema).min(1).max(MAX_BRIEF_CASES),
  }),
  z.strictObject({ kind: z.literal('scope_reply'), reply: ScopeReplySchema }),
  z.strictObject({ kind: z.literal('no_results'), ...resultContext }),
  z.strictObject({
    kind: z.literal('failed'),
    /** True when the step kept its search ("This counted as a search, because the AI work was already under way."). */
    countedAsSearch: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('cancelled') }),
]);
export type BriefResult = z.infer<typeof BriefResultSchema>;

/** What started a step, for the step switcher. */
export const StepOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question') }),
  z.strictObject({ kind: z.literal('text'), text: QuestionSchema }),
  z.strictObject({ kind: z.literal('interpretation'), label: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal('filters'), filters: BriefFiltersSchema }),
]);

/** `GET /api/briefs/:id?step=n`. `result` is present once `stage` is `done` or `failed`. */
export const BriefStepResponseSchema = z.strictObject({
  briefId: BriefIdSchema,
  step: StepNumberSchema,
  /** Steps in the brief so far. */
  steps: StepNumberSchema,
  refinementsLeft: z.number().int().min(0).max(MAX_REFINEMENTS),
  /** The brief's question (YOUR QUESTION). */
  question: QuestionSchema,
  origin: StepOriginSchema,
  stage: z.enum(BRIEF_STAGES),
  checklist: ChecklistSchema,
  startedAt: IsoInstant,
  finishedAt: IsoInstant.nullable(),
  expiresAt: IsoInstant,
  result: BriefResultSchema.optional(),
});
export type BriefStepResponse = z.infer<typeof BriefStepResponseSchema>;

/** One passage of a case as the drawer shows it, with the brief's quote spans highlighted. */
export const ContextPassageSchema = z.strictObject({
  passageId: z.string().min(1).max(80),
  section: SectionKindSchema,
  scope: z.enum(['aircraft', 'event']),
  aircraftKey: z.number().int().nonnegative().nullable(),
  sectionId: z.string().min(1).max(80),
  revisionId: z.string().regex(/^[0-9a-f]{64}$/),
  sectionRevision: z.string().regex(/^[0-9a-f]{64}$/),
  /** Offset of the passage in the section's citation text. */
  sectionStart: z.number().int().nonnegative(),
  text: z.string().min(1).max(12_000),
  highlights: z.array(SpanSchema).max(3),
});

/** A labelled line of WHY IT'S IN YOUR RESULTS (server templates), each jumping to a passage. */
export const ContextLineSchema = z.strictObject({
  label: z.enum(['EVIDENCE', 'MAINTENANCE', 'SYMPTOM', 'TIMING', 'ACCOUNT']),
  text: z.string().min(1).max(200),
  passageId: z.string().min(1).max(80).nullable(),
});

/** `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`: the brief's AI context for one case (the drawer, UI_DESIGN §4.5). */
export const CaseContextResponseSchema = z.strictObject({
  briefId: BriefIdSchema,
  step: StepNumberSchema,
  ntsbNo: NtsbNoSchema,
  /** Null when the step's summary was withheld: the drawer shows NTSB text only. */
  reading: CaseReadingSchema.nullable(),
  lines: z.array(ContextLineSchema).max(6),
  passages: z.array(ContextPassageSchema).min(1).max(MAX_BRIEF_PASSAGES),
});
export type CaseContextResponse = z.infer<typeof CaseContextResponseSchema>;

// ---------------------------------------------------------------------------
// The composition the answer model returns (validated again by
// server/briefs/validate.ts, then checked claim by claim by the check stage)

/** Shape bound only; the server's allowlist decides which numbers are valid. */
export const ComposeCaseNumberSchema = z.string().regex(/^[A-Z0-9]{6,16}$/);
export const PassageIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/);

export const ComposeQuoteSchema = z.strictObject({
  passageId: PassageIdSchema,
  /** Copied character for character from the passage (whitespace runs may differ). */
  quote: z.string().min(1).max(600),
  speaker: z.enum(SPEAKERS),
});

export const ComposeTimingSchema = z.strictObject({
  basis: z.enum(TIMING_BASES),
  /** Flight hours or calendar days; required for those bases, absent otherwise. */
  value: z.number().min(0).max(100_000).optional(),
  bound: z.enum(TIMING_BOUNDS),
});

export const ComposeCaseSchema = z.strictObject({
  ntsbNo: ComposeCaseNumberSchema,
  /** One plain sentence on why the case matches. */
  why: z.string().min(1).max(300),
  quotes: z.array(ComposeQuoteSchema).min(1).max(3),
  /** Mechanical questions only. */
  maintenance: z.enum(MAINTENANCE_RELATIONS).optional(),
  symptom: z.enum(SYMPTOMS).optional(),
  /** Only when a passage states the time since the relevant maintenance. */
  timing: ComposeTimingSchema.optional(),
});
export type ComposeCase = z.infer<typeof ComposeCaseSchema>;

export const ComposeOutputSchema = z.strictObject({
  /** Two to five plain sentences with `[[case:NTSB_NO]]` markers after statements about a case. */
  summary: z.string().min(1).max(1_500),
  /** Mechanical evidence groups, or one `examples` group; every case in exactly one group. */
  groups: z
    .array(
      z.strictObject({
        kind: z.enum(GROUP_KINDS),
        caseNumbers: z.array(ComposeCaseNumberSchema).min(1).max(MAX_BRIEF_CASES),
      }),
    )
    .min(1)
    .max(GLYPH_KINDS.length),
  cases: z.array(ComposeCaseSchema).min(1).max(MAX_BRIEF_CASES),
  /** What the evidence does not show for a case (e.g. just outside the timing window), with its passages. */
  gaps: z
    .array(
      z.strictObject({
        ntsbNo: ComposeCaseNumberSchema,
        note: z.string().min(1).max(300),
        passageIds: z.array(PassageIdSchema).min(1).max(3),
      }),
    )
    .max(2),
});
export type ComposeOutput = z.infer<typeof ComposeOutputSchema>;
