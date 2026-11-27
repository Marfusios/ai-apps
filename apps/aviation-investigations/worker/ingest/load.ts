/**
 * Corpus load (amendment A6). A load validates the extraction directory, records an
 * ingestion run, normalizes the projected tables and writes one new dataset
 * generation in ONE transaction with batched multi-row inserts. Any failure rolls
 * the whole generation back and marks the run failed, so the active generation is
 * never touched. Rows are never updated: a reload writes a new generation.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../server/db/client.js';
import {
  caseAircraft,
  caseEngines,
  caseFindings,
  caseSectionSources,
  caseSections,
  caseSequence,
  cases,
  codeDictionary,
  datasetGenerations,
  ingestionRuns,
  quarantine,
  type SourceForm,
} from '../../server/db/schema/index.js';
import { COMPLETION_MAPPING_V1, type CompletionMapping } from '../../shared/completion.js';
import { MDB_EXPORT_FLAGS, type ExtractManifest } from './extract.js';
import {
  CITATION_TEXT_VERSION,
  FIELD_NORMALIZATION_VERSION,
  REQUIRED_TABLES,
  TEXT_NORMALIZATION_VERSION,
  normalizeCorpus,
  readProjectedTables,
  type CanonicalCase,
  type NormalizeResult,
  type NormalizeStats,
  type QuarantineRow,
  type RawTables,
} from './normalize.js';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from './tables.js';

// ---------------------------------------------------------------------------
// Extraction directory contract

/** Raised when a directory is not a complete, consistent extraction. Nothing is written. */
export class ExtractDirError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`not a valid extraction directory: ${problems.join('; ')}`);
    this.name = 'ExtractDirError';
    this.problems = problems;
  }
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const manifestSchema = z.object({
  archive: z.object({ sha256: z.string().regex(SHA256), bytes: z.number().int().nonnegative() }),
  image: z.string().min(1),
  imageId: z.string().min(1),
  mdbtools: z.string().min(1),
  mdbExportFlags: z.array(z.string()),
  tables: z.record(
    z.string(),
    z.object({
      rows: z.number().int().nonnegative(),
      columns: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
});

function readBounded(file: string, limit: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > limit) throw new ExtractDirError([`manifest.json is larger than ${limit} bytes`]);
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Validate an extraction output directory (worker/ingest/extract.ts contract): a
 * directory without a valid `manifest.json` is incomplete and rejected. The
 * manifest must parse, use the current mdb-export flags, list every required table,
 * and agree with the files on disk: a listed table's CSV exists with the recorded
 * byte size and column count, and every allowlisted CSV present is listed.
 */
export function readExtractManifest(dir: string): ExtractManifest {
  const file = join(dir, 'manifest.json');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ExtractDirError(['directory does not exist']);
  if (!existsSync(file)) throw new ExtractDirError(['manifest.json missing (incomplete extraction)']);
  let json: unknown;
  try {
    json = JSON.parse(readBounded(file, MAX_MANIFEST_BYTES));
  } catch (e) {
    if (e instanceof ExtractDirError) throw e;
    throw new ExtractDirError(['manifest.json is not valid JSON']);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ExtractDirError(parsed.error.issues.map((i) => `manifest.${i.path.join('.')}: ${i.message}`));
  }
  const m = parsed.data;
  const problems: string[] = [];
  if (JSON.stringify(m.mdbExportFlags) !== JSON.stringify(MDB_EXPORT_FLAGS)) {
    problems.push('manifest.mdbExportFlags differ from the current scalar contract');
  }
  for (const table of Object.keys(m.tables)) {
    if (!(TABLE_NAMES as readonly string[]).includes(table)) problems.push(`manifest lists unknown table ${table}`);
  }
  for (const table of REQUIRED_TABLES) {
    if (!Object.hasOwn(m.tables, table)) problems.push(`manifest does not list required table ${table}`);
  }
  for (const table of TABLE_NAMES) {
    const csv = join(dir, `${table}.csv`);
    const entry = Object.hasOwn(m.tables, table) ? m.tables[table] : undefined;
    const present = existsSync(csv);
    if (entry && !present) problems.push(`${table}.csv listed in the manifest but missing`);
    if (!entry && present) problems.push(`${table}.csv present but not listed in the manifest`);
    if (!entry || !present) continue;
    if (entry.columns !== TABLE_SPECS[table].columns.length) {
      problems.push(`${table}: manifest records ${entry.columns} columns, allowlist has ${TABLE_SPECS[table].columns.length}`);
    }
    const bytes = statSync(csv).size;
    if (bytes !== entry.bytes) problems.push(`${table}.csv is ${bytes} bytes, manifest records ${entry.bytes}`);
  }
  if (problems.length > 0) throw new ExtractDirError(problems);
  // Keep the manifest exactly as written (validated), including fields added later.
  return json as ExtractManifest;
}

/** Every table read must have exactly the manifest's data-row count. */
export function checkRowCounts(tables: RawTables, manifest: ExtractManifest): void {
  const loose = tables as unknown as Readonly<Partial<Record<TableName, readonly unknown[]>>>;
  const problems: string[] = [];
  for (const table of TABLE_NAMES) {
    const rows = loose[table];
    const entry = Object.hasOwn(manifest.tables, table) ? manifest.tables[table] : undefined;
    if (!entry) {
      if (rows !== undefined) problems.push(`${table}: read but not listed in the manifest`);
      continue;
    }
    if (rows === undefined) problems.push(`${table}: listed in the manifest but not read`);
    else if (rows.length !== entry.rows) problems.push(`${table}: read ${rows.length} rows, manifest records ${entry.rows}`);
  }
  if (problems.length > 0) throw new ExtractDirError(problems);
}

// ---------------------------------------------------------------------------
// Identifiers

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable section id: `<ntsb_no>:<section_key>` (section keys never contain ':'). */
export function sectionIdOf(ntsbNo: string, sectionKey: string): string {
  return `${ntsbNo}:${sectionKey}`;
}

/**
 * Section revision: sha256 over (ntsb_no, section_key, text sha256, citation text
 * version). Identical canonical text under the same key and version keeps its
 * revision across generations, so citations stay resolvable.
 */
export function sectionRevisionId(ntsbNo: string, sectionKey: string, textSha256: string, citationTextVersion: string): string {
  return sha256Hex(JSON.stringify([ntsbNo, sectionKey, textSha256, citationTextVersion]));
}

/**
 * How to keep a narrative row's exported text without duplicating the corpus: not at
 * all when it equals the section text or the section text with CRLF line ends, and
 * verbatim otherwise (HTML, whitespace variants, mixed or lone CR line ends).
 */
export function sourceFormOf(sectionText: string, sourceText: string): { form: SourceForm; stored: string | null } {
  if (sourceText === sectionText) return { form: 'canonical', stored: null };
  if (sourceText === sectionText.replaceAll('\n', '\r\n')) return { form: 'canonical_crlf', stored: null };
  return { form: 'stored', stored: sourceText };
}

/** Inverse of `sourceFormOf`. */
export function reconstructSource(sectionText: string, form: SourceForm, stored: string | null): string {
  if (form === 'stored') {
    if (stored === null) throw new Error('stored source without text');
    return stored;
  }
  return form === 'canonical_crlf' ? sectionText.replaceAll('\n', '\r\n') : sectionText;
}

// ---------------------------------------------------------------------------
// Row builders (pure)

export type CaseInsert = typeof cases.$inferInsert;
export type AircraftInsert = typeof caseAircraft.$inferInsert;
export type EngineInsert = typeof caseEngines.$inferInsert;
export type FindingInsert = typeof caseFindings.$inferInsert;
export type SequenceInsert = typeof caseSequence.$inferInsert;
export type SectionInsert = typeof caseSections.$inferInsert;
export type SectionSourceInsert = typeof caseSectionSources.$inferInsert;
export type DictionaryInsert = typeof codeDictionary.$inferInsert;
export type QuarantineInsert = typeof quarantine.$inferInsert;

export interface CaseRows {
  case: CaseInsert;
  aircraft: AircraftInsert[];
  engines: EngineInsert[];
  findings: FindingInsert[];
  sequence: SequenceInsert[];
  sections: SectionInsert[];
  sources: SectionSourceInsert[];
}

/** All rows of one canonical case for generation `generationId`. */
export function caseRows(generationId: number, c: CanonicalCase): CaseRows {
  const f = c.fields;
  const ntsbNo = c.ntsbNo;
  const caseRow: CaseInsert = {
    generationId,
    ntsbNo,
    evId: c.evId,
    country: c.country,
    isUs: c.isUs,
    latitude: c.location?.lat ?? null,
    longitude: c.location?.lon ?? null,
    evType: f.evType,
    evDate: f.evDate,
    evDow: f.evDow,
    evTime: f.evTime,
    evTmzn: f.evTmzn,
    city: f.city,
    state: f.state,
    evYear: f.evYear,
    evMonth: f.evMonth,
    lightCond: f.lightCond,
    skyCondNonceil: f.skyCondNonceil,
    skyNonceilHt: f.skyNonceilHt,
    skyCeilHt: f.skyCeilHt,
    skyCondCeil: f.skyCondCeil,
    visSm: f.visSm,
    wxTemp: f.wxTemp,
    wxDewPt: f.wxDewPt,
    windDirDeg: f.windDirDeg,
    windDirInd: f.windDirInd,
    windVelKts: f.windVelKts,
    windVelInd: f.windVelInd,
    gustInd: f.gustInd,
    gustKts: f.gustKts,
    altimeter: f.altimeter,
    wxDensAlt: f.wxDensAlt,
    wxIntPrecip: f.wxIntPrecip,
    wxCondBasic: f.wxCondBasic,
    metar: f.metar,
    highestInjury: f.highestInjury,
    injFGrnd: f.injFGrnd,
    injMGrnd: f.injMGrnd,
    injSGrnd: f.injSGrnd,
    injTotF: f.injTotF,
    injTotM: f.injTotM,
    injTotN: f.injTotN,
    injTotS: f.injTotS,
    injTotT: f.injTotT,
    lastChangedAt: f.lastChangedAt,
    rawStatus: c.rawStatus,
    approvalDate: c.approvalDate,
    adminLastChangedAt: c.adminLastChangedAt,
    completionClass: c.completionClass,
    completionMappingVersion: c.completionMappingVersion,
    hasProbableCause: c.hasProbableCause,
    completedWithCause: c.completedWithCause,
    answerEligible: c.answerEligible,
    definingPhaseGroups: [...c.definingPhaseGroups],
    sequencePhaseGroups: [...c.sequencePhaseGroups],
    sourceRevision: c.sourceRevision,
  };

  const aircraft: AircraftInsert[] = [];
  const engines: EngineInsert[] = [];
  for (const a of c.aircraft) {
    aircraft.push({
      generationId,
      ntsbNo,
      aircraftKey: a.aircraftKey,
      aircraftNtsbNo: a.aircraftNtsbNo,
      regisNo: a.regisNo,
      make: a.make,
      model: a.model,
      series: a.series,
      category: a.category,
      farPart: a.farPart,
      purpose: a.purpose,
      damage: a.damage,
      homebuilt: a.homebuilt,
      numEngines: a.numEngines,
      dateLastInsp: a.dateLastInsp,
      afmHrs: a.afmHrs,
      afmHrsLastInsp: a.afmHrsLastInsp,
      afmHrsSince: a.afmHrsSince,
      acftYear: a.acftYear,
      lastChangedAt: a.lastChangedAt,
      definingOccurrenceNo: a.definingEvent?.occurrenceNo ?? null,
      definingPhaseGroup: a.definingPhaseGroup,
      definingEventConflict: a.definingEventConflict,
      sequencePhaseGroups: [...a.sequencePhaseGroups],
    });
    for (const e of a.engines) {
      engines.push({
        generationId,
        ntsbNo,
        aircraftKey: a.aircraftKey,
        engNo: e.engNo,
        engType: e.engType,
        carbFuelInjection: e.carbFuelInjection,
        lastChangedAt: e.lastChangedAt,
      });
    }
  }

  const findings: FindingInsert[] = c.findings.map((x) => ({
    generationId,
    ntsbNo,
    aircraftKey: x.aircraftKey,
    findingNo: x.findingNo,
    code: x.code,
    description: x.description,
    inProbableCause: x.inProbableCause,
    causeFactor: x.causeFactorRaw,
    categoryNo: x.categoryNo,
    subcategoryNo: x.subcategoryNo,
    sectionNo: x.sectionNo,
    subsectionNo: x.subsectionNo,
    modifierNo: x.modifierNo,
    lastChangedAt: x.lastChangedAt,
  }));

  const sequence: SequenceInsert[] = c.sequence.map((s) => ({
    generationId,
    ntsbNo,
    aircraftKey: s.aircraftKey,
    occurrenceNo: s.occurrenceNo,
    phaseNo: s.phaseNo,
    phaseGroup: s.phaseGroup,
    eventCode: s.eventCode,
    occurrenceCode: s.occurrenceCode,
    description: s.description,
    isDefining: s.isDefining,
    lastChangedAt: s.lastChangedAt,
  }));

  const sections: SectionInsert[] = [];
  const sources: SectionSourceInsert[] = [];
  for (const s of c.sections) {
    const sectionId = sectionIdOf(ntsbNo, s.key);
    sections.push({
      generationId,
      sectionId,
      ntsbNo,
      sectionKey: s.key,
      kind: s.kind,
      scope: s.scope,
      aircraftKey: s.aircraftKey,
      text: s.text,
      sha256: s.sha256,
      citationTextVersion: s.citationTextVersion,
      transformedFromHtml: s.transformedFromHtml,
      sourceAircraftKeys: [...s.sourceAircraftKeys],
      revisionId: sectionRevisionId(ntsbNo, s.key, s.sha256, s.citationTextVersion),
      lastChangedAt: s.lastChangedAt,
    });
    for (const src of s.sources) {
      const { form, stored } = sourceFormOf(s.text, src.sourceText);
      sources.push({
        generationId,
        sectionId,
        ntsbNo,
        sourceAircraftKey: src.aircraftKey,
        sourceSha256: src.sourceSha256,
        match: src.match,
        transformedFromHtml: src.transformedFromHtml,
        sourceForm: form,
        sourceText: stored,
        lastChangedAt: src.lastChangedAt,
      });
    }
  }
  return { case: caseRow, aircraft, engines, findings, sequence, sections, sources };
}

/** Dictionary input rows (projected `eadmspub_datadictionary` and `ct_seqevt`). */
export interface DictionaryDraft {
  source: DictionaryInsert['source'];
  tableName: string | null;
  columnName: string | null;
  code: string;
  meaning: string | null;
}

function trimmedOrNull(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}

/** Coded dictionary rows only (a blank code is a column description, not a code). */
export function dictionaryDrafts(tables: RawTables): DictionaryDraft[] {
  const out: DictionaryDraft[] = [];
  for (const r of tables.eadmspub_datadictionary ?? []) {
    const code = trimmedOrNull(r.code_iaids);
    if (code === null) continue;
    out.push({
      source: 'eadmspub_datadictionary',
      tableName: trimmedOrNull(r.table)?.toLowerCase() ?? null,
      columnName: trimmedOrNull(r.column)?.toLowerCase() ?? null,
      code,
      meaning: trimmedOrNull(r.meaning),
    });
  }
  for (const r of tables.ct_seqevt ?? []) {
    const code = trimmedOrNull(r.code);
    if (code === null) continue;
    out.push({ source: 'ct_seqevt', tableName: null, columnName: null, code, meaning: trimmedOrNull(r.meaning) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batched inserts

/** Rows per INSERT statement. */
export const BATCH_ROWS = 1000;
/** PostgreSQL allows 65,535 bind parameters per statement; stay below. */
const MAX_PARAMS = 60_000;
/** Bound on string characters per statement (narrative sections can be ~100 KB). */
const MAX_BATCH_CHARS = 16 * 1024 * 1024;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** A value PostgreSQL would reject: fail with the table, row key and column, never the value. */
export class LoadValueError extends Error {
  constructor(table: string, rowKey: string, column: string, problem: string) {
    super(`${table}: ${column} of ${rowKey} ${problem}`);
    this.name = 'LoadValueError';
  }
}

function rowKeyOf(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ['ntsbNo', 'sectionId', 'aircraftKey', 'sourceAircraftKey', 'engNo', 'findingNo', 'occurrenceNo', 'entryNo']) {
    if (row[k] !== undefined && row[k] !== null) parts.push(`${k}=${String(row[k])}`);
  }
  return parts.join(',') || 'row';
}

const integerColumnsCache = new Map<PgTable, Set<string>>();
function integerColumns(table: PgTable): Set<string> {
  let set = integerColumnsCache.get(table);
  if (!set) {
    set = new Set();
    for (const [key, col] of Object.entries(getTableColumns(table))) {
      const type = col.columnType;
      if (type === 'PgInteger' || (type === 'PgArray' && col.getSQLType().startsWith('integer'))) set.add(key);
    }
    integerColumnsCache.set(table, set);
  }
  return set;
}

/**
 * Event years the API serves: every search, dashboard and config response carries a year
 * axis bounded to 1900–2100 (shared/contracts/search.ts, config.ts). One event outside it
 * would pass normalization, verification, both builds and publish, then fail every such
 * response (task 22 search review S-I1), so the load refuses it instead. (A refusal, not a
 * change to normalized output: `FIELD_NORMALIZATION_VERSION` v1 is unchanged.)
 */
const FIRST_EVENT_YEAR = 1900;
const LAST_EVENT_YEAR = 2100;

/**
 * Validate values PostgreSQL cannot store (NUL in text, integers outside int4), and event
 * years the API could not serve, and return string size.
 */
function checkRow(table: PgTable, row: Record<string, unknown>): number {
  const ints = integerColumns(table);
  const year = row.evYear;
  if (getTableName(table) === 'cases' && typeof year === 'number' && (year < FIRST_EVENT_YEAR || year > LAST_EVENT_YEAR)) {
    throw new LoadValueError('cases', rowKeyOf(row), 'evYear', `is outside ${FIRST_EVENT_YEAR}-${LAST_EVENT_YEAR}, the years the API serves (a dropped or extra digit?)`);
  }
  let chars = 0;
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === 'string') {
      if (value.includes('\u0000')) throw new LoadValueError(getTableName(table), rowKeyOf(row), column, 'contains a NUL character');
      chars += value.length;
    } else if (ints.has(column)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (typeof v === 'number' && (!Number.isInteger(v) || v < INT32_MIN || v > INT32_MAX)) {
          throw new LoadValueError(getTableName(table), rowKeyOf(row), column, 'is outside the 32-bit integer range');
        }
      }
    }
  }
  return chars;
}

/** Insert rows in multi-row statements of at most BATCH_ROWS rows; returns rows inserted. */
export async function insertBatched<T extends PgTable>(
  tx: DbOrTx,
  table: T,
  rows: readonly T['$inferInsert'][],
): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Object.keys(getTableColumns(table)).length;
  const maxRows = Math.max(1, Math.min(BATCH_ROWS, Math.floor(MAX_PARAMS / columns)));
  let inserted = 0;
  let batch: T['$inferInsert'][] = [];
  let chars = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const result = await tx.insert(table).values(batch);
    inserted += result.rowCount ?? 0;
    batch = [];
    chars = 0;
  };
  for (const row of rows) {
    const size = checkRow(table, row as Record<string, unknown>);
    if (batch.length > 0 && (batch.length >= maxRows || chars + size > MAX_BATCH_CHARS)) await flush();
    batch.push(row);
    chars += size;
  }
  await flush();
  return inserted;
}

// ---------------------------------------------------------------------------
// Runs and generations

export const ROW_TABLES = [
  'cases',
  'case_aircraft',
  'case_engines',
  'case_findings',
  'case_sequence',
  'case_sections',
  'case_section_sources',
  'code_dictionary',
  'quarantine',
] as const;
export type RowTable = (typeof ROW_TABLES)[number];
export type RowCounts = Record<RowTable, number>;

export interface GenerationStats {
  normalize: NormalizeStats;
  rows: RowCounts;
  cohortProvisional: boolean;
  /** The completion mapping applied, in full, so verification can recompute every class. */
  completionMapping: CompletionMapping;
  codeLabels: { source: string; addedFromDictionary: number };
  /** Narrative sources by storage form (aggregate). */
  sourceForms: Record<SourceForm, number>;
}

export interface LoadInput {
  normalized: NormalizeResult;
  dictionary: readonly DictionaryDraft[];
  manifest: ExtractManifest;
}

export interface LoadReport {
  runId: number;
  generationId: number;
  /** Planner statistics refreshed after the load (`analyzeCorpus`). */
  analyzed: boolean;
  rows: RowCounts;
  stats: NormalizeStats;
  cohortProvisional: boolean;
  mappingVersion: string;
  durationMs: number;
}

export interface LoadOptions {
  /** Importer status must never retain SQL/source diagnostics. */
  privateErrors?: boolean;
  /** Durable import linkage on this exact load transaction, before it can commit. */
  onGeneration?: (tx: DbOrTx, generationId: number) => Promise<void>;
  mapping?: CompletionMapping;
  /** Cases per transaction step (each table then inserts at most BATCH_ROWS rows per statement). */
  casesPerStep?: number;
  /**
   * Test seam: runs inside the load transaction after every insert, the run's
   * `succeeded` record and the seal, just before commit. A throw rolls everything back.
   */
  beforeCommit?: () => Promise<void> | void;
}

const MAX_ERROR_CHARS = 2000;

/**
 * Error text safe to store and print: the message, plus the key detail of unique and
 * foreign-key violations. A check violation's detail ("Failing row contains ...")
 * can hold narrative text and is never included.
 */
export function describeLoadError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, MAX_ERROR_CHARS);
  const pgErr = err as Error & { code?: string; constraint?: string; table?: string; detail?: string; cause?: unknown };
  // Drizzle wraps driver errors; the pg error is the cause.
  const inner = (pgErr.cause instanceof Error ? pgErr.cause : pgErr) as typeof pgErr;
  let text = inner === pgErr ? pgErr.message : inner.message;
  // A query wrapper's own message lists the statement and its parameters (narrative text).
  if (text.startsWith('Failed query:')) text = 'database query failed';
  if (inner.code) {
    text += ` [${inner.code}${inner.table ? ` on ${inner.table}` : ''}${inner.constraint ? ` (${inner.constraint})` : ''}]`;
    if ((inner.code === '23505' || inner.code === '23503') && inner.detail) text += ` ${inner.detail}`;
  }
  return text.slice(0, MAX_ERROR_CHARS);
}

