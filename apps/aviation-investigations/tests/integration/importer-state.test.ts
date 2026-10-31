import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withScratchEnvironment, localAdminUrl } from '../../scripts/scratch-env.js';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { reserveSpend, settleSpend } from '../../server/quota/spend.js';
import { holdPaidOperations, reconcileRestore } from '../../server/quota/hold.js';
import {
  withImportSession,
  registerArtifact,
  budgetRemaining,
  fenced,
  resumeArtifact,
  type ImportSession,
  registerCandidate,
} from '../../worker/importer/store.js';
import { publishGeneration } from '../../worker/index/publish.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { createLedgerSpendGate } from '../../worker/index/spend-gate.js';
import { createOpenAIEmbedder } from '../../worker/index/embed.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { beginRun, updateRun } from '../../worker/importer/store.js';
import { pruneControls } from '../../server/quota/retention.js';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replayOutage, spoolFailure } from '../../worker/importer/recovery.js';
import { ManagedSpace, FILE_LIMITS } from '../../worker/importer/files.js';
import { adminOverview } from '../../server/admin/overview.js';
import type { ApiContext } from '../../server/routes/context.js';

const budgets = {
  monthlyUsd: 100,
  interactiveMonthlyUsd: 80,
  ingestionMonthlyUsd: 20,
  interactiveDailyUsd: 3,
  anonymousShare: 0.25,
};
const baseline = {
  generationId: 1,
  casesIndex: 'test-cases',
  passagesIndex: 'test-passages',
  publishedAt: '2026-10-31T01:00:00.000001Z',
};
const scratch = async (fn: (db: Db, owner: Db, app: Db) => Promise<void>) =>
  withScratchEnvironment(localAdminUrl(), 'importercheck', async (urls) => {
    const db = createDb(urls.ingest, { max: 8 }),
      owner = createDb(urls.migrator, { max: 4 }),
      app = createDb(urls.app, { max: 2 });
    try {
      await fn(db, owner, app);
    } finally {
      await Promise.all([closeDb(db), closeDb(owner), closeDb(app)]);
    }
  });
async function registered(db: Db, s: ImportSession) {
  return registerArtifact(db, s, 'dev', 'a'.repeat(64), 'b'.repeat(64), baseline);
}
const request = { provider: 'openai', model: 'text-embedding-3-small', stage: 'embed' };

