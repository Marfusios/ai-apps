/**
 * Publication, index cleanup and the briefs that cite indices (Task 22 fix round 3: the gate's
 * findings 1 and 2 of round 2).
 *
 * - Publication holds the lifecycle lock on one connection from its checks of the indices to
 *   the manifest it writes, and refuses an index whose deletion was requested or done (in
 *   code and in `publish_manifest`): cleanup, which holds the same lock while it decides and
 *   deletes, can no longer delete a checked index before the manifest names it.
 * - Cleanup records a deletion as requested, and commits that, before it asks Elasticsearch.
 *   Whatever happens to the request (a lost response, a failed write afterwards, the process
 *   killed), no new brief, publication or alias switch takes the index again, and the next run
 *   confirms the deletion (`deleted_at`).
 *
 * Fixture corpus in aviation_test, indices under aviation-test-*.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { BRIEF_REFERENCES_LOCK_KEY, LIFECYCLE_LOCK_KEY, claimBriefEvidence, getActiveManifest, publishManifest } from '../../server/db/generations.js';
import { localAdminUrl } from '../../scripts/scratch-env.js';
import { ALIAS_LOCK_NAMESPACE, switchAlias } from '../../worker/index/aliases.js';
import { casesAlias, rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { passagesAlias } from '../../worker/index/passages-index.js';
import { deleteUnusedIndices, type DeleteUnusedReport } from '../../worker/index/publications.js';
import { PublishRefusedError, publishGeneration } from '../../worker/index/publish.js';
import { FIXTURE_EMBEDDING, buildFixturePassagesIndex, deleteIndices, publishFixtureDataset } from '../support/api-dataset.js';
import { count } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetControls, resetCorpus, testDb, testEs } from './helpers.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const PREFIX = `${TEST_INDEX_PREFIX}del${randomBytes(4).toString('hex')}`;
const PASSAGES = passagesAlias(PREFIX);
const CASES = casesAlias(PREFIX);

let appDb: Db;
let ingest: Db;
let migrator: Db;
let writer: Client;
let generationId: number;

beforeAll(async () => {
  appDb = testDb('app');
  ingest = testDb('ingest');
  migrator = testDb('migrator');
  writer = testEs();
  await resetControls();
  generationId = (await publishFixtureDataset(ingest, writer, PREFIX, { passages: true })).generationId;
}, 180_000);

afterAll(async () => {
  await deleteIndices(writer, PREFIX);
  await resetControls();
  await resetCorpus();
  await Promise.all([closeDb(appDb), closeDb(ingest), closeDb(migrator), writer.close()]);
});

beforeEach(async () => {
  await resetControls();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Until a session waits for the advisory lock `key` (its high and low 32 bits). */
async function waitForWaiter(key: number): Promise<void> {
  const [high, low] = [Math.floor(key / 2 ** 32), key % 2 ** 32];
  for (let i = 0; i < 400; i++) {
    const waiting = await count(migrator, sql`select count(*) from pg_locks where locktype = 'advisory' and classid = ${high} and objid = ${low} and not granted`);
    if (waiting > 0) return;
    await sleep(25);
  }
  throw new Error(`no session waits for advisory lock ${key}`);
}

/** Whether a build's index deletion was requested (unavailable from then on) and recorded as done. */
async function deletionState(index: string): Promise<{ requested: boolean; deleted: boolean } | undefined> {
  const r = await migrator.execute(sql`
    select deletion_requested_at is not null as requested, deleted_at is not null as deleted from index_builds where index_name = ${index}`);
  return r.rows[0] as { requested: boolean; deleted: boolean } | undefined;
}

/** What a request whose evidence was resolved while `index` was published gets when it creates its brief. */
async function claim(index: string): Promise<string> {
  return appDb.transaction((tx) => claimBriefEvidence(tx, { generationId, passagesIndex: index }));
}

/**
 * A passages index of the generation that nothing uses any more: published (a request may have
 * resolved it as its evidence), then replaced by the one published before, with the alias moved
 * back.
 */
async function supersededPassagesIndex(): Promise<string> {
  const before = (await getActiveManifest(appDb))!;
  const index = await buildFixturePassagesIndex(writer, generationId, PREFIX);
  await publishGeneration(writer, ingest, { generationId, casesIndex: before.casesIndex, passagesIndex: index, embedding: FIXTURE_EMBEDDING });
  await publishGeneration(writer, ingest, { generationId, casesIndex: before.casesIndex, passagesIndex: before.passagesIndex, embedding: FIXTURE_EMBEDDING });
  await switchAlias(writer, ingest, PASSAGES, before.passagesIndex!);
  return index;
}

/**
 * The write client whose index deletions end in a lost connection: after Elasticsearch applied
 * the request (`applied`, a lost response), or before it got there.
 */
