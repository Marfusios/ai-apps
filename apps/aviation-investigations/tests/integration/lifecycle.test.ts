import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import {
  activePins,
  getActiveManifest,
  listGenerations,
  pinGeneration,
  pruneGenerations,
  publishManifest,
  unpinGeneration,
} from '../../server/db/generations.js';
import { GENERATION_TABLES, cases, ingestionRuns } from '../../server/db/schema/index.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { failStaleRuns, listRunningRuns } from '../../worker/ingest/runs.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { count, loadVerified, snapshot, sqlState, tamper } from './corpus-helpers.js';
import { resetControls, resetCorpus, testDb } from './helpers.js';

let ingest: Db;
let app: Db;
let migrator: Db;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-lifecycle-test-'));

beforeAll(async () => {
  ingest = testDb('ingest');
  app = testDb('app');
  migrator = testDb('migrator');
  fixtureDir = await makeExtractDir();
});

afterAll(async () => {
  await Promise.all([closeDb(ingest), closeDb(app), closeDb(migrator)]);
  for (const d of [fixtureDir, reportDir]) removeDir(d);
});

beforeEach(async () => {
  await resetCorpus();
  // Briefs another test file left behind would cite these generation ids.
  await resetControls();
});

const loaded = async (): Promise<number> => (await loadFromExtract(ingest, fixtureDir)).generationId;
const verified = (): Promise<number> => loadVerified(ingest, fixtureDir, reportDir);
const publish = (g: number) => publishManifest(ingest, g, `aviation-test-cases-${g}`, `aviation-test-passages-${g}`);

/** A minimal valid case row for generation `g` (the triggers, not constraints, must refuse it). */
const caseInsert = (g: number) =>
  sql`insert into cases (generation_id, ntsb_no, ev_id, is_us, completion_class, completion_mapping_version,
        has_probable_cause, completed_with_cause, answer_eligible, defining_phase_groups, sequence_phase_groups, source_revision)
      values (${g}, 'SYN00NEW01', 'SYN-EV', false, 'other_status', 'v1-empirical', false, false, false, '{}', '{}', ${'a'.repeat(64)})`;

async function rowsOf(db: Db, g: number): Promise<number> {
  let n = 0;
  for (const table of GENERATION_TABLES) {
    const t = table as PgTable & { generationId: typeof cases.generationId };
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(t.generationId, g));
    n += row?.n ?? 0;
  }
  return n;
}

