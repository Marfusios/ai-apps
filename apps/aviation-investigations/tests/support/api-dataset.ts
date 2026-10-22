/**
 * Publishes the fixture corpus as the active dataset of the local `test` environment
 * (database aviation_test, indices aviation-test-*): load both fixture sets, verify,
 * import the report-link seed, build a cases index under its own prefix and publish a
 * keyword-only manifest, or, with `passages`, also a passages index built with the
 * fake embedder under the production model name (`FIXTURE_EMBEDDING`: the approved
 * passages contract applies; nothing is paid). Used by the API and brief integration
 * tests and by the end-to-end server (tests/e2e-real/server.ts). It resets
 * aviation_test's corpus first.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, type FakeEmbedder } from '../../worker/index/embed.js';
import { PASSAGES_EMBEDDING_DIMS, rebuildPassagesIndex } from '../../worker/index/passages-index.js';
import { publishGeneration } from '../../worker/index/publish.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { importSeedLinks } from '../../worker/ingest/report-links.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { resetCorpus, testDbUrl } from '../integration/helpers.js';
import { APP_DIR, makeCombinedExtractDir, removeDir } from './extract-dir.js';

export interface FixtureDataset {
  generationId: number;
  casesIndex: string;
  /** The published passages index; null for a keyword-only dataset. */
  passagesIndex: string | null;
}

/**
 * The embedding the fixture passages index is built for: fake vectors under the
 * production model name and dimensions, so the approved passages contract applies.
 * The API's dataset resolver must be configured with it (`AppDeps.embedding`).
 */
export const FIXTURE_EMBEDDING = Object.freeze({ model: 'text-embedding-3-small', dims: PASSAGES_EMBEDDING_DIMS });

/** A fake embedder for the fixture passages index and its queries (hash vectors, no cost). */
export const fixtureEmbedder = (): FakeEmbedder => createFakeEmbedder(FIXTURE_EMBEDDING.dims, FIXTURE_EMBEDDING.model);

/** Index prefixes the test write key may use start with this. */
export const TEST_PREFIX = 'aviation-test-';

export async function publishFixtureDataset(ingest: Db, es: Client, prefix: string, opts: { passages?: boolean } = {}): Promise<FixtureDataset> {
  if (!prefix.startsWith(TEST_PREFIX)) throw new Error(`prefix must start with ${TEST_PREFIX}`);
  const generationId = await loadFixtureGeneration(ingest);
  const built = await rebuildCasesIndex(es, ingest, { generationId, prefix });
  const passagesIndex = opts.passages ? await buildFixturePassagesIndex(es, generationId, prefix) : null;
  await publishGeneration(es, ingest, {
    generationId,
    casesIndex: built.index,
    passagesIndex,
    ...(passagesIndex ? { embedding: FIXTURE_EMBEDDING } : {}),
  });
  return { generationId, casesIndex: built.index, passagesIndex };
}

/** Chunk, fake-embed and index the generation's answer-eligible passages; returns the index name. */
export async function buildFixturePassagesIndex(es: Client, generationId: number, prefix: string): Promise<string> {
  // A passages build reads and writes on separate connections: its own small pool.
  const db = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-passages' });
  try {
    const built = await rebuildPassagesIndex(es, db, fixtureEmbedder(), {
      generationId,
      prefix,
      gate: createMemorySpendGate(1),
      confirmCost: true,
    });
    return built.index;
  } finally {
    await closeDb(db);
  }
}

/**
 * Reset aviation_test's corpus, load both fixture sets as one generation, verify it and
 * import the report-link seed. PostgreSQL only; returns the generation id.
 */
export async function loadFixtureGeneration(ingest: Db): Promise<number> {
  await resetCorpus();
  const dir = await makeCombinedExtractDir();
  const reports = mkdtempSync(join(tmpdir(), 'aviation-api-verify-'));
  try {
    const { generationId } = await loadFromExtract(ingest, dir);
    const verified = await verifyCorpus(ingest, generationId, { outDir: reports, profile: null });
    if (!verified.ok) throw new Error(`fixture generation ${generationId} failed verification`);
    await importSeedLinks(ingest, join(APP_DIR, 'fixtures/report-links-seed.json'));
    return generationId;
  } finally {
    removeDir(dir);
    removeDir(reports);
  }
}

/** Delete every index under `prefix` (the write key can only see aviation-test-*). */
export async function deleteIndices(es: Client, prefix: string): Promise<void> {
  if (!prefix.startsWith(TEST_PREFIX)) throw new Error(`prefix must start with ${TEST_PREFIX}`);
  const found = await es.indices.get({ index: `${prefix}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  for (const index of Object.keys(found)) await es.indices.delete({ index });
}
