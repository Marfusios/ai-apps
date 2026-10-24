/**
 * Creating a brief and pruning the generation it cites (Task 22 fix round 2, gate finding 4):
 * a request resolves its evidence before admission and can pause across publications and
 * pruning. The brief is inserted holding the brief-references lock shared after checking the
 * evidence still exists (`claimBriefEvidence`); pruning waits for every insert in progress
 * before it reads which generations unexpired briefs cite (`waitForBriefInserts`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { BRIEF_REFERENCES_LOCK_KEY, claimBriefEvidence, listGenerations, pruneGenerations, publishManifest } from '../../server/db/generations.js';
import * as schema from '../../server/db/schema/index.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { count, loadVerified } from './corpus-helpers.js';
import { resetControls, resetCorpus, testDb } from './helpers.js';

let ingest: Db;
let app: Db;
let migrator: Db;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-brief-references-'));

beforeAll(async () => {
  ingest = testDb('ingest');
  app = testDb('app');
  migrator = testDb('migrator');
  fixtureDir = await makeExtractDir();
});

afterAll(async () => {
  await resetControls();
  await Promise.all([closeDb(ingest), closeDb(app), closeDb(migrator)]);
  for (const d of [fixtureDir, reportDir]) removeDir(d);
});

beforeEach(async () => {
  await resetCorpus();
  await resetControls();
  await migrator.execute(sql`TRUNCATE index_builds, index_switch_attempts RESTART IDENTITY`);
});

const verified = (): Promise<number> => loadVerified(ingest, fixtureDir, reportDir);
const passages = (g: number) => `aviation-test-refs-passages-${g}`;
const publish = (g: number) => publishManifest(ingest, g, `aviation-test-refs-cases-${g}`, passages(g));
const insertBriefRow = (g: number) => sql`
  insert into briefs (read_owner, read_owner_kind, generation_id, passages_index, created_at, expires_at)
  values (${'c'.repeat(64)}, 'trial', ${g}, ${passages(g)}, now(), now() + interval '1 hour')`;

/** Until a session waits for the brief-references lock (an advisory lock; the key's high and low 32 bits). */
async function waitForReferenceWaiter(): Promise<void> {
  const high = Math.floor(BRIEF_REFERENCES_LOCK_KEY / 2 ** 32);
  const low = BRIEF_REFERENCES_LOCK_KEY % 2 ** 32;
  for (let i = 0; i < 200; i++) {
    const waiting = await count(
      migrator,
      sql`select count(*) from pg_locks where locktype = 'advisory' and classid = ${high} and objid = ${low} and not granted`,
    );
    if (waiting > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no session waits for the brief-references lock');
}

describe('a brief being created while its generation is pruned', () => {
  it('pruning waits for the insert, then keeps the generation the new brief cites', async () => {
    const [g1, g2, g3] = [await verified(), await verified(), await verified()];
    await publish(g1);
    // The creating transaction: evidence claimed and the brief inserted, not yet committed.
    const creator = await app.$client.connect();
    let committed = false;
    try {
      await creator.query('BEGIN');
      expect(await claimBriefEvidence(drizzle({ client: creator, schema }), { generationId: g1, passagesIndex: passages(g1) })).toBe(true);
      await drizzle({ client: creator }).execute(insertBriefRow(g1));
      // Meanwhile two publications leave g1 outside the two most recent: a pruning candidate.
      await publish(g2);
      await publish(g3);
      let finished = false;
      const pruning = pruneGenerations(ingest).finally(() => (finished = true));
      await waitForReferenceWaiter();
      expect(finished).toBe(false);
      await creator.query('COMMIT');
      committed = true;
      expect(await pruning).toEqual({ retained: [g3, g2], deleted: [], skippedPinned: [], skippedLiveBriefs: [g1] });
      expect((await listGenerations(app)).map((g) => g.id)).toContain(g1);
    } finally {
      if (!committed) await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
    }
  });

  it('a request whose generation was pruned while it paused creates no brief', async () => {
    const [g1, g2, g3] = [await verified(), await verified(), await verified()];
    await publish(g1);
    const evidence = { generationId: g1, passagesIndex: passages(g1) }; // resolved now ...
    await publish(g2);
    await publish(g3);
    expect((await pruneGenerations(ingest)).deleted).toEqual([g1]); // ... pruned meanwhile
    await app.transaction(async (tx) => {
      expect(await claimBriefEvidence(tx, evidence)).toBe(false);
      // The current generation, retired or active, still takes briefs.
      expect(await claimBriefEvidence(tx, { generationId: g2, passagesIndex: passages(g2) })).toBe(true);
      expect(await claimBriefEvidence(tx, { generationId: g3, passagesIndex: passages(g3) })).toBe(true);
    });
  });

  it('a request whose passages index, or its pair’s cases index, was deleted creates no brief', async () => {
    const g = await verified();
    await publish(g);
    const record = (buildId: string, name: string, deleted: boolean) =>
      migrator.execute(sql`
        insert into index_builds (build_id, index_name, alias, generation_id, deleted_at)
        values (${buildId}, ${name}, 'aviation-test-refs', ${g}, ${deleted ? sql`now()` : sql`null`})`);
    await record('refkept', passages(g), false);
    await app.transaction(async (tx) => expect(await claimBriefEvidence(tx, { generationId: g, passagesIndex: passages(g) })).toBe(true));
    // An index cleanup deleted (recorded as deleted): the pair's cases index ...
    await record('refcases', `aviation-test-refs-cases-${g}`, true);
    await app.transaction(async (tx) => expect(await claimBriefEvidence(tx, { generationId: g, passagesIndex: passages(g) })).toBe(false));
    // ... or another passages index of the generation.
    await record('refold', `aviation-test-refs-old-${g}`, true);
    await app.transaction(async (tx) => expect(await claimBriefEvidence(tx, { generationId: g, passagesIndex: `aviation-test-refs-old-${g}` })).toBe(false));
  });
});
