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
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from '../shared/config.js';
import { createAiRuntime } from './ai/runtime.js';
import { buildApp } from './app.js';
import { closeDb, createDb } from './db/client.js';
import { startControlMaintenance } from './quota/maintenance.js';
import { startTracing } from './observability/tracing.js';
import { createEsClient } from './search/es.js';

const APP_DIR = resolve(fileURLToPath(import.meta.url), '../..');

function serverConfig(): AppConfig {
  if ((process.env.AVIATION_ENV_FILES ?? '').trim() !== '') return loadConfig();
  const local = resolve(APP_DIR, '.env.local');
  return loadConfig({ files: existsSync(local) ? [local] : [] });
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
  const db = createDb(config.databaseUrl, { max: 8, applicationName: 'aviation-api' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 10_000, maxRetries: 1 });
  // AI briefs need an evidence retriever (`briefs`), bound to hybrid retrieval in a later
  // change; until then the brief routes answer 503 and AI status reports `dependency`.
  const app = buildApp({
    config,
    db,
    es,
    ai: createAiRuntime(config, { db }),
    webRoot: resolve(APP_DIR, 'dist/web'),
    logger: { level: config.nodeEnv === 'production' ? 'info' : 'debug' },
  });

  // Retention and lease expiry of the control tables (server/quota/maintenance.ts): advisory-locked, never fatal.
  const maintenance = startControlMaintenance(db, app.log);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    maintenance.stop();
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
