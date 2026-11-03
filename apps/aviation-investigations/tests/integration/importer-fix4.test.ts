/** Real-run proofs for daily visibility and non-file cause attribution. */
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture } from '../support/importer.js';
import { importerPair } from '../support/importer-pair.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { fenced, withImportSession } from '../../worker/importer/store.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { readDevOutcomeWith } from '../../worker/importer/outcome.js';
import { recordSkippedLiveWith } from '../../worker/importer/recovery.js';
import {
  importOutcome,
  waitingWords,
  alertSentences,
} from '../../web/src/features/admin/imports.js';

const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000);

it('the quiet daily dev refresh is Last check and Recent runs; only the passing release command is hidden', async () =>
  importerFixture(async (f) => {
    await f.run();
    const imported = (await readImportStatus(f.app, schedule)).lastCheck!;
    f.config.live = { ...f.config.dev };
    expect((await f.run({ now: tomorrow })).result).toBe('unchanged');
    const daily = (
      await f.owner.execute(
        sql`select id,work_kind,source_check_succeeded from import_runs order by checked_at desc limit 1`,
      )
    ).rows[0]!;
    expect(daily).toMatchObject({
      work_kind: 'recertification',
      source_check_succeeded: true,
    });
    const checked = await readImportStatus(f.app, schedule);
    expect(checked.lastCheck!.runId).toBe(daily.id);
    expect(checked.lastCheck!.runId).not.toBe(imported.runId);
    expect(checked.recentRuns[0]!.runId).toBe(daily.id);
    expect(importOutcome(checked.lastCheck!)).toBe('No new file.');

    expect((await f.run({}, { recertify: true })).result).toBe('unchanged');
    const release = (
      await f.owner.execute(
        sql`select id,work_kind,source_check_succeeded from import_runs order by checked_at desc limit 1`,
      )
    ).rows[0]!;
    expect(release).toMatchObject({
      work_kind: 'recertification',
      source_check_succeeded: false,
    });
    const afterRelease = await readImportStatus(f.app, schedule);
    expect(afterRelease.lastCheck!.runId).toBe(daily.id);
    expect(afterRelease.recentRuns[0]!.runId).toBe(daily.id);
    expect(afterRelease.recentRuns.map((r) => r.runId)).not.toContain(release.id);
  }));

it.each([
  ['probe', 'Failed: The data on the site failed the release checks.'],
  ['source_unavailable', 'Failed: The NTSB download or the site did not answer.'],
] as const)(
  'the failed daily recheck stays visible with its %s words',
  async (reason, words) =>
    importerFixture(async (f) => {
      await f.run();
      f.config.live = { ...f.config.dev };
      await expect(
        f.run({
          now: tomorrow,
          runCanary: async () => {
            throw new ImportFailure(reason);
          },
        }),
      ).rejects.toMatchObject({ reason });
      const status = await readImportStatus(f.app, schedule);
      expect(status.lastCheck).toMatchObject({ workKind: 'recertification', reason });
      expect(status.recentRuns[0]!.runId).toBe(status.lastCheck!.runId);
      expect(importOutcome(status.lastCheck!)).toBe(words);
    }),
);

it('live counts the newest skip after a temporary dev release-check failure as Last check', async () =>
  importerPair(async (dev, live) => {
    await live.run();
    const before = (await readImportStatus(live.app, schedule)).lastCheck!;
    await expect(
      dev.run(
        {
          runCanary: async () => {
            throw new ImportFailure('source_unavailable');
          },
        },
        { recertify: true },
      ),
    ).rejects.toMatchObject({ reason: 'source_unavailable' });
    await recordSkippedLiveWith(
      live.resources.db,
      live.resources.space,
      live.config,
      await readDevOutcomeWith(dev.resources.db, dev.config),
    );
    const status = await readImportStatus(live.app, schedule);
    expect(status.alert).toBeNull();
    expect(status.lastCheck).toMatchObject({
      result: 'skipped_dev_failed',
      workKind: 'recertification',
      reason: 'source_unavailable',
    });
    expect(status.lastCheck!.runId).not.toBe(before.runId);
    expect(status.lastCheck!.runId).toBe(status.recentRuns[0]!.runId);
    expect(importOutcome(status.lastCheck!)).toBe(
      'Held back by the test copy of the site: The NTSB download or the site did not answer.',
    );
  }));

it.each(['configuration', 'source_listing_changed'] as const)(
  'a check-step %s incident leaves the pending file untried on both dev and live',
  async (reason) =>
    importerPair(async (dev, live) => {
      await expect(
        dev.run({
          fault: async (point) => {
            if (point === 'fetched') throw new ImportFailure('interrupted');
          },
        }),
      ).rejects.toThrow();
      // Keep a pending file, but isolate the later non-file cause from the earlier
      // interrupted acquisition (which correctly has its own archive-keyed reason).
      await withImportSession(dev.resources.db, (s) =>
        fenced(dev.resources.db, s, (tx) =>
          tx.execute(sql`update import_issues set resolved_at=clock_timestamp()`),
        ),
      );
      dev.resources.source.inspect = async () => {
        throw new ImportFailure(reason);
      };
      await expect(dev.run()).rejects.toMatchObject({ reason });
      const outcome = await readDevOutcomeWith(dev.resources.db, dev.config);
      expect(outcome).toMatchObject({
        reason,
        step: 'check',
        preflight: false,
        workKind: 'import',
      });
      expect(outcome.archive).not.toBeNull();
      await recordSkippedLiveWith(
        live.resources.db,
        live.resources.space,
        live.config,
        outcome,
      );
      for (const f of [dev, live]) {
        const status = await readImportStatus(f.app, schedule);
        expect(status.waiting).toMatchObject({ source: outcome.source, reason: null });
        expect(waitingWords(status.waiting!.reason)).toBe('Not imported yet');
        expect(
          alertSentences(status, f === dev ? 'dev' : 'live', 'UTC').join(' '),
        ).not.toContain('release checks');
      }
    }),
);

it('a daily storage failure never calls the serving file waiting, on dev or its inherited live skip', async () =>
  importerPair(async (dev, live) => {
    expect((await dev.run()).result).toBe('published');
    expect((await live.run()).result).toBe('published');
    await expect(
      dev.run({
        now: tomorrow,
        runCanary: async () => {
          throw new ImportFailure('storage');
        },
      }),
    ).rejects.toMatchObject({ reason: 'storage' });
    await recordSkippedLiveWith(
      live.resources.db,
      live.resources.space,
      live.config,
      await readDevOutcomeWith(dev.resources.db, dev.config),
    );
    for (const [env, f] of [
      ['dev', dev],
      ['live', live],
    ] as const) {
      const status = await readImportStatus(f.app, schedule);
      expect(status.alert).toMatchObject({
        cause: 'storage',
        servingChecks: false,
        details: { workKind: 'recertification' },
      });
      expect(status.alert!.details!.source!.advertisedAtLocal.slice(0, 10)).toBe(
        status.serving!.sourceDate,
      );
      expect(status.waiting).toBeNull();
      const text = alertSentences(status, env, 'UTC').join(' ');
      expect(text).not.toContain('is waiting');
      expect(text).toContain(
        'The server cannot safely save the import files. Check its disk space and permissions.',
      );
    }
  }));
