import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicPrivateReplace, readPrivateFile, validateLogDirectory, validatePrivateParent } from '../../scripts/release-config.js';
import { releaseEffects, runReleaseChild } from '../../scripts/release-effects.js';
import { hasStartupWarning, RECERTIFY_TIMEOUT_MS, runRelease } from '../../scripts/release-runner.js';
import { installReleaseSignals, releaseSignals } from '../../scripts/release-signals.js';
import { IMPORT_DEADLINE_MS, IMPORT_HOST_ENVIRONMENT } from '../../worker/importer/host.js';
import { fakeRelease, RELEASE_VERSION } from '../support/release.js';

afterEach(() => vi.unstubAllEnvs());
async function temp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aircase-release-fix-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function saveConfig(f: ReturnType<typeof fakeRelease>) { f.files.set(f.args[1]!, Buffer.from(JSON.stringify(f.config))); }

it('passes with the private canary warnings, checking only live startup logs', async () => {
  const f = fakeRelease();
  expect(f.behavior.startupLogs.get(f.importer.dev.container)).toBe(
    '{"level":40,"msg":"AI feature off"}\n{"level":40,"msg":"Google sign-in off"}');
  expect(await runRelease(f.args, f.fx)).toBe(0);
  expect(f.commands.filter((c) => c.command === 'docker' && c.args[0] === 'logs').map((c) => c.args.at(-1)))
    .toEqual([f.importer.live!.container]);
  expect(f.events).toContain(`http:${f.importer.dev.applicationUrl}/api/config`);
  expect(f.commands.filter((c) => c.args.at(-1) === f.importer.dev.container)
    .some((c) => c.args.some((a) => a.includes('.Config.Env')))).toBe(true);
  expect(f.output.at(-1)).toContain('recertify unchanged');
});

it('ignores request warnings on the first run and later requests inside the same startup window on a rerun', async () => {
  const f = fakeRelease();
  f.behavior.startupLogs.set(f.importer.live!.container,
    '{"level":40,"reqId":"first","msg":"dependency unavailable"}');
  expect(await runRelease(f.args, f.fx)).toBe(0);
  f.behavior.clock += 3_600_000;
  f.behavior.startupLogs.set(f.importer.live!.container,
    f.behavior.startupLogs.get(f.importer.live!.container) + '\n{"level":40,"reqId":"later","msg":"search refused by Elasticsearch"}');
  expect(await runRelease(f.args, f.fx)).toBe(0);
  const reads = f.commands.filter((c) => c.command === 'docker' && c.args[0] === 'logs');
  expect(reads).toHaveLength(2);
  expect(reads[0]!.args).toEqual(['logs', '--since', '2026-11-01T10:59:00.000000000Z',
    '--until', '2026-11-01T11:02:00.000Z', f.importer.live!.container]);
  expect(reads[1]!.args).toEqual(reads[0]!.args);
});
it.each([40, 50, 60])('ignores every request-scoped level %i but retains app-level warnings', (level) => {
  expect(hasStartupWarning(JSON.stringify({ level, reqId: null, msg: 'arbitrary request message' }))).toBe(false);
  expect(hasStartupWarning(JSON.stringify({ level, msg: 'api request' }))).toBe(true);
});

it('uses unambiguous tag names at both checks when a branch has the tag name', async () => {
  const f = fakeRelease(); f.behavior.sameNameBranch = true;
  expect(await runRelease(f.args, f.fx)).toBe(0);
  const refs = f.commands.filter((c) => c.args[0] === 'for-each-ref');
  expect(refs).toHaveLength(2);
  for (const c of refs) expect(c.args).toContain('--format=%(refname:lstrip=2)\t%(objecttype)');
});
it('recertify gets the shared three-hour importer deadline plus fifteen minutes', async () => {
  const f = fakeRelease(); expect(await runRelease(f.args, f.fx)).toBe(0);
  expect(IMPORT_DEADLINE_MS).toBe(3 * 3_600_000);
  expect(RECERTIFY_TIMEOUT_MS).toBe(IMPORT_DEADLINE_MS + 15 * 60_000);
  expect(f.commands.find((c) => c.args.includes('recertify'))!.timeoutMs).toBe(RECERTIFY_TIMEOUT_MS);
});

