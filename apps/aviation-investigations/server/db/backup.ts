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
 *   valid cookie), OAuth state with PKCE verifiers, used states and deletion confirmations.
 * - `briefs`, `brief_steps`: questions, answers, evidence and diagnostics, held 24 hours.
 * - `idempotency`: hashes of requests, deleted with an account.
 *
 * A restore therefore starts all of them empty: everyone signs in again, finding the same
 * usage counts and anti-abuse record (keyed by HMAC, and restored), and nothing a deletion
 * removed comes back. A new account is new again for its first days (the smaller daily
 * allowance) because the account rows are new. `restoreCheck` lists any of these tables
 * that are not empty (a dump made without the exclusions); `pnpm worker restore-check
 * --empty` empties them before the restored service opens.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { AUTH_TABLES } from './schema/auth.js';

/** Tables whose rows a backup never holds (their definitions it does). */
export const BACKUP_EXCLUDED_DATA = [...AUTH_TABLES, 'brief_steps', 'briefs', 'idempotency'] as const;

/** The `pg_dump` options that leave those rows out (RUNBOOK, "Backups"). */
export function pgDumpExclusions(): string[] {
  return BACKUP_EXCLUDED_DATA.map((table) => `--exclude-table-data=${table}`);
}

/** The excluded tables that hold rows (each with its count): none after a restore of a proper backup. */
export async function restoreCheck(db: DbOrTx): Promise<{ table: string; rows: number }[]> {
  const found: { table: string; rows: number }[] = [];
  for (const table of BACKUP_EXCLUDED_DATA) {
    const res = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}"`));
    const rows = (res.rows[0] as { n: number } | undefined)?.n ?? 0;
    if (rows > 0) found.push({ table, rows });
  }
  return found;
}

/** Empty the excluded tables (as the schema owner; TRUNCATE skips the brief guards): a restore made from a dump that held them. */
export async function emptyExcludedTables(db: DbOrTx): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${BACKUP_EXCLUDED_DATA.map((t) => `"${t}"`).join(', ')}`));
}
