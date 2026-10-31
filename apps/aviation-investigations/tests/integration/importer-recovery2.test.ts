/** Operability regressions through the real orchestrator and guarded PostgreSQL transitions. */
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  importerFixture,
  OLD_OBSERVATION,
  NEW_OBSERVATION,
  EMBEDDING,
  type ImportFixture,
} from '../support/importer.js';
import { editTable } from '../support/extract-dir.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';
import { planPassages } from '../../worker/index/passages-index.js';
import { publishManifest, VERIFIER_VERSION } from '../../server/db/generations.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { classify } from '../../worker/importer/failure.js';
import { privateJson } from '../../worker/importer/extraction.js';
import { AvallSource, parseListing } from '../../worker/importer/source.js';
import { spoolFailure } from '../../worker/importer/recovery.js';
import { digest } from '../../worker/importer/provenance.js';
import { rollback } from '../../worker/importer/lifecycle.js';
import { rebaselineWithResources } from '../../worker/importer/operations.js';
import { operatorWithResources } from '../../worker/importer/commands.js';
import { recordRebaseline } from '../../worker/importer/durable.js';
import {
  artifact,
  control,
  fenced,
  manifest,
  latestCanary,
  withImportSession,
  unresolvedPreartifactReviews,
  beginRun,
  updateRun,
  startAttempt,
} from '../../worker/importer/store.js';
import type { Comparison } from '../../worker/importer/compare.js';

async function rebaseline(f: ImportFixture, apply = true) {
  return withImportSession(f.resources.db, async (session) =>
    rebaselineWithResources(
      f.config,
      'dev',
      f.resources,
      session,
      digest((await manifest(f.resources.db))!),
      apply,
      f.effects,
    ),
  );
}
async function savedArtifact(f: ImportFixture) {
  const row = (
    await f.resources.db.execute(
      sql`select id from import_artifacts order by created_at desc limit 1`,
    )
  ).rows[0];
  return artifact(f.resources.db, String(row!.id));
}
async function verificationStamp(f: ImportFixture) {
  return (
    await f.resources.db
      .execute(sql`select verification_status,verifier_version,verification_report_sha256,verified_at::text
    from dataset_generations where id=(select generation_id from dataset_manifests where active)`)
  ).rows[0];
}

it('rollback abandonment survives the same advertisement indefinitely and repackaged resolved content', async () =>
  importerFixture(async (f) => {
    await f.run();
    const saved = await savedArtifact(f);
    await withImportSession(f.resources.db, (session) =>
      rollback(
        f.resources.db,
        f.resources.es,
        session,
        saved.id,
        saved.publication!,
        EMBEDDING,
      ),
    );
    await rebaseline(f);
    f.acquire.mockClear();
    expect(await f.run({ now: () => new Date('2027-01-01T00:00:00Z') })).toMatchObject({
      result: 'unchanged',
      generationId: 1,
    });
    expect(f.acquire).not.toHaveBeenCalled();
    expect((await readImportStatus(f.app, null)).attentionRequired).toBe(false);
    f.setRemote(f.candidate, { ...NEW_OBSERVATION, bytes: 12 });
    expect(await f.run()).toMatchObject({ result: 'unchanged', reason: 'same_archive' });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(await f.run()).toMatchObject({ result: 'unchanged' });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    const repackaged = await f.snapshot('resolved-repackage', (dir) =>
      editTable(dir, 'events', (rows) => {
        rows[0]!.lchg_date = '2026-10-30T00:00:00';
        return rows;
      }),
    );
    f.setRemote(repackaged, { ...NEW_OBSERVATION, bytes: 13 });
    expect(await f.run()).toMatchObject({ result: 'unchanged', reason: 'same_content' });
    expect((await savedArtifact(f)).attempts).toBe(saved.attempts);
    expect((await control(f.resources.db)).pending).toBeNull();
    expect((await readImportStatus(f.app, null)).attentionRequired).toBe(false);
  }));