it.each(['wrong-live-env', 'wrong-preflight-env', 'wrong-dev-env', 'canary-mode', 'migration-mode', 'migration-version', 'migrator-database', 'migrator-role', 'migrator-protocol'] as const)
  ('refuses %s before locks, writes or deployment', async (problem) => {
    const f = fakeRelease();
    if (problem === 'wrong-live-env') f.files.set(f.config.live.versionFile, Buffer.from('APP_ENV=dev\nAPP_VERSION=old\n'));
    if (problem === 'wrong-preflight-env') f.files.set(f.config.live.preflightEnvFiles[0]!, Buffer.from('APP_ENV=dev\n'));
    if (problem === 'wrong-dev-env') f.files.set(f.config.dev.migrateEnvFiles[0]!, Buffer.from('APP_ENV=live\n'));
    if (problem === 'canary-mode') f.files.set(f.config.dev.versionFile, Buffer.from('APP_ENV=dev\nAPP_VERSION=old\n'));
    if (problem === 'migration-mode') f.files.set(f.config.dev.migrateEnvFiles[0]!, Buffer.from('APP_ENV=dev\nAVIATION_DEV_RELEASE_IMAGE=true\n'));
    if (problem === 'migration-version') f.files.set(f.config.dev.migrateEnvFiles[0]!, Buffer.from('APP_ENV=dev\nAPP_VERSION=tag\n'));
    if (problem.startsWith('migrator-')) {
      const url = problem === 'migrator-database' ? 'postgres://aviation_migrator:dummy@localhost/aviation_live' :
        problem === 'migrator-role' ? 'postgres://aviation_app:dummy@localhost/aviation_dev' : 'https://localhost/aviation_dev';
      f.files.set(f.config.dev.migratorEnvFile, Buffer.from(`DATABASE_MIGRATOR_URL=${url}\n`));
    }
    expect(await runRelease(f.args, f.fx)).toBe(2);
    expect(f.output.join('\n')).toContain('env files must select the correct environment');
    expect(f.writes).toEqual([]); expect(f.logs.size).toBe(0);
    expect(f.events.some((e) => e.startsWith('lock:') || e === 'install')).toBe(false);
  });
it('skips empty higher-priority values just like the actual dotenv loader', async () => {
  const f = fakeRelease(), empty = '/example/private/empty.env';
  f.files.set(empty, Buffer.from('APP_ENV=\nAPP_VERSION=\nAVIATION_DEV_RELEASE_IMAGE=\n'));
  f.config.live.composeEnvFiles.unshift(empty); f.config.dev.canaryEnvFiles.unshift(empty); saveConfig(f);
  expect(await runRelease(f.args, f.fx)).toBe(0);
});
it('an empty high-priority migration version cannot hide a lower-priority release version', async () => {
  const f = fakeRelease(), lower = '/example/private/lower.env';
  f.files.set(f.config.dev.migrateEnvFiles[0]!, Buffer.from('APP_ENV=dev\nAPP_VERSION=\n'));
  f.files.set(lower, Buffer.from('APP_VERSION=tag\n')); f.config.dev.migrateEnvFiles.push(lower); saveConfig(f);
  expect(await runRelease(f.args, f.fx)).toBe(2);
  expect(f.events).not.toContain('install');
});
it('accepts read-only owner-only importer files on both checks, while keeping release files strictly 0600', async () => {
  const f = fakeRelease();
  for (const path of [...f.importer.dev.envFiles, ...f.importer.live!.envFiles, f.importer.hostLock, f.importer.maintenanceLock]) f.modes.set(path, 0o400);
  expect(await runRelease(f.args, f.fx)).toBe(0);
  for (const file of [f.config.importerConfig, f.config.live.versionFile, f.config.dev.migratorEnvFile]) {
    const other = fakeRelease(); other.modes.set(file, 0o400);
    expect(await runRelease(other.args, other.fx)).toBe(2); expect(other.writes).toEqual([]);
  }
  const other = fakeRelease(); other.modes.set(other.importer.dev.envFiles[0]!, 0o640);
  expect(await runRelease(other.args, other.fx)).toBe(2);
});

