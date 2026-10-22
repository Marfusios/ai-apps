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
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
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
  sourceLabel: string;
  /** True when every row's date was compared with the case's `ev_date`. */
  dateChecked: boolean;
  /** Matched rows inserted without a date comparison (no date column, or no `ev_date`). */
  dateUnchecked: number;
  /** Rows whose case number is not in the verified generation, or whose date disagrees. */
  unmatched: { ntsbNo: string; reportId: string; reason: 'unknown_case' | 'unknown_aircraft' | 'date_mismatch' }[];
  /** Rows without a usable report id. */
  invalid: { row: number; reason: string }[];
}

export class ReportLinkError extends Error {}

interface RawLink {
  caseNo: string;
  reportId: string;
  aircraftNo?: string | undefined;
  /** Date from the source; `undefined` when the source has no date for this row. */
  eventDate?: string | undefined;
}

/** The operator-supplied column mapping of an export. */
export interface ExportMapping {
  caseCol: string;
  /** Exactly one of idCol (numeric report id) and urlCol (CAROL report URL) is set. */
  idCol?: string;
  urlCol?: string;
  aircraftCol?: string;
  dateCol?: string;
}

/**
 * Export layouts verified against a real Aviation Search export. Deliberately empty:
 * field names are never assumed. An entry may be added only after checking a real
 * export, and must record that export's sha256 and retrieval date.
 */
export interface VerifiedLayout {
  name: string;
  exportSha256: string;
  retrievedOn: string;
  mapping: ExportMapping;
}
export const VERIFIED_LAYOUTS: VerifiedLayout[] = [];

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/**
 * Numeric id from a bare id or from a CAROL report URL: https, host data.ntsb.gov,
 * path /carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/<id>[/pdf].
 */
export function extractReportId(value: string): string | null {
  const v = value.trim();
  if (REPORT_ID_PATTERN.test(v)) return v;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'data.ntsb.gov' || u.port || u.username || u.password) return null;
  const m = /^\/carol-repgen\/api\/Aviation\/ReportMain\/GenerateNewestReport\/(\d{1,9})(?:\/pdf)?\/?$/i.exec(u.pathname);
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

function checkMapping(records: Record<string, unknown>[], m: ExportMapping): void {
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  if (!m.caseCol) throw new ReportLinkError('a case column is required');
  if (!!m.idCol === !!m.urlCol) throw new ReportLinkError('give exactly one of an id column and a url column');
  const named = [m.caseCol, m.idCol, m.urlCol, m.aircraftCol, m.dateCol].filter((c): c is string => !!c);
  const missing = named.filter((c) => !headers.includes(c));
  if (missing.length) {
    throw new ReportLinkError(
      `column(s) not found in the export: ${missing.join(', ')}; found fields: ${headers.length ? headers.join(', ') : '(none)'}`,
    );
  }
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
  const t = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|\s)/.exec(t);
  return us ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : undefined;
}

interface StoreMeta {
  source: ReportLinkSource;
  sourceLabel: string;
  mapping: ExportMapping | null;
  sha: string;
  retrievedAt: Date;
  layout: string;
  invalid: ImportReport['invalid'];
  rows: number;
}

