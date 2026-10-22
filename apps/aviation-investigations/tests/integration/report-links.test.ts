import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { reportLinks } from '../../server/db/schema/index.js';
import { importAviationSearchExport, importSeedLinks } from '../../worker/ingest/report-links.js';
import { APP_DIR, makeExtractDir, removeDir } from '../support/extract-dir.js';
import { loadVerified } from './corpus-helpers.js';
import { resetCorpus, testDb } from './helpers.js';

let ingest: Db;
let app: Db;
let dir: string;
const tmp = mkdtempSync(join(tmpdir(), 'aviation-links-test-'));
const RETRIEVED = new Date('2026-10-20T00:00:00Z');
const SEED = resolve(APP_DIR, 'fixtures/report-links-seed.json');

function file(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
}

beforeAll(async () => {
  ingest = testDb('ingest');
  app = testDb('app');
  dir = await makeExtractDir();
});
afterAll(async () => {
  await Promise.all([closeDb(ingest), closeDb(app)]);
  removeDir(dir);
  removeDir(tmp);
});
beforeEach(async () => {
  await resetCorpus();
  await loadVerified(ingest, dir, tmp);
});

describe('report-link import', () => {
  it('seed import maps four cases', async () => {
    const r = await importSeedLinks(ingest, SEED);
    expect(r).toMatchObject({ matched: 4, inserted: 4, unmatched: [] });
    const rows = await app.select().from(reportLinks);
    expect(rows.map((x) => `${x.ntsbNo}:${x.reportId}`).sort()).toEqual(['DEN08LA103:68245', 'DFW08TA066:67493', 'MIA08LA156:68586', 'NYC08LA106:67552']);
    expect(rows.every((x) => x.source === 'seed' && x.sourceLabel === 'manual verification 2026-10-16' && x.mapping === null && x.retrievedAt.toISOString().startsWith('2026-10-16'))).toBe(true);
    expect(await importSeedLinks(ingest, SEED)).toMatchObject({ inserted: 4, dateChecked: true });
    expect(await app.select().from(reportLinks)).toHaveLength(4);
  });

  it('a missing named column throws listing found headers', async () => {
    const p = file('bad.csv', 'Foo,Bar\n1,2\n');
    await expect(importAviationSearchExport(ingest, p, { mapping: { caseCol: 'Case', idCol: 'Id' }, retrievedAt: RETRIEVED })).rejects.toThrow(
      /not found.*Case, Id.*found fields: Foo, Bar/,
    );
  });

  it('a CAROL-URL column extracts IDs, keeps several reports per case and checks dates', async () => {
    const u = (id: string): string => `https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/${id}/pdf`;
    const p = file('url.csv', `case_x,link_x,day_x\nDFW08TA066,${u('67493')},2008-02-08\nDFW08TA066,${u('70000')},2008-02-08\nMIA08LA156,${u('68586')},2008-08-01\n`);
    const map = { caseCol: 'case_x', urlCol: 'link_x', dateCol: 'day_x' };
    const r = await importAviationSearchExport(ingest, p, { mapping: map, retrievedAt: RETRIEVED });
    expect(r).toMatchObject({ matched: 3, inserted: 3, unmatched: [], invalid: [], dateChecked: true, dateUnchecked: 0 });
    const rows = await app.select().from(reportLinks);
    expect(rows.filter((x) => x.ntsbNo === 'DFW08TA066').map((x) => x.reportId).sort()).toEqual(['67493', '70000']);
    expect(rows[0]).toMatchObject({ source: 'aviation_search_export', mapping: map });
    expect(rows[0]?.sourceLabel).toMatch(/^aviation search export [0-9a-f]{12}$/);
    expect(rows[0]?.retrievedAt.toISOString()).toBe(RETRIEVED.toISOString());
    // Re-import replaces the rows of the same file instead of accumulating.
    const again = await importAviationSearchExport(ingest, p, { mapping: map, retrievedAt: RETRIEVED });
    expect(again.inserted).toBe(3);
    expect(await app.select().from(reportLinks)).toHaveLength(3);
  });

  it('without a date column the report says rows were not date-checked', async () => {
    const p = file('nodate.csv', 'c,i\nDFW08TA066,67493\n');
    const r = await importAviationSearchExport(ingest, p, { mapping: { caseCol: 'c', idCol: 'i' }, retrievedAt: RETRIEVED });
    expect(r).toMatchObject({ matched: 1, dateChecked: false, dateUnchecked: 1 });
  });

  it('reports an unmatched ntsb_no and a date mismatch, and flags invalid ids', async () => {
    const p = file('j.json', JSON.stringify([
      { c: 'ZZZ99XX999', i: '1', d: '2008-02-08' },
      { c: 'DFW08TA066', i: '67493', d: '1999-01-01' },
      { c: 'DFW08TA066', i: 'nope', d: '2008-02-08' },
    ]));
    const r = await importAviationSearchExport(ingest, p, { mapping: { caseCol: 'c', idCol: 'i', dateCol: 'd' }, retrievedAt: RETRIEVED });
    expect(r.matched).toBe(0);
    expect(r.unmatched.map((u) => u.reason)).toEqual(['unknown_case', 'date_mismatch']);
    expect(r.invalid).toHaveLength(1);
  });
});
