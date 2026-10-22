/**
 * Elasticsearch filter clauses: one compiler (`filterClauses`) for keyword search over
 * the cases index (worker/index/cases-index.ts) and for both retrieval channels over
 * the passages index (worker/index/passages-index.ts), so BM25, the kNN prefilter and
 * the evidence fetch always apply exactly the same constraints.
 *
 * Compulsory clauses are added by the compiler, never by a caller or a planner:
 * - cases: `country: USA` (amendment A2);
 * - passages: `country: USA` and `answer_eligible: true` (A2, A5): AI evidence comes
 *   only from the answer-eligible cohort, and there is no completion facet.
 *
 * Semantics (shared/contracts/search.ts, amendment A14):
 * - Values within a facet are OR-ed; facets, the year range and the text are AND-ed.
 * - Event facets (completion, injury, conditions, light, state) filter event fields.
 * - Aircraft facets (phase, category, engine, far_part, purpose) are one `nested`
 *   clause: a single aircraft must satisfy every active aircraft facet, so "helicopter"
 *   and "landing" never match an event whose helicopter was hovering while another
 *   aircraft landed. Phase is that aircraft's defining-event phase group.
 * - `blank` matches a missing value. An event without aircraft rows counts as one
 *   aircraft with every field blank (none in the 2026-10-16 snapshot).
 * - Engine `blank` is an aircraft with no engine type recorded.
 *
 * Facet counts follow the same rules, so a count reproduces as a total when the
 * value is selected (dashboard bars open Explore with exactly their count).
 *
 * Passages differ in the aircraft clause only (amendment A3). An aircraft-scoped
 * passage has exactly one nested aircraft, its own; an event-scoped passage (every
 * section of a multi-aircraft event) has none and lists the event's aircraft under
 * the plain `event_aircraft` field. With any aircraft facet active the passages
 * clause is `aircraft_specific: true` plus the nested clause, and it never has the
 * "event without aircraft" branch the cases index uses for `blank`: that branch would
 * match every event-scoped passage. So an event-scoped passage never satisfies an
 * aircraft filter, and evidence for an aircraft-specific question always comes from
 * the aircraft that matched.
 */
import type { estypes } from '@elastic/elasticsearch';
import { z } from 'zod';
import { BLANK, FACET_KEYS, FACET_VALUES, type FacetKey, type SearchRequest } from '../../shared/contracts/search.js';

export type Query = estypes.QueryDslQueryContainer;

export const EVENT_FACETS = ['injury', 'conditions', 'light', 'state'] as const;
export type EventFacet = (typeof EVENT_FACETS)[number];
export const AIRCRAFT_FACET_KEYS = ['phase', 'category', 'engine', 'far_part', 'purpose'] as const;
export type AircraftFacet = (typeof AIRCRAFT_FACET_KEYS)[number];

export const EVENT_FACET_FIELD: Readonly<Record<EventFacet, string>> = {
  injury: 'highest_injury',
  conditions: 'wx_cond',
  light: 'light',
  state: 'state',
};

export const AIRCRAFT_FACET_FIELD: Readonly<Record<AircraftFacet, string>> = {
  phase: 'aircraft.defining_phase_group',
  category: 'aircraft.category',
  engine: 'aircraft.eng_types',
  far_part: 'aircraft.far_part',
  purpose: 'aircraft.purpose',
};

export const isAircraftFacet = (facet: FacetKey): facet is AircraftFacet =>
  (AIRCRAFT_FACET_KEYS as readonly string[]).includes(facet);
export const isEventFacet = (facet: FacetKey): facet is EventFacet => (EVENT_FACETS as readonly string[]).includes(facet);

/** The completion facet values as filters (completion class crossed with probable-cause availability). */
export const COMPLETION_FILTER: Readonly<Record<SearchRequest['completion'][number], Query>> = {
  completed_with_cause: { term: { completed_with_cause: true } },
  completed_without_cause: {
    bool: { filter: [{ term: { completion_class: 'completed' } }, { term: { completed_with_cause: false } }] },
  },
  in_progress: { term: { completion_class: 'in_progress' } },
  status_unknown: { term: { completion_class: 'status_unknown' } },
  other_status: { term: { completion_class: 'other_status' } },
};

/** Field `field` has one of `values` (`blank`: no value). */
export function valuesClause(field: string, values: readonly string[]): Query {
  const codes = values.filter((v) => v !== BLANK);
  const should: Query[] = [];
  if (codes.length > 0) should.push({ terms: { [field]: codes } });
  if (values.includes(BLANK)) should.push({ bool: { must_not: [{ exists: { field } }] } });
  return should.length === 1 ? (should[0] as Query) : { bool: { should, minimum_should_match: 1 } };
}

