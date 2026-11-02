import { it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture } from '../support/importer.js';
import { withImportSession, fenced } from '../../worker/importer/store.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { retainDatabase } from '../../worker/importer/retention.js';
import { recordHostCleanup } from '../../worker/importer/host-status.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { replayOutage, spoolFailure } from '../../worker/importer/recovery.js';

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

it('repeated post-success failures survive the next successful acceptance until final reporting completes', async () => importerFixture(async f => {
  const write = f.resources.space.json.bind(f.resources.space);
  const spy = vi.spyOn(f.resources.space, 'json').mockImplementation(async (path, value) => {
    if (path.endsWith('/last-dev.json')) throw new ImportFailure('cleanup');
    return write(path, value);
  });
  for (let day=1; day<=3; day++) {
    expect((await f.run()).result).toBe(day===1?'published':'unchanged');
    await withImportSession(f.resources.db, s => fenced(f.resources.db,s,tx=>tx.execute(sql`update import_issues
      set failure_day=${`2026-10-0${day}`} where run_id=(select id from import_runs order by checked_at desc limit 1)`)));
    expect((await f.owner.execute(sql`select count(*)::int as n from import_issues where resolved_at is null and post_success and not fixed`)).rows[0]!.n).toBe(day);
  }
  const status = await readImportStatus(f.app,{...f.config.schedule,enabled:true});
  expect(status.alert).toMatchObject({level:'delayed',cause:'cleanup',failedDays:3,postSuccess:true});
  expect((await f.owner.execute(sql`select result from import_runs order by checked_at desc limit 1`)).rows[0]!.result).toBe('unchanged');
  spy.mockRestore();
  await f.run();
  expect((await readImportStatus(f.app,{...f.config.schedule,enabled:true})).alert).toBeNull();
}));

it('host cleanup incidents preserve success and remain until host cleanup itself succeeds', async () => importerFixture(async f => {
  const start = new Date(Date.now()-1000).toISOString();
  await f.run();
  await recordHostCleanup(f.resources.db,f.config,f.resources.space,'dev',start,new ImportFailure('storage'));
  expect((await readImportStatus(f.app,{...f.config.schedule,enabled:true})).alert).toMatchObject({level:'fix',cause:'storage',origin:'host',postSuccess:true});
  expect((await f.owner.execute(sql`select result from import_runs order by checked_at desc limit 1`)).rows[0]!.result).toBe('published');
  await f.run(); // The child cannot claim that the host's later cleanup has succeeded.
  expect((await readImportStatus(f.app,{...f.config.schedule,enabled:true})).alert).toMatchObject({cause:'storage',origin:'host'});
  await recordHostCleanup(f.resources.db,f.config,f.resources.space,'dev',start);
  expect((await readImportStatus(f.app,{...f.config.schedule,enabled:true})).alert).toBeNull();
}));

it('replayed host cleanup after an unchanged check cannot replace its committed outcome', async () => importerFixture(async f => {
  await f.run(); await f.run();
  const row = (await f.owner.execute(sql`select id,artifact_id from import_runs order by checked_at desc limit 1`)).rows[0]!;
  await spoolFailure(f.resources.space,'dev',new ImportFailure('cleanup'),'cleanup',String(row.id),row.artifact_id?String(row.artifact_id):null,
    {code:f.config.code,image:f.config.dev.image,archive:null,source:null,postSuccess:true,origin:'host'});
  await withImportSession(f.resources.db, s => replayOutage(f.resources.db,s,f.resources.space,'dev'));
  expect((await f.owner.execute(sql`select result from import_runs where id=${String(row.id)}::uuid`)).rows[0]!.result).toBe('unchanged');
  expect((await f.owner.execute(sql`select reason,fixed,post_success from import_issues where resolved_at is null`)).rows).toEqual([{reason:'cleanup',fixed:false,post_success:true}]);
}));
