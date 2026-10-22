/**
 * Publishes the fixture corpus as the active dataset of the local `test` environment
 * (database aviation_test, indices aviation-test-*): load both fixture sets, verify,
 * import the report-link seed, build a cases index under its own prefix and publish a
 * keyword-only manifest. Used by the API integration tests and by the end-to-end
 * server (tests/e2e-real/server.ts). It resets aviation_test's corpus first.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import type { Db } from '../../server/db/client.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { publishGeneration } from '../../worker/index/publish.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { importSeedLinks } from '../../worker/ingest/report-links.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { resetCorpus } from '../integration/helpers.js';
import { APP_DIR, makeCombinedExtractDir, removeDir } from './extract-dir.js';

export interface FixtureDataset {
  generationId: number;
  casesIndex: string;
}

/** Index prefixes the test write key may use start with this. */
export const TEST_PREFIX = 'aviation-test-';

export async function publishFixtureDataset(ingest: Db, es: Client, prefix: string): Promise<FixtureDataset> {
  if (!prefix.startsWith(TEST_PREFIX)) throw new Error(`prefix must start with ${TEST_PREFIX}`);
  const generationId = await loadFixtureGeneration(ingest);
  const built = await rebuildCasesIndex(es, ingest, { generationId, prefix });
  await publishGeneration(es, ingest, { generationId, casesIndex: built.index, passagesIndex: null });
  return { generationId, casesIndex: built.index };
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
