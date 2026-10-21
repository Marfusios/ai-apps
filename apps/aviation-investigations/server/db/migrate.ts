import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { closeDb, createDb } from './client.js';

export const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../migrations');

/** Arbitrary constant: serializes concurrent migration runs on one database. */
const MIGRATION_LOCK_KEY = 7_311_905_021;

/**
 * Apply pending migrations from `server/db/migrations` as the connecting role (the
 * migrator role, which owns the schema). The journal lives in the `drizzle` schema,
 * which the runtime roles cannot read. Concurrent runs wait on an advisory lock.
 */
export async function runMigrations(url: string): Promise<void> {
  const lock = new pg.Client({ connectionString: url, application_name: 'aviation-migrate' });
  await lock.connect();
  const db = createDb(url, { max: 1, applicationName: 'aviation-migrate' });
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await closeDb(db);
    await lock.end();
  }
}
