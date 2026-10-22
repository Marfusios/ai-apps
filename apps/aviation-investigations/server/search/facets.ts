/**
 * Disjunctive facet counts over the cases index (amendment A14). Every count is a
 * number of distinct events:
 * - event facets: `terms` (and `missing` for blank) under a filter of every other
 *   active filter;
 * - aircraft facets: `nested` → a filter of the other aircraft selections (one
 *   aircraft must satisfy them all, as in `aircraftClause`) → `terms` / `missing` →
 *   `reverse_nested`, so an event counts once per value any qualifying aircraft has.
 *   Buckets can sum to more than the total in multi-aircraft events.
 * A facet's own selection never narrows its own counts.
 */
import type { estypes } from '@elastic/elasticsearch';
import {
  BLANK,
  COMPLETION_FACET_VALUES,
  FACET_VALUES,
  facetValueLabel,
  isUnknownFacetValue,
  type FacetBucket,
  type FacetKey,
} from '../../shared/contracts/search.js';
import {
  AIRCRAFT_FACET_FIELD,
  COMPLETION_FILTER,
  EVENT_FACET_FIELD,
  NO_AIRCRAFT,
  aircraftInner,
  blankAircraftMatches,
  bool,
  isAircraftFacet,
  type RequestFilters,
} from './filters.js';

type Agg = estypes.AggregationsAggregationContainer;

/** Distinct values a terms aggregation returns per facet; above every vocabulary size. */
const TERMS_SIZE = 250;

const aggName = (facet: FacetKey): string => `facet_${facet}`;

/** Aggregations for the given facets, named `facet_<key>`. */
export function facetAggs(f: RequestFilters, facets: readonly FacetKey[]): Record<string, Agg> {
  const out: Record<string, Agg> = {};
  for (const facet of facets) {
    if (facet === 'completion') {
      out[aggName(facet)] = {
        filter: bool(f.filters({ facet })),
        aggs: { values: { filters: { filters: { ...COMPLETION_FILTER } } } },
      };
    } else if (isAircraftFacet(facet)) {
      const field = AIRCRAFT_FACET_FIELD[facet];
      const inner = aircraftInner(f.aircraftWithout(facet));
      out[aggName(facet)] = {
        filter: bool(f.filters({ facet, aircraft: true })),
        aggs: {
          aircraft: {
            nested: { path: 'aircraft' },
            aggs: {
              qualifying: {
                filter: inner.length > 0 ? bool(inner) : { match_all: {} },
                aggs: {
                  values: { terms: { field, size: TERMS_SIZE }, aggs: { events: { reverse_nested: {} } } },
                  blank: { missing: { field }, aggs: { events: { reverse_nested: {} } } },
                },
              },
            },
          },
          without_aircraft: { filter: NO_AIRCRAFT },
        },
      };
    } else {
      const field = EVENT_FACET_FIELD[facet];
      out[aggName(facet)] = {
        filter: bool(f.filters({ facet })),
        aggs: { values: { terms: { field, size: TERMS_SIZE } }, blank: { missing: { field } } },
      };
    }
  }
  return out;
}

interface TermsBucket {
  key: string | number;
  key_as_string?: string;
  doc_count: number;
  events?: { doc_count: number };
}

interface FacetAggResult {
  doc_count: number;
  values?: { buckets: TermsBucket[] | Record<string, { doc_count: number }> };
  blank?: { doc_count: number; events?: { doc_count: number } };
  aircraft?: {
    qualifying: {
      values: { buckets: TermsBucket[] };
      blank: { doc_count: number; events: { doc_count: number } };
    };
  };
  without_aircraft?: { doc_count: number };
}

/** Raw counts per value of one facet (zero counts left out). */
export function facetCounts(f: RequestFilters, facet: FacetKey, aggs: Record<string, unknown>): Map<string, number> {
  const result = aggs[aggName(facet)] as FacetAggResult | undefined;
  if (!result) throw new Error(`aggregation ${aggName(facet)} missing`);
  const counts = new Map<string, number>();
  const add = (value: string, n: number) => {
    if (n > 0) counts.set(value, (counts.get(value) ?? 0) + n);
  };
  if (facet === 'completion') {
    const buckets = (result.values?.buckets ?? {}) as Record<string, { doc_count: number }>;
    for (const value of COMPLETION_FACET_VALUES) add(value, buckets[value]?.doc_count ?? 0);
  } else if (isAircraftFacet(facet)) {
    const q = result.aircraft?.qualifying;
    for (const b of q?.values.buckets ?? []) add(String(b.key_as_string ?? b.key), b.events?.doc_count ?? 0);
    add(BLANK, q?.blank.events.doc_count ?? 0);
    if (blankAircraftMatches(f.aircraftWithout(facet))) add(BLANK, result.without_aircraft?.doc_count ?? 0);
  } else {
    for (const b of (result.values?.buckets ?? []) as TermsBucket[]) add(String(b.key_as_string ?? b.key), b.doc_count);
    add(BLANK, result.blank?.doc_count ?? 0);
  }
  return counts;
}

const unknownValuesSeen = new Set<string>();

/**
 * Buckets of one facet in display order: every value with a count plus every selected
 * value. Values outside the facet's vocabulary (`FACET_VALUES`) are left out, because
 * they could not be selected; each is reported once through `onUnknown`.
 */
export function facetBuckets(
  facet: FacetKey,
  counts: ReadonlyMap<string, number>,
  selected: readonly string[],
  onUnknown?: (facet: FacetKey, value: string) => void,
): FacetBucket[] {
  const order = FACET_VALUES[facet] as readonly string[];
  const merged = new Map(counts);
  for (const v of selected) if (!merged.has(v)) merged.set(v, 0);
  const list: FacetBucket[] = [];
  for (const [value, count] of merged) {
    if (!order.includes(value)) {
      const key = `${facet}:${value}`;
      if (!unknownValuesSeen.has(key)) {
        unknownValuesSeen.add(key);
        onUnknown?.(facet, value);
      }
      continue;
    }
    list.push({ value, label: facetValueLabel(facet, value), count });
  }
  const rank = (v: string): number => order.indexOf(v);
  if (facet === 'completion') return list.sort((a, b) => rank(a.value) - rank(b.value));
  return list.sort(
    (a, b) =>
      Number(isUnknownFacetValue(a.value)) - Number(isUnknownFacetValue(b.value)) || b.count - a.count || rank(a.value) - rank(b.value),
  );
}
