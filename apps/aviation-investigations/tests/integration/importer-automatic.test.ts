import { it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture } from '../support/importer.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import {
  control,
  manifest,
  artifact,
  withImportSession,
  fenced,
} from '../../worker/importer/store.js';

it('automatically imports a verified candidate and records changes and success without approval', async () =>
  importerFixture(async (f) => {
    const result = await f.run();
    expect(result.result).toBe('published');
    expect((await manifest(f.resources.db))!.generationId).not.toBe(
      f.baseline.manifest.generationId,
    );
    expect((await control(f.resources.db)).pending).toBeNull();
    expect(
      (
        await f.owner.execute(
          sql`select changes,good_check from import_runs where canary_passed`,
        )
      ).rows[0],
    ).toMatchObject({
      good_check: true,
      changes: { updated: 1, removed: 0, new: 0 },
    });
  }));

import {
  type ImportFixture,
  OLD_OBSERVATION,
  NEW_OBSERVATION,
} from '../support/importer.js';
import { publishManifest } from '../../server/db/generations.js';
import {
  beginRun,
  updateRun,
  startAttempt,
  latestCanary,
} from '../../worker/importer/store.js';
import { digest } from '../../worker/importer/provenance.js';
import { editTable } from '../support/extract-dir.js';
import type { FaultPoint } from '../../worker/importer/runtime.js';
const fail =
  (
    at: FaultPoint,
    reason: ConstructorParameters<typeof ImportFailure>[0] = 'interrupted',
  ) =>
  async (point: FaultPoint) => {
    if (point === at) throw new ImportFailure(reason);
  };
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

it.each(['reissued', 'date_gap', 'no_history', 'external_baseline'] as const)(
  'imports %s without a review or special command',
  async (kind) =>
    importerFixture(async (f) => {
      if (kind === 'reissued') f.setRemote(f.candidate, OLD_OBSERVATION);
      if (kind === 'date_gap')
        f.setRemote(f.candidate, {
          ...NEW_OBSERVATION,
          advertisedAtLocal: '2027-02-01T07:30:00',
        });
      if (kind === 'no_history')
        await withImportSession(f.resources.db, (s) =>
          fenced(f.resources.db, s, (tx) =>
            tx.execute(sql`select import_accept(${s.fence}::uuid,null::jsonb,false)`),
          ),
        ); // Explicitly remove baseline metadata below, never corpus.
      if (kind === 'no_history')
        await f.owner.execute(sql`update import_control set accepted=null`);
      if (kind === 'external_baseline')
        await publishManifest(
          f.resources.db,
          f.baseline.manifest.generationId,
          f.baseline.manifest.casesIndex,
          f.baseline.manifest.passagesIndex,
        );
      expect((await f.run()).result).toBe('published');
      expect(
        (
          await f.owner.execute(
            sql`select count(*)::int n from import_issues where resolved_at is null`,
          )
        ).rows[0]!.n,
      ).toBe(0);
    }),
);

it.each(['total', 'eligible'] as const)(
  'shrunk %s stops before loading, indexing or any provider reservation',
  async (kind) =>
    importerFixture(async (f) => {
      const load = vi.fn(),
        build = vi.fn(),
        pay = vi.fn();
      const cases = f.candidate.facts.normalized.cases;
      const changed =
        kind === 'total'
          ? cases.slice(0, Math.floor(cases.length * 0.89))
          : cases.map((c) => ({ ...c, answerEligible: false }));
      const candidate = {
        ...f.candidate,
        facts: {
          ...f.candidate.facts,
          normalized: { ...f.candidate.facts.normalized, cases: changed },
        },
      };
      await expect(
        f.run({
          extractSnapshot: async () => candidate,
          loadFromExtract: load,
          rebuildCasesIndex: build,
          paidEmbedder: pay,
        }),
      ).rejects.toMatchObject({ reason: 'shrunk', fix: true });
      expect(load).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(pay).not.toHaveBeenCalled();
      expect(await manifest(f.resources.db)).toEqual(f.baseline.manifest);
    }),
);
it('checks live serving counts before any dev load', async () =>
  importerFixture(async (f) => {
    f.config.live = { ...f.config.dev };
    f.resources.hostFacts.serving = async () => ({
      publication: f.baseline.manifest,
      archive: f.baseline.archive,
      content: f.baseline.content,
      observation: OLD_OBSERVATION,
      counts: { total: 10000, eligible: 10000, us: 10000, sample: 'SYNTHETIC' },
    });
    const load = vi.fn();
    await expect(f.run({ loadFromExtract: load })).rejects.toMatchObject({
      reason: 'shrunk',
    });
    expect(load).not.toHaveBeenCalled();
  }));

