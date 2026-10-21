import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import { loadConfig, type AppConfig } from '../../shared/config.js';

const APP_DIR = resolve(fileURLToPath(import.meta.url), '../../..');

/** Prefix for every index the integration tests create. */
export const TEST_INDEX_PREFIX = 'aviation-test-';

export function testConfig(): AppConfig {
  return loadConfig({ files: [resolve(APP_DIR, '.env.local')] });
}

/** Same credentials as the app, pointed at the aviation_test database. */
export function testDbUrl(role: 'app' | 'migrator' | 'ingest' = 'app'): string {
  const c = testConfig();
  const url = { app: c.databaseUrl, migrator: c.databaseMigratorUrl, ingest: c.databaseIngestUrl }[role];
  if (!url) throw new Error('Database URLs missing; run pnpm services:up && pnpm services:setup');
  const u = new URL(url);
  u.pathname = '/aviation_test';
  return u.toString();
}

export function testPool(role: 'app' | 'migrator' | 'ingest' = 'app'): pg.Pool {
  return new pg.Pool({ connectionString: testDbUrl(role), max: 2 });
}

/** Placeholder until Drizzle arrives (Task 5); returns a pool for aviation_test. */
export function testDb(): pg.Pool {
  return testPool('app');
}

function esClient(apiKey: string | undefined): Client {
  const c = testConfig().elasticsearch;
  if (!apiKey) throw new Error('Elasticsearch keys missing; run pnpm services:setup');
  return new Client({
    node: c.url,
    auth: { apiKey },
    ...(c.caFile ? { tls: { ca: readFileSync(c.caFile) } } : {}),
  });
}

/** Client using the WRITE key (aviation-* only). */
export function testEs(): Client {
  return esClient(testConfig().elasticsearch.writeApiKey);
}

/** Client using the READ key. */
export function testEsReader(): Client {
  return esClient(testConfig().elasticsearch.readApiKey);
}
