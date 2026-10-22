/**
 * The PostgreSQL `CaseCatalog` (server/briefs/evidence.ts): case summaries for brief
 * cards and the section revisions passages were cut from, read from one dataset
 * generation as `aviation_app`. Summaries reuse the search result rows of
 * server/db/queries/case-views.ts, so a card shows exactly what Explore shows.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { readCaseRows, reportLink } from '../db/queries/case-views.js';
import { caseAircraft, caseSections, datasetGenerations, reportLinks } from '../db/schema/index.js';
import type { CaseCatalog, CaseSummary } from './evidence.js';
import type { SectionRevision } from './validate.js';

export function createCaseCatalog(db: Db): CaseCatalog {
  return {
    async summaries(generationId, ntsbNos) {
      const out = new Map<string, CaseSummary>();
      const list = [...new Set(ntsbNos)];
      if (list.length === 0) return out;
      const [generation] = await db
        .select({ mappingVerified: datasetGenerations.mappingVerified })
        .from(datasetGenerations)
        .where(eq(datasetGenerations.id, generationId));
      if (!generation) return out;
      const rows = await readCaseRows(db, generationId, list, { mappingVerified: generation.mappingVerified });
      const links = await db
        .select({ ntsbNo: reportLinks.ntsbNo, reportId: reportLinks.reportId, retrievedAt: reportLinks.retrievedAt })
        .from(reportLinks)
        .where(inArray(reportLinks.ntsbNo, list));
      const aircraft = await db
        .select({ ntsbNo: caseAircraft.ntsbNo, aircraftNtsbNo: caseAircraft.aircraftNtsbNo })
        .from(caseAircraft)
        .where(and(eq(caseAircraft.generationId, generationId), inArray(caseAircraft.ntsbNo, list)));
      for (const [ntsbNo, row] of rows) {
        out.set(ntsbNo, {
          row,
          report: reportLink(links.filter((l) => l.ntsbNo === ntsbNo)),
          aircraftNumbers: aircraft
            .filter((a) => a.ntsbNo === ntsbNo && a.aircraftNtsbNo !== null && a.aircraftNtsbNo !== ntsbNo)
            .map((a) => a.aircraftNtsbNo as string),
        });
      }
      return out;
    },

    async sections(generationId, revisionIds) {
      const out = new Map<string, SectionRevision>();
      const list = [...new Set(revisionIds)];
      if (list.length === 0) return out;
      const rows = await db
        .select({
          ntsbNo: caseSections.ntsbNo,
          sectionId: caseSections.sectionId,
          revisionId: caseSections.revisionId,
          scope: caseSections.scope,
          aircraftKey: caseSections.aircraftKey,
          text: caseSections.text,
          sha256: caseSections.sha256,
        })
        .from(caseSections)
        .where(and(eq(caseSections.generationId, generationId), inArray(caseSections.revisionId, list)));
      for (const r of rows) out.set(r.revisionId, { ...r, scope: r.scope as SectionRevision['scope'] });
      return out;
    },
  };
}
