import { ensureSecrets, localPort, readLocal, writeLocal } from './local-env.js';
import { ROLE_KINDS, URL_VARS, loginRole, passwordFor, provisionPostgres, roleUrl, type RoleKind } from './provision.js';

/**
 * Local environments on the stand-alone services: `dev` (database aviation_dev, the
 * DATABASE_* URLs) and `test` (aviation_test for the integration tests, TEST_DATABASE_*).
 * Same role model as the shared cluster (scripts/provision.ts).
 */
export const LOCAL_PG_ENVS = [
  { env: 'dev', prefix: '' },
  { env: 'test', prefix: 'TEST_' },
] as const;

/** Creates group roles, per-environment logins and databases; writes their URLs to .env.local. */
export async function setupPostgres(): Promise<void> {
  const { POSTGRES_PASSWORD } = ensureSecrets(['POSTGRES_PASSWORD']);
  const port = localPort('POSTGRES_PORT', 55432);
  const base = `postgres://127.0.0.1:${port}`;
  const adminUrl = `postgres://postgres:${encodeURIComponent(POSTGRES_PASSWORD!)}@127.0.0.1:${port}/postgres`;
  const out: Record<string, string> = { POSTGRES_PORT: String(port) };
  for (const { env, prefix } of LOCAL_PG_ENVS) {
    const names = ROLE_KINDS.map((k) => `${prefix}${URL_VARS[k]}`);
    const existing = readLocal(names);
    const keep: Partial<Record<RoleKind, string>> = {};
    for (const k of ROLE_KINDS) {
      const pw = passwordFor(existing[`${prefix}${URL_VARS[k]}`], loginRole(env, k));
      if (pw) keep[k] = pw;
    }
    const passwords = await provisionPostgres({ env, adminUrl, passwords: keep, log: () => undefined });
    for (const k of ROLE_KINDS) out[`${prefix}${URL_VARS[k]}`] = roleUrl(base, env, k, passwords[k]);
  }
  writeLocal(out);
}