it('an abandoned pre-registration fetch gets no fresh four-attempt allowance', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        extractSnapshot: async () => {
          throw new ImportFailure('schema');
        },
      }),
    ).rejects.toMatchObject({ reason: 'schema' });
    const pending = (await control(f.resources.db)).pending!;
    await rebaseline(f);
    expect(await f.run()).toMatchObject({ result: 'unchanged' });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    f.setRemote(f.candidate, { ...NEW_OBSERVATION, bytes: 12 });
    expect(await f.run()).toMatchObject({ result: 'unchanged' });
    expect((await control(f.resources.db)).pending).toBeNull();
    const audit = (
      await f.resources.db.execute(
        sql`select accepted from import_attestations where kind='rebaseline'`,
      )
    ).rows[0]?.accepted;
    expect(audit).toMatchObject({
      abandonedFetch: { archive: pending.archive, attempts: 1 },
    });
    expect(
      (await f.resources.db.execute(sql`select count(*)::int n from import_artifacts`)).rows[0]
        ?.n,
    ).toBe(0);
  }));

it.each(['manual', 'verifier', 'listing', 'utf8', 'restore'] as const)(
  'resolves the exact %s pre-download review after correcting its cause',
  async (kind) =>
    importerFixture(async (f) => {
      await f.run();
      let reason = 'baseline_changed';
      if (kind === 'manual') {
        const current = (await manifest(f.resources.db))!;
        await publishManifest(
          f.resources.db,
          current.generationId,
          current.casesIndex,
          current.passagesIndex,
        );
      } else if (kind === 'verifier') {
        reason = 'baseline_required';
        // A prior worker's preflight rejected a stamp from an older verifier; recovery runs the current real verifier.
        await f.owner.execute(
          sql`update dataset_generations set verifier_version='older-verifier' where id=2`,
        );
        await expect(
          f.run({
            verifyBaseline: async () => {
              throw new ImportFailure('baseline_required');
            },
          }),
        ).rejects.toMatchObject({ reason });
      } else if (kind === 'listing') {
        reason = 'source_listing_changed';
        f.inspect.mockImplementationOnce(async () =>
          parseListing('<html>changed upstream format</html>'),
        );
      } else if (kind === 'utf8') {
        reason = 'integrity';
        f.inspect.mockImplementationOnce(() =>
          new AvallSource({
            fetch: async () => new Response(new Uint8Array([0xff, 0xfe])),
            now: () => new Date('2026-10-31T00:00:00Z'),
            sleep: async () => {},
          }).inspect(),
        );
      } else {
        reason = 'restore_hold';
        // Restore hold itself must be reconciled before a fence exists; this is its preserved outage evidence.
        await spoolFailure(
          f.resources.space,
          'dev',
          new ImportFailure('restore_hold'),
          'check',
        );
      }
      if (kind !== 'verifier') await expect(f.run()).rejects.toMatchObject({ reason });
      await expect(f.run()).rejects.toMatchObject({ reason });
      const original = await unresolvedPreartifactReviews(f.resources.db);
      expect(original).toHaveLength(1);
      const preview = await rebaseline(f, false);
      expect(preview.resolvedReviews).toEqual(
        original.map(({ id, fingerprint }) => ({ id, fingerprint })),
      );
      expect(await unresolvedPreartifactReviews(f.resources.db)).toEqual(original);
      await rebaseline(f);
      expect(await unresolvedPreartifactReviews(f.resources.db)).toEqual([]);
      expect((await readImportStatus(f.app, null)).attentionRequired).toBe(false);
      expect(await f.run()).toMatchObject({ result: 'unchanged' });
      expect((await verificationStamp(f))?.verifier_version).toBe(VERIFIER_VERSION);
    }),
);

