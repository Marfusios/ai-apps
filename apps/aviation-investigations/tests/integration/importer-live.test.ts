import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerPair } from '../support/importer-pair.js';
import {
  artifact,
  control,
  withImportSession,
  fenced,
  checkCertificate,
} from '../../worker/importer/store.js';
import { readDevOutcomeWith } from '../../worker/importer/outcome.js';
import { recordSkippedLiveWith } from '../../worker/importer/recovery.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { recordHostCleanup } from '../../worker/importer/host-status.js';
import { readFile } from 'node:fs/promises';
import { editTable } from '../support/extract-dir.js';

const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };

it('a full cycle promotes dev’s pinned file to live without downloading and keeps separate allowances', async () =>
  importerPair(async (dev, live) => {
    expect((await dev.run()).result).toBe('published');
    const download = vi.fn(async () => {
      throw new Error('live must use the certified local ZIP');
    });
    live.resources.source.acquire = download;
    live.resources.source.inspect = vi.fn(async () => {
      throw new Error('no upstream listing in live');
    });
    expect((await live.run()).result).toBe('published');
    expect(download).not.toHaveBeenCalled();
    const d = (
      await dev.owner.execute(
        sql`select id,environment,archive_sha256,attempts from import_artifacts`,
      )
    ).rows[0]!;
    const l = (
      await live.owner.execute(
        sql`select id,environment,archive_sha256,attempts from import_artifacts`,
      )
    ).rows[0]!;
    expect(l).toMatchObject({
      environment: 'live',
      archive_sha256: d.archive_sha256,
      attempts: 1,
    });
    expect(d.environment).toBe('dev');
    expect(l.id).not.toBe(d.id);
    const built = await artifact(live.resources.db, String(l.id));
    await withImportSession(live.resources.db, async (s) => {
      expect(
        (
          await live.resources.db.execute(
            sql`select import_check_budget(${l.id}::uuid,${s.fence}::uuid,2000000::bigint) as charged`,
          )
        ).rows[0]!.charged,
      ).toBe('0');
      await expect(
        checkCertificate(live.resources.db, s, {
          ...built.certificate!,
          dev: null,
        }),
      ).rejects.toMatchObject({ reason: 'dev_failed' });
    });
  }));

it('a failed dev run holds live back with that run’s own cause, ignoring newer host incidents', async () =>
  importerPair(async (dev, live) => {
    const start = new Date(Date.now() - 1000).toISOString();
    await expect(
      dev.run({
        fault: async (point) => {
          if (point === 'loaded') throw new ImportFailure('probe');
        },
      }),
    ).rejects.toMatchObject({ reason: 'probe' });
    await recordHostCleanup(
      dev.resources.db,
      dev.config,
      dev.resources.space,
      'dev',
      start,
      new ImportFailure('cleanup'),
    );
    const skip = await readDevOutcomeWith(dev.resources.db, dev.config);
    expect(skip.reason).toBe('probe');
    await recordSkippedLiveWith(
      live.resources.db,
      live.resources.space,
      live.config,
      skip,
    );
    const status = await readImportStatus(live.app, schedule);
    expect(status.alert).toMatchObject({
      cause: 'probe',
      origin: 'dev',
      originRunId: skip.runId,
    });
    expect(status.lastCheck).toMatchObject({
      result: 'skipped_dev_failed',
      reason: 'probe',
      origin: 'dev',
    });
    expect(
      (await live.owner.execute(sql`select count(*)::int n from import_artifacts`))
        .rows[0]!.n,
    ).toBe(0);
    expect(live.acquire).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++)
      await expect(live.run()).rejects.toMatchObject({
        reason: 'dev_failed',
        fix: false,
      });
    expect(
      (await live.owner.execute(sql`select count(*)::int n from import_artifacts`))
        .rows[0]!.n,
    ).toBe(0);
    expect(live.acquire).not.toHaveBeenCalled();
  }));

