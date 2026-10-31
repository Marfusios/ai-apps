import { expect, it } from 'vitest';
import { stat, utimes } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import {
  importerFixture,
  OLD_OBSERVATION,
  NEW_OBSERVATION,
  EMBEDDING,
} from '../support/importer.js';
import {
  control,
  artifact,
  withImportSession,
  fenced,
  beginRun,
  registerArtifact,
} from '../../worker/importer/store.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { deleteUnusedIndices } from '../../worker/index/publications.js';
import { publishManifest } from '../../server/db/generations.js';
import { rebaselineWithResources } from '../../worker/importer/operations.js';
import { rollback } from '../../worker/importer/lifecycle.js';
import { digest } from '../../worker/importer/provenance.js';
import { editTable } from '../support/extract-dir.js';
import { setPending } from '../../worker/importer/durable.js';
import { checkCertificate, review } from '../../worker/importer/store.js';
import type { FaultPoint } from '../../worker/importer/runtime.js';
import { retainDatabase, retainFiles } from '../../worker/importer/retention.js';

const failOnce = (at: FaultPoint) => {
  let failed = false;
  return async (point: FaultPoint) => {
    if (point === at && !failed) {
      failed = true;
      throw new Error('PRIVATE_SENTINEL_INTERRUPTION');
    }
  };
};
const counts = async (fixture: Parameters<Parameters<typeof importerFixture>[0]>[0]) =>
  (
    await fixture.resources.db.execute(sql`select
  (select count(*)::int from dataset_generations) as generations,(select count(*)::int from reservations) as reservations,
  (select count(*)::int from import_artifacts) as artifacts`)
  ).rows[0];

it('persists a same-tuple replacement before registration and never calls it metadata-unchanged', async () =>
  importerFixture(async (fixture) => {
    fixture.setRemote(fixture.candidate, OLD_OBSERVATION);
    await expect(fixture.run({ fault: failOnce('fetched') })).rejects.toMatchObject({
      review: false,
      result: 'failed',
    });
    expect((await control(fixture.resources.db)).pending?.archive).toBe(
      fixture.candidate.archive,
    );
    expect((await control(fixture.resources.db)).lastRemoteFetchAt).not.toBeNull();
    await expect(fixture.run()).rejects.toMatchObject({
      reason: 'source_reissued',
      review: true,
    });
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
    const pending = (await control(fixture.resources.db)).pending!;
    expect(pending.needsReview).toBe(true);
    fixture.setRemote(fixture.original, NEW_OBSERVATION);
    await expect(fixture.run()).rejects.toMatchObject({ reason: 'source_reissued' });
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
    expect((await control(fixture.resources.db)).pendingObservation).toEqual(NEW_OBSERVATION);
    expect((await control(fixture.resources.db)).pending?.artifactId).toBe(pending.artifactId);
  }));

it.each(['registered', 'cases_built', 'published'] as const)(
  'resumes after %s with one artifact, generation and original accounting identity',
  async (point) =>
    importerFixture(async (fixture) => {
      await expect(fixture.run({ fault: failOnce(point) })).rejects.toMatchObject({
        review: false,
      });
      const pending = (await control(fixture.resources.db)).pending!;
      const before = await artifact(fixture.resources.db, pending.artifactId!);
      if (point === 'cases_built') {
        await fixture.owner.execute(
          sql`alter table index_builds disable trigger index_builds_guard`,
        );
        await fixture.owner.execute(
          sql`update index_builds set created_at=clock_timestamp()-interval '7 days'`,
        );
        await fixture.owner.execute(
          sql`alter table index_builds enable trigger index_builds_guard`,
        );
        const deletion = await deleteUnusedIndices(
          fixture.resources.es,
          fixture.resources.db,
          {
            olderThanHours: 48,
            yes: true,
          },
        );
        expect(deletion.deleted).toEqual([]);
        expect(deletion.refused.some((row) => row.reason.includes('import candidate'))).toBe(
          true,
        );
      }
      expect(await fixture.run()).toMatchObject({
        result: 'published',
        generationId: 2,
        reservationUsd: 0,
      });
      expect(fixture.acquire).toHaveBeenCalledTimes(1);
      expect(await counts(fixture)).toEqual({
        generations: 2,
        reservations: 0,
        artifacts: 1,
      });
      const after = await artifact(fixture.resources.db, before.id);
      expect(after.id).toBe(before.id);
      expect(after.attempts).toBeGreaterThanOrEqual(before.attempts);
      expect(fixture.canaryWait).toHaveBeenCalledWith(600_000);
    }),
);