async function store(db: Db, links: RawLink[], meta: StoreMeta): Promise<ImportReport> {
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
        .where(
          and(
            eq(caseAircraft.generationId, generationId),
            or(inArray(caseAircraft.aircraftNtsbNo, keys), inArray(caseAircraft.ntsbNo, keys)),
          ),
        )
    : [];
  const event = new Map(eventRows.map((r) => [r.ntsbNo, r.evDate]));
  const aircraftByNo = new Map(aircraftRows.filter((r) => r.aircraftNtsbNo).map((r) => [r.aircraftNtsbNo!, r]));
  const aircraftOfCase = new Map<string, Set<string>>();
  for (const r of aircraftRows) {
    if (!r.aircraftNtsbNo) continue;
    const set = aircraftOfCase.get(r.ntsbNo) ?? new Set<string>();
    set.add(r.aircraftNtsbNo);
    aircraftOfCase.set(r.ntsbNo, set);
  }

  const unmatched: ImportReport['unmatched'] = [];
  const toInsert: (typeof reportLinks.$inferInsert)[] = [];
  const seen = new Set<string>();
  let dateUnchecked = 0;
  for (const l of links) {
    const ev = event.has(l.caseNo) ? { ntsbNo: l.caseNo, aircraft: null as string | null, date: event.get(l.caseNo) } : undefined;
    const ac = aircraftByNo.get(l.caseNo);
    const hit = ev ?? (ac ? { ntsbNo: ac.ntsbNo, aircraft: ac.aircraftNtsbNo, date: ac.evDate } : undefined);
    if (!hit) {
      unmatched.push({ ntsbNo: l.caseNo, reportId: l.reportId, reason: 'unknown_case' });
      continue;
    }
    if (l.aircraftNo) {
      if (!aircraftOfCase.get(hit.ntsbNo)?.has(l.aircraftNo)) {
        unmatched.push({ ntsbNo: l.caseNo, reportId: l.reportId, reason: 'unknown_aircraft' });
        continue;
      }
      hit.aircraft = l.aircraftNo;
    }
    if (l.eventDate !== undefined && hit.date) {
      if (isoDate(l.eventDate) !== hit.date) {
        unmatched.push({ ntsbNo: l.caseNo, reportId: l.reportId, reason: 'date_mismatch' });
        continue;
      }
    } else {
      dateUnchecked++;
    }
    const k = `${hit.ntsbNo}|${hit.aircraft ?? ''}|${l.reportId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    toInsert.push({
      ntsbNo: hit.ntsbNo,
      aircraftNtsbNo: hit.aircraft,
      reportId: l.reportId,
      source: meta.source,
      sourceLabel: meta.sourceLabel,
      mapping: meta.mapping,
      sourceFileSha256: meta.sha,
      retrievedAt: meta.retrievedAt,
    });
  }
  // Replace the rows of this source label atomically, so re-importing a file never leaves stale rows.
  let inserted = 0;
  await db.transaction(async (tx) => {
    await tx.delete(reportLinks).where(eq(reportLinks.sourceLabel, meta.sourceLabel));
    for (let i = 0; i < toInsert.length; i += 1000) {
      const res = await tx.insert(reportLinks).values(toInsert.slice(i, i + 1000)).onConflictDoNothing().returning({ id: sql`1` });
      inserted += res.length;
    }
  });
  return {
    source: meta.source,
    sourceLabel: meta.sourceLabel,
    sourceFileSha256: meta.sha,
    retrievedAt: meta.retrievedAt,
    generationId,
    layout: meta.layout,
    rows: meta.rows,
    matched: toInsert.length,
    inserted,
    alreadyPresent: toInsert.length - inserted,
    dateChecked: dateUnchecked === 0,
    dateUnchecked,
    unmatched,
    invalid: meta.invalid,
  };
}

const SeedSchema = z.object({
  source: z.string().min(1),
  retrievedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'retrievedAt must be a date'),
  links: z.array(
    z.object({ ntsbNo: z.string().min(1), reportId: z.string().regex(REPORT_ID_PATTERN), evDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  ),
});

export async function importSeedLinks(db: Db, file: string): Promise<ImportReport> {
  const buf = readFileSync(file);
  const seed = SeedSchema.parse(JSON.parse(buf.toString('utf8')));
  return store(
    db,
    seed.links.map((l) => ({ caseNo: l.ntsbNo, reportId: l.reportId, eventDate: l.evDate })),
    {
      source: 'seed',
      sourceLabel: seed.source,
      mapping: null,
      sha: sha256(buf),
      retrievedAt: new Date(seed.retrievedAt),
      layout: seed.source,
      invalid: [],
      rows: seed.links.length,
    },
  );
}

/**
 * Import an Aviation Search export (CSV or JSON) with an explicit, operator-supplied
 * column mapping (or a VERIFIED_LAYOUTS entry). `retrievedAt` is when the export was
 * downloaded, never the import time.
 */
export async function importAviationSearchExport(
  db: Db,
  filePath: string,
  opts: { mapping: ExportMapping; retrievedAt: Date },
): Promise<ImportReport> {
  if (Number.isNaN(opts.retrievedAt.getTime())) throw new ReportLinkError('retrievedAt must be a valid date');
  const { records, sha } = readRecords(filePath);
  const m = opts.mapping;
  checkMapping(records, m);
  const links: RawLink[] = [];
  const invalid: ImportReport['invalid'] = [];
  records.forEach((r, i) => {
    const caseNo = String(r[m.caseCol] ?? '').trim();
    const id = extractReportId(String(r[(m.idCol ?? m.urlCol)!] ?? ''));
    const aircraftNo = m.aircraftCol ? String(r[m.aircraftCol] ?? '').trim() : '';
    if (!caseNo) invalid.push({ row: i + 1, reason: 'missing case number' });
    else if (!id) invalid.push({ row: i + 1, reason: 'no valid numeric report id' });
    else {
      links.push({
        caseNo,
        reportId: id,
        ...(aircraftNo ? { aircraftNo } : {}),
        ...(m.dateCol ? { eventDate: String(r[m.dateCol] ?? '') } : {}),
      });
    }
  });
  return store(db, links, {
    source: 'aviation_search_export',
    sourceLabel: `aviation search export ${sha.slice(0, 12)}`,
    mapping: m,
    sha,
    retrievedAt: opts.retrievedAt,
    layout: 'explicit column mapping',
    invalid,
    rows: records.length,
  });
}
