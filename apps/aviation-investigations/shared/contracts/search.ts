/**
 * `GET /api/search`: keyword search with disjunctive facets (UI_DESIGN §4.2,
 * amendment A14). The universe is US events (amendment A2); the default cohort is
 * completed records with probable-cause text.
 *
 * Counting rules the server must keep:
 * - Every count is a count of distinct events. Aircraft-level facets (`AIRCRAFT_FACETS`)
 *   count an event once per value any of its aircraft has, so in multi-aircraft
 *   events they can sum to more than the total; `multiAircraft` says how many
 *   matched events can do that.
 * - The Phase facet uses each aircraft's defining-event phase group (`blank` when an
 *   aircraft has no single defining event).
 * - Facets are disjunctive: a facet's counts apply every filter except its own
 *   selection. Values within a facet are OR-ed; facets are AND-ed.
 * - Buckets list every value with a count above zero plus every selected value.
 */
import { z } from 'zod';
import { BLANK_CODE_LABEL, DEFAULT_CODE_LABELS, PHASE_GROUPS, PHASE_LABEL, type PhaseGroup } from '../codes.js';
import {
  AIRCRAFT_CATEGORY,
  ENGINE_TYPE,
  FAR_PART,
  FLIGHT_PURPOSE,
  US_STATE,
  type Vocabulary,
} from '../vocab.js';
import {
  CodedSchema,
  CompletionSchema,
  DatasetSchema,
  IsoDateSchema,
  NtsbNoSchema,
  PhaseGroupSchema,
} from './common.js';

// ---------------------------------------------------------------------------
// Facets

