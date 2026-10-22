import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import { createDb, type Db } from '../../server/db/client.js';
import { CONTROL_TABLES } from '../../server/db/schema/index.js';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';

const APP_DIR = resolve(fileURLToPath(import.meta.url), '../../..');

/** Prefix for every index the integration tests create. */
export const TEST_INDEX_PREFIX = 'aviation-test-';

export function testConfig(): AppConfig {
  return loadConfig({ files: [resolve(APP_DIR, '.env.local')] });
}

/**
 * Credentials of the local `test` environment (database aviation_test, indices
 * aviation-test-*), written by `pnpm services:setup`. Nonempty process values win,
 * so the suite can run against another server (scripts/test-pg16.ts).
 */
const TEST_VARS = [
  'TEST_DATABASE_URL',
  'TEST_DATABASE_INGEST_URL',
  'TEST_DATABASE_MIGRATOR_URL',
  'TEST_ELASTICSEARCH_READ_API_KEY',
  'TEST_ELASTICSEARCH_WRITE_API_KEY',
] as const;
type TestVar = (typeof TEST_VARS)[number];

function testVar(name: TestVar): string | undefined {
  return process.env[name] || readDotenvAllowlisted(resolve(APP_DIR, '.env.local'), TEST_VARS)[name];
}

/** URL of the aviation_test login for `role`; it acts as the matching group role. */
export function testDbUrl(role: 'app' | 'migrator' | 'ingest' = 'app'): string {
  const name = ({ app: 'TEST_DATABASE_URL', migrator: 'TEST_DATABASE_MIGRATOR_URL', ingest: 'TEST_DATABASE_INGEST_URL' } as const)[role];
  const url = testVar(name);
  if (!url) throw new Error(`${name} missing; run pnpm services:up && pnpm services:setup`);
  return url;
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
  'passages', 'report_links', 'quarantine', 'code_dictionary', 'case_section_sources', 'case_sections', 'case_sequence',
  'case_findings', 'case_engines', 'case_aircraft', 'cases', 'dataset_manifests', 'generation_pins',
  'dataset_generations', 'ingestion_runs',
];

/** Empty the corpus tables of aviation_test (migrator role, TRUNCATE bypasses the row guards; identities restart at 1). */
export async function resetCorpus(): Promise<void> {
  const pool = testPool('migrator');
  try {
    await pool.query(`TRUNCATE ${CORPUS_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`);
  } finally {
    await pool.end();
  }
}

/** Empty the cost-control tables of aviation_test and re-enable the kill switch (migrator role; TRUNCATE bypasses the guards). */
export async function resetControls(): Promise<void> {
  const pool = testPool('migrator');
  try {
    await pool.query(`TRUNCATE ${CONTROL_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`);
    await pool.query(`UPDATE ai_switch SET enabled = true, note = NULL, updated_at = now() WHERE id = 1`);
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

/** Client using the test environment's WRITE key (aviation-test-* only). */
export function testEs(): Client {
  return esClient(testVar('TEST_ELASTICSEARCH_WRITE_API_KEY'));
}

/** Client using the test environment's READ key. */
export function testEsReader(): Client {
  return esClient(testVar('TEST_ELASTICSEARCH_READ_API_KEY'));
}
