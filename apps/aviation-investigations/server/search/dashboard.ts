/**
 * `GET /api/dashboard`: corpus aggregates for one cohort (UI_DESIGN §4.7, amendment
 * A14). The bars are the Explore facet counts of the cohort's empty search (the same
 * filter and aggregation code), so a bar opened in Explore shows exactly its count.
 * Coverage and the year chart come from the cases index too; METAR coverage and the
 * dot-map coordinates come from PostgreSQL for the same generation (the index holds
 * neither the METAR nor every coordinate in one page), projected here to the 1000×637
 * lower-48 frame.
 */
import type { Client } from '@elastic/elasticsearch';
import {
  DashboardResponseSchema,
  MAP_FRAME,
  type DashboardBar,
  type DashboardRequest,
  type DashboardResponse,
} from '../../shared/contracts/dashboard.js';
import { SearchRequestSchema, type FacetKey } from '../../shared/contracts/search.js';
import type { Db } from '../db/client.js';
import { readCohortLocations } from '../db/queries/case-views.js';
import type { PinnedDataset } from '../dataset.js';
import { projectLower48 } from '../projection/map.js';
import { facetAggs, facetBuckets, facetCounts } from './facets.js';
import { RequestFilters, bool } from './filters.js';

/** The Explore request a dashboard cohort corresponds to. */
export function cohortRequest(cohort: DashboardRequest['cohort']) {
  return SearchRequestSchema.parse(cohort === 'all' ? { completion: 'any' } : {});
}

const CHARTS = { phase: 'phase', injury: 'injury', weather: 'conditions', category: 'category' } as const satisfies Record<
  string,
  FacetKey
>;

export interface DashboardDeps {
  es: Client;
  db: Db;
  onUnknownFacetValue?: (facet: FacetKey, value: string) => void;
}

export async function buildDashboard(deps: DashboardDeps, pinned: PinnedDataset, cohort: DashboardRequest['cohort']): Promise<DashboardResponse> {
  const request = cohortRequest(cohort);
  const f = new RequestFilters(request, null);
  const cohortFilter = bool(f.filters());
  const res = await deps.es.search({
    index: pinned.manifest.casesIndex,
    size: 0,
    track_total_hits: true,
    query: { term: { country: 'USA' } },
    aggs: {
      ...facetAggs(f, Object.values(CHARTS)),
      cohort: {
        filter: cohortFilter,
        aggs: {
          probable_cause: { filter: { exists: { field: 'probable_cause' } } },
          coordinates: { filter: { exists: { field: 'location' } } },
          multi_aircraft: { filter: { range: { aircraft_count: { gte: 2 } } } },
        },
      },
      years: {
        terms: { field: 'ev_year', size: 300 },
        aggs: { completed: { filter: { term: { completed_with_cause: true } } } },
      },
    },
  });
  const aggs = res.aggregations as unknown as Record<string, unknown> & {
    cohort: { doc_count: number; probable_cause: { doc_count: number }; coordinates: { doc_count: number }; multi_aircraft: { doc_count: number } };
    years: { buckets: { key: number; doc_count: number; completed: { doc_count: number } }[] };
  };

  const bars = (facet: FacetKey): DashboardBar[] =>
    facetBuckets(facet, facetCounts(f, facet, aggs), [], deps.onUnknownFacetValue).map((b) => ({ facet, ...b }));

  const perYear = new Map(aggs.years.buckets.map((b) => [Number(b.key), b]));
  const years: DashboardResponse['years'] = [];
  for (let year = pinned.years.from; year <= pinned.years.to; year++) {
    const b = perYear.get(year);
    const completed = b?.completed.doc_count ?? 0;
    years.push({ year, completed, other: (b?.doc_count ?? 0) - completed });
  }

  const total = aggs.cohort.doc_count;
  const locations = await readCohortLocations(deps.db, pinned.manifest.generationId, cohort === 'default');
  if (locations.total !== total) {
    throw new Error(`cohort ${cohort}: the cases index has ${total} events, generation ${pinned.manifest.generationId} ${locations.total}`);
  }
  const points: [number, number][] = [];
  let outsideFrame = 0;
  for (const { lat, lon } of locations.points) {
    const point = projectLower48(lat, lon);
    if (point) points.push(point);
    else outsideFrame++;
  }

  return DashboardResponseSchema.parse({
    dataset: pinned.dataset,
    cohort,
    total,
    years,
    phase: bars(CHARTS.phase),
    injury: bars(CHARTS.injury),
    weather: bars(CHARTS.weather),
    category: bars(CHARTS.category),
    coverage: {
      probableCause: { count: aggs.cohort.probable_cause.doc_count, of: total },
      metar: { count: locations.metar, of: total },
      coordinates: { count: aggs.cohort.coordinates.doc_count, of: total },
      multiAircraft: aggs.cohort.multi_aircraft.doc_count,
    },
    map: {
      width: MAP_FRAME.width,
      height: MAP_FRAME.height,
      projection: 'albers-lower48',
      points,
      withoutCoordinates: locations.withoutCoordinates,
      outsideFrame,
    },
  } satisfies DashboardResponse);
}