export const FACET_KEYS = [
  'completion',
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
export type FacetKey = (typeof FACET_KEYS)[number];

/** Facets whose values belong to aircraft; they can overlap in multi-aircraft events. */
export const AIRCRAFT_FACETS: readonly FacetKey[] = ['phase', 'category', 'engine', 'far_part', 'purpose'];

/** The facet value for a blank (NULL) code. */
export const BLANK = 'blank';

/** Completion facet values: completion class crossed with probable-cause availability. */
export const COMPLETION_FACET_VALUES = [
  'completed_with_cause',
  'completed_without_cause',
  'in_progress',
  'status_unknown',
  'other_status',
] as const;
export type CompletionFacetValue = (typeof COMPLETION_FACET_VALUES)[number];

/** The default cohort, applied when the request has no `completion` parameter. */
export const DEFAULT_COMPLETION: readonly CompletionFacetValue[] = ['completed_with_cause'];

/** `completion=any` turns the completion filter off (every US record). */
export const ANY_COMPLETION = 'any';

const codes = (vocabulary: Vocabulary, undefinedCodes: readonly string[] = []): string[] => [
  ...Object.keys(vocabulary),
  ...undefinedCodes,
  BLANK,
];

/**
 * Codes the 2026-10-16 snapshot uses that the data dictionary does not define. They
 * are selectable so every bucket the API shows can be filtered; their label is the
 * raw code. The API leaves out (and logs) values outside `FACET_VALUES`.
 */
export const UNDEFINED_OBSERVED_CODES = {
  state: ['OF'],
  category: ['RCKT'],
  engine: ['HR', 'LR'],
} as const;

/** Allowed values per facet. A value outside these is a 400. */
export const FACET_VALUES = {
  completion: COMPLETION_FACET_VALUES,
  phase: [...PHASE_GROUPS, BLANK] as readonly string[],
  injury: ['FATL', 'SERS', 'MINR', 'NONE', 'UNK', BLANK],
  conditions: ['VMC', 'IMC', 'UNK', BLANK],
  light: ['DAYL', 'DAWN', 'DUSK', 'NITE', 'NDRK', 'NBRT', 'NR', BLANK],
  category: codes(AIRCRAFT_CATEGORY, UNDEFINED_OBSERVED_CODES.category),
  engine: codes(ENGINE_TYPE, UNDEFINED_OBSERVED_CODES.engine),
  far_part: codes(FAR_PART),
  purpose: codes(FLIGHT_PURPOSE),
  state: codes(US_STATE, UNDEFINED_OBSERVED_CODES.state),
} as const satisfies Record<FacetKey, readonly string[]>;

export const FACET_TITLE: Readonly<Record<FacetKey, string>> = {
  completion: 'Completion',
  phase: 'Phase',
  injury: 'Highest injury',
  conditions: 'Conditions',
  light: 'Light',
  category: 'Aircraft',
  engine: 'Engine',
  far_part: 'Operation',
  purpose: 'Purpose',
  state: 'Location',
};

const COMPLETION_LABEL: Readonly<Record<CompletionFacetValue, string>> = {
  completed_with_cause: 'Completed, with probable cause',
  completed_without_cause: 'Completed, no probable-cause text',
  in_progress: 'In progress',
  status_unknown: 'Status unknown',
  other_status: 'Other status',
};

const BLANK_FACET_LABEL: Readonly<Record<FacetKey, string>> = {
  completion: 'Not reported',
  phase: 'No defining event',
  injury: BLANK_CODE_LABEL.ev_highest_injury,
  conditions: BLANK_CODE_LABEL.wx_cond_basic,
  light: BLANK_CODE_LABEL.light_cond,
  category: 'Not reported',
  engine: 'No engine recorded',
  far_part: 'Not reported',
  purpose: 'Not reported',
  state: 'Not reported',
};

/** Display label of a facet value; unknown codes fall back to the code itself. */
export function facetValueLabel(facet: FacetKey, value: string): string {
  if (value === BLANK) return BLANK_FACET_LABEL[facet];
  const lookup = (map: Readonly<Record<string, string>>): string => (Object.hasOwn(map, value) ? (map[value] as string) : value);
  switch (facet) {
    case 'completion':
      return lookup(COMPLETION_LABEL);
    case 'phase':
      return lookup(PHASE_LABEL as Readonly<Record<string, string>>);
    case 'injury':
      return lookup(DEFAULT_CODE_LABELS.ev_highest_injury);
    case 'conditions':
      return lookup(DEFAULT_CODE_LABELS.wx_cond_basic);
    case 'light':
      return lookup(DEFAULT_CODE_LABELS.light_cond);
    case 'category':
      return lookup(AIRCRAFT_CATEGORY);
    case 'engine':
      return lookup(ENGINE_TYPE);
    case 'far_part':
      return lookup(FAR_PART);
    case 'purpose':
      return lookup(FLIGHT_PURPOSE);
    case 'state':
      return lookup(US_STATE);
  }
}

/** Unknown and not-reported values are shown muted, never hidden (UI_DESIGN §4.2). */
export function isUnknownFacetValue(value: string): boolean {
  return value === BLANK || value === 'UNK' || value === 'unknown' || value === 'NR' || value === 'status_unknown';
}

// ---------------------------------------------------------------------------
// Request (query string)

export const MAX_QUERY_LENGTH = 1500;
export const MAX_PAGE = 50;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

export const MENTIONED_IN = ['anywhere', 'probable_cause'] as const;
export type MentionedIn = (typeof MENTIONED_IN)[number];
export const SORTS = ['newest', 'oldest', 'relevance'] as const;
export type SearchSort = (typeof SORTS)[number];

/** Repeated keys and comma-separated values both work: `phase=a&phase=b` or `phase=a,b`. */
function splitList(value: unknown): unknown {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
}

function listOf<const T extends readonly string[]>(values: T) {
  return z.preprocess(
    splitList,
    z
      .array(z.enum(values as unknown as readonly [T[number], ...T[number][]]))
      .max(values.length)
      // Canonical: deduplicated, in vocabulary order.
      .transform((list) => values.filter((v): v is T[number] => (list as readonly string[]).includes(v))),
  );
}

const completionParam = z.preprocess((value) => {
  if (value === undefined) return [...DEFAULT_COMPLETION];
  const list = splitList(value) as unknown[];
  return list.includes(ANY_COMPLETION) ? [] : list;
}, listOf(COMPLETION_FACET_VALUES));

const year = z.coerce.number().int().min(1900).max(2100);

const single = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

/**
 * Query-string schema. Unknown parameters are ignored (the web URL also carries
 * `case`, `cases`, `brief` and `step`); unknown values are rejected.
 * `completion` absent means the default cohort; `completion=any` means no filter.
 */
export const SearchRequestSchema = z
  .object({
    q: z.preprocess(single, z.string().max(MAX_QUERY_LENGTH)).default(''),
    mentionedIn: z.preprocess(single, z.enum(MENTIONED_IN)).default('anywhere'),
    completion: completionParam,
    phase: listOf(FACET_VALUES.phase),
    injury: listOf(FACET_VALUES.injury),
    conditions: listOf(FACET_VALUES.conditions),
    light: listOf(FACET_VALUES.light),
    category: listOf(FACET_VALUES.category),
    engine: listOf(FACET_VALUES.engine),
    far_part: listOf(FACET_VALUES.far_part),
    purpose: listOf(FACET_VALUES.purpose),
    state: listOf(FACET_VALUES.state),
    yearFrom: z.preprocess(single, year).optional(),
    yearTo: z.preprocess(single, year).optional(),
    sort: z.preprocess(single, z.enum(SORTS)).default('newest'),
    page: z.preprocess(single, z.coerce.number().int().min(1).max(MAX_PAGE)).default(1),
    pageSize: z.preprocess(single, z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)).default(DEFAULT_PAGE_SIZE),
  })
  .refine((r) => r.yearFrom === undefined || r.yearTo === undefined || r.yearFrom <= r.yearTo, {
    message: 'yearFrom must not be after yearTo',
    path: ['yearFrom'],
  });
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type FacetSelection = Pick<SearchRequest, FacetKey>;

