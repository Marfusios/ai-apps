import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP_DIR = resolve(import.meta.dirname, '../..');
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_DOCKER_LOG"
case "$1" in
  image) echo sha256:${'0'.repeat(64)}; exit 0;;
  create) echo ${'cd'.repeat(32)}; exit 0;;
  rm)
    sleep "\${FAKE_RM_SLEEP:-0}"
    if [ -n "$FAKE_RM_FAIL" ]; then echo "rm-failed" >> "$FAKE_DOCKER_LOG"; exit 1; fi
    echo "rm-done" >> "$FAKE_DOCKER_LOG"; exit 0;;
  start) exec sleep 60;;
esac
`;

let dir: string;
let zipPath: string;
let sha256: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cli-signal-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), FAKE);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  const z = new yazl.ZipFile();
  z.addBuffer(Buffer.from('not a database'), 'avall.mdb');
  z.end();
  const chunks: Buffer[] = [];
  for await (const c of z.outputStream) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  zipPath = join(dir, 'a.zip');
  writeFileSync(zipPath, buf);
  sha256 = createHash('sha256').update(buf).digest('hex');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(signal: 'SIGINT' | 'SIGTERM', env: Record<string, string>, name: string) {
  const log = join(dir, `${name}.log`);
  const out = join(dir, name);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'worker/cli.ts', 'extract', '--archive', zipPath, '--sha256', sha256, '--out', out],
    {
      cwd: APP_DIR,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.on('close', r));
  for (let i = 0; i < 200 && !(existsSync(log) && readFileSync(log, 'utf8').includes('start -a')); i++) {
    await sleep(100);
  }
  expect(readFileSync(log, 'utf8')).toContain('start -a');
  child.kill(signal);
  const code = await exited;
  const logText = readFileSync(log, 'utf8');
  return { code, logText, stderr, out };
}

describe('CLI signal handling', () => {
  for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    it(`${signal}: exits only after delayed container removal completes`, async () => {
      const r = await run(signal, { FAKE_RM_SLEEP: '1' }, `slow-${signal}`);
      expect(r.code).toBe(expected);
      expect(r.logText).toContain('rm-done');
      expect(existsSync(r.out)).toBe(false);
    }, 30_000);

    it(`${signal}: reports a failed removal and still exits with the signal code`, async () => {
      const r = await run(signal, { FAKE_RM_FAIL: '1' }, `fail-${signal}`);
      expect(r.code).toBe(expected);
      expect(r.logText).toContain('rm-failed');
      expect(r.logText).not.toContain('rm-done');
      expect(r.stderr).toMatch(/could not confirm removal/);
      expect(existsSync(r.out)).toBe(false);
    }, 30_000);
  }
});
