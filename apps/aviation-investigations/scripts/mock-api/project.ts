/**
 * Reference projection from canonical cases (worker/ingest/normalize.ts) to the
 * public API contracts. The mock API is built with it; the Fastify routes
 * (Task 8) produce the same shapes from the loaded corpus.
 */
import { createHash } from 'node:crypto';
import { codeLabel } from '../../shared/codes.js';
import { aircraftLetter, buildHeadline, dataCautions, findingText } from '../../shared/case-view.js';
import {
  AVIATION_SEARCH_URL,
  SECTION_LABEL,
  type AircraftDetail,
  type CaseDetail,
  type SequenceStep,
} from '../../shared/contracts/cases.js';
import type { Coded, Dataset } from '../../shared/contracts/common.js';
import type { ConfigResponse } from '../../shared/contracts/config.js';
import { MAP_FRAME, type DashboardBar, type DashboardResponse } from '../../shared/contracts/dashboard.js';
import {
  BLANK,
  FACET_VALUES,
  facetValueLabel,
  isUnknownFacetValue,
  type AircraftBrief,
  type DefiningEvent,
  type FacetKey,
} from '../../shared/contracts/search.js';
import {
  AIRCRAFT_CATEGORY,
  DAMAGE,
  ENGINE_TYPE,
  EVENT_CODE,
  EVENT_TYPE,
  FAR_PART,
  FLIGHT_PURPOSE,
  FUEL_SYSTEM,
  IMPACT_EVENT_CODES,
  PHASE_CODE,
  PRECIPITATION,
  SKY_CEILING,
  SKY_NON_CEILING,
  TIME_ZONE,
  US_STATE,
  vocabLabel,
  type Vocabulary,
} from '../../shared/vocab.js';
import { completionFacetValue, type MockDoc } from '../../web/mock/engine.js';
import type {
  CanonicalAircraft,
  CanonicalCase,
  CanonicalSequenceEvent,
  NormalizeResult,
} from '../../worker/ingest/normalize.js';

export interface ProjectionContext {
  dataset: Dataset;
  citationTextVersion: string;
  fieldNormalizationVersion: string;
  mappingVerified: boolean;
}

function coded(vocabulary: Vocabulary, code: string | null, blankLabel = 'Not reported'): Coded {
  const value = (code ?? '').trim().toUpperCase();
  return { code: value === '' ? null : value, label: vocabLabel(vocabulary, value, blankLabel) };
}