/** The request with every default applied: the empty search over the default cohort. */
export function defaultSearchRequest(): SearchRequest {
  return SearchRequestSchema.parse({});
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

/**
 * Canonical query string for a request: defaults are left out, lists are
 * comma-separated in vocabulary order, so equal requests give equal strings
 * (and equal cache keys).
 */
export function searchRequestToParams(request: SearchRequest): URLSearchParams {
  const params = new URLSearchParams();
  if (request.q.trim() !== '') params.set('q', request.q);
  if (request.mentionedIn !== 'anywhere') params.set('mentionedIn', request.mentionedIn);
  for (const facet of FACET_KEYS) {
    const selected = request[facet] as readonly string[];
    if (facet === 'completion') {
      if (selected.length === 0) params.set('completion', ANY_COMPLETION);
      else if (!sameSet(selected, DEFAULT_COMPLETION)) params.set('completion', orderValues(facet, selected).join(','));
      continue;
    }
    if (selected.length > 0) params.set(facet, orderValues(facet, selected).join(','));
  }
  if (request.yearFrom !== undefined) params.set('yearFrom', String(request.yearFrom));
  if (request.yearTo !== undefined) params.set('yearTo', String(request.yearTo));
  if (request.sort !== 'newest') params.set('sort', request.sort);
  if (request.page !== 1) params.set('page', String(request.page));
  if (request.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(request.pageSize));
  return params;
}

/** Values in vocabulary order. */
export function orderValues(facet: FacetKey, values: readonly string[]): string[] {
  const order = FACET_VALUES[facet] as readonly string[];
  return [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** URLSearchParams to the plain object the schema parses (repeated keys become arrays). */
export function paramsToQuery(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length === 1 ? (all[0] as string) : all;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response

export const FacetBucketSchema = z.strictObject({
  value: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  /** Distinct events. */
  count: z.number().int().nonnegative(),
});
export type FacetBucket = z.infer<typeof FacetBucketSchema>;

export const SECTION_KINDS = ['factual', 'analysis', 'probable_cause'] as const;
export const SectionKindSchema = z.enum(SECTION_KINDS);
export type SectionKind = z.infer<typeof SectionKindSchema>;

/** Small-caps label of each section kind, as snippets and section heads print it. */
export const SECTION_LABEL: Readonly<Record<SectionKind, string>> = {
  factual: 'Factual',
  analysis: 'Analysis',
  probable_cause: 'Probable cause',
};

/** A [start, end) range of UTF-16 code units. */
export const SpanSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

/**
 * The third line of a result row: the probable cause when the terms match there,
 * otherwise the best matching passage, with its section label. Text only; matched
 * terms are offsets, never markup.
 */
export const SnippetSchema = z
  .strictObject({
    section: SectionKindSchema,
    label: z.string().min(1).max(40),
    text: z.string().min(1).max(1200),
    highlights: z.array(SpanSchema).max(60),
    /** The excerpt starts or ends inside the section text (print an ellipsis). */
    truncatedStart: z.boolean(),
    truncatedEnd: z.boolean(),
  })
  .superRefine((snippet, ctx) => {
    let previous = 0;
    for (const span of snippet.highlights) {
      if (span.start < previous || span.end <= span.start || span.end > snippet.text.length) {
        ctx.addIssue({ code: 'custom', message: 'highlights must be sorted, non-overlapping and inside text' });
        return;
      }
      previous = span.end;
    }
  });
export type Snippet = z.infer<typeof SnippetSchema>;

/** The defining event of one aircraft: phase group, the coded phase and event. */
export const DefiningEventSchema = z.strictObject({
  phase: PhaseGroupSchema,
  /** `phase_no` and its label, e.g. 453 "Maneuvering, hover". */
  phaseDetail: CodedSchema,
  /** `eventsoe_no` and its label, e.g. 341 "Loss of engine power (total)". */
  event: CodedSchema,
});
export type DefiningEvent = z.infer<typeof DefiningEventSchema>;

export const AircraftBriefSchema = z.strictObject({
  /** Small integer that relates sequence steps, findings and sections to an aircraft. */
  aircraftKey: z.number().int().nonnegative(),
  /** Suffixed in multi-aircraft events (`SEA08LA057A`). */
  aircraftNtsbNo: z.string().max(24).nullable(),
  registration: z.string().max(24).nullable(),
  make: z.string().max(120).nullable(),
  model: z.string().max(120).nullable(),
  category: CodedSchema,
  farPart: CodedSchema,
  purpose: CodedSchema,
  damage: CodedSchema,
  /** Null when no single defining event is coded for this aircraft. */
  definingEvent: DefiningEventSchema.nullable(),
});
export type AircraftBrief = z.infer<typeof AircraftBriefSchema>;

export const CaseRowSchema = z.strictObject({
  ntsbNo: NtsbNoSchema,
  eventType: CodedSchema,
  date: IsoDateSchema.nullable(),
  city: z.string().max(120).nullable(),
  state: CodedSchema,
  country: z.string().max(8).nullable(),
  /** Every aircraft, in aircraft-key order. Multi-aircraft events show one sub-row each. */
  aircraft: z.array(AircraftBriefSchema).max(64),
  /** Distinct defining-event phase groups of the event (amendment A14). */
  definingPhases: z.array(PhaseGroupSchema).max(16),
  conditions: CodedSchema,
  light: CodedSchema,
  highestInjury: CodedSchema,
  completion: CompletionSchema,
  snippet: SnippetSchema.nullable(),
});
export type CaseRow = z.infer<typeof CaseRowSchema>;

export const YearBucketSchema = z.strictObject({
  year: z.number().int().min(1900).max(2100),
  /** Events in the default cohort (completed, with probable cause). */
  completed: z.number().int().nonnegative(),
  /** Events outside it: drawn hatched. */
  other: z.number().int().nonnegative(),
});
export type YearBucket = z.infer<typeof YearBucketSchema>;

/** What a "remove one filter" suggestion drops (`completion` means "include other records"). */
export const RelaxationDropSchema = z.enum([...FACET_KEYS, 'years', 'mentionedIn']);
export type RelaxationDrop = z.infer<typeof RelaxationDropSchema>;

const facetBuckets = z.array(FacetBucketSchema).max(120);

export const SearchResponseSchema = z.strictObject({
  dataset: DatasetSchema,
  /** Exact number of matching events. */
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(MAX_PAGE),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
  rows: z.array(CaseRowSchema).max(MAX_PAGE_SIZE),
  facets: z.strictObject({
    completion: facetBuckets,
    phase: facetBuckets,
    injury: facetBuckets,
    conditions: facetBuckets,
    light: facetBuckets,
    category: facetBuckets,
    engine: facetBuckets,
    far_part: facetBuckets,
    purpose: facetBuckets,
    state: facetBuckets,
  }),
  /** Totals for each `mentionedIn` choice with every other filter applied. Equal when `q` is empty. */
  mentionedIn: z.strictObject({
    anywhere: z.number().int().nonnegative(),
    probable_cause: z.number().int().nonnegative(),
  }),
  /** Per year, every filter applied except the year range and completion; ascending. */
  years: z.array(YearBucketSchema).max(200),
  /** Matched events with more than one aircraft (aircraft facets can over-count by these). */
  multiAircraft: z.number().int().nonnegative(),
  /**
   * When `total` is 0: the total after dropping each active filter on its own,
   * for the "remove one filter" chips (UI_DESIGN §5). Empty otherwise.
   */
  relaxations: z.array(z.strictObject({ drop: RelaxationDropSchema, count: z.number().int().nonnegative() })).max(16),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export type PhaseFacetValue = PhaseGroup | typeof BLANK;
