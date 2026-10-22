/**
 * Case data for the public API, read from one dataset generation (the active
 * manifest's, amendment A6): result rows for a page of search hits and the full case
 * page. Shapes come from the shared projection (server/projection/cases.ts).
 *
 * Every column is selected by name; `ev_id` is never read (the app role cannot read it
 * either). Case pages exist for every event of the generation, US or not; search rows
 * are only ever requested for hits of the US-only cases index.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CaseDetail, ReportLink } from '../../../shared/contracts/cases.js';
import type { CaseRow } from '../../../shared/contracts/search.js';
import type { PhaseGroup } from '../../../shared/codes.js';
import { reportLinkFor } from '../../../shared/report-links.js';
import {
  SEARCH_FALLBACK_LINK,
  aircraftBrief,
  cityText,
  eventTypeCoded,
  injuryCoded,
  lightCoded,
  stateCoded,
  toCaseDetail,
  weatherCoded,
  type ProjectionAircraft,
  type ProjectionCase,
  type ProjectionContext,
  type ProjectionSequence,
} from '../../projection/cases.js';
import type { Db, DbOrTx } from '../client.js';
import { caseAircraft, caseEngines, caseFindings, caseSections, caseSequence, cases, reportLinks } from '../schema/index.js';

export type CaseRowBase = Omit<CaseRow, 'snippet'>;

export interface RowContext {
  mappingVerified: boolean;
}

const asPhases = (groups: readonly string[]): PhaseGroup[] => groups as PhaseGroup[];

/**
 * A zone-less PostgreSQL timestamp (`2008-03-11 12:00:00`, as recorded) in the
 * contract's form `2008-03-11T12:00:00`; no zone is invented and fractions are dropped.
 */
