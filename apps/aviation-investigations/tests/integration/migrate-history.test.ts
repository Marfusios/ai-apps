/**
 * The migrator over databases that recorded an earlier version of a migration (Task 22 fix
 * round 3). Migrations 0020 and 0021 changed after the local test database had recorded their
 * first versions, and drizzle's rule ("apply what is newer than the newest recorded") would
 * never apply the changes. Over such a database the migrator runs the current version again,
 * which converges to the schema a fresh database gets; anything else it cannot continue from
 * stops it with nothing changed. Scratch environments on the local server only.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { closeDb, createDb } from '../../server/db/client.js';
import { MigrationHistoryError, REAPPLIED_MIGRATIONS, migrationFiles, runMigrations } from '../../server/db/migrate.js';
import { comparePrivileges, privilegeSnapshot } from '../../server/db/privileges.js';
import { EXPECTED_PRIVILEGES } from '../../server/db/privileges-expected.js';
import { localAdminUrl, withScratchEnvironment } from '../../scripts/scratch-env.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/earlier-migrations');
const FILES = migrationFiles();
const when = (tag: string): number => FILES.find((f) => f.tag === tag)!.folderMillis;
const BEFORE = '0019_lock_order';

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** An earlier version as the migrator applied it: its statements, then its journal row. */
async function applyEarlier(c: pg.Client, tag: string, version: 'first' | 'round2'): Promise<string> {
  const text = readFileSync(resolve(FIXTURES, `${tag}.${version}.sql`), 'utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  expect(REAPPLIED_MIGRATIONS[tag]).toContain(hash);
  await c.query('BEGIN');
  for (const statement of text.split('--> statement-breakpoint')) await c.query(statement);
  await c.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [hash, when(tag)]);
  await c.query('COMMIT');
  return text;
}

const journal = (c: pg.Client) =>
  c.query<{ created_at: string; hash: string }>('SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at').then((r) => r.rows);

/** Columns, constraints, indexes, functions and triggers of the app's schemas, without data. */
async function schemaOf(url: string): Promise<Record<string, string[]>> {
  return withClient(url, async (c) => {
    const rows = async (text: string) => (await c.query(text)).rows.map((r: Record<string, unknown>) => Object.values(r).join(' | ')).sort();
    return {
      columns: await rows(`
        SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'v') AND a.attnum > 0 AND NOT a.attisdropped`),
      constraints: await rows(`
        SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
        WHERE connamespace IN ('public'::regnamespace, 'drizzle'::regnamespace)`),
      indexes: await rows(`SELECT schemaname, indexname, indexdef FROM pg_indexes WHERE schemaname IN ('public', 'drizzle')`),
      functions: await rows(`
        SELECT p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid)) FROM pg_proc p
        WHERE p.pronamespace IN ('public'::regnamespace, 'drizzle'::regnamespace) AND p.prokind = 'f'`),
      triggers: await rows(`SELECT tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal`),
    };
  });
}

async function expectAsFresh(url: string, fresh: Record<string, string[]>): Promise<void> {
  expect(await schemaOf(url)).toEqual(fresh);
  const db = createDb(url, { max: 1 });
  try {
    expect(comparePrivileges(await privilegeSnapshot(db), EXPECTED_PRIVILEGES)).toEqual({ missing: [], unexpected: [] });
  } finally {
    await closeDb(db);
  }
}

