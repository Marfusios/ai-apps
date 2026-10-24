import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { DB_CONNECT_TIMEOUT_MS } from './client.js';

export const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../migrations');

/** Arbitrary constant: serializes concurrent migration runs on one database. */
const MIGRATION_LOCK_KEY = 7_311_905_021;

/** Group role that owns the schema objects; every migration runs as it. */
export const MIGRATOR_ROLE = 'aviation_migrator';

/** Journal of applied migrations, in drizzle's format (drizzle-kit reads the same table). */
const JOURNAL = 'drizzle.__drizzle_migrations';

/**
 * Migrations rewritten after a database had recorded an earlier version, and the versions
 * (content hashes, as the journal records them) that may be found recorded (Task 22 fix
 * round 3). Only the local test database ever recorded one: 0020 and 0021 as first written
 * (dev and live were at 0016 and 0019 when they were rewritten). Their current statements
 * converge from each version listed (CREATE ... IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT
 * DO NOTHING), so `runMigrations` runs the current version again over such a database and
 * records its hash. Any other difference stops it (`MigrationHistoryError`).
 */
export const REAPPLIED_MIGRATIONS: Readonly<Record<string, readonly string[]>> = {
  '0020_restore_hold': [
    '8cb05322be6607f2bc9fcdd1292641361eeb41c3359754b1b6f1803d84d9afbc', // first version
    '87f7ecf169a167703d2d406db173f0c8ee76f03fd05d230c4a7bdbc68ed1e1b8', // fix round 2
  ],
  '0021_live_brief_generations': [
    '60bff47ec86a060670eafec3f996feb0df08c68425f352f14a94ff50d15adc32', // first version
    '6be21c32602537564b060bfddc20e882f5888541dc6f00252c1c8a7fa6bd0328', // fix round 2
  ],
};

export interface MigrationFile {
  tag: string;
  folderMillis: number;
  /** sha256 of the file, as the journal records it. */
  hash: string;
  sql: string[];
}

export interface RecordedMigration {
  hash: string;
  createdAt: number;
}

