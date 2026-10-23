/**
 * Run the integration suite on PostgreSQL 16, the shared server's major version.
 * The local services run PostgreSQL 16.2 (compose.local-services.yaml), so this is the
 * same run as `pnpm test:integration`, preceded by a check that the server behind the
 * test environment really is PostgreSQL 16: it refuses to run on another major
 * version. The command and its name stay from the time it started a throwaway 16.2
 * container, so that existing instructions keep working.
 *
 *   pnpm services:up && pnpm services:setup && pnpm test:pg16
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { DB_CONNECT_TIMEOUT_MS } from '../server/db/client.js';
import { APP_DIR, readLocal } from './local-env.js';

const REQUIRED_MAJOR = 16;
const URL_VAR = 'TEST_DATABASE_MIGRATOR_URL';

/** The version of the server the test environment points at (any login may ask). */
async function serverVersion(): Promise<{ major: number; text: string }> {
  // Nonempty process values win over .env.local, as in tests/integration/helpers.ts.
  const url = process.env[URL_VAR] || readLocal([URL_VAR])[URL_VAR];
  if (!url) throw new Error(`${URL_VAR} missing; run pnpm services:up && pnpm services:setup`);
  const client = new pg.Client({ connectionString: url, application_name: 'aviation-test-pg16', connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    const { rows } = await client.query<{ num: number; text: string }>(
      "SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS text",
    );
    return { major: Math.floor(rows[0]!.num / 10_000), text: rows[0]!.text };
  } finally {
    await client.end();
  }
}

let code = 1;
try {
  const { major, text } = await serverVersion();
  console.log(`pg16: test database server is PostgreSQL ${text}`);
  if (major !== REQUIRED_MAJOR) {
    throw new Error(
      `pg16: expected PostgreSQL ${REQUIRED_MAJOR}. The local services pin 16.2; a data volume made by another major version ` +
        'must be removed once: pnpm services:down && docker volume rm ai-aviation-local_postgres-data && ' +
        'pnpm services:up && pnpm services:setup',
    );
  }
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'integration'], { cwd: APP_DIR, stdio: 'inherit' });
  code = r.status ?? 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
}
process.exit(code);
