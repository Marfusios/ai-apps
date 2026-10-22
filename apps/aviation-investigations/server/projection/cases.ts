/**
 * Projection from canonical case data to the public API contracts (shared/contracts).
 * The API builds case rows and case pages with it from PostgreSQL; the mock API
 * (scripts/mock-api) builds the same shapes from the normalized fixtures, so both
 * produce identical responses for identical records.
 *
 * Inputs are narrow structural types: `CanonicalCase` from normalization satisfies
 * them, and so do the rows the API reads (which never include `ev_id`).
 */
import { aircraftLetter, buildHeadline, dataCautions, findingText } from '../../shared/case-view.js';
import { codeLabel } from '../../shared/codes.js';
import {
  AVIATION_SEARCH_URL,
  SECTION_LABEL,
  type AircraftDetail,
  type CaseDetail,
  type ReportLink,
  type SequenceStep,
} from '../../shared/contracts/cases.js';
import type { Coded, Dataset } from '../../shared/contracts/common.js';
import type { AircraftBrief, DefiningEvent } from '../../shared/contracts/search.js';
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
import type {
  CanonicalAircraft,
  CanonicalCase,
  CanonicalEngine,
  CanonicalEventFields,
  CanonicalFinding,
  CanonicalSection,
  CanonicalSequenceEvent,
} from '../../worker/ingest/normalize.js';

export interface ProjectionContext {
  dataset: Dataset;
  citationTextVersion: string;
  fieldNormalizationVersion: string;
  mappingVerified: boolean;
}

export type ProjectionSequence = Pick<
  CanonicalSequenceEvent,
  'aircraftKey' | 'occurrenceNo' | 'phaseNo' | 'phaseGroup' | 'eventCode' | 'isDefining'
>;

export type ProjectionAircraftBrief = Pick<
  CanonicalAircraft,
  'aircraftKey' | 'aircraftNtsbNo' | 'regisNo' | 'make' | 'model' | 'category' | 'farPart' | 'purpose' | 'damage'
> & { definingEvent: ProjectionSequence | null };

export type ProjectionAircraft = ProjectionAircraftBrief &
  Pick<CanonicalAircraft, 'series' | 'homebuilt' | 'acftYear' | 'definingEventConflict'> & {
    engines: Pick<CanonicalEngine, 'engNo' | 'engType' | 'carbFuelInjection'>[];
  };

export type ProjectionSection = Pick<
  CanonicalSection,
  'key' | 'kind' | 'scope' | 'aircraftKey' | 'sourceAircraftKeys' | 'text' | 'sha256' | 'citationTextVersion' | 'transformedFromHtml' | 'lastChangedAt'
>;

export type ProjectionFinding = Pick<CanonicalFinding, 'aircraftKey' | 'findingNo' | 'code' | 'description' | 'inProbableCause'>;

export type ProjectionFields = Pick<
  CanonicalEventFields,
  | 'evType'
  | 'evDate'
  | 'evTime'
  | 'evTmzn'
  | 'city'
  | 'state'
  | 'lightCond'
  | 'skyCondNonceil'
  | 'skyNonceilHt'
  | 'skyCeilHt'
  | 'skyCondCeil'
  | 'visSm'
  | 'wxTemp'
  | 'wxDewPt'
  | 'windDirDeg'
  | 'windDirInd'
  | 'windVelKts'
  | 'windVelInd'
  | 'gustInd'
  | 'gustKts'
  | 'altimeter'
  | 'wxDensAlt'
  | 'wxIntPrecip'
  | 'wxCondBasic'
  | 'metar'
  | 'highestInjury'
  | 'injTotF'
  | 'injTotM'
  | 'injTotN'
  | 'injTotS'
  | 'lastChangedAt'
>;

/** Everything a case page needs; `CanonicalCase` satisfies it. */
export interface ProjectionCase
  extends Pick<
    CanonicalCase,
    | 'ntsbNo'
    | 'country'
    | 'location'
    | 'rawStatus'
    | 'approvalDate'
    | 'adminLastChangedAt'
    | 'completionClass'
    | 'completionMappingVersion'
    | 'hasProbableCause'
    | 'sourceRevision'
  > {
  fields: ProjectionFields;
  aircraft: ProjectionAircraft[];
  sections: ProjectionSection[];
  findings: ProjectionFinding[];
  sequence: ProjectionSequence[];
}

