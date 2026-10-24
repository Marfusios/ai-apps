/**
 * A restore establishes the hold on paid operations by itself (Task 22 fix round 2: gate
 * finding 1, re-review N6). docker/postgres/restore.sh ends its transaction with
 * docker/postgres/after-restore.sql: it records the restore in drizzle.restores and holds paid
 * operations when the hold table exists; migration 0020, run later on a database restored from
 * a backup taken before it, starts held because of that record. Nothing depends on database
 * OIDs, which a new cluster can repeat. Throwaway environments on the local services only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeDb, createDb } from '../../server/db/client.js';
import { runMigrations } from '../../server/db/migrate.js';
import { paidOperationsHeld, readPaidOperationsHold } from '../../server/quota/hold.js';
import { localAdminUrl, withScratchEnvironment } from '../../scripts/scratch-env.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const AFTER_RESTORE = readFileSync(resolve(APP_DIR, 'docker/postgres/after-restore.sql'), 'utf8');
const ENV = 'holdrestore';

/** What restore.sh sends after the dump, in the restore's transaction. */
async function afterRestore(url: string, backup: string): Promise<void> {
  const db = createDb(url, { max: 1 });
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('aviation.restored_from', ${backup}, true)`);
      await tx.execute(sql.raw(AFTER_RESTORE));
    });
  } finally {
    await closeDb(db);
  }
}

async function holdOf(url: string) {
  const db = createDb(url, { max: 1 });
  try {
    return { held: await paidOperationsHeld(db), hold: await readPaidOperationsHold(db) };
  } finally {
    await closeDb(db);
  }
}

describe('a restore establishes the hold on paid operations', () => {
  it('holds them even when the restored row names this very database (a repeated OID)', async () => {
    await withScratchEnvironment(localAdminUrl(), ENV, async (urls) => {
      // The state any migrated database has, and what a backup restored into a database that
      // happens to get the same OID brings along: this database's OID, nothing held.
      expect(await holdOf(urls.app)).toMatchObject({ held: false, hold: { reason: null } });
      await afterRestore(urls.migrator, 'aviation_live-2026-10-24T031500Z.dump');
      expect(await holdOf(urls.app)).toMatchObject({ held: true, hold: { held: true, reason: 'restored' } });
      const migrator = createDb(urls.migrator, { max: 1 });
      try {
        const rows = await migrator.execute(sql`SELECT backup FROM drizzle.restores`);
        expect(rows.rows).toEqual([{ backup: 'aviation_live-2026-10-24T031500Z.dump' }]);
      } finally {
        await closeDb(migrator);
      }
    });
  });

  it('a backup taken before migration 0020 starts held once the restored database is migrated', async () => {
    await withScratchEnvironment(
      localAdminUrl(),
      ENV,
      async (urls) => {
        // The restored schema of such a backup has no hold table: the restore records itself only.
        const migrator = createDb(urls.migrator, { max: 1 });
        try {
          expect((await migrator.execute(sql`SELECT to_regclass('public.paid_operations_hold') AS t`)).rows).toEqual([{ t: null }]);
        } finally {
          await closeDb(migrator);
        }
        await afterRestore(urls.migrator, 'aviation_live-2026-09-30T031500Z.dump');
        await runMigrations(urls.migrator);
        expect(await holdOf(urls.app)).toMatchObject({ held: true, hold: { reason: 'restored' } });
      },
      { upTo: '0019_lock_order' },
    );
  });

  it('an upgrade to migration 0020 without a restore holds nothing', async () => {
    await withScratchEnvironment(
      localAdminUrl(),
      ENV,
      async (urls) => {
        await runMigrations(urls.migrator);
        expect(await holdOf(urls.app)).toMatchObject({ held: false, hold: { reason: null } });
      },
      { upTo: '0019_lock_order' },
    );
  });
});
