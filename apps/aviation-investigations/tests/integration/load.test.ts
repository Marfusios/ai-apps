import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { getActiveManifest, listGenerations, publishManifest, pruneGenerations } from '../../server/db/generations.js';
import {
  GENERATION_TABLES,
  caseSections,
  cases,
  datasetGenerations,
  ingestionRuns,
} from '../../server/db/schema/index.js';
import { ExtractDirError, loadCorpus, loadFromExtract, readExtractManifest } from '../../worker/ingest/load.js';
import { NormalizationError, normalizeCorpus, readProjectedTables } from '../../worker/ingest/normalize.js';
import { TABLE_SPECS } from '../../worker/ingest/tables.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { APP_DIR, editTable, makeExtractDir, readCsv, removeDir, writeCsv, type CsvRow } from '../support/extract-dir.js';
import { resetCorpus, testDb } from './helpers.js';

const SEED_CASES = ['DFW08TA066', 'MIA08LA156', 'DEN08LA103', 'NYC08LA106'];

let ingest: Db;
let app: Db;
let migrator: Db;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-verify-test-'));
const tempDirs: string[] = [];

beforeAll(async () => {
  ingest = testDb('ingest');
  app = testDb('app');
  migrator = testDb('migrator');
  fixtureDir = await makeExtractDir();
});

afterAll(async () => {
  await Promise.all([closeDb(ingest), closeDb(app), closeDb(migrator)]);
  for (const d of [fixtureDir, reportDir, ...tempDirs]) removeDir(d);
});

beforeEach(async () => {
  await resetCorpus();
});

async function tempExtract(opts: Parameters<typeof makeExtractDir>[0]): Promise<string> {
  const dir = await makeExtractDir(opts);
  tempDirs.push(dir);
  return dir;
}

async function loadVerified(dir = fixtureDir): Promise<number> {
  const r = await loadFromExtract(ingest, dir);
  const v = await verifyCorpus(ingest, r.generationId, { outDir: reportDir, profile: null });
  expect(v.checks.filter((c) => !c.ok)).toEqual([]);
  expect(v.status).toBe('verified');
  return r.generationId;
}

/** Every row of one generation, as sorted JSON per table. */
async function snapshot(generationId: number): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of GENERATION_TABLES) {
    const t = table as PgTable & { generationId: typeof cases.generationId };
    const rows = await app.select().from(t).where(eq(t.generationId, generationId));
    out[getTableName(table)] = rows
      .map((r) => JSON.stringify(r))
      .sort();
  }
  return out;
}

async function count(db: Db, query: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute(query);
  return Number(Object.values(r.rows[0] ?? {})[0] ?? 0);
}

async function revisions(generationId: number): Promise<Map<string, { sha256: string; revisionId: string }>> {
  const rows = await app
    .select({ sectionId: caseSections.sectionId, sha256: caseSections.sha256, revisionId: caseSections.revisionId })
    .from(caseSections)
    .where(eq(caseSections.generationId, generationId));
  return new Map(rows.map((r) => [r.sectionId, { sha256: r.sha256, revisionId: r.revisionId }]));
}

/** SQLSTATE of a failed query (Drizzle wraps the driver error). */
async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

function evIdOf(dir: string, ntsbNo: string): string {
  const row = readCsv(join(dir, 'events.csv')).find((r) => r.ntsb_no === ntsbNo);
  if (!row?.ev_id) throw new Error(`${ntsbNo} not in fixture`);
  return row.ev_id;
}

