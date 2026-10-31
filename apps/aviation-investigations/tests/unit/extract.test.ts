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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import yazl from 'yazl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupExtraction,
  extractArchive,
  removeAllContainers,
  runContainer,
  runMdbExport,
  sandboxFlags,
  setDockerCommand,
  setExtractEnvironment,
  summarizeStderr,
} from '../../worker/ingest/extract.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';

let dir: string;
let log: string;
let bin: string;
let state: string;
const IMAGE = `sha256:${'0'.repeat(64)}`;

const CID = 'ab'.repeat(32);
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_DOCKER_LOG"
case "$1" in
  image) echo ${IMAGE}; exit 0;;
  create)
    if [ -n "$FAKE_CREATE_SLEEP" ]; then sleep "$FAKE_CREATE_SLEEP"; fi
    case "$FAKE_CREATE" in
      # The daemon created the container, then the CLI lost its connection: exit 1, no ID.
      lost) echo "$3" >> "$FAKE_STATE"; echo "error during connect: unexpected EOF" >&2; exit 1;;
      # Rejected, nothing created.
      refused) echo "error during connect: unexpected EOF" >&2; exit 1;;
    esac
    echo ${CID}; exit 0;;
  rm)
    if [ -n "$FAKE_RM_SLEEP" ]; then sleep "$FAKE_RM_SLEEP"; fi
    if [ -n "$FAKE_RM_FAIL" ]; then echo boom >&2; echo "rm-failed" >> "$FAKE_DOCKER_LOG"; exit 1; fi
    if [ -f "$FAKE_STATE" ]; then grep -vx -- "$3" "$FAKE_STATE" > "$FAKE_STATE.tmp"; mv "$FAKE_STATE.tmp" "$FAKE_STATE"; fi
    echo "rm-done" >> "$FAKE_DOCKER_LOG"; exit 0;;
  ps)
    if [ -f "$FAKE_STATE" ]; then cat "$FAKE_STATE"; fi; exit 0;;
  start)
    case "$FAKE_RUN" in
      hang) exec sleep 30;;
      flood) exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaa;;
      stderr) echo id; echo "page read failed at offset 123 secret-value" >&2; exit 0;;
      fail) echo "page read failed at offset 123 secret-value" >&2; exit 3;;
      *) echo id; exit 0;;
    esac;;
esac
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'extract-unit-'));
  bin = join(dir, 'docker');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  log = join(dir, 'docker.log');
  state = join(dir, 'containers.state');
  process.env.FAKE_STATE = state;
  setDockerCommand(bin);
});
afterAll(() => {
  setDockerCommand('docker');
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const k of ['FAKE_RUN', 'FAKE_RM_FAIL', 'FAKE_RM_SLEEP', 'FAKE_CREATE_SLEEP', 'FAKE_CREATE']) {
    delete process.env[k];
  }
  rmSync(log, { force: true });
  rmSync(state, { force: true });
});
process.env.FAKE_DOCKER_LOG = '';
beforeAll(() => {
  process.env.FAKE_DOCKER_LOG = log;
});

const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
const logText = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
/** Containers the fake daemon still holds, one name per line. */
const stateText = () => (existsSync(state) ? readFileSync(state, 'utf8').trim() : '');
const message = async (p: Promise<unknown>) => ((await p.then(() => null, (e: Error) => e)) as Error).message;
const base = { image: IMAGE, mounts: [], command: ['mdb-export'], timeoutMs: 5000 };

