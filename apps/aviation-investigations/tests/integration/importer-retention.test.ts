import { it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture } from '../support/importer.js';
import { withImportSession, fenced } from '../../worker/importer/store.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { retainDatabase } from '../../worker/importer/retention.js';

it('retains unindexed candidates until reconciled, then releases their orphan pins after 48 hours', async () => importerFixture(async f => {
  await expect(f.run({ fault: async point => { if (point === 'loaded') throw new ImportFailure('probe'); } })).rejects.toThrow();
  const row = (await f.owner.execute(sql`select artifact_id,generation_id from import_processing where active`)).rows[0]!;
  const pinned = async () => (await f.owner.execute(sql`select 1 from generation_pins
    where generation_id=${Number(row.generation_id)} and reason=${`import:${row.artifact_id}`}`)).rows.length;
  const age = async () => {
    // Fixture-only clock movement; never disable production guards.
    await f.owner.execute(sql`alter table import_processing disable trigger import_processing_guard`);
    try { await f.owner.execute(sql`update import_processing set updated_at=clock_timestamp()-interval '49 hours'`); }
    finally { await f.owner.execute(sql`alter table import_processing enable trigger import_processing_guard`); }
  };
  const cleanup = () => withImportSession(f.resources.db, s => retainDatabase(f.resources.db, f.resources.es, s));
  await age(); await cleanup(); expect(await pinned()).toBe(1); // Active unfinished load stays protected.
  await withImportSession(f.resources.db, s => fenced(f.resources.db, s, tx =>
    tx.execute(sql`update import_processing set phase='abandoned' where artifact_id=${String(row.artifact_id)}::uuid`)));
  await cleanup(); expect(await pinned()).toBe(1); // Recently reconciled work has its own grace.
  await age(); await cleanup(); expect(await pinned()).toBe(0);
  expect((await f.owner.execute(sql`select 1 from dataset_manifests where active and generation_id=${f.baseline.manifest.generationId}`)).rows).toHaveLength(1);
}));

it('a final status-file failure after success records storage without downgrading or rolling back', async () => importerFixture(async f => {
  const write = f.resources.space.json.bind(f.resources.space);
  vi.spyOn(f.resources.space, 'json').mockImplementation(async (path, value) => {
    if (path.endsWith('/last-dev.json')) throw new ImportFailure('storage');
    return write(path, value);
  });
  expect((await f.run()).result).toBe('published');
  expect((await f.owner.execute(sql`select result,canary_passed from import_runs order by checked_at desc limit 1`)).rows[0]).toMatchObject({result:'published',canary_passed:true});
  expect((await f.owner.execute(sql`select reason,fixed,post_success from import_issues where resolved_at is null`)).rows).toEqual([{reason:'storage',fixed:true,post_success:true}]);
  expect((await f.owner.execute(sql`select rollback from import_processing where active`)).rows[0]!.rollback).toBeNull();
}));