const round = (n: number | null, digits = 0): number | null => {
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function definingEvent(s: CanonicalSequenceEvent): DefiningEvent {
  return {
    phase: s.phaseGroup,
    phaseDetail: coded(PHASE_CODE, s.phaseNo === null ? null : String(s.phaseNo), 'Phase not coded'),
    event: coded(EVENT_CODE, s.eventCode, 'Event not coded'),
  };
}

function aircraftBrief(a: CanonicalAircraft): AircraftBrief {
  return {
    aircraftKey: a.aircraftKey,
    aircraftNtsbNo: a.aircraftNtsbNo,
    registration: a.regisNo,
    make: a.make,
    model: a.model,
    category: coded(AIRCRAFT_CATEGORY, a.category),
    farPart: coded(FAR_PART, a.farPart),
    purpose: coded(FLIGHT_PURPOSE, a.purpose),
    damage: coded(DAMAGE, a.damage),
    definingEvent: a.definingEvent ? definingEvent(a.definingEvent) : null,
  };
}

function aircraftDetail(a: CanonicalAircraft): AircraftDetail {
  return {
    ...aircraftBrief(a),
    series: a.series,
    homebuilt: a.homebuilt,
    year: a.acftYear,
    engines: a.engines.map((e) => ({
      engNo: e.engNo,
      type: coded(ENGINE_TYPE, e.engType),
      fuelSystem: coded(FUEL_SYSTEM, e.carbFuelInjection),
    })),
    definingEventConflict: a.definingEventConflict,
  };
}

function stateOf(c: CanonicalCase): Coded {
  const code = (c.fields.state ?? '').trim().toUpperCase();
  return { code: code === '' ? null : code, label: code === '' ? 'Not reported' : (US_STATE[code] ?? code) };
}

function latest(values: readonly (string | null)[]): string | null {
  const present = values.filter((v): v is string => v !== null).sort();
  return present[present.length - 1] ?? null;
}

const KIND_ORDER = { factual: 0, analysis: 1, probable_cause: 2 } as const;

export function toCaseDetail(c: CanonicalCase, ctx: ProjectionContext): CaseDetail {
  const f = c.fields;
  const sections = [...c.sections].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key, 'en'),
  );
  const sequence: SequenceStep[] = [...c.sequence]
    .sort((a, b) => a.aircraftKey - b.aircraftKey || a.occurrenceNo - b.occurrenceNo)
    .map((s) => ({
      aircraftKey: s.aircraftKey,
      occurrenceNo: s.occurrenceNo,
      phase: s.phaseGroup,
      phaseDetail: coded(PHASE_CODE, s.phaseNo === null ? null : String(s.phaseNo), 'Phase not coded'),
      event: coded(EVENT_CODE, s.eventCode, 'Event not coded'),
      isDefining: s.isDefining,
      impact: s.eventCode !== null && IMPACT_EVENT_CODES.has(s.eventCode),
    }));
  const letters = c.aircraft.map((a, i) => aircraftLetter(c.ntsbNo, a.aircraftNtsbNo, i));

  return {
    ntsbNo: c.ntsbNo,
    eventType: coded(EVENT_TYPE, f.evType),
    date: f.evDate,
    time: {
      hhmm: f.evTime === null ? null : String(f.evTime).padStart(4, '0'),
      zone: coded(TIME_ZONE, f.evTmzn, 'Zone not recorded'),
    },
    city: f.city?.trim() || null,
    state: stateOf(c),
    country: c.country,
    location: c.location,
    headline: buildHeadline({
      aircraft: c.aircraft.map((a) => ({
        make: a.make,
        model: a.model,
        categoryCode: a.category,
        definingEvent: a.definingEvent
          ? {
              phase: a.definingEvent.phaseGroup,
              phaseCode: a.definingEvent.phaseNo === null ? null : String(a.definingEvent.phaseNo),
              eventCode: a.definingEvent.eventCode,
            }
          : null,
      })),
      eventTypeCode: f.evType,
      city: f.city,
      stateCode: f.state,
    }),
    completion: {
      class: c.completionClass,
      rawStatus: c.rawStatus,
      hasProbableCause: c.hasProbableCause,
      mappingVersion: c.completionMappingVersion,
      mappingVerified: ctx.mappingVerified,
    },
    highestInjury: { code: f.highestInjury, label: codeLabel('ev_highest_injury', f.highestInjury) },
    injuries: { fatal: f.injTotF, serious: f.injTotS, minor: f.injTotM, uninjured: f.injTotN },
    weather: {
      basic: { code: f.wxCondBasic, label: codeLabel('wx_cond_basic', f.wxCondBasic) },
      light: { code: f.lightCond, label: codeLabel('light_cond', f.lightCond) },
      ceiling: { cover: coded(SKY_CEILING, f.skyCondCeil), heightFt: round(f.skyCeilHt) },
      lowestNonCeiling: { cover: coded(SKY_NON_CEILING, f.skyCondNonceil), heightFt: round(f.skyNonceilHt) },
      visibilitySm: f.visSm,
      wind: {
        directionDeg: round(f.windDirDeg),
        directionIndicator: f.windDirInd,
        speedKts: round(f.windVelKts),
        speedIndicator: f.windVelInd,
        gustKts: round(f.gustKts),
        gustIndicator: f.gustInd,
      },
      temperatureC: f.wxTemp,
      dewPointC: f.wxDewPt,
      altimeterInHg: round(f.altimeter, 2),
      densityAltitudeFt: round(f.wxDensAlt),
      precipitation: coded(PRECIPITATION, f.wxIntPrecip),
      metar: f.metar,
    },
    aircraft: c.aircraft.map(aircraftDetail),
    sequence,
    sections: sections.map((s) => ({
      key: s.key,
      kind: s.kind,
      label: SECTION_LABEL[s.kind],
      scope: s.scope,
      aircraftKey: s.aircraftKey,
      sourceAircraftKeys: s.sourceAircraftKeys,
      text: s.text,
      revision: s.sha256,
      citationTextVersion: s.citationTextVersion,
      transformedFromHtml: s.transformedFromHtml,
      lastChangedAt: s.lastChangedAt,
    })),
    findings: c.findings.map((x) => ({
      aircraftKey: x.aircraftKey,
      findingNo: x.findingNo,
      code: x.code,
      text: findingText(x.description),
      inProbableCause: x.inProbableCause,
    })),
    cautions: dataCautions({
      rawStatus: c.rawStatus,
      completed: c.completionClass === 'completed',
      hasProbableCause: c.hasProbableCause,
      highestInjuryCode: f.highestInjury,
      injuries: { fatal: f.injTotF, serious: f.injTotS, minor: f.injTotM },
      aircraftCount: c.aircraft.length,
      hasEventScopedSections: c.sections.some((s) => s.scope === 'event'),
      definingConflicts: c.aircraft.flatMap((a, i) => (a.definingEventConflict ? [letters[i] as string] : [])),
    }),
    report: {
      kind: 'search',
      url: AVIATION_SEARCH_URL,
      label: 'Search NTSB aviation investigations',
      note: 'Direct report link unavailable',
    },
    provenance: {
      source: 'NTSB aviation investigation database (avall.mdb)',
      snapshotDate: ctx.dataset.snapshotDate,
      datasetRevision: ctx.dataset.revision,
      caseRevision: c.sourceRevision,
      approvalDate: c.approvalDate,
      lastChangedAt: latest([f.lastChangedAt, c.adminLastChangedAt, ...c.sections.map((s) => s.lastChangedAt)]),
      citationTextVersion: ctx.citationTextVersion,
      fieldNormalizationVersion: ctx.fieldNormalizationVersion,
    },
  };
}

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

