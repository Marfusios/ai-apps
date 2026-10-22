/**
 * Run the migrations and the integration suite against PostgreSQL 16.2, the shared
 * server's version (local services carry 17). Starts the throwaway `postgres16`
 * service (profile pg16) of the ai-aviation-local project, provisions the `test`
 * environment on it with the same role model, runs `vitest --project integration`
 * with TEST_DATABASE_* pointing at it (Elasticsearch stays on the local services),
 * then removes the container.
 *
 *   pnpm services:up && pnpm services:setup && pnpm test:pg16
 */
import { spawnSync } from 'node:child_process';
import { APP_DIR, ENV_LOCAL, ensureSecrets } from './local-env.js';
import { ROLE_KINDS, provisionPostgres, roleUrl } from './provision.js';

const port = Number(process.env.POSTGRES16_PORT || 55416);
const compose = ['compose', '-f', 'compose.local-services.yaml', '--env-file', ENV_LOCAL, '--profile', 'pg16'];
const docker = (args: string[]) => spawnSync('docker', [...compose, ...args], { cwd: APP_DIR, stdio: 'inherit' }).status;

const { POSTGRES_PASSWORD } = ensureSecrets(['POSTGRES_PASSWORD']);
let code = 1;
try {
  if (docker(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres16']) !== 0) throw new Error('postgres16 did not start');
  const adminUrl = `postgres://postgres:${encodeURIComponent(POSTGRES_PASSWORD!)}@127.0.0.1:${port}/postgres`;
  const passwords = await provisionPostgres({ env: 'test', adminUrl, log: (m) => console.log(`pg16: ${m}`) });
  const base = `postgres://127.0.0.1:${port}`;
  const env = { ...process.env };
  const vars = { migrator: 'TEST_DATABASE_MIGRATOR_URL', ingest: 'TEST_DATABASE_INGEST_URL', app: 'TEST_DATABASE_URL' } as const;
  for (const k of ROLE_KINDS) env[vars[k]] = roleUrl(base, 'test', k, passwords[k]);
  // The provisioning test then creates its throwaway environment on this server too.
  env.TEST_PG_ADMIN_URL = adminUrl;
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'integration'], { cwd: APP_DIR, stdio: 'inherit', env });
  code = r.status ?? 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
} finally {
  docker(['rm', '--stop', '--force', 'postgres16']);
}
process.exit(code);
