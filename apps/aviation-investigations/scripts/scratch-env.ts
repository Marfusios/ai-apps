/**
 * Throwaway environments on the local services (pnpm services:up), for checks that need a
 * database provisioned and migrated with this checkout and nothing else: the restore
 * commands' tests and `pnpm db:privileges`. The administrator URL comes from .env.local (or
 * TEST_PG_ADMIN_URL), as in tests/integration/provision.test.ts. Never prints credentials.
 */
import { resolve } from 'node:path';
import pg from 'pg';
import { DB_CONNECT_TIMEOUT_MS } from '../server/db/client.js';
import { runMigrations } from '../server/db/migrate.js';
import { readDotenvAllowlisted } from '../shared/env-files.js';
import { APP_DIR } from './local-env.js';
import { databaseName, loginRole, ownerRole, provisionPostgres, roleUrl, ROLE_KINDS, type RoleKind } from './provision.js';

/** Administrator URL of the local services (or TEST_PG_ADMIN_URL). */
export function localAdminUrl(): string {
  if (process.env.TEST_PG_ADMIN_URL) return process.env.TEST_PG_ADMIN_URL;
  const local = readDotenvAllowlisted(resolve(APP_DIR, '.env.local'), ['POSTGRES_PASSWORD', 'POSTGRES_PORT']);
  if (!local.POSTGRES_PASSWORD) throw new Error('POSTGRES_PASSWORD missing from .env.local; run pnpm services:up');
  return `postgres://postgres:${encodeURIComponent(local.POSTGRES_PASSWORD)}@127.0.0.1:${local.POSTGRES_PORT ?? 55432}/postgres`;
}

/** Remove environment `env` (its database, logins and owner role); the shared group roles stay. */
export async function dropEnvironment(adminUrl: string, env: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName(env)} WITH (FORCE)`);
    for (const k of ROLE_KINDS) await admin.query(`DROP ROLE IF EXISTS ${loginRole(env, k)}`);
    await admin.query(`DROP ROLE IF EXISTS ${ownerRole(env)}`);
  } finally {
    await admin.end();
  }
}

/**
 * Provision and migrate throwaway environment `env`, run `fn` with its role URLs, and remove
 * it again, also when `fn` fails.
 */
export async function withScratchEnvironment<T>(
  adminUrl: string,
  env: string,
  fn: (urls: Record<RoleKind, string>) => Promise<T>,
): Promise<T> {
  await dropEnvironment(adminUrl, env);
  try {
    const passwords = await provisionPostgres({ env, adminUrl, log: () => undefined });
    const urls = Object.fromEntries(ROLE_KINDS.map((k) => [k, roleUrl(adminUrl, env, k, passwords[k])])) as Record<RoleKind, string>;
    await runMigrations(urls.migrator);
    return await fn(urls);
  } finally {
    await dropEnvironment(adminUrl, env);
  }
}
