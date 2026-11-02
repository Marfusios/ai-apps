import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink, chmod, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicPrivateReplace, parseReleaseConfig, privateLogDirectory, readPrivateFile, repin, versionEdit } from '../../scripts/release-config.js';
import { childEnvironment, hasStartupWarning, inReleaseQuietWindow, releaseTag, runRelease } from '../../scripts/release-runner.js';
import { runReleaseChild } from '../../scripts/release-effects.js';
import { hostLock, journalLine } from '../../worker/importer/host.js';
import { fakeRelease, RELEASE_HEAD, RELEASE_IMAGE, RELEASE_VERSION, OLD_IMAGE } from '../support/release.js';

afterEach(() => vi.unstubAllEnvs());

describe('Prague quiet window, including DST dates', () => {
  it.each([
    ['2026-01-15', 1], ['2026-07-15', 2], ['2026-03-29', 2], ['2026-10-25', 1],
  ])('%s uses the civil clock', (day, offset) => {
    for (const [hours, minutes, expected] of [[3, 29, false], [3, 30, true], [5, 59, true], [6, 0, false]] as const) {
      expect(inReleaseQuietWindow(new Date(`${day}T${String(hours - Number(offset)).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`)), `${hours}:${minutes}`).toBe(expected);
    }
  });
  it('allows both repeated 02:30 instants and refuses 03:30 after the autumn change', () => {
    expect(inReleaseQuietWindow(new Date('2026-10-25T00:30:00Z'))).toBe(false);
    expect(inReleaseQuietWindow(new Date('2026-10-25T01:30:00Z'))).toBe(false);
    expect(inReleaseQuietWindow(new Date('2026-10-25T02:30:00Z'))).toBe(true);
  });
});

it.each(['', `${RELEASE_VERSION}\tcommit`, 'v1\ttag', '2026.11.01-1111111\ttag', `${RELEASE_VERSION}\ttag\n2026.11.02-abcdef1\ttag`])('rejects invalid tag evidence %s', (refs) => {
  expect(() => releaseTag(RELEASE_HEAD, refs)).toThrow();
});
it('accepts exactly one matching annotated tag', () => {
  expect(releaseTag(RELEASE_HEAD, `${RELEASE_VERSION}\ttag\nold-unrelated-tag\tcommit`)).toBe(RELEASE_VERSION);
});

it.each(['branch', 'tracked', 'untracked', 'checkout'] as const)('refuses wrong checkout: %s', async (issue) => {
  const f = fakeRelease();
  if (issue === 'branch') f.behavior.branch = 'feature';
  if (issue === 'tracked') f.behavior.dirty = ' M source.ts';
  if (issue === 'untracked') f.behavior.dirty = '?? new.ts';
  if (issue === 'checkout') f.fx.ownCheckout = '/example/worktree';
  expect(await runRelease(f.args, f.fx)).toBe(2);
  expect(f.writes).toEqual([]);
  expect(f.commands.some((c) => c.command !== 'git')).toBe(false);
});
it('checks quiet time before files, locks or Docker', async () => {
  const f = fakeRelease(); f.behavior.clock = Date.parse('2026-11-01T03:00:00Z');
  expect(await runRelease(f.args, f.fx)).toBe(75);
  expect(f.events.some((v) => v.includes(f.config.importerConfig) || v.startsWith('lock:') || v.startsWith('docker:'))).toBe(false);
});
it.each(['--unknown', '--config', 'relative', 'bad-json', 'unknown-key'] as const)('invalid args/config exit 2: %s', async (problem) => {
  const f = fakeRelease(); let args = f.args;
  if (problem === '--unknown') args = [...args, problem];
  if (problem === '--config') args = ['--config'];
  if (problem === 'relative') args = ['--config', 'relative.json'];
  if (problem === 'bad-json') f.files.set(args[1]!, Buffer.from('{'));
  if (problem === 'unknown-key') f.files.set(args[1]!, Buffer.from(JSON.stringify({ ...f.config, unknown: true })));
  expect(await runRelease(args, f.fx)).toBe(2); expect(f.commands).toEqual([]);
});

