import { defineConfig } from 'vitest/config';
/** Isolated scratch databases; does not migrate or reset the shared integration database. */
export default defineConfig({ test: { include: ['tests/integration/importer-*.test.ts'],
  fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 } });