function losingDeletes(es: Client, applied: boolean): Client {
  const indices = new Proxy(es.indices, {
    get(target, prop) {
      if (prop === 'delete') {
        return async (...args: Parameters<Client['indices']['delete']>) => {
          if (applied) await target.delete(...args);
          throw Object.assign(new Error(`socket hang up (simulated lost ${applied ? 'response' : 'request'})`), { name: 'ConnectionError' });
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(es, {
    get(target, prop) {
      if (prop === 'indices') return indices;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The write client, running `before` ahead of every `indices` call it makes. */
function watchedIndices(es: Client, before: () => Promise<void>): Client {
  const indices = new Proxy(es.indices, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await before();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return new Proxy(es, {
    get(target, prop) {
      if (prop === 'indices') return indices;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Whether a session holds the brief-references lock exclusively (new briefs wait for it). */
async function briefsLockedOut(): Promise<boolean> {
  const [high, low] = [Math.floor(BRIEF_REFERENCES_LOCK_KEY / 2 ** 32), BRIEF_REFERENCES_LOCK_KEY % 2 ** 32];
  return (
    (await count(
      migrator,
      sql`select count(*) from pg_locks where locktype = 'advisory' and classid = ${high} and objid = ${low} and mode = 'ExclusiveLock' and granted`,
    )) > 0
  );
}

const cleanup = (es: Client = writer, extra: Partial<Parameters<typeof deleteUnusedIndices>[2]> = {}): Promise<DeleteUnusedReport> =>
  deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [PASSAGES], ...extra });

/** Nothing takes the index again: a new brief, a publication, an alias switch. */
async function expectUnavailable(index: string): Promise<void> {
  expect(await claim(index)).toBe('gone');
  const active = (await getActiveManifest(appDb))!;
  await expect(
    publishGeneration(writer, ingest, { generationId, casesIndex: active.casesIndex, passagesIndex: index, embedding: FIXTURE_EMBEDDING }),
  ).rejects.toBeInstanceOf(PublishRefusedError);
  await expect(switchAlias(writer, ingest, PASSAGES, index)).rejects.toThrow(/deletion/);
  expect((await getActiveManifest(appDb))!.passagesIndex).toBe(active.passagesIndex);
}

describe('publication and index cleanup (gate round 2, finding 1)', () => {
  it('a publication paused after its checks holds cleanup off; cleanup then keeps the index it published', async () => {
    const active = (await getActiveManifest(appDb))!;
    // A rollback's cases index: built earlier (the alias moved to it), replaced, unused since.
    const old = (await rebuildCasesIndex(writer, ingest, { generationId, prefix: PREFIX })).index;
    await switchAlias(writer, ingest, CASES, active.casesIndex);
    let running: Promise<DeleteUnusedReport> | undefined;
    const other = testDb('ingest'); // cleanup is another process
    let report: DeleteUnusedReport;
    try {
      const published = await publishGeneration(writer, ingest, {
        generationId,
        casesIndex: old,
        passagesIndex: active.passagesIndex,
        embedding: FIXTURE_EMBEDDING,
        afterValidate: async () => {
          running = deleteUnusedIndices(writer, other, { olderThanHours: 0, yes: true, aliases: [CASES] });
          // Until cleanup waits for the lifecycle lock (or, if nothing holds it off, has finished).
          await Promise.race([running.catch(() => undefined), waitForWaiter(LIFECYCLE_LOCK_KEY)]);
        },
      });
      expect(published.manifest.casesIndex).toBe(old);
      report = await running!;
    } finally {
      await running?.catch(() => undefined);
      await closeDb(other);
    }
    expect(report.deleted).not.toContain(old);
    expect(report.refused).toContainEqual({ indexName: old, reason: 'referenced by a dataset manifest' });
    expect(await writer.indices.exists({ index: old })).toBe(true);
    // Back to the dataset the other tests expect.
    await publishGeneration(writer, ingest, { generationId, casesIndex: active.casesIndex, passagesIndex: active.passagesIndex, embedding: FIXTURE_EMBEDDING });
  }, 120_000);

  it('publish_manifest refuses an index whose deletion was requested or recorded, and changes nothing', async () => {
    const active = (await getActiveManifest(appDb))!;
    const tag = randomBytes(3).toString('hex');
    for (const deleted of [false, true]) {
      const index = `${PREFIX}-gone-${tag}-${deleted ? 'done' : 'requested'}`;
      await migrator.execute(sql`
        insert into index_builds (build_id, index_name, alias, generation_id, deletion_requested_at, deleted_at)
        values (${`gone${tag}${deleted ? 'd' : 'r'}`}, ${index}, ${PASSAGES}, ${generationId}, now(), ${deleted ? sql`now()` : sql`null`})`);
      await expect(publishManifest(ingest, generationId, active.casesIndex, index)).rejects.toMatchObject({
        code: '55000',
        message: expect.stringContaining(`index ${index} is deleted or being deleted`),
      });
      await expect(publishManifest(ingest, generationId, index, active.passagesIndex)).rejects.toMatchObject({ code: '55000' });
    }
    expect(await getActiveManifest(appDb)).toEqual(active);
  });
});

describe('an index deletion is recorded before Elasticsearch is asked (gate round 2, finding 2)', () => {
  it('a lost response leaves the deletion requested: nothing takes the index, and the next run confirms it', async () => {
    const index = await supersededPassagesIndex();
    await expect(cleanup(losingDeletes(writer, true))).rejects.toThrow(/lost response/);
    expect(await writer.indices.exists({ index })).toBe(false); // Elasticsearch did delete it
    await expectUnavailable(index);
    expect(await deletionState(index)).toEqual({ requested: true, deleted: false });

    const next = await cleanup();
    expect(next.missing).toContain(index);
    expect(await deletionState(index)).toEqual({ requested: true, deleted: true });
  }, 180_000);

  it('a database failure after Elasticsearch deleted the index leaves it requested; the next run records it', async () => {
    const index = await supersededPassagesIndex();
    const admin = new pg.Client({ connectionString: localAdminUrl() });
    await admin.connect();
    try {
      const failed = await cleanup(writer, {
        afterDelete: async (name) => {
          if (name !== index) return;
          // The connection that holds the cleanup's alias lock, and records the deletion, dies first.
          const killed = await admin.query(
            `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = $1 and objsubid = 2 and granted`,
            [ALIAS_LOCK_NAMESPACE],
          );
          expect(killed.rowCount).toBe(1);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failed).toBeInstanceOf(Error);
    } finally {
      await admin.end();
    }
    expect(await writer.indices.exists({ index })).toBe(false);
    await expectUnavailable(index);
    expect(await deletionState(index)).toEqual({ requested: true, deleted: false });

    const next = await cleanup();
    expect(next.missing).toContain(index);
    expect(await deletionState(index)).toEqual({ requested: true, deleted: true });
  }, 180_000);

  for (const point of ['before-delete', 'after-delete'] as const) {
    it(`a cleanup process killed ${point === 'before-delete' ? 'before it asks Elasticsearch' : 'after Elasticsearch deleted the index'} leaves the deletion requested; the next run completes it`, async () => {
      const index = await supersededPassagesIndex();
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
        const child = spawn(resolve(APP_DIR, 'node_modules/.bin/tsx'), ['tests/support/interrupted-cleanup.ts', PASSAGES, index, point], {
          cwd: APP_DIR,
          env: process.env,
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        child.on('error', fail);
        child.on('exit', (code, signal) => done({ code, signal }));
      });
      // Killed outright (tsx reports its child's SIGKILL as exit code 137).
      expect(exit.signal === 'SIGKILL' || exit.code === 137).toBe(true);
      expect(await writer.indices.exists({ index })).toBe(point === 'before-delete');
      await expectUnavailable(index);
      expect(await deletionState(index)).toEqual({ requested: true, deleted: false });

      const next = await cleanup();
      expect(point === 'before-delete' ? next.deleted : next.missing).toContain(index);
      expect(await writer.indices.exists({ index })).toBe(false);
      expect(await deletionState(index)).toEqual({ requested: true, deleted: true });
    }, 180_000);
  }

  it('a request lost on its way leaves the index requested; a dry run lists it apart, the next run deletes it', async () => {
    const index = await supersededPassagesIndex();
    await expect(cleanup(losingDeletes(writer, false))).rejects.toThrow(/lost request/);
    expect(await writer.indices.exists({ index })).toBe(true);
    await expectUnavailable(index);
    // At any age: the decision was taken.
    const dry = await deleteUnusedIndices(writer, ingest, { olderThanHours: 24, aliases: [PASSAGES] });
    expect(dry.pending).toEqual([index]);
    expect(dry.wouldDelete).not.toContain(index);
    expect(await deletionState(index)).toEqual({ requested: true, deleted: false });
    expect((await cleanup()).deleted).toContain(index);
    expect(await writer.indices.exists({ index })).toBe(false);
    expect(await deletionState(index)).toEqual({ requested: true, deleted: true });
  }, 180_000);
});

describe('what index cleanup makes new briefs wait for (re-check N11)', () => {
  it('a dry run takes no lock a brief being created holds', async () => {
    const index = await supersededPassagesIndex();
    // A brief being created holds the brief-references lock shared until it commits.
    const creator = await appDb.$client.connect();
    try {
      await creator.query('BEGIN');
      await creator.query('select pg_advisory_xact_lock_shared($1)', [BRIEF_REFERENCES_LOCK_KEY]);
      const dry = await Promise.race([
        deleteUnusedIndices(writer, ingest, { olderThanHours: 0, aliases: [PASSAGES] }),
        sleep(10_000).then(() => 'still waiting' as const),
      ]);
      expect(dry).not.toBe('still waiting');
      expect((dry as DeleteUnusedReport).wouldDelete).toContain(index);
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
    }
    expect((await cleanup()).deleted).toContain(index);
  }, 180_000);

  it('Elasticsearch is asked nothing while new briefs are locked out', async () => {
    const index = await supersededPassagesIndex();
    const lockedOut: boolean[] = [];
    const report = await cleanup(watchedIndices(writer, async () => void lockedOut.push(await briefsLockedOut())));
    expect(report.deleted).toContain(index);
    expect(lockedOut.length).toBeGreaterThan(1); // the alias read-back and the delete, at least
    expect(lockedOut).not.toContain(true);
  }, 180_000);
});