export type AircraftSelection = Partial<Record<AircraftFacet, readonly string[]>>;

/** Inner (aircraft-level) clauses of a selection; empty when nothing is selected. */
export function aircraftInner(selection: AircraftSelection): Query[] {
  return AIRCRAFT_FACET_KEYS.flatMap((facet) => {
    const values = selection[facet];
    return values && values.length > 0 ? [valuesClause(AIRCRAFT_FACET_FIELD[facet], values)] : [];
  });
}

/** Whether an event without aircraft rows (all fields blank) satisfies the selection. */
export function blankAircraftMatches(selection: AircraftSelection): boolean {
  return AIRCRAFT_FACET_KEYS.every((facet) => {
    const values = selection[facet];
    return !values || values.length === 0 || values.includes(BLANK);
  });
}

export const NO_AIRCRAFT: Query = { bool: { must_not: [{ nested: { path: 'aircraft', query: { match_all: {} } } }] } };

/** One nested clause for the whole aircraft selection, or null when none is active. */
export function aircraftClause(selection: AircraftSelection): Query | null {
  const inner = aircraftInner(selection);
  if (inner.length === 0) return null;
  const nested: Query = { nested: { path: 'aircraft', query: { bool: { filter: inner } } } };
  return blankAircraftMatches(selection) ? { bool: { should: [nested, NO_AIRCRAFT], minimum_should_match: 1 } } : nested;
}

export function completionClause(values: SearchRequest['completion']): Query | null {
  if (values.length === 0) return null;
  const should = values.map((v) => COMPLETION_FILTER[v]);
  return should.length === 1 ? (should[0] as Query) : { bool: { should, minimum_should_match: 1 } };
}

export function yearsClause(from: number | undefined, to: number | undefined): Query | null {
  if (from === undefined && to === undefined) return null;
  return { range: { ev_year: { ...(from !== undefined ? { gte: from } : {}), ...(to !== undefined ? { lte: to } : {}) } } };
}

// ---------------------------------------------------------------------------
// One compiler for both indices

/** The index a filter is compiled for. */
export type FilterTarget = 'cases' | 'passages';

/** Clauses every query on the target carries, whatever the selection. */
export const COMPULSORY_FILTERS: Readonly<Record<FilterTarget, readonly Query[]>> = {
  cases: [{ term: { country: 'USA' } }],
  passages: [{ term: { country: 'USA' } }, { term: { answer_eligible: true } }],
};

/** Validated facet values and a year range (`SearchRequest` is one; `RetrievalFilters` is another). */
export type FilterSelection = Partial<Record<Exclude<FacetKey, 'completion'>, readonly string[]>> & {
  completion?: SearchRequest['completion'];
  yearFrom?: number;
  yearTo?: number;
};

/** The selection's aircraft facets, without `except` (a facet whose own counts are being computed). */
export function aircraftSelectionOf(selection: FilterSelection, except?: FacetKey): AircraftSelection {
  const out: AircraftSelection = {};
  for (const facet of AIRCRAFT_FACET_KEYS) {
    const values = selection[facet];
    if (facet !== except && values && values.length > 0) out[facet] = values;
  }
  return out;
}

/** True when any aircraft facet is selected. */
export function hasAircraftFilter(selection: FilterSelection): boolean {
  return Object.keys(aircraftSelectionOf(selection)).length > 0;
}

/**
 * The aircraft clauses of a selection for one target, empty when none is active.
 * Cases: one nested clause (or it, or "no aircraft rows" when every active facet
 * allows `blank`). Passages: `aircraft_specific: true` and the nested clause, never
 * the "no aircraft" branch (module comment).
 */
export function aircraftClauses(target: FilterTarget, selection: AircraftSelection): Query[] {
  if (target === 'cases') {
    const a = aircraftClause(selection);
    return a ? [a] : [];
  }
  const inner = aircraftInner(selection);
  if (inner.length === 0) return [];
  return [{ term: { aircraft_specific: true } }, { nested: { path: 'aircraft', query: { bool: { filter: inner } } } }];
}

export interface CompileOptions {
  except?: Except;
  /** Cases only: the probable-cause text clause ("mentioned in the probable cause"). */
  textInCause?: Query | null;
}

/**
 * Every filter clause of `selection` on `target`, compulsory clauses first, in a fixed
 * order: compulsory, probable-cause text (cases), completion (cases), event facets,
 * aircraft, years. Completion is a cases-index facet only: the passages index holds
 * the answer-eligible cohort and refuses a completion selection.
 */