it.each(['accepted', 'before_report'] as const)(
  'commits last success atomically before a %s failure',
  async (point) =>
    importerFixture(async (fixture) => {
      expect(await fixture.run({ fault: failOnce(point) })).toMatchObject({
        result: 'published',
        generationId: 2,
      });
      const status = await readImportStatus(fixture.app, null);
      expect(status.lastSuccessfulImport).toMatchObject({
        generationId: 2,
        result: 'published',
      });
      expect(status.attentionRequired).toBe(false);
      expect(await fixture.run()).toMatchObject({
        result: 'unchanged',
        generationId: 2,
      });
      expect(await counts(fixture)).toEqual({
        generations: 2,
        reservations: 0,
        artifacts: 1,
      });
    }),
);

it('requires a baseline review after a greater-than-62-day advertisement gap', async () =>
  importerFixture(async (fixture) => {
    fixture.setRemote(fixture.candidate, {
      ...NEW_OBSERVATION,
      advertisedAtLocal: '2026-12-03T07:36:33',
    });
    await expect(fixture.run()).rejects.toMatchObject({ reason: 'baseline_required' });
    expect((await control(fixture.resources.db)).pending?.needsReview).toBe(true);
    expect(await counts(fixture)).toEqual({
      generations: 1,
      reservations: 0,
      artifacts: 1,
    });
  }));

it('does not acquire or latch when the separately running app is unavailable; recovery proceeds', async () =>
  importerFixture(async (fixture) => {
    await expect(
      fixture.run({
        applicationAvailable: async () => {
          throw new ImportFailure('source_unavailable', false);
        },
      }),
    ).rejects.toMatchObject({ review: false });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect((await readImportStatus(fixture.app, null)).attentionRequired).toBe(false);
    expect(await fixture.run()).toMatchObject({ result: 'published' });
  }));

it('daily code/image upgrade re-certifies the current pair without resetting certificates, generations or attempts', async () =>
  importerFixture(async (fixture) => {
    await fixture.run();
    const before = (await fixture.resources.db.execute(sql`select * from import_artifacts`))
      .rows[0]!;
    await fixture.owner.execute(
      sql`update dataset_generations set verifier_version='previous-verifier' where id=2`,
    );
    const stamp = (
      await fixture.resources.db.execute(
        sql`select verifier_version,verification_report_sha256,verified_at::text from dataset_generations where id=2`,
      )
    ).rows[0];
    fixture.config.code = 'c'.repeat(40);
    fixture.config.dev.image = 'sha256:' + 'd'.repeat(64);
    fixture.config.live = { ...fixture.config.dev };
    expect(await fixture.run()).toMatchObject({
      result: 'unchanged',
      generationId: 2,
      cacheMisses: 0,
    });
    expect(
      (
        await fixture.resources.db.execute(
          sql`select verifier_version,verification_report_sha256,verified_at::text from dataset_generations where id=2`,
        )
      ).rows[0],
    ).toEqual(stamp);
    const after = await artifact(fixture.resources.db, String(before.id));
    expect(after.certificate).toEqual(before.certificate);
    expect(after.attempts).toBe(before.attempts);
    expect(after.canary).toMatchObject({
      code: fixture.config.code,
      deployedCode: fixture.config.dev.image,
    });
    expect(await counts(fixture)).toEqual({
      generations: 2,
      reservations: 0,
      artifacts: 1,
    });
    expect(
      (
        await fixture.resources.db.execute(
          sql`select count(*)::int as n from import_attestations where kind='recertification'`,
        )
      ).rows[0]?.n,
    ).toBe(1);
  }));

it('re-certification refuses publication changes during the full canary and existing integrity reviews', async () =>
  importerFixture(async (fixture) => {
    await fixture.run();
    const state = (await control(fixture.resources.db)).accepted!;
    await expect(
      fixture.run(
        {
          runCanary: async () => {
            await publishManifest(
              fixture.resources.db,
              state.manifest.generationId,
              state.manifest.casesIndex,
              state.manifest.passagesIndex,
            );
            return 'e'.repeat(64);
          },
        },
        { recertify: true },
      ),
    ).rejects.toMatchObject({ reason: 'baseline_changed' });
    expect((await readImportStatus(fixture.app, null)).attentionRequired).toBe(true);
    await expect(fixture.run({}, { recertify: true })).rejects.toMatchObject({
      review: true,
    });
    expect(await counts(fixture)).toEqual({
      generations: 2,
      reservations: 0,
      artifacts: 1,
    });
  }));

