import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';

export const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../migrations');

/** Arbitrary constant: serializes concurrent migration runs on one database. */
const MIGRATION_LOCK_KEY = 7_311_905_021;

/** Group role that owns the schema objects; every migration runs as it. */
export const MIGRATOR_ROLE = 'aviation_migrator';

/** Journal of applied migrations, in drizzle's format (drizzle-kit reads the same table). */
const JOURNAL = 'drizzle.__drizzle_migrations';

/**
 * Apply pending migrations from `server/db/migrations` as the aviation_migrator group
 * role. The URL's login must switch to it with the `options=-c role=aviation_migrator`
 * parameter (scripts/provision.ts); anything else is refused, so objects never belong
 * to an environment's login role.
 *
 * This is drizzle's migrator (same journal table, same "newer than the last applied
 * timestamp" rule, one transaction for all pending migrations) without its
 * `CREATE SCHEMA IF NOT EXISTS drizzle`: PostgreSQL checks database-level CREATE for
 * that statement even when the schema exists, and aviation_migrator holds no
 * database privilege at all. Provisioning creates the `drizzle` schema, owned by
 * aviation_migrator; the runtime roles cannot read it. Concurrent runs wait on an
 * advisory lock.
 */
export async function runMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'aviation-migrate' });
  await client.connect();
  try {
    const { rows } = await client.query<{ current_user: string; journal: boolean }>(
      `SELECT current_user, EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') AS journal`,
    );
    if (rows[0]?.current_user !== MIGRATOR_ROLE) {
      throw new Error(`migrations must run as ${MIGRATOR_ROLE}; add options=-c role=${MIGRATOR_ROLE} to the migrator URL`);
    }
    if (!rows[0].journal) {
      throw new Error('schema drizzle is missing; provision the database first (pnpm services:setup or pnpm provision:shared)');
    }
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${JOURNAL} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    const last = (await client.query<{ created_at: string }>(`SELECT created_at FROM ${JOURNAL} ORDER BY created_at DESC LIMIT 1`)).rows[0];
    const pending = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).filter(
      (m) => !last || Number(last.created_at) < m.folderMillis,
    );
    if (pending.length === 0) return;
    await client.query('BEGIN');
    try {
      for (const m of pending) {
        for (const statement of m.sql) await client.query(statement);
        await client.query(`INSERT INTO ${JOURNAL} (hash, created_at) VALUES ($1, $2)`, [m.hash, m.folderMillis]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    await client.end();
  }
}
