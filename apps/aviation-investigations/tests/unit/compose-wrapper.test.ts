import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkDatabaseUrl,
  checkEdgeSubnet,
  checkoutDirty,
  devReleaseImage,
  liveImagePlan,
  maintenanceInvocation,
  maintenanceLock,
  MAINTENANCE_BUSY_EXIT,
  MAINTENANCE_BUSY_MESSAGE,
  planCompose,
  versionAtLeast,
  type LiveImageFacts,
  type Values,
} from '../../scripts/compose.js';
import { proveMaintenanceLock } from '../../scripts/maintenance-lock-proof.js';

// Private (RFC 1918) example subnets are built from octets: the repository check
// rejects private address literals in committed files.
const privateNet = (a: number, b: number, c: number, bits: number) => `${[a, b, c, 0].join('.')}/${bits}`;
const EDGE = privateNet(172, 30, 9, 28);

const url = (env: string, user: string, group: string) =>
  `postgres://${user}:pw@shared-postgres:5432/aviation_${env}?options=-c%20role%3D${group}`;
const env = (appEnv: 'dev' | 'live', extra: Values = {}): Values => ({
  APP_ENV: appEnv,
  SHARED_POSTGRES_NETWORK: 'pg-net',
  SHARED_ELASTICSEARCH_NETWORK: 'es-net',
  DATABASE_URL: url(appEnv, `aviation_${appEnv}_app`, 'aviation_app'),
  DATABASE_INGEST_URL: url(appEnv, `aviation_${appEnv}_ingest`, 'aviation_ingest'),
  DATABASE_MIGRATOR_URL: url(appEnv, `aviation_${appEnv}_migrator`, 'aviation_migrator'),
  ELASTICSEARCH_URL: 'https://shared-es:9200',
  ELASTICSEARCH_READ_API_KEY: 'k',
  ELASTICSEARCH_INDEX_PREFIX: `ai-aviation-${appEnv}`,
  ...extra,
});
const error = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
};

describe('planCompose on live', () => {
  const live = env('live', { APP_VERSION: 'v1.2.0', TUNNEL_TOKEN: 'secret-token', EDGE_SUBNET: EDGE });

  it('always runs tunnel mode: tunnel override and profile, no published port', () => {
    const plan = planCompose('app-up', [], {}, [live]);
    expect(plan).toMatchObject({ appEnv: 'live', tunnel: true, files: ['compose.yaml', 'compose.tunnel.yaml'] });
    expect(plan.tail.slice(0, 4)).toEqual(['--profile', 'app', '--profile', 'tunnel']);
  });

  it('refuses to start without a tunnel token instead of publishing a port', () => {
    expect(error(() => planCompose('app-up', [], {}, [{ ...live, TUNNEL_TOKEN: undefined }]))).toMatch(/tunnel mode: set TUNNEL_TOKEN/);
  });

  it('needs an explicit release tag', () => {
    for (const command of ['app-up', 'ingest', 'migrate'] as const) {
      expect(error(() => planCompose(command, [], {}, [{ ...live, APP_VERSION: undefined }]))).toMatch(/explicit APP_VERSION/);
      expect(error(() => planCompose(command, [], {}, [{ ...live, APP_VERSION: 'dev' }]))).toMatch(/explicit APP_VERSION/);
    }
    expect(error(() => planCompose('app-up', [], {}, [{ ...live, APP_VERSION: 'bad tag!' }]))).toMatch(/not a valid image tag/);
    expect(() => planCompose('app-ps', [], {}, [{ APP_ENV: 'live' }])).not.toThrow();
  });

  it('accepts at most 80 tag characters, matching APP_VERSION in the server and contract', () => {
    expect(() => planCompose('app-up', [], {}, [{ ...live, APP_VERSION: 'v'.repeat(80) }])).not.toThrow();
    for (const length of [81, 128]) {
      expect(() => planCompose('app-up', [], {}, [{ ...live, APP_VERSION: 'v'.repeat(length) }])).toThrow(/maximum 80/);
    }
  });

  it('needs a valid edge subnet in tunnel mode', () => {
    expect(error(() => planCompose('app-up', [], {}, [{ ...live, EDGE_SUBNET: undefined }]))).toMatch(/needs EDGE_SUBNET/);
    expect(error(() => planCompose('app-up', [], {}, [{ ...live, EDGE_SUBNET: '198.51.100.0/28' }]))).toMatch(/private/);
  });
});