async function startRun(db: Db, archiveSha256: string | null, mapping: CompletionMapping): Promise<number> {
  const [run] = await db
    .insert(ingestionRuns)
    .values({
      status: 'running',
      archiveSha256,
      mappingVersion: mapping.version,
      textNormalizationVersion: TEXT_NORMALIZATION_VERSION,
      fieldNormalizationVersion: FIELD_NORMALIZATION_VERSION,
    })
    .returning({ id: ingestionRuns.id });
  if (!run) throw new Error('could not create ingestion run');
  return run.id;
}

/**
 * Run `fn` under a new ingestion run. `fn` records `succeeded` inside the generation
 * transaction; when it throws, nothing it wrote was committed and the run is marked
 * `failed` here (only while still `running`). The original error is always rethrown,
 * even if recording the failure fails.
 */
async function withRun(
  db: Db,
  archiveSha256: string | null,
  mapping: CompletionMapping,
  fn: (runId: number) => Promise<Omit<LoadReport, 'runId' | 'durationMs' | 'analyzed'>>,
  privateErrors = false,
): Promise<LoadReport> {
  const started = Date.now();
  const runId = await startRun(db, archiveSha256, mapping);
  let report: Omit<LoadReport, 'runId' | 'durationMs' | 'analyzed'>;
  try {
    report = await fn(runId);
  } catch (err) {
    try {
      await db
        .update(ingestionRuns)
        .set({ status: 'failed', finishedAt: new Date(), error: privateErrors ? 'import load failed' : describeLoadError(err) })
        .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.status, 'running')));
    } catch {
      // The run stays 'running'; `worker fail-stale-runs` closes it later.
    }
    throw err;
  }
  // Best effort: the generation is committed whether or not statistics refresh.
  const analyzed = await analyzeCorpus(db).then(
    () => true,
    () => false,
  );
  return { ...report, runId, analyzed, durationMs: Date.now() - started };
}

