/**
 * Regenerates the mock API responses in `web/mock/*.json` from the committed NTSB
 * fixtures (`fixtures/ntsb`, `fixtures/ntsb-ui`), normalized with `normalizeCorpus`.
 *
 *   pnpm mock:build
 *
 * The dev mock mode (`WEB_MOCK_API=1 pnpm dev:web`) and the component and
 * end-to-end tests serve these through MSW. `tests/unit/mock-api.test.ts` fails
 * when the committed files are out of date or break a contract.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMockApi, serialize } from './mock-api/build.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appDir, 'web', 'mock');

async function main(): Promise<void> {
  const files = await buildMockApi(appDir);
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const text = serialize(content);
    writeFileSync(join(outDir, name), text);
    console.log(`web/mock/${name}: ${(text.length / 1024).toFixed(1)} KiB`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