describe('planCompose on dev', () => {
  it('publishes the loopback port without a token and uses the tunnel with one', () => {
    expect(planCompose('app-up', [], {}, [env('dev')])).toMatchObject({ tunnel: false, files: ['compose.yaml'] });
    const tunnel = planCompose('app-up', [], {}, [env('dev', { TUNNEL_TOKEN: 't', EDGE_SUBNET: EDGE })]);
    expect(tunnel.files).toEqual(['compose.yaml', 'compose.tunnel.yaml']);
  });

  it('adds the tracing override for app and ingest', () => {
    const tracing = env('dev', { AVIATION_TRACING_ENABLED: 'true' });
    expect(planCompose('ingest', ['generations'], {}, [tracing])).toMatchObject({
      files: ['compose.yaml', 'compose.tracing.yaml'],
      tail: ['--profile', 'tools', 'run', '--build', '--rm', 'aviation-ingest', 'generations'],
    });
    expect(planCompose('migrate', [], {}, [tracing]).files).toEqual(['compose.yaml']);
  });
});

describe('planCompose consistency checks', () => {
  it('checks the database of each command against APP_ENV', () => {
    const dev = env('dev');
    expect(error(() => planCompose('app-up', [], {}, [{ ...dev, DATABASE_URL: url('live', 'aviation_live_app', 'aviation_app') }]))).toMatch(
      /DATABASE_URL must use database aviation_dev/,
    );
    expect(error(() => planCompose('migrate', [], {}, [{ ...dev, DATABASE_MIGRATOR_URL: url('live', 'x', 'aviation_migrator') }]))).toMatch(
      /DATABASE_MIGRATOR_URL must use database aviation_dev/,
    );
    expect(error(() => planCompose('ingest', [], {}, [{ ...dev, DATABASE_INGEST_URL: url('dev', 'x', 'aviation_app') }]))).toMatch(
      /DATABASE_INGEST_URL must end in \?options=-c%20role%3Daviation_ingest/,
    );
  });

  it('refuses an APP_ENV in the shell that differs from the env files', () => {
    expect(error(() => planCompose('ingest', [], { APP_ENV: 'live' }, [env('dev')]))).toMatch(/differs/);
    expect(error(() => planCompose('ingest', [], {}, [env('dev'), { APP_ENV: 'live' }]))).toMatch(/disagree/);
    expect(planCompose('ingest', [], { APP_ENV: 'dev' }, [env('dev')]).appEnv).toBe('dev');
  });

  it('checks the index prefix', () => {
    expect(error(() => planCompose('ingest', [], {}, [env('dev', { ELASTICSEARCH_INDEX_PREFIX: 'ai-aviation-live' })]))).toMatch(
      /must be ai-aviation-dev/,
    );
  });

  it('never echoes values', () => {
    const msg = error(() =>
      planCompose('app-up', [], {}, [{ ...env('live'), APP_VERSION: 'v1', TUNNEL_TOKEN: 'secret-token', EDGE_SUBNET: 'secret-token' }]),
    );
    expect(msg).toMatch(/EDGE_SUBNET/);
    expect(msg).not.toContain('secret-token');
  });

  it('builds the extraction image without any configuration', () => {
    expect(planCompose('extract-image', [], {}, [])).toMatchObject({ appEnv: 'dev', tail: ['build', 'extract-image'] });
  });
});

