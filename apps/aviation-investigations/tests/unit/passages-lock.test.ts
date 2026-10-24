/**
 * The per-generation passages-build lock (task 22 re-review N4): it lives on a session of
 * its own for the whole build. If that session drops, the worker must not end on an
 * unhandled `error`, and since the server released the lock with the session, the build
 * must stop before it pays for more embeddings or switches the alias. Offline, against a
 * fake PostgreSQL server (tests/support/fake-pg.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb } from '../../server/db/client.js';
import { PassagesLockLostError, withGenerationLock } from '../../worker/index/passages-index.js';
import { FakePg } from '../support/fake-pg.js';

let fake: FakePg;

beforeAll(async () => {
  fake = await FakePg.start();
  // `select pg_try_advisory_lock(...) as ok` answers true.
  fake.column = { name: 'ok', typeOid: 16, value: 't' };
});

afterAll(async () => {
  await fake.close();
});

describe('the passages-build lock session', () => {
  it('holds the lock for the build and lets it check that it still does', async () => {
    const db = createDb(fake.url, { max: 1, connectTimeoutMs: 1_000, onConnectionError: () => undefined });
    try {
      expect(await withGenerationLock(db, 7, async (assertLocked) => (assertLocked(), 'built'))).toBe('built');
    } finally {
      await closeDb(db);
    }
  });

  it('a dropped lock session neither ends the worker nor lets the build go on unlocked', async () => {
    const db = createDb(fake.url, { max: 1, connectTimeoutMs: 1_000, onConnectionError: () => undefined });
    const steps: string[] = [];
    try {
      const outcome = await withGenerationLock(db, 7, async (assertLocked) => {
        assertLocked();
        steps.push('embedded under the lock');
        // The lock's session drops (a PostgreSQL restart): the server releases the lock with it.
        fake.dropAll();
        await new Promise((r) => setTimeout(r, 100));
        assertLocked();
        steps.push('went on unlocked');
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(PassagesLockLostError);
      expect((outcome as Error).message).toMatch(/generation 7/);
      expect(steps).toEqual(['embedded under the lock']);
    } finally {
      await closeDb(db);
    }
  });
});
