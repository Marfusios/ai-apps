/**
 * Build the committed interface fixtures (run manually; tests and the mock API only
 * read the output).
 *
 *   pnpm fixtures:build-ui --from data/work/<extraction-dir> [--out fixtures/ntsb-ui]
 *
 * `fixtures/ntsb` (scripts/build-fixtures.ts) covers the data edge cases but has no
 * carburetor-icing or traffic-pattern stall records, which the interface's examples
 * and end-to-end tests search for. This set adds a few, chosen for a spread of
 * phases, outcomes, conditions, categories and completion statuses. Rows are public
 * NTSB records (US government works) copied byte-for-byte from a Task 3 extraction
 * directory, `TABLE_SPECS` columns only, and read back for exact equality.
 *
 * The mock API (`scripts/build-mock-api.ts`) normalizes both fixture sets together.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'csv-stringify/sync';
import { readProjectedTables } from '../worker/ingest/normalize.js';
import { TABLE_SPECS, type TableName } from '../worker/ingest/tables.js';

/** Interface fixture events by public case number, with the reason each is included. */
const UI_FIXTURE_CASES: Readonly<Record<string, string>> = {
  ERA25LA016: 'carburetor icing in the probable cause; initial climb; no injuries',
  WPR24FA190: 'carburetor icing in the probable cause; initial climb; fatal',
  WPR24LA154: 'cause says "carburetor ice": matches "icing" only through stemming',
  CEN12LA175: 'carburetor icing in the probable cause; IMC',
  CEN13FA030: 'carburetor icing in the probable cause; approach at night; fatal',
  CEN19FA009: 'carburetor icing in the probable cause; helicopter; fatal',
  ANC15LA005: 'carburetor icing in the probable cause; VFR pattern final; Alaska',
  CEN25LA300: 'status P, factual narrative only, mentions carburetor icing',
  CEN26LA258: 'status P, factual narrative only, mentions carburetor icing',
  CEN09FA115: 'stall/spin on the base leg; fatal',
  CEN09CA566: 'loss of control on final in the traffic pattern',
};

const PER_EVENT_TABLES: readonly TableName[] = [
  'events', 'aircraft', 'engines', 'narratives', 'findings', 'events_sequence', 'ntsb_admin',
];

type Row = Record<string, string>;

function writeTable(dir: string, table: TableName, rows: readonly Readonly<Row>[]): void {
  mkdirSync(dir, { recursive: true });
  const columns = [...TABLE_SPECS[table].columns];
  const csv = stringify([columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))], { record_delimiter: 'unix' });
  writeFileSync(join(dir, `${table}.csv`), csv);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, out: { type: 'string', default: 'fixtures/ntsb-ui' } },
    strict: true,
  });
  if (!values.from) throw new Error('usage: build-ui-fixtures --from <extraction dir> [--out <dir>]');
  const outDir = resolve(values.out);
  const source = (await readProjectedTables(resolve(values.from))) as unknown as Partial<
    Record<TableName, readonly Readonly<Row>[]>
  >;
  const wanted = new Set(Object.keys(UI_FIXTURE_CASES));
  const events = (source.events ?? []).filter((e) => wanted.has(e.ntsb_no ?? ''));
  const missing = [...wanted].filter((no) => !events.some((e) => e.ntsb_no === no));
  if (missing.length > 0) throw new Error(`fixture events not in source: ${missing.join(', ')}`);
  const evIds = new Set(events.map((e) => e.ev_id ?? ''));

  const written: Partial<Record<TableName, readonly Readonly<Row>[]>> = {};
  for (const table of PER_EVENT_TABLES) {
    const rows = source[table];
    if (!rows) throw new Error(`${table}.csv not in the extraction directory`);
    const selected = rows.filter((r) => evIds.has(r.ev_id ?? ''));
    writeTable(outDir, table, selected);
    written[table] = selected;
    console.log(`${table}: ${selected.length} rows`);
  }

  const reread = (await readProjectedTables(outDir)) as unknown as Partial<Record<TableName, readonly Readonly<Row>[]>>;
  for (const table of PER_EVENT_TABLES) {
    if (JSON.stringify(reread[table]) !== JSON.stringify(written[table])) {
      throw new Error(`${table}: fixture does not read back identically`);
    }
  }
  console.log('fixtures read back identically');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
