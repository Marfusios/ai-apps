import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client as EsClient } from '@elastic/elasticsearch';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/db/migrate.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';
import { parseProvisionArgs, runProvision } from '../../scripts/provision-shared.js';
import { ROLE_KINDS, loginRole, ownerRole } from '../../scripts/provision.js';
import { testDbUrl } from './helpers.js';

// Provisions a throwaway environment `ci` on the local services (or on the server in
// TEST_PG_ADMIN_URL, as `pnpm test:pg16` sets), checks its isolation, removes it.
const APP_DIR = resolve(import.meta.dirname, '../..');
const local = readDotenvAllowlisted(resolve(APP_DIR, '.env.local'), [
  'POSTGRES_PASSWORD',
  'POSTGRES_PORT',
  'ELASTIC_PASSWORD',
  'ELASTICSEARCH_URL',
]);
const PG_ADMIN_URL =
  process.env.TEST_PG_ADMIN_URL ||
  `postgres://postgres:${encodeURIComponent(local.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${local.POSTGRES_PORT ?? 55432}/postgres`;
const ES_URL = local.ELASTICSEARCH_URL ?? 'http://localhost:59200';
const ENV = 'ci';

let dir: string;
let out: string;
let args: string[];
const files = () => ({
  pgHost: join(out, 'postgres', `aviation-${ENV}.env`),
  pgDocker: join(out, 'postgres', `aviation-${ENV}.docker.env`),
  esHost: join(out, 'elasticsearch', `aviation-${ENV}.env`),
  esDocker: join(out, 'elasticsearch', `aviation-${ENV}.docker.env`),
});
const read = (f: string) =>
  readDotenvAllowlisted(f, [
    'APP_ENV', 'DATABASE_URL', 'DATABASE_INGEST_URL', 'DATABASE_MIGRATOR_URL', 'SHARED_POSTGRES_NETWORK',
    'ELASTICSEARCH_URL', 'ELASTICSEARCH_READ_API_KEY', 'ELASTICSEARCH_WRITE_API_KEY', 'ELASTICSEARCH_INDEX_PREFIX',
    'SHARED_ELASTICSEARCH_NETWORK',
  ]);
const admin = () => new pg.Client({ connectionString: PG_ADMIN_URL });
const esAdmin = () => new EsClient({ node: ES_URL, auth: { username: 'elastic', password: local.ELASTIC_PASSWORD ?? '' } });
const provision = (...extra: string[]) => runProvision(parseProvisionArgs([...args, ...extra]), () => undefined);

async function connectAs(url: string): Promise<{ current_user: string; session_user: string }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query('SELECT current_user, session_user')).rows[0];
  } finally {
    await c.end();
  }
}
const sqlState = (p: Promise<unknown>) => p.then(() => 'connected', (e: { code?: string }) => e.code ?? 'error');
const withDb = (url: string, db: string) => Object.assign(new URL(url), { pathname: `/${db}` }).toString();

