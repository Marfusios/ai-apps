import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRACT_IMAGE, extractArchive, mdbtoolsVersion, runMdbExport } from '../../worker/ingest/extract.js';

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

  it('leaves no raw or partial output after a failed run, and refuses a finished directory', async () => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('not a database'), 'avall.mdb');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const zipPath = join(dir, 'bad.zip');
    writeFileSync(zipPath, buf);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const out = join(dir, 'run');
    await expect(extractArchive({ archive: zipPath, sha256, out })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.startsWith('run'))).toEqual([]);
    // Same path again works because nothing was left behind; an existing path is refused untouched.
    await expect(extractArchive({ archive: zipPath, sha256, out })).rejects.toThrow(/exited with|diagnostics/);
    mkdirSync(out);
    writeFileSync(join(out, 'manifest.json'), '{}');
    await expect(extractArchive({ archive: zipPath, sha256, out })).rejects.toThrow(/already exists/);
    expect(readdirSync(out)).toEqual(['manifest.json']);
  });
});