describe('sealed generations', () => {
  it('ingest cannot append to, delete from, update or re-label a published generation', async () => {
    const g = await verified();
    await publish(g);
    const before = await snapshot(ingest, g);
    // Append (the trigger refuses: the generation is sealed).
    expect(await sqlState(ingest.execute(caseInsert(g)))).toBe('55000');
    // Delete and update (no privilege at all).
    expect(await sqlState(ingest.execute(sql`delete from case_sections where generation_id = ${g}`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`delete from cases where generation_id = ${g}`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`update cases set city = 'X' where generation_id = ${g}`))).toBe('42501');
    // Generation metadata, status, manifests and runs.
    expect(await sqlState(ingest.execute(sql`update dataset_generations set stats = '{}' where id = ${g}`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`update dataset_generations set status = 'verified' where id = ${g}`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`update dataset_generations set extract_manifest = '{}' where id = ${g}`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`delete from dataset_generations where id = ${g}`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`update dataset_manifests set active = false`))).toBe('42501');
    expect(
      await sqlState(
        ingest.execute(sql`insert into dataset_manifests (generation_id, cases_index, passages_index) values (${g}, 'a', 'b')`),
      ),
    ).toBe('42501');
    expect(await sqlState(ingest.execute(sql`delete from ingestion_runs`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`update ingestion_runs set started_at = now()`))).toBe('42501');
    // A finished run cannot be reopened, and a generation cannot be born sealed.
    expect(await sqlState(ingest.execute(sql`update ingestion_runs set status = 'running', finished_at = null`))).toBe('55000');
    expect(
      await sqlState(
        ingest.execute(sql`insert into dataset_generations (ingestion_run_id, archive_sha256, extract_manifest, mapping_version,
          mapping_verified, citation_text_version, field_normalization_version, status, stats)
          values (1, ${'a'.repeat(64)}, '{}', 'v', false, 'v1', 'v1', 'published', '{}')`),
      ),
    ).toBe('55000');
    expect(await snapshot(ingest, g)).toEqual(before);
  });

  it('a sealed generation rejects writes from every role, the schema owner included', async () => {
    const g = await loaded();
    expect(await sqlState(ingest.execute(caseInsert(g)))).toBe('55000');
    expect(await sqlState(migrator.execute(caseInsert(g)))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`delete from case_findings where generation_id = ${g}`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`update case_sections set text = 'x' where generation_id = ${g}`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`update dataset_generations set stats = '{}' where id = ${g}`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`update dataset_generations set status = 'published' where id = ${g}`))).toBe('55000');
  });

  it('app role reads the corpus without internal ids and writes nothing', async () => {
    const g = await verified();
    expect(await count(app, sql`select count(ntsb_no) from cases where generation_id = ${g}`)).toBe(16);
    expect(await count(app, sql`select count(*) from case_sections where generation_id = ${g}`)).toBeGreaterThan(0);
    expect(await sqlState(app.execute(sql`select ev_id from cases`))).toBe('42501');
    expect(await sqlState(app.execute(sql`select * from cases`))).toBe('42501');
    expect(await sqlState(app.execute(sql`select count(*) from quarantine`))).toBe('42501');
    expect(await sqlState(app.execute(sql`select count(*) from ingestion_runs`))).toBe('42501');
    for (const statement of [
      caseInsert(g),
      sql`update case_sections set text = 'x' where generation_id = ${g}`,
      sql`delete from case_sections where generation_id = ${g}`,
      sql`update dataset_manifests set active = false`,
      sql`update dataset_generations set status = 'failed'`,
      sql`insert into generation_pins (generation_id, reason) values (${g}, 'x')`,
      sql`truncate case_findings`,
      sql`select publish_manifest(${g}, 'a', 'b', 'verify-v2')`,
      sql`select prune_generation(${g})`,
      sql`select analyze_corpus()`,
    ]) {
      expect(await sqlState(app.execute(statement))).toBe('42501');
    }
  });
});

