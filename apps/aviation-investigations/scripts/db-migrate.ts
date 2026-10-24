/**
 * Apply migrations as aviation_migrator (the URL switches to that group role).
 *
 *   pnpm db:migrate          # the database in DATABASE_MIGRATOR_URL
 *   pnpm db:migrate --test   # aviation_test, via TEST_DATABASE_MIGRATOR_URL
 *
 * URLs come from the process environment, AVIATION_ENV_FILES, or the app's ignored
 * `.env.local`. They are never printed. Each environment has its own migrator login,
 * which can connect only to its own database.
 */
import { parseArgs } from 'node:util';
import { runMigrations } from '../server/db/migrate.js';
import { workerConfig } from '../worker/config.js';
import { readLocal } from './local-env.js';

const { values } = parseArgs({ options: { test: { type: 'boolean' } }, strict: true });
const name = values.test ? 'TEST_DATABASE_MIGRATOR_URL' : 'DATABASE_MIGRATOR_URL';
const url = values.test
  ? process.env.TEST_DATABASE_MIGRATOR_URL || readLocal([name])[name]
  : workerConfig().databaseMigratorUrl;
if (!url) {
  console.error(`${name} is not set; run pnpm services:setup`);
  process.exit(2);
}
const database = new URL(url).pathname.slice(1);
runMigrations(url).then(
  (r) => {
    console.log(`migrations applied to ${database}`);
    if (r.reapplied.length > 0) console.log(`run again over an earlier recorded version: ${r.reapplied.join(', ')}`);
  },
  (err: unknown) => {
    console.error(`migration failed on ${database}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