describe('corpus load', () => {
  it('loads seed cases', async () => {
    const r = await loadFromExtract(ingest, fixtureDir);
    expect(r.generationId).toBe(1);
    expect(r.rows.cases).toBe(16);
    expect(r.stats.events).toBe(16);

    const [gen] = await app.select().from(datasetGenerations).where(eq(datasetGenerations.id, r.generationId));
    expect(gen).toMatchObject({ status: 'loading', mappingVersion: 'v1-empirical', mappingVerified: false, citationTextVersion: 'v1' });
    expect(gen?.archiveSha256).toBe(readExtractManifest(fixtureDir).archive.sha256);
    const [run] = await app.select().from(ingestionRuns).where(eq(ingestionRuns.id, r.runId));
    expect(run).toMatchObject({ status: 'succeeded', error: null, textNormalizationVersion: 'v1' });
    expect(run?.finishedAt).toBeInstanceOf(Date);

    const caseRows = await app.select().from(cases).where(eq(cases.generationId, r.generationId));
    const byNo = new Map(caseRows.map((c) => [c.ntsbNo, c]));
    for (const no of SEED_CASES) {
      expect(byNo.get(no)).toMatchObject({ isUs: true, country: 'USA', rawStatus: 'B', completionClass: 'completed', answerEligible: true });
    }
    expect(byNo.get('ENG10WA034')).toMatchObject({ isUs: true, completionClass: 'completed', hasProbableCause: false, answerEligible: false });
    expect(byNo.get('CEN23LA137')).toMatchObject({ rawStatus: 'P', completionClass: 'other_status', answerEligible: false });
    expect(byNo.get('ENG08WA029')).toMatchObject({ isUs: false, answerEligible: false });
    expect(byNo.get('DFW08TA066')?.definingPhaseGroups).toEqual(['maneuvering']);

    // Multi-aircraft narratives are event-scoped, with each source row as provenance.
    const sea = await app
      .select()
      .from(caseSections)
      .where(sql`${caseSections.generationId} = ${r.generationId} and ${caseSections.ntsbNo} = 'SEA08LA057'`);
    expect(sea.length).toBeGreaterThan(0);
    expect(sea.every((s) => s.scope === 'event' && s.aircraftKey === null)).toBe(true);
    const seaCause = sea.find((s) => s.kind === 'probable_cause');
    expect(seaCause?.sourceAircraftKeys).toEqual([1, 2]);
    const seaSources = await app.execute(
      sql`select source_aircraft_key, match, source_form from case_section_sources
          where generation_id = ${r.generationId} and section_id = ${seaCause?.sectionId ?? ''} order by 1`,
    );
    expect(seaSources.rows).toEqual([
      { source_aircraft_key: 1, match: 'exact', source_form: expect.stringMatching(/^canonical/) },
      { source_aircraft_key: 2, match: 'whitespace', source_form: 'stored' },
    ]);
    // HTML narratives keep the exported source.
    const html = await count(
      app,
      sql`select count(*) from case_section_sources where generation_id = ${r.generationId}
          and ntsb_no = 'CEN24FA064' and transformed_from_html and source_form = 'stored' and source_text like '%<%'`,
    );
    expect(html).toBeGreaterThan(0);

    const v = await verifyCorpus(ingest, r.generationId, { outDir: reportDir, profile: null });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v).toMatchObject({ ok: true, statusBefore: 'loading', status: 'verified', profile: null });
    expect(v.counts).toMatchObject({ events: 16, uniqueNtsbNo: 16, 'rows.cases': 16 });
    const [verified] = await app.select().from(datasetGenerations).where(eq(datasetGenerations.id, r.generationId));
    expect(verified?.status).toBe('verified');
    expect(verified?.verifiedAt).toBeInstanceOf(Date);

    // The report file holds aggregate counts only: no case numbers, internal ids or text.
    expect(v.reportPath).toBe(join(reportDir, `verify-gen-${r.generationId}.json`));
    const file = readFileSync(v.reportPath, 'utf8');
    expect(JSON.parse(file)).toMatchObject({ generationId: r.generationId, ok: true });
    for (const c of caseRows) {
      expect(file).not.toContain(c.ntsbNo);
      expect(file).not.toContain(c.evId);
    }
    expect(file).not.toMatch(/probable_cause\/|aircraft-\d/);
  });

  it('reload creates a new generation and leaves the earlier one intact', async () => {
    const g1 = await loadVerified();
    const before = await snapshot(g1);
    const g2 = await loadVerified();
    expect(g2).toBe(g1 + 1);
    expect(await snapshot(g1)).toEqual(before);

    const r1 = await revisions(g1);
    const r2 = await revisions(g2);
    expect(r1.size).toBeGreaterThan(0);
    expect(r2).toEqual(r1);
    const perGeneration = await app.execute(
      sql`select generation_id, count(*)::int as n from cases group by 1 order by 1`,
    );
    expect(perGeneration.rows).toEqual([
      { generation_id: String(g1), n: 16 },
      { generation_id: String(g2), n: 16 },
    ]);
  });

  it('changed narrative text gives a new sha256 and revision', async () => {
    const g1 = await loadVerified();
    const before = await snapshot(g1);
    const dfw = evIdOf(fixtureDir, 'DFW08TA066');
    const changed = await tempExtract({
      edit: (d) =>
        editTable(d, 'narratives', (rows) =>
          rows.map((r) => (r.ev_id === dfw ? { ...r, narr_cause: `${r.narr_cause} Amended.` } : r)),
        ),
    });
    const g2 = await loadVerified(changed);

    const r1 = await revisions(g1);
    const r2 = await revisions(g2);
    const id = 'DFW08TA066:probable_cause/aircraft-1';
    expect(r1.get(id)).toBeDefined();
    expect(r2.get(id)?.sha256).not.toBe(r1.get(id)?.sha256);
    expect(r2.get(id)?.revisionId).not.toBe(r1.get(id)?.revisionId);
    for (const [sectionId, rev] of r1) {
      if (sectionId !== id) expect(r2.get(sectionId)).toEqual(rev);
    }
    const revisionsByCase = await app.execute(
      sql`select a.ntsb_no from cases a join cases b on b.ntsb_no = a.ntsb_no and b.generation_id = ${g2}
          where a.generation_id = ${g1} and a.source_revision <> b.source_revision`,
    );
    expect(revisionsByCase.rows).toEqual([{ ntsb_no: 'DFW08TA066' }]);
    expect(await snapshot(g1)).toEqual(before);
  });

  it('rejects duplicate ntsb_no: the run fails and nothing is written', async () => {
    const duplicate = await tempExtract({
      edit: (d) =>
        editTable(d, 'events', (rows) => rows.map((r) => (r.ntsb_no === 'MIA08LA156' ? { ...r, ntsb_no: 'DFW08TA066' } : r))),
    });
    const err = await loadFromExtract(ingest, duplicate).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NormalizationError);
    expect((err as Error).message).toContain('duplicate ntsb_no DFW08TA066');
    const runs = await app.select().from(ingestionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });
    expect(runs[0]?.error).toContain('duplicate ntsb_no DFW08TA066');
    expect(await count(app, sql`select count(*) from dataset_generations`)).toBe(0);
  });

  it('a database failure late in the load rolls the whole generation back', async () => {
    const g1 = await loadVerified();
    await publishManifest(ingest, g1, 'aviation-test-cases-1', 'aviation-test-passages-1');
    const before = await snapshot(g1);

    const tables = await readProjectedTables(fixtureDir);
    const normalized = normalizeCorpus(tables);
    const first = normalized.cases[0];
    if (!first) throw new Error('no fixture cases');
    // Bypass normalization: the database must still refuse a duplicate case number.
    const withDuplicate = { ...normalized, cases: [...normalized.cases, { ...first, evId: 'SYNTHETIC-DUP' }] };
    const manifest = readExtractManifest(fixtureDir);
    const err = await loadCorpus(ingest, { normalized: withDuplicate, dictionary: [], manifest }, { casesPerStep: 4 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);

    const [run] = await app.select().from(ingestionRuns).where(sql`${ingestionRuns.id} <> 1`);
    expect(run).toMatchObject({ status: 'failed' });
    expect(run?.error).toContain('23505');
    expect(run?.error).toContain('cases_pk');
    expect(await count(app, sql`select count(*) from dataset_generations where id <> ${g1}`)).toBe(0);
    for (const table of GENERATION_TABLES) {
      const t = table as PgTable & { generationId: typeof cases.generationId };
      const others = await app.select({ n: sql<number>`count(*)::int` }).from(t).where(sql`${t.generationId} <> ${g1}`);
      expect(others[0]?.n).toBe(0);
    }
    expect((await getActiveManifest(app))?.generationId).toBe(g1);
    expect(await snapshot(g1)).toEqual(before);
  });

  it('rejects a load from a directory without manifest.json before writing anything', async () => {
    const incomplete = await tempExtract({ withoutManifest: true });
    await expect(loadFromExtract(ingest, incomplete)).rejects.toThrow(ExtractDirError);
    await expect(loadFromExtract(ingest, incomplete)).rejects.toThrow('manifest.json missing');
    expect(await count(app, sql`select count(*) from ingestion_runs`)).toBe(0);
    expect(await count(app, sql`select count(*) from dataset_generations`)).toBe(0);
  });

  it('fails the run when the tables disagree with the manifest row counts', async () => {
    const dir = await tempExtract({});
    // The manifest promises one more NTSB_Admin row than the file holds (byte size unchanged).
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.tables.ntsb_admin.rows += 1;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await expect(loadFromExtract(ingest, dir)).rejects.toThrow(/ntsb_admin: read 16 rows, manifest records 17/);
    const runs = await app.select().from(ingestionRuns);
    expect(runs.map((r) => r.status)).toEqual(['failed']);
    expect(await count(app, sql`select count(*) from dataset_generations`)).toBe(0);
  });
});

