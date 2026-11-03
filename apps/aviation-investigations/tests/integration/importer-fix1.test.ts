import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFile } from 'node:fs/promises';
import {
  importerFixture,
  NEW_OBSERVATION,
  type ImportFixture,
} from '../support/importer.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import {
  artifact,
  control,
  fenced,
  manifest,
  withImportSession,
} from '../../worker/importer/store.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { rollback } from '../../worker/importer/lifecycle.js';
import { deleteUnusedIndices } from '../../worker/index/publications.js';

async function latestArtifact(f: ImportFixture) {
  const row = (
    await f.owner.execute(
      sql`select id from import_artifacts order by created_at desc limit 1`,
    )
  ).rows[0]!;
  return artifact(f.resources.db, String(row.id));
}
const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };

it.each(['recertify', 'preflight'] as const)(
  '%s failure does not suppress a file that has not run',
  async (kind) =>
    importerFixture(async (f) => {
      await expect(
        f.run({
          fault: async (point) => {
            if (point === 'fetched') throw new ImportFailure('interrupted');
          },
        }),
      ).rejects.toThrow();
      const pending = (await control(f.resources.db)).pending;
      if (kind === 'recertify') {
        await expect(
          f.run(
            {
              probeCandidate: async () => {
                throw new ImportFailure('probe');
              },
            },
            { recertify: true },
          ),
        ).rejects.toMatchObject({ reason: 'probe' });
      } else {
        await expect(
          f.run({
            deployedImage: async () => {
              throw new ImportFailure('configuration');
            },
          }),
        ).rejects.toMatchObject({ reason: 'configuration' });
      }
      expect((await control(f.resources.db)).pending).toEqual(pending);
      expect((await readImportStatus(f.app, schedule)).status).toBe('fix');
      expect((await f.run()).result).toBe('published');
      expect((await readImportStatus(f.app, schedule)).alert).toBeNull();
    }),
);

it('a restored publication with a failed site check retries daily without a switch hold', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        runCanary: async () => {
          throw new ImportFailure('probe');
        },
      }),
    ).rejects.toMatchObject({ reason: 'site_check' });
    const pendingRestore = await latestArtifact(f);
    expect(pendingRestore.phase).toBe('rolling_back');
    expect(await manifest(f.resources.db)).toEqual(pendingRestore.rollback);
    expect(
      (await f.owner.execute(sql`select switch_hold from import_control`)).rows[0]!
        .switch_hold,
    ).toBeNull();
    expect(
      (
        await f.owner.execute(
          sql`select site_state,original_reason from import_issues where resolved_at is null`,
        )
      ).rows[0],
    ).toMatchObject({ site_state: 'restore_unverified', original_reason: 'probe' });
    const beforeCalls = f.acquire.mock.calls.length;
    expect((await f.run()).result).toBe('waiting');
    expect(f.acquire).toHaveBeenCalledTimes(beforeCalls);
    expect((await latestArtifact(f)).phase).toBe('restored');
    expect((await readImportStatus(f.app, schedule)).alert).toMatchObject({
      cause: 'site_check',
      siteState: 'restored',
    });
  }));

it('a rollback that never commits holds switches and keeps both generations and indices pinned', async () =>
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
    ).rejects.toMatchObject({ reason: 'rollback_failed' });
    const a = await latestArtifact(f);
    expect(a.rollback).toBeNull();
    const pins = (
      await f.owner.execute(
        sql`select generation_id,reason from generation_pins where reason like 'import%' order by reason`,
      )
    ).rows;
    const refs = (
      await f.owner.execute(
        sql`select index_name from import_index_refs where released_at is null order by index_name`,
      )
    ).rows;
    expect(new Set(pins.map((r) => String(r.generation_id))).size).toBe(2);
    expect(refs).toHaveLength(4);
    await expect(f.run()).rejects.toMatchObject({ reason: 'rollback_failed' });
    expect(
      (
        await f.owner.execute(
          sql`select generation_id,reason from generation_pins where reason like 'import%' order by reason`,
        )
      ).rows,
    ).toEqual(pins);
    expect(
      (
        await f.owner.execute(
          sql`select index_name from import_index_refs where released_at is null order by index_name`,
        )
      ).rows,
    ).toEqual(refs);
    f.config.code = 'e'.repeat(40);
    expect((await f.run()).result).toBe('waiting');
    expect((await latestArtifact(f)).phase).toBe('restored');
  }));

