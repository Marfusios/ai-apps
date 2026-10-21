/**
 * Report-link imports: the verified seed file and Aviation Search exports.
 *
 * `report_links` is external mapping data, not part of a sealed generation. Rows are
 * validated against the latest verified generation (case numbers must exist there);
 * unmatched rows are reported, never inserted.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../server/db/client.js';
import { caseAircraft, cases, datasetGenerations, reportLinks, type ReportLinkSource } from '../../server/db/schema/index.js';
import { REPORT_ID_PATTERN } from '../../shared/report-links.js';

export interface ImportReport {
  source: ReportLinkSource;
  sourceFileSha256: string;
  retrievedAt: Date;
  generationId: number;
  layout: string;
  rows: number;
  matched: number;
  inserted: number;
  alreadyPresent: number;
  /** Rows whose case number is not in the verified generation, or whose date disagrees. */
  unmatched: { ntsbNo: string; reportId: string; reason: 'unknown_case' | 'date_mismatch' }[];
  /** Rows without a usable report id. */
  invalid: { row: number; reason: string }[];
}

export class ReportLinkError extends Error {}

interface RawLink {
  caseNo: string;
  reportId: string;
  eventDate?: string | undefined;
}

/**
 * Verified export layouts, matched on normalized header names (lowercase, letters and
 * digits only). Add a layout here only after checking it against a real export; the
 * importer refuses anything it cannot identify positively. An id column holds either
 * the numeric report id or a CAROL report URL (the numeric id is extracted strictly).
 */
interface Layout {
  name: string;
  caseKeys: string[];
  idKeys: string[];
  dateKeys: string[];
}
export const EXPORT_LAYOUTS: Layout[] = [
  { name: 'case-number + report-id', caseKeys: ['ntsbno', 'ntsbnumber', 'casenumber'], idKeys: ['reportid', 'mkey'], dateKeys: ['eventdate', 'dateofevent'] },
  { name: 'case-number + report-url', caseKeys: ['ntsbno', 'ntsbnumber', 'casenumber'], idKeys: ['reporturl', 'reportlink'], dateKeys: ['eventdate', 'dateofevent'] },
];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** Numeric id from a bare id or from a URL whose final numeric path segment (before an optional /pdf) is the id. */
export function extractReportId(value: string): string | null {
  const v = value.trim();
  if (REPORT_ID_PATTERN.test(v)) return v;
  const m = /^https:\/\/[^\s/]*ntsb\.gov\/[^\s?#]*?\/(\d{1,9})(?:\/pdf)?\/?(?:[?#]\S*)?$/i.exec(v);
  return m?.[1] ?? null;
}

function readRecords(path: string): { records: Record<string, unknown>[]; sha: string } {
  const buf = readFileSync(path);
  const sha = sha256(buf);
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (/\.json$/i.test(path)) {
    let data: unknown = JSON.parse(text);
    if (data && !Array.isArray(data) && typeof data === 'object') {
      const arrays = Object.values(data).filter(Array.isArray);
      if (arrays.length === 1) data = arrays[0];
    }
    if (!Array.isArray(data) || !data.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      throw new ReportLinkError('export JSON must be an array of objects (or an object holding exactly one such array)');
    }
    return { records: data as Record<string, unknown>[], sha };
  }
  const records = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: false }) as Record<string, unknown>[];
  return { records, sha };
}

function detect(records: Record<string, unknown>[]): { layout: Layout; caseCol: string; idCol: string; dateCol?: string } {
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const layout of EXPORT_LAYOUTS) {
    const caseCol = layout.caseKeys.map((k) => byNorm.get(k)).find(Boolean);
    const idCol = layout.idKeys.map((k) => byNorm.get(k)).find(Boolean);
    if (caseCol && idCol) {
      const dateCol = layout.dateKeys.map((k) => byNorm.get(k)).find(Boolean);
      return { layout, caseCol, idCol, ...(dateCol ? { dateCol } : {}) };
    }
  }
  throw new ReportLinkError(
    `unknown Aviation Search export layout; found fields: ${headers.length ? headers.join(', ') : '(none)'}. ` +
      'Verify the field names against the export and add the layout to EXPORT_LAYOUTS.',
  );
}

async function latestVerifiedGeneration(db: Db): Promise<number> {
  const [row] = await db
    .select({ id: datasetGenerations.id })
    .from(datasetGenerations)
    .where(eq(datasetGenerations.verificationStatus, 'ok'))
    .orderBy(desc(datasetGenerations.id))
    .limit(1);
  if (!row) throw new ReportLinkError('no verified generation to validate case numbers against');
  return row.id;
}

function isoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()) ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v.trim());
  if (!m) return undefined;
  return m[1]!.length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