describe('quarantine and dictionaries', () => {
  it('stores quarantine and coded dictionary rows and accounts for every excluded source row', async () => {
    const dir = await tempExtract({
      source: join(APP_DIR, 'fixtures/ntsb-malformed/invalid-values'),
      edit: (d) => {
        const blank = (table: 'eadmspub_datadictionary' | 'ct_seqevt'): CsvRow =>
          Object.fromEntries(TABLE_SPECS[table].columns.map((c) => [c, '']));
        writeCsv(join(d, 'eadmspub_datadictionary.csv'), 'eadmspub_datadictionary', [
          { ...blank('eadmspub_datadictionary'), table: 'events', column: 'light_cond', code_iaids: 'DAYL', meaning: 'Day' },
          { ...blank('eadmspub_datadictionary'), table: 'events', column: 'ev_id', meaning: 'Event identifier' },
        ]);
        writeCsv(join(d, 'ct_seqevt.csv'), 'ct_seqevt', [{ code: '342', meaning: 'Synthetic meaning' }]);
      },
    });
    const r = await loadFromExtract(ingest, dir);
    expect(r.rows.code_dictionary).toBe(2);
    expect(r.rows.quarantine).toBeGreaterThan(0);
    const dictionary = await app.execute(
      sql`select source, table_name, column_name, code, meaning from code_dictionary where generation_id = ${r.generationId} order by entry_no`,
    );
    expect(dictionary.rows).toEqual([
      { source: 'eadmspub_datadictionary', table_name: 'events', column_name: 'light_cond', code: 'DAYL', meaning: 'Day' },
      { source: 'ct_seqevt', table_name: null, column_name: null, code: '342', meaning: 'Synthetic meaning' },
    ]);
    const reasons = await app.execute(
      sql`select reason, action, count(*)::int as n from quarantine where generation_id = ${r.generationId} and run_id = ${r.runId}
          group by 1, 2 order by 1, 2`,
    );
    expect(reasons.rows).toEqual(
      expect.arrayContaining([
        { reason: 'orphan_row', action: 'row_excluded', n: 1 },
        { reason: 'coordinate_out_of_range', action: 'value_nulled', n: 1 },
        { reason: 'invalid_date', action: 'value_nulled', n: 1 },
      ]),
    );
    const v = await verifyCorpus(ingest, r.generationId, { outDir: reportDir, profile: null });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.counts['excludedRows.findings']).toBe(1);
    expect(v.counts['rows.case_findings']).toBe(1);
  });
});