it('live refuses a shrunk file after dev advanced and identifies the split deployment', async () =>
  importerPair(async (dev, live) => {
    expect((await dev.run()).result).toBe('published');
    const original = live.effects.extractSnapshot!;
    await expect(
      live.run({
        extractSnapshot: async (...args) => {
          const candidate = await original(...args);
          return {
            ...candidate,
            facts: {
              ...candidate.facts,
              normalized: {
                ...candidate.facts.normalized,
                cases: candidate.facts.normalized.cases.slice(0, 1),
              },
            },
          };
        },
      }),
    ).rejects.toMatchObject({ reason: 'shrunk' });
    expect((await readImportStatus(live.app, schedule)).alert).toMatchObject({
      cause: 'shrunk',
      origin: 'live',
      devAdvanced: true,
    });
    expect((await control(live.resources.db)).accepted!.archive).toBe(
      live.baseline.archive,
    );
    expect((await control(dev.resources.db)).accepted!.archive).toBe(
      dev.candidate.archive,
    );
  }));

it('an adopted baseline with no source attestation waits for dev instead of raising configuration', async () =>
  importerPair(async (dev, live) => {
    await dev.owner.execute(sql`update import_control set accepted=null`);
    for (let i = 0; i < 5; i++)
      await expect(live.run()).rejects.toMatchObject({
        reason: 'dev_failed',
        fix: false,
      });
    expect(
      (await live.owner.execute(sql`select count(*)::int n from import_artifacts`))
        .rows[0]!.n,
    ).toBe(0);
    expect((await readImportStatus(live.app, schedule)).alert).toBeNull();
    expect(live.acquire).not.toHaveBeenCalled();
    expect((await dev.run()).result).toBe('published');
    expect((await live.run()).result).toBe('published');
  }));

it('a real 0028 cohort_bounds stop migrates unchanged, resumes its counters and publishes dev then live', async () =>
  importerPair(async (dev, live) => {
    // Reconstruct 3c903fc steps.acquire/extract/register + run catch using its 0028 SQL.
    // Comparison stopped at extract before startAttempt: artifact attempts=0, pending attempts=1.
    let runId = '',
      artifactId = '';
    await withImportSession(dev.resources.db, (s) =>
      fenced(dev.owner, s, async (tx) => {
        runId = String(
          (
            await tx.execute(
              sql`insert into import_runs(mode,step) values('automatic','extract') returning id`,
            )
          ).rows[0]!.id,
        );
        artifactId = String(
          (
            await tx.execute(sql`insert into import_artifacts(environment,archive_sha256,content_sha256,baseline)
      values('dev',${dev.candidate.archive},${dev.candidate.facts.digest},${JSON.stringify(dev.baseline.manifest)}::jsonb) returning id`)
          ).rows[0]!.id,
        );
        const pending = {
          archive: dev.candidate.archive,
          content: dev.candidate.facts.digest,
          artifactId,
          runId,
          observation: { advertisedAtLocal: '2026-11-01T07:30:00', bytes: 11 },
          fetchedAt: new Date().toISOString(),
          attempts: 1,
          needsReview: false,
          reason: null as string | null,
        };
        await tx.execute(
          sql`select import_set_pending(${s.fence}::uuid,${JSON.stringify(pending)}::jsonb,true)`,
        );
        await tx.execute(
          sql`update import_artifacts set needs_review=true,reason='cohort_bounds' where id=${artifactId}::uuid`,
        );
        await tx.execute(
          sql`select import_set_pending(${s.fence}::uuid,${JSON.stringify({ ...pending, needsReview: true, reason: 'cohort_bounds' })}::jsonb,false)`,
        );
        await tx.execute(sql`update import_runs set result='needs_review',reason='cohort_bounds',finished_at=clock_timestamp(),
      artifact_id=${artifactId}::uuid,pending_run_id=${runId}::uuid,source=${JSON.stringify(pending.observation)}::jsonb,
      observed_sha256=${dev.candidate.archive} where id=${runId}::uuid`);
      }),
    );
    const oldRun = (
      await dev.owner.execute(sql`select * from import_runs where id=${runId}::uuid`)
    ).rows[0]!;
    const oldArtifact = (
      await dev.owner.execute(
        sql`select * from import_artifacts where id=${artifactId}::uuid`,
      )
    ).rows[0]!;
    const oldMoney = (await dev.owner.execute(sql`select * from reservations`)).rows;
    expect(oldArtifact).toMatchObject({
      needs_review: true,
      reason: 'cohort_bounds',
      attempts: 0,
      generation_id: null,
      certificate: null,
    });
    expect((await control(dev.resources.db)).lastFetched).toMatchObject({
      state: 'needs_review',
      attempts: 1,
    });
    const pending = (await control(dev.resources.db)).pending!;
    dev.setRemote(dev.candidate, pending.observation);
    await dev.migrate();
    const migration = await readFile(
      new URL('../../server/db/migrations/0029_automatic_import.sql', import.meta.url),
      'utf8',
    );
    await dev.owner.transaction(async (tx) => {
      for (const statement of migration.split('--> statement-breakpoint'))
        if (statement.trim()) await tx.execute(sql.raw(statement));
    });
    expect(
      (
        await dev.owner.execute(
          sql`select * from import_artifacts where id=${artifactId}::uuid`,
        )
      ).rows[0],
    ).toEqual(oldArtifact);
    expect(await artifact(dev.resources.db, artifactId)).toMatchObject({
      code: '0'.repeat(40),
      image: 'sha256:' + '0'.repeat(64),
      phase: 'building',
      generation_id: null,
    });
    let resumedAttempts = 0;
    expect(
      (
        await dev.run({
          fault: async (point) => {
            if (point === 'extracted')
              resumedAttempts = (await control(dev.resources.db)).pending!.attempts;
          },
        })
      ).result,
    ).toBe('published');
    expect(resumedAttempts).toBe(2);
    const afterRun = (
      await dev.owner.execute(sql`select * from import_runs where id=${runId}::uuid`)
    ).rows[0]!;
    for (const key of Object.keys(oldRun))
      expect(afterRun[key], key).toEqual(oldRun[key]);
    expect(
      (
        await dev.owner.execute(
          sql`select * from import_artifacts where id=${artifactId}::uuid`,
        )
      ).rows[0],
    ).toEqual({ ...oldArtifact, attempts: 1 });
    expect((await dev.owner.execute(sql`select * from reservations`)).rows).toEqual(
      oldMoney,
    );
    expect((await live.run()).result).toBe('published');
    expect(live.acquire).not.toHaveBeenCalled();
    expect((await control(live.resources.db)).accepted!.archive).toBe(
      dev.candidate.archive,
    );
  }, true));

