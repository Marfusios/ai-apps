/**
 * The restore check (server/db/backup.ts, server/db/privileges.ts; RUNBOOK, "Backups"; Task 22
 * ops O1, data D-I1, gate finding 4): before a restored service opens, its database must have
 * exactly the owners and grants a freshly provisioned and migrated one has, and none of the rows
 * a backup never holds. Runs on throwaway environments of the local services, never on the
 * shared aviation_test, so another checkout's migrations cannot change what it sees.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { restoreCheck } from '../../server/db/backup.js';
import { closeDb, createDb } from '../../server/db/client.js';
import { EXPECTED_PRIVILEGES } from '../../server/db/privileges-expected.js';
import { comparePrivileges, privilegeSnapshot } from '../../server/db/privileges.js';
import { localAdminUrl, withScratchEnvironment } from '../../scripts/scratch-env.js';

const ENV = 'restorecheck';

const unexpectedLine = (r: Awaited<ReturnType<typeof restoreCheck>>, prefix: string): string =>
  r.privileges.unexpected.find((l) => l.startsWith(prefix)) ?? '';

/** The administrator, connected to the scratch environment's database. */
async function adminOf(): Promise<pg.Client> {
  const url = new URL(localAdminUrl());
  url.pathname = `/aviation_${ENV}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  return admin;
}

describe('restore check', () => {
  it('a database provisioned and migrated with this checkout has exactly the expected owners and grants', async () => {
    await withScratchEnvironment(localAdminUrl(), ENV, async (urls) => {
      const db = createDb(urls.migrator, { max: 1 });
      try {
        // On a difference, regenerate server/db/privileges-expected.ts with `pnpm db:privileges`.
        expect(comparePrivileges(await privilegeSnapshot(db), EXPECTED_PRIVILEGES)).toEqual({ missing: [], unexpected: [] });
        expect(await restoreCheck(db)).toEqual({ ok: true, rows: [], unreadable: [], privileges: { missing: [], unexpected: [] } });
      } finally {
        await closeDb(db);
      }
    });
  });

  it('refuses another owner, a grant too many or too few, and a definer function PUBLIC may execute', async () => {
    await withScratchEnvironment(localAdminUrl(), ENV, async (urls) => {
      const admin = await adminOf();
      const db = createDb(urls.migrator, { max: 1 });
      try {
        const adminRole = ((await admin.query('select current_user as u')).rows[0] as { u: string }).u;
        // What restoring as the administrator with --no-owner (the RUNBOOK's earlier procedure) leaves:
        await admin.query('ALTER TABLE public.cases OWNER TO CURRENT_USER');
        await admin.query('ALTER TABLE public.idempotency OWNER TO CURRENT_USER');
        await admin.query('ALTER FUNCTION public.prune_controls() OWNER TO CURRENT_USER');
        // What restoring as the migrator under provisioning's default privileges leaves, for both runtime roles:
        await admin.query('GRANT SELECT ON TABLE public.auth_users TO aviation_ingest');
        await admin.query('GRANT SELECT ON TABLE public.quarantine TO aviation_app');
        // A grant the dump lost, and one PUBLIC must never have.
        await admin.query('REVOKE EXECUTE ON FUNCTION public.publish_manifest(bigint, text, text, text) FROM aviation_ingest');
        await admin.query('GRANT EXECUTE ON FUNCTION public.spend_totals(date) TO PUBLIC');
        const r = await restoreCheck(db);
        expect(r.ok).toBe(false);
        expect(r.rows).toEqual([]);
        // The migrator no longer reads a table another role owns; the check says so instead of failing.
        expect(r.unreadable).toEqual(['idempotency']);
        expect(unexpectedLine(r, 'table public.idempotency |')).toContain(`owner=${adminRole}`);

        expect(unexpectedLine(r, 'table public.cases |')).toContain(`owner=${adminRole}`);
        expect(unexpectedLine(r, 'function public.prune_controls() |')).toContain(`owner=${adminRole} | security definer`);
        expect(unexpectedLine(r, 'table public.auth_users |')).toContain('aviation_ingest:SELECT');
        expect(unexpectedLine(r, 'table public.quarantine |')).toContain('aviation_app:SELECT');
        expect(unexpectedLine(r, 'function public.publish_manifest(')).not.toContain('aviation_ingest:EXECUTE');
        expect(unexpectedLine(r, 'function public.spend_totals(')).toContain('PUBLIC:EXECUTE');
        expect(r.privileges.unexpected).toHaveLength(7);
        expect(r.privileges.missing).toHaveLength(7);
        expect(r.privileges.missing.every((l) => EXPECTED_PRIVILEGES.includes(l))).toBe(true);
      } finally {
        await closeDb(db);
        await admin.end();
      }
    });
  });

  it('names the tables a backup never holds when they hold rows', async () => {
    await withScratchEnvironment(localAdminUrl(), ENV, async (urls) => {
      const db = createDb(urls.migrator, { max: 1 });
      try {
        await db.$client.query(
          `insert into auth_users (name, email, email_verified, created_at, updated_at) values ('Restored', 'restored@example.com', true, now(), now())`,
        );
        expect(await restoreCheck(db)).toEqual({
          ok: false,
          rows: [{ table: 'auth_users', rows: 1 }],
          unreadable: [],
          privileges: { missing: [], unexpected: [] },
        });
      } finally {
        await closeDb(db);
      }
    });
  });
});
