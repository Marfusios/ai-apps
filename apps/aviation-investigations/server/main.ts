/**
 * HTTP entry point (`pnpm dev:server`; `node server/main.js` in the image).
 *
 * Configuration: AVIATION_ENV_FILES when set, otherwise the app's ignored `.env.local`
 * when present (a checkout), with nonempty process values winning. The server connects
 * as `aviation_app` (DATABASE_URL) and reads Elasticsearch with ELASTICSEARCH_READ_API_KEY
 * only. It listens on HOST:PORT (default 127.0.0.1:3000; the container sets 0.0.0.0)
 * and serves the built web client from `dist/web` when it exists.
 *
 * A live deployment must run in tunnel mode: with APP_ENV=live the server refuses to
 * start unless TRUSTED_PROXY_CIDRS is set.
 *
 * AI briefs read their evidence through hybrid retrieval (server/briefs/retriever.ts)
 * with the OpenAI query embedder (OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL and
 * OPENAI_EMBEDDING_DIMENSIONS), under the frozen retrieval configuration that
 * AVIATION_RETRIEVAL_VERSION names (server/search/retrieval-config.ts; logged at start).
 * The dataset resolver checks the active passages index against the same model and
 * dimensions; without the key AI briefs stay off.
 *
 * Google sign-in (server/auth/better-auth.ts) runs when GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, BETTER_AUTH_SECRET and the identity HMAC key are set; otherwise
 * it is off (`googleEnabled: false`) and the log says which setting is missing.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@elastic/elasticsearch';
import { loadConfig, type AppConfig } from '../shared/config.js';
import { createOpenAIQueryEmbedder } from './ai/embeddings.js';
import { createAiRuntime } from './ai/runtime.js';
import { createAuthService, type AuthLog } from './auth/better-auth.js';
import { buildApp } from './app.js';
import { createHybridRetriever } from './briefs/retriever.js';
import { createBriefServices, type BriefServices } from './briefs/services.js';
import { DB_CONNECT_TIMEOUT_MS, closeDb, createDb, type Db } from './db/client.js';
import { manifestCasesIndex } from './db/generations.js';
import { startControlMaintenance } from './quota/maintenance.js';
import { startTracing } from './observability/tracing.js';
import { createEsClient } from './search/es.js';
import { retrievalConfig } from './search/retrieval-config.js';

const APP_DIR = resolve(fileURLToPath(import.meta.url), '../..');

function serverConfig(): AppConfig {
  if ((process.env.AVIATION_ENV_FILES ?? '').trim() !== '') return loadConfig();
  const local = resolve(APP_DIR, '.env.local');
  return loadConfig({ files: existsSync(local) ? [local] : [] });
}

/** Evidence retrieval for AI briefs, or why there is none (setting names only). */
function briefServices(config: AppConfig, db: Db, es: Client): { services: BriefServices | null; problem: string | null } {
  const { apiKey, embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  if (!apiKey) return { services: null, problem: 'OPENAI_API_KEY is not set: AI briefs have no query embeddings' };
  try {
    const embedder = createOpenAIQueryEmbedder({ apiKey, model, dims });
    const retriever = createHybridRetriever({
      es,
      embedder,
      retrieval: retrievalConfig(config.retrieval.version),
      // The cases index of the manifest a brief's pinned passages index was published with.
      // Bounded: a stalled pool or database ends the lookup (and the step) instead of holding it.
      casesIndexOf: (d, signal) => manifestCasesIndex(db, d.generationId, d.passagesIndex, { timeoutMs: 2_000, signal }),
    });
    return {
      services: createBriefServices(db, { retriever, displayMode: config.ai.partialDisplay ? 'claims' : 'whole' }),
      problem: null,
    };
  } catch {
    return { services: null, problem: 'OPENAI_EMBEDDING_MODEL has no known price: AI briefs have no query embeddings' };
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const config = serverConfig();
  if (!config.databaseUrl) fail('DATABASE_URL is not set (the aviation_app login); run pnpm services:setup');
  if (!config.elasticsearch.readApiKey) fail('ELASTICSEARCH_READ_API_KEY is not set; run pnpm services:setup');
  if (config.appEnv === 'live' && config.trustedProxyCidrs.length === 0) {
    fail('APP_ENV=live requires tunnel mode: set TRUSTED_PROXY_CIDRS (compose.tunnel.yaml sets it from EDGE_SUBNET)');
  }

  const tracing = startTracing(config);
  // Opening a connection or waiting for one ends after 5 s (server/db/client.ts).
  const db = createDb(config.databaseUrl, { max: 8, applicationName: 'aviation-api', connectTimeoutMs: DB_CONNECT_TIMEOUT_MS });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 10_000, maxRetries: 1 });
  const evidence = briefServices(config, db, es);
  const ai = createAiRuntime(config, { db });
  // Better Auth logs through the server's logger, which exists once the app does.
  let authLog: AuthLog | null = null;
  const signIn = createAuthService(config, {
    db,
    policy: ai.policy,
    trials: ai.trials,
    log: {
      info: (obj, msg) => authLog?.info(obj, msg),
      warn: (obj, msg) => authLog?.warn(obj, msg),
      error: (obj, msg) => authLog?.error(obj, msg),
    },
  });
  const app = buildApp({
    config,
    db,
    es,
    ai,
    auth: signIn.service,
    briefs: evidence.services,
    embedding: { model: config.ai.openai.embeddingModel, dims: config.ai.openai.embeddingDimensions },
    webRoot: resolve(APP_DIR, 'dist/web'),
    logger: { level: config.nodeEnv === 'production' ? 'info' : 'debug' },
  });

  authLog = app.log;
  if (signIn.problem) app.log.warn({ problem: signIn.problem }, 'Google sign-in off');
  if (evidence.problem) app.log.warn({ problem: evidence.problem }, 'AI feature off');
  else app.log.info({ retrievalVersion: config.retrieval.version }, 'AI retrieval configuration');

  // Retention and lease expiry of the control tables (server/quota/maintenance.ts): advisory-locked, never fatal.
  const maintenance = startControlMaintenance(db, app.log);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    maintenance.stop();
    // `app.close()` finishes within SHUTDOWN_GRACE_MS (9 s, server/app.ts); then the clients close.
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    void (async () => {
      await app.close().catch(() => undefined);
      await Promise.allSettled([closeDb(db), es.close(), tracing.shutdown()]);
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(`server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