it.each(['rollback', 'manual'] as const)(
  'rebaseline recovers after a %s publication, with dry-run default and immutable history',
  async (kind) =>
    importerFixture(async (fixture) => {
      await fixture.run();
      const state = (await control(fixture.resources.db)).accepted!;
      const saved = (await fixture.resources.db.execute(sql`select * from import_artifacts`))
        .rows[0]!;
      await withImportSession(fixture.resources.db, async (session) => {
        const publication =
          kind === 'rollback'
            ? await rollback(
                fixture.resources.db,
                fixture.resources.es,
                session,
                String(saved.id),
                state.manifest,
                EMBEDDING,
              )
            : await publishManifest(
                fixture.resources.db,
                state.manifest.generationId,
                state.manifest.casesIndex,
                state.manifest.passagesIndex,
              )
                .then(async () =>
                  (await import('../../worker/importer/store.js')).manifest(
                    fixture.resources.db,
                  ),
                )
                .then((value) => value!);
        const args = [
          fixture.config,
          'dev',
          fixture.resources,
          session,
          digest(publication),
        ] as const;
        expect(await rebaselineWithResources(...args, false, fixture.effects)).toMatchObject({
          applied: false,
        });
        expect((await control(fixture.resources.db)).accepted).toEqual(state);
        expect(await rebaselineWithResources(...args, true, fixture.effects)).toMatchObject({
          applied: true,
        });
        expect((await control(fixture.resources.db)).accepted?.manifest).toEqual(publication);
        const after = await artifact(fixture.resources.db, String(saved.id));
        expect(after.attempts).toBe(saved.attempts);
        expect(after.certificate).toEqual(saved.certificate);
      });
      fixture.setRemote(
        kind === 'rollback' ? fixture.original : fixture.candidate,
        kind === 'rollback' ? OLD_OBSERVATION : NEW_OBSERVATION,
      );
      expect(await fixture.run({}, { noChange: true })).toMatchObject({
        result: 'unchanged',
      });
    }),
);

it('maps a repackaged unresolved live fetch back to the original artifact, cap and retry history', async () =>
  importerFixture(async (fixture) => {
    const repackaged = await fixture.snapshot('repackaged-candidate', (dir) =>
      editTable(dir, 'events', (rows) => {
        rows[0]!.lchg_date = '2026-10-30T00:00:00';
        return rows;
      }),
    );
    expect(repackaged.facts.digest).toBe(fixture.candidate.facts.digest);
    fixture.config.live = { ...fixture.config.dev };
    const devPublication = { ...fixture.baseline.manifest, generationId: 42 };
    fixture.resources.hostFacts.canary = async () => ({
      current: devPublication,
      observedImage: fixture.config.dev.image,
      canary: {
        publication: devPublication,
        archive: fixture.candidate.archive,
        content: fixture.candidate.facts.digest,
        code: fixture.config.code,
        deployedCode: fixture.config.dev.image,
        checkedAt: new Date(Date.now() - 1000).toISOString(),
        probes: 'f'.repeat(64),
      },
    });
    let originalId = '';
    await withImportSession(fixture.resources.db, async (session) => {
      const saved = await registerArtifact(
        fixture.resources.db,
        session,
        'live',
        fixture.candidate.archive,
        fixture.candidate.facts.digest,
        fixture.baseline.manifest,
      );
      originalId = saved.id;
      await fenced(fixture.resources.db, session, (tx) =>
        tx.execute(sql`update import_artifacts set attempts=1 where id=${saved.id}::uuid`),
      );
      const run = await beginRun(fixture.resources.db, session, 'automatic');
      await setPending(
        fixture.resources.db,
        session,
        {
          archive: repackaged.archive,
          content: null,
          artifactId: null,
          fetchedAt: new Date().toISOString(),
          runId: run,
          observation: NEW_OBSERVATION,
          attempts: 0,
          needsReview: false,
          reason: null,
        },
        true,
      );
    });
    fixture.setRemote(repackaged);
    expect(await fixture.run({}, { environment: 'live' })).toMatchObject({
      result: 'published',
      archive: fixture.candidate.archive,
    });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(await counts(fixture)).toEqual({
      generations: 2,
      reservations: 0,
      artifacts: 1,
    });
    expect(await artifact(fixture.resources.db, originalId)).toMatchObject({
      attempts: 2,
      archive_sha256: fixture.candidate.archive,
    });
    expect((await control(fixture.resources.db)).lastFetched).toMatchObject({
      archive: repackaged.archive,
      state: 'accepted',
    });
  }));

