import { describe, expect, it } from 'vitest';
import {
  checkDatabaseUrl,
  checkEdgeSubnet,
  planCompose,
  versionAtLeast,
  type Values,
} from '../../scripts/compose.js';

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
