/**
 * The real API server for `pnpm test:e2e:real`: publishes the fixture corpus as the
 * active dataset of the local `test` environment (aviation_test, an aviation-test-e2e*
 * cases index; tests/support/api-dataset.ts), then serves the API and the built web
 * client (`dist/web`) on 127.0.0.1:E2E_REAL_PORT (default 5181), exactly as
 * production does: same origin, CSP and all. The indices are deleted on exit.
 *
 * It resets aviation_test's corpus, so do not run it alongside `pnpm test:integration`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../server/app.js';
import { closeDb } from '../../server/db/client.js';
import { deleteIndices, publishFixtureDataset } from '../support/api-dataset.js';
import { APP_DIR } from '../support/extract-dir.js';
import { testDb, testEs, testEsReader } from '../integration/helpers.js';

const port = Number(process.env.E2E_REAL_PORT) || 5181;
const prefix = `aviation-test-e2e${randomBytes(4).toString('hex')}`;
const webRoot = join(APP_DIR, 'dist/web');
if (!existsSync(join(webRoot, 'index.html'))) {
  console.error('dist/web is missing; run pnpm build:web first');
  process.exit(2);
}

const ingest = testDb('ingest');
const db = testDb('app');
const writer = testEs();
const reader = testEsReader();
const dataset = await publishFixtureDataset(ingest, writer, prefix);
await closeDb(ingest);
console.log(`fixture dataset: generation ${dataset.generationId}, ${dataset.casesIndex}`);

// Every browser of the parallel workers shares 127.0.0.1: raise the per-identity limit
// so tests never trip it (tests/integration/api-search.test.ts covers the limit).
const app = buildApp({
  config: { appUrl: `http://127.0.0.1:${port}`, trustedProxyCidrs: [] },
  db,
  es: reader,
  webRoot,
  rateLimit: { limit: 10_000, windowMs: 60_000 },
});
await app.listen({ host: '127.0.0.1', port });
console.log(`e2e server on http://127.0.0.1:${port}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close().catch(() => undefined);
  await deleteIndices(writer, prefix).catch(() => undefined);
  await Promise.allSettled([closeDb(db), writer.close(), reader.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
