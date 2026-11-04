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
 * A second app on the same dataset and database, http://127.0.0.1:E2E_REAL_V3_PORT (default
 * E2E_REAL_PORT + 3), serves the reviewed state policy (live ran it until 31 October 2026) instead
 * of the server's defaults: the question alone in keyword search, in match order (`er-q-v1`), and a state the
 * question names applied automatically by the guarded policy (`state-explicit.v1.3`), for
 * tests/e2e-real/evidence-v3.spec.ts. Like two replicas, the two apps share the quota and search
 * tables.
 *
 * A third app, http://127.0.0.1:E2E_REAL_LIVE_PORT (default E2E_REAL_PORT + 4), runs what live runs
 * since 31 October 2026, for the search checklist, ratings and the admin page (Task 25,
 * tests/e2e-real/search-checklist.spec.ts and admin.spec.ts): the question alone in keyword search
 * with the leading 50 results put in order by the (fake) reranker (`er-q-h50-v1`), no filter applied
 * on its own, and Google sign-in through the stand-in of tests/e2e-real/auth-server.ts, whose token
 * and certificate endpoints it reaches through that process (`/proxy/*`), with
 * `AIRCASE_ADMIN_EMAILS` naming the stand-in's `e2e-admin@example.com`. Its fake scope stage and
 * reranker each take about a second, and its answer to `POST /api/evidence` waits a little more once
 * the search is done, so the checklist's reads of the search's progress see each stage under way and
 * then the finished search; nothing of this is in production code.
 *
 * A fourth app, http://127.0.0.1:E2E_REAL_FIELDS_PORT (default E2E_REAL_PORT + 5), runs the
 * attributed policy (Task 30, `attributed.v1`) on live's ranking (`er-q-h50-v1`), for
 * tests/e2e-real/evidence-attributed.spec.ts: the state, years and aircraft category a question names
 * are applied on their own once the deterministic candidate rules and the (fake, scripted) attribution
 * check pass each value, and are stored through migration 0030's guard.
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
import { createAuthService } from '../../server/auth/better-auth.js';
import type { FakeScript } from '../../server/ai/fake.js';
import { GOOGLE_CERTS_URL, GOOGLE_TOKEN_URL } from '../support/mock-google.js';
import { deleteIndices, fixtureEmbedder, FIXTURE_EMBEDDING, publishFixtureDataset } from '../support/api-dataset.js';
import { APP_DIR } from '../support/extract-dir.js';
import { FakeSiteverify } from '../support/fake-siteverify.js';
import { resetControls, testDb, testEs, testEsReader } from '../integration/helpers.js';
import { E2E_ADMIN_EMAIL, E2E_GOOGLE_CLIENT, e2eAttribution, e2eEvidenceScope, e2eRerank } from './evidence-fakes.js';

const port = Number(process.env.E2E_REAL_PORT) || 5181;
const appUrl = `http://127.0.0.1:${port}`;
const v3Port = Number(process.env.E2E_REAL_V3_PORT) || port + 3;
const v3Url = `http://127.0.0.1:${v3Port}`;
const livePort = Number(process.env.E2E_REAL_LIVE_PORT) || port + 4;
const liveUrl = `http://127.0.0.1:${livePort}`;
const fieldsPort = Number(process.env.E2E_REAL_FIELDS_PORT) || port + 5;
const fieldsUrl = `http://127.0.0.1:${fieldsPort}`;
const googleUrl = `http://localhost:${Number(process.env.E2E_GOOGLE_PORT) || 5183}`;
const prefix = `aviation-test-e2e${randomBytes(4).toString('hex')}`;
const webRoot = join(APP_DIR, 'dist/web');
if (!existsSync(join(webRoot, 'index.html'))) {
  console.error('dist/web is missing; run pnpm build:web first');
  process.exit(2);
}

// Synthetic secrets and Cloudflare's documented always-passing test keys; nothing real.
const env = {
  NODE_ENV: 'test',
  APP_ENV: 'dev',
  APP_URL: appUrl,
  AI_LLM_PROVIDER: 'fake',
  AI_BRIEFS_ENABLED: 'false',
  IDENTITY_HMAC_SECRET: 'e2e-real-identity-hmac-secret-0123456789',
  IP_HMAC_SECRET: 'e2e-real-network-hmac-secret-0123456789',
  TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEYS[0],
  TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_KEYS[0],
};
const config = loadConfig({ files: [], env });
const v3Config = loadConfig({
  files: [],
  env: { ...env, APP_URL: v3Url, AVIATION_EVIDENCE_AUTO_FILTERS: 'state-explicit.v1.3', AVIATION_EVIDENCE_RANKING: 'er-q-v1' },
});
// What live runs, with Google sign-in (the stand-in's client) and one admin.
const liveConfig = loadConfig({
  files: [],
  env: {
    ...env,
    APP_URL: liveUrl,
    AVIATION_EVIDENCE_RANKING: 'er-q-h50-v1',
    AVIATION_EVIDENCE_AUTO_FILTERS: 'none',
    GOOGLE_CLIENT_ID: E2E_GOOGLE_CLIENT.id,
    GOOGLE_CLIENT_SECRET: E2E_GOOGLE_CLIENT.secret,
    BETTER_AUTH_SECRET: 'e2e-real-better-auth-secret-0123456789abcdef',
    AIRCASE_ADMIN_EMAILS: E2E_ADMIN_EMAIL,
  },
});
// The attributed policy on live's ranking.
const fieldsConfig = loadConfig({
  files: [],
  env: { ...env, APP_URL: fieldsUrl, AVIATION_EVIDENCE_RANKING: 'er-q-h50-v1', AVIATION_EVIDENCE_AUTO_FILTERS: 'attributed.v1' },
});