describe('runContainer cleanup', () => {
  it('removes the container and awaits it after a timeout', async () => {
    process.env.FAKE_RUN = 'hang';
    await expect(runContainer({ ...base, sink: sink(), timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(logText()).toMatch(/rm -f [0-9a-f]{64}/);
  });

  it('removes the container when output exceeds the cap', async () => {
    process.env.FAKE_RUN = 'flood';
    await expect(runContainer({ ...base, sink: sink(), maxBytes: 2000 })).rejects.toThrow(/exceeds/);
    expect(logText()).toMatch(/rm -f [0-9a-f]{64}/);
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

describe('runContainer lifecycle', () => {
  it('refuses root or invalid sandbox identities without relaxing private-file permissions', () => {
    for (const [uid, gid] of [[0, 1000], [1000, 0], [-1, 1000], [1000, -1], [1.5, 1000], [NaN, 1000]]) {
      expect(() => sandboxFlags(uid, gid)).toThrow(/unprivileged/);
    }
    expect(sandboxFlags(1000, 1001)).toContain('1000:1001');
  });

  it('removes the container explicitly after a successful run', async () => {
    await runContainer({ ...base, sink: sink() });
    expect(logText()).toMatch(/create --name ai-aviation-dev-extract-[0-9a-f]{12} /);
    expect(logText()).not.toMatch(/--rm/);
    expect(logText()).toMatch(/rm -f [0-9a-f]{64}/);
    expect(logText()).toMatch(/rm-done/);
  });

  it('groups the container with the environment\'s Compose project and keeps the sandbox flags', async () => {
    const createLine = () => logText().split('\n').find((l) => l.startsWith('create ')) ?? '';
    // sha256 of the sandbox flags, mounts, image and command (`docker compose ps` needs a config hash).
    const HASH = createHash('sha256').update(JSON.stringify([sandboxFlags(), [], IMAGE, ['mdb-export']])).digest('hex');
    const labels = (env: string) =>
      [
        `--label com.docker.compose.project=ai-aviation-${env}`,
        '--label com.docker.compose.service=extract',
        '--label com.docker.compose.oneoff=True',
        `--label com.docker.compose.config-hash=${HASH}`,
        '--label ai-apps.app=aviation-investigations',
        '--label ai-apps.component=extract',
        `--label ai-apps.environment=${env}`,
      ].join(' ');
    await runContainer({ ...base, sink: sink() });
    expect(createLine()).toMatch(/^create --name ai-aviation-dev-extract-[0-9a-f]{12} /);
    expect(createLine()).toContain(labels('dev'));
    expect(createLine()).toContain(
      `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --memory 1g --memory-swap 1g --cpus 2 --pids-limit 64 --user ${process.getuid!()}:${process.getgid!()}`,
    );
    rmSync(log, { force: true });
    setExtractEnvironment('live');
    try {
      await runContainer({ ...base, sink: sink() });
    } finally {
      setExtractEnvironment('dev');
    }
    expect(createLine()).toMatch(/^create --name ai-aviation-live-extract-[0-9a-f]{12} /);
    expect(createLine()).toContain(labels('live'));
    expect(() => setExtractEnvironment('prod' as 'live')).toThrow(/invalid/);
  });

  it('waits for an in-flight create, removes the returned id and never starts it', async () => {
    process.env.FAKE_CREATE_SLEEP = '1';
    await expect(runContainer({ ...base, sink: sink(), timeoutMs: 200 })).rejects.toThrow(/timed out/);
    const text = logText();
    expect(text).toMatch(/rm -f [0-9a-f]{64}/);
    expect(text).not.toMatch(/start -a/);
    expect(text).toMatch(/rm-done/);
  });

  it('does not echo raw stderr on a nonzero exit', async () => {
    process.env.FAKE_RUN = 'fail';
    const err = await runContainer({ ...base, sink: sink() }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/exited with 3 \(diagnostics: page-read=1\)/);
    expect((err as Error).message).not.toMatch(/secret-value/);
  });
});

describe('output sink failures', () => {
  it('routes a sink error raised while docker create is pending through cleanup (injected ENOSPC)', async () => {
    process.env.FAKE_CREATE_SLEEP = '1';
    const s = sink();
    setTimeout(() => s.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })), 100);
    await expect(runContainer({ ...base, sink: s })).rejects.toThrow(/ENOSPC/);
    const text = logText();
    expect(text).toMatch(/rm -f [0-9a-f]{64}/);
    expect(text).toMatch(/rm-done/);
    expect(text).not.toMatch(/start -a/);
    expect(await removeAllContainers()).toEqual([]);
  });

  it('routes an output-file open failure raised while docker create is pending through cleanup', async () => {
    process.env.FAKE_CREATE_SLEEP = '1';
    const s = createWriteStream(join(dir, 'missing-dir', 'events.csv'), { flags: 'wx', mode: 0o600 });
    await expect(runContainer({ ...base, sink: s })).rejects.toThrow(/ENOENT/);
    const text = logText();
    expect(text).toMatch(/rm -f [0-9a-f]{64}/);
    expect(text).toMatch(/rm-done/);
    expect(text).not.toMatch(/start -a/);
    expect(await removeAllContainers()).toEqual([]);
  });

  it.skipIf(!existsSync('/dev/full'))('removes the container when writing the output fails mid-stream', async () => {
    await expect(runContainer({ ...base, sink: createWriteStream('/dev/full') })).rejects.toThrow(/ENOSPC/);
    const text = logText();
    expect(text).toMatch(/start -a/);
    expect(text).toMatch(/rm -f [0-9a-f]{64}/);
    expect(text).toMatch(/rm-done/);
    expect(await removeAllContainers()).toEqual([]);
  });

  it('runMdbExport opens the output file before creating a container and never overwrites it', async () => {
    const out = join(dir, 'exp-exists');
    mkdirSync(out);
    writeFileSync(join(out, `${TABLE_NAMES[0]}.csv`), 'keep');
    await expect(runMdbExport(join(dir, 'x.mdb'), out)).rejects.toThrow(/EEXIST/);
    expect(logText()).not.toMatch(/^create /m);
    expect(readFileSync(join(out, `${TABLE_NAMES[0]}.csv`), 'utf8')).toBe('keep');
  });
});

describe('uncertain container creation', () => {
  const createdName = () => /create --name (ai-aviation-dev-extract-[0-9a-f]+)/.exec(logText())?.[1] ?? 'missing';

  it('reconciles by name when the daemon created the container but the CLI exited 1 without an ID', async () => {
    process.env.FAKE_CREATE = 'lost';
    const msg = await message(runContainer({ ...base, sink: sink() }));
    expect(msg).toMatch(/docker create failed \(exit 1\)/);
    expect(msg).not.toMatch(/cleanup failed/);
    const name = createdName();
    const text = logText();
    expect(text).toContain(`rm -f ${name}\n`);
    expect(text).toContain(`ps -a --filter name=^/?${name}$`);
    expect(text).not.toMatch(/start -a/);
    expect(stateText()).toBe(''); // no orphan left in the daemon
    expect(await removeAllContainers()).toEqual([]);
  });

  it('keeps tracking and reports a container whose absence it cannot confirm', async () => {
    process.env.FAKE_CREATE = 'lost';
    process.env.FAKE_RM_FAIL = '1';
    const msg = await message(runContainer({ ...base, sink: sink() }));
    const name = createdName();
    expect(msg).toMatch(/docker create failed \(exit 1\); cleanup failed: .*could not confirm/);
    expect(msg).toContain(name);
    expect(stateText()).toBe(name);
    const failures = await removeAllContainers();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(name);
    delete process.env.FAKE_RM_FAIL;
    expect(await removeAllContainers()).toEqual([]);
    expect(stateText()).toBe('');
    expect(await removeAllContainers()).toEqual([]);
  }, 30_000);

  it('confirms absence by name when docker create failed and nothing was created', async () => {
    process.env.FAKE_CREATE = 'refused';
    const msg = await message(runContainer({ ...base, sink: sink() }));
    expect(msg).toMatch(/docker create failed \(exit 1\)/);
    expect(msg).not.toMatch(/cleanup failed/);
    expect(logText()).toMatch(/^ps -a --filter name=/m);
    expect(await removeAllContainers()).toEqual([]);
  });

  it('needs no reconciliation when the docker CLI could not be started at all', async () => {
    setDockerCommand(join(dir, 'no-such-docker'));
    let msg: string;
    try {
      msg = await message(runContainer({ ...base, sink: sink() }));
    } finally {
      setDockerCommand(bin);
    }
    expect(msg).toMatch(/docker create failed/);
    expect(msg).not.toMatch(/cleanup failed/);
    expect(await removeAllContainers()).toEqual([]);
  });
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

  it('an interruption after the publishing rename keeps the finished extraction (data review D-M1)', () => {
    // A signal handled after the rename completed but before the run recorded it as published.
    const dest = join(dir, 'published');
    mkdirSync(dest);
    writeFileSync(join(dest, 'events.csv'), 'rows');
    writeFileSync(join(dest, 'manifest.json'), '{}');
    const staging = `${dest}.staging-0123456789ab`;
    cleanupExtraction({ dest, staging }, { stagingCreated: true, published: false });
    expect(readdirSync(dest).sort()).toEqual(['events.csv', 'manifest.json']);
    expect(existsSync(staging)).toBe(false);
    // Before the rename the destination is only the empty reservation: removed with the staging directory.
    const reserved = join(dir, 'reserved');
    mkdirSync(reserved);
    const work = `${reserved}.staging-0123456789ab`;
    mkdirSync(work);
    writeFileSync(join(work, 'manifest.json'), '{}');
    cleanupExtraction({ dest: reserved, staging: work }, { stagingCreated: true, published: false });
    expect(existsSync(reserved)).toBe(false);
    expect(existsSync(work)).toBe(false);
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
