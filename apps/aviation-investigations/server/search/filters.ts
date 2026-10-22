/**
 * Elasticsearch filter clauses for `SearchRequest` over the cases index
 * (worker/index/cases-index.ts). Task 10 extends these for the passages index.
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
 */
import type { estypes } from '@elastic/elasticsearch';
import { BLANK, FACET_KEYS, type FacetKey, type SearchRequest } from '../../shared/contracts/search.js';

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
    const selection: AircraftSelection = {};
    for (const facet of AIRCRAFT_FACET_KEYS) if (request[facet].length > 0) selection[facet] = request[facet];
    this.aircraftSelection = selection;
  }

  /** The aircraft selection without one facet. */
  aircraftWithout(facet: FacetKey | undefined): AircraftSelection {
    if (facet === undefined || !isAircraftFacet(facet)) return this.aircraftSelection;
    const rest: AircraftSelection = { ...this.aircraftSelection };
    delete rest[facet];
    return rest;
  }

  filters(except: Except = {}): Query[] {
    const r = this.request;
    const out: Query[] = [{ term: { country: 'USA' } }];
    if (!except.mentionedIn && r.mentionedIn === 'probable_cause' && this.textInCause) out.push(this.textInCause);
    if (!except.completion && except.facet !== 'completion') {
      const c = completionClause(r.completion);
      if (c) out.push(c);
    }
    for (const facet of EVENT_FACETS) {
      if (facet === except.facet || r[facet].length === 0) continue;
      out.push(valuesClause(EVENT_FACET_FIELD[facet], r[facet]));
    }
    if (!except.aircraft) {
      const a = aircraftClause(this.aircraftWithout(except.facet));
      if (a) out.push(a);
    }
    if (!except.years) {
      const y = yearsClause(r.yearFrom, r.yearTo);
      if (y) out.push(y);
    }
    return out;
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