it('a wrong initial seed is recoverable using the corrected pinned seed', async () =>
  importerFixture(async (f) => {
    await f.owner.execute(sql`update import_control set accepted=null where id=1`);
    const seed = join(f.config.root, 'seed.zip');
    await writeFile(seed, 'original-public-fixture', { mode: 0o600 });
    await expect(
      f.run(
        {},
        { seed: { path: seed, sha256: 'e'.repeat(64), observation: OLD_OBSERVATION } },
      ),
    ).rejects.toMatchObject({ reason: 'integrity' });
    await withImportSession(f.resources.db, (session) =>
      rebaselineWithResources(
        f.config,
        'dev',
        f.resources,
        session,
        digest(f.baseline.manifest),
        true,
        f.effects,
        { path: seed, sha256: f.original.archive, observation: OLD_OBSERVATION },
      ),
    );
    f.setRemote(f.original, OLD_OBSERVATION);
    expect(await f.run()).toMatchObject({ result: 'unchanged' });
  }));

it.each(['probe', 'verify', 'canary'] as const)(
  'failed %s re-certification preserves serving data/stamp and recovers its proof',
  async (failure) =>
    importerFixture(async (f) => {
      await f.run();
      const before = await savedArtifact(f);
      const stamp = await verificationStamp(f);
      const status = await readImportStatus(f.app, null);
      const fail = async (): Promise<never> => {
        throw new ImportFailure('verification');
      };
      const overrides =
        failure === 'probe'
          ? { probeCandidate: fail }
          : failure === 'verify'
            ? { verifyCorpus: fail }
            : { runCanary: fail };
      await expect(f.run(overrides, { recertify: true })).rejects.toMatchObject({
        review: false,
        result: 'deferred',
      });
      expect((await savedArtifact(f)).needs_review).toBe(false);
      expect(await verificationStamp(f)).toEqual(stamp);
      expect(await latestCanary(f.resources.db, before.content_sha256)).toBeNull();
      expect(await f.run({}, { recertify: true })).toMatchObject({
        result: 'unchanged',
        reservationUsd: 0,
      });
      expect(await verificationStamp(f)).toEqual(stamp);
      expect((await savedArtifact(f)).attempts).toBe(before.attempts);
      expect(await latestCanary(f.resources.db, before.content_sha256)).not.toBeNull();
      const after = await readImportStatus(f.app, null);
      expect(after.lastSuccessfulImport).toEqual(status.lastSuccessfulImport);
      expect(after.recentRuns.filter((r) => r.result === 'published')).toEqual(
        status.recentRuns,
      );
      expect(after.attentionRequired).toBe(false);
      const row = (
        await f.resources.db.execute(
          sql`select r.result,r.canary_passed,t.kind from import_runs r join import_attestations t on t.run_id=r.id order by t.created_at desc limit 1`,
        )
      ).rows[0];
      expect(row).toEqual({
        result: 'unchanged',
        canary_passed: false,
        kind: 'recertification',
      });
    }),
);

it('publishing a newer snapshot clears a failed recertification warning for the previous snapshot', async () =>
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
    ).rejects.toMatchObject({ result: 'deferred' });
    expect((await readImportStatus(f.app, null)).attentionRequired).toBe(true);
    const newer = await f.snapshot('newer-public-fixture', (dir) =>
      editTable(dir, 'events', (rows) => {
        rows[0]!.lchg_date = '2026-10-31T01:00:00';
        return rows;
      }),
    );
    f.setRemote(newer, { advertisedAtLocal: '2026-11-01T07:36:33', bytes: 12 });
    expect(await f.run()).toMatchObject({ result: 'published', generationId: 3 });
    const status = await readImportStatus(f.app, null);
    expect(status.attentionRequired).toBe(false);
    expect(status.lastSuccessfulImport?.generationId).toBe(3);
  }));

it('a repeated forced-dev refuses before pending registration and does not latch the serving artifact', async () =>
  importerFixture(async (f) => {
    await f.run({}, { forcedDev: true });
    const saved = await savedArtifact(f);
    await expect(f.run({}, { forcedDev: true })).rejects.toMatchObject({
      reason: 'configuration',
      review: false,
    });
    expect((await control(f.resources.db)).pending).toBeNull();
    expect(await savedArtifact(f)).toEqual(saved);
    expect((await readImportStatus(f.app, null)).attentionRequired).toBe(false);
  }));