async function store(
  db: Db,
  links: RawLink[],
  meta: { source: ReportLinkSource; sha: string; retrievedAt: Date; layout: string; invalid: ImportReport['invalid']; rows: number },
): Promise<ImportReport> {
  const generationId = await latestVerifiedGeneration(db);
  const keys = [...new Set(links.map((l) => l.caseNo))];
  const eventRows = keys.length
    ? await db
        .select({ ntsbNo: cases.ntsbNo, evDate: cases.evDate })
        .from(cases)
        .where(and(eq(cases.generationId, generationId), inArray(cases.ntsbNo, keys)))
    : [];
  const aircraftRows = keys.length
    ? await db
        .select({ ntsbNo: caseAircraft.ntsbNo, aircraftNtsbNo: caseAircraft.aircraftNtsbNo, evDate: cases.evDate })
        .from(caseAircraft)
        .innerJoin(cases, and(eq(cases.generationId, caseAircraft.generationId), eq(cases.ntsbNo, caseAircraft.ntsbNo)))
        .where(and(eq(caseAircraft.generationId, generationId), inArray(caseAircraft.aircraftNtsbNo, keys)))
    : [];
  const event = new Map(eventRows.map((r) => [r.ntsbNo, r.evDate]));
  const aircraft = new Map(aircraftRows.map((r) => [r.aircraftNtsbNo!, r]));

  const unmatched: ImportReport['unmatched'] = [];
  const toInsert: (typeof reportLinks.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const ev = event.has(l.caseNo) ? { ntsbNo: l.caseNo, aircraft: null as string | null, date: event.get(l.caseNo) } : undefined;
    const ac = aircraft.get(l.caseNo);
    const hit = ev ?? (ac ? { ntsbNo: ac.ntsbNo, aircraft: ac.aircraftNtsbNo, date: ac.evDate } : undefined);
    if (!hit) {
      unmatched.push({ ntsbNo: l.caseNo, reportId: l.reportId, reason: 'unknown_case' });
      continue;
    }
    const exportDate = isoDate(l.eventDate);
    if (exportDate && hit.date && exportDate !== hit.date) {
      unmatched.push({ ntsbNo: l.caseNo, reportId: l.reportId, reason: 'date_mismatch' });
      continue;
    }
    const k = `${hit.ntsbNo}|${hit.aircraft ?? ''}|${l.reportId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    toInsert.push({
      ntsbNo: hit.ntsbNo,
      aircraftNtsbNo: hit.aircraft,
      reportId: l.reportId,
      source: meta.source,
      sourceFileSha256: meta.sha,
      retrievedAt: meta.retrievedAt,
    });
  }
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 1000) {
    const res = await db.insert(reportLinks).values(toInsert.slice(i, i + 1000)).onConflictDoNothing().returning({ id: sql`1` });
    inserted += res.length;
  }
  return {
    source: meta.source,
    sourceFileSha256: meta.sha,
    retrievedAt: meta.retrievedAt,
    generationId,
    layout: meta.layout,
    rows: meta.rows,
    matched: toInsert.length,
    inserted,
    alreadyPresent: toInsert.length - inserted,
    unmatched,
    invalid: meta.invalid,
  };
}

const SeedSchema = z.object({
  source: z.string().min(1),
  retrievedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'retrievedAt must be a date'),
  links: z.array(z.object({ ntsbNo: z.string().min(1), reportId: z.string().regex(REPORT_ID_PATTERN) })),
});

export async function importSeedLinks(db: Db, file: string): Promise<ImportReport> {
  const buf = readFileSync(file);
  const seed = SeedSchema.parse(JSON.parse(buf.toString('utf8')));
  return store(
    db,
    seed.links.map((l) => ({ caseNo: l.ntsbNo, reportId: l.reportId })),
    { source: 'seed', sha: sha256(buf), retrievedAt: new Date(seed.retrievedAt), layout: seed.source, invalid: [], rows: seed.links.length },
  );
}

export async function importAviationSearchExport(db: Db, filePath: string, opts: { retrievedAt?: Date } = {}): Promise<ImportReport> {
  const { records, sha } = readRecords(filePath);
  const { layout, caseCol, idCol, dateCol } = detect(records);
  const links: RawLink[] = [];
  const invalid: ImportReport['invalid'] = [];
  records.forEach((r, i) => {
    const caseNo = String(r[caseCol] ?? '').trim();
    const id = extractReportId(String(r[idCol] ?? ''));
    if (!caseNo) invalid.push({ row: i + 1, reason: 'missing case number' });
    else if (!id) invalid.push({ row: i + 1, reason: 'no valid numeric report id' });
    else links.push({ caseNo, reportId: id, eventDate: dateCol ? String(r[dateCol] ?? '') : undefined });
  });
  return store(db, links, {
    source: 'aviation_search_export',
    sha,
    retrievedAt: opts.retrievedAt ?? new Date(),
    layout: layout.name,
    invalid,
    rows: records.length,
  });
}
