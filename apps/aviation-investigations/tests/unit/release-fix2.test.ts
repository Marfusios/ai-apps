import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { childEnvironment, hasStartupWarning, runRelease } from '../../scripts/release-runner.js';
import { releaseEffects, runReleaseChild } from '../../scripts/release-effects.js';
import { ReleaseError } from '../../scripts/release-config.js';
import { fakeRelease } from '../support/release.js';

afterEach(() => vi.unstubAllEnvs());
const listening = JSON.stringify({ level: 30, msg: 'Server listening at http://127.0.0.1:3000' });

it('ignores visitor-caused app warnings after listening on the first run and a no-restart rerun', async () => {
  const f = fakeRelease(), container = f.importer.live!.container;
  f.behavior.startupLogs.set(container, `${listening}\n${JSON.stringify({ level: 40, msg: 'evidence rerank unavailable' })}`);
  expect(await runRelease(f.args, f.fx)).toBe(0);
  f.behavior.clock += 3_600_000;
  f.behavior.startupLogs.set(container, f.behavior.startupLogs.get(container) +
    '\n' + JSON.stringify({ level: 40, msg: 'Google sign-in refused' }));
  expect(await runRelease(f.args, f.fx)).toBe(0);
  const reads = f.commands.filter((c) => c.command === 'docker' && c.args[0] === 'logs');
  expect(reads).toHaveLength(2);
  expect(reads[0]!.args).toEqual(reads[1]!.args);
  expect(f.output.filter((line) => line === 'live-up: ok')).toHaveLength(2);
});
it.each([40, 50, 60])('still fails a level-%i configuration warning before listening', async (level) => {
  const f = fakeRelease();
  f.behavior.startupLogs.set(f.importer.live!.container, `${JSON.stringify({ level, msg: 'AI feature off' })}\n${listening}`);
  expect(await runRelease(f.args, f.fx)).toBe(1);
  expect(f.events).not.toContain('dev-up');
  expect(f.output).toContain('live-up: failed; startup warning or error; see the private step log');
});
it.each([
  ['a non-request warning', '{"level":40,"msg":"evidence rerank unavailable"}', true],
  ['a request warning', '{"level":60,"reqId":"request","msg":"request failed"}', false],
  ['info only', '{"level":30,"msg":"startup"}', false],
  ['a changed listening message', '{"level":30,"msg":"Now listening"}\n{"level":40,"msg":"warning"}', true],
  ['a request impersonating readiness', '{"level":30,"reqId":"request","msg":"Server listening at http://127.0.0.1:3000"}\n{"level":40,"msg":"configuration warning"}', true],
] as const)('without a usable listening line, checks the whole window: %s', (_name, output, expected) => {
  expect(hasStartupWarning(output)).toBe(expected);
});
it('uses the first listening line even if Fastify announces several addresses', () => {
  expect(hasStartupWarning(`${listening}\n{"level":40,"msg":"visitor warning"}\n${listening}`)).toBe(false);
  expect(hasStartupWarning(`{"level":40,"reqId":"request","msg":"request warning"}\n${listening}`)).toBe(false);
});

it('the real effects snapshot sends one Docker endpoint to every child, including lock helpers', async () => {
  vi.stubEnv('DOCKER_HOST', 'unix:///example/docker.sock');
  vi.stubEnv('DOCKER_CONTEXT', 'offline-context');
  vi.stubEnv('DOCKER_CONFIG', '/example/docker-config');
  vi.stubEnv('DATABASE_URL', 'PRIVATE_DATABASE_SENTINEL');
  vi.stubEnv('OPENAI_API_KEY', 'PRIVATE_PROVIDER_SENTINEL');
  vi.stubEnv('NODE_OPTIONS', 'PRIVATE_NODE_SENTINEL');
  const real = releaseEffects(), f = fakeRelease();
  f.fx.environment = real.environment; f.fx.importerEnvironment = real.importerEnvironment;
  const lockEnvironments: Record<string, string>[] = [], lock = f.fx.lock;
  f.fx.lock = async (path, env) => { lockEnvironments.push(env); return lock(path, env); };
  expect(await runRelease(f.args, f.fx)).toBe(0);
  for (const env of [...f.commands.map((c) => c.env), ...lockEnvironments]) {
    expect(env.DOCKER_HOST).toBe('unix:///example/docker.sock');
    expect(env.DOCKER_CONTEXT).toBe('offline-context');
    expect(env.DOCKER_CONFIG).toBe('/example/docker-config');
    expect(JSON.stringify(env)).not.toContain('PRIVATE_');
  }
  expect(lockEnvironments).toHaveLength(2);
  expect(f.commands.some((c) => c.args[0] === 'inspect')).toBe(true);
  expect(f.commands.some((c) => c.args[0] === 'logs')).toBe(true);
  // Run a harmless actual Node child through that environment too, without invoking Docker.
  const env = childEnvironment(real.environment, undefined, real.importerEnvironment);
  const result = await real.run({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.env))'],
    cwd: fileURLToPath(new URL('../..', import.meta.url)), env, locks: [], timeoutMs: 5000 });
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(env);
});
it('does not create empty Docker overrides or forward unrelated host variables', () => {
  const base = { PATH: '/example/bin', HOME: '/example/home' };
  expect(childEnvironment(base, undefined, { DOCKER_HOST: '', DOCKER_CONTEXT: undefined, DATABASE_URL: 'PRIVATE_SENTINEL' })).toEqual(base);
});