export function isoLocal(value: string | null): string | null {
  if (value === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  if (!m) throw new Error('unexpected timestamp format');
  return `${m[1]}T${m[2]}`;
}

/** Defining sequence rows of the given aircraft rows, keyed `<ntsb_no>|<aircraft_key>`. */
async function definingRows(
  db: DbOrTx,
  generationId: number,
  ntsbNos: readonly string[],
): Promise<Map<string, ProjectionSequence>> {
  const rows = await db
    .select({
      ntsbNo: caseSequence.ntsbNo,
      aircraftKey: caseSequence.aircraftKey,
      occurrenceNo: caseSequence.occurrenceNo,
      phaseNo: caseSequence.phaseNo,
      phaseGroup: caseSequence.phaseGroup,
      eventCode: caseSequence.eventCode,
      isDefining: caseSequence.isDefining,
    })
    .from(caseSequence)
    .innerJoin(
      caseAircraft,
      and(
        eq(caseAircraft.generationId, caseSequence.generationId),
        eq(caseAircraft.ntsbNo, caseSequence.ntsbNo),
        eq(caseAircraft.aircraftKey, caseSequence.aircraftKey),
        eq(caseAircraft.definingOccurrenceNo, caseSequence.occurrenceNo),
      ),
    )
    .where(and(eq(caseSequence.generationId, generationId), inArray(caseSequence.ntsbNo, [...ntsbNos])));
  return new Map(
    rows.map((r) => [
      `${r.ntsbNo}|${r.aircraftKey}`,
      { ...r, phaseGroup: r.phaseGroup as PhaseGroup },
    ]),
  );
}

/** Result rows (without snippets) for the given case numbers of one generation. */
export async function readCaseRows(
  db: DbOrTx,
  generationId: number,
  ntsbNos: readonly string[],
  ctx: RowContext,
): Promise<Map<string, CaseRowBase>> {
  if (ntsbNos.length === 0) return new Map();
  const list = [...ntsbNos];
  const caseRows = await db
    .select({
      ntsbNo: cases.ntsbNo,
      evType: cases.evType,
      evDate: cases.evDate,
      city: cases.city,
      state: cases.state,
      country: cases.country,
      lightCond: cases.lightCond,
      wxCondBasic: cases.wxCondBasic,
      highestInjury: cases.highestInjury,
      rawStatus: cases.rawStatus,
      completionClass: cases.completionClass,
      completionMappingVersion: cases.completionMappingVersion,
      hasProbableCause: cases.hasProbableCause,
      definingPhaseGroups: cases.definingPhaseGroups,
    })
    .from(cases)
    .where(and(eq(cases.generationId, generationId), inArray(cases.ntsbNo, list)));
  const aircraft = await db
    .select({
      ntsbNo: caseAircraft.ntsbNo,
      aircraftKey: caseAircraft.aircraftKey,
      aircraftNtsbNo: caseAircraft.aircraftNtsbNo,
      regisNo: caseAircraft.regisNo,
      make: caseAircraft.make,
      model: caseAircraft.model,
      category: caseAircraft.category,
      farPart: caseAircraft.farPart,
      purpose: caseAircraft.purpose,
      damage: caseAircraft.damage,
    })
    .from(caseAircraft)
    .where(and(eq(caseAircraft.generationId, generationId), inArray(caseAircraft.ntsbNo, list)))
    .orderBy(asc(caseAircraft.ntsbNo), asc(caseAircraft.aircraftKey));
  const defining = await definingRows(db, generationId, list);

  const out = new Map<string, CaseRowBase>();
  for (const c of caseRows) {
    out.set(c.ntsbNo, {
      ntsbNo: c.ntsbNo,
      eventType: eventTypeCoded(c.evType),
      date: c.evDate,
      city: cityText(c.city),
      state: stateCoded(c.state),
      country: c.country,
      aircraft: aircraft
        .filter((a) => a.ntsbNo === c.ntsbNo)
        .map((a) => aircraftBrief({ ...a, definingEvent: defining.get(`${a.ntsbNo}|${a.aircraftKey}`) ?? null })),
      definingPhases: asPhases(c.definingPhaseGroups),
      conditions: weatherCoded(c.wxCondBasic),
      light: lightCoded(c.lightCond),
      highestInjury: injuryCoded(c.highestInjury),
      completion: {
        class: c.completionClass,
        rawStatus: c.rawStatus,
        hasProbableCause: c.hasProbableCause,
        mappingVersion: c.completionMappingVersion,
        mappingVerified: ctx.mappingVerified,
      },
    });
  }
  return out;
}

/** The report link of a case: the highest valid report id, or the labelled search fallback. */
export function reportLink(rows: readonly { reportId: string; retrievedAt: Date }[]): ReportLink {
  const link = reportLinkFor(rows);
  if (link.kind !== 'report') return SEARCH_FALLBACK_LINK;
  const captured = rows
    .filter((r) => r.reportId === link.reportId)
    .map((r) => r.retrievedAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  return { kind: 'report', url: link.url, label: 'NTSB report', capturedOn: new Date(captured).toISOString().slice(0, 10) };
}

/** The full case page of `ntsbNo` in one generation, or null when it has no such case. */
export async function readCaseDetail(
  db: Db,
  generationId: number,
  ntsbNo: string,
  ctx: ProjectionContext,
): Promise<CaseDetail | null> {
  // One snapshot for every table of the case.
  return db.transaction(
    async (tx) => {
      const [c] = await tx
        .select({
          ntsbNo: cases.ntsbNo,
          country: cases.country,
          latitude: cases.latitude,
          longitude: cases.longitude,
          evType: cases.evType,
          evDate: cases.evDate,
          evTime: cases.evTime,
          evTmzn: cases.evTmzn,
          city: cases.city,
          state: cases.state,
          lightCond: cases.lightCond,
          skyCondNonceil: cases.skyCondNonceil,
          skyNonceilHt: cases.skyNonceilHt,
          skyCeilHt: cases.skyCeilHt,
          skyCondCeil: cases.skyCondCeil,
          visSm: cases.visSm,
          wxTemp: cases.wxTemp,
          wxDewPt: cases.wxDewPt,
          windDirDeg: cases.windDirDeg,
          windDirInd: cases.windDirInd,
          windVelKts: cases.windVelKts,
          windVelInd: cases.windVelInd,
          gustInd: cases.gustInd,
          gustKts: cases.gustKts,
          altimeter: cases.altimeter,
          wxDensAlt: cases.wxDensAlt,
          wxIntPrecip: cases.wxIntPrecip,
          wxCondBasic: cases.wxCondBasic,
          metar: cases.metar,
          highestInjury: cases.highestInjury,
          injTotF: cases.injTotF,
          injTotM: cases.injTotM,
          injTotN: cases.injTotN,
          injTotS: cases.injTotS,
          lastChangedAt: cases.lastChangedAt,
          rawStatus: cases.rawStatus,
          approvalDate: cases.approvalDate,
          adminLastChangedAt: cases.adminLastChangedAt,
          completionClass: cases.completionClass,
          completionMappingVersion: cases.completionMappingVersion,
          hasProbableCause: cases.hasProbableCause,
          sourceRevision: cases.sourceRevision,
        })
        .from(cases)
        .where(and(eq(cases.generationId, generationId), eq(cases.ntsbNo, ntsbNo)));
      if (!c) return null;
      const aircraftRows = await tx
        .select({
          aircraftKey: caseAircraft.aircraftKey,
          aircraftNtsbNo: caseAircraft.aircraftNtsbNo,
          regisNo: caseAircraft.regisNo,
          make: caseAircraft.make,
          model: caseAircraft.model,
          series: caseAircraft.series,
          category: caseAircraft.category,
          farPart: caseAircraft.farPart,
          purpose: caseAircraft.purpose,
          damage: caseAircraft.damage,
          homebuilt: caseAircraft.homebuilt,
          acftYear: caseAircraft.acftYear,
          definingOccurrenceNo: caseAircraft.definingOccurrenceNo,
          definingEventConflict: caseAircraft.definingEventConflict,
        })
        .from(caseAircraft)
        .where(and(eq(caseAircraft.generationId, generationId), eq(caseAircraft.ntsbNo, ntsbNo)))
        .orderBy(asc(caseAircraft.aircraftKey));
      const engines = await tx
        .select({
          aircraftKey: caseEngines.aircraftKey,
          engNo: caseEngines.engNo,
          engType: caseEngines.engType,
          carbFuelInjection: caseEngines.carbFuelInjection,
        })
        .from(caseEngines)
        .where(and(eq(caseEngines.generationId, generationId), eq(caseEngines.ntsbNo, ntsbNo)))
        .orderBy(asc(caseEngines.aircraftKey), asc(caseEngines.engNo));
      const sequenceRows = await tx
        .select({
          aircraftKey: caseSequence.aircraftKey,
          occurrenceNo: caseSequence.occurrenceNo,
          phaseNo: caseSequence.phaseNo,
          phaseGroup: caseSequence.phaseGroup,
          eventCode: caseSequence.eventCode,
          isDefining: caseSequence.isDefining,
        })
        .from(caseSequence)
        .where(and(eq(caseSequence.generationId, generationId), eq(caseSequence.ntsbNo, ntsbNo)))
        .orderBy(asc(caseSequence.aircraftKey), asc(caseSequence.occurrenceNo));
      const sections = await tx
        .select({
          key: caseSections.sectionKey,
          kind: caseSections.kind,
          scope: caseSections.scope,
          aircraftKey: caseSections.aircraftKey,
          sourceAircraftKeys: caseSections.sourceAircraftKeys,
          text: caseSections.text,
          sha256: caseSections.sha256,
          citationTextVersion: caseSections.citationTextVersion,
          transformedFromHtml: caseSections.transformedFromHtml,
          lastChangedAt: caseSections.lastChangedAt,
        })
        .from(caseSections)
        .where(and(eq(caseSections.generationId, generationId), eq(caseSections.ntsbNo, ntsbNo)));
      const findings = await tx
        .select({
          aircraftKey: caseFindings.aircraftKey,
          findingNo: caseFindings.findingNo,
          code: caseFindings.code,
          description: caseFindings.description,
          inProbableCause: caseFindings.inProbableCause,
        })
        .from(caseFindings)
        .where(and(eq(caseFindings.generationId, generationId), eq(caseFindings.ntsbNo, ntsbNo)))
        .orderBy(asc(caseFindings.aircraftKey), asc(caseFindings.findingNo));
      const links = await tx
        .select({ reportId: reportLinks.reportId, retrievedAt: reportLinks.retrievedAt })
        .from(reportLinks)
        .where(eq(reportLinks.ntsbNo, ntsbNo));

      const sequence: ProjectionSequence[] = sequenceRows.map((s) => ({ ...s, phaseGroup: s.phaseGroup as PhaseGroup }));
      const aircraft: ProjectionAircraft[] = aircraftRows.map((a) => ({
        ...a,
        engines: engines.filter((e) => e.aircraftKey === a.aircraftKey),
        definingEvent:
          a.definingOccurrenceNo === null
            ? null
            : (sequence.find((s) => s.aircraftKey === a.aircraftKey && s.occurrenceNo === a.definingOccurrenceNo) ?? null),
      }));
      const source: ProjectionCase = {
        ntsbNo: c.ntsbNo,
        country: c.country,
        location: c.latitude !== null && c.longitude !== null ? { lat: c.latitude, lon: c.longitude } : null,
        rawStatus: c.rawStatus,
        approvalDate: c.approvalDate,
        adminLastChangedAt: isoLocal(c.adminLastChangedAt),
        completionClass: c.completionClass,
        completionMappingVersion: c.completionMappingVersion,
        hasProbableCause: c.hasProbableCause,
        sourceRevision: c.sourceRevision,
        fields: {
          evType: c.evType,
          evDate: c.evDate,
          evTime: c.evTime,
          evTmzn: c.evTmzn,
          city: c.city,
          state: c.state,
          lightCond: c.lightCond,
          skyCondNonceil: c.skyCondNonceil,
          skyNonceilHt: c.skyNonceilHt,
          skyCeilHt: c.skyCeilHt,
          skyCondCeil: c.skyCondCeil,
          visSm: c.visSm,
          wxTemp: c.wxTemp,
          wxDewPt: c.wxDewPt,
          windDirDeg: c.windDirDeg,
          windDirInd: c.windDirInd,
          windVelKts: c.windVelKts,
          windVelInd: c.windVelInd,
          gustInd: c.gustInd,
          gustKts: c.gustKts,
          altimeter: c.altimeter,
          wxDensAlt: c.wxDensAlt,
          wxIntPrecip: c.wxIntPrecip,
          wxCondBasic: c.wxCondBasic,
          metar: c.metar,
          highestInjury: c.highestInjury,
          injTotF: c.injTotF,
          injTotM: c.injTotM,
          injTotN: c.injTotN,
          injTotS: c.injTotS,
          lastChangedAt: isoLocal(c.lastChangedAt),
        },
        aircraft,
        sections: sections.map((x) => ({ ...x, lastChangedAt: isoLocal(x.lastChangedAt) })),
        findings,
        sequence,
      };
      return toCaseDetail(source, ctx, reportLink(links));
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Coordinates and METAR coverage of a dashboard cohort (US events of one generation). */
export async function readCohortLocations(
  db: DbOrTx,
  generationId: number,
  defaultCohort: boolean,
): Promise<{ points: { lat: number; lon: number }[]; metar: number; withoutCoordinates: number; total: number }> {
  const cohort = defaultCohort ? sql`and answer_eligible` : sql``;
  const result = await db.execute(sql`
    select latitude, longitude, metar is not null as has_metar
      from cases
     where generation_id = ${generationId} and is_us ${cohort}`);
  const points: { lat: number; lon: number }[] = [];
  let metar = 0;
  let withoutCoordinates = 0;
  for (const row of result.rows as { latitude: number | null; longitude: number | null; has_metar: boolean }[]) {
    if (row.has_metar) metar++;
    if (row.latitude === null || row.longitude === null) withoutCoordinates++;
    else points.push({ lat: Number(row.latitude), lon: Number(row.longitude) });
  }
  return { points, metar, withoutCoordinates, total: result.rows.length };
}