const RAD = Math.PI / 180;

/** d3-style Albers equal-area conic (parallels 29.5°/45.5°, rotated 96°W), fitted to the frame. */
function albers(lon: number, lat: number): [number, number] {
  const phi0 = 29.5 * RAD;
  const phi1 = 45.5 * RAD;
  const sy0 = Math.sin(phi0);
  const n = (sy0 + Math.sin(phi1)) / 2;
  const c = 1 + sy0 * (2 * n - sy0);
  const r0 = Math.sqrt(c) / n;
  const raw = (lambda: number, phi: number): [number, number] => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    return [r * Math.sin(lambda * n), r0 - r * Math.cos(lambda * n)];
  };
  const [cx, cy] = raw(-0.6 * RAD, 38.7 * RAD);
  const [x, y] = raw((lon + 96) * RAD, lat * RAD);
  const scale = 1180;
  return [MAP_FRAME.width / 2 + scale * (x - cx), MAP_FRAME.height / 2 - scale * (y - cy)];
}

const LOWER_48 = { minLat: 24.3, maxLat: 49.5, minLon: -125.0, maxLon: -66.8 };

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
    const { lat, lon } = c.location;
    const inside = lat >= LOWER_48.minLat && lat <= LOWER_48.maxLat && lon >= LOWER_48.minLon && lon <= LOWER_48.maxLon;
    const [x, y] = albers(lon, lat);
    if (!inside || x < 0 || x > MAP_FRAME.width || y < 0 || y > MAP_FRAME.height) {
      outsideFrame++;
      continue;
    }
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
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

