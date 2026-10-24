import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import type { Db } from '../../server/db/client.js';
import { publishManifest } from '../../server/db/generations.js';
import { GENERATION_TABLES, caseSections, cases } from '../../server/db/schema/index.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { makeExtractDir, readCsv, removeDir } from '../support/extract-dir.js';

export async function loadVerified(ingest: Db, dir: string, reportDir: string): Promise<number> {
  const r = await loadFromExtract(ingest, dir);
  const v = await verifyCorpus(ingest, r.generationId, { outDir: reportDir, profile: null });
  expect(v.checks.filter((c) => !c.ok)).toEqual([]);
  expect(v).toMatchObject({ ok: true, conflict: false, status: 'verified', verificationStatus: 'ok' });
  return r.generationId;
}

/**
 * A verified generation of the fixture extract, published under `passagesIndex` (and a cases
 * index named after it) with no index behind either: the evidence a new brief must cite
 * (`claimBriefEvidence`, server/db/generations.ts) in tests whose steps never retrieve.
 */
export async function publishedEvidence(ingest: Db, passagesIndex: string): Promise<{ generationId: number; passagesIndex: string }> {
  const extract = await makeExtractDir();
  const reports = mkdtempSync(join(tmpdir(), 'aviation-evidence-reports-'));
  try {
    const generationId = await loadVerified(ingest, extract, reports);
    await publishManifest(ingest, generationId, `${passagesIndex}-cases`, passagesIndex);
    return { generationId, passagesIndex };
  } finally {
    removeDir(extract);
    removeDir(reports);
  }
}

/** Every row of one generation, as sorted JSON per table (read as the ingest role, which sees every column). */
export async function snapshot(ingest: Db, generationId: number): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of GENERATION_TABLES) {
    const t = table as PgTable & { generationId: typeof cases.generationId };
    const rows = await ingest.select().from(t).where(eq(t.generationId, generationId));
    out[getTableName(table)] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

export async function count(db: Db, query: SQL): Promise<number> {
  const r = await db.execute(query);
  return Number(Object.values(r.rows[0] ?? {})[0] ?? 0);
}

export async function revisions(db: Db, generationId: number): Promise<Map<string, { sha256: string; revisionId: string }>> {
  const rows = await db
    .select({ sectionId: caseSections.sectionId, sha256: caseSections.sha256, revisionId: caseSections.revisionId })
    .from(caseSections)
    .where(eq(caseSections.generationId, generationId));
  return new Map(rows.map((r) => [r.sectionId, { sha256: r.sha256, revisionId: r.revisionId }]));
}

/** SQLSTATE of a failed query (Drizzle wraps the driver error). */
export async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

export function evIdOf(dir: string, ntsbNo: string): string {
  const row = readCsv(join(dir, 'events.csv')).find((r) => r.ntsb_no === ntsbNo);
  if (!row?.ev_id) throw new Error(`${ntsbNo} not in fixture`);
  return row.ev_id;
}

/**
 * Simulate tampering by the schema owner: the lifecycle triggers are switched off for
 * the given tables inside one transaction (only the owner can do this).
 */
export async function tamper(migrator: Db, tables: readonly string[], statement: SQL): Promise<void> {
  await migrator.transaction(async (tx) => {
    for (const t of tables) await tx.execute(sql.raw(`ALTER TABLE "${t}" DISABLE TRIGGER USER`));
    await tx.execute(statement);
    for (const t of tables) await tx.execute(sql.raw(`ALTER TABLE "${t}" ENABLE TRIGGER USER`));
  });
}