it.each(['code', 'image', 'bytes'] as const)(
  'same fixed tuple waits; a changed %s retries without resetting the artifact history',
  async (changed) =>
    importerFixture(async (f) => {
      const extraction = vi.fn(f.effects.extractSnapshot!);
      await expect(f.run({ fault: fail('loaded', 'probe') })).rejects.toMatchObject({
        reason: 'probe',
      });
      const before = await saved(f),
        attempts = before.attempts;
      expect((await f.run({ extractSnapshot: extraction })).result).toBe('waiting');
      expect(extraction).not.toHaveBeenCalled();
      expect(f.inspect).toHaveBeenCalledTimes(2);
      if (changed === 'code') f.config.code = 'd'.repeat(40);
      if (changed === 'image') f.config.dev.image = 'sha256:' + 'd'.repeat(64);
      if (changed === 'bytes') {
        const next = await f.snapshot('repacked-candidate', (dir) =>
          editTable(dir, 'events', (rows) => {
            rows[0]!.lchg_date = '2026-10-30T00:00:00';
            return rows;
          }),
        );
        f.setRemote(next, { ...NEW_OBSERVATION, bytes: 12 });
      }
      expect((await f.run()).result).toBe('published');
      const after = await saved(f);
      expect(after.id).toBe(before.id);
      expect(after.attempts).toBe(attempts + 1);
    }),
);
it('weekly unconditional refresh discovers a reissue even while the earlier bytes are suppressed', async () =>
  importerFixture(async (f) => {
    await expect(f.run({ fault: fail('loaded', 'probe') })).rejects.toThrow();
    const next = await f.snapshot('same-date-reissue', (dir) =>
      editTable(dir, 'events', (rows) => {
        rows[0]!.lchg_date = '2026-10-29T00:00:00';
        return rows;
      }),
    );
    f.setRemote(next, NEW_OBSERVATION);
    expect(
      (await f.run({ now: () => new Date(Date.now() + 8 * 86_400_000) })).result,
    ).toBe('published');
    expect(f.acquire).toHaveBeenCalledTimes(2);
  }));
it('more than four interruptions retry daily and preserve attempt history', async () =>
  importerFixture(async (f) => {
    for (let i = 1; i <= 6; i++) {
      await expect(
        f.run({
          loadFromExtract: async () => {
            throw new ImportFailure('interrupted');
          },
        }),
      ).rejects.toMatchObject({ fix: false });
      expect((await saved(f)).attempts).toBe(i);
    }
    expect((await f.run()).result).toBe('published');
    expect((await saved(f)).attempts).toBe(7);
  }));
it('a dead worker counts its attempt once and becomes a dated temporary incident', async () =>
  importerFixture(async (f) => {
    await expect(f.run({ fault: fail('registered') })).rejects.toThrow();
    const a = await saved(f);
    await withImportSession(f.resources.db, async (s) => {
      const id = await beginRun(f.resources.db, s, 'automatic');
      await updateRun(f.resources.db, s, id, {
        step: 'load',
        result: 'running',
        artifactId: a.id,
      });
      await startAttempt(f.resources.db, s, id, a.id);
    });
    expect((await f.run()).result).toBe('published');
    expect((await saved(f)).attempts).toBe(2);
    expect(
      (
        await f.owner.execute(
          sql`select count(*)::int n from import_issues where reason='interrupted'`,
        )
      ).rows[0]!.n,
    ).toBeGreaterThanOrEqual(2);
  }));

