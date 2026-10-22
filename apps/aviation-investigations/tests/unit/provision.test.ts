import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertOutsideRepo,
  parseProvisionArgs,
  readAdminEnv,
  repoRoot,
} from '../../scripts/provision-shared.js';
import {
  databaseName,
  esRoles,
  loginRole,
  ownerRole,
  passwordFor,
  pgBaseUrl,
  roleUrl,
  scramVerifier,
} from '../../scripts/provision.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'provision-unit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = ['--env', 'dev', '--out', join(dir, 'out')];
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
};

describe('parseProvisionArgs', () => {
  it('parses every flag and resolves paths', () => {
    const a = parseProvisionArgs([
      ...base,
      '--pg-admin-env', 'pg.env',
      '--pg-host-url', 'postgres://db.example:5432?sslmode=require',
      '--pg-docker-host', 'shared-postgres:5432',
      '--pg-network', 'shared_pg_net',
      '--es-admin-env', 'es.env',
      '--es-host-url', 'https://search.example:9200/',
      '--es-docker-url', 'https://es01:9200',
      '--es-ca-file', 'ca.crt',
      '--es-network', 'shared-es',
      '--rotate',
    ]);
    expect(a).toMatchObject({
      env: 'dev',
      out: join(dir, 'out'),
      pgAdminEnv: resolve('pg.env'),
      pgDockerHost: 'shared-postgres:5432',
      pgNetwork: 'shared_pg_net',
      esAdminEnv: resolve('es.env'),
      esHostUrl: 'https://search.example:9200',
      esDockerUrl: 'https://es01:9200',
      esCaFile: resolve('ca.crt'),
      esNetwork: 'shared-es',
      rotate: true,
      dryRun: false,
    });
  });

  it('defaults the booleans and accepts one side only', () => {
    expect(parseProvisionArgs([...base, '--es-admin-env', 'es.env'])).toMatchObject({ rotate: false, dryRun: false });
    expect(parseProvisionArgs([...base, '--pg-admin-env', 'pg.env', '--dry-run']).dryRun).toBe(true);
  });

  it.each([
    [['--out', 'x', '--pg-admin-env', 'a'], /--env is required/],
    [['--env', 'Dev', '--out', 'x', '--pg-admin-env', 'a'], /invalid environment name/],
    [['--env', 'dev-1', '--out', 'x', '--pg-admin-env', 'a'], /invalid environment name/],
    [['--env', 'dev', '--pg-admin-env', 'a'], /--out is required/],
    [base, /--pg-admin-env, --es-admin-env or both/],
    [[...base, '--es-admin-env', 'e', '--pg-network', 'n'], /--pg-network needs --pg-admin-env/],
    [[...base, '--pg-admin-env', 'p', '--es-ca-file', 'c'], /--es-ca-file needs --es-admin-env/],
    [[...base, '--pg-admin-env', 'p', '--pg-docker-host', 'a b'], /--pg-docker-host must be host\[:port\]/],
    [[...base, '--pg-admin-env', 'p', '--pg-host-url', 'postgres://u:secret-pw@h:5432'], /must not contain credentials/],
    [[...base, '--pg-admin-env', 'p', '--pg-host-url', 'mysql://h'], /must be a postgres:\/\/ URL/],
    [[...base, '--es-admin-env', 'e', '--es-host-url', 'https://elastic:secret-pw@h:9200'], /must not contain credentials/],
    [[...base, '--es-admin-env', 'e', '--es-docker-url', 'ftp://h'], /must be an http\(s\) URL/],
    [[...base, '--pg-admin-env', 'p', '--pg-network', 'bad/name'], /not a Docker network name/],
    [[...base, '--pg-admin-env', 'p', '--unknown'], /Unknown option/],
  ])('rejects %j', (argv, expected) => {
    const m = message(() => parseProvisionArgs(argv));
    expect(m).toMatch(expected);
    expect(m).not.toContain('secret-pw');
  });
});

describe('readAdminEnv', () => {
  it('returns only the allowlisted names', () => {
    const f = join(dir, 'es-admin.env');
    writeFileSync(f, 'ELASTIC_PASSWORD=pw\nELASTICSEARCH_ADMIN_URL=https://h:9200\nOPENAI_API_KEY=unrelated\n');
    expect(readAdminEnv(f, ['ELASTIC_PASSWORD', 'ELASTICSEARCH_ADMIN_URL'])).toEqual({
      ELASTIC_PASSWORD: 'pw',
      ELASTICSEARCH_ADMIN_URL: 'https://h:9200',
    });
  });

  it('names missing variables without echoing values', () => {
    const f = join(dir, 'pg-admin.env');
    writeFileSync(f, 'PG_ADMIN_URL=\nPOSTGRES_PASSWORD=secret-value\n');
    const m = message(() => readAdminEnv(f, ['PG_ADMIN_URL']));
    expect(m).toMatch(/lacks PG_ADMIN_URL/);
    expect(m).not.toContain('secret-value');
    expect(message(() => readAdminEnv(join(dir, 'missing.env'), ['PG_ADMIN_URL']))).toMatch(/not found/);
  });
});

