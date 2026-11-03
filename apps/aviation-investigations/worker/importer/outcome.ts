/** Host-only, bounded dev failure metadata. No environment child reads another environment's DB. */
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { ImportFailure } from './contracts.js';
import { SkipSchema, type Skip } from './recovery.js';

export async function readDevOutcomeWith(db: Db, config: ImporterConfig): Promise<Skip> {
  const fallback: Skip = {
    reason: 'interrupted',
    step: 'check',
    runId: null,
    source: null,
    archive: null,
    fixed: false,
    suppressFile: false,
    code: config.code,
    image: config.dev.image,
  };
  const run = (
    await db.execute(sql`select id,reason,step,source,observed_sha256,code,image
    from import_runs order by checked_at desc limit 1`)
  ).rows[0];
  if (!run) return fallback;
  // A host cleanup incident can be newer than the child's failure. It did not
  // cause this child to stop. A suppressed check instead refers to its file issue.
  const issue = (
    await db.execute(sql`select reason,step,source,archive_sha256 as archive,fixed,suppresses_file as "suppressFile",code,image
    from import_issues where resolved_at is null and origin<>'host'
      and (run_id=${String(run.id)}::uuid or
        (${run.reason === null} and archive_sha256=${run.observed_sha256 ?? null}
          and code=${run.code ?? config.code} and image=${run.image ?? config.dev.image}))
    order by (run_id=${String(run.id)}::uuid) desc,last_at desc limit 1`)
  ).rows[0];
  if (issue) return SkipSchema.parse({ ...issue, runId: run.id });
  if (!run.reason) return { ...fallback, runId: String(run.id) };
  const reason = SkipSchema.shape.reason.parse(run.reason);
  return SkipSchema.parse({
    reason,
    step: run.step,
    source: run.source,
    archive: run.observed_sha256,
    fixed: new ImportFailure(reason).fix,
    code: run.code ?? config.code,
    image: run.image ?? config.dev.image,
    runId: run.id,
  });
}

export async function readDevOutcome(config: ImporterConfig): Promise<Skip> {
  const cfg = environmentConfig(config, 'dev', true);
  const db = createDb(cfg.databaseIngestUrl!, {
    max: 1,
    applicationName: 'aviation-import-host-outcome',
    execution: {
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 5_000,
      transportTimeoutMs: 10_000,
    },
    onConnectionError: () => {},
  });
  try {
    return await readDevOutcomeWith(db, config);
  } catch {
    return {
      reason: 'interrupted',
      step: 'check',
      runId: null,
      source: null,
      archive: null,
      fixed: false,
      suppressFile: false,
      code: config.code,
      image: config.dev.image,
    };
  } finally {
    await closeDb(db);
  }
}