describe('roles', () => {
  it('app role can read the corpus but not write it', async () => {
    const g = await loadVerified();
    expect(await count(app, sql`select count(*) from cases where generation_id = ${g}`)).toBe(16);
    expect(await count(app, sql`select count(*) from case_sections where generation_id = ${g}`)).toBeGreaterThan(0);
    for (const statement of [
      sql`insert into cases (generation_id, ntsb_no, ev_id, is_us, completion_class, completion_mapping_version,
            has_probable_cause, completed_with_cause, answer_eligible, defining_phase_groups, sequence_phase_groups, source_revision)
          values (${g}, 'X', 'X', false, 'other_status', 'v', false, false, false, '{}', '{}', ${'a'.repeat(64)})`,
      sql`update cases set city = 'X' where generation_id = ${g}`,
      sql`delete from case_sections where generation_id = ${g}`,
      sql`update dataset_manifests set active = false`,
      sql`update dataset_generations set status = 'failed'`,
      sql`insert into ingestion_runs (status, mapping_version, text_normalization_version, field_normalization_version)
          values ('running', 'v', 'v', 'v')`,
      sql`truncate case_findings`,
    ]) {
      expect(await sqlState(app.execute(statement))).toBe('42501');
    }
  });

  it('ingest role can insert and delete corpus rows but never update them', async () => {
    const g = await loadVerified();
    for (const statement of [
      sql`update case_sections set text = 'tampered' where generation_id = ${g}`,
      sql`update cases set answer_eligible = true where generation_id = ${g}`,
      sql`update case_section_sources set source_text = null where generation_id = ${g}`,
    ]) {
      expect(await sqlState(ingest.execute(statement))).toBe('42501');
    }
  });
});

