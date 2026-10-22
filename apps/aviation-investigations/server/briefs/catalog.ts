/**
 * The PostgreSQL `CaseCatalog` (server/briefs/evidence.ts), read from one dataset
 * generation as `aviation_app`:
 * - case summaries for brief cards, reusing the search result rows of
 *   server/db/queries/case-views.ts, so a card shows exactly what Explore shows;
 * - the canonical `passages` rows (identity, section kind, scope, aircraft, offsets) of
 *   the served chunker, joined with the section revision they were cut from;
 * - every probable-cause passage of a case, for the completeness check.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { readCaseRows, reportLink } from '../db/queries/case-views.js';
import { caseAircraft, caseSections, datasetGenerations, passages, reportLinks } from '../db/schema/index.js';
import type { CaseCatalog, CaseSummary } from './evidence.js';
import type { CanonicalPassage } from './validate.js';

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

    async passages(generationId, chunkerVersion, passageIds) {
      const out = new Map<string, CanonicalPassage>();
      const list = [...new Set(passageIds)];
      if (list.length === 0) return out;
      const rows = await db
        .select({
          passageId: passages.passageId,
          chunkerVersion: passages.chunkerVersion,
          ntsbNo: passages.ntsbNo,
          sectionId: passages.sectionId,
          revisionId: passages.revisionId,
          sectionKind: passages.sectionKind,
          scope: passages.scope,
          aircraftKey: passages.aircraftKey,
          start: passages.start,
          end: passages.end,
          sectionText: caseSections.text,
          sectionSha: caseSections.sha256,
        })
        .from(passages)
        .innerJoin(
          caseSections,
          and(
            eq(caseSections.generationId, passages.generationId),
            eq(caseSections.sectionId, passages.sectionId),
            eq(caseSections.revisionId, passages.revisionId),
          ),
        )
        .where(
          and(eq(passages.generationId, generationId), eq(passages.chunkerVersion, chunkerVersion), inArray(passages.passageId, list)),
        );
      for (const r of rows) out.set(r.passageId, { ...r, scope: r.scope as CanonicalPassage['scope'] });
      return out;
    },

    async causePassageIds(generationId, chunkerVersion, ntsbNos) {
      const out = new Map<string, string[]>();
      const list = [...new Set(ntsbNos)];
      if (list.length === 0) return out;
      const rows = await db
        .select({ ntsbNo: passages.ntsbNo, passageId: passages.passageId })
        .from(passages)
        .where(
          and(
            eq(passages.generationId, generationId),
            eq(passages.chunkerVersion, chunkerVersion),
            eq(passages.sectionKind, 'probable_cause'),
            inArray(passages.ntsbNo, list),
          ),
        )
        .orderBy(asc(passages.ntsbNo), asc(passages.passageId));
      for (const r of rows) out.set(r.ntsbNo, [...(out.get(r.ntsbNo) ?? []), r.passageId]);
      return out;
    },
  };
}