it.each(['published', 'propagation', 'site_check'] as const)(
  'failure at %s restores and checks the exact previous data, then suppresses only these bytes',
  async (where) =>
    importerFixture(async (f) => {
      let first = true;
      const checks = vi.fn(f.effects.runCanary!);
      await expect(
        f.run({
          ...(where === 'published' ? { fault: fail('published') } : {}),
          ...(where === 'propagation'
            ? {
                propagate: async () => {
                  if (first) {
                    first = false;
                    throw new ImportFailure('timeout');
                  }
                },
              }
            : {}),
          runCanary: async (...args) => {
            if (where === 'site_check' && first) {
              first = false;
              throw new ImportFailure('probe');
            }
            return checks(...args);
          },
        }),
      ).rejects.toMatchObject({ reason: 'site_check' });
      const now = (await manifest(f.resources.db))!;
      expect(now).toMatchObject({
        generationId: f.baseline.manifest.generationId,
        casesIndex: f.baseline.manifest.casesIndex,
        passagesIndex: f.baseline.manifest.passagesIndex,
      });
      expect(now.publishedAt).not.toBe(f.baseline.manifest.publishedAt);
      expect(checks).toHaveBeenCalled();
      expect((await saved(f)).phase).toBe('restored');
      expect((await f.run()).result).toBe('waiting');
      const issue = (
        await f.owner.execute(
          sql`select site_state,fixed from import_issues where resolved_at is null`,
        )
      ).rows[0]!;
      expect(issue).toMatchObject({ site_state: 'restored', fixed: true });
    }),
);
it('resumes a committed publication with no canary, and never acquires a newer file first', async () =>
  importerFixture(async (f) => {
    await f.run();
    const a = await saved(f);
    // Exact state between the publication commit and acceptance, simulating a killed worker.
    await withImportSession(f.resources.db, (s) =>
      fenced(f.resources.db, s, async (tx) => {
        await tx.execute(
          sql`update import_processing set canary=null,phase='published' where id=${a.processingId}::uuid`,
        );
        await tx.execute(
          sql`select import_accept(${s.fence}::uuid,${JSON.stringify(f.baseline)}::jsonb,false)`,
        );
      }),
    );
    f.acquire.mockClear();
    f.inspect.mockClear();
    expect((await f.run()).result).toBe('published');
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    expect((await saved(f)).phase).toBe('complete');
  }));
it.each(['storage', 'cleanup', 'unclassified'] as const)(
  'post-success %s keeps the successful import and a separate incident',
  async (reason) =>
    importerFixture(async (f) => {
      expect(
        (
          await f.run({
            retainDatabase: async () => {
              throw new ImportFailure(reason);
            },
          })
        ).result,
      ).toBe('published');
      expect((await manifest(f.resources.db))!.generationId).not.toBe(1);
      expect((await saved(f)).rollback).toBeNull();
      expect(
        (
          await f.owner.execute(
            sql`select post_success,fixed,reason from import_issues where resolved_at is null`,
          )
        ).rows[0],
      ).toMatchObject({ post_success: true, fixed: reason === 'storage', reason });
      expect(
        (
          await f.owner.execute(
            sql`select result,canary_passed from import_runs order by checked_at desc limit 1`,
          )
        ).rows[0],
      ).toMatchObject({ result: 'published', canary_passed: true });
    }),
);

it('release recertification preserves waiting work, its date, attempts, money and issue; next daily run is automatic', async () =>
  importerFixture(async (f) => {
    await expect(f.run({ fault: fail('loaded', 'probe') })).rejects.toThrow();
    const before = await control(f.resources.db),
      a = await saved(f),
      issues = await f.owner.execute(sql`select * from import_issues`);
    f.config.code = 'f'.repeat(40);
    const result = await f.run({}, { recertify: true });
    expect(result.result).toBe('unchanged');
    expect(result.generationId).toBe(f.baseline.manifest.generationId);
    const after = await control(f.resources.db);
    expect(after.pending).toEqual(before.pending);
    expect(after.lastFetched).toEqual(before.lastFetched);
    expect(after.lastRemoteFetchAt).toBe(before.lastRemoteFetchAt);
    expect((await saved(f)).attempts).toBe(a.attempts);
    expect((await f.owner.execute(sql`select * from import_issues`)).rows).toEqual(
      issues.rows,
    );
    expect((await latestCanary(f.resources.db, f.baseline.content))?.archive).toBe(
      f.baseline.archive,
    );
    expect((await f.run()).result).toBe('published');
  }));
