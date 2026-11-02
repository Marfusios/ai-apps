import { parseEnv } from 'node:util';
import { ImporterConfigSchema } from '../../worker/importer/config.js';
import { ReleaseError, type ReleaseConfig } from '../../scripts/release-config.js';
import type { Command, ReleaseEffects } from '../../scripts/release-runner.js';

export const RELEASE_HEAD = 'abcdef1' + 'a'.repeat(33);
export const RELEASE_VERSION = '2026.11.01-abcdef1';
export const RELEASE_OLD = '2026.10.31-aaaaaaa';
export const RELEASE_IMAGE = 'sha256:' + 'b'.repeat(64);
export const OLD_IMAGE = 'sha256:' + 'c'.repeat(64);

export function fakeRelease() {
  const config: ReleaseConfig = {
    version: 'aircase-release.v1', checkout: '/example/ai-apps', branch: 'aviation-casebook',
    importerConfig: '/example/private/importer.json', publicUrl: 'https://example.org', logDir: '/example/private/logs',
    live: { versionFile: '/example/private/live.env', composeEnvFiles: ['/example/private/live.env'],
      preflightEnvFiles: ['/example/private/live-host.env'], migratorEnvFile: '/example/private/live-migrator.env' },
    dev: { versionFile: '/example/private/canary.env', migrateEnvFiles: ['/example/private/dev-migrate.env'],
      canaryEnvFiles: ['/example/private/canary.env'], migratorEnvFile: '/example/private/dev-migrator.env' },
  };
  const importer = ImporterConfigSchema.parse({
    version: 'snapshot-importer.v1', root: '/example/private/imports', hostLock: '/example/private/import.lock', maintenanceLock: '/example/private/maintenance.lock',
    code: 'a'.repeat(40), schedule: { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' },
    installation: { backupMutexConfirmed: true, headroomReportSha256: 'd'.repeat(64) },
    dev: { envFiles: ['/example/private/worker-dev.env'], applicationUrl: 'http://localhost:3100', container: 'aircase-dev', image: OLD_IMAGE },
    live: { envFiles: ['/example/private/worker-live.env'], applicationUrl: 'https://example.org', container: 'aircase-live', image: OLD_IMAGE },
  });
  const files = new Map<string, Buffer>([
    ['/example/private/release.json', Buffer.from(JSON.stringify(config))],
    [config.importerConfig, Buffer.from(JSON.stringify(importer))],
    [config.live.versionFile, Buffer.from(`APP_ENV=live\nAPP_VERSION=${RELEASE_OLD}\nSENTINEL=PRIVATE\n`)],
    [config.dev.versionFile, Buffer.from(`APP_ENV=dev\nAPP_VERSION=${RELEASE_OLD}\nAVIATION_DEV_RELEASE_IMAGE=true\n`)],
    [config.live.preflightEnvFiles[0]!, Buffer.from('APP_ENV=live\n')],
    [config.dev.migrateEnvFiles[0]!, Buffer.from('APP_ENV=dev\n')],
    [config.live.migratorEnvFile, Buffer.from('DATABASE_MIGRATOR_URL=postgres://offline:offline@localhost/aviation_live?options=-c%20role%3Daviation_migrator\n')],
    [config.dev.migratorEnvFile, Buffer.from('DATABASE_MIGRATOR_URL=postgres://offline:offline@localhost/aviation_dev?options=-c%20role%3Daviation_migrator\n')],
    ...[importer.hostLock, importer.maintenanceLock, ...importer.dev.envFiles, ...importer.live!.envFiles].map((p): [string, Buffer] => [p, Buffer.alloc(0)]),
  ]);
  const events: string[] = [], output: string[] = [], commands: Command[] = [], writes: string[] = [];
  const logs = new Map<string, string>();
  const modes = new Map<string, number>();
  const images = new Map([[importer.dev.container, OLD_IMAGE], [importer.live!.container, OLD_IMAGE]]);
  const behavior = {
    branch: config.branch, dirty: '', head: RELEASE_HEAD, tags: `${RELEASE_VERSION}\ttag\n`,
    fail: '', busy: '', badFile: '', badParent: '', badLogs: '', prepareLogsFailure: '', closeFailure: '',
    sameNameBranch: false, clock: Date.parse('2026-11-01T11:00:00Z'),
    startupLogs: new Map([[importer.live!.container, ''], [importer.dev.container,
      '{"level":40,"msg":"AI feature off"}\n{"level":40,"msg":"Google sign-in off"}']]),
    recertify: { code: 0, line: '{"step":"complete","result":"unchanged","reason":null}' },
    devImage: RELEASE_IMAGE, runningVersion: '', health: 200,
    httpOverrides: new Map<string, number>(),
  };
  const commandName = (spec: Command) => {
    if (spec.command === 'git') return `git:${spec.args[0]}`;
    if (spec.command === 'docker') return `docker:${spec.args[0]}`;
    if (spec.args[0] === 'install') return 'install';
    if (spec.args.includes('recertify')) return 'recertify';
    if (spec.args.includes('ai-preflight')) return 'preflight';
    if (spec.args.includes('scripts/release-privileges.ts')) return `${spec.args.at(-1)}-privileges`;
    const env = spec.env.AVIATION_ENV_FILES!.split(',')
      .map((p) => parseEnv(files.get(p)!.toString()).APP_ENV).find(Boolean);
    return `${env}-${spec.args.includes('app:migrate') ? 'migrate' : 'up'}`;
  };
  const fx: ReleaseEffects = {
    ownCheckout: config.checkout, environment: { PATH: '/example/bin', HOME: '/example/home' },
    importerEnvironment: { USER: 'operator', TZ: 'UTC', DOCKER_CONTEXT: 'offline-context' },
    now: () => new Date(behavior.clock), realpath: async (p) => p,
    async readPrivate(p, exactMode = true) {
      events.push(`read:${p}`);
      const mode = modes.get(p) ?? 0o600;
      if (p === behavior.badFile || !files.has(p) || (exactMode ? mode !== 0o600 : (mode & 0o077) !== 0)) throw new ReleaseError(2, 'private file refused');
      return Buffer.from(files.get(p)!);
    },
    async readImporter(p) { return ImporterConfigSchema.parse(JSON.parse((await fx.readPrivate(p)).toString())); },
    async lock(p, env) {
      if (JSON.stringify(env) !== JSON.stringify(fx.environment)) throw new Error('dirty lock environment');
      events.push(`lock:${p}`);
      if (behavior.busy === p) throw { reason: 'busy' };
      return { fd: p === importer.hostLock ? 100 : 101, close: async () => {
        events.push(`unlock:${p}`);
        if (p === behavior.closeFailure) throw new Error('close failed');
      } };
    },
    async validateParent(p) { if (p === behavior.badParent) throw new ReleaseError(2, 'private file parent is unsafe'); },
    async validateLogs(p) { if (p === behavior.badLogs) throw new ReleaseError(2, 'unsafe release log directory'); },
    async prepareLogs(p) {
      if (p === behavior.prepareLogsFailure) throw new Error('prepare failed');
      events.push(`mkdir:${p}`);
    },
    async log(p, bytes) { logs.set(p, (logs.get(p) ?? '') + bytes.toString()); },
    async replace(p, before, after) {
      if (!files.get(p)?.equals(before)) throw new ReleaseError(1, 'private file changed during release');
      if (!before.equals(after)) { writes.push(p); events.push(`write:${p}`); files.set(p, after); }
    },
    async run(spec) {
      commands.push({ ...spec, locks: [...spec.locks] });
      const name = commandName(spec);
      events.push(name);
      let stdout = '', stderr = '', code = 0;
      if (behavior.fail === name) return { code: 1, stdout: '', stderr: 'PRIVATE_FAILURE_SENTINEL' };
      if (spec.command === 'git') {
        stdout = spec.args[0] === 'branch' ? behavior.branch : spec.args[0] === 'status' ? behavior.dirty :
          spec.args[0] === 'rev-parse' ? behavior.head : behavior.tags;
        if (spec.args[0] === 'for-each-ref' && behavior.sameNameBranch && spec.args.some((a) => a.includes('refname:short')))
          stdout = stdout.replace(RELEASE_VERSION, `tags/${RELEASE_VERSION}`);
      } else if (spec.command === 'docker') {
        if (spec.args[0] === 'logs') stdout = behavior.startupLogs.get(spec.args.at(-1)!) ?? '';
        else if (spec.args.includes('{{.Image}}')) stdout = images.get(spec.args.at(-1)!) ?? '';
        else if (spec.args.some((a) => a.includes('.State.StartedAt'))) stdout = 'true 2026-11-01T10:59:00.000000000Z';
        else stdout = behavior.runningVersion || `APP_VERSION=${RELEASE_VERSION}`;
      } else if (name === 'live-up' || name === 'dev-up') {
        images.set(name === 'live-up' ? importer.live!.container : importer.dev.container,
          name === 'live-up' ? RELEASE_IMAGE : behavior.devImage);
      } else if (name === 'recertify') {
        ({ code } = behavior.recertify);
        stdout = behavior.recertify.line + '\n';
        for (const line of stdout.split('\n')) spec.importerLine?.(line);
      }
      if (spec.log) logs.set(spec.log, (logs.get(spec.log) ?? '') + stdout + stderr);
      return { code, stdout, stderr };
    },
    async httpStatus(url) {
      events.push(`http:${url}`);
      const path = new URL(url).pathname;
      return behavior.httpOverrides.get(path) ?? (path === '/api/config' ? behavior.health : path.includes('admin') ? 404 : 200);
    },
    async sleep(ms) { behavior.clock += ms; }, print: (line) => output.push(line),
  };
  return { config, importer, files, fx, events, output, commands, writes, logs, behavior, images, modes,
    args: ['--config', '/example/private/release.json'] };
}
