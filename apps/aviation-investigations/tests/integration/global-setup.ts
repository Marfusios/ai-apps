import { runMigrations } from '../../server/db/migrate.js';
import { testDbUrl } from './helpers.js';

/** Bring aviation_test to the current schema before any integration test runs. */
export default async function setup(): Promise<void> {
  await runMigrations(testDbUrl('migrator'));
}