it('legacy November-style reviews and pending needsReview never block the next check', async () =>
  importerFixture(async (f) => {
    await expect(f.run({ fault: fail('loaded') })).rejects.toThrow();
    const a = await saved(f);
    await withImportSession(f.resources.db, async (s) => {
      await fenced(f.resources.db, s, (tx) =>
        tx.execute(
          sql`update import_artifacts set needs_review=true,reason='cohort_bounds' where id=${a.id}::uuid`,
        ),
      );
      const id = await beginRun(f.resources.db, s, 'automatic');
      await updateRun(f.resources.db, s, id, {
        step: 'check',
        result: 'needs_review',
        reason: 'baseline_required',
      });
    });
    await f.owner.execute(
      sql`update import_control set pending=pending||'{"needsReview":true,"reason":"cohort_bounds"}'::jsonb,last_fetched=last_fetched||'{"state":"reviewed_abandoned"}'::jsonb`,
    );
    expect((await f.run()).result).toBe('published');
    expect(
      (
        await f.owner.execute(
          sql`select needs_review from import_artifacts where id=${a.id}::uuid`,
        )
      ).rows[0]!.needs_review,
    ).toBe(true); // History untouched.
  }));

import { fakeRelease, RELEASE_HEAD, RELEASE_IMAGE } from '../support/release.js';
import { runRelease } from '../../scripts/release-runner.js';
it('Task 27 release stays green with a real waiting import and leaves that candidate untouched', async () =>
  importerFixture(async (f) => {
    await expect(f.run({ fault: fail('loaded', 'probe') })).rejects.toThrow();
    const pending = (await control(f.resources.db)).pending;
    const release = fakeRelease(),
      run = release.fx.run;
    release.fx.run = async (spec) => {
      if (spec.args.includes('recertify')) {
        f.config.code = RELEASE_HEAD;
        f.config.dev.image = RELEASE_IMAGE;
        const report = await f.run({}, { recertify: true });
        release.behavior.recertify = {
          code: 0,
          line: JSON.stringify({
            step: 'complete',
            result: report.result,
            reason: report.reason,
          }),
        };
      }
      return run(spec);
    };
    expect(await runRelease(release.args, release.fx)).toBe(0);
    expect((await control(f.resources.db)).pending).toEqual(pending);
    expect((await f.run()).result).toBe('published');
  }));

import { operatorWithResources } from '../../worker/importer/commands.js';
it('emergency rollback is checked, exact and latch-free; its bytes wait for a release', async () =>
  importerFixture(async (f) => {
    await f.run();
    const a = await saved(f);
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
    expect((await manifest(f.resources.db))!.generationId).toBe(
      f.baseline.manifest.generationId,
    );
    expect((await f.run()).result).toBe('waiting');
  }));
it('an external publication during canary is adopted without suppressing the candidate', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'published') {
            await publishManifest(
              f.resources.db,
              f.baseline.manifest.generationId,
              f.baseline.manifest.casesIndex,
              f.baseline.manifest.passagesIndex,
            );
            throw new ImportFailure('baseline_changed');
          }
        },
      }),
    ).rejects.toMatchObject({ reason: 'interrupted', fix: false });
    expect((await saved(f)).phase).toBe('abandoned');
    expect((await saved(f)).rollback).toBeNull();
    expect((await control(f.resources.db)).accepted!.manifest).toEqual(
      await manifest(f.resources.db),
    );
    expect((await f.run()).result).toBe('published');
  }));
it('an ambiguous alias stays fixed across days and releases until the exact request is reconciled', async () =>
  importerFixture(async (f) => {
    const alias = f.resources.appConfig.elasticsearch.indexPrefix + '-cases';
    await f.resources.db.execute(
      sql`insert into index_switch_attempts(alias,index_name) values(${alias},'aviation-test-missing-pending')`,
    );
    await expect(f.run()).rejects.toMatchObject({ reason: 'alias_unknown' });
    await expect(f.run()).rejects.toMatchObject({ reason: 'alias_unknown' });
    f.config.code = 'e'.repeat(40);
    await expect(f.run()).rejects.toMatchObject({ reason: 'alias_unknown' });
    expect(await manifest(f.resources.db)).toEqual(f.baseline.manifest);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(
      (await f.owner.execute(sql`select switch_hold from import_control`)).rows[0]!
        .switch_hold,
    ).not.toBeNull();
  }));
