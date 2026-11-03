/** Coverage retained from the pre-automatic orchestration/recovery suites, with no review latches. */
import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { join } from 'node:path';
import { stat, writeFile, utimes } from 'node:fs/promises';
import {
  importerFixture,
  OLD_OBSERVATION,
  type ImportFixture,
} from '../support/importer.js';
import { editTable } from '../support/extract-dir.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import {
  artifact,
  control,
  fenced,
  latestCanary,
  manifest,
  withImportSession,
} from '../../worker/importer/store.js';
import { publishManifest } from '../../server/db/generations.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { planPassages } from '../../worker/index/passages-index.js';
import { retainFiles } from '../../worker/importer/retention.js';
import { reserveSpend, settleSpend } from '../../server/quota/spend.js';

const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
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
async function stamps(f: ImportFixture) {
  return (
    await f.owner.execute(
      sql`select id,verifier_version,verification_report_sha256,verified_at::text from dataset_generations order by id`,
    )
  ).rows;
}

it('the automatic daily code/image refresh preserves generation stamps, certificates and attempts', async () =>
  importerFixture(async (f) => {
    await f.run();
    const before = await saved(f),
      stamp = await stamps(f);
    f.config.code = 'c'.repeat(40);
    f.config.dev.image = 'sha256:' + 'd'.repeat(64);
    f.config.live = { ...f.config.dev };
    expect((await f.run()).result).toBe('unchanged');
    const after = await saved(f);
    expect(after.certificate).toEqual(before.certificate);
    expect(after.generation_id).toBe(before.generation_id);
    expect(after.attempts).toBe(before.attempts);
    expect(await stamps(f)).toEqual(stamp);
    expect(await latestCanary(f.resources.db, before.content_sha256)).toMatchObject({
      code: f.config.code,
      deployedCode: f.config.dev.image,
    });
    expect(
      (
        await f.owner.execute(
          sql`select count(*)::int n from import_attestations where kind='recertification'`,
        )
      ).rows[0]!.n,
    ).toBe(1);
  }));

it('re-certification refuses an external publication during the canary without overwriting that publication', async () =>
  importerFixture(async (f) => {
    await f.run();
    const before = (await control(f.resources.db)).accepted!,
      stamp = await stamps(f);
    await expect(
      f.run(
        {
          runCanary: async () => {
            await publishManifest(
              f.resources.db,
              before.manifest.generationId,
              before.manifest.casesIndex,
              before.manifest.passagesIndex,
            );
            return 'e'.repeat(64);
          },
        },
        { recertify: true },
      ),
    ).rejects.toMatchObject({ reason: 'baseline_changed' });
    const current = (await manifest(f.resources.db))!;
    expect(current.publishedAt).not.toBe(before.manifest.publishedAt);
    expect(current.generationId).toBe(before.manifest.generationId);
    expect(await stamps(f)).toEqual(stamp);
    expect((await saved(f)).rollback).toBeNull();
    expect((await f.run({}, { recertify: true })).result).toBe('unchanged');
    expect(await manifest(f.resources.db)).toEqual(current);
  }));

it.each(['probe', 'verify', 'canary'] as const)(
  'a failed %s recertification keeps the serving data and stamp; its next success clears only that warning',
  async (stage) =>
    importerFixture(async (f) => {
      await f.run();
      const before = await saved(f),
        stamp = await stamps(f),
        publication = await manifest(f.resources.db);
      const fail = async (): Promise<never> => {
        throw new ImportFailure('verification');
      };
      const effects =
        stage === 'probe'
          ? { probeCandidate: fail }
          : stage === 'verify'
            ? { verifyCorpus: fail }
            : { runCanary: fail };
      await expect(f.run(effects, { recertify: true })).rejects.toMatchObject({
        reason: 'verification',
      });
      expect(await manifest(f.resources.db)).toEqual(publication);
      expect(await stamps(f)).toEqual(stamp);
      expect((await saved(f)).attempts).toBe(before.attempts);
      expect((await readImportStatus(f.app, schedule)).status).toBe('fix');
      expect((await f.run({}, { recertify: true })).result).toBe('unchanged');
      expect((await readImportStatus(f.app, schedule)).alert).toBeNull();
      expect(await stamps(f)).toEqual(stamp);
      expect((await saved(f)).certificate).toEqual(before.certificate);
    }),
);

