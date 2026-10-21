import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import { createDb, type Db } from '../../server/db/client.js';
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

/** Drizzle on aviation_test as the given role; close with `closeDb`. */
export function testDb(role: 'app' | 'migrator' | 'ingest' = 'app'): Db {
  return createDb(testDbUrl(role), { max: 2, applicationName: `aviation-test-${role}` });
}

/** Every table of the corpus schema, for resetting aviation_test between tests. */
const CORPUS_TABLES = [
  'quarantine', 'code_dictionary', 'case_section_sources', 'case_sections', 'case_sequence',
  'case_findings', 'case_engines', 'case_aircraft', 'cases', 'dataset_manifests',
  'dataset_generations', 'ingestion_runs',
];

/** Empty the corpus tables of aviation_test (migrator role; identities restart at 1). */
export async function resetCorpus(): Promise<void> {
  const pool = testPool('migrator');
  try {
    await pool.query(`TRUNCATE ${CORPUS_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`);
  } finally {
    await pool.end();
  }
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
