/**
 * Per-environment provisioning of PostgreSQL and Elasticsearch, shared by the local
 * services setup (`pnpm services:setup`) and `scripts/provision-shared.ts`.
 *
 * Role model (docs/RUNBOOK.md#role-model): the NOLOGIN group roles aviation_migrator,
 * aviation_ingest and aviation_app hold every privilege the migrations grant. Each
 * environment has LOGIN roles aviation_<env>_{migrator,ingest,app} (NOINHERIT members
 * of their group) that may connect only to database aviation_<env>, which
 * aviation_migrator owns. Every connection acts as the group role through the URL
 * option `options=-c role=<group>`, so objects belong to the group roles and a login
 * without the option holds no privileges.
 *
 * Nothing here prints passwords, API keys or admin credentials.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client as EsClient } from '@elastic/elasticsearch';
import pg from 'pg';

export const ROLE_KINDS = ['migrator', 'ingest', 'app'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const GROUP_ROLES: Record<RoleKind, string> = {
  migrator: 'aviation_migrator',
  ingest: 'aviation_ingest',
  app: 'aviation_app',
};

/** Connection URL variable per role, as read by the app and the worker. */
export const URL_VARS: Record<RoleKind, string> = {
  migrator: 'DATABASE_MIGRATOR_URL',
  ingest: 'DATABASE_INGEST_URL',
  app: 'DATABASE_URL',
};

const ENV_NAME = /^[a-z][a-z0-9]{0,15}$/;

export function assertEnvName(env: string): void {
  if (!ENV_NAME.test(env)) throw new Error(`invalid environment name (expected ${ENV_NAME.source})`);
}

export const databaseName = (env: string): string => `aviation_${env}`;
export const loginRole = (env: string, kind: RoleKind): string => `aviation_${env}_${kind}`;
export const defaultIndexPrefix = (env: string): string => `ai-aviation-${env}`;

export type Log = (message: string) => void;

/**
 * URL of an environment login that acts as its group role. `base` supplies scheme,
 * host, port and query parameters such as `sslmode`; user, password, database and
 * the `options` parameter are replaced. Space and `=` are percent-encoded so that
 * both node-postgres and libpq read the option.
 */
export function roleUrl(base: string, env: string, kind: RoleKind, password: string): string {
  const u = new URL(base);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('expected a postgres:// URL');
  u.username = loginRole(env, kind);
  u.password = encodeURIComponent(password);
  u.pathname = `/${databaseName(env)}`;
  const params = [...u.searchParams]
    .filter(([k]) => k !== 'options')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  params.push(`options=${encodeURIComponent(`-c role=${GROUP_ROLES[kind]}`)}`);
  u.search = params.join('&');
  return u.toString();
}

/** The password of `url` if it belongs to the expected login, else undefined. */
export function passwordFor(url: string | undefined, login: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (decodeURIComponent(u.username) !== login || !u.password) return undefined;
    return decodeURIComponent(u.password);
  } catch {
    return undefined;
  }
}

/** Base URL (scheme, host, port, query) of a postgres URL, without credentials or database. */
export function pgBaseUrl(url: string): string {
  const u = new URL(url);
  u.username = '';
  u.password = '';
  u.pathname = '/';
  return u.toString();
}

/** A new random password (hex, so it needs no escaping anywhere). */
export const newPassword = (): string => randomBytes(24).toString('hex');

/**
 * SCRAM-SHA-256 verifier for `password` (RFC 5802/7677, as PostgreSQL stores it).
 * Sending the verifier instead of the password keeps the password out of server
 * statement logs. Generated passwords are ASCII, so SASLprep changes nothing.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export interface PgProvisionOptions {
  env: string;
  /** Administrative connection (superuser, or CREATEROLE and CREATEDB with membership in the group roles). */
  adminUrl: string;
  /** Passwords to keep, by role kind; missing ones are generated. */
  passwords?: Partial<Record<RoleKind, string>>;
  /** Generate new passwords even when existing ones are given. */
  rotate?: boolean;
  /** Report what would change; change nothing. */
  dryRun?: boolean;
  log?: Log;
}

