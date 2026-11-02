/** Final host cleanup outlives both children; its incidents must outlive their success too. */
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { ImportFailure, SourceSchema, Sha256 } from './contracts.js';
import { ManagedSpace } from './files.js';
import { fenced, withImportSession } from './store.js';
import { spoolFailure } from './recovery.js';
import { digest } from './provenance.js';
import { localClock } from './status.js';

type Environment = 'dev' | 'live';

/** Injectable database only; the production wrapper always opens the pinned environment. */
export async function recordHostCleanup(
  db: Db, config: ImporterConfig, space: ManagedSpace, environment: Environment,
  startedAt: string, failure?: ImportFailure,
): Promise<void> {
  let runId: string | null = null, artifactId: string | null = null;
  let source: ReturnType<typeof SourceSchema.parse> | null = null;
  let archive: string | null = null, postSuccess = false;
  try {
    await withImportSession(db, async session => {
      if (!failure) {
        await fenced(db, session, tx => tx.execute(sql`update import_issues set resolved_at=clock_timestamp()
          where resolved_at is null and origin='host' and step='cleanup'`));
        return;
      }
      // Both host locks still belong to this invocation. Never attach a failure to
      // an older run (including one completed before this host process started).
      const r = (await db.execute(sql`select id,artifact_id,source,observed_sha256,result,step
        from import_runs where checked_at>=${startedAt}::timestamptz order by checked_at desc limit 1`)).rows[0];
      if (r) {
        runId = String(r.id); artifactId = r.artifact_id ? String(r.artifact_id) : null;
        source = r.source ? SourceSchema.parse(r.source) : null;
        archive = r.observed_sha256 ? Sha256.parse(r.observed_sha256) : null;
        postSuccess = r.step === 'complete' && ['published','unchanged'].includes(String(r.result));
      }
      const image = config[environment]!.image;
      const fixed = postSuccess ? failure.reason === 'storage' : failure.fix;
      await fenced(db, session, tx => tx.execute(sql`insert into import_issues
        (key,run_id,artifact_id,code,image,archive_sha256,source,reason,step,origin,fixed,post_success,failure_day)
        values(${digest(['host',environment,startedAt,runId,failure.reason])},${runId}::uuid,${artifactId}::uuid,
          ${config.code},${image},${archive},${source ? JSON.stringify(source) : null}::jsonb,
          ${failure.reason},'cleanup','host',${fixed},${postSuccess},${localClock(new Date(),config.schedule.timeZone).day})
        on conflict(key) do update set last_at=clock_timestamp(),resolved_at=null`));
    });
  } catch (error) {
    if (!failure) throw error; // Keep the previous incident until clearing it is durable.
    await spoolFailure(space, environment, failure, 'cleanup', runId, artifactId, {
      code:config.code,image:config[environment]!.image,archive,source,postSuccess,origin:'host',
    });
  }
}

export async function hostCleanupStatus(
  config: ImporterConfig, space: ManagedSpace, environments: ReadonlySet<Environment>,
  startedAt: string, failure?: ImportFailure,
): Promise<void> {
  let failed = false;
  for (const environment of environments) {
    let db: Db | undefined;
    try {
      const cfg = environmentConfig(config, environment, true);
      db = createDb(cfg.databaseIngestUrl!, {
        max:2, applicationName:'aviation-import-host-cleanup',
        execution:{statementTimeoutMs:5_000,idleInTransactionTimeoutMs:5_000,transportTimeoutMs:10_000},
        onConnectionError:()=>{},
      });
      await recordHostCleanup(db,config,space,environment,startedAt,failure);
    } catch { failed = true; }
    finally { if (db) await closeDb(db).catch(()=>{ failed=true; }); }
  }
  if (failed) throw new ImportFailure('cleanup');
}
