import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { closeDb, createDb } from './client.js';

export const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../migrations');

/** Arbitrary constant: serializes concurrent migration runs on one database. */
const MIGRATION_LOCK_KEY = 7_311_905_021;

/** Group role that owns the schema; every migration runs as it. */
export const MIGRATOR_ROLE = 'aviation_migrator';

/**
 * Apply pending migrations from `server/db/migrations` as the aviation_migrator group
 * role, which owns the schema. The URL's login must switch to it with the
 * `options=-c role=aviation_migrator` parameter (scripts/provision.ts); anything else
 * is refused, so objects never belong to an environment's login role. The journal
 * lives in the `drizzle` schema, which the runtime roles cannot read. Concurrent
 * runs wait on an advisory lock.
 */
export async function runMigrations(url: string): Promise<void> {
  const lock = new pg.Client({ connectionString: url, application_name: 'aviation-migrate' });
  await lock.connect();
  const db = createDb(url, { max: 1, applicationName: 'aviation-migrate' });
  try {
    const { rows } = await lock.query<{ current_user: string }>('SELECT current_user');
    if (rows[0]?.current_user !== MIGRATOR_ROLE) {
      throw new Error(`migrations must run as ${MIGRATOR_ROLE}; add options=-c role=${MIGRATOR_ROLE} to the migrator URL`);
    }
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await closeDb(db);
    await lock.end();
  }
}