it.each(['before_commit', 'after_commit', 'failed_read_back'] as const)(
  'recovers a worker killed during rollback %s',
  async (point) =>
    importerFixture(async (f) => {
      await f.run();
      const a = await latestArtifact(f);
      await withImportSession(f.resources.db, async (s) => {
        await fenced(f.resources.db, s, async (tx) => {
          await tx.execute(
            sql`update import_processing set phase='published',canary=null where id=${a.processingId}::uuid`,
          );
          await tx.execute(
            sql`select import_adopt(${s.fence}::uuid,${JSON.stringify((await control(f.resources.db)).accepted)}::jsonb)`,
          );
        });
        const undo = () =>
          rollback(
            f.resources.db,
            f.resources.es,
            s,
            a.id,
            a.publication!,
            { model: 'text-embedding-3-small', dims: 1536 },
            point === 'before_commit'
              ? async () => {
                  throw new Error('simulate process death before rollback commit');
                }
              : undefined,
          );
        if (point === 'before_commit') await expect(undo()).rejects.toThrow();
        else await undo();
      });
      expect((await latestArtifact(f)).phase).toBe('rolling_back');
      const check = vi.fn(f.effects.runCanary!);
      if (point === 'failed_read_back') {
        const execute = f.resources.db.execute.bind(f.resources.db);
        const dialect = new PgDialect();
        let injected = false;
        const spy = vi.spyOn(f.resources.db, 'execute').mockImplementation((query) => {
          const text =
            typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
          if (!injected && text.includes('select original_reason')) {
            injected = true;
            throw new ImportFailure('integrity');
          }
          return execute(query);
        });
        try {
          await expect(f.run({ runCanary: check })).rejects.toMatchObject({
            reason: 'site_check',
          });
        } finally {
          spy.mockRestore();
        }
        expect(injected).toBe(true);
      } else expect((await f.run({ runCanary: check })).result).toBe('waiting');
      expect(check).toHaveBeenCalled();
      expect((await latestArtifact(f)).phase).toBe('restored');
      const acquired = f.acquire.mock.calls.length;
      const extract = vi.fn();
      expect((await f.run({ extractSnapshot: extract })).result).toBe('waiting');
      expect(f.acquire).toHaveBeenCalledTimes(acquired);
      expect(extract).not.toHaveBeenCalled();
      expect((await latestArtifact(f)).phase).toBe('restored');
      expect(
        (
          await f.owner.execute(
            sql`select step,preflight,suppresses_file from import_issues where resolved_at is null`,
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          step: 'canary',
          preflight: false,
          suppresses_file: true,
        }),
      ]);
      expect((await manifest(f.resources.db))!.generationId).toBe(
        f.baseline.manifest.generationId,
      );
    }),
);

it('cases_built resumes with the same index and its protected original accounting identity', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'cases_built') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toThrow();
    const a = await latestArtifact(f);
    const refs = (
      await f.owner.execute(
        sql`select index_name from import_index_refs where artifact_id=${a.id}::uuid order by index_name`,
      )
    ).rows;
    await f.owner.execute(
      sql`alter table index_builds disable trigger index_builds_guard`,
    );
    try {
      await f.owner.execute(
        sql`update index_builds set created_at=clock_timestamp()-interval '7 days'`,
      );
    } finally {
      await f.owner.execute(
        sql`alter table index_builds enable trigger index_builds_guard`,
      );
    }
    const cleanup = await deleteUnusedIndices(f.resources.es, f.resources.db, {
      olderThanHours: 48,
      yes: true,
    });
    expect(cleanup.deleted).toEqual([]);
    expect(cleanup.refused.some((r) => r.reason.includes('import candidate'))).toBe(true);
    const build = vi.fn();
    expect((await f.run({ rebuildCasesIndex: build })).result).toBe('published');
    expect(build).not.toHaveBeenCalled();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect((await latestArtifact(f)).id).toBe(a.id);
    expect((await latestArtifact(f)).generation_id).toBe(a.generation_id);
    const after = (
      await f.owner.execute(
        sql`select index_name from import_index_refs where artifact_id=${a.id}::uuid order by index_name`,
      )
    ).rows;
    expect(after).toEqual(expect.arrayContaining(refs));
    expect(
      (await f.owner.execute(sql`select count(*)::int n from reservations`)).rows[0]!.n,
    ).toBe(0);
  }));

