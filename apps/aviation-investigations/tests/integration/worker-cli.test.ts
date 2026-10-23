/** The maintenance commands of the worker CLI, run as child processes against the local test database only. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, type Db } from '../../server/db/client.js';
import { listGenerations } from '../../server/db/generations.js';
import { resetControls, testDb, testDbUrl } from './helpers.js';

const run = promisify(execFile);
const APP_DIR = resolve(import.meta.dirname, '../..');
let app: Db;

beforeAll(() => {
  app = testDb('app');
});
afterAll(async () => {
  await closeDb(app);
});

async function worker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(resolve(APP_DIR, 'node_modules/.bin/tsx'), ['worker/cli.ts', ...args], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // Nonempty process values win over .env.local: only the aviation_test logins are used.
      DATABASE_URL: testDbUrl('app'),
      DATABASE_INGEST_URL: testDbUrl('ingest'),
      DATABASE_MIGRATOR_URL: testDbUrl('migrator'),
    },
  });
}

describe('worker maintenance commands', () => {
  it('prune-generations --dry-run lists the plan and deletes nothing', async () => {
    const before = (await listGenerations(app)).map((g) => g.id);
    const { stdout } = await worker('prune-generations', '--dry-run', '--grace-hours', '24');
    expect(stdout).toMatch(/^retained \(active and most recently published\): /m);
    expect(stdout).toMatch(/^would delete \(dry run, nothing deleted\): /m);
    expect(stdout).toMatch(/^skipped \(pinned\): /m);
    expect((await listGenerations(app)).map((g) => g.id)).toEqual(before);
  });

  it('prune-generations refuses a malformed --grace-hours', async () => {
    await expect(worker('prune-generations', '--grace-hours', 'soon')).rejects.toMatchObject({ code: 2 });
  });

  it('brief-diagnose takes a brief id and a step, and reports a missing step', async () => {
    // Usage errors exit 2 before connecting; the content itself is covered in briefs.test.ts.
    await expect(worker('brief-diagnose')).rejects.toMatchObject({ code: 2 });
    await expect(worker('brief-diagnose', 'not-a-uuid')).rejects.toMatchObject({ code: 2 });
    await expect(worker('brief-diagnose', '0b7e2a4c-1f3d-4e5a-9b6c-7d8e9f0a1b2c', '--step', '9')).rejects.toMatchObject({ code: 2 });
    for (const extra of [[], ['--include-expired']]) {
      await expect(worker('brief-diagnose', '0b7e2a4c-1f3d-4e5a-9b6c-7d8e9f0a1b2c', ...extra)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('no such brief step'),
      });
    }
  });

  it('prune-controls expires leases and prunes as the app role', async () => {
    const { stdout } = await worker('prune-controls');
    expect(stdout).toMatch(/^leases expired: \d+ \(charged [\d.]+ USD\)$/m);
    expect(stdout).toMatch(/^pruned trialIdentities: \d+$/m);
    expect(stdout).toMatch(/^pruned costLedger: \d+$/m);
  });

  it('restore-check passes on empty sign-in, brief and idempotency tables, names any with rows, and --empty empties them', async () => {
    const migrator = testDb('migrator');
    try {
      await resetControls();
      expect((await worker('restore-check')).stdout).toMatch(/^restore check passed: auth_deletion_confirmations, .*idempotency are empty$/m);
      await migrator.execute(sql`
        INSERT INTO auth_users (name, email, email_verified, created_at, updated_at) VALUES ('Restored', 'restored@example.com', true, now(), now())`);
      await expect(worker('restore-check')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('auth_users: 1 rows') });
      expect((await worker('restore-check', '--empty')).stdout).toMatch(/^restore check passed/m);
      expect((await migrator.execute(sql`SELECT count(*)::int AS n FROM auth_users`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await closeDb(migrator);
    }
  });

  it('ai-switch --account-check sets when signed-in AI requests take a Turnstile check', async () => {
    try {
      expect((await worker('ai-switch', '--account-check', 'always')).stdout).toMatch(/EVERY signed-in request checked/);
      expect((await worker('ai-switch')).stdout).toMatch(/EVERY signed-in request checked/);
      expect((await worker('ai-switch', '--account-check', 'suspicious')).stdout).toMatch(/signed-in requests checked when suspicious/);
      await expect(worker('ai-switch', '--account-check', 'sometimes')).rejects.toMatchObject({ code: 2 });
    } finally {
      await resetControls();
    }
  });
});