/**
 * Refresh planner statistics of the corpus tables (`analyze_corpus()`, owned by the
 * migrator). A new generation's `generation_id` is unknown to the previous
 * statistics, so queries on it (verification first) would otherwise be planned as
 * if it were empty.
 */
export async function analyzeCorpus(db: DbOrTx): Promise<void> {
  await db.execute(sql`select analyze_corpus()`);
}

function emptyCounts(): RowCounts {
  return Object.fromEntries(ROW_TABLES.map((t) => [t, 0])) as RowCounts;
}

/** Expected row counts and source-form tally, computed without building every row. */
function plannedCounts(input: LoadInput): { rows: RowCounts; sourceForms: Record<SourceForm, number> } {
  const rows = emptyCounts();
  const sourceForms: Record<SourceForm, number> = { canonical: 0, canonical_crlf: 0, stored: 0 };
  for (const c of input.normalized.cases) {
    rows.cases += 1;
    rows.case_aircraft += c.aircraft.length;
    for (const a of c.aircraft) rows.case_engines += a.engines.length;
    rows.case_findings += c.findings.length;
    rows.case_sequence += c.sequence.length;
    rows.case_sections += c.sections.length;
    for (const s of c.sections) {
      rows.case_section_sources += s.sources.length;
      for (const src of s.sources) sourceForms[sourceFormOf(s.text, src.sourceText).form] += 1;
    }
  }
  rows.code_dictionary = input.dictionary.length;
  rows.quarantine = input.normalized.quarantine.length;
  return { rows, sourceForms };
}

