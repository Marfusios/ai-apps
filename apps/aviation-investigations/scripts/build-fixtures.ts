/**
 * Build the committed NTSB test fixtures (run manually; tests only read the output).
 *
 *   pnpm fixtures:build --json data/research
 *   pnpm fixtures:build --csv data/work/<extraction-dir>
 *
 * `--json` reads research exports named `<table>.json` (arrays of objects with
 * mdb-export's default `MM/DD/YY HH:MM:SS` dates, converted here to the ISO form
 * the extraction writes). `--csv` reads a Task 3 extraction directory of projected
 * CSVs. Optional: `--out <dir>` (default `fixtures`).
 *
 * Writes:
 * - `<out>/ntsb/<table>.csv`: the rows of the events in `FIXTURE_CASES`, projected
 *   to the `TABLE_SPECS` allowlist (no owner/operator fields, no `lchg_userid`), in
 *   source order. Tables absent from the source (the research JSON has no engines,
 *   ct_seqevt or dictionary export) are skipped and reported.
 * - `<out>/ntsb-malformed/{duplicate-key,invalid-values}/<table>.csv`: small
 *   synthetic sets defined below.
 *
 * The fixture rows are public NTSB records (US government works). Large source
 * files stay in the ignored `data/` directory.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from '../worker/ingest/tables.js';

/** Fixture events by public case number, with the reason each is included. */
const FIXTURE_CASES: Readonly<Record<string, string>> = {
  DFW08TA066: 'seed case: maintenance-related causal fault',
  MIA08LA156: 'seed case: defect without an established causal link',
  DEN08LA103: 'seed case: undetermined cause, negative examination',
  NYC08LA106: 'seed case: fuel-pump failure contributed',
  SEA08LA057: 'two aircraft with different defining phases; identical factual text',
  DCA25MA108: 'two aircraft with duplicated analysis and cause narratives',
  CEN24FA064: 'HTML probable cause',
  ERA24LA303: 'HTML probable cause with a word split across spans',
  WPR26LA114: 'HTML probable cause with a leading <br />',
  CEN19FA024: 'plain factual narrative with a stray NBSP span',
  CEN20LA361: 'analysis with an &nbsp; entity and no tags',
  ENG08WA029: 'non-US (PE), status B, cause is only <br /><br />',
  CEN23LA137: 'status P',
  CEN22LA442: 'blank status, phase 990',
  ENG10WA034: 'US status B without probable-cause text',
};

const PER_EVENT_TABLES: readonly TableName[] = [
  'events', 'aircraft', 'engines', 'narratives', 'findings', 'events_sequence', 'ntsb_admin',
];

/** Columns that hold mdb-export date/time values. */
const DATE_COLUMNS: Readonly<Partial<Record<TableName, readonly string[]>>> = {
  events: ['ev_date', 'lchg_date'],
  aircraft: ['date_last_insp'],
  narratives: ['lchg_date'],
  findings: ['lchg_date'],
  events_sequence: ['lchg_date'],
  ntsb_admin: ['approval_date', 'lchg_date'],
};

type Row = Record<string, string>;

const US_DATE = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/** Two-digit years up to this value are 20xx. The archive starts in 2008; older values are inspection dates. */
const TWO_DIGIT_YEAR_PIVOT = 30;

function isoFromUsDate(value: string, where: string): string {
  if (value === '') return '';
  const m = US_DATE.exec(value);
  if (!m) throw new Error(`${where}: unexpected date format`);
  const [, mo, d, yy, h, mi, s] = m;
  const year = Number(yy) <= TWO_DIGIT_YEAR_PIVOT ? 2000 + Number(yy) : 1900 + Number(yy);
  return `${year}-${mo}-${d}T${h}:${mi}:${s}`;
}

function project(table: TableName, row: Row, convertDates: boolean): Row {
  const out: Row = {};
  for (const column of TABLE_SPECS[table].columns) {
    const value = row[column];
    if (typeof value !== 'string') throw new Error(`${table}: source row lacks column "${column}"`);
    out[column] = convertDates && DATE_COLUMNS[table]?.includes(column) ? isoFromUsDate(value, `${table}.${column}`) : value;
  }
  return out;
}

function writeTable(dir: string, table: TableName, rows: readonly Row[]): void {
  mkdirSync(dir, { recursive: true });
  const columns = [...TABLE_SPECS[table].columns];
  const csv = stringify(
    [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))],
    { record_delimiter: 'unix' },
  );
  writeFileSync(join(dir, `${table}.csv`), csv);
}

async function readCsv(file: string): Promise<Row[]> {
  const rows: Row[] = [];
  await pipeline(createReadStream(file), parse({ bom: true, columns: true }), async function (source: AsyncIterable<Row>) {
    for await (const r of source) rows.push(r);
  });
  return rows;
}

