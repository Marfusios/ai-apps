/**
 * The HTTP API against the fixture corpus in the local `test` environment, for the test files
 * that call `useApiFixture` (each test file gets its own copy of this module): both fixture
 * sets loaded into aviation_test, verified, indexed under the file's own prefix and published
 * as a keyword-only manifest (tests/support/api-dataset.ts), and a web root with a page
 * template like the built one and one hashed asset. The bindings below are set by the file's
 * `beforeAll`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { buildApp, type AppDeps } from '../../server/app.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { deleteIndices, publishFixtureDataset, type FixtureDataset } from '../support/api-dataset.js';
import { testDb, testEs, testEsReader } from './helpers.js';

export const LOCAL = '127.0.0.1';

/** The ingestion login (loads and publishes the fixtures). */
export let ingest: Db;
/** The API's login (`aviation_app`). */
export let appDb: Db;
/** Elasticsearch with the write key (index set-up and clean-up). */
export let es: Client;
/** Elasticsearch with the read key, as the API reads it. */
export let reader: Client;
export let dataset: FixtureDataset;
/** The API on the fixture dataset, with a browsing limit no test reaches. */
export let app: FastifyInstance;
export let webRoot: string;

const apps: FastifyInstance[] = [];

/** A page template like the built one: the server replaces its title and description. */
const TEMPLATE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="description" content="Find and compare NTSB aviation investigations by their evidence, findings and probable causes." /><title>AirCase · aviation casebook</title></head><body><div id="root"></div></body></html>';

/** Another app on the fixture dataset (closed after the file's tests). */
export function makeApp(overrides: Partial<AppDeps> = {}): FastifyInstance {
  const built = buildApp({
    config: { appUrl: 'http://localhost:3000', trustedProxyCidrs: [] },
    db: appDb,
    es: reader,
    webRoot,
    rateLimit: { limit: 100_000, windowMs: 60_000 },
    ...overrides,
  });
  apps.push(built);
  return built;
}

export interface Got {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json: unknown;
}

export async function get(url: string, opts: { app?: FastifyInstance; from?: string; headers?: Record<string, string> } = {}): Promise<Got> {
  const r = await (opts.app ?? app).inject({ method: 'GET', url, remoteAddress: opts.from ?? LOCAL, headers: opts.headers ?? {} });
  let json: unknown = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    json = null;
  }
  return { status: r.statusCode, headers: r.headers, body: r.body, json };
}

/**
 * Publishes the fixture dataset under `aviation-test-{name}{random}` before the file's tests and
 * removes it after them; returns that prefix.
 */
export function useApiFixture(name: string): string {
  const prefix = `aviation-test-${name}${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    ingest = testDb('ingest');
    appDb = testDb('app');
    es = testEs();
    reader = testEsReader();
    dataset = await publishFixtureDataset(ingest, es, prefix);
    webRoot = mkdtempSync(join(tmpdir(), 'aviation-api-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), TEMPLATE);
    writeFileSync(join(webRoot, 'assets', 'app-0123abcd.js'), 'console.log(1);\n');
    app = makeApp();
  }, 180_000);
  afterAll(async () => {
    for (const a of apps) await a.close();
    if (es) await deleteIndices(es, prefix);
    if (ingest) await closeDb(ingest);
    if (appDb) await closeDb(appDb);
    if (webRoot) rmSync(webRoot, { recursive: true, force: true });
  });
  return prefix;
}
