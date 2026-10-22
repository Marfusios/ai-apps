/**
 * Mock-only projection pieces: facet values, mock search documents, config and the
 * dashboard from normalized fixtures. Case rows and case pages come from the same
 * projection the API uses (server/projection/cases.ts), so the mock and the real
 * server produce identical shapes for identical records.
 */
import { createHash } from 'node:crypto';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import type { Dataset } from '../../shared/contracts/common.js';
import type { ConfigResponse } from '../../shared/contracts/config.js';
import { MAP_FRAME, type DashboardBar, type DashboardResponse } from '../../shared/contracts/dashboard.js';
import {
  BLANK,
  FACET_VALUES,
  facetValueLabel,
  isUnknownFacetValue,
  type FacetKey,
} from '../../shared/contracts/search.js';
import { aircraftBrief } from '../../server/projection/cases.js';
import { projectLower48 } from '../../server/projection/map.js';
import { completionFacetValue, type MockDoc } from '../../web/mock/engine.js';
import type { CanonicalAircraft, CanonicalCase, NormalizeResult } from '../../worker/ingest/normalize.js';

export { toCaseDetail, type ProjectionContext } from '../../server/projection/cases.js';

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

/** Facet values of an event: aircraft facets hold the union over its aircraft (amendment A14). */
export function facetValues(c: CanonicalCase): Record<FacetKey, string[]> {
  const f = c.fields;
  const perAircraft = (pick: (a: CanonicalAircraft) => string | null): string[] =>
    c.aircraft.length === 0 ? [BLANK] : distinct(c.aircraft.map((a) => pick(a) ?? BLANK));
  return {
    completion: [completionFacetValue(c.completionClass, c.hasProbableCause)],
    phase: perAircraft((a) => a.definingPhaseGroup),
    injury: [f.highestInjury ?? BLANK],
    conditions: [f.wxCondBasic ?? BLANK],
    light: [f.lightCond ?? BLANK],
    category: perAircraft((a) => a.category),
    engine:
      c.aircraft.length === 0
        ? [BLANK]
        : distinct(c.aircraft.flatMap((a) => (a.engines.length === 0 ? [BLANK] : a.engines.map((e) => e.engType ?? BLANK)))),
    far_part: perAircraft((a) => a.farPart),
    purpose: perAircraft((a) => a.purpose),
    state: [(f.state ?? '').trim().toUpperCase() || BLANK],
  };
}

export function toMockDoc(c: CanonicalCase, detail: CaseDetail): MockDoc {
  const f = c.fields;
  return {
    row: {
      ntsbNo: detail.ntsbNo,
      eventType: detail.eventType,
      date: detail.date,
      city: detail.city,
      state: detail.state,
      country: detail.country,
      aircraft: c.aircraft.map(aircraftBrief),
      definingPhases: c.definingPhaseGroups,
      conditions: detail.weather.basic,
      light: detail.weather.light,
      highestInjury: detail.highestInjury,
      completion: detail.completion,
    },
    year: f.evYear ?? (f.evDate ? Number(f.evDate.slice(0, 4)) : null),
    facets: facetValues(c),
    defaultCohort: c.answerEligible,
    fields: [
      c.ntsbNo,
      ...c.aircraft.flatMap((a) => [a.make, a.model, a.series, a.regisNo]),
      f.city,
      detail.state.code ? detail.state.label : null,
    ]
      .filter((s): s is string => s !== null && s.trim() !== '')
      .join(' '),
  };
}

// ---------------------------------------------------------------------------
// Dataset, config and dashboard

export function datasetOf(result: NormalizeResult, snapshotDate: string): Dataset {
  const hash = createHash('sha256');
  for (const c of result.cases) hash.update(`${c.ntsbNo}:${c.sourceRevision}\n`);
  return { revision: `fx-${hash.digest('hex').slice(0, 16)}`, snapshotDate };
}

function yearOf(c: CanonicalCase): number | null {
  return c.fields.evYear ?? (c.fields.evDate ? Number(c.fields.evDate.slice(0, 4)) : null);
}

export function toConfig(result: NormalizeResult, dataset: Dataset): ConfigResponse {
  const us = result.cases.filter((c) => c.isUs);
  const years = us.map(yearOf).filter((y): y is number => y !== null);
  const defaultCohort = us.filter((c) => c.answerEligible).length;
  return {
    turnstileSiteKey: null,
    googleEnabled: false,
    snapshotDate: dataset.snapshotDate,
    datasetRevision: dataset.revision,
    coverage: {
      defaultCohort,
      otherRecords: us.length - defaultCohort,
      yearFrom: Math.min(...years),
      yearTo: Math.max(...years),
      provisional: result.cohortProvisional,
    },
  };
}

function bars(facet: FacetKey, cases: readonly CanonicalCase[]): DashboardBar[] {
  const counts = new Map<string, number>();
  for (const c of cases) for (const v of facetValues(c)[facet]) counts.set(v, (counts.get(v) ?? 0) + 1);
  const order = FACET_VALUES[facet] as readonly string[];
  return [...counts.entries()]
    .map(([value, count]) => ({ facet, value, label: facetValueLabel(facet, value), count }))
    .sort(
      (a, b) =>
        Number(isUnknownFacetValue(a.value)) - Number(isUnknownFacetValue(b.value)) ||
        b.count - a.count ||
        order.indexOf(a.value) - order.indexOf(b.value),
    );
}

export function toDashboard(result: NormalizeResult, dataset: Dataset, cohort: 'default' | 'all'): DashboardResponse {
  const us = result.cases.filter((c) => c.isUs);
  const cases = cohort === 'default' ? us.filter((c) => c.answerEligible) : us;
  const years = us.map(yearOf).filter((y): y is number => y !== null);
  const yearBuckets: DashboardResponse['years'] = [];
  for (let year = Math.min(...years); year <= Math.max(...years); year++) {
    const inYear = us.filter((c) => yearOf(c) === year);
    yearBuckets.push({ year, completed: inYear.filter((c) => c.answerEligible).length, other: inYear.filter((c) => !c.answerEligible).length });
  }
  const points: [number, number][] = [];
  let outsideFrame = 0;
  for (const c of cases) {
    if (!c.location) continue;
    const point = projectLower48(c.location.lat, c.location.lon);
    if (point) points.push(point);
    else outsideFrame++;
  }
  return {
    dataset,
    cohort,
    total: cases.length,
    years: yearBuckets,
    phase: bars('phase', cases),
    injury: bars('injury', cases),
    weather: bars('conditions', cases),
    category: bars('category', cases),
    coverage: {
      probableCause: { count: cases.filter((c) => c.hasProbableCause).length, of: cases.length },
      metar: { count: cases.filter((c) => c.fields.metar !== null).length, of: cases.length },
      coordinates: { count: cases.filter((c) => c.location !== null).length, of: cases.length },
      multiAircraft: cases.filter((c) => c.aircraft.length > 1).length,
    },
    map: {
      width: MAP_FRAME.width,
      height: MAP_FRAME.height,
      projection: 'albers-lower48',
      points,
      withoutCoordinates: cases.filter((c) => c.location === null).length,
      outsideFrame,
    },
  };
}

