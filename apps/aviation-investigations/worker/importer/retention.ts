import { sql } from 'drizzle-orm';
import { type Db } from '../../server/db/client.js';
import { pinGeneration, unpinGeneration, pruneGenerations } from '../../server/db/generations.js';
import { deleteUnusedIndices, cleanupStalePins } from '../index/publications.js';
import { fenced, manifest, type ImportSession } from './store.js';
import type { Client } from '@elastic/elasticsearch';
import { type ImporterConfig } from './config.js';
import { ManagedSpace } from './files.js';
import { digest } from './provenance.js';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ImportFailure } from './contracts.js';
import { retainedArchives, type HostFacts } from './facts.js';

/** Release only reconciled imports superseded for 48h; active/previous and unresolved candidates remain protected. */
export async function retainDatabase(db: Db, es: Client, s: ImportSession): Promise<void> {
  await fenced(db, s, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
    const current = await manifest(tx);
    if (!current) throw new ImportFailure('baseline_required');
    // Existing manual publications also get a full grace window, observed under the same lifecycle lock.
    const retired = await tx.execute(
      sql`select generation_id,published_at::text from dataset_manifests where not active`,
    );
    for (const g of retired.rows) {
      const reason = `import-grace:${g.generation_id}:${digest(g.published_at).slice(0, 16)}`;
      const exists = await tx.execute(
        sql`select 1 from generation_pins where generation_id=${Number(g.generation_id)} and reason=${reason}`,
      );
      if (!exists.rows.length)
        await pinGeneration(
          tx,
          Number(g.generation_id),
          reason,
          new Date(Date.now() + 48 * 3_600_000),
        );
    }
    const old = await tx.execute(sql`select r.index_name,r.artifact_id,r.generation_id from import_index_refs r
      where r.released_at is null and r.created_at < clock_timestamp()-interval '48 hours'
        and r.generation_id not in (select generation_id from dataset_manifests order by active desc,published_at desc limit 2)
        and not exists(select 1 from import_processing p where p.artifact_id=r.artifact_id
          and (p.updated_at>=clock_timestamp()-interval '48 hours'
            or (p.active and p.phase in ('building','switching','published','rolling_back'))))`);
    for (const ref of old.rows) {
      await tx.execute(sql`update import_index_refs set released_at=clock_timestamp()
        where artifact_id=${String(ref.artifact_id)}::uuid and index_name=${String(ref.index_name)} and released_at is null`);
      const remaining=await tx.execute(sql`select 1 from import_index_refs where artifact_id=${String(ref.artifact_id)}::uuid
        and generation_id=${Number(ref.generation_id)} and released_at is null`);
      if(!remaining.rows.length) {
        await unpinGeneration(tx,Number(ref.generation_id),`import:${ref.artifact_id}`);
        await unpinGeneration(tx,Number(ref.generation_id),`import-previous:${ref.artifact_id}`);
      }
    }
    // A load can stop before either index exists. Such generations have a pin but no
    // import_index_refs row to drive the loop above. Release those pins only after
    // every processing attempt is reconciled and the same 48-hour grace has elapsed.
    const orphanPins = await tx.execute(sql`select g.generation_id,g.reason
      from generation_pins g join import_artifacts a
        on g.reason in ('import:'||a.id::text,'import-previous:'||a.id::text)
      where g.generation_id not in (
          select generation_id from dataset_manifests order by active desc,published_at desc limit 2)
        and not exists(select 1 from import_processing p where p.artifact_id=a.id
          and (p.updated_at>=clock_timestamp()-interval '48 hours'
            or (p.active and p.phase in ('building','switching','published','rolling_back'))))
        and not exists(select 1 from import_index_refs r where r.artifact_id=a.id
          and r.generation_id=g.generation_id and r.released_at is null)`);
    for (const pin of orphanPins.rows)
      await unpinGeneration(tx, Number(pin.generation_id), String(pin.reason));
    await tx.execute(sql`select import_prune_runs(${s.fence}::uuid)`);
  });
  await cleanupStalePins(db, { olderThanHours: 48 });
  await pruneGenerations(db, { keep: 2, graceHours: 48 });
  await deleteUnusedIndices(es, db, { olderThanHours: 48, yes: true });
}
/** File cleanup is cross-environment: dev cannot discard the accepted/pending live archive. */
export async function retainFiles(
  db: Db,
  config: ImporterConfig,
  environment: 'dev' | 'live',
  space: ManagedSpace,
  facts: HostFacts,
): Promise<void> {
  const keep = new Set(await retainedArchives(db));
  const other = environment === 'dev' ? 'live' : 'dev';
  if (config[other]) {
    for (const archive of await facts.retention(other)) keep.add(archive);
  }
  for (const path of await space.registered()) {
    const sha = /^(?:archives|extracts)\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (!sha || keep.has(sha)) continue;
    const full = join(space.root, path);
    const stat = await lstat(full).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (stat && Date.now() - stat.mtimeMs >= 48 * 3_600_000) await space.remove(full);
  }
}