it.each(['application', 'source', 'dev', 'canary', 'dirty'] as const)(
  'five %s deferrals do not consume attempts',
  async (condition) =>
    importerFixture(async (f) => {
      const fail = async (): Promise<never> => {
        throw new ImportFailure('source_unavailable', false);
      };
      if (condition === 'dev') {
        f.config.live = { ...f.config.dev };
        f.resources.hostFacts.canary = async () => ({
          canary: null,
          current: f.baseline.manifest,
          observedImage: f.config.dev.image,
        });
      }
      if (condition === 'source') f.inspect.mockImplementation(fail);
      for (let day = 0; day < 5; day++) {
        const override =
          condition === 'application'
            ? { applicationAvailable: fail }
            : condition === 'canary'
              ? { runCanary: fail }
              : condition === 'dirty'
                ? {
                    workerIdentity: async () => {
                      throw new ImportFailure('configuration', false);
                    },
                  }
                : {};
        await expect(
          f.run(override, { environment: condition === 'dev' ? 'live' : 'dev' }),
        ).rejects.toMatchObject({ review: false, result: 'deferred' });
        const pending = (await control(f.resources.db)).pending;
        if (pending?.artifactId)
          expect((await artifact(f.resources.db, pending.artifactId)).attempts).toBe(0);
      }
      if (condition === 'source') f.inspect.mockImplementation(async () => NEW_OBSERVATION);
      if (condition === 'dev') {
        expect((await readImportStatus(f.app, null)).attentionRequired).toBe(true);
        // Dev has moved past this candidate: the pending candidate can instead be explicitly abandoned.
        await rebaseline(f);
        expect((await control(f.resources.db)).pending).toBeNull();
        expect((await savedArtifact(f)).resolved_at).not.toBeNull();
        expect((await readImportStatus(f.app, null)).attentionRequired).toBe(false);
      } else {
        expect(await f.run()).toMatchObject({ result: 'published' });
        expect((await savedArtifact(f)).attempts).toBe(1);
      }
    }),
);

it('cache-only misses defer and a real cap latch can be abandoned without resetting money or attempts', async () =>
  importerFixture(async (f) => {
    const changed = await f.snapshot('cache-misses', (dir) =>
      editTable(dir, 'narratives', (rows) => {
        rows[0]!.narr_cause += ' A new synthetic sentence.';
        return rows;
      }),
    );
    f.setRemote(changed);
    for (let day = 0; day < 5; day++)
      await expect(f.run()).rejects.toMatchObject({
        reason: 'cache_miss',
        review: false,
      });
    expect((await savedArtifact(f)).attempts).toBe(0);
    await expect(
      f.run(
        {
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
    ).rejects.toMatchObject({ reason: 'import_cap' });
    const before = await savedArtifact(f);
    await rebaseline(f);
    const after = await savedArtifact(f);
    expect(after.resolved_at).not.toBeNull();
    expect(after.attempts).toBe(before.attempts);
    expect(after.needs_review).toBe(true);
    expect(
      (await f.resources.db.execute(sql`select count(*)::int n from reservations`)).rows[0]?.n,
    ).toBe(0);
    expect(await f.run()).toMatchObject({ result: 'unchanged' });
  }));

it('abandonment permits an 89-day-old candidate and preserves its conservative charged reservation', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'registered') throw new Error('stopped');
        },
      }),
    ).rejects.toThrow();
    const saved = await savedArtifact(f);
    const { reserveSpend, settleSpend } = await import('../../server/quota/spend.js');
    await withImportSession(f.resources.db, async (session) => {
      const r = await reserveSpend(f.resources.db, {
        import: { artifactId: saved.id, fence: session.fence },
        category: 'indexing',
        usd: 0.01,
        request: { provider: 'offline', model: 'synthetic', stage: 'embed' },
        budgets: f.resources.appConfig.ai.budgets,
      });
      if (!r.ok) throw new Error('scratch reservation refused');
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
    await f.owner.execute(
      sql`update import_artifacts set first_reservation_at=clock_timestamp()-interval '2136 hours' where id=${saved.id}::uuid`,
    );
    await f.owner.execute(
      sql`alter table import_artifacts enable trigger import_artifact_guard`,
    );
    await expect(f.run()).rejects.toMatchObject({ reason: 'accounting' });
    const money = (await f.resources.db.execute(sql`select * from reservations`)).rows;
    await rebaseline(f);
    expect((await savedArtifact(f)).resolved_at).not.toBeNull();
    expect((await f.resources.db.execute(sql`select * from reservations`)).rows).toEqual(
      money,
    );
  }));