it('preflight app unavailability defers without acquisition, a fixed issue or a latch', async () =>
  importerFixture(async (f) => {
    for (let i = 0; i < 5; i++)
      await expect(
        f.run({
          applicationAvailable: async () => {
            throw new ImportFailure('source_unavailable');
          },
        }),
      ).rejects.toMatchObject({ reason: 'source_unavailable', fix: false });
    expect(f.acquire).not.toHaveBeenCalled();
    expect((await control(f.resources.db)).pending).toBeNull();
    expect(
      (await f.owner.execute(sql`select 1 from import_issues where fixed`)).rows,
    ).toHaveLength(0);
    expect((await f.run()).result).toBe('published');
  }));

it('source unavailability does not consume attempts, and a plain good unchanged check clears temporary dates', async () =>
  importerFixture(async (f) => {
    await f.run();
    const before = await latestArtifact(f);
    const inspect = f.resources.source.inspect;
    f.resources.source.inspect = async () => {
      throw new ImportFailure('source_unavailable');
    };
    for (let i = 0; i < 5; i++)
      await expect(f.run()).rejects.toMatchObject({ fix: false });
    expect((await latestArtifact(f)).attempts).toBe(before.attempts);
    f.resources.source.inspect = inspect;
    expect((await f.run()).result).toBe('unchanged');
    expect(
      (await f.owner.execute(sql`select 1 from import_issues where resolved_at is null`))
        .rows,
    ).toHaveLength(0);
  }));

it('the pending reason/time guard and accepted-content match survive 0029', async () =>
  importerFixture(async (f) => {
    await expect(
      f.run({
        fault: async (point) => {
          if (point === 'fetched') throw new ImportFailure('interrupted');
        },
      }),
    ).rejects.toThrow();
    const pending = (await control(f.resources.db)).pending!;
    await withImportSession(f.resources.db, async (s) => {
      for (const change of [
        { reason: 'arbitrary' },
        { fetchedAt: 'yesterday' },
        { fetchedAt: '2026-13-01T00:00:00Z' },
      ]) {
        await expect(
          fenced(f.resources.db, s, (tx) =>
            tx.execute(
              sql`select import_set_pending(${s.fence}::uuid,${JSON.stringify({ ...pending, ...change })}::jsonb,false)`,
            ),
          ),
        ).rejects.toThrow();
      }
      await fenced(f.resources.db, s, (tx) =>
        tx.execute(
          sql`select import_set_pending(${s.fence}::uuid,${JSON.stringify({ ...pending, content: f.candidate.facts.digest })}::jsonb,false)`,
        ),
      );
      await expect(
        fenced(f.resources.db, s, (tx) =>
          tx.execute(
            sql`select import_accept(${s.fence}::uuid,${JSON.stringify(f.baseline)}::jsonb,false)`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        fenced(f.resources.db, s, (tx) =>
          tx.execute(sql`update import_artifacts set approved='{}'::jsonb`),
        ),
      ).rejects.toThrow();
      await expect(
        fenced(f.resources.db, s, (tx) =>
          tx.execute(sql`update import_issues set reason='configuration'`),
        ),
      ).rejects.toThrow();
      await expect(
        fenced(f.resources.db, s, (tx) =>
          tx.execute(sql`update import_processing set code=${'0'.repeat(40)}`),
        ),
      ).rejects.toThrow();
    });
  }));