export function filterClauses(target: FilterTarget, selection: FilterSelection, opts: CompileOptions = {}): Query[] {
  const except = opts.except ?? {};
  const out: Query[] = [...COMPULSORY_FILTERS[target]];
  if (target === 'cases') {
    if (!except.mentionedIn && opts.textInCause) out.push(opts.textInCause);
    if (!except.completion && except.facet !== 'completion') {
      const c = completionClause(selection.completion ?? []);
      if (c) out.push(c);
    }
  } else if ((selection.completion ?? []).length > 0) {
    throw new Error('the passages index has no completion facet: AI evidence is always the answer-eligible cohort');
  }
  for (const facet of EVENT_FACETS) {
    const values = selection[facet] ?? [];
    if (facet === except.facet || values.length === 0) continue;
    out.push(valuesClause(EVENT_FACET_FIELD[facet], values));
  }
  if (!except.aircraft) out.push(...aircraftClauses(target, aircraftSelectionOf(selection, except.facet)));
  if (!except.years) {
    const y = yearsClause(selection.yearFrom, selection.yearTo);
    if (y) out.push(y);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Retrieval filters (AI evidence over the passages index)

/** Facets an AI request may filter evidence by: every facet except completion. */
export const RETRIEVAL_FACETS = ['phase', 'injury', 'conditions', 'light', 'category', 'engine', 'far_part', 'purpose', 'state'] as const;
export type RetrievalFacet = (typeof RETRIEVAL_FACETS)[number];

const facetList = <F extends RetrievalFacet>(facet: F) => {
  const values = FACET_VALUES[facet] as unknown as readonly [string, ...string[]];
  return z
    .array(z.enum(values))
    .max(values.length)
    .refine((list) => new Set(list).size === list.length, { message: 'duplicate value' })
    .optional();
};
const retrievalYear = z.number().int().min(1900).max(2100).optional();

/**
 * Validated retrieval filters: facet values from `FACET_VALUES`, a year range, no
 * completion and nothing else (unknown keys are rejected). The compulsory country and
 * answer-eligibility clauses are not part of it: the compiler always adds them.
 */
export const RetrievalFiltersSchema = z
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
    yearFrom: retrievalYear,
    yearTo: retrievalYear,
  })
  .refine((f) => f.yearFrom === undefined || f.yearTo === undefined || f.yearFrom <= f.yearTo, {
    message: 'yearFrom must not be after yearTo',
    path: ['yearFrom'],
  });
export type RetrievalFilters = z.infer<typeof RetrievalFiltersSchema>;
/** The brief's name for the validated retrieval filters. */
export type ValidatedFilters = RetrievalFilters;

/**
 * The passages filter both retrieval channels use (BM25 `filter`, kNN prefilter and
 * the evidence fetch): `answer_eligible: true`, `country: USA`, the selection, and for
 * any aircraft facet `aircraft_specific: true` with one nested aircraft clause.
 */
export function compileFilters(f: ValidatedFilters): { bool: { filter: Query[] } } {
  return { bool: { filter: filterClauses('passages', f) } };
}

/** What `filters()` leaves out: one facet's own selection, the years, completion or the probable-cause text. */
export interface Except {
  facet?: FacetKey;
  /** Leave out the whole aircraft clause (aircraft facet counts apply it inside `nested`). */
  aircraft?: boolean;
  years?: boolean;
  completion?: boolean;
  mentionedIn?: boolean;
}

/**
 * The request's filters as composable clauses. `textInCause` is the probable-cause
 * text clause, applied when `mentionedIn` is `probable_cause` (the query itself
 * already requires the words anywhere in the report).
 */
export class RequestFilters {
  readonly aircraftSelection: AircraftSelection;

  constructor(
    readonly request: SearchRequest,
    readonly textInCause: Query | null,
  ) {
    this.aircraftSelection = aircraftSelectionOf(request);
  }

  /** The aircraft selection without one facet. */
  aircraftWithout(facet: FacetKey | undefined): AircraftSelection {
    if (facet === undefined || !isAircraftFacet(facet)) return this.aircraftSelection;
    return aircraftSelectionOf(this.request, facet);
  }

  filters(except: Except = {}): Query[] {
    const textInCause = this.request.mentionedIn === 'probable_cause' ? this.textInCause : null;
    return filterClauses('cases', this.request, { except, textInCause });
  }

  /** Active filters a "remove one filter" suggestion can drop, in display order. */
  activeDrops(): ('mentionedIn' | FacetKey | 'years')[] {
    const r = this.request;
    const drops: ('mentionedIn' | FacetKey | 'years')[] = [];
    if (r.mentionedIn === 'probable_cause') drops.push('mentionedIn');
    for (const facet of FACET_KEYS) if (r[facet].length > 0) drops.push(facet);
    if (r.yearFrom !== undefined || r.yearTo !== undefined) drops.push('years');
    return drops;
  }
}

export const bool = (filter: Query[]): Query => ({ bool: { filter } });
