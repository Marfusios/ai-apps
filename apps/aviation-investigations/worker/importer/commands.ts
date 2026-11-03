/** Emergency rollback only. Ordinary processing never needs an operator command. */
import { sql } from 'drizzle-orm';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { ImportFailure, Sha256, sameManifest } from './contracts.js';
import { digest } from './provenance.js';
import {
  artifact,
  beginRun,
  fenced,
  updateRun,
  withImportSession,
  manifest,
} from './store.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { rollback } from './lifecycle.js';
import { classify } from './failure.js';
import { adoptServing, servingCounts, suppressionKey } from './automatic.js';
import { applicationProbe, propagate } from './application.js';
import { runCanary } from './probes.js';
import { CASES_INDEX_VERSION } from '../index/cases-index.js';
import { localClock } from './status.js';
import type { ImportEffects, ImportResources } from './runtime.js';
export async function operatorCommand(
  config: ImporterConfig,
  environment: 'dev' | 'live',
  command: 'rollback',
  archive: string,
  options: { publicationHash?: string },
): Promise<void> {
  const cfg = environmentConfig(config, environment),
    db = createDb(cfg.databaseIngestUrl!, {
      max: 6,
      applicationName: 'aviation-import-rollback',
    }),
    es = createEsClient(cfg.elasticsearch, 'write', { maxRetries: 0 });
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
export async function operatorWithResources(
  config: ImporterConfig,
  environment: 'dev' | 'live',
  _command: 'rollback',
  archive: string,
  options: { publicationHash?: string },
  resources: Pick<ImportResources, 'db' | 'es' | 'appConfig'>,
  effects: Partial<
    Pick<ImportEffects, 'applicationProbe' | 'propagate' | 'runCanary'>
  > = {},
): Promise<void> {
  Sha256.parse(archive);
  const { db, es, appConfig: cfg } = resources;
  await withImportSession(db, async (s) => {
    const r = await db.execute(
      sql`select a.id from import_artifacts a join import_processing p on p.artifact_id=a.id and p.active where a.environment=${environment} and p.archive_sha256=${archive}`,
    );
    if (r.rows.length !== 1) throw new ImportFailure('integrity');
    const a = await artifact(db, String(r.rows[0]!.id));
    if (
      !a.publication ||
      !options.publicationHash ||
      digest(a.publication) !== options.publicationHash
    )
      throw new ImportFailure('baseline_changed');
    const id = await beginRun(db, s, 'automatic');
    try {
      const previous = await rollback(db, es, s, a.id, a.publication, {
        model: cfg.ai.openai.embeddingModel,
        dims: cfg.ai.openai.embeddingDimensions,
      });
      const accepted = await adoptServing(db, s, config.code);
      await fenced(db, s, (tx) =>
        tx.execute(
          sql`update import_runs set restoration=${JSON.stringify({ publication: previous, source: accepted.observation, checkedAt: null })}::jsonb where id=${id}::uuid`,
        ),
      );
      const counts = await servingCounts(db, previous),
        app = (effects.applicationProbe ?? applicationProbe)(
          config[environment]!,
          CASES_INDEX_VERSION,
          { cases: counts.us, eligible: counts.eligible, sample: counts.sample },
        );
      await (effects.propagate ?? propagate)(app, previous);
      await (effects.runCanary ?? runCanary)(db, previous, app);
      await fenced(db, s, async (tx) => {
        await tx.execute(
          sql`update import_processing set phase='restored' where id=${a.processingId}::uuid`,
        );
        await tx.execute(sql`insert into import_issues(key,run_id,artifact_id,code,image,archive_sha256,reason,step,origin,fixed,site_state,failure_day,suppresses_file)
     values(${suppressionKey(environment, archive, null, config.code, config[environment]!.image)},${id}::uuid,${a.id}::uuid,${config.code},${config[environment]!.image},${archive},'manual_rollback','canary',${environment},true,'restored',${localClock(new Date(), config.schedule.timeZone).day},true)
     on conflict(key) do update set site_state=excluded.site_state,resolved_at=null,last_at=clock_timestamp()`);
        await tx.execute(
          sql`update import_runs set restoration=${JSON.stringify({ publication: previous, source: accepted.observation, checkedAt: new Date().toISOString() })}::jsonb where id=${id}::uuid`,
        );
      });
      await updateRun(db, s, id, {
        step: 'complete',
        result: 'rolled_back',
        reason: 'manual_rollback',
        artifactId: a.id,
      });
    } catch (error) {
      // Only a read-back of the jointly committed rollback proves that the switch
      // finished. An unknown alias state is never treated as a passed rollback.
      let committed = false;
      if (classify(error).reason !== 'alias_unknown') {
        try {
          const fresh = await artifact(db, a.id);
          committed =
            fresh.rollback !== null && sameManifest(fresh.rollback, await manifest(db));
        } catch {
          /* unreadable is not proof */
        }
      }
      const reason = committed ? 'manual_rollback' : 'rollback_failed';
      const siteState = committed ? 'restore_unverified' : 'uncertain';
      await fenced(db, s, async (tx) => {
        if (!committed)
          await tx.execute(
            sql`select import_switch_hold(${s.fence}::uuid,${JSON.stringify({ code: config.code, image: config[environment]!.image, reason: 'rollback_failed', artifactId: a.id, runId: id })}::jsonb)`,
          );
        await tx.execute(sql`insert into import_issues(key,run_id,artifact_id,code,image,archive_sha256,reason,step,origin,fixed,site_state,failure_day,suppresses_file)
        values(${suppressionKey(environment, archive, null, config.code, config[environment]!.image)},${id}::uuid,${a.id}::uuid,${config.code},${config[environment]!.image},${archive},${reason},'canary',${environment},true,${siteState},${localClock(new Date(), config.schedule.timeZone).day},true)
        on conflict(key) do update set site_state=excluded.site_state,resolved_at=null,last_at=clock_timestamp()`);
      });
      await updateRun(db, s, id, {
        step: committed ? 'complete' : 'canary',
        result: committed ? 'rolled_back' : 'failed',
        reason,
        artifactId: a.id,
      });
      throw new ImportFailure(committed ? 'site_check' : 'rollback_failed');
    }
  });
}