function quarantineRow(generationId: number, runId: number, entryNo: number, q: QuarantineRow): QuarantineInsert {
  return {
    generationId,
    entryNo,
    runId,
    tableName: q.table,
    key: q.key,
    columnName: q.column,
    reason: q.reason,
    action: q.action,
    value: q.value,
    detail: q.detail,
  };
}

/**
 * Write one new generation in a single transaction: insert it as `loading`, insert
 * every row, record the run as `succeeded` (with its counts) and seal the generation
 * (`loaded`), then commit. After the seal the database rejects any further write to
 * its rows; `verifyCorpus` takes it from there.
 */
async function writeGeneration(
  db: Db,
  runId: number,
  input: LoadInput,
  opts: LoadOptions,
): Promise<Omit<LoadReport, 'runId' | 'durationMs' | 'analyzed'>> {
  const { normalized, manifest } = input;
  const planned = plannedCounts(input);
  const mapping = normalized.completionMapping;
  const stats: GenerationStats = {
    normalize: normalized.stats,
    rows: planned.rows,
    cohortProvisional: normalized.cohortProvisional,
    completionMapping: {
      version: mapping.version,
      verified: mapping.verified,
      completedStatuses: [...mapping.completedStatuses],
      inProgressStatuses: [...mapping.inProgressStatuses],
    },
    codeLabels: { source: normalized.codeLabels.source, addedFromDictionary: normalized.codeLabels.addedFromDictionary.length },
    sourceForms: planned.sourceForms,
  };
  const step = Math.max(1, opts.casesPerStep ?? BATCH_ROWS);

  const generationId = await db.transaction(async (tx) => {
    // Foreign-key checks run one key lookup per inserted row with a plan cached early,
    // while this generation's tables are still small. A sequential-scan plan cached
    // then would be reused as the tables grow (quadratic time); force index lookups.
    await tx.execute(sql`set local enable_seqscan = off`);
    const [gen] = await tx
      .insert(datasetGenerations)
      .values({
        ingestionRunId: runId,
        archiveSha256: manifest.archive.sha256,
        extractManifest: manifest,
        mappingVersion: mapping.version,
        mappingVerified: mapping.verified,
        citationTextVersion: normalized.citationTextVersion,
        fieldNormalizationVersion: normalized.fieldNormalizationVersion,
        status: 'loading',
        stats,
      })
      .returning({ id: datasetGenerations.id });
    if (!gen) throw new Error('could not create dataset generation');
    const id = gen.id;
    await opts.onGeneration?.(tx, id);
    const inserted = emptyCounts();
    for (let i = 0; i < normalized.cases.length; i += step) {
      const sets = normalized.cases.slice(i, i + step).map((c) => caseRows(id, c));
      // Parents before children: foreign keys are checked per statement.
      inserted.cases += await insertBatched(tx, cases, sets.map((s) => s.case));
      inserted.case_aircraft += await insertBatched(tx, caseAircraft, sets.flatMap((s) => s.aircraft));
      inserted.case_engines += await insertBatched(tx, caseEngines, sets.flatMap((s) => s.engines));
      inserted.case_findings += await insertBatched(tx, caseFindings, sets.flatMap((s) => s.findings));
      inserted.case_sequence += await insertBatched(tx, caseSequence, sets.flatMap((s) => s.sequence));
      inserted.case_sections += await insertBatched(tx, caseSections, sets.flatMap((s) => s.sections));
      inserted.case_section_sources += await insertBatched(tx, caseSectionSources, sets.flatMap((s) => s.sources));
    }
    inserted.code_dictionary = await insertBatched(
      tx,
      codeDictionary,
      input.dictionary.map((d, n) => ({ generationId: id, entryNo: n + 1, ...d })),
    );
    inserted.quarantine = await insertBatched(
      tx,
      quarantine,
      normalized.quarantine.map((q, n) => quarantineRow(id, runId, n + 1, q)),
    );
    const mismatched = ROW_TABLES.filter((t) => inserted[t] !== planned.rows[t]);
    if (mismatched.length > 0) {
      throw new Error(`inserted row counts differ from the plan: ${mismatched.map((t) => `${t} ${inserted[t]}/${planned.rows[t]}`).join(', ')}`);
    }
    const finished = await tx
      .update(ingestionRuns)
      .set({ status: 'succeeded', finishedAt: new Date(), counts: { generationId: id, rows: inserted } })
      .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.status, 'running')))
      .returning({ id: ingestionRuns.id });
    if (finished.length !== 1) throw new Error(`ingestion run ${runId} is no longer running`);
    await tx.execute(sql`select seal_generation(${id})`);
    await opts.beforeCommit?.();
    return id;
  });

  return {
    generationId,
    rows: planned.rows,
    stats: normalized.stats,
    cohortProvisional: normalized.cohortProvisional,
    mappingVersion: mapping.version,
  };
}

