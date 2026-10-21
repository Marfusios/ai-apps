/**
 * Case records built offline from the committed NTSB fixtures: normalize the
 * projected CSVs, turn each canonical case into its database rows (`caseRows`, the
 * loader's own row builder) and assemble them as `streamCaseRecords` does.
 */
import {
  assembleCaseRecords,
  type AircraftRow,
  type CaseRecord,
  type CaseRecordRows,
  type CaseRow,
  type EngineRow,
  type FindingRow,
  type SectionRow,
  type SequenceRow,
} from '../../server/db/queries/case-records.js';
import { caseRows } from '../../worker/ingest/load.js';
import { normalizeCorpus, readProjectedTables, type CanonicalCase } from '../../worker/ingest/normalize.js';
import { FIXTURES_DIR } from './extract-dir.js';

/** Rows as the loader writes them, narrowed to the selected columns (all are set by `caseRows`). */
function rowsOf(generationId: number, canonical: readonly CanonicalCase[]): CaseRecordRows {
  const all = canonical.map((c) => caseRows(generationId, c));
  return {
    cases: all.map((r) => r.case as unknown as CaseRow),
    aircraft: all.flatMap((r) => r.aircraft as unknown as AircraftRow[]),
    engines: all.flatMap((r) => r.engines as unknown as EngineRow[]),
    sections: all.flatMap((r) => r.sections as unknown as SectionRow[]),
    findings: all.flatMap((r) => r.findings as unknown as FindingRow[]),
    sequence: all.flatMap((r) => r.sequence as unknown as SequenceRow[]),
  };
}

/** Every fixture event (US and foreign) as a case record, by case number. */
export async function fixtureCaseRecords(generationId = 1): Promise<Map<string, CaseRecord>> {
  const { cases } = normalizeCorpus(await readProjectedTables(FIXTURES_DIR));
  const records = assembleCaseRecords(generationId, rowsOf(generationId, cases));
  return new Map(records.map((r) => [r.ntsbNo, r]));
}
