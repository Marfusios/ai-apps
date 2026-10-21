import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRACT_IMAGE, mdbtoolsVersion, runMdbExport } from '../../worker/ingest/extract.js';

// Needs Docker. mdbtools cannot create MDB files, so no synthetic database is
// exported here; the full export is covered by the manual real-archive run.
let dir: string;
beforeAll(() => {
  const build = spawnSync('docker', ['build', '-q', '-t', EXTRACT_IMAGE, 'docker/extract'], {
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`image build failed: ${build.stderr}`);
  dir = mkdtempSync(join(tmpdir(), 'extract-image-'));
}, 300_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('extract image', () => {
  it('runs the pinned mdbtools inside the sandbox', async () => {
    const fake = join(dir, 'avall.mdb');
    writeFileSync(fake, 'not a database');
    await expect(mdbtoolsVersion(fake)).resolves.toMatch(/^1\.0\.0/);
  });

  it('reports a failure for a file that is not an MDB database', async () => {
    const fake = join(dir, 'bad.mdb');
    writeFileSync(fake, 'not a database');
    await expect(runMdbExport(fake, dir)).rejects.toThrow(/exited with/);
  });
});
