/**
 * What a backup holds (server/db/backup.ts; RUNBOOK, "Backups"): no rows of the account,
 * sign-in, brief or idempotency tables, so a restore never brings back a deleted account,
 * its content, a session or OAuth state. The backup and restore scripts (docker/postgres),
 * the RUNBOOK's procedure and compose.yaml must say the same as the code.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POSTGRES_TOOLS_IMAGE } from '../../scripts/restore-drill.js';
import { BACKUP_EXCLUDED_DATA, pgDumpExclusions } from '../../server/db/backup.js';
import * as schema from '../../server/db/schema/index.js';

const APP_DIR = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNBOOK = readFileSync(resolve(APP_DIR, 'docs/RUNBOOK.md'), 'utf8');

const tables = Object.values(schema)
  .filter((v) => isTable(v))
  .map((t) => getTableName(t as Parameters<typeof getTableName>[0]));

/** The RUNBOOK section `## <title>`, up to the next `## `. */
function section(title: string): string {
  const start = RUNBOOK.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`RUNBOOK has no section ${title}`);
  const end = RUNBOOK.indexOf('\n## ', start + 1);
  return RUNBOOK.slice(start, end < 0 ? undefined : end);
}

describe('backups never hold accounts, sign-in state or content', () => {
  it('every sign-in table, the briefs and the idempotency records are left out; nothing else is', () => {
    for (const table of tables.filter((t) => t.startsWith('auth_'))) expect(BACKUP_EXCLUDED_DATA, table).toContain(table);
    for (const table of ['briefs', 'brief_steps', 'idempotency']) expect(BACKUP_EXCLUDED_DATA).toContain(table);
    // Each excluded name is a real table of the schema.
    for (const table of BACKUP_EXCLUDED_DATA) expect(tables, table).toContain(table);
    // Usage, abuse records, charges and the corpus stay in backups.
    for (const kept of ['usage_buckets', 'abuse_records', 'reservations', 'cost_ledger', 'trial_identities', 'cases']) expect(BACKUP_EXCLUDED_DATA).not.toContain(kept);
  });

  it('the backup script leaves out exactly those tables and dumps as the migrator login', () => {
    const script = readFileSync(resolve(APP_DIR, 'docker/postgres/backup.sh'), 'utf8');
    const excluded = [...script.matchAll(/--exclude-table-data=([a-z_]+)/g)].map((m) => m[1]);
    expect(excluded).toEqual(pgDumpExclusions().map((o) => o.split('=')[1]));
    expect(script).toMatch(/pg_dump --format=custom/);
    expect(script).toContain('--dbname "$DATABASE_MIGRATOR_URL"');
    // Written under a temporary name and renamed once complete, readable by its owner only.
    expect(script).toContain('umask 077');
    expect(script).toMatch(/mv "\$partial" "\/backup\/\$\{name\}"/);
  });

  it('the restore script restores as the migrator, with its default privileges suspended, in one transaction', () => {
    const script = readFileSync(resolve(APP_DIR, 'docker/postgres/restore.sh'), 'utf8');
    expect(script).toContain('--dbname "$DATABASE_MIGRATOR_URL"');
    expect(script).toContain('pg_restore --no-owner --use-list "$list" --file - "$file" && echo \'COMMIT;\'');
    expect(script).toContain("echo 'BEGIN;'");
    expect(script).toContain('ON_ERROR_STOP=1');
    expect(script).toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %s/);
    expect(script).toContain("grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - drizzle|ACL - SCHEMA public) '");
    expect(script).toMatch(/restore only into a freshly provisioned database/);
    // Never as an administrator, never with ownership taken from elsewhere.
    expect(script).not.toMatch(/PG_ADMIN|--role|--single-transaction/);
  });

  it('the drill restores with the same PostgreSQL tools image as the backup containers', () => {
    const compose = readFileSync(resolve(APP_DIR, 'compose.yaml'), 'utf8');
    expect(compose).toContain(`image: ${POSTGRES_TOOLS_IMAGE}`);
    expect(POSTGRES_TOOLS_IMAGE).toMatch(/^postgres:16\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it('the RUNBOOK restores with the wrapper, migrates, checks before the app starts and reconciles after', () => {
    const backups = section('Backups');
    const order = ['pnpm app:backup', 'pnpm provision:shared', 'pnpm app:restore', 'pnpm app:migrate', 'pnpm worker restore-check', 'pnpm app:up', 'pnpm worker restore-reconcile'];
    let at = -1;
    for (const command of order) {
      at = backups.indexOf(command, at + 1);
      expect(at, command).toBeGreaterThan(-1);
    }
    expect(backups).toContain('pnpm db:restore-drill');
    // The earlier procedure: an administrator restoring with --no-owner.
    expect(backups).not.toMatch(/pg_restore --no-owner --dbname/);
    expect(backups).not.toMatch(/<backup-role>|<admin-role>/);
  });

  it('after a restore the RUNBOOK keeps paid operations held until the reconciliation, which follows the check', () => {
    const backups = section('Backups');
    expect(backups).toContain('### Paid operations after a restore');
    expect(backups.indexOf('pnpm worker restore-check')).toBeLessThan(backups.indexOf('pnpm worker restore-reconcile'));
    for (const option of ['--interactive-usd', '--ingestion-usd', '--charge-remaining', '--dry-run']) expect(backups).toContain(option);
  });
});
