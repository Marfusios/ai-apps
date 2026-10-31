import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withScratchEnvironment, localAdminUrl } from '../../scripts/scratch-env.js';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import {
  withImportSession,
  beginRun,
  updateRun,
  fenced,
  registerArtifact,
  type ImportSession,
} from '../../worker/importer/store.js';
import { acknowledgeWithResources } from '../../worker/importer/operations.js';
import { acknowledgePreartifact, preartifactFingerprint } from '../../worker/importer/durable.js';
import { ManagedSpace, FILE_LIMITS } from '../../worker/importer/files.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { holdPaidOperations } from '../../server/quota/hold.js';
import { reserveSpend, settleSpend } from '../../server/quota/spend.js';
import { budgetRemaining } from '../../worker/importer/store.js';

async function isolated(body: (db: Db, owner: Db, app: Db, space: ManagedSpace) => Promise<void>) {
  await withScratchEnvironment(localAdminUrl(), 'importoperator', async (urls) => {
    const db = createDb(urls.ingest, { max: 8 }),
      owner = createDb(urls.migrator),
      app = createDb(urls.app);
    const root = await mkdtemp(join(tmpdir(), 'import-operator-'));
    const space = new ManagedSpace(root, { ...FILE_LIMITS, reserve: 0 });
    try {
      await body(db, owner, app, space);
    } finally {
      await Promise.all([closeDb(db), closeDb(owner), closeDb(app)]);
      await rm(root, { recursive: true, force: true });
    }
  });
}
async function reviewedRun(db: Db, session: ImportSession) {
  const run = await beginRun(db, session, 'automatic');
  await updateRun(db, session, run, {
    step: 'extract',
    result: 'needs_review',
    reason: 'configuration',
  });
  return run;
}
async function evidence(db: Db, space: ManagedSpace, run: string) {
  const fingerprint = await preartifactFingerprint(db, run);
  const body = Buffer.from(
    JSON.stringify({
      version: 'preartifact-ack.v1',
      environment: 'dev',
      runId: run,
      runFingerprint: fingerprint,
      cleanupChecked: true,
    }),
  );
  const hash = createHash('sha256').update(body).digest('hex');
  await mkdir(join(space.root, 'reconciliation'), { recursive: true, mode: 0o700 });
  await writeFile(join(space.root, 'reconciliation', `preartifact-${hash}.json`), body, {
    mode: 0o600,
  });
  return { hash, fingerprint };
}

it('acknowledges only the exact finished setup failure, dry-runs, and serializes repeat/concurrent acknowledgements', async () =>
  isolated(async (db, _owner, app, space) => {
    await withImportSession(db, async (session) => {
      const run = await reviewedRun(db, session),
        proof = await evidence(db, space, run);
      const args = [db, session, space, 'dev', run, proof.hash] as const;
      await acknowledgeWithResources(...args, false, async () => {});
      expect(
        (await db.execute(sql`select acknowledged_at from import_runs where id=${run}::uuid`))
          .rows[0]?.acknowledged_at,
      ).toBeNull();
      expect((await readImportStatus(app, null)).attentionRequired).toBe(true);
      await Promise.all([1, 2].map(() => acknowledgeWithResources(...args, true, async () => {})));
      const first = (
        await db.execute(
          sql`select acknowledged_at::text as at,acknowledgement_sha256 from import_runs where id=${run}::uuid`,
        )
      ).rows[0];
      await acknowledgeWithResources(...args, true, async () => {});
      expect(
        (
          await db.execute(
            sql`select acknowledged_at::text as at,acknowledgement_sha256 from import_runs where id=${run}::uuid`,
          )
        ).rows[0],
      ).toEqual(first);
      expect(await preartifactFingerprint(db, run)).toBe(proof.fingerprint);
      expect(await readImportStatus(app, null)).toMatchObject({
        attentionRequired: false,
        lastCheck: null,
        lastSuccessfulImport: null,
      });
      await expect(
        acknowledgePreartifact(db, session, run, proof.fingerprint, 'f'.repeat(64), true),
      ).rejects.toThrow();
      await expect(
        db.execute(
          sql`update import_runs set acknowledged_at=clock_timestamp() where id=${run}::uuid`,
        ),
      ).rejects.toThrow();
    });
  }));