describe('verification', () => {
  it('fails a generation whose stored text no longer matches its hash', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    // Only the schema owner can tamper with stored rows.
    await migrator.execute(
      sql`update case_sections set text = text || ' tampered' where generation_id = ${g} and section_id = 'DFW08TA066:probable_cause/aircraft-1'`,
    );
    const v = await verifyCorpus(ingest, g, { outDir: reportDir, profile: null });
    expect(v.ok).toBe(false);
    expect(v.status).toBe('failed');
    expect(v.checks.find((c) => c.name === 'section_sha256_matches_text')).toMatchObject({ ok: false, failures: 1 });
    await expect(publishManifest(ingest, g, 'aviation-test-cases', 'aviation-test-passages')).rejects.toThrow(/is failed/);
  });

  it('fails a generation with a missing child row', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    await migrator.execute(
      sql`delete from case_findings where generation_id = ${g} and (ntsb_no, aircraft_key, finding_no) =
          (select ntsb_no, aircraft_key, finding_no from case_findings where generation_id = ${g} order by 1, 2, 3 limit 1)`,
    );
    const v = await verifyCorpus(ingest, g, { outDir: reportDir, profile: null });
    expect(v.ok).toBe(false);
    expect(v.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['counts_match_normalization_and_source']);
    const file = JSON.parse(readFileSync(v.reportPath, 'utf8'));
    expect(file.countMismatches).toEqual(['rows.case_findings', 'source.findings']);
  });

  it('fails a generation whose completion class disagrees with its raw status', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    await migrator.execute(sql`update cases set raw_status = 'F' where generation_id = ${g} and ntsb_no = 'DFW08TA066'`);
    const v = await verifyCorpus(ingest, g, { outDir: reportDir, profile: null });
    expect(v.checks.filter((c) => !c.ok)).toEqual([{ name: 'completion_class_matches_mapping', failures: 1, ok: false }]);
    expect(v.status).toBe('failed');
  });

  it('checks a snapshot profile for the generation archive', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    const archiveSha256 = readExtractManifest(fixtureDir).archive.sha256;
    const v = await verifyCorpus(ingest, g, {
      outDir: reportDir,
      profile: { name: 'fixture', archiveSha256, expected: { events: 16, uniqueNtsbNo: 16, answerEligibleUs: 99 } },
    });
    expect(v.ok).toBe(false);
    expect(v.profile).toEqual({
      name: 'fixture',
      ok: false,
      mismatches: [{ measure: 'answerEligibleUs', expected: 99, actual: v.counts.answerEligibleUs }],
    });
    await expect(
      verifyCorpus(ingest, g, { outDir: reportDir, profile: { name: 'x', archiveSha256: 'f'.repeat(64), expected: {} } }),
    ).rejects.toThrow(/different archive/);
  });
});

