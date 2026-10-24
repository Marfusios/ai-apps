/**
 * What a backup of the database holds, and the check after a restore (RUNBOOK, "Backups";
 * DESIGN §7: "Account deletion ends sessions and removes saved content"; Task 20 review).
 *
 * A backup holds every table's definition but no rows of the tables below. They hold
 * people's accounts and what they asked, which deleting an account removes for good, and
 * sign-in state that must never come back:
 *
 * - `auth_users`, `auth_accounts`: each account's name, email and Google subject. A
 *   backup that held them would bring back an account deleted after it was taken.
 * - `auth_sessions`, `auth_verifications`, `auth_state_uses`,
 *   `auth_deletion_confirmations`: sessions (a token that, with BETTER_AUTH_SECRET, signs a
 *   valid cookie), Better Auth's verification rows (unused: OAuth state lives in an
 *   encrypted cookie), the hashes of used OAuth states and deletion confirmations.
 * - `briefs`, `brief_steps`: questions, answers, evidence and diagnostics, held 24 hours.
 * - `idempotency`: hashes of requests, deleted with an account.
 *
 * A restore therefore starts all of them empty: everyone signs in again, finding the same
 * usage counts and anti-abuse record (keyed by HMAC, and restored), and nothing a deletion
 * removed comes back. A new account is new again for its first days (the smaller daily
 * allowance) because the account rows are new. `restoreCheck` lists any of these tables
 * that are not empty (a dump made without the exclusions); `pnpm worker restore-check
 * --empty` empties them before the restored service opens.
 *
 * `restoreCheck` also compares every owner and grant with a freshly migrated database
 * (`EXPECTED_PRIVILEGES`, server/db/privileges.ts): a restore that left tables or SECURITY
 * DEFINER functions owned by the restoring administrator, or a grant the migrations never
 * made (for example the SELECT that provisioning's default privileges give the runtime roles
 * on tables the migrator creates, which a dump's own grants never revoke), fails it.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { EXPECTED_PRIVILEGES } from './privileges-expected.js';
import { comparePrivileges, privilegeSnapshot, type PrivilegeDiff } from './privileges.js';
import { AUTH_TABLES } from './schema/auth.js';

/** Tables whose rows a backup never holds (their definitions it does). */
export const BACKUP_EXCLUDED_DATA = [...AUTH_TABLES, 'brief_steps', 'briefs', 'idempotency'] as const;

/** The `pg_dump` options that leave those rows out (RUNBOOK, "Backups"). */
export function pgDumpExclusions(): string[] {
  return BACKUP_EXCLUDED_DATA.map((table) => `--exclude-table-data=${table}`);
}

export interface RestoreCheckReport {
  ok: boolean;
  /** Excluded tables that hold rows, each with its count: none after a restore of a proper backup. */
  rows: { table: string; rows: number }[];
  /** Excluded tables aviation_migrator cannot read: another role owns them. */
  unreadable: string[];
  /** Owners and grants that differ from a freshly migrated database. */
  privileges: PrivilegeDiff;
}

/**
 * Check a restored database before the service opens, as aviation_migrator (which owns, and
 * so reads, every table). The owners and grants come from the catalog, which any role reads,
 * so a database with the wrong owners is still described rather than failing on the first
 * table the migrator cannot read. Statements run one by one, outside a transaction.
 */
export async function restoreCheck(db: DbOrTx, expected: readonly string[] = EXPECTED_PRIVILEGES): Promise<RestoreCheckReport> {
  const privileges = comparePrivileges(await privilegeSnapshot(db), expected);
  const rows: { table: string; rows: number }[] = [];
  const unreadable: string[] = [];
  for (const table of BACKUP_EXCLUDED_DATA) {
    let n: number;
    try {
      const res = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}"`));
      n = (res.rows[0] as { n: number } | undefined)?.n ?? 0;
    } catch (err) {
      const code = ((err as { cause?: { code?: string } }).cause ?? (err as { code?: string })).code;
      if (code !== '42501') throw err;
      unreadable.push(table);
      continue;
    }
    if (n > 0) rows.push({ table, rows: n });
  }
  const ok = rows.length === 0 && unreadable.length === 0 && privileges.missing.length === 0 && privileges.unexpected.length === 0;
  return { ok, rows, unreadable, privileges };
}

/** Empty the excluded tables (as the schema owner; TRUNCATE skips the brief guards): a restore made from a dump that held them. */
export async function emptyExcludedTables(db: DbOrTx): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${BACKUP_EXCLUDED_DATA.map((t) => `"${t}"`).join(', ')}`));
}