// The live app's sign-in exchanges its codes with the stand-in for Google, in the sign-in server's
// process (tests/e2e-real/auth-server.ts). Every other request goes out as before.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const target = `${url.origin}${url.pathname}`;
  if (target === GOOGLE_TOKEN_URL) {
    const body = input instanceof Request ? await input.text() : String(init?.body ?? '');
    return realFetch(`${googleUrl}/proxy/token`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  if (target === GOOGLE_CERTS_URL) return realFetch(`${googleUrl}/proxy/certs`);
  if (/(^|\.)(google|googleapis)\.com$/.test(url.hostname)) throw new Error(`unexpected request to ${url.origin}`);
  return realFetch(input, init);
};

await resetControls();
const ingest = testDb('ingest');
const db = testDb('app');
const writer = testEs();
const reader = testEsReader();
const dataset = await publishFixtureDataset(ingest, writer, prefix, { passages: true });
await closeDb(ingest);
console.log(`fixture dataset: generation ${dataset.generationId}, ${dataset.casesIndex}, ${dataset.passagesIndex}`);

const siteverify = new FakeSiteverify(() => new Date(), { hostname: '127.0.0.1', action: 'ask-ai' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ServeOptions {
  /** The fake provider's script (default: the scripted scope stage, answering at once). */
  llm?: FakeScript;
  /** Google sign-in through the stand-in. */
  signIn?: boolean;
  /** How long the answer to `POST /api/evidence` waits once the search is done. */
  holdEvidenceAnswerMs?: number;
}

/** One app over the published dataset, with its own AI runtime (offline fakes) for `appConfig`. */
async function serve(appConfig: typeof config, listenPort: number, options: ServeOptions = {}) {
  const ai = createAiRuntime(appConfig, {
    db,
    llm: createFakeProvider(options.llm ?? { evidenceScope: e2eEvidenceScope }),
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

  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const signIn = options.signIn
    ? createAuthService(appConfig, { db, policy: ai.policy, trials: ai.trials, log: quiet, rateLimits: { signIn: 1_000, callback: 1_000, signOut: 1_000 } })
    : null;
  if (signIn && !signIn.service) throw new Error(`sign-in is off: ${signIn.problem}`);

  // Every browser of the parallel workers shares 127.0.0.1: raise the per-identity limits (the
  // API's and the progress polls') so tests never trip them (tests/integration/api-search.test.ts
  // covers the limit).
  const served = buildApp({
    config: appConfig,
    db,
    es: reader,
    ai,
    ...(signIn?.service ? { auth: signIn.service } : {}),
    evidence: createEvidenceServices(createEvidenceRetriever(db, reader, fixtureEmbedder())),
    embedding: FIXTURE_EMBEDDING,
    webRoot,
    rateLimit: { limit: 10_000, windowMs: 60_000 },
    pollRateLimit: { limit: 10_000, windowMs: 60_000 },
  });
  const hold = options.holdEvidenceAnswerMs ?? 0;
  if (hold > 0) {
    served.addHook('onSend', async (request, _reply, payload) => {
      if (request.method === 'POST' && request.url === '/api/evidence') await sleep(hold);
      return payload;
    });
  }
  await served.listen({ host: '127.0.0.1', port: listenPort });
  return served;
}

// The v3 and live apps first: the main app's health check, which Playwright waits for, then answers for all.
const v3App = await serve(v3Config, v3Port);
console.log(`e2e evidence.v3 server on ${v3Url} (the reviewed state policy: er-q-v1, state-explicit.v1.3)`);
// What live runs, its scope stage and reranker each taking about a second, and its answers a little later.
const slowly = <I, O>(step: (input: I) => O) => async (input: I) => {
  await sleep(1_000);
  return step(input);
};
const liveApp = await serve(liveConfig, livePort, {
  llm: { evidenceScope: slowly(e2eEvidenceScope), rerank: slowly(e2eRerank) },
  signIn: true,
  holdEvidenceAnswerMs: 1_200,
});
console.log(`e2e live-configuration server on ${liveUrl} (er-q-h50-v1, none; Google sign-in, admin ${E2E_ADMIN_EMAIL})`);
const fieldsApp = await serve(fieldsConfig, fieldsPort, { llm: { evidenceScope: e2eEvidenceScope, rerank: e2eRerank, evidenceAttribution: e2eAttribution } });
console.log(`e2e attributed-policy server on ${fieldsUrl} (er-q-h50-v1, attributed.v1)`);
const app = await serve(config, port);
console.log(`e2e server on ${appUrl}, AI evidence search on (offline fakes)`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.all([app.close().catch(() => undefined), v3App.close().catch(() => undefined), liveApp.close().catch(() => undefined), fieldsApp.close().catch(() => undefined)]);
  await deleteIndices(writer, prefix).catch(() => undefined);
  await Promise.allSettled([closeDb(db), writer.close(), reader.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
