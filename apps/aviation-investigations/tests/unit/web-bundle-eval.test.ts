/**
 * The production web bundle never tries to compile code at run time. The server's CSP has no
 * 'unsafe-eval', and a blocked `Function(...)` is reported to the console and to any
 * `securitypolicyviolation` listener even when the caller catches the error. Zod probes
 * `Function` the first time an object schema is built unless `jitless` is set, so `jitless`
 * must be set before any schema is built. The entry's own first import did not guarantee
 * that in the production build: the bundler put Zod and the contracts' schemas, which the
 * entry and the lazy pages share, in a chunk that the entry imports, and a chunk runs before
 * the code of its importer (web/src/zod-jitless.ts, vite.config.ts).
 *
 * This builds the client exactly as `pnpm build:web` does and starts it in jsdom in a bare
 * Node process with `Function` recording its callers (tests/support/boot-web-bundle.mjs).
 * tests/e2e-real/real-server.spec.ts proves the same in Chromium under the real CSP.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DIR } from '../support/extract-dir.js';

let outDir = '';

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'aviation-web-build-'));
  const vite = join(APP_DIR, 'node_modules/vite/bin/vite.js');
  execFileSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: APP_DIR,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'pipe',
  });
  // The build has no package.json of its own: its chunks are ES modules.
  writeFileSync(join(outDir, 'package.json'), '{"type":"module"}\n');
}, 120_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('the production web bundle (the CSP has no unsafe-eval)', () => {
  it('starts and renders without calling Function, with Zod configured before any schema is built', () => {
    const stdout = execFileSync(process.execPath, [join(APP_DIR, 'tests/support/boot-web-bundle.mjs'), outDir, APP_DIR], { encoding: 'utf8' });
    const result = JSON.parse(stdout) as { calls: string[]; failure: string | null; jitless: boolean; wordmark: string | null };
    // What the CSP would report: a `Function` call (Zod's probe passes an empty body).
    expect(result.calls, 'Function was called while the bundle started').toEqual([]);
    // The bundle really started: it got as far as rendering the app's header.
    expect(result.failure).toBeNull();
    expect(result.wordmark, 'the header should have rendered').toBeTruthy();
    expect(result.jitless).toBe(true);
  }, 60_000);
});