it('a repackaged unresolved live file keeps its original monetary identity and history', async () =>
  importerPair(async (dev, live) => {
    await dev.run();
    await expect(
      live.run({
        fault: async (point) => {
          if (point === 'registered') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toMatchObject({ reason: 'interrupted' });
    const before = (await live.owner.execute(sql`select * from import_artifacts`))
      .rows[0]!;
    const history = (
      await live.owner.execute(sql`select * from import_runs order by checked_at`)
    ).rows;
    const edit = (dir: string) =>
      editTable(dir, 'events', (rows) => {
        rows[0]!.lchg_date = '2026-10-30T00:00:00';
        return rows;
      });
    const repacked = await dev.snapshot('live-repacked-fix1', edit);
    await live.snapshot('live-repacked-fix1', edit);
    dev.setRemote(repacked, { advertisedAtLocal: '2026-11-02T07:30:00', bytes: 12 });
    // Same canonical corpus, different archive bytes; dev has proved this exact archive.
    expect((await dev.run()).result).toBe('unchanged');
    expect((await live.run()).result).toBe('published');
    const after = (await live.owner.execute(sql`select * from import_artifacts`)).rows;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.id,
      archive_sha256: before.archive_sha256,
      content_sha256: before.content_sha256,
      attempts: Number(before.attempts) + 1,
    });
    for (const row of history)
      expect(
        (
          await live.owner.execute(
            sql`select * from import_runs where id=${row.id}::uuid`,
          )
        ).rows[0],
      ).toEqual(row);
    expect(
      (await live.owner.execute(sql`select count(*)::int n from reservations`)).rows[0]!
        .n,
    ).toBe(0);
    expect(live.acquire).not.toHaveBeenCalled();
  }));