export function coded(vocabulary: Vocabulary, code: string | null, blankLabel = 'Not reported'): Coded {
  const value = (code ?? '').trim().toUpperCase();
  return { code: value === '' ? null : value, label: vocabLabel(vocabulary, value, blankLabel) };
}

const round = (n: number | null, digits = 0): number | null => {
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export function phaseDetail(phaseNo: number | null): Coded {
  return coded(PHASE_CODE, phaseNo === null ? null : String(phaseNo), 'Phase not coded');
}

export function eventCoded(eventCode: string | null): Coded {
  return coded(EVENT_CODE, eventCode, 'Event not coded');
}

export function definingEvent(s: ProjectionSequence): DefiningEvent {
  return { phase: s.phaseGroup, phaseDetail: phaseDetail(s.phaseNo), event: eventCoded(s.eventCode) };
}

export function aircraftBrief(a: ProjectionAircraftBrief): AircraftBrief {
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

function aircraftDetail(a: ProjectionAircraft): AircraftDetail {
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

export function stateCoded(state: string | null): Coded {
  const code = (state ?? '').trim().toUpperCase();
  return { code: code === '' ? null : code, label: code === '' ? 'Not reported' : (US_STATE[code] ?? code) };
}

export function eventTypeCoded(evType: string | null): Coded {
  return coded(EVENT_TYPE, evType);
}

export function injuryCoded(code: string | null): Coded {
  return { code, label: codeLabel('ev_highest_injury', code) };
}

export function weatherCoded(code: string | null): Coded {
  return { code, label: codeLabel('wx_cond_basic', code) };
}

export function lightCoded(code: string | null): Coded {
  return { code, label: codeLabel('light_cond', code) };
}

export function cityText(city: string | null): string | null {
  return city?.trim() || null;
}

function latest(values: readonly (string | null)[]): string | null {
  const present = values.filter((v): v is string => v !== null).sort();
  return present[present.length - 1] ?? null;
}

const KIND_ORDER = { factual: 0, analysis: 1, probable_cause: 2 } as const;

export const SEARCH_FALLBACK_LINK: ReportLink = {
  kind: 'search',
  url: AVIATION_SEARCH_URL,
  label: 'Search NTSB aviation investigations',
  note: 'Direct report link unavailable',
};

export function toCaseDetail(c: ProjectionCase, ctx: ProjectionContext, report: ReportLink = SEARCH_FALLBACK_LINK): CaseDetail {
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
      phaseDetail: phaseDetail(s.phaseNo),
      event: eventCoded(s.eventCode),
      isDefining: s.isDefining,
      impact: s.eventCode !== null && IMPACT_EVENT_CODES.has(s.eventCode),
    }));
  const letters = c.aircraft.map((a, i) => aircraftLetter(c.ntsbNo, a.aircraftNtsbNo, i));

  return {
    ntsbNo: c.ntsbNo,
    eventType: eventTypeCoded(f.evType),
    date: f.evDate,
    time: {
      hhmm: f.evTime === null ? null : String(f.evTime).padStart(4, '0'),
      zone: coded(TIME_ZONE, f.evTmzn, 'Zone not recorded'),
    },
    city: cityText(f.city),
    state: stateCoded(f.state),
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
    highestInjury: injuryCoded(f.highestInjury),
    injuries: { fatal: f.injTotF, serious: f.injTotS, minor: f.injTotM, uninjured: f.injTotN },
    weather: {
      basic: weatherCoded(f.wxCondBasic),
      light: lightCoded(f.lightCond),
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
      // A3: aircraft scope only with exactly one aircraft. Normalization already
      // scopes multi-aircraft text to the event; a case with no aircraft row is too.
      scope: c.aircraft.length === 1 ? s.scope : 'event',
      aircraftKey: c.aircraft.length === 1 && s.scope === 'aircraft' ? s.aircraftKey : null,
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
    report,
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
