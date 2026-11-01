import { join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { ImporterConfigSchema, type ImporterConfig } from '../worker/importer/config.js';
import { localClock } from '../worker/importer/status.js';
import { journalLine } from '../worker/importer/host.js';
import { checkDatabaseUrl } from './compose.js';
import { ReleaseError, outsideCheckout, parseReleaseConfig, repin, versionEdit, type ReleaseConfig } from './release-config.js';

export const QUIET_TIME_ZONE = 'Europe/Prague';
export const QUIET_START_MINUTE = 3 * 60 + 30;
export const QUIET_END_MINUTE = 6 * 60;
export const APP_HEALTH_TIMEOUT_MS = 180_000;
export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
export const RELEASE_TAG = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/;
export const STEPS = [
  'install', 'versions', 'dev-migrate', 'dev-privileges', 'live-migrate', 'live-privileges',
  'preflight', 'live-up', 'dev-canary-up', 'images', 'importer-pins', 'recertify',
] as const;
export type ReleaseStep = typeof STEPS[number];
const PLAN_STEPS = [
  'install', 'versions', 'dev-migrate; dev-privileges; live-migrate; live-privileges',
  'preflight', 'live-up; health, startup logs and public checks',
  'dev-canary-up; health, startup logs and image comparison', 'importer-pins',
  'release both locks; recertify',
];
export interface ReleaseLock { fd: number; close(): Promise<void> }
export interface Command {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  log?: string;
  locks: readonly ReleaseLock[];
  importerLine?: (line: string) => void;
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface ReleaseEffects {
  ownCheckout: string;
  environment: { PATH: string; HOME: string };
  now(): Date;
  realpath(path: string): Promise<string>;
  readPrivate(path: string, exactMode?: boolean): Promise<Buffer>;
  readImporter(path: string): Promise<ImporterConfig>;
  lock(path: string, env: Record<string, string>): Promise<ReleaseLock>;
  prepareLogs(path: string, checkout: string): Promise<void>;
  log(path: string, bytes: Buffer): Promise<void>;
  replace(path: string, before: Buffer, after: Buffer, config?: boolean): Promise<void>;
  run(command: Command): Promise<CommandResult>;
  httpStatus(url: string, timeoutMs: number): Promise<number>;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
}
export function inReleaseQuietWindow(now: Date): boolean {
  const c = localClock(now, QUIET_TIME_ZONE), minute = c.hour * 60 + c.minute;
  return minute >= QUIET_START_MINUTE && minute < QUIET_END_MINUTE;
}
export function childEnvironment(base: { PATH: string; HOME: string }, files?: string[]): Record<string, string> {
  return { PATH: base.PATH, HOME: base.HOME, ...(files ? { AVIATION_ENV_FILES: files.join(',') } : {}) };
}
export function releaseTag(head: string, refs: string): string {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new ReleaseError(2, 'HEAD is not a full commit');
  const candidates = refs.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
    .filter(([name]) => RELEASE_TAG.test(name ?? ''));
  if (candidates.length !== 1 || candidates[0]![1] !== 'tag' || !candidates[0]![0]!.endsWith(`-${head.slice(0, 7)}`))
    throw new ReleaseError(2, 'HEAD needs exactly one annotated YYYY.MM.DD-<short HEAD> tag');
  return candidates[0]![0]!;
}
export function hasStartupWarning(output: string): boolean {
  return output.split('\n').some((line) => {
    try {
      const value = JSON.parse(line) as { level?: unknown; msg?: unknown };
      return [40, 50].includes(Number(value.level)) && value.msg !== 'api request';
    } catch { return false; }
  });
}
export function parseReleaseArgs(args: string[]): { config: string; dryRun: boolean } {
  try {
    const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args,
      options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' } }, strict: true });
    if (!values.config || !values.config.startsWith('/') || /[\x00-\x1f\x7f]/.test(values.config)) throw new Error();
    return { config: values.config, dryRun: values['dry-run'] === true };
  } catch { throw new ReleaseError(2, 'usage: pnpm app:release --config <absolute path> [--dry-run]'); }
}

function mergedEnv(files: string[], snapshots: Map<string, Buffer>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const file of [...files].reverse()) Object.assign(values, parseEnv(snapshots.get(file)!.toString('utf8')));
  return values;
}
function validateEnvironmentFiles(config: ReleaseConfig, snapshots: Map<string, Buffer>, tag: string): void {
  try {
    for (const [files, expected] of [
      [config.live.composeEnvFiles, 'live'], [config.live.preflightEnvFiles, 'live'],
      [config.dev.migrateEnvFiles, 'dev'], [config.dev.canaryEnvFiles, 'dev'],
    ] as const) {
      if (mergedEnv([...files], snapshots).APP_ENV !== expected) throw new Error();
    }
    const changed = new Map(snapshots);
    for (const path of [config.live.versionFile, config.dev.versionFile]) changed.set(path, versionEdit(snapshots.get(path)!, tag).bytes);
    if (mergedEnv(config.live.composeEnvFiles, changed).APP_VERSION !== tag ||
      mergedEnv(config.dev.canaryEnvFiles, changed).APP_VERSION !== tag ||
      mergedEnv(config.dev.canaryEnvFiles, changed).AVIATION_DEV_RELEASE_IMAGE !== 'true') throw new Error();
    // Dev migrates first, before the new live release image exists. Use its ordinary dev tools image.
    const migrate = mergedEnv(config.dev.migrateEnvFiles, changed);
    if (migrate.AVIATION_DEV_RELEASE_IMAGE === 'true' || (migrate.APP_VERSION && migrate.APP_VERSION !== 'dev')) throw new Error();
    for (const [file, name] of [[config.dev.migratorEnvFile, 'dev'], [config.live.migratorEnvFile, 'live']] as const) {
      const url = parseEnv(snapshots.get(file)!.toString('utf8')).DATABASE_MIGRATOR_URL ?? '';
      if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) throw new Error();
      checkDatabaseUrl('DATABASE_MIGRATOR_URL', url, name, 'aviation_migrator');
    }
  } catch { throw new ReleaseError(2, 'env files must select the correct environment, version, dev migration mode and migrator role'); }
}