it('approve binds withdrawal proof, clears only its pending review and resumes the real import', async () =>
  importerFixture(async (f) => {
    const withdrawn = await f.snapshot('synthetic-withdrawal', (dir) => {
      let evId = '';
      editTable(dir, 'events', (rows) => {
        evId = rows.find((row) => row.ntsb_no === 'CEN09CA566')!.ev_id!;
        return rows;
      });
      for (const table of TABLE_NAMES)
        editTable(dir, table, (rows) => rows.filter((r) => r.ev_id !== evId));
    });
    f.setRemote(withdrawn);
    await expect(f.run()).rejects.toMatchObject({ reason: 'cohort_bounds' });
    const saved = await savedArtifact(f);
    const comparison = (await privateJson(
      join(f.config.root, 'reports', 'dev', `${saved.id}-comparison.json`),
    )) as Comparison;
    const proof = {
      archive: saved.archive_sha256,
      environment: 'dev',
      baseline: saved.baseline,
      policy: 'snapshot-monthly.v1',
      code: f.config.code,
      report: comparison.hash,
      reasons: comparison.failures,
      cases: comparison.cases,
    };
    const path = join(f.config.root, 'approval.json');
    await f.resources.space.json(path, { ...proof, cases: [] });
    await expect(
      operatorWithResources(
        f.config,
        'dev',
        'approve',
        saved.archive_sha256,
        { approval: path },
        f.resources,
      ),
    ).rejects.toThrow();
    expect((await control(f.resources.db)).pending?.needsReview).toBe(true);
    await f.resources.space.json(path, proof);
    await operatorWithResources(
      f.config,
      'dev',
      'approve',
      saved.archive_sha256,
      { approval: path },
      f.resources,
    );
    expect((await control(f.resources.db)).pending?.needsReview).toBe(false);
    expect(await f.run()).toMatchObject({ result: 'published' });
  }));

it('weekly identical bytes report same_archive and stale SQLSTATE 55000 is integrity, never accounting', async () =>
  importerFixture(async (f) => {
    await f.run();
    const report = await f.run({ now: () => new Date(Date.now() + 8 * 86_400_000) });
    expect(report).toMatchObject({ result: 'unchanged', reason: 'same_archive' });
    expect(classify({ code: '55000' })).toMatchObject({ reason: 'integrity' });
    expect(classify({ code: 'P2604' })).toMatchObject({ reason: 'accounting' });
    expect(classify({ code: 'P2605' })).toMatchObject({
      reason: 'alias_unknown',
      review: false,
    });
  }));

