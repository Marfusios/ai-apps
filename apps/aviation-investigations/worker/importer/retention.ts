import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { pinGeneration, unpinGeneration, pruneGenerations } from '../../server/db/generations.js';
import { deleteUnusedIndices, cleanupStalePins } from '../index/publications.js';
import { fenced, manifest, type ImportSession } from './store.js';
import type { Client } from '@elastic/elasticsearch';
import { environmentConfig, type ImporterConfig } from './config.js';
import { ManagedSpace } from './files.js';
import { digest } from './provenance.js';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ImportFailure } from './contracts.js';

/** Release only reconciled imports superseded for 48h; active/previous and unresolved candidates remain protected. */
export async function retainDatabase(db: Db, es: Client, s: ImportSession): Promise<void> {
  await fenced(db, s, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
    const current = await manifest(tx);
    if (!current) throw new ImportFailure('baseline_required');
    await tx.execute(sql`update import_artifacts set superseded_at=clock_timestamp()
      where publication is not null and superseded_at is null and publication<>${JSON.stringify(current)}::jsonb`);
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
    const old = await tx.execute(sql`select id,generation_id,baseline from import_artifacts
      where canary is not null and not needs_review and rollback is null and superseded_at<clock_timestamp()-interval '48 hours'
        and generation_id not in (select generation_id from dataset_manifests order by active desc,published_at desc limit 2)
        and exists (select 1 from import_index_refs r where r.artifact_id=import_artifacts.id and released_at is null)`);
    for (const a of old.rows) {
      await tx.execute(
        sql`update import_index_refs set released_at=clock_timestamp() where artifact_id=${String(a.id)}::uuid and released_at is null`,
      );
      await unpinGeneration(tx, Number(a.generation_id), `import:${a.id}`);
      const baseline = a.baseline as { generationId: number };
      await unpinGeneration(tx, baseline.generationId, `import-previous:${a.id}`);
    }
    await tx.execute(sql`select import_prune_runs(${s.fence}::uuid)`);
  });
  await cleanupStalePins(db, { olderThanHours: 48 });
  await pruneGenerations(db, { keep: 2, graceHours: 48 });
  await deleteUnusedIndices(es, db, { olderThanHours: 48, yes: true });
}
/** File cleanup is cross-environment: dev cannot discard the accepted/pending live archive. */
export async function retainFiles(config: ImporterConfig, space: ManagedSpace): Promise<void> {
  const keep = new Set<string>();
  for (const environment of ['dev', 'live'] as const) {
    if (!config[environment]) continue;
    const cfg = environmentConfig(config, environment, true),
      db = createDb(cfg.databaseIngestUrl!, {
        max: 2,
        applicationName: 'aviation-import-retention',
      });
    try {
      const rows =
        await db.execute(sql`select accepted->>'archive' as archive from import_control where accepted is not null
        union select a.archive_sha256 from import_artifacts a where needs_review or canary is null
          or exists (select 1 from import_index_refs r where r.artifact_id=a.id and released_at is null)`);
      for (const r of rows.rows) if (typeof r.archive === 'string') keep.add(r.archive);
    } finally {
      await closeDb(db);
    }
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
