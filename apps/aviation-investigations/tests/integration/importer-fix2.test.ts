import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture, type ImportFixture } from '../support/importer.js';
import { importerPair } from '../support/importer-pair.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import {
  artifact,
  control,
  fenced,
  manifest,
  withImportSession,
} from '../../worker/importer/store.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { readDevOutcomeWith } from '../../worker/importer/outcome.js';
import {
  recordSkippedLiveWith,
  replayOutage,
  spoolFailure,
} from '../../worker/importer/recovery.js';
import { operatorWithResources } from '../../worker/importer/commands.js';
import { recordHostCleanup } from '../../worker/importer/host-status.js';
import { digest } from '../../worker/importer/provenance.js';
import { publishManifest } from '../../server/db/generations.js';
const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };

// PostgreSQL has its own clock. Re-date only the rows produced by the real run,
// never invent a failure or change its classification/key/resolution.
async function dateLastRun(f: ImportFixture, at: Date) {
  await withImportSession(f.resources.db, (s) =>
    fenced(f.owner, s, async (tx) => {
      const id = String(
        (
          await tx.execute(
            sql`select id from import_runs order by checked_at desc limit 1`,
          )
        ).rows[0]!.id,
      );
      await tx.execute(sql`alter table import_runs disable trigger import_run_guard`);
      await tx.execute(
        sql`update import_runs set checked_at=${at.toISOString()}::timestamptz,finished_at=${at.toISOString()}::timestamptz where id=${id}::uuid`,
      );
      await tx.execute(sql`alter table import_runs enable trigger import_run_guard`);
      await tx.execute(
        sql`update import_issues set created_at=${at.toISOString()}::timestamptz,last_at=${at.toISOString()}::timestamptz where run_id=${id}::uuid`,
      );
    }),
  );
}
async function saved(f: ImportFixture) {
  return artifact(
    f.resources.db,
    String(
      (
        await f.owner.execute(
          sql`select id from import_artifacts order by created_at desc limit 1`,
        )
      ).rows[0]!.id,
    ),
  );
}
const at = (day: number) =>
  new Date(`2026-10-${String(20 + day).padStart(2, '0')}T04:30:00.000Z`);
it('real dev listing failures escalate after three then seven civil dates without losing the first date', async () =>
  importerFixture(async (f) => {
    f.resources.source.inspect = async () => {
      throw new ImportFailure('source_unavailable');
    };
    for (let day = 0; day < 7; day++) {
      await expect(f.run({ now: () => at(day) })).rejects.toMatchObject({
        reason: 'source_unavailable',
      });
      await dateLastRun(f, at(day));
      const status = await readImportStatus(f.app, schedule, at(day));
      if (day < 2) expect(status.alert).toBeNull();
      else
        expect(status.alert).toMatchObject({
          level: day < 6 ? 'delayed' : 'fix',
          failedDays: day + 1,
          since: at(0).toISOString(),
        });
    }
    expect(f.acquire).not.toHaveBeenCalled();
  }));
it('fixed listing failures retain their first date on dev and live and bound inherited fixed rows', async () =>
  importerPair(async (dev, live) => {
    dev.resources.source.inspect = async () => {
      throw new ImportFailure('source_listing_changed');
    };
    for (let day = 0; day < 3; day++) {
      await expect(dev.run({ now: () => at(day) })).rejects.toMatchObject({
        reason: 'source_listing_changed',
      });
      await dateLastRun(dev, at(day));
      const skip = await readDevOutcomeWith(dev.resources.db, dev.config);
      await recordSkippedLiveWith(
        live.resources.db,
        live.resources.space,
        live.config,
        skip,
      );
      await dateLastRun(live, at(day));
      for (const f of [dev, live])
        expect((await readImportStatus(f.app, schedule, at(day))).alert).toMatchObject({
          level: 'fix',
          since: at(0).toISOString(),
          nextAction: 'daily',
        });
    }
    expect(
      (
        await live.owner.execute(
          sql`select key from import_issues where fixed and resolved_at is null`,
        )
      ).rows,
    ).toHaveLength(1);
  }));
it('successful preflight clears only its own fixed failure, leaving a listing failure open', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        deployedImage: async () => {
          throw new ImportFailure('configuration');
        },
      }),
    ).rejects.toThrow();
    f.resources.source.inspect = async () => {
      throw new ImportFailure('source_listing_changed');
    };
    await expect(f.run()).rejects.toThrow();
    await expect(f.run()).rejects.toThrow();
    const rows = (
      await f.owner.execute(
        sql`select reason,preflight,resolved_at is not null as resolved from import_issues order by created_at`,
      )
    ).rows;
    expect(rows).toEqual([
      { reason: 'configuration', preflight: true, resolved: true },
      { reason: 'source_listing_changed', preflight: false, resolved: false },
      { reason: 'source_listing_changed', preflight: false, resolved: false },
    ]);
  }));
it('baseline_changed during file work is temporary; the next run adopts the new baseline and retries', async () =>
  importerFixture(async (f) => {
    let adopted: unknown;
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'loaded') {
            await publishManifest(
              f.resources.db,
              f.baseline.manifest.generationId,
              f.baseline.manifest.casesIndex,
              f.baseline.manifest.passagesIndex,
            );
            adopted = await manifest(f.resources.db);
            throw new ImportFailure('baseline_changed');
          }
        },
      }),
    ).rejects.toMatchObject({ reason: 'baseline_changed', fix: false });
    expect(
      (
        await f.owner.execute(
          sql`select fixed,suppresses_file from import_issues where resolved_at is null`,
        )
      ).rows,
    ).toEqual([{ fixed: false, suppresses_file: false }]);
    expect(
      (
        await f.run({
          fault: async (point) => {
            if (point === 'extracted')
              expect((await control(f.resources.db)).accepted!.manifest).toEqual(adopted);
          },
        })
      ).result,
    ).toBe('published');
  }));