async function loadSource(kind: 'json' | 'csv', dir: string, table: TableName): Promise<Row[] | null> {
  const file = join(dir, `${table}.${kind}`);
  if (!existsSync(file)) return null;
  if (kind === 'csv') return readCsv(file);
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${file}: expected a JSON array`);
  return data as Row[];
}

async function buildRealFixtures(kind: 'json' | 'csv', sourceDir: string, outDir: string): Promise<void> {
  const events = await loadSource(kind, sourceDir, 'events');
  if (!events) throw new Error(`events.${kind} not found in the source directory`);
  const wanted = new Set(Object.keys(FIXTURE_CASES));
  const evIds = new Set<string>();
  for (const e of events) if (wanted.has(e.ntsb_no ?? '')) evIds.add(e.ev_id ?? '');
  const found = new Set(events.filter((e) => evIds.has(e.ev_id ?? '')).map((e) => e.ntsb_no));
  const missing = [...wanted].filter((no) => !found.has(no));
  if (missing.length > 0) throw new Error(`fixture events not in source: ${missing.join(', ')}`);

  for (const table of PER_EVENT_TABLES) {
    const rows = table === 'events' ? events : await loadSource(kind, sourceDir, table);
    if (!rows) {
      console.log(`${table}: not in source, skipped`);
      continue;
    }
    const selected = rows.filter((r) => evIds.has(r.ev_id ?? '')).map((r) => project(table, r, kind === 'json'));
    writeTable(join(outDir, 'ntsb'), table, selected);
    console.log(`${table}: ${selected.length} rows`);
  }
}

/** A synthetic row: every allowlisted column blank, then the given values. */
function synthetic(table: TableName, values: Row): Row {
  const row: Row = {};
  for (const c of TABLE_SPECS[table].columns) row[c] = '';
  return { ...row, ...values };
}

const SYNTHETIC_NOTE = 'Synthetic narrative for a malformed-row test; not an NTSB record.';

function syntheticEvent(evId: string, extra: Row = {}): Row {
  return synthetic('events', {
    ev_id: evId, ntsb_no: evId, ev_type: 'ACC', ev_date: '2008-01-15T00:00:00', ev_country: 'USA',
    ev_year: '2008', ev_month: '1', ...extra,
  });
}

const SYNTHETIC_SETS: Readonly<Record<string, Partial<Record<TableName, Row[]>>>> = {
  'duplicate-key': {
    events: [syntheticEvent('SYN00DUP01')],
    aircraft: [synthetic('aircraft', { ev_id: 'SYN00DUP01', aircraft_key: '1', ntsb_no: 'SYN00DUP01', acft_category: 'AIR' })],
    narratives: [synthetic('narratives', { ev_id: 'SYN00DUP01', aircraft_key: '1', narr_cause: SYNTHETIC_NOTE })],
    findings: [
      synthetic('findings', { ev_id: 'SYN00DUP01', aircraft_key: '1', finding_no: '1', cm_inpc: 'T' }),
      synthetic('findings', { ev_id: 'SYN00DUP01', aircraft_key: '1', finding_no: '2', cm_inpc: 'T' }),
      synthetic('findings', { ev_id: 'SYN00DUP01', aircraft_key: '1', finding_no: '2', cm_inpc: 'F' }),
    ],
    events_sequence: [],
    ntsb_admin: [synthetic('ntsb_admin', { ev_id: 'SYN00DUP01', rec_stat: 'B' })],
  },
  'invalid-values': {
    events: [
      syntheticEvent('SYN00BAD01', { dec_latitude: '123.4', dec_longitude: '-80.1' }),
      syntheticEvent('SYN00BAD02', { ev_date: '2008-02-30T00:00:00' }),
    ],
    aircraft: [
      synthetic('aircraft', { ev_id: 'SYN00BAD01', aircraft_key: '1', ntsb_no: 'SYN00BAD01', afm_hrs_since: 'U' }),
      synthetic('aircraft', { ev_id: 'SYN00BAD02', aircraft_key: '1', ntsb_no: 'SYN00BAD02' }),
    ],
    narratives: [synthetic('narratives', { ev_id: 'SYN00BAD01', aircraft_key: '1', narr_cause: SYNTHETIC_NOTE })],
    findings: [
      synthetic('findings', { ev_id: 'SYN00BAD01', aircraft_key: '1', finding_no: '1', cm_inpc: 'X' }),
      synthetic('findings', { ev_id: 'SYN00BAD02', aircraft_key: '2', finding_no: '1', cm_inpc: 'T' }),
    ],
    events_sequence: [
      synthetic('events_sequence', {
        ev_id: 'SYN00BAD01', aircraft_key: '1', occurrence_no: '1', phase_no: '450', eventsoe_no: '342',
        occurrence_code: '450342', defining_ev: 'Y',
      }),
    ],
    ntsb_admin: [
      synthetic('ntsb_admin', { ev_id: 'SYN00BAD01', rec_stat: 'B' }),
      synthetic('ntsb_admin', { ev_id: 'SYN00BAD02', rec_stat: 'P' }),
    ],
  },
};

function buildSyntheticFixtures(outDir: string): void {
  for (const [name, tables] of Object.entries(SYNTHETIC_SETS)) {
    for (const table of TABLE_NAMES) {
      const rows = tables[table];
      if (rows) writeTable(join(outDir, 'ntsb-malformed', name), table, rows);
    }
    console.log(`ntsb-malformed/${name}: written`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { json: { type: 'string' }, csv: { type: 'string' }, out: { type: 'string', default: 'fixtures' } },
    strict: true,
  });
  if (Boolean(values.json) === Boolean(values.csv)) {
    throw new Error('usage: build-fixtures (--json <research dir> | --csv <extraction dir>) [--out <dir>]');
  }
  const outDir = resolve(values.out);
  if (values.json) await buildRealFixtures('json', resolve(values.json), outDir);
  else if (values.csv) await buildRealFixtures('csv', resolve(values.csv), outDir);
  buildSyntheticFixtures(outDir);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
