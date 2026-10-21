/**
 * Apply database migrations as the migrator role.
 *
 *   pnpm db:migrate                         # the database in DATABASE_MIGRATOR_URL
 *   pnpm db:migrate --database aviation_test
 *
 * The URL comes from the process environment, AVIATION_ENV_FILES, or the app's
 * ignored `.env.local`. It is never printed.
 */
import { parseArgs } from 'node:util';
import { runMigrations } from '../server/db/migrate.js';
import { workerConfig } from '../worker/config.js';

const { values } = parseArgs({ options: { database: { type: 'string' } }, strict: true });
const url = workerConfig().databaseMigratorUrl;
if (!url) {
  console.error('DATABASE_MIGRATOR_URL is not set; run pnpm services:setup');
  process.exit(2);
}
const target = new URL(url);
if (values.database) {
  if (!/^[a-z_][a-z0-9_]*$/.test(values.database)) {
    console.error('invalid database name');
    process.exit(2);
  }
  target.pathname = `/${values.database}`;
}
const name = target.pathname.slice(1);
runMigrations(target.toString()).then(
  () => console.log(`migrations applied to ${name}`),
  (err: unknown) => {
    console.error(`migration failed on ${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
