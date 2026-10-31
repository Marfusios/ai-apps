import { sql } from 'drizzle-orm';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { ImportFailure, Sha256, sameManifest } from './contracts.js';
import { digest } from './provenance.js';
import { artifact, fenced, manifest, withImportSession } from './store.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { privateJson } from './extraction.js';
import { checkApproval, ApprovalSchema } from './approval.js';
import { rollback } from './lifecycle.js';
import { join } from 'node:path';
import type { Comparison } from './compare.js';
import type { ImportResources } from './runtime.js';

export async function operatorCommand(
  config: ImporterConfig,
  environment: 'dev' | 'live',
  command: 'approve' | 'rollback',
  archive: string,
  options: { approval?: string; publicationHash?: string },
): Promise<void> {
  Sha256.parse(archive);
  const cfg = environmentConfig(config, environment);
  const db = createDb(cfg.databaseIngestUrl!, {
    max: 6,
    applicationName: 'aviation-import-review',
  });
  const es = createEsClient(cfg.elasticsearch, 'write', { maxRetries: 0 });
  try {
    await operatorWithResources(config, environment, command, archive, options, {
      db,
      es,
      appConfig: cfg,
    });
  } finally {
    await es.close();
    await closeDb(db);
  }
}

/** Same operator path as the CLI, with owned scratch resources for offline integration tests. */
export async function operatorWithResources(
  config: ImporterConfig,
  environment: 'dev' | 'live',
  command: 'approve' | 'rollback',
  archive: string,
  options: { approval?: string; publicationHash?: string },
  resources: Pick<ImportResources, 'db' | 'es' | 'appConfig'>,
): Promise<void> {
  Sha256.parse(archive);
  const { db, es, appConfig: cfg } = resources;
  await withImportSession(db, async (s) => {
    const r = await db.execute(
      sql`select id from import_artifacts where environment=${environment} and archive_sha256=${archive}`,
    );
    if (r.rows.length !== 1) throw new ImportFailure('integrity');
    const a = await artifact(db, String(r.rows[0]!.id));
    if (command === 'rollback') {
      if (
        !a.publication ||
        !options.publicationHash ||
        digest(a.publication) !== options.publicationHash
      )
        throw new ImportFailure('baseline_changed');
      await rollback(db, es, s, a.id, a.publication, {
        model: cfg.ai.openai.embeddingModel,
        dims: cfg.ai.openai.embeddingDimensions,
      });
      return;
    }
    if (
      !options.approval ||
      !a.baseline ||
      !a.needs_review ||
      !['cohort_bounds', 'source_reissued', 'baseline_required'].includes(a.reason ?? '') ||
      a.resolved_at !== null ||
      a.publication ||
      !sameManifest(a.baseline, await manifest(db))
    )
      throw new ImportFailure('verification');
    const approved = ApprovalSchema.parse(await privateJson(options.approval));
    const comparison = (await privateJson(
      join(config.root, 'reports', environment, `${a.id}-comparison.json`),
    )) as Comparison;
    const { hash, ...facts } = comparison;
    if (hash !== digest(facts) || comparison.candidate !== a.content_sha256)
      throw new ImportFailure('integrity');
    checkApproval(approved, a, a.baseline, config.code, comparison);
    await fenced(db, s, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
      if (!sameManifest(await manifest(tx), a.baseline))
        throw new ImportFailure('baseline_changed');
      await tx.execute(sql`update import_artifacts set approved=${JSON.stringify(approved)}::jsonb,needs_review=false,reason=null
        where id=${a.id}::uuid and reason=${a.reason} and resolved_at is null`);
      // Age/history remains mandatory. Clearing a policy review cannot clear an accounting or restore latch.
      await tx.execute(
        sql`select import_check_budget(${a.id}::uuid,${s.fence}::uuid,0::bigint)`,
      );
      await tx.execute(sql`select import_approve_pending(${s.fence}::uuid,${a.id}::uuid)`);
    });
  });
}