it.each(['# no version\n', 'APP_VERSION=one\nAPP_VERSION=two\n', 'APP_VERSION=one\nexport APP_VERSION=two\n'])('rejects ambiguous APP_VERSION', (text) => {
  expect(() => versionEdit(Buffer.from(text), RELEASE_VERSION)).toThrow();
});
it.each(['\n', '\r\n'])('preserves all other bytes and %j endings', (end) => {
  for (const final of ['', end]) {
    const before = Buffer.from(`# café${end}APP_VERSION=old${end}OTHER="x = 2"${final}`);
    const edited = versionEdit(before, RELEASE_VERSION);
    expect(edited.current).toBe('old');
    expect(edited.bytes.toString()).toBe(`# café${end}APP_VERSION=${RELEASE_VERSION}${end}OTHER="x = 2"${final}`);
    expect(versionEdit(edited.bytes, RELEASE_VERSION).bytes).toBe(edited.bytes);
  }
});

async function temp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aircase-release-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
it('validates real descriptor permissions, symlinks, bound and owner-only config', async () => temp(async (dir) => {
  const p = join(dir, 'env'), link = join(dir, 'link');
  await writeFile(p, 'APP_VERSION=old\n', { mode: 0o600 });
  expect((await readPrivateFile(p)).toString()).toContain('old');
  await symlink(p, link); await expect(readPrivateFile(link)).rejects.toThrow();
  await chmod(p, 0o644); await expect(readPrivateFile(p)).rejects.toThrow();
  await chmod(p, 0o400); await expect(readPrivateFile(p)).rejects.toThrow();
  await expect(readPrivateFile(p, false)).resolves.toBeInstanceOf(Buffer);
  await chmod(p, 0o600); await writeFile(p, Buffer.alloc(65537));
  await expect(readPrivateFile(p)).rejects.toThrow();
  await expect(readPrivateFile(dir)).rejects.toThrow();
}));
it('atomic version editing retains mode, no-ops at equality, refuses concurrent changes and invalid pins', async () => temp(async (dir) => {
  const p = join(dir, 'env'), before = Buffer.from('KEEP="verbatim"\r\nAPP_VERSION=old');
  await writeFile(p, before, { mode: 0o600 });
  const after = versionEdit(before, RELEASE_VERSION).bytes;
  await atomicPrivateReplace(p, before, after);
  expect(await readFile(p)).toEqual(after); expect((await stat(p)).mode & 0o7777).toBe(0o600);
  const ino = (await stat(p)).ino;
  await atomicPrivateReplace(p, after, after); expect((await stat(p)).ino).toBe(ino);
  await expect(atomicPrivateReplace(p, before, after)).rejects.toThrow('changed');
  expect(() => repin(Buffer.from('{}'), RELEASE_HEAD, RELEASE_IMAGE)).toThrow();
  expect(await readFile(p)).toEqual(after);
}));
it('logs are owner-only, append safely and refuse symlink directories', async () => temp(async (dir) => {
  const logs = join(dir, 'logs');
  await privateLogDirectory(logs, '/example/checkout');
  expect((await stat(logs)).mode & 0o7777).toBe(0o700);
  await symlink(logs, join(dir, 'alias')); await expect(privateLogDirectory(join(dir, 'alias'), '/example/checkout')).rejects.toThrow();
  await expect(privateLogDirectory('/example/checkout/logs', '/example/checkout')).rejects.toThrow();
}));