it('database pending guards validate reason/time and ingest cannot forge a rebaseline resolution', async () =>
  importerFixture(async (f) => {
    await withImportSession(f.resources.db, async (session) => {
      const runId = await beginRun(f.resources.db, session, 'automatic');
      const pending = {
        archive: f.candidate.archive,
        observation: NEW_OBSERVATION,
        fetchedAt: new Date().toISOString(),
        runId,
        artifactId: null,
        content: null,
        attempts: 0,
        needsReview: false,
        reason: null,
      };
      for (const change of [
        { reason: 'arbitrary' },
        { fetchedAt: 'yesterday' },
        { fetchedAt: '2026-13-01T00:00:00Z' },
      ]) {
        await expect(
          fenced(f.resources.db, session, (tx) =>
            tx.execute(
              sql`select import_set_pending(${session.fence}::uuid,${JSON.stringify({ ...pending, ...change })}::jsonb,false)`,
            ),
          ),
        ).rejects.toThrow();
      }
      await expect(
        fenced(f.resources.db, session, (tx) =>
          tx.execute(
            sql`insert into import_attestations(kind,accepted,evidence_sha256) values('rebaseline','{}'::jsonb,${'a'.repeat(64)})`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        fenced(f.resources.db, session, (tx) =>
          tx.execute(
            sql`select import_record_attestation(${session.fence}::uuid,null::uuid,null::uuid,'rebaseline',null::jsonb,'{}'::jsonb,null::jsonb,${'a'.repeat(64)})`,
          ),
        ),
      ).rejects.toThrow();
    });
  }));

it('successful re-certification leaves the publication history window unchanged, including a lost acknowledgement', async () =>
  importerFixture(async (f) => {
    await f.run();
    const before = await readImportStatus(f.app, null);
    expect(
      await f.run(
        {
          fault: async (point) => {
            if (point === 'accepted') throw new Error('lost acknowledgement');
          },
        },
        { recertify: true },
      ),
    ).toMatchObject({ result: 'unchanged' });
    const after = await readImportStatus(f.app, null);
    expect(after.recentRuns).toEqual(before.recentRuns);
    expect(after.lastSuccessfulImport).toEqual(before.lastSuccessfulImport);
  }));

it('an altered pre-review fingerprint and an active restore hold cannot be resolved by rebaseline', async () =>
  importerFixture(async (f) => {
    f.inspect.mockImplementationOnce(async () => parseListing('<html>changed listing</html>'));
    await expect(f.run()).rejects.toMatchObject({ reason: 'source_listing_changed' });
    const reviews = await unresolvedPreartifactReviews(f.resources.db);
    const stamp = await verificationStamp(f);
    await withImportSession(f.resources.db, async (session) => {
      await expect(
        fenced(f.resources.db, session, (tx) =>
          recordRebaseline(
            tx,
            session,
            {
              ...f.baseline,
              validation: {
                genericReport: String(stamp?.verification_report_sha256),
                verifier: String(stamp?.verifier_version),
                probes: 'a'.repeat(64),
              },
              resolvedReviews: [{ id: reviews[0]!.id, fingerprint: 'f'.repeat(64) }],
            },
            {},
            null,
            null,
          ),
        ),
      ).rejects.toThrow();
    });
    expect(await unresolvedPreartifactReviews(f.resources.db)).toEqual(reviews);
    await f.owner.execute(sql`update import_control set restore_required=true where id=1`);
    await expect(rebaseline(f)).rejects.toThrow();
    expect(await unresolvedPreartifactReviews(f.resources.db)).toEqual(reviews);
    // Only this scratch fixture models the separate reviewed restore reconciliation.
    await f.owner.execute(sql`update import_control set restore_required=false where id=1`);
    await rebaseline(f);
    expect(await unresolvedPreartifactReviews(f.resources.db)).toEqual([]);
  }));

it('real failed/crashed work still has a four-attempt bound', async () =>
  importerFixture(async (f) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        f.run({
          loadFromExtract: async () => {
            throw new Error('interrupted work');
          },
        }),
      ).rejects.toMatchObject({ result: 'failed' });
      expect((await savedArtifact(f)).attempts).toBe(attempt + 1);
    }
    await expect(f.run()).rejects.toMatchObject({ reason: 'interrupted', review: true });
    expect((await savedArtifact(f)).attempts).toBe(4);
  }));

it('a dead worker counts its in-progress attempt once under the next fence', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'registered') throw new Error('stopped before work');
        },
      }),
    ).rejects.toThrow();
    const saved = await savedArtifact(f);
    await withImportSession(f.resources.db, async (session) => {
      const runId = await beginRun(f.resources.db, session, 'automatic');
      await updateRun(f.resources.db, session, runId, {
        step: 'load',
        result: 'running',
        artifactId: saved.id,
      });
      await startAttempt(f.resources.db, session, runId, saved.id);
      // The session ends with no terminal outcome, as when the host kills the worker.
    });
    expect(await f.run()).toMatchObject({ result: 'published' });
    expect((await savedArtifact(f)).attempts).toBe(2);
    expect(await f.run()).toMatchObject({ result: 'unchanged' });
    expect((await savedArtifact(f)).attempts).toBe(2);
  }));