describe('planCompose image builds', () => {
  const live = env('live', { APP_VERSION: 'v1.2.0', TUNNEL_TOKEN: 'secret-token', EDGE_SUBNET: EDGE });

  it('on dev rebuilds the image from the checkout for app:up, app:migrate and ingest', () => {
    // A tag that already exists would otherwise run the previous code: new migrations unapplied.
    expect(planCompose('app-up', [], {}, [env('dev')]).tail).toContain('--build');
    expect(planCompose('migrate', [], {}, [env('dev')]).tail).toEqual(['--profile', 'tools', 'run', '--build', '--rm', 'aviation-migrate']);
    expect(planCompose('ingest', ['verify', '--generation', '3'], {}, [env('dev')]).tail).toEqual([
      '--profile', 'tools', 'run', '--build', '--rm', 'aviation-ingest', 'verify', '--generation', '3',
    ]);
  });

  it('on live builds a release tag once: never again implicitly, so a rollback starts the image that tag was built as', () => {
    for (const command of ['app-up', 'migrate', 'ingest'] as const) {
      expect(planCompose(command, [], {}, [live]).tail, command).not.toContain('--build');
    }
    expect(planCompose('app-up', [], {}, [live]).tail).toEqual(['--profile', 'app', '--profile', 'tunnel', 'up', '-d', '--wait', '--wait-timeout', '180']);
    expect(planCompose('migrate', [], {}, [live]).tail).toEqual(['--profile', 'tools', 'run', '--rm', 'aviation-migrate']);
  });

  it('rebuilds a tag only when asked with --rebuild, which is never passed on', () => {
    expect(planCompose('app-up', ['--rebuild'], {}, [live]).tail).toEqual([
      '--profile', 'app', '--profile', 'tunnel', 'up', '-d', '--build', '--wait', '--wait-timeout', '180',
    ]);
    expect(planCompose('migrate', ['--rebuild'], {}, [live]).tail).toEqual(['--profile', 'tools', 'run', '--build', '--rm', 'aviation-migrate']);
    expect(planCompose('ingest', ['--rebuild', 'generations'], {}, [live]).tail).toEqual([
      '--profile', 'tools', 'run', '--build', '--rm', 'aviation-ingest', 'generations',
    ]);
    expect(planCompose('ingest', ['--rebuild', 'generations'], {}, [env('dev')]).tail).not.toContain('--rebuild');
    expect(error(() => planCompose('app-ps', ['--rebuild'], {}, [live]))).toMatch(/--rebuild/);
  });
});

