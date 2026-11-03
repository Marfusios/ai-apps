/** Round-3 regressions exercise the real worker and app-role status reader. */
import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  importerFixture,
  OLD_OBSERVATION,
  type ImportFixture,
} from '../support/importer.js';
import { importerPair } from '../support/importer-pair.js';
import { editTable } from '../support/extract-dir.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import {
  artifact,
  control,
  fenced,
  manifest,
  withImportSession,
} from '../../worker/importer/store.js';
import { publishManifest } from '../../server/db/generations.js';
import { readImportStatus } from '../../server/db/import-status.js';
import {
  recordSkippedLiveWith,
  replayOutage,
  spoolFailure,
} from '../../worker/importer/recovery.js';
import { readDevOutcomeWith } from '../../worker/importer/outcome.js';
import {
  alertSentences,
  waitingWords,
  importOutcome,
} from '../../web/src/features/admin/imports.js';

const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
const later = { advertisedAtLocal: '2026-11-01T07:30:00', bytes: 12 };
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
async function third(f: ImportFixture) {
  return f.snapshot('third-public-fixture', (dir) =>
    editTable(dir, 'events', (rows) => {
      rows[0]!.lchg_date = '2026-11-01T00:00:00';
      return rows;
    }),
  );
}
async function republishOriginal(f: ImportFixture) {
  const m = f.baseline.manifest;
  await publishManifest(f.resources.db, m.generationId, m.casesIndex, m.passagesIndex);
  return (await manifest(f.resources.db))!;
}
const stopRegistered = {
  fault: async (point: string) => {
    if (point === 'registered') throw new ImportFailure('interrupted');
  },
};

it.each(['switching', 'published'] as const)(
  'recovery fall-through from %s leaves run identity free for the newly listed file',
  async (phase) =>
    importerFixture(async (f) => {
      await expect(f.run(stopRegistered)).rejects.toMatchObject({
        reason: 'interrupted',
      });
      const a = await saved(f);
      await withImportSession(f.resources.db, (s) =>
        fenced(f.resources.db, s, (tx) =>
          tx.execute(sql`update import_processing
      set phase=${phase},publication=${phase === 'published' ? JSON.stringify(f.baseline.manifest) : null}::jsonb
      where id=${a.processingId}::uuid`),
        ),
      );
      if (phase === 'published') await republishOriginal(f);
      const next = await third(f);
      f.setRemote(next, later);
      expect((await f.run()).result).toBe('published');
      expect((await control(f.resources.db)).accepted!.archive).toBe(next.archive);
      expect(
        (
          await f.owner.execute(
            sql`select key from import_issues where reason='integrity'`,
          )
        ).rows,
      ).toEqual([]);
      expect((await saved(f)).phase).toBe('complete');
    }),
);

