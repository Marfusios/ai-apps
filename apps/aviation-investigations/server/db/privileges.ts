/**
 * Who owns what, and who may do what, in an environment's database (RUNBOOK, "Backups";
 * Task 22: a restore must leave every object owned by aviation_migrator with the grants
 * the migrations made).
 *
 * `privilegeSnapshot` reads the catalog of the connected database into sorted lines, one
 * per object: the database, schemas `public` and `drizzle`, their tables, sequences and
 * functions, column grants, row-level security policies and default privileges. Each line
 * names the owner and the effective privileges by grantee (a NULL ACL is expanded to the
 * built-in defaults, so PUBLIC's EXECUTE on a function shows), whether a function is
 * SECURITY DEFINER and its fixed settings, and whether a table enforces row-level security.
 * Environment login and owner roles (`aviation_<env>_app`, ...) are written as
 * `aviation_<env>_...`, so one expectation fits every environment; the grantor is left
 * out, and so is PostgreSQL 17's MAINTAIN privilege (the migrations revoke it only there).
 *
 * `EXPECTED_PRIVILEGES` (privileges-expected.ts) is the snapshot of a database provisioned
 * and migrated with this checkout. An integration test keeps it equal to a freshly
 * migrated database; regenerate it with `pnpm db:privileges` after a migration that adds
 * objects or changes grants.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';

/** Privileges PostgreSQL 17 added; the migrations revoke MAINTAIN only on 17 (server_version_num guards). */
const VERSION_SPECIFIC = new Set(['MAINTAIN']);

interface CatalogRow {
  kind: string;
  name: string;
  owner: string | null;
  /** `aclexplode` output: grantee name ('PUBLIC' for 0), privilege, grantable. */
  grants: { grantee: string; privilege: string; grantable: boolean }[] | null;
  extra: string | null;
}

/**
 * One row per object with its expanded ACL. Catalog reads only: any role can run it.
 * Relations, functions and policies of schemas public and drizzle; the current database;
 * the two schemas; columns with their own ACL; default privileges of this database.
 */
const CATALOG = sql`
  WITH objects AS (
    SELECT 'database' AS kind, d.datname::text AS name, d.datdba AS owner_oid,
      coalesce(d.datacl, acldefault('d', d.datdba)) AS acl, NULL::text AS extra
    FROM pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT 'schema', n.nspname::text, n.nspowner, coalesce(n.nspacl, acldefault('n', n.nspowner)), NULL
    FROM pg_namespace n WHERE n.nspname IN ('public', 'drizzle')
    UNION ALL
    SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
        WHEN 'f' THEN 'foreign table' ELSE 'table' END,
      n.nspname || '.' || c.relname, c.relowner,
      coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)),
      CASE WHEN c.relkind IN ('r', 'p') THEN
        'rls=' || CASE WHEN c.relrowsecurity THEN 'on' ELSE 'off' END
          || CASE WHEN c.relforcerowsecurity THEN ',forced' ELSE '' END END
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, NULL, a.attacl, NULL
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle') AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    UNION ALL
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      p.proowner, coalesce(p.proacl, acldefault('f', p.proowner)),
      CASE WHEN p.prosecdef THEN 'security definer' ELSE 'security invoker' END
        || coalesce(' set ' || array_to_string(p.proconfig, ' set '), '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'drizzle')
    UNION ALL
    SELECT 'policy', n.nspname || '.' || c.relname || '.' || pol.polname, NULL, NULL,
      'for ' || CASE pol.polcmd WHEN 'r' THEN 'select' WHEN 'a' THEN 'insert' WHEN 'w' THEN 'update'
          WHEN 'd' THEN 'delete' ELSE 'all' END
        || CASE WHEN pol.polpermissive THEN '' ELSE ' restrictive' END
        || ' to ' || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r)::text END, ',' ORDER BY 1)
          FROM unnest(pol.polroles) AS r)
        || ' using ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
        || ' check ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
    UNION ALL
    SELECT 'default privileges', 'for ' || pg_get_userbyid(da.defaclrole) || ' in ' || coalesce(n.nspname, 'every schema')
        || ' on ' || CASE da.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'functions'
          WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' ELSE da.defaclobjtype::text END,
      NULL, da.defaclacl, NULL
    FROM pg_default_acl da LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
  )
  SELECT o.kind, o.name, CASE WHEN o.owner_oid IS NULL THEN NULL ELSE pg_get_userbyid(o.owner_oid)::text END AS owner,
    (SELECT json_agg(json_build_object(
        'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END,
        'privilege', x.privilege_type, 'grantable', x.is_grantable))
      FROM aclexplode(o.acl) AS x) AS grants,
    o.extra
  FROM objects o`;

/** Replaces the environment's own login and owner roles (`aviation_dev_app`, ...) with `aviation_<env>_...`. */
function roleNormalizer(database: string): (text: string) => string {
  const env = /^aviation_([a-z][a-z0-9]{0,15})$/.exec(database)?.[1];
  if (!env) return (text) => text;
  const login = new RegExp(`\\baviation_${env}_(app|ingest|migrator|owner)\\b`, 'g');
  return (text) => text.replace(login, 'aviation_<env>_$1');
}

function line(row: CatalogRow, normalize: (text: string) => string): string {
  const parts = [`${row.kind} ${row.kind === 'database' ? 'current' : row.name}`];
  if (row.owner !== null) parts.push(`owner=${normalize(row.owner)}`);
  if (row.extra !== null) parts.push(normalize(row.extra));
  if (row.grants !== null) {
    const byGrantee = new Map<string, string[]>();
    for (const g of row.grants) {
      if (VERSION_SPECIFIC.has(g.privilege)) continue;
      const grantee = normalize(g.grantee);
      byGrantee.set(grantee, [...(byGrantee.get(grantee) ?? []), `${g.privilege}${g.grantable ? '*' : ''}`]);
    }
    const acl = [...byGrantee.entries()].map(([grantee, privileges]) => `${grantee}:${privileges.sort().join(',')}`).sort();
    parts.push(`acl=${acl.join(' ') || '-'}`);
  }
  return parts.join(' | ');
}

/** The ownership and privilege lines of the connected database, sorted. */
export async function privilegeSnapshot(db: DbOrTx): Promise<string[]> {
  const database = ((await db.execute(sql`SELECT current_database() AS d`)).rows[0] as { d: string }).d;
  const normalize = roleNormalizer(database);
  const rows = (await db.execute(CATALOG)).rows as unknown as CatalogRow[];
  return rows.map((r) => line(r, normalize)).sort();
}

export interface PrivilegeDiff {
  /** Expected lines the database lacks (a missing object, grant or owner). */
  missing: string[];
  /** Lines the database has that are not expected (another owner, an extra grant or object). */
  unexpected: string[];
}

export function comparePrivileges(actual: readonly string[], expected: readonly string[]): PrivilegeDiff {
  const have = new Set(actual);
  const want = new Set(expected);
  return {
    missing: expected.filter((l) => !have.has(l)),
    unexpected: actual.filter((l) => !want.has(l)),
  };
}