it('runs the complete ordered plan with fresh environments and unlocks before recertify', async () => {
  vi.stubEnv('DATABASE_URL', 'PRIVATE_LEAK_SENTINEL'); vi.stubEnv('APP_ENV', 'wrong');
  const f = fakeRelease();
  expect(await runRelease(f.args, f.fx)).toBe(0);
  const ordered = ['install', 'dev-migrate', 'dev-privileges', 'live-migrate', 'live-privileges', 'preflight', 'live-up', 'dev-up', `write:${f.config.importerConfig}`, `unlock:${f.importer.maintenanceLock}`, `unlock:${f.importer.hostLock}`, 'recertify'];
  const actual = f.events.filter((e) => ordered.includes(e)); expect(actual).toEqual(ordered);
  const afterUp = f.events.indexOf('dev-up');
  expect(f.events.slice(afterUp, f.events.indexOf(`write:${f.config.importerConfig}`)).filter((v) => v === 'docker:inspect')).toHaveLength(3);
  for (const command of f.commands) {
    expect(Object.keys(command.env).sort()).toEqual(command.args.includes('recertify') ? ['DOCKER_CONTEXT', 'HOME', 'PATH', 'TZ', 'USER'] :
      command.env.AVIATION_ENV_FILES ? ['AVIATION_ENV_FILES', 'DOCKER_CONTEXT', 'HOME', 'PATH'] : ['DOCKER_CONTEXT', 'HOME', 'PATH']);
    expect(command.env.DOCKER_CONTEXT).toBe('offline-context');
    expect(JSON.stringify(command.env)).not.toContain('PRIVATE_LEAK');
  }
  expect(f.commands.find((c) => c.args.includes('recertify'))!.locks).toEqual([]);
  const pinned = JSON.parse(f.files.get(f.config.importerConfig)!.toString());
  expect(pinned.code).toBe(RELEASE_HEAD); expect(pinned.live.image).toBe(RELEASE_IMAGE); expect(pinned.dev.image).toBe(RELEASE_IMAGE);
  expect(pinned.installation).toEqual(f.importer.installation);
  expect(f.output.join('\n')).not.toMatch(/PRIVATE|postgres:|DATABASE_URL/);
});
it.each(['hostLock', 'maintenanceLock'] as const)('a busy %s is read-only, exits 75 and releases earlier locks', async (which) => {
  const f = fakeRelease(); f.behavior.busy = f.importer[which];
  expect(await runRelease(f.args, f.fx)).toBe(75);
  expect(f.writes).toEqual([]); expect(f.logs.size).toBe(0);
  expect(f.commands.every((c) => c.command === 'git')).toBe(true);
  if (which === 'maintenanceLock') expect(f.events).toContain(`unlock:${f.importer.hostLock}`);
  expect(f.output.join('\n')).toContain('the importer or a backup is running');
});
it('dry run takes and releases both locks, prints plan and performs no writes or mutating child', async () => {
  const f = fakeRelease(); expect(await runRelease([...f.args, '--dry-run'], f.fx)).toBe(0);
  expect(f.writes).toEqual([]); expect(f.logs.size).toBe(0);
  expect(f.events.some((e) => e.startsWith('mkdir:'))).toBe(false);
  expect(f.commands.every((c) => ['git', 'docker'].includes(c.command))).toBe(true);
  expect(f.output.join('\n')).toContain(`importer code ${f.importer.code} -> ${RELEASE_HEAD}`);
  expect(f.output.join('\n')).toContain('built in step 5');
  expect(f.events.slice(-2)).toEqual([`unlock:${f.importer.maintenanceLock}`, `unlock:${f.importer.hostLock}`]);
});
it('second run at the same tag preserves env/config bytes and image IDs', async () => {
  const f = fakeRelease(); expect(await runRelease(f.args, f.fx)).toBe(0);
  f.writes.length = 0; const state = [...f.files].map(([p, b]) => [p, b.toString()]);
  expect(await runRelease(f.args, f.fx)).toBe(0);
  expect(f.writes).toEqual([]); expect([...f.files].map(([p, b]) => [p, b.toString()])).toEqual(state);
  expect([...f.images.values()]).toEqual([RELEASE_IMAGE, RELEASE_IMAGE]);
});
it.each(['dev-migrate', 'dev-privileges', 'live-migrate', 'live-privileges', 'preflight'] as const)('%s failure stops the release and keeps importer pins', async (name) => {
  const f = fakeRelease(); f.behavior.fail = name;
  expect(await runRelease(f.args, f.fx)).toBe(1);
  expect(f.events).not.toContain('live-up'); expect(f.events).not.toContain('dev-up');
  if (name.startsWith('dev')) expect(f.events).not.toContain('live-migrate');
  expect(f.writes).not.toContain(f.config.importerConfig);
  expect(f.output.join('\n')).not.toContain('PRIVATE_FAILURE_SENTINEL');
});
it.each(['mismatch', 'format'] as const)('refuses %s images before re-pin', async (problem) => {
  const f = fakeRelease(); f.behavior.devImage = problem === 'mismatch' ? OLD_IMAGE : 'unexpected';
  expect(await runRelease(f.args, f.fx)).toBe(1);
  expect(f.writes).not.toContain(f.config.importerConfig); expect(f.events).not.toContain('recertify');
});
it('concurrent importer config change is not overwritten', async () => {
  const f = fakeRelease(), run = f.fx.run;
  f.fx.run = async (c) => {
    const r = await run(c);
    if (c.args.includes('app:up') && c.env.AVIATION_ENV_FILES === f.config.dev.canaryEnvFiles.join(',')) f.files.set(f.config.importerConfig, Buffer.from('{}'));
    return r;
  };
  expect(await runRelease(f.args, f.fx)).toBe(1); expect(f.writes).not.toContain(f.config.importerConfig);
});
it.each([40, 50, 60])('startup level %i fails before starting dev', async (level) => {
  const f = fakeRelease(); f.behavior.startupLogs.set(f.importer.live!.container, JSON.stringify({ level, msg: 'PRIVATE_WARNING_SENTINEL' }));
  expect(await runRelease(f.args, f.fx)).toBe(1); expect(f.events).not.toContain('dev-up');
  expect(f.output.join('\n')).not.toContain('PRIVATE_WARNING_SENTINEL');
});
it('retrying a release checks the same container startup instead of forgetting its warning', async () => {
  const f = fakeRelease(); f.behavior.startupLogs.set(f.importer.live!.container, '{"level":40,"msg":"startup warning"}');
  expect(await runRelease(f.args, f.fx)).toBe(1);
  f.behavior.clock += 3_600_000;
  expect(await runRelease(f.args, f.fx)).toBe(1);
  const reads = f.commands.filter((c) => c.command === 'docker' && c.args[0] === 'logs');
  expect(reads).toHaveLength(2); expect(reads[0]!.args).toEqual(reads[1]!.args);
  expect(reads[0]!.args).toContain('2026-11-01T10:59:00.000000000Z');
  expect(f.events).not.toContain('dev-up');
});
it('ignores request log lines when checking startup warnings', () => {
  expect(hasStartupWarning('{"level":50,"reqId":"r1","msg":"api request"}\nnot json\n{"level":30,"msg":"started"}')).toBe(false);
});
it('bounds health polling and refuses an unexpected signed-out status', async () => {
  const f = fakeRelease(); f.behavior.health = 503; const start = f.behavior.clock;
  expect(await runRelease(f.args, f.fx)).toBe(1); expect(f.behavior.clock - start).toBe(180_000);
  expect(f.events).not.toContain('dev-up');
  const other = fakeRelease(); other.behavior.httpOverrides.set('/admin', 200);
  expect(await runRelease(other.args, other.fx)).toBe(1); expect(other.events).not.toContain('dev-up');
});
it('requires a readable running version to match', async () => {
  const f = fakeRelease(); f.behavior.runningVersion = 'APP_VERSION=old';
  expect(await runRelease(f.args, f.fx)).toBe(1); expect(f.events).not.toContain('dev-up');
});
it.each([
  { code: 1, line: '{"step":"check","result":"deferred","reason":"source_unavailable"}' },
  { code: 0, line: 'PRIVATE_RAW_SENTINEL' },
  { code: 0, line: '{"step":"complete","result":"published","reason":null}' },
])('requires unchanged final step and exit 0 on recertify: %j', async (result) => {
  const f = fakeRelease(); f.behavior.recertify = result;
  expect(await runRelease(f.args, f.fx)).toBe(1);
  expect(f.output.join('\n')).toContain('idempotent'); expect(f.output.join('\n')).not.toContain('PRIVATE_RAW_SENTINEL');
  expect(f.events.indexOf(`unlock:${f.importer.hostLock}`)).toBeLessThan(f.events.indexOf('recertify'));
});
it('actual subprocess gets only the explicit environment and writes private logs', async () => temp(async (dir) => {
  vi.stubEnv('DATABASE_URL', 'PRIVATE_LEAK_SENTINEL');
  const log = join(dir, 'child.log');
  const result = await runReleaseChild({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.env)); console.error("offline diagnostic")'], cwd: dir,
    env: childEnvironment({ PATH: process.env.PATH!, HOME: dir }), log, timeoutMs: 5000, locks: [] });
  expect(result.code).toBe(0); expect(Object.keys(JSON.parse(result.stdout)).sort()).toEqual(['HOME', 'PATH']);
  expect((await readFile(log, 'utf8'))).not.toContain('PRIVATE_LEAK');
  expect((await stat(log)).mode & 0o7777).toBe(0o600);
}));
it('existing-lock mode refuses missing files without creating them, and uses the same flock inode', async () => temp(async (dir) => {
  const path = join(dir, 'lock'), env = childEnvironment({ PATH: process.env.PATH!, HOME: dir });
  await expect(hostLock(path, env, false)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path, '', { mode: 0o600 });
  const first = await hostLock(path, env, false);
  try { await expect(hostLock(path, env, false)).rejects.toMatchObject({ reason: 'busy' }); }
  finally { await first.close(); }
  const again = await hostLock(path, env, false); await again.close();
}));
it('subprocess timeout fails, preserves logs, and does not echo arbitrary output as importer steps', async () => temp(async (dir) => {
  const lines: string[] = [], log = join(dir, 'timeout.log');
  const r = await runReleaseChild({ command: process.execPath,
    args: ['-e', 'console.log("PRIVATE_RAW_SENTINEL"); setInterval(() => {}, 1000)'],
    cwd: dir, env: childEnvironment({ PATH: process.env.PATH!, HOME: dir }), log, locks: [], timeoutMs: 2000,
    importerLine: (line) => { lines.push(line); } });
  expect(r.code).toBe(1); expect((await readFile(log, 'utf8'))).toContain('PRIVATE_RAW_SENTINEL');
  // The process adapter passes the line to the runner; only its allowlisted journal parser may print it.
  expect(lines).toEqual(['PRIVATE_RAW_SENTINEL']);
}));
it('a bad file or invalid initial image fails before any change', async () => {
  const f = fakeRelease(); f.behavior.badFile = f.config.dev.migratorEnvFile;
  expect(await runRelease(f.args, f.fx)).toBe(2); expect(f.events.some((e) => e.startsWith('lock:'))).toBe(false);
  const other = fakeRelease(); other.images.set(other.importer.dev.container, 'bad');
  expect(await runRelease(other.args, other.fx)).toBe(2); expect(other.writes).toEqual([]); expect(other.logs.size).toBe(0);
});
it('invalid re-pinning input cannot produce replacement bytes', () => {
  const f = fakeRelease(), original = f.files.get(f.config.importerConfig)!;
  expect(() => repin(original, 'bad-commit', RELEASE_IMAGE)).toThrow();
  expect(() => repin(original, RELEASE_HEAD, 'bad-image')).toThrow();
  expect(f.files.get(f.config.importerConfig)).toEqual(original);
});
it('recognizes safe importer failures on stderr without echoing other diagnostics', async () => temp(async (dir) => {
  const output: string[] = [], line = '{"step":"check","result":"deferred","reason":"busy"}';
  const r = await runReleaseChild({ command: process.execPath,
    args: ['-e', `console.error("PRIVATE_RAW_SENTINEL"); console.error(${JSON.stringify(line)}); process.exitCode=1`],
    cwd: dir, env: childEnvironment({ PATH: process.env.PATH!, HOME: dir }), log: join(dir, 'child.log'), locks: [], timeoutMs: 5000,
    importerLine: (text) => { const safe = journalLine(text); if (safe) output.push(safe); } });
  expect(r.code).toBe(1); expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toEqual(JSON.parse(line)); expect(output.join('')).not.toContain('PRIVATE_RAW_SENTINEL');
}));
it('refuses a moved tag before changing importer pins', async () => {
  const f = fakeRelease(), run = f.fx.run;
  f.fx.run = async (c) => {
    const r = await run(c);
    if (c.args.includes('app:up')) f.behavior.tags = '';
    return r;
  };
  expect(await runRelease(f.args, f.fx)).toBe(1); expect(f.writes).not.toContain(f.config.importerConfig);
});