it('a newer publication clears a serving-data recertification warning', async () =>
  importerFixture(async (f) => {
    await f.run();
    await expect(
      f.run(
        {
          probeCandidate: async () => {
            throw new ImportFailure('probe');
          },
        },
        { recertify: true },
      ),
    ).rejects.toThrow();
    const next = await f.snapshot('newer-recert-fixture', (dir) =>
      editTable(dir, 'events', (rows) => {
        rows[0]!.lchg_date = '2026-10-31T01:00:00';
        return rows;
      }),
    );
    f.setRemote(next, { advertisedAtLocal: '2026-11-01T07:36:33', bytes: 12 });
    expect((await f.run()).result).toBe('published');
    expect((await readImportStatus(f.app, schedule)).alert).toBeNull();
  }));

it('recertification and lost acknowledgements add no publication history or monetary attempt', async () =>
  importerFixture(async (f) => {
    await f.run();
    const before = (
      await f.owner.execute(
        sql`select * from import_attestations where kind='publication' order by created_at`,
      )
    ).rows;
    const manifests = (
      await f.owner.execute(sql`select * from dataset_manifests order by generation_id`)
    ).rows;
    const a = await saved(f);
    for (const lost of [false, true]) {
      const result = await f.run(
        {
          fault: async (point) => {
            if (lost && point === 'accepted')
              throw Object.assign(new Error('lost acknowledgement'), {
                code: 'ECONNRESET',
              });
          },
        },
        { recertify: true },
      );
      expect(result).toMatchObject({ result: 'unchanged', reservationUsd: 0 });
      expect(
        (
          await f.owner.execute(
            sql`select * from import_attestations where kind='publication' order by created_at`,
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await f.owner.execute(
            sql`select * from dataset_manifests order by generation_id`,
          )
        ).rows,
      ).toEqual(manifests);
      expect((await saved(f)).attempts).toBe(a.attempts);
    }
  }));

it('an incorrect initial seed is recoverable with the corrected pinned seed', async () =>
  importerFixture(async (f) => {
    await f.owner.execute(sql`update import_control set accepted=null`);
    const path = join(f.config.root, 'seed.zip');
    await writeFile(path, 'original-public-fixture', { mode: 0o600 });
    await expect(
      f.run({}, { seed: { path, sha256: 'e'.repeat(64), observation: OLD_OBSERVATION } }),
    ).rejects.toMatchObject({ reason: 'integrity' });
    f.setRemote(f.original, OLD_OBSERVATION);
    expect(
      (
        await f.run(
          {},
          {
            seed: {
              path,
              sha256: f.original.archive,
              observation: OLD_OBSERVATION,
            },
          },
        )
      ).result,
    ).toBe('unchanged');
    expect((await readImportStatus(f.app, schedule)).alert).toBeNull();
  }));

it('a weekly refresh of identical bytes reports same_archive, with no new generation', async () =>
  importerFixture(async (f) => {
    await f.run();
    const before = await stamps(f);
    expect(
      await f.run({ now: () => new Date(Date.now() + 8 * 86_400_000) }),
    ).toMatchObject({ result: 'unchanged', reason: 'same_archive' });
    expect(await stamps(f)).toEqual(before);
    expect(f.acquire).toHaveBeenCalledTimes(2);
  }));

it('repeated forced-dev work reuses its generation and monetary identity without resetting the count', async () =>
  importerFixture(async (f) => {
    await f.run({}, { forcedDev: true });
    const before = await saved(f);
    expect((await f.run({}, { forcedDev: true })).result).toBe('published');
    const after = await saved(f);
    expect(after.id).toBe(before.id);
    expect(after.generation_id).toBe(before.generation_id);
    expect(after.attempts).toBe(before.attempts + 1);
    expect(
      (await f.owner.execute(sql`select count(*)::int n from reservations`)).rows[0]!.n,
    ).toBe(0);
  }));

it('cache misses defer and an actual planned import-cap failure suppresses the file without spending', async () =>
  importerFixture(async (f) => {
    const changed = await f.snapshot('cache-misses-fix1', (dir) =>
      editTable(dir, 'narratives', (rows) => {
        rows[0]!.narr_cause += ' A new synthetic sentence.';
        return rows;
      }),
    );
    f.setRemote(changed);
    for (let i = 0; i < 5; i++)
      await expect(f.run()).rejects.toMatchObject({
        reason: 'cache_miss',
        fix: false,
      });
    const before = await saved(f),
      paid = vi.fn();
    await expect(
      f.run(
        {
          paidEmbedder: paid,
          planPassages: (db, options) =>
            planPassages(db, {
              ...options,
              embedding: {
                ...options.embedding!,
                usdPerMillionTokens: 1_000_000,
              },
            }),
        },
        { cacheOnly: false },
      ),
    ).rejects.toMatchObject({ reason: 'import_cap', fix: true });
    const after = await saved(f);
    expect(after.id).toBe(before.id);
    expect(after.attempts).toBeGreaterThanOrEqual(before.attempts);
    expect((await f.run()).result).toBe('waiting');
    expect(paid).not.toHaveBeenCalled();
    expect(
      (await f.owner.execute(sql`select count(*)::int n from reservations`)).rows[0]!.n,
    ).toBe(0);
  }));

it('an 89-day candidate remains refused through a real run, while release recertification preserves its money', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'registered') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toThrow();
    const a = await saved(f);
    await withImportSession(f.resources.db, async (s) => {
      const r = await reserveSpend(f.resources.db, {
        import: { artifactId: a.id, fence: s.fence },
        category: 'indexing',
        usd: 0.01,
        request: { provider: 'offline', model: 'synthetic', stage: 'embed' },
        budgets: f.resources.appConfig.ai.budgets,
      });
      if (!r.ok) throw new Error('fixture reservation refused');
      await settleSpend(
        f.resources.db,
        { reservationId: r.reservationId },
        'uncertain',
        r.fencingToken,
      );
    });
    await f.owner.execute(
      sql`alter table import_artifacts disable trigger import_artifact_guard`,
    );
    try {
      await f.owner.execute(
        sql`update import_artifacts set first_reservation_at=clock_timestamp()-interval '2136 hours' where id=${a.id}::uuid`,
      );
    } finally {
      await f.owner.execute(
        sql`alter table import_artifacts enable trigger import_artifact_guard`,
      );
    }
    const money = (await f.owner.execute(sql`select * from reservations`)).rows;
    await expect(f.run()).rejects.toMatchObject({ reason: 'accounting' });
    const pending = (await control(f.resources.db)).pending;
    expect((await f.run({}, { recertify: true })).result).toBe('unchanged');
    expect((await control(f.resources.db)).pending).toEqual(pending);
    expect((await f.owner.execute(sql`select * from reservations`)).rows).toEqual(money);
    expect((await f.run()).result).toBe('waiting');
  }));

it('retainFiles keeps the candidate extraction under a fixed issue regardless of file age', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'loaded') throw new ImportFailure('probe');
        },
      }),
    ).rejects.toThrow();
    await utimes(f.candidate.dir, new Date(0), new Date(0));
    await retainFiles(
      f.resources.db,
      f.config,
      'dev',
      f.resources.space,
      f.resources.hostFacts,
    );
    expect((await stat(f.candidate.dir)).isDirectory()).toBe(true);
    expect((await f.run()).result).toBe('waiting');
  }));