describe('manifests and pruning', () => {
  it('publishes atomically and reads the active manifest', async () => {
    expect(await getActiveManifest(app)).toBeNull();
    const g1 = await loadVerified();
    const g2 = await loadVerified();

    const a1 = await publishManifest(ingest, g1, 'aviation-test-cases-1', 'aviation-test-passages-1');
    expect(a1).toMatchObject({ generationId: g1, casesIndex: 'aviation-test-cases-1', passagesIndex: 'aviation-test-passages-1' });
    expect(await getActiveManifest(app)).toMatchObject({ generationId: g1, mappingVersion: 'v1-empirical', citationTextVersion: 'v1' });

    await publishManifest(ingest, g2, 'aviation-test-cases-2', 'aviation-test-passages-2');
    const active = await getActiveManifest(app);
    expect(active).toMatchObject({ generationId: g2, casesIndex: 'aviation-test-cases-2' });
    const statuses = await listGenerations(app);
    expect(statuses.map((g) => [g.id, g.status, g.active])).toEqual([
      [g1, 'retired', false],
      [g2, 'published', true],
    ]);

    // At most one active manifest, even when written directly.
    expect(await sqlState(ingest.execute(sql`update dataset_manifests set active = true`))).toBe('23505');
    // Only verified generations, and only valid index names.
    const { generationId: g3 } = await loadFromExtract(ingest, fixtureDir);
    await expect(publishManifest(ingest, g3, 'aviation-test-cases-3', 'aviation-test-passages-3')).rejects.toThrow(/is loading/);
    await expect(publishManifest(ingest, g2, 'Bad/Name', 'aviation-test-passages-2')).rejects.toThrow(/invalid index name/);
    await expect(publishManifest(ingest, 999, 'a', 'b')).rejects.toThrow(/does not exist/);
    expect((await getActiveManifest(app))?.generationId).toBe(g2);

    // Rolling back to the earlier generation.
    await publishManifest(ingest, g1, 'aviation-test-cases-1', 'aviation-test-passages-1');
    expect((await getActiveManifest(app))?.generationId).toBe(g1);
    expect(await count(app, sql`select count(*) from dataset_manifests where active`)).toBe(1);
  });

  it('prunes all but the last two published generations and failed ones, never the active one', async () => {
    // Before anything is published only failed generations go.
    const g1 = await loadVerified();
    const { generationId: gFailed0 } = await loadFromExtract(ingest, fixtureDir);
    await ingest.update(datasetGenerations).set({ status: 'failed' }).where(eq(datasetGenerations.id, gFailed0));
    expect(await pruneGenerations(ingest)).toEqual({ kept: [], deleted: [gFailed0] });

    const g2 = await loadVerified();
    const g3 = await loadVerified();
    const g4 = await loadVerified();
    for (const g of [g1, g2, g3]) await publishManifest(ingest, g, `aviation-test-cases-${g}`, `aviation-test-passages-${g}`);
    const { generationId: gFailed } = await loadFromExtract(ingest, fixtureDir);
    await ingest.update(datasetGenerations).set({ status: 'failed' }).where(eq(datasetGenerations.id, gFailed));
    const { generationId: gPending } = await loadFromExtract(ingest, fixtureDir);
    const keptBefore = await snapshot(g2);

    // Active g3, previous g2. g1 is older than both; g4 (verified, never published) is newer
    // than g2 and stays, as does gPending (loaded, awaiting verification).
    const report = await pruneGenerations(ingest, 2);
    expect(report).toEqual({ kept: [g3, g2], deleted: [g1, gFailed] });
    const remaining = (await listGenerations(app)).map((g) => [g.id, g.status]);
    expect(remaining).toEqual([
      [g2, 'retired'],
      [g3, 'published'],
      [g4, 'verified'],
      [gPending, 'loading'],
    ]);
    for (const table of GENERATION_TABLES) {
      const t = table as PgTable & { generationId: typeof cases.generationId };
      const rows = await app
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(sql`${t.generationId} in (${g1}, ${gFailed})`);
      expect(rows[0]?.n).toBe(0);
    }
    expect(await snapshot(g2)).toEqual(keptBefore);
    expect((await getActiveManifest(app))?.generationId).toBe(g3);

    // Roll back to g2, then publish g4: the last two published are g4 (active) and g2.
    await publishManifest(ingest, g2, 'aviation-test-cases-2b', 'aviation-test-passages-2b');
    await publishManifest(ingest, g4, 'aviation-test-cases-4', 'aviation-test-passages-4');
    expect(await pruneGenerations(ingest, 2)).toEqual({ kept: [g4, g2], deleted: [] });
    // keep = 1 leaves only the active generation and anything newer.
    expect(await pruneGenerations(ingest, 1)).toEqual({ kept: [g4], deleted: [g2, g3] });
    expect((await listGenerations(app)).map((g) => g.id)).toEqual([g4, gPending]);
    expect((await getActiveManifest(app))?.generationId).toBe(g4);
    await expect(pruneGenerations(ingest, 0)).rejects.toThrow(/positive integer/);
    expect(await count(app, sql`select count(*) from dataset_manifests`)).toBe(1);
  });
});