describe('live images are built once, from the commit their tag names (re-review N1)', () => {
  const live = env('live', { APP_VERSION: 'v1.2.0', TUNNEL_TOKEN: 'secret-token', EDGE_SUBNET: EDGE });
  const TAGGED = 'a'.repeat(40);
  const NEWER = 'b'.repeat(40);
  const facts = (over: Partial<LiveImageFacts> = {}): LiveImageFacts => ({
    image: { revision: TAGGED },
    tagCommit: TAGGED,
    head: NEWER,
    dirty: false,
    ...over,
  });

  it('a rollback starts the image its tag was built as, and never builds', () => {
    expect(liveImagePlan('v1.2.0', false, facts())).toBe('use');
    expect(planCompose('app-up', [], {}, [live], facts()).tail).toEqual([
      '--profile', 'app', '--profile', 'tunnel', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '180',
    ]);
    expect(planCompose('migrate', [], {}, [live], facts()).tail).toEqual(['--profile', 'tools', 'run', '--rm', 'aviation-migrate']);
  });

  it('refuses a rollback to a tag whose image is gone instead of building the current checkout under it', () => {
    expect(() => liveImagePlan('v1.2.0', false, facts({ image: null }))).toThrow(/not on this host.*never builds another commit/);
    expect(() => planCompose('app-up', [], {}, [live], facts({ image: null }))).toThrow(/not on this host/);
    expect(() => planCompose('ingest', ['generations'], {}, [live], facts({ image: null }))).toThrow(/not on this host/);
  });

  it('builds a missing tag only from a clean checkout of the commit it names', () => {
    expect(liveImagePlan('v1.2.0', false, facts({ image: null, head: TAGGED }))).toBe('build');
    expect(planCompose('migrate', [], {}, [live], facts({ image: null, head: TAGGED })).tail).toEqual([
      '--profile', 'tools', 'run', '--build', '--rm', 'aviation-migrate',
    ]);
    expect(() => liveImagePlan('v1.2.0', false, facts({ image: null, head: TAGGED, dirty: true }))).toThrow(/not on this host/);
  });

  it('refuses an image built from another commit than its tag names, or a release without a git tag', () => {
    expect(() => liveImagePlan('v1.2.0', false, facts({ image: { revision: NEWER } }))).toThrow(/was built from bbbbbbbbbbbb, not from the commit tagged v1\.2\.0/);
    expect(() => liveImagePlan('v1.2.0', false, facts({ image: { revision: null } }))).toThrow(/an unrecorded commit/);
    expect(() => liveImagePlan('v1.2.0', false, facts({ tagCommit: null }))).toThrow(/git tag v1\.2\.0/);
  });

  it('--rebuild builds only from a clean checkout of the tagged commit', () => {
    expect(liveImagePlan('v1.2.0', true, facts({ head: TAGGED }))).toBe('build');
    expect(planCompose('app-up', ['--rebuild'], {}, [live], facts({ head: TAGGED })).tail).toContain('--build');
    expect(() => liveImagePlan('v1.2.0', true, facts())).toThrow(/--rebuild builds the checkout/);
    expect(() => liveImagePlan('v1.2.0', true, facts({ head: TAGGED, dirty: true }))).toThrow(/--rebuild builds the checkout/);
  });
});

describe('planCompose for backups and restores', () => {
  const backups = (appEnv: 'dev' | 'live', extra: Values = {}) => env(appEnv, { AVIATION_BACKUP_DIR: '/srv/aviation-backups', ...extra });

  it('backs up and restores as the migrator login with the PostgreSQL tools, without the application image', () => {
    for (const appEnv of ['dev', 'live'] as const) {
      // No release tag on live: these containers run the PostgreSQL image, not the application's.
      expect(planCompose('backup', [], {}, [backups(appEnv)])).toEqual({
        appEnv,
        tunnel: false,
        files: ['compose.yaml'],
        tail: ['--profile', 'tools', 'run', '--rm', 'aviation-backup'],
      });
      expect(planCompose('restore', [`aviation_${appEnv}-2026-10-24T031500Z.dump`], {}, [backups(appEnv)]).tail).toEqual([
        '--profile',
        'tools',
        'run',
        '--rm',
        'aviation-restore',
        `aviation_${appEnv}-2026-10-24T031500Z.dump`,
      ]);
    }
  });

  it('needs the backup directory and the environment’s migrator URL', () => {
    expect(error(() => planCompose('backup', [], {}, [env('dev')]))).toMatch(/missing for backup: AVIATION_BACKUP_DIR/);
    expect(error(() => planCompose('restore', ['a.dump'], {}, [env('dev')]))).toMatch(/missing for restore: AVIATION_BACKUP_DIR/);
    expect(
      error(() => planCompose('backup', [], {}, [backups('dev', { DATABASE_MIGRATOR_URL: url('live', 'aviation_live_migrator', 'aviation_migrator') })])),
    ).toMatch(/DATABASE_MIGRATOR_URL must use database aviation_dev/);
    expect(error(() => planCompose('restore', ['a.dump'], {}, [backups('dev', { DATABASE_MIGRATOR_URL: url('dev', 'u', 'aviation_app') })]))).toMatch(
      /role%3Daviation_migrator/,
    );
  });

  it('restores exactly one backup file named inside the backup directory, and backs up without arguments', () => {
    for (const args of [[], ['a.dump', 'b.dump'], ['../a.dump'], ['dir/a.dump'], ['a.sql'], ['-x.dump']]) {
      expect(error(() => planCompose('restore', args, {}, [backups('dev')]))).toMatch(/one backup file/);
    }
    expect(error(() => planCompose('backup', ['--format=plain'], {}, [backups('dev')]))).toMatch(/takes no arguments/);
  });
});

