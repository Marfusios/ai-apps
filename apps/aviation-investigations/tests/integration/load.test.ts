import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { VERIFIER_VERSION, getActiveManifest, publishManifest } from '../../server/db/generations.js';
import { GENERATION_TABLES, caseSections, cases, datasetGenerations, ingestionRuns } from '../../server/db/schema/index.js';
import { ExtractDirError, loadCorpus, loadFromExtract, readExtractManifest, sectionRevisionId } from '../../worker/ingest/load.js';
import { NormalizationError, normalizeCorpus, readProjectedTables } from '../../worker/ingest/normalize.js';
import { TABLE_SPECS } from '../../worker/ingest/tables.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { APP_DIR, editTable, makeExtractDir, removeDir, writeCsv, type CsvRow } from '../support/extract-dir.js';
import { count, evIdOf, loadVerified, revisions, snapshot, tamper } from './corpus-helpers.js';
import { resetCorpus, testDb } from './helpers.js';

const SEED_CASES = ['DFW08TA066', 'MIA08LA156', 'DEN08LA103', 'NYC08LA106'];
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

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

const verify = (g: number) => verifyCorpus(ingest, g, { outDir: reportDir, profile: null });
const failedChecks = (v: Awaited<ReturnType<typeof verify>>) => v.checks.filter((c) => !c.ok).map((c) => c.name);