/** The checkout's migrations in journal order, with their tags. */
export function migrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  const journal = JSON.parse(readFileSync(resolve(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  const files = readMigrationFiles({ migrationsFolder: dir });
  return files.map((m, i) => {
    const entry = journal.entries[i];
    if (!entry || entry.when !== m.folderMillis) throw new Error('the migration journal and files disagree');
    return { tag: entry.tag, folderMillis: m.folderMillis, hash: m.hash, sql: m.sql };
  });
}

/**
 * What a database recorded, against this checkout's migrations (`lastMillis`: up to that
 * migration only): those to run again over an earlier recorded version (REAPPLIED_MIGRATIONS),
 * and every difference that stops migrating. Drizzle's rule ("apply what is newer than the
 * newest recorded") would skip a migration missing below the newest one, and never notice one
 * recorded with other content, leaving the schema different from the code's.
 */
export function planRecorded(
  files: readonly MigrationFile[],
  recorded: readonly RecordedMigration[],
  lastMillis = Number.POSITIVE_INFINITY,
): { reapply: MigrationFile[]; problems: string[] } {
  const hashes = new Map(recorded.map((r) => [r.createdAt, r.hash]));
  const newest = Math.max(Number.NEGATIVE_INFINITY, ...recorded.map((r) => r.createdAt));
  const reapply: MigrationFile[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const hash = hashes.get(f.folderMillis);
    if (hash === undefined) {
      if (f.folderMillis < newest) problems.push(`${f.tag} is not recorded, although later migrations are (another checkout migrated this database)`);
      continue;
    }
    if (hash === f.hash) continue;
    if (REAPPLIED_MIGRATIONS[f.tag]?.includes(hash)) {
      if (f.folderMillis <= lastMillis) reapply.push(f);
      continue;
    }
    problems.push(`${f.tag} is recorded with other content than this checkout's (${hash.slice(0, 12)})`);
  }
  const first = reapply[0];
  if (first) {
    // A later migration may change what it defines: run it again only below migrations that are re-run too.
    const tags = new Map(files.map((f) => [f.folderMillis, f.tag]));
    for (const r of recorded) {
      if (r.createdAt <= first.folderMillis) continue;
      const tag = tags.get(r.createdAt);
      if (tag === undefined || !(tag in REAPPLIED_MIGRATIONS)) {
        problems.push(`${tag ?? `a migration of ${r.createdAt} this checkout does not have`} is recorded after ${first.tag}, which cannot be run again below it`);
      }
    }
  }
  return { reapply, problems };
}

/** A database whose recorded migrations this checkout cannot continue from; nothing was changed. */
export class MigrationHistoryError extends Error {
  constructor(database: string, problems: readonly string[]) {
    super(
      `${database}: not migrated, its recorded migrations differ from this checkout's: ${problems.join('; ')}. ` +
        'The local test database is reset as docs/RUNBOOK.md ("Local-services mode") describes; on any other database, ' +
        'find out what applied the differing migration before going on.',
    );
    this.name = 'MigrationHistoryError';
  }
}

export interface MigrationReport {
  /** Migrations applied for the first time. */
  applied: string[];
  /** Migrations run again over an earlier recorded version (REAPPLIED_MIGRATIONS). */
  reapplied: string[];
}

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
 *
 * Before that, the recorded migrations are compared with this checkout's (`planRecorded`):
 * one recorded in an earlier version listed in REAPPLIED_MIGRATIONS is run again (in the same
 * transaction, which also records its current hash), and any other difference stops the run
 * with `MigrationHistoryError`, changing nothing.
 *
 * `upTo` (tests only) stops after the migration with that tag, to build a database of an
 * earlier schema (for example a backup taken before a migration).
 */
export async function runMigrations(url: string, opts: { upTo?: string } = {}): Promise<MigrationReport> {
  const files = migrationFiles();
  let lastMillis = Number.POSITIVE_INFINITY;
  if (opts.upTo !== undefined) {
    const entry = files.find((f) => f.tag === opts.upTo);
    if (!entry) throw new Error(`no migration ${opts.upTo}`);
    lastMillis = entry.folderMillis;
  }
  const client = new pg.Client({ connectionString: url, application_name: 'aviation-migrate', connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS });
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
    const recorded = (await client.query<{ hash: string; created_at: string }>(`SELECT hash, created_at FROM ${JOURNAL}`)).rows.map((r) => ({
      hash: r.hash,
      createdAt: Number(r.created_at),
    }));
    const { reapply, problems } = planRecorded(files, recorded, lastMillis);
    if (problems.length > 0) {
      const name = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? 'the database';
      throw new MigrationHistoryError(name, problems);
    }
    const newest = Math.max(Number.NEGATIVE_INFINITY, ...recorded.map((r) => r.createdAt));
    const pending = files.filter((m) => newest < m.folderMillis && m.folderMillis <= lastMillis);
    const report: MigrationReport = { applied: pending.map((m) => m.tag), reapplied: reapply.map((m) => m.tag) };
    if (pending.length === 0 && reapply.length === 0) return report;
    await client.query('BEGIN');
    try {
      for (const m of reapply) {
        for (const statement of m.sql) await client.query(statement);
        await client.query(`UPDATE ${JOURNAL} SET hash = $1 WHERE created_at = $2`, [m.hash, m.folderMillis]);
      }
      for (const m of pending) {
        for (const statement of m.sql) await client.query(statement);
        await client.query(`INSERT INTO ${JOURNAL} (hash, created_at) VALUES ($1, $2)`, [m.hash, m.folderMillis]);
      }
      await client.query('COMMIT');
      return report;
    } catch (e) {
      // The migration's own error is what matters; a failed ROLLBACK (for example on a
      // broken connection, which discards the transaction anyway) must not replace it.
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    await client.end();
  }
}