/** Load already-normalized input as a new generation under a new ingestion run. */
export async function loadCorpus(db: Db, input: LoadInput, opts: LoadOptions = {}): Promise<LoadReport> {
  return withRun(db, input.manifest.archive.sha256, input.normalized.completionMapping, (runId) =>
    writeGeneration(db, runId, input, opts), opts.privateErrors,
  );
}

/**
 * `worker load --from <dir>`: validate the extraction directory (rejected before any
 * database write when its manifest is missing or inconsistent), then, under a new
 * ingestion run, read the projected tables, check their row counts against the
 * manifest, normalize and write a new generation. Normalization errors (duplicate
 * keys or case numbers, missing columns) fail the run with nothing written.
 */
export async function loadFromExtract(db: Db, dir: string, opts: LoadOptions = {}): Promise<LoadReport> {
  const manifest = readExtractManifest(dir);
  const mapping = opts.mapping ?? COMPLETION_MAPPING_V1;
  return withRun(db, manifest.archive.sha256, mapping, async (runId) => {
    const tables = await readProjectedTables(dir);
    checkRowCounts(tables, manifest);
    const normalized = normalizeCorpus(tables, { mapping });
    if (normalized.citationTextVersion !== CITATION_TEXT_VERSION) throw new Error('citation text version mismatch');
    return writeGeneration(db, runId, { normalized, dictionary: dictionaryDrafts(tables), manifest }, opts);
  }, opts.privateErrors);
}
