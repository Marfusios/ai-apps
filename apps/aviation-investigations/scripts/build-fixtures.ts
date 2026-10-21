/**
 * Build the committed NTSB test fixtures (run manually; tests only read the output).
 *
 *   pnpm fixtures:build --from data/work/<extraction-dir> [--out fixtures]
 *
 * `--from` is a Task 3 extraction directory of projected CSVs (allowlisted columns,
 * ISO dates, narratives with their original CRLF). It is read with the same guarded
 * reader the loader uses (`readProjectedTables`).
 *
 * Writes:
 * - `<out>/ntsb/<table>.csv` for events, aircraft, engines, narratives, findings,
 *   events_sequence and ntsb_admin: the rows of the events in `FIXTURE_CASES`, every
 *   value byte-for-byte as extracted, in source order, `TABLE_SPECS` columns only
 *   (no owner/operator fields, no `lchg_userid`). The output is read back and
 *   compared with the selected source rows before the script reports success.
 * - `<out>/ntsb-malformed/{duplicate-key,invalid-values}/<table>.csv`: small
 *   synthetic sets defined below.
 *
 * The fixture rows are public NTSB records (US government works). The extraction
 * itself stays in the ignored `data/` directory. `fixtures/.gitattributes` keeps Git
 * from rewriting the CRLF inside quoted narrative fields.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'csv-stringify/sync';
import { readProjectedTables } from '../worker/ingest/normalize.js';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from '../worker/ingest/tables.js';

/** Fixture events by public case number, with the reason each is included. */
const FIXTURE_CASES: Readonly<Record<string, string>> = {
  DFW08TA066: 'seed case: maintenance-related causal fault',
  MIA08LA156: 'seed case: defect without an established causal link',
  DEN08LA103: 'seed case: undetermined cause, negative examination',
  NYC08LA106: 'seed case: fuel-pump failure contributed',
  SEA08LA057: 'two aircraft, different defining phases; causes differ only in trailing CRLFs',
  DCA25MA108: 'two aircraft with identical analysis and cause narratives',
  WPR15FA010: 'two aircraft; the cause names the Savannah pilot and is recorded on the Cessna row too',
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

type Row = Record<string, string>;

function writeTable(dir: string, table: TableName, rows: readonly Readonly<Row>[]): void {
  mkdirSync(dir, { recursive: true });
  const columns = [...TABLE_SPECS[table].columns];
  const csv = stringify(
    [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))],
    { record_delimiter: 'unix' },
  );
  writeFileSync(join(dir, `${table}.csv`), csv);
}

async function buildRealFixtures(sourceDir: string, outDir: string): Promise<void> {
  const source = (await readProjectedTables(sourceDir)) as unknown as Partial<Record<TableName, readonly Readonly<Row>[]>>;
  const events = source.events ?? [];
  const wanted = new Set(Object.keys(FIXTURE_CASES));
  const selectedEvents = events.filter((e) => wanted.has(e.ntsb_no ?? ''));
  const missing = [...wanted].filter((no) => !selectedEvents.some((e) => e.ntsb_no === no));
  if (missing.length > 0) throw new Error(`fixture events not in source: ${missing.join(', ')}`);
  const evIds = new Set(selectedEvents.map((e) => e.ev_id ?? ''));

  const written: Partial<Record<TableName, readonly Readonly<Row>[]>> = {};
  for (const table of PER_EVENT_TABLES) {
    const rows = source[table];
    if (!rows) throw new Error(`${table}.csv not in the extraction directory`);
    const selected = rows.filter((r) => evIds.has(r.ev_id ?? ''));
    writeTable(join(outDir, 'ntsb'), table, selected);
    written[table] = selected;
    console.log(`${table}: ${selected.length} rows`);
  }

  // Read the fixtures back with the loader's reader and require exact equality.
  const reread = (await readProjectedTables(join(outDir, 'ntsb'))) as unknown as Partial<Record<TableName, readonly Readonly<Row>[]>>;
  for (const table of PER_EVENT_TABLES) {
    if (JSON.stringify(reread[table]) !== JSON.stringify(written[table])) {
      throw new Error(`${table}: fixture does not read back identically`);
    }
  }
  console.log('fixtures read back identically');
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
    options: { from: { type: 'string' }, out: { type: 'string', default: 'fixtures' } },
    strict: true,
  });
  if (!values.from) throw new Error('usage: build-fixtures --from <extraction dir> [--out <dir>]');
  const outDir = resolve(values.out);
  await buildRealFixtures(resolve(values.from), outDir);
  buildSyntheticFixtures(outDir);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