it('bounds pre-registration failures and clears every linked attempt only through an audited rebaseline', async () =>
  importerFixture(async (fixture) => {
    const extract = async () => {
      throw new Error('PRIVATE_SENTINEL_TRANSIENT');
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(fixture.run({ extractSnapshot: extract })).rejects.toMatchObject({
        review: false,
        result: 'failed',
      });
    }
    expect((await control(fixture.resources.db)).pending?.attempts).toBe(4);
    await expect(fixture.run()).rejects.toMatchObject({
      review: true,
      reason: 'interrupted',
    });
    const pending = (await control(fixture.resources.db)).pending!;
    expect((await readImportStatus(fixture.app, null)).attentionRequired).toBe(true);
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
    await withImportSession(fixture.resources.db, (session) =>
      rebaselineWithResources(
        fixture.config,
        'dev',
        fixture.resources,
        session,
        digest(fixture.baseline.manifest),
        true,
        fixture.effects,
      ),
    );
    const state = await control(fixture.resources.db);
    expect(state.pending).toBeNull();
    expect(state.lastFetched).toMatchObject({
      archive: fixture.candidate.archive,
      state: 'reviewed_abandoned',
    });
    expect((await readImportStatus(fixture.app, null)).attentionRequired).toBe(false);
    expect(
      (
        await fixture.resources.db.execute(sql`select count(*)::int as n from import_runs
    where pending_run_id=${pending.runId}::uuid and result in ('failed','needs_review')`)
      ).rows[0]?.n,
    ).toBe(5);
    fixture.setRemote(fixture.original, OLD_OBSERVATION);
    expect(await fixture.run({}, { noChange: true })).toMatchObject({
      result: 'unchanged',
      generationId: 1,
    });
  }));

it('defers live admission until the same dev publication is ready and refuses a live certificate without dev proof', async () =>
  importerFixture(async (fixture) => {
    fixture.config.live = { ...fixture.config.dev };
    fixture.resources.hostFacts.canary = async () => ({
      canary: null,
      current: fixture.baseline.manifest,
      observedImage: fixture.config.dev.image,
    });
    await expect(fixture.run({}, { environment: 'live' })).rejects.toMatchObject({
      review: false,
      reason: 'dev_failed',
    });
    const pending = (await control(fixture.resources.db)).pending!;
    expect((await artifact(fixture.resources.db, pending.artifactId!)).needs_review).toBe(
      false,
    );
    fixture.resources.hostFacts.canary = async () => ({
      current: fixture.baseline.manifest,
      observedImage: fixture.config.dev.image,
      canary: {
        publication: fixture.baseline.manifest,
        archive: fixture.candidate.archive,
        content: fixture.candidate.facts.digest,
        code: fixture.config.code,
        deployedCode: fixture.config.dev.image,
        checkedAt: new Date(Date.now() - 1000).toISOString(),
        probes: 'f'.repeat(64),
      },
    });
    await expect(
      fixture.run({ fault: failOnce('published') }, { environment: 'live' }),
    ).rejects.toMatchObject({ review: false });
    const saved = await artifact(fixture.resources.db, pending.artifactId!);
    await withImportSession(fixture.resources.db, (session) =>
      fenced(fixture.resources.db, session, (tx) =>
        expect(
          checkCertificate(tx, session, { ...saved.certificate!, dev: null }),
        ).rejects.toMatchObject({ reason: 'dev_failed' }),
      ),
    );
    expect(await fixture.run({}, { environment: 'live' })).toMatchObject({
      result: 'published',
    });
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
  }));

it.each(['integrity', 'accounting'] as const)(
  'refuses free recertification under an existing %s review',
  async (reason) =>
    importerFixture(async (fixture) => {
      await fixture.run();
      const saved = (await fixture.resources.db.execute(sql`select id from import_artifacts`))
        .rows[0]!;
      await withImportSession(fixture.resources.db, (session) =>
        review(fixture.resources.db, session, String(saved.id), reason),
      );
      await expect(fixture.run({}, { recertify: true })).rejects.toMatchObject({
        review: true,
        reason,
      });
      expect(await counts(fixture)).toEqual({
        generations: 2,
        reservations: 0,
        artifacts: 1,
      });
    }),
);