it.each([
  'running',
  'artifact',
  'accounting',
  'unknown_publication',
  'cleanup',
  'spool',
  'restore',
] as const)('refuses pre-artifact acknowledgement with %s evidence', async (kind) =>
  isolated(async (db, owner, _app, space) => {
    await withImportSession(db, async (session) => {
      const run = await reviewedRun(db, session);
      if (kind === 'running')
        await updateRun(db, session, run, { step: 'extract', result: 'running' });
      if (kind === 'accounting')
        await updateRun(db, session, run, {
          step: 'extract',
          result: 'needs_review',
          reason: 'accounting',
        });
      if (kind === 'artifact') {
        const saved = await registerArtifact(db, session, 'dev', 'a'.repeat(64), 'b'.repeat(64), {
          generationId: 1,
          casesIndex: 'synthetic-cases',
          passagesIndex: 'synthetic-passages',
          publishedAt: '2026-10-31T00:00:00.000001Z',
        });
        await updateRun(db, session, run, {
          step: 'extract',
          result: 'needs_review',
          reason: 'configuration',
          artifactId: saved.id,
        });
      }
      if (kind === 'unknown_publication')
        await db.execute(
          sql`insert into index_switch_attempts(alias,index_name) values('synthetic-alias','synthetic-index')`,
        );
      const proof = await evidence(db, space, run);
      if (kind === 'cleanup')
        await space.json(join(space.root, 'extraction.json'), { containers: ['synthetic'] });
      if (kind === 'spool')
        await space.json(join(space.root, 'status-dev.json'), { reason: 'interrupted' });
      if (kind === 'restore') await holdPaidOperations(owner, 'synthetic isolated restore');
      await expect(
        acknowledgeWithResources(db, session, space, 'dev', run, proof.hash, true, async () => {}),
      ).rejects.toThrow();
      expect(
        (await db.execute(sql`select acknowledged_at from import_runs where id=${run}::uuid`))
          .rows[0]?.acknowledged_at,
      ).toBeNull();
    });
  }),
);

it('contains status SQL failure inside a savepoint so the overview snapshot remains usable', async () =>
  isolated(async (_db, owner, app) => {
    await owner.execute(sql`create or replace function import_status_attention() returns boolean language plpgsql
    security definer set search_path=public,pg_temp as $$ begin raise exception 'PRIVATE_SENTINEL_SQL'; end $$`);
    await app.transaction(
      async (tx) => {
        expect((await readImportStatus(tx, null)).attentionRequired).toBe(true);
        expect((await tx.execute(sql`select 42 as answer`)).rows[0]?.answer).toBe(42);
      },
      { isolationLevel: 'repeatable read' },
    );
  }));

it('refuses at 89 days on database time, before the 90-day ledger retention boundary', async () =>
  isolated(async (db, owner) => {
    await withImportSession(db, async (session) => {
      const saved = await registerArtifact(db, session, 'dev', 'c'.repeat(64), 'd'.repeat(64), {
        generationId: 1,
        casesIndex: 'synthetic-cases',
        passagesIndex: 'synthetic-passages',
        publishedAt: '2026-10-31T00:00:00.000001Z',
      });
      const reservation = await reserveSpend(db, {
        import: { artifactId: saved.id, fence: session.fence },
        category: 'indexing',
        usd: 0.01,
        request: { provider: 'offline', model: 'synthetic', stage: 'embed' },
        budgets: {
          monthlyUsd: 100,
          interactiveMonthlyUsd: 80,
          ingestionMonthlyUsd: 20,
          interactiveDailyUsd: 3,
          anonymousShare: 0.25,
        },
      });
      if (!reservation.ok) throw new Error('isolated reservation refused');
      await settleSpend(
        db,
        { reservationId: reservation.reservationId },
        'uncertain',
        reservation.fencingToken,
      );
      // Time travel changes only this disposable fixture; production first-reservation markers remain immutable.
      await owner.execute(sql`alter table import_artifacts disable trigger import_artifact_guard`);
      await owner.execute(
        sql`update import_artifacts set first_reservation_at=clock_timestamp()-interval '2135 hours' where id=${saved.id}::uuid`,
      );
      await owner.execute(sql`alter table import_artifacts enable trigger import_artifact_guard`);
      expect(await budgetRemaining(db, session, saved.id)).toBe(0.49);
      await owner.execute(sql`alter table import_artifacts disable trigger import_artifact_guard`);
      await owner.execute(
        sql`update import_artifacts set first_reservation_at=clock_timestamp()-interval '2136 hours' where id=${saved.id}::uuid`,
      );
      await owner.execute(sql`alter table import_artifacts enable trigger import_artifact_guard`);
      await expect(budgetRemaining(db, session, saved.id)).rejects.toThrow();
    });
  }));
