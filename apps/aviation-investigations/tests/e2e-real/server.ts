/**
 * The real API server for `pnpm test:e2e:real`: publishes the fixture corpus as the
 * active dataset of the local `test` environment (aviation_test, aviation-test-e2e*
 * cases and passages indices; tests/support/api-dataset.ts), then serves the API and the
 * built web client (`dist/web`) on 127.0.0.1:E2E_REAL_PORT (default 5181), exactly as
 * production does: same origin, CSP and all. The indices are deleted on exit.
 *
 * AI is on, offline: the AI evidence view (`POST /api/evidence`) runs the production
 * pipeline (admission, quotas, ledger, retrieval, projection, storage) with the repository's
 * fakes in place of every provider, as tests/integration/evidence.test.ts does: the fake
 * language-model provider with a scripted scope stage (tests/e2e-real/evidence-fakes.ts),
 * the deterministic fake embedder the fixture passages index is built with, and Cloudflare's
 * always-passing Turnstile test keys answered by a local stand-in for siteverify. Nothing
 * leaves the machine. Generated briefs stay off (`AI_BRIEFS_ENABLED=false`).
 *
 * It resets aviation_test's corpus and control tables, so do not run it alongside
 * `pnpm test:integration`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../shared/config.js';
import { createFakeProvider } from '../../server/ai/fake.js';
import { createAiRuntime } from '../../server/ai/runtime.js';
import { buildApp } from '../../server/app.js';
import { closeDb } from '../../server/db/client.js';
import { createEvidenceRetriever, createEvidenceServices } from '../../server/evidence/retrieve.js';
import { TURNSTILE_TEST_SECRET_KEYS, TURNSTILE_TEST_SITE_KEYS } from '../../server/identity/turnstile.js';
import { deleteIndices, fixtureEmbedder, FIXTURE_EMBEDDING, publishFixtureDataset } from '../support/api-dataset.js';
import { APP_DIR } from '../support/extract-dir.js';
import { FakeSiteverify } from '../support/fake-siteverify.js';
import { resetControls, testDb, testEs, testEsReader } from '../integration/helpers.js';
import { e2eEvidenceScope } from './evidence-fakes.js';

const port = Number(process.env.E2E_REAL_PORT) || 5181;
const appUrl = `http://127.0.0.1:${port}`;
const prefix = `aviation-test-e2e${randomBytes(4).toString('hex')}`;
const webRoot = join(APP_DIR, 'dist/web');
if (!existsSync(join(webRoot, 'index.html'))) {
  console.error('dist/web is missing; run pnpm build:web first');
  process.exit(2);
}

// Synthetic secrets and Cloudflare's documented always-passing test keys; nothing real.
const config = loadConfig({
  files: [],
  env: {
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    APP_URL: appUrl,
    AI_LLM_PROVIDER: 'fake',
    AI_BRIEFS_ENABLED: 'false',
    IDENTITY_HMAC_SECRET: 'e2e-real-identity-hmac-secret-0123456789',
    IP_HMAC_SECRET: 'e2e-real-network-hmac-secret-0123456789',
    TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEYS[0],
    TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_KEYS[0],
  },
});

await resetControls();
const ingest = testDb('ingest');
const db = testDb('app');
const writer = testEs();
const reader = testEsReader();
const dataset = await publishFixtureDataset(ingest, writer, prefix, { passages: true });
await closeDb(ingest);
console.log(`fixture dataset: generation ${dataset.generationId}, ${dataset.casesIndex}, ${dataset.passagesIndex}`);

const siteverify = new FakeSiteverify(() => new Date(), { hostname: '127.0.0.1', action: 'ask-ai' });
const ai = createAiRuntime(config, {
  db,
  llm: createFakeProvider({ evidenceScope: e2eEvidenceScope }),
  turnstile: { fetch: siteverify.fetch, retryDelayMs: 0 },
  // Every browser of the parallel workers is one network, 127.0.0.1: new trials are not limited.
  trialLimits: { perNetworkHour: 10_000, perNetworkDay: 10_000, globalDay: 10_000 },
});
if (ai.problems.length > 0 || !ai.policy) throw new Error(`AI is off: ${ai.problems.join('; ')}`);
// The same network for every test: the attempt and in-flight limits are raised so tests never
// trip them (tests/integration/quota.test.ts covers them). The daily allowances stay as configured.
Object.assign(ai.policy.limits, {
  anonymousPerMinute: 1_000,
  accountPerMinute: 1_000,
  anonymousNetworkPerHour: 100_000,
  anonymousNetworkPerDay: 100_000,
  accountNetworkPerHour: 100_000,
  accountNetworkPerDay: 100_000,
  anonymousInFlight: 100,
  globalInFlight: 100,
});

// Every browser of the parallel workers shares 127.0.0.1: raise the per-identity limit
// so tests never trip it (tests/integration/api-search.test.ts covers the limit).
const app = buildApp({
  config,
  db,
  es: reader,
  ai,
  evidence: createEvidenceServices(createEvidenceRetriever(db, reader, fixtureEmbedder())),
  embedding: FIXTURE_EMBEDDING,
  webRoot,
  rateLimit: { limit: 10_000, windowMs: 60_000 },
});
await app.listen({ host: '127.0.0.1', port });
console.log(`e2e server on ${appUrl}, AI evidence search on (offline fakes)`);

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