const ident = (s: string): string => pg.escapeIdentifier(s);
const lit = (s: string): string => pg.escapeLiteral(s);

async function exists(c: pg.Client, query: string, value: string): Promise<boolean> {
  return ((await c.query(query, [value])).rowCount ?? 0) > 0;
}
const roleExists = (c: pg.Client, name: string) => exists(c, 'SELECT 1 FROM pg_roles WHERE rolname = $1', name);
const databaseExists = (c: pg.Client, name: string) => exists(c, 'SELECT 1 FROM pg_database WHERE datname = $1', name);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Create or update the group roles, the environment's login roles and its database
 * (idempotent). Returns the password of each login role.
 */
export async function provisionPostgres(opts: PgProvisionOptions): Promise<Record<RoleKind, string>> {
  assertEnvName(opts.env);
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = databaseName(opts.env);
  const created = opts.dryRun ? 'would create' : 'created';
  const admin = new pg.Client({ connectionString: opts.adminUrl, application_name: 'aviation-provision' });
  await admin.connect();
  const passwords = {} as Record<RoleKind, string>;
  try {
    const run = async (statement: string): Promise<void> => {
      if (!opts.dryRun) await admin.query(statement);
    };
    for (const kind of ROLE_KINDS) {
      const group = GROUP_ROLES[kind];
      const found = await roleExists(admin, group);
      if (!found) await run(`CREATE ROLE ${ident(group)} NOLOGIN`);
      await run(`ALTER ROLE ${ident(group)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL`);
      log(`group role ${group}: ${found ? 'present' : created} (NOLOGIN)`);
    }
    for (const kind of ROLE_KINDS) {
      const login = loginRole(opts.env, kind);
      const kept = opts.rotate ? undefined : opts.passwords?.[kind];
      passwords[kind] = kept ?? newPassword();
      const found = await roleExists(admin, login);
      const attrs = `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${lit(scramVerifier(passwords[kind]))}`;
      await run(found ? `ALTER ROLE ${ident(login)} ${attrs}` : `CREATE ROLE ${ident(login)} ${attrs}`);
      await run(`GRANT ${ident(GROUP_ROLES[kind])} TO ${ident(login)}`);
      const pw = kept ? 'kept' : opts.rotate ? 'rotated' : 'generated';
      log(`login role ${login}: ${found ? 'present' : created}, member of ${GROUP_ROLES[kind]}, password ${pw}`);
    }
    const dbFound = await databaseExists(admin, db);
    await run(dbFound ? `ALTER DATABASE ${ident(db)} OWNER TO aviation_migrator` : `CREATE DATABASE ${ident(db)} OWNER aviation_migrator`);
    // Only this environment's logins may connect. The owner's own CONNECT is revoked
    // too: it is shared by every environment and its members would inherit it.
    await run(`REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC`);
    await run(`REVOKE CONNECT ON DATABASE ${ident(db)} FROM aviation_migrator, aviation_ingest, aviation_app`);
    await run(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ROLE_KINDS.map((k) => ident(loginRole(opts.env, k))).join(', ')}`);
    log(`database ${db}: ${dbFound ? 'present' : created}, owner aviation_migrator, CONNECT only for aviation_${opts.env}_*`);
  } finally {
    await admin.end();
  }
  if (opts.dryRun) {
    log(`schema public in ${db}: would set owner, usage grants and default privileges`);
    return passwords;
  }
  // Schema ownership and default privileges, inside the environment's database.
  const inDb = new pg.Client({ connectionString: withDatabase(opts.adminUrl, db), application_name: 'aviation-provision' });
  await inDb.connect();
  try {
    await inDb.query(`
      ALTER SCHEMA public OWNER TO aviation_migrator;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO aviation_ingest, aviation_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE aviation_migrator IN SCHEMA public
        GRANT SELECT ON TABLES TO aviation_ingest, aviation_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE aviation_migrator IN SCHEMA public
        GRANT SELECT ON SEQUENCES TO aviation_ingest, aviation_app;`);
    log(`schema public in ${db}: owner aviation_migrator, usage for ingest and app`);
  } finally {
    await inDb.end();
  }
  return passwords;
}

export interface EsAdmin {
  url: string;
  password: string;
  caFile?: string;
}

export interface EsRole {
  name: string;
  keyName: string;
  body: { cluster?: string[]; indices: { names: string[]; privileges: string[] }[] };
}

/** Reader and writer roles of an environment, limited to `<prefix>-*`. */
export function esRoles(env: string, prefix = defaultIndexPrefix(env)): { read: EsRole; write: EsRole } {
  assertEnvName(env);
  const names = [`${prefix}-*`];
  return {
    read: {
      name: `aviation_${env}_reader`,
      keyName: `aviation-${env}-read`,
      body: { indices: [{ names, privileges: ['read', 'view_index_metadata'] }] },
    },
    write: {
      name: `aviation_${env}_writer`,
      keyName: `aviation-${env}-write`,
      // Cluster `monitor` lets ingestion list its indices (`_cat/indices`).
      body: { cluster: ['monitor'], indices: [{ names, privileges: ['create_index', 'write', 'manage', 'read'] }] },
    },
  };
}

function esClient(url: string, auth: { apiKey: string } | { username: string; password: string }, caFile?: string): EsClient {
  return new EsClient({ node: url, auth, ...(caFile ? { tls: { ca: readFileSync(caFile) } } : {}) });
}

/** True when `key` authenticates as the API key named `keyName`. */
async function keyWorks(admin: EsAdmin, key: string | undefined, keyName: string): Promise<boolean> {
  if (!key) return false;
  try {
    const me = await esClient(admin.url, { apiKey: key }, admin.caFile).security.authenticate();
    return me.api_key?.name === keyName;
  } catch {
    return false;
  }
}

export interface EsProvisionOptions {
  env: string;
  admin: EsAdmin;
  indexPrefix?: string;
  /** API keys to keep when they still work. */
  keys?: { read?: string; write?: string };
  rotate?: boolean;
  dryRun?: boolean;
  log?: Log;
}

/**
 * Create or update the environment's reader and writer roles and return an API key
 * for each, reusing a given key that still authenticates (idempotent). Re-minting
 * invalidates earlier keys of the same name.
 */
export async function provisionElasticsearch(opts: EsProvisionOptions): Promise<{ read: string; write: string }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const roles = esRoles(opts.env, opts.indexPrefix);
  const admin = esClient(opts.admin.url, { username: 'elastic', password: opts.admin.password }, opts.admin.caFile);
  const out = { read: '', write: '' };
  for (const which of ['read', 'write'] as const) {
    const role = roles[which];
    if (!opts.dryRun) await admin.security.putRole({ name: role.name, ...role.body });
    log(`role ${role.name}: ${opts.dryRun ? 'would put' : 'put'} on ${role.body.indices[0]!.names.join(', ')}`);
    const existing = opts.keys?.[which];
    if (!opts.rotate && (await keyWorks(opts.admin, existing, role.keyName))) {
      out[which] = existing!;
      log(`API key ${role.keyName}: kept`);
      continue;
    }
    if (opts.dryRun) {
      log(`API key ${role.keyName}: would mint`);
      continue;
    }
    await admin.security.invalidateApiKey({ name: role.keyName }).catch(() => undefined);
    const k = await admin.security.createApiKey({
      name: role.keyName,
      role_descriptors: { [role.name]: role.body },
      metadata: { app: 'aviation-investigations', env: opts.env },
    });
    out[which] = k.encoded;
    log(`API key ${role.keyName}: ${opts.rotate ? 'rotated' : 'minted'}`);
  }
  return out;
}
