/**
 * Per-environment provisioning of PostgreSQL and Elasticsearch, shared by the local
 * services setup (`pnpm services:setup`) and `scripts/provision-shared.ts`.
 *
 * Role model (docs/RUNBOOK.md#role-model): the NOLOGIN group roles aviation_migrator,
 * aviation_ingest and aviation_app hold every privilege the migrations grant, and
 * aviation_migrator owns every schema object. Each environment has LOGIN roles
 * aviation_<env>_{migrator,ingest,app} (NOINHERIT members of their group) that may
 * connect only to database aviation_<env>. That database and its schema `public` are
 * owned by the environment's NOLOGIN role aviation_<env>_owner, which has no members,
 * so no login can change who may connect. Every connection acts as the group role
 * through the URL option `options=-c role=<group>`, so objects belong to the group
 * roles and a login without the option holds no privileges.
 *
 * Nothing here prints passwords, API keys or admin credentials.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client as EsClient } from '@elastic/elasticsearch';
import pg from 'pg';
import { DB_CONNECT_TIMEOUT_MS } from '../server/db/client.js';

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
/** NOLOGIN owner of the environment's database and schema `public`; it has no members. */
export const ownerRole = (env: string): string => `aviation_${env}_owner`;
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
  /** Administrative connection; must be a superuser (checked before anything changes). */
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
  const owner = ownerRole(opts.env);
  const logins = ROLE_KINDS.map((k) => loginRole(opts.env, k));
  const created = opts.dryRun ? 'would create' : 'created';
  const admin = new pg.Client({ connectionString: opts.adminUrl, application_name: 'aviation-provision', connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS });
  await admin.connect();
  const passwords = {} as Record<RoleKind, string>;
  try {
    // Owner changes, ACL resets across roles and default privileges for another role
    // need a superuser; fail before changing anything rather than half way.
    const su = await admin.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!su.rows[0]?.rolsuper) throw new Error('PG_ADMIN_URL must connect as a superuser');
    const run = async (statement: string): Promise<void> => {
      if (!opts.dryRun) await admin.query(statement);
    };
    const noRights = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
    for (const kind of ROLE_KINDS) {
      const group = GROUP_ROLES[kind];
      const found = await roleExists(admin, group);
      if (!found) await run(`CREATE ROLE ${ident(group)} NOLOGIN`);
      await run(`ALTER ROLE ${ident(group)} NOLOGIN ${noRights} PASSWORD NULL`);
      log(`group role ${group}: ${found ? 'present' : created} (NOLOGIN)`);
    }
    for (const kind of ROLE_KINDS) {
      const login = loginRole(opts.env, kind);
      const kept = opts.rotate ? undefined : opts.passwords?.[kind];
      passwords[kind] = kept ?? newPassword();
      const found = await roleExists(admin, login);
      const attrs = `LOGIN NOINHERIT ${noRights} PASSWORD ${lit(scramVerifier(passwords[kind]))}`;
      await run(found ? `ALTER ROLE ${ident(login)} ${attrs}` : `CREATE ROLE ${ident(login)} ${attrs}`);
      await run(`GRANT ${ident(GROUP_ROLES[kind])} TO ${ident(login)}`);
      const pw = kept ? 'kept' : opts.rotate ? 'rotated' : 'generated';
      log(`login role ${login}: ${found ? 'present' : created}, member of ${GROUP_ROLES[kind]}, password ${pw}`);
    }

    // The owner role must stay memberless: whoever could act as it could grant CONNECT.
    const ownerFound = await roleExists(admin, owner);
    if (!ownerFound) await run(`CREATE ROLE ${ident(owner)} NOLOGIN NOINHERIT`);
    await run(`ALTER ROLE ${ident(owner)} NOLOGIN NOINHERIT ${noRights} PASSWORD NULL`);
    const members = ownerFound
      ? (
          await admin.query<{ member: string; grantor: string }>(
            `SELECT pg_get_userbyid(m.member) AS member, pg_get_userbyid(m.grantor) AS grantor
             FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = $1`,
            [owner],
          )
        ).rows
      : [];
    for (const m of members) await run(`REVOKE ${ident(owner)} FROM ${ident(m.member)} GRANTED BY ${ident(m.grantor)} CASCADE`);
    log(`owner role ${owner}: ${ownerFound ? 'present' : created} (NOLOGIN, no members${members.length ? `; ${opts.dryRun ? 'would revoke' : 'revoked'} ${members.length}` : ''})`);

    const dbFound = await databaseExists(admin, db);
    await run(dbFound ? `ALTER DATABASE ${ident(db)} OWNER TO ${ident(owner)}` : `CREATE DATABASE ${ident(db)} OWNER ${ident(owner)}`);
    // Reset the database ACL: only this environment's logins hold a privilege, and
    // only CONNECT, without grant option. The group roles (shared by every
    // environment) hold nothing here, so their members cannot grant themselves access.
    await run(`REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC`);
    if (dbFound || !opts.dryRun) {
      const grantees = await admin.query<{ grantee: string }>(
        `SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee
         FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = $1 AND a.grantee <> 0`,
        [db],
      );
      for (const { grantee } of grantees.rows) {
        // Logins keep CONNECT throughout (no window where they cannot connect).
        if (logins.includes(grantee)) {
          await run(`REVOKE GRANT OPTION FOR ALL ON DATABASE ${ident(db)} FROM ${ident(grantee)} CASCADE`);
          await run(`REVOKE CREATE, TEMPORARY ON DATABASE ${ident(db)} FROM ${ident(grantee)} CASCADE`);
        } else {
          await run(`REVOKE ALL ON DATABASE ${ident(db)} FROM ${ident(grantee)} CASCADE`);
        }
      }
    }
    await run(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${logins.map(ident).join(', ')}`);
    log(`database ${db}: ${dbFound ? 'present' : created}, owner ${owner}, CONNECT only for ${logins.join(', ')}`);
  } finally {
    await admin.end();
  }
  if (opts.dryRun) {
    log(`schemas in ${db}: would set owners, migrator and usage grants, default privileges`);
    return passwords;
  }
  // Inside the database: `public` belongs to the owner role; the migrator may use and
  // create in it (objects stay owned by aviation_migrator, as the migrations expect)
  // and owns the `drizzle` schema of the migration journal. Nothing else.
  const inDb = new pg.Client({ connectionString: withDatabase(opts.adminUrl, db), application_name: 'aviation-provision', connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS });
  await inDb.connect();
  try {
    await inDb.query(`
      ALTER SCHEMA public OWNER TO ${ident(owner)};
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE, CREATE ON SCHEMA public TO aviation_migrator;
      GRANT USAGE ON SCHEMA public TO aviation_ingest, aviation_app;
      CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION aviation_migrator;
      ALTER SCHEMA drizzle OWNER TO aviation_migrator;
      REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE aviation_migrator IN SCHEMA public
        GRANT SELECT ON TABLES TO aviation_ingest, aviation_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE aviation_migrator IN SCHEMA public
        GRANT SELECT ON SEQUENCES TO aviation_ingest, aviation_app;`);
    log(`schemas in ${db}: public owned by ${owner} (USAGE, CREATE for aviation_migrator; USAGE for ingest and app), drizzle owned by aviation_migrator`);
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
      // Index privileges only: no cluster privilege, so neither key sees other
      // tenants' indices, cluster state or tasks on a shared cluster.
      body: { indices: [{ names, privileges: ['create_index', 'write', 'manage', 'read'] }] },
    },
  };
}

function esClient(url: string, auth: { apiKey: string } | { username: string; password: string }, caFile?: string): EsClient {
  return new EsClient({ node: url, auth, ...(caFile ? { tls: { ca: readFileSync(caFile) } } : {}) });
}

/** sha256 of a role definition, stored in each API key's metadata. */
export function descriptorHash(body: EsRole['body']): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * True when `key` authenticates as the API key named `role.keyName` and was minted
 * for the current role definition. A key minted before the definition changed
 * (another descriptor hash, or none) must be re-minted: API keys keep the role
 * descriptors they were created with.
 */
async function keyCurrent(admin: EsAdmin, adminClient: EsClient, key: string | undefined, role: EsRole): Promise<boolean> {
  if (!key) return false;
  try {
    const me = await esClient(admin.url, { apiKey: key }, admin.caFile).security.authenticate();
    if (me.api_key?.name !== role.keyName || !me.api_key.id) return false;
    const { api_keys: found } = await adminClient.security.getApiKey({ id: me.api_key.id });
    return found[0]?.metadata?.descriptor_sha256 === descriptorHash(role.body);
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
 * for each, reusing a given key that still authenticates and was minted for the
 * current role definition (idempotent). Re-minting invalidates earlier keys of the
 * same name.
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
    if (!opts.rotate && (await keyCurrent(opts.admin, admin, existing, role))) {
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
      metadata: { app: 'aviation-investigations', env: opts.env, descriptor_sha256: descriptorHash(role.body) },
    });
    out[which] = k.encoded;
    log(`API key ${role.keyName}: ${opts.rotate ? 'rotated' : existing ? 'minted (definition changed or key invalid)' : 'minted'}`);
  }
  return out;
}