it('protects a latched candidate without an age limit and releases it only after audited resolution and grace', async () =>
  importerFixture(async (fixture) => {
    await expect(fixture.run({ fault: failOnce('cases_built') })).rejects.toThrow();
    const pending = (await control(fixture.resources.db)).pending!;
    const saved = await artifact(fixture.resources.db, pending.artifactId!);
    const old = new Date(Date.now() - 7 * 86_400_000);
    await utimes(fixture.candidate.dir, old, old);
    await withImportSession(fixture.resources.db, async (session) => {
      await review(fixture.resources.db, session, saved.id, 'probe');
      await setPending(fixture.resources.db, session, {
        ...pending,
        needsReview: true,
        reason: 'probe',
      });
      await retainDatabase(fixture.resources.db, fixture.resources.es, session);
      await retainFiles(
        fixture.resources.db,
        fixture.config,
        'dev',
        fixture.resources.space,
        fixture.resources.hostFacts,
      );
      expect((await stat(fixture.candidate.dir)).isDirectory()).toBe(true);
      expect(
        (
          await fixture.resources.db
            .execute(sql`select count(*)::int as n from import_index_refs
      where artifact_id=${saved.id}::uuid and released_at is null`)
        ).rows[0]?.n,
      ).toBeGreaterThan(0);
      await rebaselineWithResources(
        fixture.config,
        'dev',
        fixture.resources,
        session,
        digest(fixture.baseline.manifest),
        true,
        fixture.effects,
      );
      expect((await artifact(fixture.resources.db, saved.id)).needs_review).toBe(true);
      await fixture.owner.execute(
        sql`alter table import_artifacts disable trigger import_artifact_guard`,
      );
      await fixture.owner.execute(
        sql`update import_artifacts set resolved_at=clock_timestamp()-interval '49 hours' where id=${saved.id}::uuid`,
      );
      await fixture.owner.execute(
        sql`alter table import_artifacts enable trigger import_artifact_guard`,
      );
      await retainDatabase(fixture.resources.db, fixture.resources.es, session);
      await retainFiles(
        fixture.resources.db,
        fixture.config,
        'dev',
        fixture.resources.space,
        fixture.resources.hostFacts,
      );
      expect(
        (
          await fixture.resources.db
            .execute(sql`select count(*)::int as n from import_index_refs
      where artifact_id=${saved.id}::uuid and released_at is null`)
        ).rows[0]?.n,
      ).toBe(0);
      await expect(stat(fixture.candidate.dir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await artifact(fixture.resources.db, saved.id)).attempts).toBe(saved.attempts);
    });
  }));

it.each(['accounting', 'unknown_alias', 'spool', 'publication_changed'] as const)(
  'rebaseline refuses %s without clearing a review or adopting a new pair',
  async (condition) =>
    importerFixture(async (fixture) => {
      await expect(fixture.run({ fault: failOnce('registered') })).rejects.toThrow();
      const before = (await control(fixture.resources.db)).accepted;
      const pending = (await control(fixture.resources.db)).pending!;
      await withImportSession(fixture.resources.db, async (session) => {
        await review(
          fixture.resources.db,
          session,
          pending.artifactId!,
          condition === 'accounting' ? 'accounting' : 'probe',
        );
        if (condition === 'unknown_alias')
          await fixture.resources.db
            .execute(sql`insert into index_switch_attempts(alias,index_name)
        values('synthetic-unknown','synthetic-unknown-index')`);
        if (condition === 'spool')
          await fixture.resources.space.json(
            `${fixture.resources.space.root}/status-dev.json`,
            {
              reason: 'integrity',
            },
          );
        const effects =
          condition === 'publication_changed'
            ? {
                ...fixture.effects,
                probeCandidate: async (
                  ...args: Parameters<NonNullable<typeof fixture.effects.probeCandidate>>
                ) => {
                  const { probeCandidate } = await import('../../worker/importer/probes.js');
                  const result = await probeCandidate(...args);
                  await publishManifest(
                    fixture.resources.db,
                    fixture.baseline.manifest.generationId,
                    fixture.baseline.manifest.casesIndex,
                    fixture.baseline.manifest.passagesIndex,
                  );
                  return result;
                },
              }
            : fixture.effects;
        await expect(
          rebaselineWithResources(
            fixture.config,
            'dev',
            fixture.resources,
            session,
            digest(fixture.baseline.manifest),
            true,
            effects,
          ),
        ).rejects.toThrow();
        expect((await control(fixture.resources.db)).accepted).toEqual(before);
        expect(
          (await artifact(fixture.resources.db, pending.artifactId!)).resolved_at,
        ).toBeNull();
      });
    }),
);