it.each(['health-sleep', 'public-check', 'config', 'release-error'] as const)('reports interruption rather than the step error during %s', async (where) => {
  const f = fakeRelease(), abort = new AbortController(); f.fx.signal = abort.signal;
  if (where === 'health-sleep') {
    f.behavior.health = 503;
    f.fx.sleep = async () => { abort.abort(); throw new DOMException('PRIVATE_ABORT_MESSAGE', 'AbortError'); };
  } else if (where === 'public-check') {
    const http = f.fx.httpStatus;
    f.fx.httpStatus = async (url, timeout) => {
      if (new URL(url).pathname === '/') { abort.abort(); throw new Error('PRIVATE_FETCH_ERROR'); }
      return http(url, timeout);
    };
  } else {
    f.fx.readImporter = async () => {
      abort.abort();
      throw where === 'release-error' ? new ReleaseError(75, 'PRIVATE_OTHER_REASON') : new Error('PRIVATE_CONFIG_ERROR');
    };
  }
  expect(await runRelease(f.args, f.fx)).toBe(1);
  const failures = f.output.filter((line) => line.includes(': failed;'));
  expect(failures).toEqual([`${where === 'health-sleep' || where === 'public-check' ? 'live-up' : 'files'}: failed; release interrupted`]);
  expect(f.output.join('\n')).not.toContain('PRIVATE_');
  if (where === 'health-sleep' || where === 'public-check') {
    expect(f.events).toContain(`unlock:${f.importer.hostLock}`);
    expect(f.events).toContain(`unlock:${f.importer.maintenanceLock}`);
    expect(f.events).not.toContain('dev-up');
  }
});
it.each([
  ['busy', 75, 'locks: failed; the importer or a backup is running'],
  ['config', 2, 'docker: failed; container image ID has an unexpected format'],
  ['step', 1, 'preflight: failed; pnpm command failed; see the private step log'],
  ['interrupt', 1, 'live-up: failed; release interrupted'],
] as const)('retains the %s failure and exit %i when cleanup also fails', async (where, exit, original) => {
  const f = fakeRelease(); f.behavior.closeFailure = f.importer.hostLock;
  if (where === 'busy') f.behavior.busy = f.importer.maintenanceLock;
  if (where === 'config') f.images.set(f.importer.live!.container, 'invalid');
  if (where === 'step') f.behavior.fail = 'preflight';
  if (where === 'interrupt') {
    const abort = new AbortController(); f.fx.signal = abort.signal; f.behavior.health = 503;
    f.fx.sleep = async () => { abort.abort(); throw new Error('PRIVATE_ABORT_MESSAGE'); };
  }
  expect(await runRelease(f.args, f.fx)).toBe(exit);
  expect(f.output.filter((line) => line.includes(': failed;'))).toEqual([
    original, 'release-locks: failed; could not close a release lock',
  ]);
  expect(f.output.at(-1)).toMatch(/^summary:/);
  expect(f.output.join('\n')).not.toContain('PRIVATE_');
});

it('pnpm launches with the Node loader and no arguments prints usage with exit 2, offline', async () => {
  const app = fileURLToPath(new URL('../..', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  expect(manifest.scripts['app:release']).toBe('node --import tsx scripts/release.ts');
  const result = await runReleaseChild({ command: 'pnpm', args: ['app:release'], cwd: app,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, COREPACK_ENABLE_NETWORK: '0' }, locks: [], timeoutMs: 15_000 });
  expect(result.code).toBe(2);
  expect(result.stdout + result.stderr).toContain('usage: pnpm app:release --config <absolute path> [--dry-run]');
  expect(result.stdout + result.stderr).not.toContain('checkout:');
}, 20_000);
