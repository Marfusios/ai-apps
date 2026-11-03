import { it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { withScratchEnvironment, localAdminUrl } from '../../scripts/scratch-env.js';
import { createDb, closeDb } from '../../server/db/client.js';
import {
  withImportSession,
  fenced,
  beginRun,
  updateRun,
} from '../../worker/importer/store.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { resolveIssues } from '../../worker/importer/automatic.js';
const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
it('durable dates survive 200 later runs, deduplicate by civil day and reset only when resolved', async () =>
  withScratchEnvironment(localAdminUrl(), 'importhealth', async (urls) => {
    const db = createDb(urls.ingest),
      app = createDb(urls.app),
      owner = createDb(urls.migrator);
    try {
      await withImportSession(db, async (s) => {
        const record = async (day: number, fixed = false) => {
          const id = await beginRun(db, s, 'automatic');
          await updateRun(db, s, id, {
            step: 'acquire',
            result: 'deferred',
            reason: 'monthly_budget',
          });
          await fenced(db, s, (tx) =>
            tx.execute(sql`insert into import_issues(key,run_id,code,image,reason,step,origin,fixed,failure_day)
    values(${id.replaceAll('-', '').repeat(2)},${id}::uuid,${'a'.repeat(40)},${'sha256:' + 'b'.repeat(64)},'monthly_budget','acquire','dev',${fixed},${'2026-10-' + String(day).padStart(2, '0')})`),
          );
        };
        await record(22);
        await record(22);
        await record(24);
        expect((await readImportStatus(app, schedule)).alert).toBeNull();
        await record(25);
        expect((await readImportStatus(app, schedule)).alert).toMatchObject({
          level: 'delayed',
          cause: 'monthly_budget',
          failedDays: 3,
          origin: 'dev',
        });
        for (const day of [26, 27, 28, 29]) await record(day);
        // Simulate many later checks. They must not erase failure dates or invent a good check.
        await fenced(owner, s, (tx) =>
          tx.execute(sql`insert into import_runs(mode,result,step,finished_at,suppressed)
    select 'automatic','waiting','check',clock_timestamp(),true from generate_series(1,220)`),
        );
        await fenced(db, s, (tx) =>
          tx.execute(sql`select import_prune_runs(${s.fence}::uuid)`),
        );
        const result = await readImportStatus(app, schedule);
        expect(result.alert).toMatchObject({ level: 'fix', failedDays: 7 });
        expect(result.recentRuns).toHaveLength(20);
        expect(result.lastGoodCheck).toBeNull();
        expect(result.lastStartedAt).not.toBeNull();
        expect(
          await readImportStatus(app, { ...schedule, enabled: false }),
        ).toMatchObject({ status: 'off', alert: null });
        await resolveIssues(db, s, true);
        expect(await readImportStatus(app, schedule)).toMatchObject({
          status: 'working',
          alert: null,
        });
        for (const name of ['import_issues', 'import_processing', 'import_control'])
          await expect(app.execute(sql.raw(`select * from ${name}`))).rejects.toThrow();
        await expect(
          app.execute(sql`select import_public_run(gen_random_uuid())`),
        ).rejects.toThrow();
      });
    } finally {
      await Promise.all([closeDb(db), closeDb(app), closeDb(owner)]);
    }
  }));

it('the delay since is the first unresolved failure date, not the newest run', async () =>
  withScratchEnvironment(localAdminUrl(), 'importdelay', async (urls) => {
    const db = createDb(urls.ingest),
      app = createDb(urls.app);
    try {
      await withImportSession(db, async (session) => {
        for (const day of ['2026-10-22', '2026-10-24', '2026-10-25']) {
          const id = await beginRun(db, session, 'automatic');
          await updateRun(db, session, id, {
            step: 'acquire',
            result: 'deferred',
            reason: 'source_unavailable',
          });
          await fenced(db, session, (tx) =>
            tx.execute(sql`insert into import_issues
      (key,run_id,code,image,reason,step,origin,fixed,failure_day,created_at,last_at)
      values(${id.replaceAll('-', '').repeat(2)},${id}::uuid,${'a'.repeat(40)},${'sha256:' + 'b'.repeat(64)},
       'source_unavailable','acquire','dev',false,${day},${day + 'T04:30:00Z'}::timestamptz,${day + 'T04:30:00Z'}::timestamptz)`),
          );
        }
      });
      expect((await readImportStatus(app, schedule)).alert).toMatchObject({
        level: 'delayed',
        failedDays: 3,
        since: '2026-10-22T04:30:00.000Z',
      });
    } finally {
      await Promise.all([closeDb(db), closeDb(app)]);
    }
  }));

it('a restore alert uses the hold time and no unrelated incident details', async () =>
  withScratchEnvironment(localAdminUrl(), 'importholdstatus', async (urls) => {
    const db = createDb(urls.ingest),
      app = createDb(urls.app),
      owner = createDb(urls.migrator);
    try {
      await withImportSession(db, async (s) => {
        const id = await beginRun(db, s, 'automatic');
        await updateRun(db, s, id, {
          step: 'check',
          result: 'failed',
          reason: 'storage',
        });
        await fenced(db, s, (tx) =>
          tx.execute(sql`insert into import_issues(key,run_id,code,image,reason,step,origin,fixed,failure_day)
          values(${id.replaceAll('-', '').repeat(2)},${id}::uuid,${'a'.repeat(40)},${'sha256:' + 'b'.repeat(64)},'storage','check','host',true,'2026-11-01')`),
        );
      });
      await owner.execute(
        sql`update paid_operations_hold set held_at='2026-11-01T03:00:00Z'::timestamptz where id=1`,
      );
      expect((await readImportStatus(app, schedule)).alert).toMatchObject({
        cause: 'restore_hold',
        since: '2026-11-01T03:00:00.000Z',
        details: null,
        origin: 'host',
      });
    } finally {
      await Promise.all([closeDb(db), closeDb(app), closeDb(owner)]);
    }
  }));
