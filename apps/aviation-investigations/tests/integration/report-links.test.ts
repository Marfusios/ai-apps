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
    expect(rows.every((x) => x.source === 'seed' && x.retrievedAt.toISOString().startsWith('2026-10-16'))).toBe(true);
    expect((await importSeedLinks(ingest, SEED)).alreadyPresent).toBe(4);
  });

  it('unknown export layout throws listing found headers', async () => {
    const p = file('bad.csv', 'Foo,Bar\n1,2\n');
    await expect(importAviationSearchExport(ingest, p)).rejects.toThrow(/found fields: Foo, Bar/);
  });

  it('a CAROL-URL-column layout extracts IDs and keeps several reports per case', async () => {
    const u = (id: string): string => `https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/${id}/pdf`;
    const p = file('url.csv', `NTSB Number,Report URL\nDFW08TA066,${u('67493')}\nDFW08TA066,${u('70000')}\nMIA08LA156,${u('68586')}\n`);
    const r = await importAviationSearchExport(ingest, p);
    expect(r).toMatchObject({ matched: 3, inserted: 3, unmatched: [], invalid: [] });
    const rows = await app.select().from(reportLinks);
    expect(rows.filter((x) => x.ntsbNo === 'DFW08TA066').map((x) => x.reportId).sort()).toEqual(['67493', '70000']);
    expect(rows[0]?.source).toBe('aviation_search_export');
  });

  it('reports an unmatched ntsb_no and a date mismatch, and flags invalid ids', async () => {
    const p = file('j.json', JSON.stringify([
      { 'NTSB No': 'ZZZ99XX999', 'Report ID': '1' },
      { 'NTSB No': 'DFW08TA066', 'Report ID': '67493', 'Event Date': '1999-01-01' },
      { 'NTSB No': 'DFW08TA066', 'Report ID': 'nope' },
    ]));
    const r = await importAviationSearchExport(ingest, p);
    expect(r.matched).toBe(0);
    expect(r.unmatched.map((u) => u.reason)).toEqual(['unknown_case', 'date_mismatch']);
    expect(r.invalid).toHaveLength(1);
  });
});
