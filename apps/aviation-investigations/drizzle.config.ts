import { defineConfig } from 'drizzle-kit';

// Used by `pnpm db:generate` only (no database connection). Migrations are applied
// by `pnpm db:migrate` (scripts/db-migrate.ts) as the migrator role.
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema/index.ts',
  out: './server/db/migrations',
  strict: true,
  verbose: true,
});