describe('publication', () => {
  it('publishes atomically and reads the active manifest', async () => {
    expect(await getActiveManifest(app)).toBeNull();
    const g1 = await verified();
    const g2 = await verified();

    const a1 = await publish(g1);
    expect(a1).toMatchObject({ generationId: g1, casesIndex: `aviation-test-cases-${g1}`, verificationStatus: 'ok' });
    expect(await getActiveManifest(app)).toMatchObject({ generationId: g1, mappingVersion: 'v1-empirical', citationTextVersion: 'v1' });
    await publish(g2);
    expect((await getActiveManifest(app))?.generationId).toBe(g2);
    expect((await listGenerations(app)).map((g) => [g.id, g.status, g.active])).toEqual([
      [g1, 'retired', false],
      [g2, 'published', true],
    ]);
    // At most one active manifest, even for the schema owner.
    expect(await sqlState(migrator.execute(sql`update dataset_manifests set active = true`))).toBe('23505');
    await expect(publishManifest(ingest, g2, 'Bad/Name', 'aviation-test-passages-2')).rejects.toThrow(/invalid index name/);
    await expect(publishManifest(ingest, 999, 'a', 'b')).rejects.toThrow(/does not exist/);
    // Rolling back to the earlier generation.
    await publish(g1);
    expect((await getActiveManifest(app))?.generationId).toBe(g1);
    expect(await count(app, sql`select count(*) from dataset_manifests where active`)).toBe(1);
  });

  it('requires a current successful verification, also for a rollback', async () => {
    const g1 = await verified();
    const g2 = await loaded();
    await expect(publish(g2)).rejects.toThrow(/is loaded; only a verified generation/);
    await publish(g1);
    const v2 = await verifyCorpus(ingest, g2, { outDir: reportDir, profile: null });
    expect(v2.status).toBe('verified');
    await publish(g2);

    // g1 is retired; a failed re-verification bars rolling back to it.
    await tamper(migrator, ['cases'], sql`update cases set raw_status = 'F' where generation_id = ${g1} and ntsb_no = 'DFW08TA066'`);
    const v1 = await verifyCorpus(ingest, g1, { outDir: reportDir, profile: null });
    expect(v1).toMatchObject({ ok: false, status: 'retired', verificationStatus: 'failed' });
    await expect(publish(g1)).rejects.toThrow(/no current successful verification \(latest failed/);
    expect((await getActiveManifest(app))?.generationId).toBe(g2);

    // A verification by an older verifier version does not count either.
    const g3 = await verified();
    await migrator.execute(sql`update dataset_generations set verifier_version = 'verify-v1' where id = ${g3}`);
    await expect(publish(g3)).rejects.toThrow(/verifier verify-v1/);
    expect((await getActiveManifest(app))?.generationId).toBe(g2);
  });
});

describe('pruning', () => {
  it('retains by publication order, not id: retired generations outside the last two go', async () => {
    const [g1, g2, g3, g4] = [await verified(), await verified(), await verified(), await verified()];
    // Published 3, then 2, then 4: the last two published are [4, 2]; 3 is retired outside them.
    await publish(g3 as number);
    await publish(g2 as number);
    await publish(g4 as number);
    const keptBefore = await snapshot(ingest, g2 as number);
    const report = await pruneGenerations(ingest);
    expect(report).toEqual({ retained: [g4, g2], deleted: [g3], skippedPinned: [], skippedLiveBriefs: [] });
    // g1 was verified moments ago and never published: within the grace period.
    expect((await listGenerations(app)).map((g) => [g.id, g.status])).toEqual([
      [g1, 'verified'],
      [g2, 'retired'],
      [g4, 'published'],
    ]);
    expect(await rowsOf(ingest, g3 as number)).toBe(0);
    expect(await snapshot(ingest, g2 as number)).toEqual(keptBefore);
    expect((await getActiveManifest(app))?.generationId).toBe(g4);
  });

  it('a dry run lists what would be deleted and deletes nothing', async () => {
    const [g1, g2, g3, g4] = [await verified(), await verified(), await verified(), await verified()];
    for (const g of [g1, g2, g3]) await publish(g as number);
    await pinGeneration(ingest, g1 as number, 'brief 7');
    const before = (await listGenerations(app)).map((g) => g.id);
    const planned = await pruneGenerations(ingest, { keep: 1, dryRun: true });
    expect(planned).toEqual({ retained: [g3], deleted: [g2], skippedPinned: [g1], skippedLiveBriefs: [] });
    expect((await listGenerations(app)).map((g) => g.id)).toEqual(before);
    expect(await rowsOf(ingest, g2 as number)).toBeGreaterThan(0);
    // g4 is verified but never published and inside the grace period: not a candidate either way.
    expect(planned.deleted).not.toContain(g4);
    // The real run does what the plan said.
    expect(await pruneGenerations(ingest, { keep: 1 })).toEqual(planned);
    expect((await listGenerations(app)).map((g) => g.id)).not.toContain(g2);
  });

  it('keeps a slow load that committed late, deletes unpublished ones past the grace period and failed ones', async () => {
    const active = await verified();
    await publish(active);
    const late = await loaded();
    // The load started two days ago but sealed (committed) just now.
    await tamper(
      migrator,
      ['dataset_generations'],
      sql`update dataset_generations set created_at = now() - interval '48 hours' where id = ${late}`,
    );
    expect(await pruneGenerations(ingest, { graceHours: 24 })).toEqual({ retained: [active], deleted: [], skippedPinned: [], skippedLiveBriefs: [] });

    // Once sealed (and verified) more than a day ago it is pruned.
    const stale = await verified();
    await tamper(
      migrator,
      ['dataset_generations'],
      sql`update dataset_generations set sealed_at = now() - interval '30 hours',
            verified_at = case when verified_at is null then null else now() - interval '25 hours' end
          where id in (${late}, ${stale})`,
    );
    const failed = await loaded();
    const v = await verifyCorpus(ingest, failed, {
      outDir: reportDir,
      profile: { name: 'impossible', archiveSha256: (await listGenerations(ingest))[0]?.archiveSha256 ?? '', expected: { events: 1 } },
    });
    expect(v.status).toBe('failed');
    const fresh = await loaded();
    expect(await pruneGenerations(ingest, { graceHours: 24 })).toEqual({
      retained: [active],
      deleted: [late, stale, failed],
      skippedPinned: [],
      skippedLiveBriefs: [],
    });
    expect((await listGenerations(app)).map((g) => g.id)).toEqual([active, fresh]);
  });

  it('keeps a generation that an unexpired brief cites until its briefs expire (A6)', async () => {
    const [g1, g2, g3] = [await verified(), await verified(), await verified()];
    await publish(g1 as number);
    const brief = (g: number, createdHoursAgo: number) =>
      migrator.execute(sql`
        insert into briefs (read_owner, read_owner_kind, generation_id, passages_index, created_at, expires_at)
        values (${'b'.repeat(64)}, 'trial', ${g}, ${`aviation-test-passages-${g}`}, now() - make_interval(hours => ${createdHoursAgo}),
          now() - make_interval(hours => ${createdHoursAgo}) + interval '24 hours')`);
    // A brief made while g1 served, 2 hours ago, and an expired one.
    await brief(g1 as number, 2);
    await brief(g1 as number, 30);
    // Two publications within the brief's life: keep = 2 alone would delete g1 under it.
    await publish(g2 as number);
    await publish(g3 as number);
    const planned = await pruneGenerations(ingest, { dryRun: true });
    expect(planned).toEqual({ retained: [g3, g2], deleted: [], skippedPinned: [], skippedLiveBriefs: [g1] });
    expect(await pruneGenerations(ingest)).toEqual(planned);
    expect(await rowsOf(ingest, g1 as number)).toBeGreaterThan(0);
    // aviation_ingest learns generation ids only; it still cannot read briefs.
    expect(await sqlState(ingest.execute(sql`select count(*) from briefs`))).toBe('42501');
    expect(await sqlState(app.execute(sql`select * from generations_cited_by_live_briefs()`))).toBe('42501');
    // Once its briefs are gone (expired and pruned), the generation goes too.
    await resetControls();
    expect(await pruneGenerations(ingest)).toEqual({ retained: [g3, g2], deleted: [g1], skippedPinned: [], skippedLiveBriefs: [] });
  });

  it('never deletes a pinned or the active generation', async () => {
    const [g1, g2, g3] = [await verified(), await verified(), await verified()];
    for (const g of [g1, g2, g3]) await publish(g as number);
    await pinGeneration(ingest, g1 as number, 'brief 42');
    expect(await activePins(ingest, g1 as number)).toEqual([{ reason: 'brief 42', pinnedUntil: null }]);
    expect(await pruneGenerations(ingest, { keep: 1 })).toEqual({ retained: [g3], deleted: [g2], skippedPinned: [g1], skippedLiveBriefs: [] });
    // The database function refuses too.
    await expect(ingest.execute(sql`select prune_generation(${g1})`)).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(ingest.execute(sql`select prune_generation(${g3})`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/is active/) },
    });
    // An expired pin no longer protects; neither does a removed one.
    await pinGeneration(ingest, g1 as number, 'brief 42', new Date(Date.now() - 1000));
    expect(await activePins(ingest, g1 as number)).toEqual([]);
    await pinGeneration(ingest, g1 as number, 'brief 43');
    expect(await unpinGeneration(ingest, g1 as number, 'brief 43')).toBe(true);
    expect(await pruneGenerations(ingest, { keep: 1 })).toEqual({ retained: [g3], deleted: [g1], skippedPinned: [], skippedLiveBriefs: [] });
    expect(await count(ingest, sql`select count(*) from generation_pins`)).toBe(0);
    await expect(pruneGenerations(ingest, { keep: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe('pins', () => {
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if ((await count(migrator, sql`select count(*) from pg_locks where locktype = 'advisory' and not granted`)) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no session is waiting for the lifecycle lock');
  }

  it('are written only through the locked database functions', async () => {
    const g = await loaded();
    for (const statement of [
      sql`insert into generation_pins (generation_id, reason) values (${g}, 'direct')`,
      sql`update generation_pins set pinned_until = null`,
      sql`delete from generation_pins`,
    ]) {
      expect(await sqlState(ingest.execute(statement))).toBe('42501');
      expect(await sqlState(app.execute(statement))).toBe('42501');
    }
    expect(await sqlState(app.execute(sql`select pin_generation(${g}, 'x', null)`))).toBe('42501');
    await expect(pinGeneration(ingest, 999, 'brief')).rejects.toThrow(/generation 999 does not exist/);
    await pinGeneration(ingest, g, 'brief');
    expect(await activePins(app, g)).toEqual([{ reason: 'brief', pinnedUntil: null }]);
    expect(await unpinGeneration(ingest, g, 'brief')).toBe(true);
    expect(await unpinGeneration(ingest, g, 'brief')).toBe(false);
  });

  it('a renewal racing pruning either protects the generation or fails because pruning won', async () => {
    const [g1, g2, g3] = [await verified(), await verified(), await verified()];
    for (const g of [g1, g2, g3]) await publish(g as number);
    // Renewed before pruning plans: the pin protects.
    await pinGeneration(ingest, g1 as number, 'brief', new Date(Date.now() - 1000));
    await pinGeneration(ingest, g1 as number, 'brief', null);
    expect(await pruneGenerations(ingest, { keep: 1 })).toEqual({ retained: [g3], deleted: [g2], skippedPinned: [g1], skippedLiveBriefs: [] });

    // Expired again; pruning plans to delete g1 and a renewal arrives meanwhile. The
    // renewal waits for the lifecycle lock, pruning deletes, and the renewal fails cleanly.
    await pinGeneration(ingest, g1 as number, 'brief', new Date(Date.now() - 1000));
    let renewal: Promise<unknown> = Promise.resolve();
    const report = await pruneGenerations(ingest, {
      keep: 1,
      afterPlan: async (candidates) => {
        expect(candidates).toEqual([g1]);
        renewal = pinGeneration(ingest, g1 as number, 'brief', null).then(
          () => 'pinned',
          (e: unknown) => e,
        );
        await waitForLockWaiter();
      },
    });
    expect(report).toEqual({ retained: [g3], deleted: [g1], skippedPinned: [], skippedLiveBriefs: [] });
    const outcome = await renewal;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/generation \d+ does not exist/);
    expect(await count(ingest, sql`select count(*) from generation_pins`)).toBe(0);
    expect((await listGenerations(app)).map((g) => g.id)).toEqual([g3]);
  });
});

describe('ingestion runs', () => {
  it('lists running runs and closes stale ones', async () => {
    const [old] = await ingest
      .insert(ingestionRuns)
      .values({
        status: 'running',
        startedAt: new Date(Date.now() - 3 * 3600_000),
        mappingVersion: 'v1-empirical',
        textNormalizationVersion: 'v1',
        fieldNormalizationVersion: 'v1',
      })
      .returning({ id: ingestionRuns.id });
    const [recent] = await ingest
      .insert(ingestionRuns)
      .values({ status: 'running', mappingVersion: 'v1-empirical', textNormalizationVersion: 'v1', fieldNormalizationVersion: 'v1' })
      .returning({ id: ingestionRuns.id });
    const running = await listRunningRuns(ingest);
    expect(running.map((r) => r.id)).toEqual([old?.id, recent?.id]);
    expect(running[0]?.ageMinutes).toBeGreaterThanOrEqual(179);
    expect(await failStaleRuns(ingest, 60)).toEqual([old?.id]);
    const [closed] = await ingest.select().from(ingestionRuns).where(eq(ingestionRuns.id, old?.id ?? 0));
    expect(closed).toMatchObject({ status: 'failed', error: 'marked failed: still running after more than 60 minutes' });
    expect((await listRunningRuns(ingest)).map((r) => r.id)).toEqual([recent?.id]);
  });
});