async function cleanup(): Promise<void> {
  const c = admin();
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS aviation_${ENV} WITH (FORCE)`);
    for (const k of ROLE_KINDS) await c.query(`DROP ROLE IF EXISTS ${loginRole(ENV, k)}`);
    await c.query(`DROP ROLE IF EXISTS ${ownerRole(ENV)}`);
  } finally {
    await c.end();
  }
  const es = esAdmin();
  for (const name of [`aviation-${ENV}-read`, `aviation-${ENV}-write`]) {
    await es.security.invalidateApiKey({ name }).catch(() => undefined);
  }
  for (const name of [`aviation_${ENV}_reader`, `aviation_${ENV}_writer`]) {
    await es.security.deleteRole({ name }).catch(() => undefined);
  }
  const found = await es.cat.indices({ index: `ai-aviation-${ENV}-*`, format: 'json', h: 'index' });
  for (const { index } of found) if (index) await es.indices.delete({ index });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'provision-it-'));
  out = join(dir, 'connections');
  writeFileSync(join(dir, 'pg-admin.env'), `PG_ADMIN_URL=${PG_ADMIN_URL}\nOPENAI_API_KEY=unrelated\n`, { mode: 0o600 });
  writeFileSync(
    join(dir, 'es-admin.env'),
    `ELASTIC_PASSWORD=${local.ELASTIC_PASSWORD ?? ''}\nELASTICSEARCH_ADMIN_URL=${ES_URL}\n`,
    { mode: 0o600 },
  );
  args = [
    '--env', ENV, '--out', out,
    '--pg-admin-env', join(dir, 'pg-admin.env'), '--pg-docker-host', 'shared-postgres:5432', '--pg-network', 'pg-net',
    '--es-admin-env', join(dir, 'es-admin.env'), '--es-docker-url', 'http://shared-es:9200', '--es-network', 'es-net',
  ];
  await cleanup();
}, 120_000);

afterAll(async () => {
  await cleanup();
  rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('provision-shared on the local services', () => {
  it('writes private connection files for the environment', async () => {
    const result = await provision();
    const f = files();
    expect(result.files.sort()).toEqual(Object.values(f).sort());
    for (const file of Object.values(f)) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(out, 'postgres')).mode & 0o777).toBe(0o700);
    const host = read(f.pgHost);
    expect(host.APP_ENV).toBe(ENV);
    expect(host.DATABASE_URL).toMatch(/^postgres:\/\/aviation_ci_app:[0-9a-f]{48}@127\.0\.0\.1:\d+\/aviation_ci\?options=-c%20role%3Daviation_app$/);
    const docker = read(f.pgDocker);
    expect(docker.DATABASE_INGEST_URL).toMatch(/^postgres:\/\/aviation_ci_ingest:[0-9a-f]{48}@shared-postgres:5432\/aviation_ci\?options=/);
    expect(docker.SHARED_POSTGRES_NETWORK).toBe('pg-net');
    const es = read(f.esDocker);
    expect(es).toMatchObject({ ELASTICSEARCH_URL: 'http://shared-es:9200', ELASTICSEARCH_INDEX_PREFIX: 'ai-aviation-ci', SHARED_ELASTICSEARCH_NETWORK: 'es-net' });
    expect(read(f.esHost).ELASTICSEARCH_URL).toBe(ES_URL);
    const text = Object.values(f).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(text).not.toContain(local.POSTGRES_PASSWORD);
    expect(text).not.toContain(local.ELASTIC_PASSWORD);
    expect(text).not.toContain('unrelated');
  }, 120_000);

  it('connects each login as its group role, only to its own database', async () => {
    const host = read(files().pgHost);
    await expect(connectAs(host.DATABASE_URL!)).resolves.toEqual({ current_user: 'aviation_app', session_user: 'aviation_ci_app' });
    await expect(connectAs(host.DATABASE_MIGRATOR_URL!)).resolves.toMatchObject({ current_user: 'aviation_migrator' });
    // 42501: permission denied for database.
    expect(await sqlState(connectAs(withDb(host.DATABASE_URL!, 'aviation_test')))).toBe('42501');
    expect(await sqlState(connectAs(withDb(host.DATABASE_MIGRATOR_URL!, 'aviation_test')))).toBe('42501');
    expect(await sqlState(connectAs(withDb(testDbUrl('app'), 'aviation_ci')))).toBe('42501');
    // A login cannot act as another group role.
    const asMigrator = host.DATABASE_URL!.replace('role%3Daviation_app', 'role%3Daviation_migrator');
    expect(await sqlState(connectAs(asMigrator))).toBe('42501');
  });

  it('stops a migrator login from reaching another environment (the shared owner attack)', async () => {
    const host = read(files().pgHost);
    const c = new pg.Client({ connectionString: host.DATABASE_MIGRATOR_URL });
    await c.connect();
    try {
      expect((await c.query('SELECT current_user')).rows[0].current_user).toBe('aviation_migrator');
      // aviation_migrator holds no privilege on any database, so it cannot grant one.
      for (const statement of [
        'GRANT CONNECT ON DATABASE aviation_test TO aviation_ci_migrator',
        'GRANT CONNECT ON DATABASE aviation_test TO aviation_migrator',
        'GRANT CONNECT ON DATABASE aviation_ci TO aviation_test_migrator',
        'ALTER DATABASE aviation_test OWNER TO aviation_migrator',
        'SET ROLE aviation_test_owner',
        'SET ROLE aviation_ci_owner',
      ]) {
        await expect(c.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await c.end();
    }
    expect(await sqlState(connectAs(withDb(host.DATABASE_MIGRATOR_URL!, 'aviation_test')))).toBe('42501');
    // As the administrator: each database belongs to its memberless owner role and only
    // the environment's three logins hold CONNECT, without grant option.
    const a = admin();
    await a.connect();
    try {
      for (const env of [ENV, 'test']) {
        const acl = await a.query(
          `SELECT pg_get_userbyid(d.datdba) AS owner, pg_get_userbyid(x.grantee) AS grantee,
                  x.privilege_type, x.is_grantable
           FROM pg_database d, aclexplode(d.datacl) x WHERE d.datname = $1 ORDER BY 2`,
          [`aviation_${env}`],
        );
        expect(acl.rows).toEqual(
          ROLE_KINDS.map((k) => loginRole(env, k)).sort().map((grantee) => ({
            owner: ownerRole(env),
            grantee,
            privilege_type: 'CONNECT',
            is_grantable: false,
          })),
        );
        const members = await a.query(
          `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = $1`,
          [ownerRole(env)],
        );
        expect(members.rows[0].n).toBe(0);
      }
      const migratorDbPrivileges = await a.query(
        `SELECT count(*)::int AS n FROM pg_database d, aclexplode(d.datacl) x
         WHERE d.datname LIKE 'aviation\_%' AND x.grantee IN ('aviation_migrator'::regrole, 'aviation_ingest'::regrole, 'aviation_app'::regrole)`,
      );
      expect(migratorDbPrivileges.rows[0].n).toBe(0);
    } finally {
      await a.end();
    }
  });

  it('migrates as aviation_migrator, which owns every object', async () => {
    const host = read(files().pgHost);
    await runMigrations(host.DATABASE_MIGRATOR_URL!);
    const c = new pg.Client({ connectionString: host.DATABASE_MIGRATOR_URL });
    await c.connect();
    try {
      const owners = await c.query(
        `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname IN ('public', 'drizzle')
         UNION SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'public'::regnamespace`,
      );
      expect(owners.rows.map((r) => r.tableowner)).toEqual(['aviation_migrator']);
      const schemas = await c.query(
        `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('public', 'drizzle') ORDER BY 1`,
      );
      expect(schemas.rows).toEqual([
        { nspname: 'drizzle', owner: 'aviation_migrator' },
        { nspname: 'public', owner: ownerRole(ENV) },
      ]);
      // A second run finds nothing pending.
      await runMigrations(host.DATABASE_MIGRATOR_URL!);
    } finally {
      await c.end();
    }
    // The ingest login has the ingest grants (and nothing without the role switch).
    const ingest = new pg.Client({ connectionString: host.DATABASE_INGEST_URL });
    await ingest.connect();
    try {
      await expect(ingest.query('SELECT count(*) FROM dataset_generations')).resolves.toBeDefined();
      await expect(ingest.query('SELECT analyze_corpus()')).resolves.toBeDefined();
      // RESET ROLE returns to the URL's role; only SET ROLE NONE drops it, and the
      // NOINHERIT login alone holds nothing.
      await ingest.query('RESET ROLE');
      await expect(ingest.query('SELECT current_user')).resolves.toMatchObject({ rows: [{ current_user: 'aviation_ingest' }] });
      await ingest.query('SET ROLE NONE');
      await expect(ingest.query('SELECT count(*) FROM public.dataset_generations')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ingest.end();
    }
    // A migrator URL without the role switch is refused before anything runs.
    const plain = host.DATABASE_MIGRATOR_URL!.replace(/\?options=.*$/, '');
    await expect(runMigrations(plain)).rejects.toThrow(/must run as aviation_migrator/);
  }, 120_000);

  it('limits the API keys to the environment indices', async () => {
    const env = read(files().esHost);
    const writer = new EsClient({ node: ES_URL, auth: { apiKey: env.ELASTICSEARCH_WRITE_API_KEY! } });
    const reader = new EsClient({ node: ES_URL, auth: { apiKey: env.ELASTICSEARCH_READ_API_KEY! } });
    const status = (p: Promise<unknown>) => p.then(() => 200, (e: { meta?: { statusCode?: number } }) => e.meta?.statusCode);
    await writer.indices.create({ index: 'ai-aviation-ci-probe' });
    await writer.index({ index: 'ai-aviation-ci-probe', document: { a: 1 }, refresh: true });
    expect(await status(reader.search({ index: 'ai-aviation-ci-probe' }))).toBe(200);
    expect(await status(reader.index({ index: 'ai-aviation-ci-probe', document: { a: 2 } }))).toBe(403);
    expect(await status(writer.indices.create({ index: 'aviation-test-ci-probe' }))).toBe(403);
    expect(await status(writer.indices.create({ index: 'ai-aviation-dev-ci-probe' }))).toBe(403);
  });

  it('keeps passwords and working keys on a rerun and replaces them with --rotate', async () => {
    const f = files();
    const before = { pg: readFileSync(f.pgHost, 'utf8'), es: readFileSync(f.esHost, 'utf8') };
    await provision();
    expect(readFileSync(f.pgHost, 'utf8')).toBe(before.pg);
    expect(readFileSync(f.esHost, 'utf8')).toBe(before.es);
    const oldApp = read(f.pgHost).DATABASE_URL!;
    await provision('--rotate');
    const rotated = read(f.pgHost);
    expect(rotated.DATABASE_URL).not.toBe(oldApp);
    expect(read(f.esHost).ELASTICSEARCH_WRITE_API_KEY).not.toBe(read(f.esHost).ELASTICSEARCH_READ_API_KEY);
    expect(readFileSync(f.esHost, 'utf8')).not.toBe(before.es);
    expect(await sqlState(connectAs(oldApp))).toBe('28P01'); // invalid password
    await expect(connectAs(rotated.DATABASE_URL!)).resolves.toMatchObject({ current_user: 'aviation_app' });
  }, 120_000);

  it('changes nothing in a dry run', async () => {
    const before = readFileSync(files().pgHost, 'utf8');
    await provision('--dry-run', '--rotate');
    expect(readFileSync(files().pgHost, 'utf8')).toBe(before);
    await expect(connectAs(read(files().pgHost).DATABASE_URL!)).resolves.toMatchObject({ current_user: 'aviation_app' });
  }, 120_000);
});
