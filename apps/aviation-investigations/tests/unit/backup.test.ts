/**
 * What a backup holds (server/db/backup.ts; RUNBOOK, "Backups"): no rows of the account,
 * sign-in, brief or idempotency tables, so a restore never brings back a deleted account,
 * its content, a session or OAuth state. The RUNBOOK's command and procedure must say the
 * same as the code.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
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

  it('the RUNBOOK backup command leaves out exactly those tables, and the restore runs the check before the app starts', () => {
    const backups = section('Backups');
    const dump = /pg_dump[^`]*?"postgresql:[^"]*"/s.exec(backups)?.[0] ?? '';
    expect(dump).not.toBe('');
    const excluded = [...dump.matchAll(/--exclude-table-data=([a-z_]+)/g)].map((m) => m[1]);
    expect(excluded).toEqual(pgDumpExclusions().map((o) => o.split('=')[1]));
    expect(backups).toContain('pnpm worker restore-check');
    expect(backups.indexOf('pnpm worker restore-check')).toBeLessThan(backups.indexOf('pnpm app:up'));
  });
});