describe('import ledger on an isolated migrated PostgreSQL database', () => {
  it('wires the trimmed importer state into the actual overview snapshot under the app role', async () =>
    scratch(async (db, _owner, app) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s),
          id = await beginRun(db, s, 'automatic');
        await updateRun(db, s, id, {
          step: 'complete',
          result: 'unchanged',
          artifactId: a.id,
          sourceCheckSucceeded: true,
          source: { advertisedAtLocal: '2026-10-01T07:36:33', bytes: 100 },
        });
        await fenced(db, s, (tx) =>
          tx.execute(
            sql`update import_artifacts set certificate='{"PRIVATE_SENTINEL":"private report"}'::jsonb where id=${a.id}::uuid`,
          ),
        );
      });
      const result = await adminOverview(
        { db: app, datasets: { current: async () => null } } as unknown as ApiContext,
        {
          emails: [],
          appEnv: 'dev',
          startedAt: '2026-10-31T12:00:00.000Z',
          ranking: 'er-q-v1',
          automaticFilters: 'none',
          imports: { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' },
        },
        new Date('2026-10-31T12:00:00Z'),
      );
      expect(result.system.imports.schedule?.nextCheckAt).toBe('2026-11-01T04:30:00.000Z');
      expect(result.system.imports.lastCheck?.result).toBe('unchanged');
      expect(result.system).not.toHaveProperty('nextAutomaticImport');
      expect(result.costs.interactiveToday).toBe(0);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    }));
  it('reconciles an outage without refreshing lastCheck, and keeps the original artifact review latched', async () =>
    scratch(async (db) => {
      const root = await mkdtemp(join(tmpdir(), 'import-spool-')),
        space = new ManagedSpace(root, { ...FILE_LIMITS, reserve: 0 });
      try {
        await withImportSession(db, async (s) => {
          const a = await registered(db, s),
            id = await beginRun(db, s, 'automatic');
          await spoolFailure(space, 'dev', new ImportFailure('integrity'), 'extract', id, a.id);
          await replayOutage(db, s, space, 'dev');
          await replayOutage(db, s, space, 'dev');
          const status = await readImportStatus(db, {
            enabled: true,
            localTime: '05:30',
            timeZone: 'Europe/Prague',
          });
          expect(status).toMatchObject({ lastCheck: null, attentionRequired: true, overdue: true });
          expect(status.recentRuns).toHaveLength(1);
          expect(status.recentRuns[0]?.reason).toBe('integrity');
          expect(await readdir(root)).toEqual([]);
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }));
  it('tags in the reservation transaction, serializes concurrent cap admission, counts uncertainty exactly once', async () =>
    scratch(async (db) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s),
          tag = { artifactId: a.id, fence: s.fence };
        const attempts = await Promise.allSettled(
          [1, 2, 3].map(() =>
            reserveSpend(db, { import: tag, category: 'indexing', usd: 0.2, request, budgets }),
          ),
        );
        const accepted = attempts.flatMap((r) =>
          r.status === 'fulfilled' && r.value.ok ? [r.value] : [],
        );
        expect(accepted).toHaveLength(2);
        expect(await budgetRemaining(db, s, a.id)).toBeCloseTo(0.1);
        const first = accepted[0]!,
          second = accepted[1]!;
        await settleSpend(
          db,
          { reservationId: first.reservationId },
          { lines: [{ usd: 0.1, ...request }] },
          first.fencingToken,
        );
        await settleSpend(
          db,
          { reservationId: second.reservationId },
          'uncertain',
          second.fencingToken,
        );
        expect(await budgetRemaining(db, s, a.id)).toBeCloseTo(0.2);
        for (let i = 0; i < 4; i++) await resumeArtifact(db, s, a.id);
        await expect(resumeArtifact(db, s, a.id)).rejects.toThrow();
        const counts = await db.execute(
          sql`select count(*)::int as n from reservations where import_artifact_id=${a.id}::uuid`,
        );
        expect(counts.rows[0]?.n).toBe(2);
        await expect(
          db.execute(
            sql`update reservations set import_artifact_id=null where id=${first.reservationId}`,
          ),
        ).rejects.toThrow();
      });
    }));
  it('refuses a stale fence and a cache-only resume after the irreversible retention boundary', async () =>
    scratch(async (db, owner) => {
      let stale = '';
      await withImportSession(db, async (s) => {
        stale = s.fence;
      });
      await withImportSession(db, async (s) => {
        const a = await registered(db, s);
        await expect(
          reserveSpend(db, {
            import: { artifactId: a.id, fence: stale },
            category: 'indexing',
            usd: 0.01,
            request,
            budgets,
          }),
        ).rejects.toThrow();
        // Privileged failure fixture in this disposable database only; production cannot edit the marker.
        await owner.execute(
          sql`alter table import_artifacts disable trigger import_artifact_guard`,
        );
        await owner.execute(
          sql`update import_artifacts set first_reservation_at=clock_timestamp()-interval '90 days' where id=${a.id}::uuid`,
        );
        await owner.execute(sql`alter table import_artifacts enable trigger import_artifact_guard`);
        await expect(resumeArtifact(db, s, a.id)).rejects.toThrow();
        await expect(budgetRemaining(db, s, a.id)).rejects.toThrow();
      });
    }));
  it('keeps an importer restore latch after global reconciliation, with no new identity/cap', async () =>
    scratch(async (db, owner) => {
      await withImportSession(db, async (s) => {
        await registered(db, s);
      });
      await holdPaidOperations(owner, 'synthetic restore');
      await reconcileRestore(owner, {
        interactiveUsd: 0,
        ingestionUsd: 0,
        note: 'synthetic global reconciliation',
        budgets,
      });
      await expect(withImportSession(db, async () => {})).rejects.toThrow();
      const c = await owner.execute(sql`select restore_required from import_control where id=1`);
      expect(c.rows[0]?.restore_required).toBe(true);
    }));
  it('retains expired outstanding reservations and old-month reservations in the artifact cap', async () =>
    scratch(async (db, owner) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s);
        const r = await reserveSpend(db, {
          import: { artifactId: a.id, fence: s.fence },
          category: 'indexing',
          usd: 0.3,
          request,
          budgets,
          ttlMs: 1,
        });
        expect(r.ok).toBe(true);
        await new Promise((r) => setTimeout(r, 5));
        // Month attribution is irrelevant to the lifetime (<90d) artifact aggregate.
        await owner.execute(sql`alter table reservations disable trigger user`);
        await owner.execute(
          sql`update reservations set accounting_day=(current_date-interval '1 month')::date where import_artifact_id=${a.id}::uuid`,
        );
        await owner.execute(sql`alter table reservations enable trigger user`);
        expect(await budgetRemaining(db, s, a.id)).toBeCloseTo(0.2);
        await expect(
          reserveSpend(db, {
            import: { artifactId: a.id, fence: s.fence },
            category: 'indexing',
            usd: 0.21,
            request,
            budgets,
          }),
        ).rejects.toThrow();
      });
    }));
  it('refuses references after deletion is requested and blocks deletion of retained candidates', async () =>
    scratch(async (db, owner) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s);
        await db.execute(
          sql`insert into index_builds(build_id,index_name,alias,generation_id) values('testone','test-index','test-alias',1)`,
        );
        await registerCandidate(db, s, a.id, 'test-index', 'testone', 1);
        await db.execute(
          sql`insert into index_switch_attempts(alias,index_name,build_id) values('test-alias','test-index','testone')`,
        );
        expect((await readImportStatus(db, null)).attentionRequired).toBe(true);
        await db.execute(
          sql`update index_switch_attempts set outcome='committed',resolved_at=clock_timestamp() where index_name='test-index'`,
        );
        expect((await readImportStatus(db, null)).attentionRequired).toBe(false);
        await expect(
          owner.execute(
            sql`update index_builds set deletion_requested_at=clock_timestamp() where build_id='testone'`,
          ),
        ).rejects.toThrow();
        await db.execute(
          sql`insert into index_builds(build_id,index_name,alias,generation_id) values('testtwo','test-index2','test-alias',1)`,
        );
        await owner.execute(
          sql`update index_builds set deletion_requested_at=clock_timestamp() where build_id='testtwo'`,
        );
        await expect(registerCandidate(db, s, a.id, 'test-index2', 'testtwo', 1)).rejects.toThrow();
      });
    }));
  it('every provider retry reserves a distinct artifact-tagged attempt and uncertain charges stay counted', async () =>
    scratch(async (db) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s),
          gate = createLedgerSpendGate(db, {
            import: { artifactId: a.id, fence: s.fence },
            budgets,
            provider: 'openai',
            model: 'text-embedding-3-small',
            stage: 'embed',
          });
        let calls = 0;
        const embedder = createOpenAIEmbedder({
          apiKey: 'synthetic-offline-only',
          model: 'text-embedding-3-small',
          dims: 1536,
          gate,
          purpose: 'import-offline-retries',
          sleep: async () => {},
          fetch: async () => {
            calls++;
            return new Response('{"error":{"type":"server_error","message":"PRIVATE_SENTINEL"}}', {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        });
        await expect(embedder.embed(['Public synthetic text'])).rejects.toThrow();
        expect(calls).toBe(3);
        const rows =
          await db.execute(sql`select count(*)::int as n,sum(charged_usd)::text as charged,
        bool_and(import_artifact_id=${a.id}::uuid and uncertain) as correct from reservations`);
        expect(rows.rows[0]?.n).toBe(3);
        expect(rows.rows[0]?.correct).toBe(true);
        expect(await budgetRemaining(db, s, a.id)).toBeCloseTo(
          0.5 - Number(rows.rows[0]?.charged),
          6,
        );
      });
    }));
  it('a pruned ledger and restore into another database cannot recreate the import allowance', async () =>
    scratch(async (db, owner) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s);
        const reservation = await reserveSpend(db, {
          import: { artifactId: a.id, fence: s.fence },
          category: 'indexing',
          usd: 0.2,
          request,
          budgets,
        });
        if (!reservation.ok) throw new Error('fixture reservation refused');
        await settleSpend(
          db,
          { reservationId: reservation.reservationId },
          { lines: [{ usd: 0.2, ...request }] },
          reservation.fencingToken,
        );
        const firstRun = await beginRun(db, s, 'automatic');
        await updateRun(db, s, firstRun, {
          step: 'plan',
          result: 'deferred',
          reason: 'interrupted',
          artifactId: a.id,
        });
        await owner.execute(
          sql`alter table import_artifacts disable trigger import_artifact_guard`,
        );
        await owner.execute(
          sql`update import_artifacts set first_reservation_at=clock_timestamp()-interval '2160 hours' where id=${a.id}::uuid`,
        );
        await owner.execute(sql`alter table import_artifacts enable trigger import_artifact_guard`);
        await owner.execute(sql`alter table reservations disable trigger user`);
        await owner.execute(sql`alter table cost_ledger disable trigger user`);
        await owner.execute(
          sql`update reservations set settled_at=clock_timestamp()-interval '90 days 1 second' where import_artifact_id=${a.id}::uuid`,
        );
        await owner.execute(
          sql`update cost_ledger set created_at=clock_timestamp()-interval '90 days 1 second' where reservation_id=${reservation.reservationId}`,
        );
        await owner.execute(sql`alter table reservations enable trigger user`);
        await owner.execute(sql`alter table cost_ledger enable trigger user`);
        expect((await pruneControls(owner)).reservations).toBe(1);
        await expect(resumeArtifact(db, s, a.id)).rejects.toThrow();
        const refused = await beginRun(db, s, 'automatic');
        await updateRun(db, s, refused, {
          step: 'plan',
          result: 'needs_review',
          reason: 'accounting',
          artifactId: a.id,
        });
        const status = await readImportStatus(db, {
          enabled: true,
          localTime: '05:30',
          timeZone: 'Europe/Prague',
        });
        expect(status.recentRuns[0]?.costUsd).toBe(0.2);
      });
      await owner.execute(sql`update paid_operations_hold set database_oid=0`);
      await reconcileRestore(owner, {
        interactiveUsd: 0,
        ingestionUsd: 0,
        note: 'synthetic global reconcile after clone',
        budgets,
      });
      await expect(withImportSession(db, async () => {})).rejects.toThrow();
    }));
  it('serializes the candidate/deletion race, even when the deletion already holds the row lock', async () =>
    scratch(async (db, owner) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s);
        await db.execute(
          sql`insert into index_builds(build_id,index_name,alias,generation_id) values('racebuild','race-index','race-alias',1)`,
        );
        let release!: () => void, entered!: () => void;
        const held = new Promise<void>((r) => {
            release = r;
          }),
          ready = new Promise<void>((r) => {
            entered = r;
          });
        const registration = fenced(db, s, async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
          entered();
          await held;
          await tx.execute(sql`insert into import_index_refs(index_name,artifact_id,build_id,generation_id)
          values('race-index',${a.id}::uuid,'racebuild',1)`);
        });
        await ready;
        const deletion = owner
          .execute(
            sql`update index_builds set deletion_requested_at=clock_timestamp() where build_id='racebuild'`,
          )
          .then(
            () => false,
            () => true,
          );
        await new Promise((r) => setTimeout(r, 25));
        release();
        await registration;
        expect(await deletion).toBe(true);
      });
    }));
  it('projects only the trimmed status and keeps review latched across later successful checks', async () =>
    scratch(async (db, owner) => {
      await withImportSession(db, async (s) => {
        const a = await registered(db, s),
          r = await beginRun(db, s, 'automatic');
        await updateRun(db, s, r, {
          step: 'complete',
          result: 'unchanged',
          sourceCheckSucceeded: true,
          source: { advertisedAtLocal: '2026-10-01T07:36:33', bytes: 100 },
          artifactId: a.id,
        });
        await fenced(db, s, (tx) =>
          tx.execute(sql`update import_artifacts set needs_review=true,reason='accounting',
        certificate='{"PRIVATE_SENTINEL":"not public"}'::jsonb where id=${a.id}::uuid`),
        );
        const status = await readImportStatus(db, {
          enabled: true,
          localTime: '05:30',
          timeZone: 'Europe/Prague',
        });
        expect(status.lastCheck?.result).toBe('unchanged');
        expect(status.overdue).toBe(false);
        expect(status.attentionRequired).toBe(true);
        expect(JSON.stringify(status)).not.toContain('PRIVATE_SENTINEL');
        const privileges =
          await owner.execute(sql`select has_table_privilege('aviation_app','import_artifacts','select') as readable,
        has_table_privilege('aviation_ingest','import_artifacts','delete') as deletable`);
        expect(privileges.rows[0]).toMatchObject({ readable: false, deletable: false });
      });
    }));
});
