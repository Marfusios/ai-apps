import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import yazl from 'yazl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  extractArchive,
  removeAllContainers,
  runContainer,
  runMdbExport,
  setDockerCommand,
  summarizeStderr,
} from '../../worker/ingest/extract.js';

let dir: string;
let log: string;
const IMAGE = `sha256:${'0'.repeat(64)}`;

const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_DOCKER_LOG"
case "$1" in
  image) echo ${IMAGE}; exit 0;;
  rm) if [ -n "$FAKE_RM_FAIL" ]; then echo boom >&2; exit 1; fi; exit 0;;
  run)
    case "$FAKE_RUN" in
      hang) exec sleep 30;;
      flood) exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaa;;
      stderr) echo id; echo "page read failed at offset 123 secret-value" >&2; exit 0;;
      *) echo id; exit 0;;
    esac;;
esac
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'extract-unit-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  log = join(dir, 'docker.log');
  setDockerCommand(bin);
});
afterAll(() => {
  setDockerCommand('docker');
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const k of ['FAKE_RUN', 'FAKE_RM_FAIL']) delete process.env[k];
  rmSync(log, { force: true });
});
process.env.FAKE_DOCKER_LOG = '';
beforeAll(() => {
  process.env.FAKE_DOCKER_LOG = log;
});

const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
const logText = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const base = { image: IMAGE, mounts: [], command: ['mdb-export'], timeoutMs: 5000 };

describe('runContainer cleanup', () => {
  it('removes the container and awaits it after a timeout', async () => {
    process.env.FAKE_RUN = 'hang';
    await expect(runContainer({ ...base, sink: sink(), timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(logText()).toMatch(/rm -f aviation-extract-/);
  });

  it('removes the container when output exceeds the cap', async () => {
    process.env.FAKE_RUN = 'flood';
    await expect(runContainer({ ...base, sink: sink(), maxBytes: 2000 })).rejects.toThrow(/exceeds/);
    expect(logText()).toMatch(/rm -f aviation-extract-/);
  });

  it('reports a failed removal and keeps tracking the container until it succeeds', async () => {
    process.env.FAKE_RUN = 'hang';
    process.env.FAKE_RM_FAIL = '1';
    await expect(runContainer({ ...base, sink: sink(), timeoutMs: 200 })).rejects.toThrow(/cleanup failed/);
    expect((await removeAllContainers()).length).toBe(1);
    delete process.env.FAKE_RM_FAIL;
    expect(await removeAllContainers()).toEqual([]);
    expect(await removeAllContainers()).toEqual([]);
  }, 30_000);
});

describe('runMdbExport stderr', () => {
  it('fails on diagnostics even with exit code 0, without echoing raw content', async () => {
    process.env.FAKE_RUN = 'stderr';
    const out = join(dir, 'exp');
    mkdirSync(out);
    const err = await runMdbExport(join(dir, 'x.mdb'), out).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/diagnostics.*page-read=1/);
    expect((err as Error).message).not.toMatch(/secret-value/);
  });

  it('summarizes clean stderr as null', () => {
    expect(summarizeStderr('\n  \n')).toBeNull();
  });
});

describe('extractArchive ownership', () => {
  async function zipOf(content: string) {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from(content), 'avall.mdb');
    z.end();
    const chunks: Buffer[] = [];
    for await (const c of z.outputStream) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const path = join(dir, `z${Math.random().toString(16).slice(2)}.zip`);
    writeFileSync(path, buf);
    return { path, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  it('refuses an existing destination and leaves it untouched', async () => {
    const z = await zipOf('data');
    const dest = join(dir, 'existing');
    mkdirSync(join(dest, 'raw'), { recursive: true });
    writeFileSync(join(dest, 'raw', 'avall.mdb'), 'precious');
    writeFileSync(join(dest, 'events.csv'), 'precious');
    await expect(extractArchive({ archive: z.path, sha256: z.sha256, out: dest })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dest, 'raw', 'avall.mdb'), 'utf8')).toBe('precious');
    expect(readFileSync(join(dest, 'events.csv'), 'utf8')).toBe('precious');
  });

  it('a checksum mismatch removes only what this run created', async () => {
    const z = await zipOf('data');
    const parent = join(dir, 'parent');
    mkdirSync(parent);
    writeFileSync(join(parent, 'neighbour.txt'), 'keep');
    await expect(
      extractArchive({ archive: z.path, sha256: '0'.repeat(64), out: join(parent, 'run') }),
    ).rejects.toThrow(/sha256/);
    expect(readdirSync(parent)).toEqual(['neighbour.txt']);
  });

  it('a failed run leaves neither destination nor staging directory', async () => {
    process.env.FAKE_RUN = 'stderr';
    const z = await zipOf('data');
    const parent = join(dir, 'parent2');
    mkdirSync(parent);
    await expect(extractArchive({ archive: z.path, sha256: z.sha256, out: join(parent, 'run') })).rejects.toThrow();
    expect(readdirSync(parent)).toEqual([]);
  });
});