it.each(['daily', 'emergency'] as const)(
  'emergency rollback with a failed check has no hold and resumes through %s recovery',
  async (recovery) =>
    importerFixture(async (f) => {
      await f.run();
      const a = await saved(f);
      await expect(
        operatorWithResources(
          f.config,
          'dev',
          'rollback',
          a.archive_sha256,
          { publicationHash: digest(a.publication) },
          f.resources,
          {
            ...f.effects,
            runCanary: async () => {
              throw new ImportFailure('probe');
            },
          },
        ),
      ).rejects.toMatchObject({ reason: 'site_check' });
      expect((await saved(f)).phase).toBe('rolling_back');
      expect(
        (await f.owner.execute(sql`select switch_hold from import_control`)).rows[0]!
          .switch_hold,
      ).toBeNull();
      expect((await readImportStatus(f.app, schedule)).alert).toMatchObject({
        siteState: 'restore_unverified',
        nextAction: 'daily',
      });
      if (recovery === 'daily') expect((await f.run()).result).toBe('waiting');
      else
        await operatorWithResources(
          f.config,
          'dev',
          'rollback',
          a.archive_sha256,
          { publicationHash: digest(a.publication) },
          f.resources,
          f.effects,
        );
      expect((await saved(f)).phase).toBe('restored');
      expect((await readImportStatus(f.app, schedule)).alert?.siteState).toBe('restored');
    }),
);
it('emergency rollback failure can update an existing suppression issue with the restricted ingest grant', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        runCanary: async () => {
          throw new ImportFailure('probe');
        },
        fault: async (point) => {
          if (point === 'rollback_started') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toThrow();
    const a = await saved(f);
    // Keep a known switch hold and existing file issue, but make rollback impossible.
    await withImportSession(f.resources.db, (s) =>
      fenced(f.owner, s, (tx) =>
        tx.execute(
          sql`update import_index_refs set released_at=clock_timestamp() where artifact_id=${a.id}::uuid`,
        ),
      ),
    );
    await expect(
      operatorWithResources(
        f.config,
        'dev',
        'rollback',
        a.archive_sha256,
        { publicationHash: digest(a.publication) },
        f.resources,
        f.effects,
      ),
    ).rejects.toMatchObject({ reason: 'rollback_failed' });
    expect(
      (
        await f.owner.execute(
          sql`select switch_hold->>'reason' as reason from import_control`,
        )
      ).rows[0],
    ).toEqual({ reason: 'rollback_failed' });
    expect(
      (
        await f.owner.execute(
          sql`select site_state from import_issues where resolved_at is null`,
        )
      ).rows,
    ).toEqual([{ site_state: 'uncertain' }]);
    await recordHostCleanup(
      f.resources.db,
      f.config,
      f.resources.space,
      'dev',
      new Date(Date.now() - 60_000).toISOString(),
      new ImportFailure('storage'),
    );
    expect((await readImportStatus(f.app, schedule)).alert).toMatchObject({
      cause: 'rollback_failed',
      holds: ['rollback_failed'],
      details: { reason: 'storage' },
    });
  }));

it('bounded fixed live skips show a new immutable cause when the same file passes preflight then fails processing', async () =>
  importerPair(async (dev, live) => {
    await expect(
      dev.run({
        fault: async (point) => {
          if (point === 'fetched') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toThrow();
    await expect(
      dev.run({
        deployedImage: async () => {
          throw new ImportFailure('configuration');
        },
      }),
    ).rejects.toThrow();
    const first = await readDevOutcomeWith(dev.resources.db, dev.config);
    await recordSkippedLiveWith(
      live.resources.db,
      live.resources.space,
      live.config,
      first,
    );
    expect((await readImportStatus(live.app, schedule)).alert).toMatchObject({
      cause: 'configuration',
      nextAction: 'daily',
    });
    await expect(
      dev.run({
        fault: async (point) => {
          if (point === 'loaded') throw new ImportFailure('probe');
        },
      }),
    ).rejects.toThrow();
    const second = await readDevOutcomeWith(dev.resources.db, dev.config);
    expect([second.archive, second.code, second.image]).toEqual([
      first.archive,
      first.code,
      first.image,
    ]);
    for (let i = 0; i < 3; i++)
      await recordSkippedLiveWith(
        live.resources.db,
        live.resources.space,
        live.config,
        second,
      );
    // Replaying a lost status write must use the same bounded immutable key.
    await spoolFailure(
      live.resources.space,
      'live',
      new ImportFailure(second.reason),
      second.step,
      null,
      null,
      {
        code: second.code,
        image: second.image,
        archive: second.archive,
        source: second.source,
        origin: 'dev',
        originRunId: second.runId,
        suppressFile: second.suppressFile,
      },
    );
    await withImportSession(live.resources.db, (s) =>
      replayOutage(live.resources.db, s, live.resources.space, 'live'),
    );
    expect((await readImportStatus(live.app, schedule)).alert).toMatchObject({
      cause: 'probe',
      nextAction: 'new_file_or_release',
    });
    expect(
      (
        await live.owner.execute(
          sql`select reason from import_issues where fixed and resolved_at is null order by reason`,
        )
      ).rows,
    ).toEqual([{ reason: 'configuration' }, { reason: 'probe' }]);
  }));