it('a resumed publication retains its failing canary reason and does not retry restoration on the next listing outage', async () =>
  importerFixture(async (f) => {
    await f.run();
    const a = await saved(f);
    await withImportSession(f.resources.db, (s) =>
      fenced(f.resources.db, s, (tx) =>
        tx.execute(sql`update import_processing
      set phase='published',canary=null where id=${a.processingId}::uuid`),
      ),
    );
    await expect(
      f.run({
        runCanary: async (db, m, app) => {
          if (m.generationId === a.publication!.generationId)
            throw new ImportFailure('probe');
          return f.effects.runCanary!(db, m, app);
        },
      }),
    ).rejects.toMatchObject({ reason: 'site_check' });
    expect((await saved(f)).phase).toBe('restored');
    const original = (
      await f.owner.execute(
        sql`select original_reason,suppresses_file from import_issues where reason='site_check'`,
      )
    ).rows;
    expect(original).toEqual([{ original_reason: 'probe', suppresses_file: true }]);
    const before = (
      await f.owner.execute(sql`select key from import_issues where reason='site_check'`)
    ).rows;
    f.resources.source.inspect = async () => {
      throw new ImportFailure('source_unavailable');
    };
    const check = vi.fn(f.effects.runCanary!);
    const rollbackFault = vi.fn();
    await expect(f.run({ runCanary: check, fault: rollbackFault })).rejects.toMatchObject(
      { reason: 'source_unavailable', fix: false },
    );
    expect(check).not.toHaveBeenCalled();
    expect(rollbackFault.mock.calls.flat()).not.toContain('rollback_started');
    expect(
      (
        await f.owner.execute(
          sql`select key from import_issues where reason='site_check'`,
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await f.owner.execute(
          sql`select reason,fixed from import_issues order by created_at desc limit 1`,
        )
      ).rows[0],
    ).toEqual({ reason: 'source_unavailable', fixed: false });
  }));

it('same-code retry pins and restores the externally published generation that served just before its attempt', async () =>
  importerFixture(async (f) => {
    await f.run(); // generation 2 is the original baseline for the next attempt.
    const next = await third(f);
    f.setRemote(next, later);
    await expect(f.run(stopRegistered)).rejects.toMatchObject({ reason: 'interrupted' });
    const candidate = await saved(f);
    const external = await republishOriginal(f); // a DIFFERENT generation, not merely a new timestamp.
    expect(candidate.baseline!.generationId).not.toBe(external.generationId);
    await expect(
      f.run({
        fault: async (point) => {
          if (point !== 'loaded') return;
          expect((await saved(f)).baseline).toEqual(external);
          expect(
            (
              await f.owner.execute(
                sql`select generation_id from generation_pins where reason=${`import-previous:${candidate.id}`}`,
              )
            ).rows.map((r) => Number(r.generation_id)),
          ).toContain(external.generationId);
          const names = (
            await f.owner.execute(
              sql`select index_name from import_index_refs where artifact_id=${candidate.id}::uuid and released_at is null`,
            )
          ).rows.map((r) => r.index_name);
          expect(names).toEqual(
            expect.arrayContaining([external.casesIndex, external.passagesIndex]),
          );
        },
        runCanary: async (db, m, app) => {
          if (m.generationId !== external.generationId) throw new ImportFailure('probe');
          return f.effects.runCanary!(db, m, app);
        },
      }),
    ).rejects.toMatchObject({ reason: 'site_check' });
    expect((await manifest(f.resources.db))!.generationId).toBe(external.generationId);
    expect((await saved(f)).rollback!.casesIndex).toBe(external.casesIndex);
    expect((await saved(f)).phase).toBe('restored');
  }));

it.each(['direct', 'spooled'] as const)(
  'a resolved live skip starts a fresh %s episode with the current date and run',
  async (mode) =>
    importerPair(async (dev, live) => {
      dev.setRemote(dev.original, OLD_OBSERVATION);
      const fail = {
        deployedImage: async () => {
          throw new ImportFailure('configuration');
        },
      };
      await expect(dev.run(fail)).rejects.toThrow();
      const first = await readDevOutcomeWith(dev.resources.db, dev.config);
      await recordSkippedLiveWith(
        live.resources.db,
        live.resources.space,
        live.config,
        first,
      );
      const before = (await readImportStatus(live.app, schedule)).alert!;
      await withImportSession(live.resources.db, (s) =>
        fenced(live.owner, s, (tx) =>
          tx.execute(sql`update import_issues
      set created_at=created_at-interval '10 days' where resolved_at is null`),
        ),
      );
      expect((await dev.run()).result).toBe('unchanged');
      expect((await live.run()).result).toBe('unchanged');
      expect((await readImportStatus(live.app, schedule)).alert).toBeNull();
      await expect(dev.run(fail)).rejects.toThrow();
      const second = await readDevOutcomeWith(dev.resources.db, dev.config);
      const start = Date.now();
      if (mode === 'direct')
        await recordSkippedLiveWith(
          live.resources.db,
          live.resources.space,
          live.config,
          second,
        );
      else {
        await spoolFailure(
          live.resources.space,
          'live',
          new ImportFailure(second.reason),
          second.step,
          null,
          null,
          { ...second, origin: 'dev', originRunId: second.runId },
        );
        await withImportSession(live.resources.db, (s) =>
          replayOutage(live.resources.db, s, live.resources.space, 'live'),
        );
      }
      const after = (await readImportStatus(live.app, schedule)).alert!;
      expect(Date.parse(after.since!)).toBeGreaterThanOrEqual(start);
      expect(after.details!.runId).not.toBe(before.details!.runId);
      expect(after.originRunId).toBe(second.runId);
      expect(
        (
          await live.owner.execute(
            sql`select key from import_issues where resolved_at is not null`,
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await live.owner.execute(
            sql`select key from import_issues where resolved_at is null`,
          )
        ).rows,
      ).toHaveLength(1);
    }),
);

it.each(['configuration', 'storage'] as const)(
  'persistent preflight %s is bounded to an episode, with no file suppression',
  async (reason) =>
    importerFixture(async (f) => {
      for (let n = 0; n < 3; n++)
        await expect(
          f.run({
            deployedImage: async () => {
              throw new ImportFailure(reason);
            },
          }),
        ).rejects.toThrow();
      expect(
        (await f.owner.execute(sql`select preflight,suppresses_file from import_issues`))
          .rows,
      ).toEqual([{ preflight: true, suppresses_file: false }]);
    }),
);

it('recertification while the November file waits is attributed to serving data on dev and inherited live status', async () =>
  importerPair(async (dev, live) => {
    dev.setRemote(dev.candidate, later);
    await expect(dev.run(stopRegistered)).rejects.toMatchObject({
      reason: 'interrupted',
    });
    // Resolve that earlier interruption; this run is solely a failed release check.
    await withImportSession(dev.resources.db, (s) =>
      fenced(dev.resources.db, s, (tx) =>
        tx.execute(sql`update import_issues set resolved_at=clock_timestamp()`),
      ),
    );
    await expect(
      dev.run(
        {
          runCanary: async () => {
            throw new ImportFailure('probe');
          },
        },
        { recertify: true },
      ),
    ).rejects.toThrow();
    const local = await readImportStatus(dev.app, schedule);
    expect(local.alert).toMatchObject({ cause: 'probe', servingChecks: true });
    expect(local.waiting).toMatchObject({ source: later, reason: null });
    expect(waitingWords(local.waiting!.reason)).toBe('Not imported yet');
    const words = alertSentences(local, 'dev', 'UTC').join(' ');
    expect(words).toContain('The data on the site failed the release checks.');
    expect(words).not.toContain('The new data');
    expect(words).not.toContain('file of 1 Nov 2026 is waiting');
    await recordSkippedLiveWith(
      live.resources.db,
      live.resources.space,
      live.config,
      await readDevOutcomeWith(dev.resources.db, dev.config),
    );
    const inherited = await readImportStatus(live.app, schedule);
    expect(inherited.alert!.servingChecks).toBe(true);
    expect(inherited.waiting).toBeNull();
    expect(alertSentences(inherited, 'live', 'UTC').join(' ')).toContain(
      'The release checks failed in the test copy of the site (dev). Live was not touched.',
    );
    expect(importOutcome(inherited.recentRuns[0]!)).toContain(
      'The data on the site failed the release checks.',
    );
  }));

it('a pending newer file does not inherit an old file issue or a non-file failure reason', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'registered') throw new ImportFailure('schema');
        },
      }),
    ).rejects.toThrow();
    f.setRemote(await third(f), later);
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'fetched') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toThrow();
    const status = await readImportStatus(f.app, schedule);
    expect(status.alert?.cause).toBe('schema');
    expect(status.waiting).toMatchObject({
      source: later,
      reason: 'interrupted',
      retry: 'daily',
    });
    expect(waitingWords(status.waiting!.reason)).not.toContain('AirCase can’t read');
  }));