it.each([false, true])('unsafe parents and log directories refuse before writes (dry-run %s)', async (dry) => {
  const candidates = fakeRelease();
  for (const path of [candidates.config.importerConfig, candidates.config.live.versionFile, candidates.config.dev.versionFile]) {
    const f = fakeRelease(); f.behavior.badParent = path;
    expect(await runRelease([...f.args, ...(dry ? ['--dry-run'] : [])], f.fx)).toBe(2);
    expect(f.writes).toEqual([]); expect(f.logs.size).toBe(0);
    expect(f.events.some((e) => e.startsWith('lock:') || e.startsWith('mkdir:'))).toBe(false);
    expect(f.output.at(-1)).toContain('logs not written');
  }
  for (const path of [candidates.config.logDir, join(candidates.config.logDir, RELEASE_VERSION)]) {
    const f = fakeRelease(); f.behavior.badLogs = path;
    expect(await runRelease([...f.args, ...(dry ? ['--dry-run'] : [])], f.fx)).toBe(2);
    expect(f.writes).toEqual([]); expect(f.logs.size).toBe(0);
    expect(f.events).not.toContain('install'); expect(f.output.at(-1)).toContain('logs not written');
  }
});
it('a late log-directory failure still exits 2 without claiming it wrote logs', async () => {
  const f = fakeRelease(); f.behavior.prepareLogsFailure = join(f.config.logDir, RELEASE_VERSION);
  expect(await runRelease(f.args, f.fx)).toBe(2);
  expect(f.output).toContain('logs: failed; release log directory could not be prepared');
  expect(f.output.at(-1)).toContain('logs not written');
  expect(f.writes).toEqual([]); expect(f.logs.size).toBe(0);
  expect(f.events.slice(-2)).toEqual([`unlock:${f.importer.maintenanceLock}`, `unlock:${f.importer.hostLock}`]);
});
it('uses the same real parent rule before and during writes, without repairing it', async () => temp(async (dir) => {
  const parent = join(dir, 'private'), path = join(parent, 'env');
  await mkdir(parent, { mode: 0o700 }); await writeFile(path, 'old', { mode: 0o600 }); await chmod(parent, 0o770);
  await expect(validatePrivateParent(path)).rejects.toMatchObject({ exitCode: 2 });
  await expect(atomicPrivateReplace(path, Buffer.from('old'), Buffer.from('new'))).rejects.toMatchObject({ exitCode: 1 });
  expect(await readFile(path, 'utf8')).toBe('old');
  await chmod(parent, 0o700); await validatePrivateParent(path);
  await symlink(parent, join(dir, 'link'));
  await expect(validatePrivateParent(join(dir, 'link', 'env'))).rejects.toMatchObject({ exitCode: 2 });
}));
it('validates log ancestors and existing permissions read-only, including symlinks', async () => temp(async (dir) => {
  const log = join(dir, 'missing', 'logs'), checkout = join(dir, 'checkout');
  await validateLogDirectory(log, checkout);
  await expect(stat(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  await chmod(dir, 0o770);
  await expect(validateLogDirectory(log, checkout)).rejects.toMatchObject({ exitCode: 2 });
  await chmod(dir, 0o700); await mkdir(join(dir, 'existing'), { mode: 0o755 });
  await expect(validateLogDirectory(join(dir, 'existing'), checkout)).rejects.toMatchObject({ exitCode: 2 });
  await symlink(dir, join(dir, 'link'));
  await expect(validateLogDirectory(join(dir, 'link', 'logs'), checkout)).rejects.toMatchObject({ exitCode: 2 });
}));

it('prints specific precheck reasons with no nonexistent-log hint', async () => {
  for (const value of ['{', '{}']) {
    const f = fakeRelease(); f.files.set(f.config.importerConfig, Buffer.from(value));
    expect(await runRelease(f.args, f.fx)).toBe(2);
    expect(f.output).toContain('files: failed; importer config is invalid (readImporterConfig)');
    expect(f.output.join('\n')).not.toContain('step log');
  }
  const invalid = fakeRelease(); invalid.fx.readImporter = async () => { throw new Error('PRIVATE_INVALID_CONFIG'); };
  expect(await runRelease(invalid.args, invalid.fx)).toBe(2);
  expect(invalid.output).toContain('files: failed; importer config is invalid (readImporterConfig)');
  expect(invalid.output.join('\n')).not.toContain('PRIVATE_INVALID_CONFIG');
  const missing = fakeRelease(); missing.fx.realpath = async () => { throw new Error('PRIVATE_ENOENT'); };
  expect(await runRelease(missing.args, missing.fx)).toBe(2);
  expect(missing.output).toEqual(['checkout: failed; checkout not found or inaccessible']);
  const git = fakeRelease(); git.behavior.fail = 'git:branch';
  expect(await runRelease(git.args, git.fx)).toBe(2);
  expect(git.output).toEqual(['checkout: failed; git command failed']);
});
it('attributes lock-close failure to release-locks after successful pinning', async () => {
  const f = fakeRelease(); f.behavior.closeFailure = f.importer.maintenanceLock;
  expect(await runRelease(f.args, f.fx)).toBe(1);
  expect(f.output).toContain('importer-pins: ok');
  expect(f.output).toContain('release-locks: failed; could not close a release lock');
  expect(f.output.join('\n')).not.toContain('importer-pins: failed');
  expect(f.events).not.toContain('recertify'); expect(f.events).toContain(`unlock:${f.importer.hostLock}`);
});
it('prints recertification result and reason in both failure and summary', async () => {
  const f = fakeRelease(); f.behavior.recertify = { code: 1, line: '{"step":"check","result":"deferred","reason":"source_unavailable"}' };
  expect(await runRelease(f.args, f.fx)).toBe(1);
  expect(f.output).toContain('recertify: failed; recertification failed: deferred/source_unavailable');
  expect(f.output.at(-1)).toContain('recertify deferred/source_unavailable');
});

it('wires the real checkout, environment allowlists and non-creating lock adapter', async () => temp(async (dir) => {
  vi.stubEnv('HOME', dir);
  for (const name of IMPORT_HOST_ENVIRONMENT) {
    if (!['PATH', 'HOME'].includes(name)) vi.stubEnv(name, `offline-${name}`);
  }
  for (const name of ['DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AVIATION_ENV_FILES', 'NODE_OPTIONS']) vi.stubEnv(name, 'PRIVATE_SENTINEL');
  const fx = releaseEffects();
  expect(await realpath(fx.ownCheckout)).toBe(await realpath(fileURLToPath(new URL('../../../..', import.meta.url))));
  expect(fx.environment).toEqual({ PATH: process.env.PATH, HOME: dir });
  expect(Object.keys(fx.importerEnvironment).sort()).toEqual([...IMPORT_HOST_ENVIRONMENT].sort());
  expect(JSON.stringify(fx.importerEnvironment)).not.toContain('PRIVATE_SENTINEL');
  for (const name of IMPORT_HOST_ENVIRONMENT) expect(fx.importerEnvironment[name]).toBe(process.env[name]);
  const p = join(dir, 'lock');
  await expect(fx.lock(p, fx.environment)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(p, '', { mode: 0o600 });
  const lock = await fx.lock(p, fx.environment); await lock.close();
  const f = fakeRelease(); f.fx.environment = fx.environment; f.fx.importerEnvironment = fx.importerEnvironment;
  expect(await runRelease(f.args, f.fx)).toBe(0);
  for (const c of f.commands) {
    if (c.args.includes('recertify')) expect(c.env).toEqual(fx.importerEnvironment);
    else expect(Object.keys(c.env).sort()).toEqual(c.env.AVIATION_ENV_FILES ? ['AVIATION_ENV_FILES', 'HOME', 'PATH'] : ['HOME', 'PATH']);
  }
  await expect(readPrivateFile(p)).resolves.toEqual(Buffer.alloc(0));
}));
it.each(['PATH', 'HOME'])('refuses a missing %s in the actual effects adapter', (key) => {
  vi.stubEnv(key, ''); expect(() => releaseEffects()).toThrow('PATH and HOME must be set');
});
it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('keeps %s listeners until cleanup and escalates later signals', (name) => {
  const source = new EventEmitter(), control = releaseSignals(), dispose = installReleaseSignals(control, source);
  source.emit(name); expect(control.signal.aborted).toBe(true); expect(control.forceSignal.aborted).toBe(false);
  source.emit(name); expect(control.forceSignal.aborted).toBe(true);
  source.emit(name); expect(source.listenerCount(name)).toBe(1);
  dispose(); for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(source.listenerCount(s)).toBe(0);
});
it('kills a stubborn real child on a second signal and drains the runner locks before reporting failure', async () => temp(async (dir) => {
  const f = fakeRelease(), control = releaseSignals(), source = new EventEmitter();
  const dispose = installReleaseSignals(control, source), run = f.fx.run;
  f.fx.signal = control.signal;
  let childPid = 0, childClosed = false, termSeen = false;
  f.fx.run = async (spec) => {
    if (spec.args[0] !== 'install') return run(spec);
    const result = await runReleaseChild({ ...spec, command: process.execPath, cwd: dir,
      env: { PATH: process.env.PATH!, HOME: dir }, locks: [], log: join(dir, 'child.log'), timeoutMs: 5000,
      args: ['-e', 'process.on("SIGTERM", () => console.log("TERM")); console.log(process.pid); setInterval(() => {}, 1000)'],
      importerLine: (line) => {
        if (/^\d+$/.test(line)) { childPid = Number(line); source.emit('SIGHUP'); }
        if (line === 'TERM') { termSeen = true; source.emit('SIGTERM'); }
      },
    }, control.signal, control.forceSignal);
    childClosed = true; return result;
  };
  const print = f.fx.print;
  f.fx.print = (line) => {
    if (line.startsWith('install: failed') || line.startsWith('summary:')) {
      expect(childClosed).toBe(true);
      expect(f.events).toContain(`unlock:${f.importer.hostLock}`);
      expect(f.events).toContain(`unlock:${f.importer.maintenanceLock}`);
    }
    print(line);
  };
  try {
    const started = performance.now();
    expect(await runRelease(f.args, f.fx)).toBe(1);
    expect(performance.now() - started).toBeLessThan(4000); // The second signal beats the five-second hard-kill fallback.
    expect(termSeen).toBe(true); expect(control.forceSignal.aborted).toBe(true);
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(f.output).toContain('install: failed; release interrupted');
    expect(f.output.at(-1)).toMatch(/^summary:/);
    expect(f.writes).toEqual([]); expect(f.events).not.toContain('dev-migrate');
    expect(await readFile(join(dir, 'child.log'), 'utf8')).toContain('TERM');
  } finally { control.stop(); control.stop(); dispose(); }
}));
it('an already aborted runner or child cannot start work', async () => temp(async (dir) => {
  const f = fakeRelease(), control = releaseSignals(); control.stop(); f.fx.signal = control.signal;
  expect(await runRelease(f.args, f.fx)).toBe(1); expect(f.events).toEqual([]);
  await expect(runReleaseChild({ command: process.execPath, args: ['-e', 'process.exit(0)'],
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir }, locks: [], timeoutMs: 1000 }, control.signal)).rejects.toThrow('interrupted');
}));
