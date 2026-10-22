/**
 * Test extraction directories built from the committed NTSB fixtures: the projected
 * CSVs plus a synthetic `manifest.json` that matches them (rows, columns, bytes), as
 * `worker extract` would write it. Callers may edit tables first.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { EXTRACT_IMAGE, MDB_EXPORT_FLAGS, type ExtractManifest } from '../../worker/ingest/extract.js';
import { readProjectedTables } from '../../worker/ingest/normalize.js';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from '../../worker/ingest/tables.js';

export const APP_DIR = resolve(import.meta.dirname, '../..');
export const FIXTURES_DIR = join(APP_DIR, 'fixtures/ntsb');
/** Public events the interface examples and end-to-end tests search for (carburetor icing, pattern stalls). */
export const UI_FIXTURES_DIR = join(APP_DIR, 'fixtures/ntsb-ui');

export type CsvRow = Record<string, string>;

/** Read a projected CSV as objects (header row first). */
export function readCsv(file: string): CsvRow[] {
  return parse(readFileSync(file), { columns: true, bom: true }) as CsvRow[];
}

/** Write rows with the table's allowlisted header, LF records (quoted CRLF kept). */
export function writeCsv(file: string, table: TableName, rows: readonly CsvRow[]): void {
  const columns = [...TABLE_SPECS[table].columns];
  writeFileSync(file, stringify([columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))], { record_delimiter: 'unix' }));
}

/** Rewrite one table of an extraction directory. */
export function editTable(dir: string, table: TableName, edit: (rows: CsvRow[]) => CsvRow[]): void {
  const file = join(dir, `${table}.csv`);
  writeCsv(file, table, edit(readCsv(file)));
}

/** Write `manifest.json` describing the CSVs currently in `dir`. */
export async function writeManifest(dir: string, archiveSha256?: string): Promise<ExtractManifest> {
  const tables = (await readProjectedTables(dir)) as unknown as Partial<Record<TableName, readonly unknown[]>>;
  const entries: ExtractManifest['tables'] = {};
  for (const table of TABLE_NAMES) {
    const rows = tables[table];
    if (!rows) continue;
    entries[table] = {
      rows: rows.length,
      columns: TABLE_SPECS[table].columns.length,
      bytes: statSync(join(dir, `${table}.csv`)).size,
    };
  }
  const manifest: ExtractManifest = {
    archive: { sha256: archiveSha256 ?? createHash('sha256').update('synthetic fixture archive').digest('hex'), bytes: 0 },
    image: EXTRACT_IMAGE,
    imageId: `sha256:${'0'.repeat(64)}`,
    mdbtools: '1.0.0',
    mdbExportFlags: MDB_EXPORT_FLAGS,
    tables: entries,
    startedAt: '2026-10-16T00:00:00.000Z',
    finishedAt: '2026-10-16T00:00:01.000Z',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface ExtractDirOptions {
  /** Directory of projected CSVs to copy (default: the real-record fixtures). */
  source?: string;
  /** Edit the copied CSVs before the manifest is written. */
  edit?: (dir: string) => void;
  /** Leave `manifest.json` out (an incomplete extraction). */
  withoutManifest?: boolean;
}

/** A fresh temporary extraction directory with the fixture CSVs; remove it with `removeDir`. */
export async function makeExtractDir(opts: ExtractDirOptions = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aviation-extract-test-'));
  const source = opts.source ?? FIXTURES_DIR;
  for (const name of readdirSync(source)) {
    if (name.endsWith('.csv')) copyFileSync(join(source, name), join(dir, name));
  }
  opts.edit?.(dir);
  if (!opts.withoutManifest) await writeManifest(dir);
  return dir;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A fresh extraction directory with both fixture sets (`fixtures/ntsb` and
 * `fixtures/ntsb-ui`, whose events do not overlap): the corpus of the mock API, used
 * by the API integration tests and the end-to-end tests against the real server.
 */
export async function makeCombinedExtractDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aviation-extract-combined-'));
  for (const table of TABLE_NAMES) {
    const sources = [FIXTURES_DIR, UI_FIXTURES_DIR].map((d) => join(d, `${table}.csv`)).filter((f) => existsSync(f));
    if (sources.length === 0) continue;
    writeCsv(join(dir, `${table}.csv`), table, sources.flatMap((f) => readCsv(f)));
  }
  await writeManifest(dir);
  return dir;
}
