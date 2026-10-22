/**
 * Builds the mock API responses from the committed NTSB fixtures. Everything is
 * deterministic: the same fixtures give byte-identical files, which a unit test
 * checks against the committed `web/mock/*.json`.
 */
import { join } from 'node:path';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { SearchRequestSchema } from '../../shared/contracts/search.js';
import { searchCorpus, type MockCorpus } from '../../web/mock/engine.js';
import {
  normalizeCorpus,
  readProjectedTables,
  type NormalizeResult,
  type RawTables,
} from '../../worker/ingest/normalize.js';
import { TABLE_NAMES, type TableName } from '../../worker/ingest/tables.js';
import { datasetOf, toCaseDetail, toConfig, toDashboard, toMockDoc } from './project.js';

/** Fixture sets merged into the mock corpus (event ids do not overlap). */
export const MOCK_FIXTURE_DIRS = ['fixtures/ntsb', 'fixtures/ntsb-ui'] as const;

/** Date of the NTSB snapshot the fixtures were taken from (the 2026-10-16 avall.zip). */
export const MOCK_SNAPSHOT_DATE = '2026-10-16';

/** Sample searches written out as complete request/response pairs. */
export const SAMPLE_SEARCHES: Readonly<Record<string, Record<string, string>>> = {
  default: {},
  'carburetor-icing': { q: 'carburetor icing' },
  'carburetor-icing-probable-cause': { q: 'carburetor icing', mentionedIn: 'probable_cause' },
  'carburetor-icing-initial-climb': { q: 'carburetor icing', phase: 'initial_climb' },
  'midair-all-records': { q: 'midair', completion: 'any' },
  'no-results': { q: 'carburetor icing', phase: 'landing', injury: 'FATL' },
};

export async function readFixtureTables(appDir: string): Promise<RawTables> {
  const merged: Partial<Record<TableName, Record<string, string>[]>> = {};
  for (const dir of MOCK_FIXTURE_DIRS) {
    const tables = (await readProjectedTables(join(appDir, dir))) as unknown as Partial<
      Record<TableName, readonly Record<string, string>[]>
    >;
    for (const table of TABLE_NAMES) {
      const rows = tables[table];
      if (rows) (merged[table] ??= []).push(...rows);
    }
  }
  return merged as unknown as RawTables;
}

export interface MockApiFiles {
  'config.json': unknown;
  'dashboard-default.json': unknown;
  'dashboard-all.json': unknown;
  'cases.json': unknown;
  'search-index.json': unknown;
  'search-samples.json': unknown;
}

export function buildMockCorpus(result: NormalizeResult): MockCorpus {
  const dataset = datasetOf(result, MOCK_SNAPSHOT_DATE);
  const ctx = {
    dataset,
    citationTextVersion: result.citationTextVersion,
    fieldNormalizationVersion: result.fieldNormalizationVersion,
    mappingVerified: result.completionMapping.verified,
  };
  const cases: Record<string, CaseDetail> = {};
  const docs = [];
  for (const c of result.cases) {
    const detail = toCaseDetail(c, ctx);
    cases[c.ntsbNo] = detail;
    // Explore covers US events only (amendment A2); every case still has a page.
    if (c.isUs) docs.push(toMockDoc(c, detail));
  }
  return { dataset, docs, cases };
}

export async function buildMockApi(appDir: string): Promise<MockApiFiles> {
  const result = normalizeCorpus(await readFixtureTables(appDir));
  const corpus = buildMockCorpus(result);
  const samples = Object.fromEntries(
    Object.entries(SAMPLE_SEARCHES).map(([name, query]) => [
      name,
      { query, response: searchCorpus(corpus, SearchRequestSchema.parse(query)) },
    ]),
  );
  return {
    'config.json': toConfig(result, corpus.dataset),
    'dashboard-default.json': toDashboard(result, corpus.dataset, 'default'),
    'dashboard-all.json': toDashboard(result, corpus.dataset, 'all'),
    'cases.json': corpus.cases,
    'search-index.json': { dataset: corpus.dataset, docs: corpus.docs },
    'search-samples.json': samples,
  };
}

/** Stable serialization for the committed files. */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}