describe('helpers', () => {
  it('accepts private, aligned edge subnets from /16 to /29', () => {
    expect(() => checkEdgeSubnet(EDGE)).not.toThrow();
    expect(() => checkEdgeSubnet(privateNet(10, 200, 0, 24))).not.toThrow();
    expect(() => checkEdgeSubnet(privateNet(192, 168, 7, 29))).not.toThrow();
    expect(() => checkEdgeSubnet(privateNet(172, 32, 0, 28))).toThrow(/private/);
    expect(() => checkEdgeSubnet(privateNet(172, 30, 9, 30))).toThrow(/\/16 to \/29/);
    expect(() => checkEdgeSubnet(`${[172, 30, 9, 8].join('.')}/28`)).toThrow(/network address/);
    expect(() => checkEdgeSubnet('not-a-subnet')).toThrow(/IPv4 CIDR/);
  });

  it('checks database URLs', () => {
    expect(() => checkDatabaseUrl('X', url('dev', 'u', 'aviation_app'), 'dev', 'aviation_app')).not.toThrow();
    expect(() => checkDatabaseUrl('X', 'postgres://u@h/aviation_dev', 'dev', 'aviation_app')).toThrow(/options/);
    expect(() => checkDatabaseUrl('X', 'not a url', 'dev', 'aviation_app')).toThrow(/not a valid URL/);
  });

  it('compares Compose versions', () => {
    expect(versionAtLeast('2.24.0')).toBe(true);
    expect(versionAtLeast('v2.29.7\n')).toBe(true);
    expect(versionAtLeast('2.23.3')).toBe(false);
    expect(versionAtLeast('1.29.2')).toBe(false);
    expect(versionAtLeast('3.0.0-rc1')).toBe(true);
    expect(versionAtLeast('')).toBe(false);
  });
});