describe('assertOutsideRepo', () => {
  const root = repoRoot();

  it('finds the work tree that contains the app', () => {
    expect(resolve(APP_DIR).startsWith(root)).toBe(true);
  });

  it('refuses the repository, paths inside it and paths that do not exist yet', () => {
    for (const p of [root, APP_DIR, join(APP_DIR, 'data', 'provision'), join(root, 'new', 'deep', 'dir')]) {
      expect(message(() => assertOutsideRepo(p))).toMatch(/outside the repository/);
    }
  });

  it('refuses a symlink that leads into the repository', () => {
    const link = join(dir, 'into-repo');
    symlinkSync(APP_DIR, link);
    expect(message(() => assertOutsideRepo(join(link, 'out')))).toMatch(/outside the repository/);
  });

  it('accepts a directory outside it, existing or not', () => {
    mkdirSync(join(dir, 'conn'), { recursive: true });
    expect(() => assertOutsideRepo(join(dir, 'conn'))).not.toThrow();
    expect(() => assertOutsideRepo(join(dir, 'not', 'yet'))).not.toThrow();
    expect(() => assertOutsideRepo(join(dir, 'conn'), APP_DIR)).not.toThrow();
  });
});

describe('connection URLs', () => {
  it('builds a login URL that acts as the group role', () => {
    const url = roleUrl('postgres://db.example:5432/?sslmode=require&options=x', 'live', 'app', 'abc123');
    expect(url).toBe(
      'postgres://aviation_live_app:abc123@db.example:5432/aviation_live?sslmode=require&options=-c%20role%3Daviation_app',
    );
    expect(new URL(url).searchParams.get('options')).toBe('-c role=aviation_app');
    expect(roleUrl('postgres://h', 'dev', 'migrator', 'p')).toContain('options=-c%20role%3Daviation_migrator');
    expect(() => roleUrl('mysql://h', 'dev', 'app', 'p')).toThrow(/postgres/);
  });

  it('reads back the password only for the expected login', () => {
    const url = roleUrl('postgres://h:1', 'dev', 'ingest', 'f00d');
    expect(passwordFor(url, loginRole('dev', 'ingest'))).toBe('f00d');
    expect(passwordFor(url, loginRole('live', 'ingest'))).toBeUndefined();
    expect(passwordFor('postgres://aviation_app:old@h/aviation', 'aviation_dev_app')).toBeUndefined();
    expect(passwordFor('not a url', 'x')).toBeUndefined();
    expect(passwordFor(undefined, 'x')).toBeUndefined();
  });

  it('strips credentials and database from the admin URL', () => {
    expect(pgBaseUrl('postgres://postgres:secret@db.example:5432/postgres?sslmode=verify-full')).toBe(
      'postgres://db.example:5432/?sslmode=verify-full',
    );
  });

  it('names databases, logins and Elasticsearch roles per environment', () => {
    expect(databaseName('live')).toBe('aviation_live');
    expect(loginRole('dev', 'migrator')).toBe('aviation_dev_migrator');
    expect(ownerRole('live')).toBe('aviation_live_owner');
    const r = esRoles('dev');
    expect(r.read).toMatchObject({ name: 'aviation_dev_reader', keyName: 'aviation-dev-read' });
    expect(r.read.body.indices).toEqual([{ names: ['ai-aviation-dev-*'], privileges: ['read', 'view_index_metadata'] }]);
    expect(r.write.body.indices).toEqual([
      { names: ['ai-aviation-dev-*'], privileges: ['create_index', 'write', 'manage', 'read'] },
    ]);
    expect(esRoles('test', 'aviation-test').write.body.indices[0]!.names).toEqual(['aviation-test-*']);
  });
});

describe('scramVerifier', () => {
  it('produces a PostgreSQL SCRAM-SHA-256 verifier without the password', () => {
    const v = scramVerifier('a-password', Buffer.alloc(16, 1));
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(v).not.toContain('a-password');
    expect(scramVerifier('a-password', Buffer.alloc(16, 1))).toBe(v);
    expect(scramVerifier('a-password')).not.toBe(v);
  });
});
