import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXTRACT_IMAGE,
  extractArchive,
  mdbtoolsVersion,
  removeAllContainers,
  resolveImageId,
  runContainer,
  runMdbExport,
  setDockerCommand,
} from '../../worker/ingest/extract.js';

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

describe('container cleanup against the real daemon', () => {
  // Passes every call to the real docker CLI and logs it. With LOSE_CREATE_ID set,
  // `docker create` really creates the container but then exits 1 without printing
  // the ID, as when the CLI loses its connection after the daemon accepted the request.
  let wrapper: string;
  let wrapperLog: string;
  beforeAll(() => {
    wrapper = join(dir, 'docker-wrapper');
    wrapperLog = join(dir, 'docker-wrapper.log');
    writeFileSync(
      wrapper,
      `#!/bin/sh
echo "$@" >> "${'$'}WRAPPER_LOG"
if [ "$1" = create ] && [ -n "${'$'}LOSE_CREATE_ID" ]; then
  id=$(docker "$@" 2>/dev/null)
  echo "server-created $id" >> "${'$'}WRAPPER_LOG"
  echo "error during connect: unexpected EOF" >&2
  exit 1
fi
exec docker "$@"
`,
    );
    chmodSync(wrapper, 0o755);
  });

  const listed = (name: string) =>
    spawnSync('docker', ['ps', '-a', '-q', '--filter', `name=^/?${name}$`], { encoding: 'utf8' }).stdout.trim();
  const createdName = () =>
    /create --name (aviation-extract-[0-9a-f]+)/.exec(readFileSync(wrapperLog, 'utf8'))?.[1] ?? 'missing';
  async function viaWrapper(env: Record<string, string>, body: () => Promise<unknown>): Promise<string> {
    rmSync(wrapperLog, { force: true });
    Object.assign(process.env, { WRAPPER_LOG: wrapperLog, ...env });
    setDockerCommand(wrapper);
    try {
      return await body().then(
        () => 'resolved',
        (e: Error) => e.message,
      );
    } finally {
      setDockerCommand('docker');
      for (const k of ['WRAPPER_LOG', ...Object.keys(env)]) delete process.env[k];
    }
  }

  it('removes a container the daemon created when docker create exits 1 without an ID', async () => {
    const image = await resolveImageId();
    const msg = await viaWrapper({ LOSE_CREATE_ID: '1' }, () =>
      runContainer({ image, mounts: [], command: ['true'], sink: null, timeoutMs: 60_000 }),
    );
    const name = createdName();
    const log = readFileSync(wrapperLog, 'utf8');
    expect(log).toMatch(/server-created [0-9a-f]{64}/); // the orphan really existed
    expect(msg).toMatch(/docker create failed \(exit 1\)/);
    expect(msg).not.toMatch(/cleanup failed/);
    expect(log).toContain(`rm -f ${name}\n`);
    expect(log).not.toMatch(/^start /m);
    expect(listed(name)).toBe('');
    expect(await removeAllContainers()).toEqual([]);
  });

  it('removes the container when the output file fails to open while docker create is pending', async () => {
    const image = await resolveImageId();
    const msg = await viaWrapper({}, () =>
      runContainer({
        image,
        mounts: [],
        command: ['true'],
        sink: createWriteStream(join(dir, 'missing-dir', 'events.csv'), { flags: 'wx', mode: 0o600 }),
        timeoutMs: 60_000,
      }),
    );
    const name = createdName();
    expect(msg).toMatch(/ENOENT/);
    expect(readFileSync(wrapperLog, 'utf8')).not.toMatch(/^start /m);
    expect(listed(name)).toBe('');
    expect(await removeAllContainers()).toEqual([]);
  });
});