describe('corpus load', () => {
  it('loads seed cases', async () => {
    const r = await loadFromExtract(ingest, fixtureDir);
    expect(r.generationId).toBe(1);
    expect(r.rows.cases).toBe(16);
    expect(r.stats.events).toBe(16);

    const [gen] = await ingest.select().from(datasetGenerations).where(eq(datasetGenerations.id, r.generationId));
    expect(gen).toMatchObject({
      status: 'loaded',
      verificationStatus: null,
      mappingVersion: 'v1-empirical',
      mappingVerified: false,
      citationTextVersion: 'v1',
    });
    expect(gen?.sealedAt).toBeInstanceOf(Date);
    expect(gen?.archiveSha256).toBe(readExtractManifest(fixtureDir).archive.sha256);
    const [run] = await ingest.select().from(ingestionRuns).where(eq(ingestionRuns.id, r.runId));
    expect(run).toMatchObject({ status: 'succeeded', error: null, textNormalizationVersion: 'v1' });
    expect(run?.counts).toMatchObject({ generationId: r.generationId, rows: { cases: 16 } });
    expect(run?.finishedAt).toBeInstanceOf(Date);

    const caseRows = await ingest.select().from(cases).where(eq(cases.generationId, r.generationId));
    const byNo = new Map(caseRows.map((c) => [c.ntsbNo, c]));
    for (const no of SEED_CASES) {
      expect(byNo.get(no)).toMatchObject({ isUs: true, country: 'USA', rawStatus: 'B', completionClass: 'completed', answerEligible: true });
    }
    expect(byNo.get('ENG10WA034')).toMatchObject({ isUs: true, completionClass: 'completed', hasProbableCause: false, answerEligible: false });
    expect(byNo.get('CEN23LA137')).toMatchObject({ rawStatus: 'P', completionClass: 'other_status', answerEligible: false });
    expect(byNo.get('ENG08WA029')).toMatchObject({ isUs: false, answerEligible: false });
    expect(byNo.get('DFW08TA066')?.definingPhaseGroups).toEqual(['maneuvering']);

    // Multi-aircraft narratives are event-scoped, with each source row as provenance.
    const sea = await ingest
      .select()
      .from(caseSections)
      .where(sql`${caseSections.generationId} = ${r.generationId} and ${caseSections.ntsbNo} = 'SEA08LA057'`);
    expect(sea.length).toBeGreaterThan(0);
    expect(sea.every((s) => s.scope === 'event' && s.aircraftKey === null)).toBe(true);
    const seaCause = sea.find((s) => s.kind === 'probable_cause');
    expect(seaCause?.sourceAircraftKeys).toEqual([1, 2]);
    const seaSources = await ingest.execute(
      sql`select source_aircraft_key, match, source_form from case_section_sources
          where generation_id = ${r.generationId} and section_id = ${seaCause?.sectionId ?? ''} order by 1`,
    );
    expect(seaSources.rows).toEqual([
      { source_aircraft_key: 1, match: 'exact', source_form: expect.stringMatching(/^canonical/) },
      { source_aircraft_key: 2, match: 'whitespace', source_form: 'stored' },
    ]);
    // HTML narratives keep the exported source.
    const html = await count(
      ingest,
      sql`select count(*) from case_section_sources where generation_id = ${r.generationId}
          and ntsb_no = 'CEN24FA064' and transformed_from_html and source_form = 'stored' and source_text like '%<%'`,
    );
    expect(html).toBeGreaterThan(0);

    const v = await verify(r.generationId);
    expect(failedChecks(v)).toEqual([]);
    expect(v).toMatchObject({
      ok: true,
      conflict: false,
      statusBefore: 'loaded',
      status: 'verified',
      verificationStatus: 'ok',
      verifierVersion: VERIFIER_VERSION,
      profile: null,
    });
    expect(v.counts).toMatchObject({ events: 16, uniqueNtsbNo: 16, 'rows.cases': 16 });
    const [verified] = await ingest.select().from(datasetGenerations).where(eq(datasetGenerations.id, r.generationId));
    expect(verified).toMatchObject({ status: 'verified', verificationStatus: 'ok', verifierVersion: VERIFIER_VERSION });
    expect(verified?.verifiedAt).toBeInstanceOf(Date);

    // The report file holds aggregate counts only, and its hash is recorded.
    expect(v.reportPath).toBe(join(reportDir, `verify-gen-${r.generationId}.json`));
    const file = readFileSync(v.reportPath, 'utf8');
    expect(sha256(file)).toBe(v.reportSha256);
    expect(verified?.verificationReportSha256).toBe(v.reportSha256);
    expect(JSON.parse(file)).toMatchObject({ generationId: r.generationId, ok: true, verifierVersion: VERIFIER_VERSION });
    for (const c of caseRows) {
      expect(file).not.toContain(c.ntsbNo);
      expect(file).not.toContain(c.evId);
    }
    expect(file).not.toMatch(/probable_cause\/|aircraft-\d/);
  });

  it('reload creates a new generation and leaves the earlier one intact', async () => {
    const g1 = await loadVerified(ingest, fixtureDir, reportDir);
    const before = await snapshot(ingest, g1);
    const g2 = await loadVerified(ingest, fixtureDir, reportDir);
    expect(g2).toBe(g1 + 1);
    expect(await snapshot(ingest, g1)).toEqual(before);

    const r1 = await revisions(ingest, g1);
    const r2 = await revisions(ingest, g2);
    expect(r1.size).toBeGreaterThan(0);
    expect(r2).toEqual(r1);
    const perGeneration = await ingest.execute(sql`select generation_id, count(*)::int as n from cases group by 1 order by 1`);
    expect(perGeneration.rows).toEqual([
      { generation_id: String(g1), n: 16 },
      { generation_id: String(g2), n: 16 },
    ]);
  });

  it('changed narrative text gives a new sha256 and revision', async () => {
    const g1 = await loadVerified(ingest, fixtureDir, reportDir);
    const before = await snapshot(ingest, g1);
    const dfw = evIdOf(fixtureDir, 'DFW08TA066');
    const changed = await tempExtract({
      edit: (d) =>
        editTable(d, 'narratives', (rows) =>
          rows.map((r) => (r.ev_id === dfw ? { ...r, narr_cause: `${r.narr_cause} Amended.` } : r)),
        ),
    });
    const g2 = await loadVerified(ingest, changed, reportDir);

    const r1 = await revisions(ingest, g1);
    const r2 = await revisions(ingest, g2);
    const id = 'DFW08TA066:probable_cause/aircraft-1';
    expect(r1.get(id)).toBeDefined();
    expect(r2.get(id)?.sha256).not.toBe(r1.get(id)?.sha256);
    expect(r2.get(id)?.revisionId).not.toBe(r1.get(id)?.revisionId);
    for (const [sectionId, rev] of r1) {
      if (sectionId !== id) expect(r2.get(sectionId)).toEqual(rev);
    }
    const revisionsByCase = await ingest.execute(
      sql`select a.ntsb_no from cases a join cases b on b.ntsb_no = a.ntsb_no and b.generation_id = ${g2}
          where a.generation_id = ${g1} and a.source_revision <> b.source_revision`,
    );
    expect(revisionsByCase.rows).toEqual([{ ntsb_no: 'DFW08TA066' }]);
    expect(await snapshot(ingest, g1)).toEqual(before);
  });

  it('rejects duplicate ntsb_no: the run fails and nothing is written', async () => {
    const duplicate = await tempExtract({
      edit: (d) =>
        editTable(d, 'events', (rows) => rows.map((r) => (r.ntsb_no === 'MIA08LA156' ? { ...r, ntsb_no: 'DFW08TA066' } : r))),
    });
    const err = await loadFromExtract(ingest, duplicate).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NormalizationError);
    expect((err as Error).message).toContain('duplicate ntsb_no DFW08TA066');
    const runs = await ingest.select().from(ingestionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });
    expect(runs[0]?.error).toContain('duplicate ntsb_no DFW08TA066');
    expect(await count(ingest, sql`select count(*) from dataset_generations`)).toBe(0);
  });

  it('a database failure late in the load rolls the whole generation back', async () => {
    const g1 = await loadVerified(ingest, fixtureDir, reportDir);
    await publishManifest(ingest, g1, 'aviation-test-cases-1', 'aviation-test-passages-1');
    const before = await snapshot(ingest, g1);

    const normalized = normalizeCorpus(await readProjectedTables(fixtureDir));
    const first = normalized.cases[0];
    if (!first) throw new Error('no fixture cases');
    // Bypass normalization: the database must still refuse a duplicate case number.
    const withDuplicate = { ...normalized, cases: [...normalized.cases, { ...first, evId: 'SYNTHETIC-DUP' }] };
    const manifest = readExtractManifest(fixtureDir);
    const err = await loadCorpus(ingest, { normalized: withDuplicate, dictionary: [], manifest }, { casesPerStep: 4 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);

    const [run] = await ingest.select().from(ingestionRuns).where(sql`${ingestionRuns.id} <> 1`);
    expect(run).toMatchObject({ status: 'failed' });
    expect(run?.error).toContain('23505');
    expect(run?.error).toContain('cases_pk');
    expect(await count(ingest, sql`select count(*) from dataset_generations where id <> ${g1}`)).toBe(0);
    for (const table of GENERATION_TABLES) {
      const t = table as PgTable & { generationId: typeof cases.generationId };
      const others = await ingest.select({ n: sql<number>`count(*)::int` }).from(t).where(sql`${t.generationId} <> ${g1}`);
      expect(others[0]?.n).toBe(0);
    }
    expect((await getActiveManifest(app))?.generationId).toBe(g1);
    expect(await snapshot(ingest, g1)).toEqual(before);
  });

  it('records success inside the generation transaction: a failure before commit leaves a failed run and no generation', async () => {
    const injected = new Error('injected failure after every insert, the run success and the seal');
    const normalized = normalizeCorpus(await readProjectedTables(fixtureDir));
    const manifest = readExtractManifest(fixtureDir);
    const err = await loadCorpus(
      ingest,
      { normalized, dictionary: [], manifest },
      {
        beforeCommit: () => {
          throw injected;
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toBe(injected);
    const runs = await ingest.select().from(ingestionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', counts: null, error: injected.message });
    expect(await count(ingest, sql`select count(*) from dataset_generations`)).toBe(0);
    expect(await count(ingest, sql`select count(*) from cases`)).toBe(0);
  });

  it('rejects a load from a directory without manifest.json before writing anything', async () => {
    const incomplete = await tempExtract({ withoutManifest: true });
    await expect(loadFromExtract(ingest, incomplete)).rejects.toThrow(ExtractDirError);
    await expect(loadFromExtract(ingest, incomplete)).rejects.toThrow('manifest.json missing');
    expect(await count(ingest, sql`select count(*) from ingestion_runs`)).toBe(0);
    expect(await count(ingest, sql`select count(*) from dataset_generations`)).toBe(0);
  });

  it('fails the run when the tables disagree with the manifest row counts', async () => {
    const dir = await tempExtract({});
    // The manifest promises one more NTSB_Admin row than the file holds (byte size unchanged).
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.tables.ntsb_admin.rows += 1;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await expect(loadFromExtract(ingest, dir)).rejects.toThrow(/ntsb_admin: read 16 rows, manifest records 17/);
    const runs = await ingest.select().from(ingestionRuns);
    expect(runs.map((r) => r.status)).toEqual(['failed']);
    expect(await count(ingest, sql`select count(*) from dataset_generations`)).toBe(0);
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
    const dictionary = await ingest.execute(
      sql`select source, table_name, column_name, code, meaning from code_dictionary where generation_id = ${r.generationId} order by entry_no`,
    );
    expect(dictionary.rows).toEqual([
      { source: 'eadmspub_datadictionary', table_name: 'events', column_name: 'light_cond', code: 'DAYL', meaning: 'Day' },
      { source: 'ct_seqevt', table_name: null, column_name: null, code: '342', meaning: 'Synthetic meaning' },
    ]);
    const reasons = await ingest.execute(
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
    const v = await verify(r.generationId);
    expect(failedChecks(v)).toEqual([]);
    expect(v.counts['excludedRows.findings']).toBe(1);
    expect(v.counts['rows.case_findings']).toBe(1);
  });
});

describe('verification', () => {
  it('fails a generation whose stored text no longer matches its hash', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    await tamper(
      migrator,
      ['case_sections'],
      sql`update case_sections set text = text || ' tampered' where generation_id = ${g} and section_id = 'DFW08TA066:probable_cause/aircraft-1'`,
    );
    const v = await verify(g);
    expect(v).toMatchObject({ ok: false, status: 'failed', verificationStatus: 'failed' });
    expect(v.checks.find((c) => c.name === 'section_sha256_matches_text')).toMatchObject({ ok: false, failures: 1 });
    await expect(publishManifest(ingest, g, 'aviation-test-cases', 'aviation-test-passages')).rejects.toThrow(/is failed/);
  });

  it('fails replaced canonical text even when every hash and revision is recomputed', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    const [cause] = await ingest
      .select({ sectionId: caseSections.sectionId, sectionKey: caseSections.sectionKey })
      .from(caseSections)
      .where(sql`${caseSections.generationId} = ${g} and ${caseSections.ntsbNo} = 'CEN24FA064' and ${caseSections.kind} = 'probable_cause'`);
    if (!cause) throw new Error('CEN24FA064 cause missing');
    const text = 'The pilot did something entirely unrelated to the source narrative.';
    const textSha = sha256(text);
    await tamper(
      migrator,
      ['case_sections'],
      sql`update case_sections set text = ${text}, sha256 = ${textSha},
            revision_id = ${sectionRevisionId('CEN24FA064', cause.sectionKey, textSha, 'v1')}
          where generation_id = ${g} and section_id = ${cause.sectionId}`,
    );
    const v = await verify(g);
    expect(v.ok).toBe(false);
    expect(failedChecks(v)).toEqual(['source_derives_section_text']);
  });

  it('fails a wrong HTML-transformation flag', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    await tamper(
      migrator,
      ['case_section_sources'],
      sql`update case_section_sources set transformed_from_html = not transformed_from_html
          where generation_id = ${g} and ntsb_no = 'DFW08TA066'`,
    );
    const v = await verify(g);
    expect(failedChecks(v)).toEqual(expect.arrayContaining(['source_html_flag']));
  });

  it('fails event and aircraft phase summaries that disagree with their rows', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    await tamper(
      migrator,
      ['cases'],
      sql`update cases set defining_phase_groups = '{taxi}' where generation_id = ${g} and ntsb_no = 'DFW08TA066'`,
    );
    expect(failedChecks(await verify(g))).toEqual(['event_defining_phases']);

    const { generationId: g2 } = await loadFromExtract(ingest, fixtureDir);
    await tamper(
      migrator,
      ['cases', 'case_aircraft'],
      sql`with c as (update cases set sequence_phase_groups = array_append(sequence_phase_groups, 'taxi')
            where generation_id = ${g2} and ntsb_no = 'DFW08TA066' returning 1)
          update case_aircraft set sequence_phase_groups = '{}' where generation_id = ${g2} and ntsb_no = 'DFW08TA066'`,
    );
    expect(failedChecks(await verify(g2))).toEqual(['event_sequence_phases', 'aircraft_sequence_phases']);
  });

  it('fails a missing child row and a generation whose run did not succeed', async () => {
    const { generationId: g, runId } = await loadFromExtract(ingest, fixtureDir);
    await tamper(
      migrator,
      ['case_findings', 'ingestion_runs'],
      sql`with d as (delete from case_findings where generation_id = ${g} and (ntsb_no, aircraft_key, finding_no) =
            (select ntsb_no, aircraft_key, finding_no from case_findings where generation_id = ${g} order by 1, 2, 3 limit 1)
            returning 1)
          update ingestion_runs set status = 'failed' where id = ${runId}`,
    );
    const v = await verify(g);
    expect(failedChecks(v)).toEqual(['generation_run_succeeded', 'counts_match_normalization_and_source']);
    const file = JSON.parse(readFileSync(v.reportPath, 'utf8'));
    expect(file.countMismatches).toEqual(['rows.case_findings', 'source.findings']);
  });

  it('fails a completion class that disagrees with its raw status', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    await tamper(migrator, ['cases'], sql`update cases set raw_status = 'F' where generation_id = ${g} and ntsb_no = 'DFW08TA066'`);
    const v = await verify(g);
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

  it('reports a conflict and records nothing when the generation changes during verification', async () => {
    const { generationId: g } = await loadFromExtract(ingest, fixtureDir);
    const v = await verifyCorpus(ingest, g, {
      outDir: reportDir,
      profile: null,
      // Another writer (the schema owner, outside the lifecycle lock) records an outcome meanwhile.
      beforeRecord: async () => {
        await migrator.execute(
          sql`update dataset_generations set status = 'failed', verification_status = 'failed', verified_at = now(),
                verifier_version = 'other', verification_report_sha256 = ${'0'.repeat(64)} where id = ${g}`,
        );
      },
    });
    expect(v).toMatchObject({ ok: true, conflict: true, statusBefore: 'loaded', status: 'loaded', verificationStatus: null });
    const [gen] = await ingest.select().from(datasetGenerations).where(eq(datasetGenerations.id, g));
    expect(gen).toMatchObject({ status: 'failed', verifierVersion: 'other' });
  });

  it('re-verification of a published generation keeps its status and records the outcome', async () => {
    const g = await loadVerified(ingest, fixtureDir, reportDir);
    await publishManifest(ingest, g, 'aviation-test-cases-1', 'aviation-test-passages-1');
    const ok = await verify(g);
    expect(ok).toMatchObject({ ok: true, statusBefore: 'published', status: 'published', verificationStatus: 'ok' });
    await tamper(migrator, ['cases'], sql`update cases set raw_status = 'F' where generation_id = ${g} and ntsb_no = 'DFW08TA066'`);
    const bad = await verify(g);
    expect(bad).toMatchObject({ ok: false, status: 'published', verificationStatus: 'failed' });
    const [gen] = await ingest.select().from(datasetGenerations).where(eq(datasetGenerations.id, g));
    expect(gen).toMatchObject({ status: 'published', verificationStatus: 'failed' });
  });
});