export async function runRelease(args: string[], fx: ReleaseEffects): Promise<number> {
  const locks: ReleaseLock[] = [];
  let currentStep = 'config', config: ReleaseConfig | undefined, tag = '', head = '', logs = '';
  let image = '', recertification = 'not run', beforeLive = '?', beforeDev = '?';
  let pinnedCommit = 'not read';
  const closeLocks = async () => {
    let failed = false;
    while (locks.length) try { await locks.pop()!.close(); } catch { failed = true; }
    if (failed) throw new ReleaseError(1, 'could not close a release lock');
  };
  const summary = () => {
    if (tag) fx.print(`summary: live ${beforeLive} -> ${tag}; dev ${beforeDev} -> ${tag}; image ${image ? image.slice(0, 19) : 'not verified'}; pinned commit ${pinnedCommit}; recertify ${recertification}; logs ${logs || 'not written'}`);
  };
  try {
    const options = parseReleaseArgs(args);
    config = parseReleaseConfig(await fx.readPrivate(options.config, false));
    const c = config;
    const env = childEnvironment(fx.environment);
    const appDir = join(c.checkout, 'apps/aviation-investigations');
    const precheckOutput: string[] = [];
    let log: string | undefined;
    const command = async (name: string, values: string[], files?: string[], timeoutMs = 30_000, importerLine?: (line: string) => void) => {
      const r = await fx.run({ command: name, args: values, cwd: appDir, env: childEnvironment(fx.environment, files),
        timeoutMs, log, locks, importerLine });
      if (!log) precheckOutput.push(r.stdout, r.stderr);
      return r;
    };
    const checked = async (name: string, values: string[], files?: string[], timeoutMs?: number) => {
      const r = await command(name, values, files, timeoutMs);
      if (r.code !== 0) throw new ReleaseError(log ? 1 : 2, `${name} command failed; see the private step log if available`);
      return r.stdout.trim();
    };
    const check = async (name: string, action: () => Promise<void>) => { currentStep = name; await action(); fx.print(`${name}: ok`); };
    currentStep = 'checkout';
    await check('checkout', async () => {
      if (await fx.realpath(fx.ownCheckout) !== await fx.realpath(c.checkout)) throw new ReleaseError(2, 'run from the configured checkout, not another worktree');
      if ((await checked('git', ['branch', '--show-current'])) !== c.branch) throw new ReleaseError(2, 'checkout branch does not match config');
      if (await checked('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new ReleaseError(2, 'checkout has tracked or untracked changes');
      head = await checked('git', ['rev-parse', 'HEAD']);
      tag = releaseTag(head, await checked('git', ['for-each-ref', '--points-at', 'HEAD', '--format=%(refname:short)\t%(objecttype)', 'refs/tags/']));
    });
    await check('quiet-window', async () => {
      if (inReleaseQuietWindow(fx.now())) throw new ReleaseError(75, 'releases pause from 03:30 to 06:00 Europe/Prague');
    });
    let importer!: ImporterConfig;
    let importerBytes!: Buffer;
    const snapshots = new Map<string, Buffer>();
    await check('files', async () => {
      importerBytes = await fx.readPrivate(c.importerConfig, false);
      importer = await fx.readImporter(c.importerConfig);
      pinnedCommit = importer.code;
      if (!importer.live || importer.live.container === importer.dev.container) throw new ReleaseError(2, 'importer config must name distinct live and dev containers');
      if (JSON.stringify(ImporterConfigSchema.parse(JSON.parse(importerBytes.toString('utf8')))) !== JSON.stringify(importer))
        throw new ReleaseError(2, 'importer config changed during checks');
      // Check the version/env files as well as the worker files recertify will read.
      const paths = new Set([c.live.versionFile, c.dev.versionFile, ...c.live.composeEnvFiles,
        ...c.live.preflightEnvFiles, c.live.migratorEnvFile, ...c.dev.migrateEnvFiles,
        ...c.dev.canaryEnvFiles, c.dev.migratorEnvFile, ...importer.dev.envFiles, ...importer.live.envFiles,
        importer.hostLock, importer.maintenanceLock]);
      for (const path of paths) snapshots.set(path, await fx.readPrivate(path));
      for (const path of [options.config, c.importerConfig, ...paths]) {
        if (!outsideCheckout(await fx.realpath(path), await fx.realpath(c.checkout))) throw new ReleaseError(2, 'private release files must be outside the checkout');
      }
      if (!outsideCheckout(resolve(c.logDir), resolve(c.checkout))) throw new ReleaseError(2, 'release logs must be outside the checkout');
      beforeLive = versionEdit(snapshots.get(c.live.versionFile)!, tag).current;
      beforeDev = versionEdit(snapshots.get(c.dev.versionFile)!, tag).current;
      validateEnvironmentFiles(c, snapshots, tag);
    });
    await check('locks', async () => {
      try {
        locks.push(await fx.lock(importer.hostLock, env));
        locks.push(await fx.lock(importer.maintenanceLock, env));
      } catch (e) {
        if ((e as { reason?: string }).reason === 'busy' || (e instanceof ReleaseError && e.exitCode === 75))
          throw new ReleaseError(75, 'the importer or a backup is running');
        throw new ReleaseError(2, 'could not acquire the importer locks');
      }
      // A competing invocation could have changed a config while these files were being checked.
      if (!(await fx.readPrivate(c.importerConfig, false)).equals(importerBytes)) throw new ReleaseError(2, 'importer config changed during checks');
      for (const [path, bytes] of snapshots) if (!(await fx.readPrivate(path)).equals(bytes)) throw new ReleaseError(2, 'env or lock file changed during checks');
    });
    const inspectImage = async (container: string) => {
      const value = await checked('docker', ['inspect', '--type', 'container', '--format', '{{.Image}}', container]);
      if (!IMAGE_ID.test(value)) throw new ReleaseError(log ? 1 : 2, 'container image ID has an unexpected format');
      return value;
    };
    await check('docker', async () => {
      const live = await inspectImage(importer.live!.container), dev = await inspectImage(importer.dev.container);
      fx.print(`current images: live ${live}; dev ${dev}`);
    });
    if (options.dryRun) {
      fx.print(`plan: live APP_VERSION ${beforeLive} -> ${tag}; dev APP_VERSION ${beforeDev} -> ${tag}`);
      fx.print(`plan: importer code ${importer.code} -> ${head}; image ${importer.dev.image} -> built in step 5 (live app:up; Compose may build it during migration)`);
      PLAN_STEPS.forEach((s, i) => fx.print(`plan ${i + 1}: ${s}`));
      fx.print('dry-run: ok; no files written or deployment commands run');
      return 0;
    }
    logs = join(c.logDir, tag);
    currentStep = 'logs';
    await fx.prepareLogs(c.logDir, c.checkout);
    await fx.prepareLogs(logs, c.checkout);
    await fx.log(join(logs, '00-checks.log'), Buffer.from(precheckOutput.join('\n')));
    const step = async (name: ReleaseStep, action: () => Promise<void>) => {
      currentStep = name;
      log = join(logs, `${String(STEPS.indexOf(name) + 1).padStart(2, '0')}-${name}.log`);
      await fx.log(log, Buffer.from(`release ${tag}: ${name}\n`));
      await action();
      fx.print(`${name}: ok`);
    };
    const pnpm = (script: string, files?: string[]) => checked('pnpm', ['-s', script], files, 30 * 60_000);
    await step('install', async () => { await checked('pnpm', ['install', '--frozen-lockfile'], undefined, 15 * 60_000); });
    await step('versions', async () => {
      for (const path of [c.live.versionFile, c.dev.versionFile]) {
        const before = snapshots.get(path)!;
        await fx.replace(path, before, versionEdit(before, tag).bytes);
      }
    });
    await step('dev-migrate', async () => { await pnpm('app:migrate', c.dev.migrateEnvFiles); });
    await step('dev-privileges', async () => { await checked('pnpm', ['exec', 'tsx', 'scripts/release-privileges.ts', '--environment', 'dev'], [c.dev.migratorEnvFile], 60_000); });
    await step('live-migrate', async () => { await pnpm('app:migrate', c.live.composeEnvFiles); });
    await step('live-privileges', async () => { await checked('pnpm', ['exec', 'tsx', 'scripts/release-privileges.ts', '--environment', 'live'], [c.live.migratorEnvFile], 60_000); });
    await step('preflight', async () => { await checked('pnpm', ['-s', 'worker', 'ai-preflight'], c.live.preflightEnvFiles, 10 * 60_000); });
    const up = async (target: ImporterConfig['dev'], files: string[], publicChecks: boolean) => {
      await pnpm('app:up', files);
      const deadline = fx.now().getTime() + APP_HEALTH_TIMEOUT_MS;
      for (;;) {
        const remaining = deadline - fx.now().getTime();
        if (remaining <= 0) throw new ReleaseError(1, 'app health did not return 200 within 180 seconds');
        if (await fx.httpStatus(new URL('/api/config', target.applicationUrl).href, Math.min(10_000, remaining)).catch(() => 0) === 200) break;
        await fx.sleep(Math.min(2000, Math.max(0, deadline - fx.now().getTime())));
      }
      const version = await checked('docker', ['inspect', '--type', 'container', '--format',
        '{{range .Config.Env}}{{if eq (index (split . "=") 0) "APP_VERSION"}}{{println .}}{{end}}{{end}}', target.container]);
      if (version && version !== `APP_VERSION=${tag}`) throw new ReleaseError(1, 'running APP_VERSION does not match the release tag');
      // Check this container's startup even on a no-restart retry. Using release start time
      // would silently forgive the warning that stopped the previous invocation.
      const state = await checked('docker', ['inspect', '--type', 'container', '--format', '{{.State.Running}} {{.State.StartedAt}}', target.container]);
      const since = /^true (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z)$/.exec(state)?.[1];
      if (!since || !Number.isFinite(Date.parse(since))) throw new ReleaseError(1, 'container is not running with a valid startup time');
      const until = new Date(Date.parse(since) + APP_HEALTH_TIMEOUT_MS).toISOString();
      const r = await command('docker', ['logs', '--since', since, '--until', until, target.container]);
      if (r.code !== 0) throw new ReleaseError(1, 'could not read startup logs');
      if (hasStartupWarning(r.stdout + '\n' + r.stderr)) throw new ReleaseError(1, 'startup warning or error; see the private step log');
      if (publicChecks) {
        for (const [path, expected] of [['/', 200], ['/privacy', 200], ['/api/admin/overview', 404], ['/admin', 404]] as const) {
          if (await fx.httpStatus(new URL(path, c.publicUrl).href, 15_000).catch(() => 0) !== expected)
            throw new ReleaseError(1, `signed-out public check failed: ${path} must return ${expected}`);
        }
      }
    };
    await step('live-up', () => up(importer.live!, c.live.composeEnvFiles, true));
    await step('dev-canary-up', () => up(importer.dev, c.dev.canaryEnvFiles, false));
    await step('images', async () => {
      image = await inspectImage(importer.live!.container);
      if (image !== await inspectImage(importer.dev.container)) throw new ReleaseError(1, 'live and dev image IDs differ; importer pins were not changed');
    });
    await step('importer-pins', async () => {
      if (await checked('git', ['rev-parse', 'HEAD']) !== head ||
        await checked('git', ['status', '--porcelain', '--untracked-files=normal']) ||
        await checked('git', ['branch', '--show-current']) !== c.branch ||
        releaseTag(head, await checked('git', ['for-each-ref', '--points-at', 'HEAD', '--format=%(refname:short)\t%(objecttype)', 'refs/tags/'])) !== tag)
        throw new ReleaseError(1, 'checkout or release tag changed during release');
      await fx.replace(c.importerConfig, importerBytes, repin(importerBytes, head, image), true);
      pinnedCommit = head;
    });
    await closeLocks();
    await step('recertify', async () => {
      let last: { step: string; result: string; reason: string | null } | undefined;
      const line = (raw: string) => {
        const safe = journalLine(raw);
        if (safe) { fx.print(safe); last = JSON.parse(safe) as typeof last; }
      };
      const r = await command('pnpm', ['-s', 'importer', 'recertify', '--config', c.importerConfig, '--env', 'dev'], undefined, 20 * 60_000, line);
      recertification = last ? `${last.result}/${last.reason ?? 'none'}` : 'no final step';
      if (r.code !== 0 || last?.step !== 'complete' || last.result !== 'unchanged') throw new ReleaseError(1, `recertification failed: ${recertification}`);
      recertification = 'unchanged';
    });
    summary();
    return 0;
  } catch (e) {
    const error = e instanceof ReleaseError ? e : new ReleaseError(currentStep === 'config' || ['checkout', 'files', 'locks', 'docker'].includes(currentStep) ? 2 : 1, 'operation failed; inspect the private step log if available');
    fx.print(`${currentStep}: failed; ${error.message}`);
    if (currentStep === 'recertify') fx.print('Recovery: every release step is idempotent. Fix the cause and rerun pnpm app:release; the daily importer also re-certifies on its own.');
    summary();
    return logs && error.exitCode === 2 ? 1 : error.exitCode;
  } finally { await closeLocks(); }
}