describe('a database that recorded an earlier version of 0020 and 0021', () => {
  it('gets the current versions run again, which leave the schema and grants of a fresh database', async () => {
    const fresh = await withScratchEnvironment(localAdminUrl(), 'migfresh', (urls) => schemaOf(urls.migrator));
    const states: { name: string; build: (c: pg.Client) => Promise<void> }[] = [
      {
        // The local test database: the first versions, and the second version's additions to 0021 applied by hand.
        name: 'first versions, plus the 0021 additions applied by hand',
        build: async (c) => {
          await applyEarlier(c, '0020_restore_hold', 'first');
          await applyEarlier(c, '0021_live_brief_generations', 'first');
          const round2 = readFileSync(resolve(FIXTURES, '0021_live_brief_generations.round2.sql'), 'utf8');
          const marker = 'GRANT EXECUTE ON FUNCTION generations_cited_by_live_briefs() TO aviation_ingest;';
          for (const statement of round2.slice(round2.indexOf(marker) + marker.length).split('--> statement-breakpoint')) await c.query(statement);
        },
      },
      {
        name: 'the versions of fix round 2',
        build: async (c) => {
          await applyEarlier(c, '0020_restore_hold', 'round2');
          await applyEarlier(c, '0021_live_brief_generations', 'round2');
        },
      },
    ];
    for (const state of states) {
      await withScratchEnvironment(
        localAdminUrl(),
        'mighist',
        async (urls) => {
          await withClient(urls.migrator, state.build);
          const report = await runMigrations(urls.migrator);
          expect(report, state.name).toEqual({ applied: [], reapplied: ['0020_restore_hold', '0021_live_brief_generations'] });
          const recorded = await withClient(urls.migrator, journal);
          expect(recorded.map((r) => r.hash)).toEqual(FILES.map((f) => f.hash));
          await expectAsFresh(urls.migrator, fresh);
          // The hold row the earlier version wrote stays as it was: paid operations not held.
          const hold = await withClient(urls.migrator, (c) => c.query('SELECT held_at FROM paid_operations_hold').then((r) => r.rows));
          expect(hold).toEqual([{ held_at: null }]);
          // Nothing is run twice.
          expect(await runMigrations(urls.migrator)).toEqual({ applied: [], reapplied: [] });
        },
        { upTo: BEFORE },
      );
    }
  }, 180_000);
});

describe('a database this checkout cannot continue from', () => {
  it('stops the migrator with the reason and the documented reset, and nothing changes', async () => {
    await withScratchEnvironment(localAdminUrl(), 'mighist', async (urls) =>
      withClient(urls.migrator, async (c) => {
        const before = await journal(c);
        for (const [tag, problem] of [
          [BEFORE, `${BEFORE} is recorded with other content than this checkout's`],
          ['0021_live_brief_generations', "0021_live_brief_generations is recorded with other content than this checkout's"],
        ] as const) {
          await c.query('UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2', ['e'.repeat(64), when(tag)]);
          const err = await runMigrations(urls.migrator).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(MigrationHistoryError);
          expect((err as Error).message).toContain(problem);
          expect((err as Error).message).toMatch(/docs\/RUNBOOK\.md \("Local-services mode"\)/);
          await c.query('UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2', [FILES.find((f) => f.tag === tag)!.hash, when(tag)]);
        }
        expect(await journal(c)).toEqual(before);
      }),
    );
    await withScratchEnvironment(
      localAdminUrl(),
      'mighist',
      async (urls) =>
        withClient(urls.migrator, async (c) => {
          // Another checkout's later migration, recorded without 0020 and 0021: drizzle would skip them.
          const later = when('0021_live_brief_generations') + 60_000;
          await c.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', ['f'.repeat(64), later]);
          let err = await runMigrations(urls.migrator).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(MigrationHistoryError);
          expect((err as Error).message).toContain('0020_restore_hold is not recorded, although later migrations are');
          expect((err as Error).message).toContain('0021_live_brief_generations is not recorded, although later migrations are');
          // An earlier 0020 and 0021 below it: the later migration may change what they define, so they are not run again.
          await c.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1', [later]);
          await applyEarlier(c, '0020_restore_hold', 'first');
          await applyEarlier(c, '0021_live_brief_generations', 'first');
          await c.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', ['f'.repeat(64), later]);
          const before = await journal(c);
          err = await runMigrations(urls.migrator).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(MigrationHistoryError);
          expect((err as Error).message).toContain(`a migration of ${later} this checkout does not have is recorded after 0020_restore_hold`);
          expect(await journal(c)).toEqual(before);
        }),
      { upTo: BEFORE },
    );
  }, 180_000);
});