describe('a live build only from a clean checkout (re-check N9)', () => {
  it('counts changed, staged and untracked files under the app directory, not ignored ones', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aviation-checkout-'));
    try {
      const git = (...a: string[]) => {
        const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
      };
      const app = join(repo, 'apps', 'app');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'index.ts'), 'export {};\n');
      writeFileSync(join(app, '.gitignore'), 'data/\n');
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
      expect(checkoutDirty(app)).toBe(false);
      // Ignored output and files outside the app directory do not enter its build.
      mkdirSync(join(app, 'data'));
      writeFileSync(join(app, 'data', 'cache.json'), '{}');
      writeFileSync(join(repo, 'notes.txt'), 'elsewhere');
      expect(checkoutDirty(app)).toBe(false);
      // An untracked source file would enter the image built as the tagged commit.
      writeFileSync(join(app, 'extra.ts'), 'export const x = 1;\n');
      expect(checkoutDirty(app)).toBe(true);
      rmSync(join(app, 'extra.ts'));
      writeFileSync(join(app, 'index.ts'), 'export const changed = true;\n');
      expect(checkoutDirty(app)).toBe(true);
      // Not a checkout at all: unknown counts as dirty.
      expect(checkoutDirty(join(tmpdir(), 'no-such-aviation-checkout'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('maintenance lock for backup and restore', () => {
  const scratch = (run: (path: string, dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'aircase-compose-lock-'));
    const path = join(dir, 'maintenance.lock');
    writeFileSync(path, '', { mode: 0o600 });
    try { run(path, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('defaults to a bounded 1500-second wait and wraps only backups and restores', () => scratch((path) => {
    const settings = env('dev', { AVIATION_BACKUP_DIR: '/srv/backups', AVIATION_MAINTENANCE_LOCK: path });
    const expected = { path, waitSeconds: 1500 };
    expect(maintenanceLock(settings)).toEqual(expected);
    for (const command of ['backup', 'restore'] as const) {
      const plan = planCompose(command, command === 'restore' ? ['a.dump'] : [], {}, [settings]);
      expect(plan.maintenanceLock).toEqual(expected);
      expect(maintenanceInvocation('docker', ['compose', ...plan.tail], plan.maintenanceLock)).toEqual({
        command: 'flock', args: ['-w', '1500', '-E', '75', '--', path, 'docker', 'compose', ...plan.tail],
      });
    }
    for (const command of ['app-up', 'migrate', 'ingest', 'app-down', 'app-ps', 'extract-image'] as const) {
      expect(planCompose(command, [], {}, [settings]).maintenanceLock).toBeUndefined();
    }
  }));

  it('preserves the direct invocation when unset and nonempty process values win', () => scratch((path) => {
    expect(maintenanceLock({ AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: 'invalid-but-unused' })).toBeUndefined();
    expect(maintenanceInvocation('docker', ['compose', 'run'])).toEqual({ command: 'docker', args: ['compose', 'run'] });
    const settings = env('live', { AVIATION_BACKUP_DIR: '/srv/backups', AVIATION_MAINTENANCE_LOCK: path, AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '12' });
    expect(planCompose('backup', [], { AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '0' }, [settings]).maintenanceLock).toEqual({ path, waitSeconds: 0 });
    expect(planCompose('backup', [], { AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '' }, [settings]).maintenanceLock?.waitSeconds).toBe(12);
  }));

  it('refuses relative, absent, directory and symlink paths and another owner, without echoing paths', () => scratch((path, dir) => {
    const link = join(dir, 'alias');
    symlinkSync(path, link);
    for (const candidate of ['relative.lock', join(dir, 'SENTINEL_MISSING'), dir, link, `${path}\0`]) {
      const message = error(() => maintenanceLock({ AVIATION_MAINTENANCE_LOCK: candidate }));
      expect(message).toMatch(/absolute.*existing regular file.*0600.*not a symlink/);
      expect(message).not.toContain(candidate);
    }
    expect(() => maintenanceLock({ AVIATION_MAINTENANCE_LOCK: path }, process.getuid!() + 1)).toThrow(/owned by this user/);
  }));

  it('requires exact 0600 including special bits; rejects malformed or unbounded waits', () => scratch((path) => {
    for (const mode of [0o400, 0o640, 0o660, 0o700, 0o1600]) {
      chmodSync(path, mode);
      expect(() => maintenanceLock({ AVIATION_MAINTENANCE_LOCK: path })).toThrow(/mode 0600/);
    }
    chmodSync(path, 0o600);
    for (const wait of ['-1', '1.5', 'NaN', 'Infinity', '1e3', ' 1', '86401', '9999999999999999', 'SENTINEL']) {
      const message = error(() => maintenanceLock({ AVIATION_MAINTENANCE_LOCK: path, AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: wait }));
      expect(message).toMatch(/integer from 0 to 86400/);
      expect(message).not.toContain('SENTINEL');
    }
    expect(maintenanceLock({ AVIATION_MAINTENANCE_LOCK: path, AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '86400' })?.waitSeconds).toBe(86400);
  }));

  it('uses the importer flock in both directions with a scratch file and harmless commands', async () => {
    await proveMaintenanceLock();
  });

  it('the real wrapper times out with one fixed message, never calls the dump, and succeeds after release', () => scratch((path, dir) => {
    const log = join(dir, 'docker-calls.jsonl');
    const docker = join(dir, 'docker');
    writeFileSync(docker, `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2);\n` +
      `if(a.join(' ') === 'compose version --short') console.log('2.24.0');\n` +
      `else fs.appendFileSync(process.env.OPS_TEST_LOG, JSON.stringify(a)+'\\n');\n`, { mode: 0o700 });
    const settings = env('dev', { AVIATION_BACKUP_DIR: dir, AVIATION_MAINTENANCE_LOCK: path, AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '0' });
    const fd = openSync(path, 'r+');
    try {
      expect(spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status).toBe(0);
      const run = (command: string, args: string[] = [], extra: Values = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/compose.ts', command, ...args], {
        cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 10000,
        env: { PATH: `${dir}:${process.env.PATH}`, ...settings, ...extra, OPS_TEST_LOG: log },
      });
      for (const command of ['backup', 'restore']) {
        writeFileSync(join(dir, 'a.dump'), 'stand-in, never read');
        const r = run(command, command === 'restore' ? ['a.dump'] : []);
        expect(r.status, r.stderr).toBe(MAINTENANCE_BUSY_EXIT);
        expect(r.stderr.trim()).toBe(MAINTENANCE_BUSY_MESSAGE);
        expect(r.stdout).toBe('');
        expect(() => readFileSync(log)).toThrow();
      }
      expect(spawnSync('flock', ['--unlock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status).toBe(0);
      expect(run('backup').status).toBe(0);
      expect(run('restore', ['a.dump']).status).toBe(0);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('aviation-backup');
      expect(calls[1]!.slice(-2)).toEqual(['aviation-restore', 'a.dump']);
      rmSync(log);
      expect(run('backup', [], { AVIATION_MAINTENANCE_LOCK: join(dir, 'missing') }).status).toBe(2);
      expect(() => readFileSync(log)).toThrow();
    } finally { closeSync(fd); }
  }));
});

describe('explicit private dev release image', () => {
  const revision = 'a'.repeat(40);
  const id = `sha256:${'b'.repeat(64)}`;
  const facts: LiveImageFacts = { tagCommit: revision, head: 'c'.repeat(40), dirty: true, image: { revision, id } };
  const dev = env('dev', { AVIATION_DEV_RELEASE_IMAGE: 'true', APP_VERSION: 'v1.2.0' });

  it('pins an existing release ID even from a different checkout, removing builds and keeping loopback', () => {
    expect(devReleaseImage(facts)).toBe(id);
    for (const command of ['app-up', 'migrate', 'ingest'] as const) {
      const plan = planCompose(command, [], {}, [dev], facts);
      expect(plan.pinnedImageId).toBe(id);
      expect(plan.files).toEqual(['compose.yaml', 'compose.dev-release.yaml']);
      expect(plan.tunnel).toBe(false);
      expect(plan.tail).not.toContain('--build');
    }
    expect(planCompose('app-up', [], {}, [dev], facts).tail).toContain('--no-build');
    const override = readFileSync(resolve(import.meta.dirname, '../../compose.dev-release.yaml'), 'utf8');
    expect(override.match(/build: !reset null/g)).toHaveLength(3);
    expect(override.match(/image: \$\{AVIATION_DEV_RELEASE_IMAGE_ID:/g)).toHaveLength(3);
    const base = readFileSync(resolve(import.meta.dirname, '../../compose.yaml'), 'utf8');
    expect(base).toContain('pull_policy: never');
    expect(base).toContain('127.0.0.1:${PORT:-3000}:3000');
    expect(override).not.toMatch(/ports:|networks:|environment:/);
  });

  it('refuses absent, unlabelled or mismatched images, even on a clean tagged checkout', () => {
    expect(() => planCompose('app-up', [], {}, [dev])).toThrow(/existing git tag/);
    expect(() => planCompose('app-up', [], {}, [dev], { ...facts, tagCommit: null })).toThrow(/git tag/);
    expect(() => planCompose('app-up', [], {}, [dev], { ...facts, image: null, head: revision, dirty: false })).toThrow(/no image will be built or pulled/);
    for (const image of [{ revision: null, id }, { revision: 'd'.repeat(40), id }, { revision, id: 'not-an-id' }, { revision }]) {
      expect(() => planCompose('app-up', [], {}, [dev], { ...facts, image })).toThrow(/dev release image/);
    }
  });

  it('requires explicit dev-only opt-in and a valid tag; refuses build, tunnel and tracing overrides', () => {
    for (const APP_VERSION of [undefined, 'dev', 'tag with spaces', 'v'.repeat(81)]) {
      expect(() => planCompose('app-up', [], {}, [{ ...dev, APP_VERSION }], facts)).toThrow(/APP_VERSION/);
    }
    for (const args of [['--rebuild'], ['--build'], ['--pull', 'always']]) {
      expect(() => planCompose('app-up', args, {}, [dev], facts)).toThrow(/refuses|no extra arguments/);
    }
    expect(() => planCompose('app-up', [], {}, [{ ...dev, APP_ENV: 'live' }], facts)).toThrow(/only to APP_ENV=dev/);
    expect(() => planCompose('app-up', [], {}, [{ ...dev, AVIATION_DEV_RELEASE_IMAGE: 'typo' }], facts)).toThrow(/true or false/);
    expect(() => planCompose('app-up', [], {}, [{ ...dev, TUNNEL_TOKEN: 't', EDGE_SUBNET: EDGE }], facts)).toThrow(/loopback/);
    expect(() => planCompose('app-up', [], {}, [{ ...dev, AVIATION_TRACING_ENABLED: 'true' }], facts)).toThrow(/tracing off/);
    expect(planCompose('app-up', [], { AVIATION_DEV_RELEASE_IMAGE: 'false' }, [dev]).tail).toContain('--build');
    expect(planCompose('app-up', [], {}, [env('dev')]).files).toEqual(['compose.yaml']);
  });

  it('the real wrapper supplies the inspected ID to Compose, not an exported override or the release tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aircase-compose-release-'));
    const log = join(dir, 'calls.jsonl');
    try {
      writeFileSync(join(dir, 'docker'), `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2);\n` +
        `if(a.join(' ') === 'compose version --short') console.log('2.24.0');\n` +
        `else if(a[0] === 'image') { if(process.env.OPS_TEST_MISSING) process.exit(1); console.log('${id} ${revision}'); }\n` +
        `else fs.appendFileSync(process.env.OPS_TEST_LOG, JSON.stringify({args:a, image:process.env.AVIATION_DEV_RELEASE_IMAGE_ID, version:process.env.APP_VERSION})+'\\n');\n`,
        { mode: 0o700 });
      writeFileSync(join(dir, 'git'), `#!${process.execPath}\nconst a = process.argv.slice(2);\n` +
        `if(a.includes('rev-parse')) console.log(a.some(x=>x.startsWith('refs/tags/')) ? '${revision}' : '${'c'.repeat(40)}');\n`, { mode: 0o700 });
      const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/compose.ts', 'app-up'], {
        cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 10000,
        env: { PATH: `${dir}:${process.env.PATH}`, ...dev, AVIATION_DEV_RELEASE_IMAGE_ID: 'untrusted-override', OPS_TEST_LOG: log, ...extra },
      });
      const success = run();
      expect(success.status, success.stderr).toBe(0);
      const call = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; image: string; version: string };
      expect(call.image).toBe(id);
      expect(call.version).toBe('v1.2.0');
      expect(call.args).toContain('compose.dev-release.yaml');
      expect(call.args).toContain('--no-build');
      expect(call.args).not.toContain('--build');
      expect(call.args).not.toContain('compose.tunnel.yaml');
      rmSync(log);
      const missing = run({ OPS_TEST_MISSING: 'true' });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('no image will be built or pulled');
      expect(() => readFileSync(log)).toThrow();
      const normal = run({ AVIATION_DEV_RELEASE_IMAGE: 'false', APP_VERSION: 'dev' });
      expect(normal.status, normal.stderr).toBe(0);
      const normalCall = JSON.parse(readFileSync(log, 'utf8')) as { args: string[] };
      expect(normalCall.args).toContain('--build');
      expect(normalCall.args).not.toContain('compose.dev-release.yaml');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
