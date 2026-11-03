/** Orchestration only. Step effects live in steps.ts; every acceptance boundary is fenced in durable.ts. */
import { join } from 'node:path';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { sql } from 'drizzle-orm';
import { rollback } from './lifecycle.js';
import {
  servingCounts,
  incident,
  holdSwitch,
  checkSwitchHold,
  adoptServing,
  processingFile,
} from './automatic.js';
import { reconcileAlias } from '../index/publications.js';
import {
  ImportFailure,
  safeLog,
  sameManifest,
  IMPORT_REASONS,
  type ImportReason,
} from './contracts.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { ManagedSpace } from './files.js';
import { AvallSource, refreshOwed, sameObservation } from './source.js';
import { workerHostFacts } from './facts.js';
import { certificationClient } from './strict-es.js';
import { committedSuccess, completedRun } from './durable.js';
import { classify } from './failure.js';
import {
  accountingReport,
  artifact,
  control,
  fenced,
  manifest,
  updateRun,
  withImportSession,
  type AcceptedSnapshot,
} from './store.js';
import { spoolFailure } from './recovery.js';
import {
  productionEffects,
  type ImportContext,
  type ImportEffects,
  type ImportResources,
  type RunOptions,
  type RunReport,
} from './runtime.js';
import * as steps from './steps.js';

export { verifyBaseline } from './baseline.js';
export { matchingDev } from './facts.js';
export { classify } from './failure.js';
export type { RunOptions, RunReport } from './runtime.js';

export function unchangedDecision(
  accepted: AcceptedSnapshot,
  observed: AcceptedSnapshot['observation'],
  lastFetch: string | null,
  now: Date,
): boolean {
  return (
    accepted.observation !== null &&
    observed !== null &&
    sameObservation(accepted.observation, observed) &&
    !refreshOwed(lastFetch, now)
  );
}

/** The manifest is already back; only its HTTP/site verification remains outstanding. */
class RestoreCheckPending extends ImportFailure {
  constructor() {
    super('site_check');
  }
}

async function restored(context: ImportContext): Promise<void> {
  const a = await artifact(context.db, context.artifact!.id);
  const previous = a.rollback;
  if (!previous || !sameManifest(previous, await manifest(context.db)))
    throw new ImportFailure('rollback_failed');
  context.accepted = await adoptServing(
    context.db,
    context.session!,
    context.config.code,
  );
  await fenced(context.db, context.session!, (tx) =>
    tx.execute(sql`update import_runs
    set restoration=${JSON.stringify({ publication: previous, source: context.accepted!.observation, checkedAt: null })}::jsonb
    where id=${context.runId}::uuid`),
  );
  const counts = await servingCounts(context.db, previous);
  const app = context.effects.applicationProbe(
    context.config[context.options.environment]!,
    (await import('../index/cases-index.js')).CASES_INDEX_VERSION,
    { cases: counts.us, eligible: counts.eligible, sample: counts.sample },
  );
  try {
    await context.effects.propagate(app, previous);
    await context.effects.runCanary(context.db, previous, app);
  } catch {
    throw new RestoreCheckPending();
  }
  await fenced(context.db, context.session!, async (tx) => {
    await tx.execute(
      sql`update import_processing set phase='restored' where id=${a.processingId}::uuid`,
    );
    await tx.execute(
      sql`update import_runs set restoration=${JSON.stringify({ publication: previous, source: context.accepted!.observation, checkedAt: context.effects.now().toISOString() })}::jsonb where id=${context.runId}::uuid`,
    );
  });
}
async function switchBack(context: ImportContext): Promise<void> {
  const a = await artifact(context.db, context.artifact!.id);
  if (!a.publication) return;
  const current = await manifest(context.db);
  if (a.rollback && sameManifest(a.rollback, current)) {
    await restored(context);
    return;
  }
  if (!sameManifest(a.publication, current)) {
    // A publisher outside this worker won the lifecycle lock. Never overwrite it.
    await fenced(context.db, context.session!, (tx) =>
      tx.execute(
        sql`update import_processing set phase='abandoned' where id=${a.processingId}::uuid`,
      ),
    );
    context.accepted = await adoptServing(
      context.db,
      context.session!,
      context.config.code,
    );
    return;
  }
  await rollback(
    context.db,
    context.es,
    context.session!,
    a.id,
    a.publication,
    {
      model: context.appConfig.ai.openai.embeddingModel,
      dims: context.appConfig.ai.openai.embeddingDimensions,
    },
    () => context.effects.fault('rollback_started'),
  );
  await context.effects.fault('rollback_committed');
  await restored(context);
}
async function reconcile(context: ImportContext): Promise<void> {
  await checkSwitchHold(context);
  for (const kind of ['cases', 'passages']) {
    const state = await reconcileAlias(
      context.es,
      context.db,
      `${context.appConfig.elasticsearch.indexPrefix}-${kind}`,
      { lockTimeoutMs: 5000 },
    );
    if (state.unresolved.length || state.targets.length > 1)
      throw new ImportFailure('alias_unknown');
  }
  const held = (
    await context.db.execute(
      sql`select switch_hold is not null as held from import_control where id=1`,
    )
  ).rows[0]?.held;
  if (held)
    await fenced(context.db, context.session!, (tx) =>
      tx.execute(
        sql`select import_switch_hold(${context.session!.fence}::uuid,null::jsonb)`,
      ),
    );
}
async function dispatch(context: ImportContext): Promise<RunReport> {
  await steps.initialize(context);
  await steps.establishBaseline(context);
  if (context.options.recertify) return steps.unchanged(context, 'metadata_unchanged');
  await reconcile(context);
  if (
    context.artifact &&
    ['switching', 'published', 'rolling_back'].includes(context.artifact.phase)
  ) {
    const a = context.artifact;
    if (a.rollback || a.phase === 'rolling_back') {
      context.recoveryReason = a.reason ?? 'site_check';
      // Only rollback recovery binds this run to the old file. Fall-through
      // may discover a newer file and must leave its immutable run fields empty.
      await steps.stage(context, 'canary');
      context.fileWork = true;
      const prior = (
        await context.db.execute(sql`select original_reason from import_issues
        where artifact_id=${a.id}::uuid and fixed and not post_success order by created_at desc limit 1`)
      ).rows[0]?.original_reason;
      context.recoveryReason =
        typeof prior === 'string' && IMPORT_REASONS.includes(prior as ImportReason)
          ? (prior as ImportReason)
          : (a.reason ?? 'site_check');
      await switchBack(context);
      await incident(context, new ImportFailure('site_check'), {
        siteState: 'restored',
        originalReason: context.recoveryReason,
      });
      await updateRun(context.db, context.session!, context.runId, {
        step: 'canary',
        result: 'failed',
        reason: 'site_check',
        artifactId: a.id,
      });
      return steps.report(context, 'waiting', null);
    }
    const current = await manifest(context.db);
    if (a.publication && sameManifest(a.publication, current)) {
      context.fileWork = true;
      await steps.resumePublished(context);
      await steps.canary(context);
      await steps.cleanup(context);
      return steps.report(context, 'published', null);
    }
    if (a.publication) {
      await fenced(context.db, context.session!, (tx) =>
        tx.execute(
          sql`update import_processing set phase='abandoned' where id=${a.processingId}::uuid`,
        ),
      );
      context.accepted = await adoptServing(
        context.db,
        context.session!,
        context.config.code,
      );
    } else {
      await fenced(context.db, context.session!, (tx) =>
        tx.execute(
          sql`update import_processing set phase='building' where id=${a.processingId}::uuid`,
        ),
      );
    }
    context.artifact = await artifact(context.db, a.id);
  }
  await steps.preflight(context);
  const decision = await steps.detect(context);
  if (decision === 'waiting') return steps.waiting(context);
  if (decision === 'unchanged')
    return steps.unchanged(
      context,
      context.options.noChange ? 'same_archive' : 'metadata_unchanged',
    );
  if (decision === 'acquire') {
    const acquired = await steps.acquire(context);
    if (acquired === 'waiting') return steps.waiting(context);
    if (acquired === 'unchanged') return steps.unchanged(context, 'same_archive');
  }
  await steps.extract(context);
  const registered = await steps.register(context);
  if (registered !== 'candidate') return steps.unchanged(context, registered);
  await steps.compare(context);
  await steps.load(context);
  await steps.verify(context);
  await steps.plan(context);
  await steps.indexCases(context);
  await steps.indexPassages(context);
  await steps.validate(context);
  await steps.publish(context);
  await steps.canary(context);
  await steps.cleanup(context);
  await context.effects.fault('before_report');
  const result = await steps.report(context, 'published', null);
  await context.space.json(
    join(context.reports, `${context.artifact!.id}-accounting.json`),
    await accountingReport(context.db, context.artifact!.id),
  );
  await context.space.json(
    join(context.reports, `${context.artifact!.id}-result.json`),
    result,
  );
  return result;
}

/** Offline tests supply isolated resources and bounded effects; CLI callers always use productionEffects. */
export async function runWithResources(
  config: ImporterConfig,
  options: RunOptions,
  resources: ImportResources,
  effects: Partial<ImportEffects> = {},
): Promise<RunReport> {
  if (
    (options.forcedDev &&
      (options.environment !== 'dev' || options.noChange || options.recertify)) ||
    (options.recertify && options.noChange)
  )
    throw new ImportFailure('configuration');
  const context: ImportContext = {
    ...resources,
    config,
    options,
    effects: { ...productionEffects, ...effects },
    started: Date.now(),
    reports: join(resources.space.root, 'reports', options.environment),
    runId: '',
    step: 'check',
    artifact: null,
    pending: null,
    blocked: false,
    sourceChecked: false,
    recertifying: false,
    fileWork: false,
    preflightActive: false,
  };
  try {
    return await withImportSession(resources.db, async (session) => {
      context.session = session;
      const result = await dispatch(context);
      // Keep the final report inside the same failure boundary as all other writes:
      // a disk failure after committed success is a separate incident, never a failed import.
      await context.space.json(
        join(config.root, `last-${options.environment}.json`),
        result,
      );
      if (result.result !== 'waiting' && !options.noChange) {
        // The host has a later cleanup boundary of its own. Only that boundary can
        // clear host incidents; worker success cannot erase recurring host failures.
        await fenced(resources.db, session, (tx) =>
          tx.execute(sql`update import_issues
          set resolved_at=clock_timestamp() where resolved_at is null and post_success and origin<>'host'`),
        );
      }
      return result;
    });
  } catch (error) {
    let failure = classify(error);
    const originalReason = context.recoveryReason ?? failure.reason;
    let succeeded: Awaited<ReturnType<typeof committedSuccess>> = null;
    let completed = false;
    await withImportSession(resources.db, async (session) => {
      context.session = session;
      succeeded = await committedSuccess(resources.db, context.runId);
      completed = !!succeeded || (await completedRun(resources.db, context.runId));
      if (completed) {
        await incident(context, failure, { postSuccess: true });
        return;
      }
      let siteState: 'unchanged' | 'restored' | 'restore_unverified' | 'uncertain' =
        'unchanged';
      if (error instanceof RestoreCheckPending) {
        siteState = 'restore_unverified';
      } else if (context.artifact && !context.blocked && !context.recertifying) {
        const fresh = await artifact(resources.db, context.artifact.id);
        context.artifact = fresh;
        if (
          ['switching', 'published', 'rolling_back'].includes(fresh.phase) &&
          fresh.publication &&
          !fresh.canary
        ) {
          try {
            await switchBack(context);
            siteState =
              fresh.publication &&
              sameManifest(
                (await artifact(resources.db, fresh.id)).rollback,
                await manifest(resources.db),
              )
                ? 'restored'
                : 'unchanged';
          } catch (restoreError) {
            // A lost acknowledgement or a later database/probe failure must
            // not turn a proved rollback into an uncertain switch. Only an
            // unproved rollback (or unresolved aliases) needs the hold.
            let rollbackCommitted = restoreError instanceof RestoreCheckPending;
            if (!rollbackCommitted && classify(restoreError).reason !== 'alias_unknown') {
              try {
                const restoredArtifact = await artifact(resources.db, fresh.id);
                rollbackCommitted =
                  restoredArtifact.rollback !== null &&
                  sameManifest(restoredArtifact.rollback, await manifest(resources.db));
              } catch {
                // Unreadable state is not proof of a committed switch.
              }
            }
            if (rollbackCommitted) {
              failure = new ImportFailure('site_check');
              siteState = 'restore_unverified';
            } else {
              failure = new ImportFailure('rollback_failed');
              siteState = 'uncertain';
              await holdSwitch(context, failure.reason);
            }
          }
          if (siteState === 'restored') failure = new ImportFailure('site_check');
          else if ((await artifact(resources.db, fresh.id)).phase === 'abandoned')
            failure = new ImportFailure('interrupted');
        }
      }
      if (failure.reason === 'alias_unknown') {
        siteState = 'uncertain';
        await holdSwitch(context, 'alias_unknown');
      }
      if (!context.blocked)
        await incident(context, failure, { siteState, originalReason });
      if (context.runId)
        await updateRun(resources.db, session, context.runId, {
          step: context.step,
          result: context.blocked ? 'waiting' : failure.result,
          reason: failure.reason,
          artifactId: context.artifact?.id,
          pendingRunId: context.pending?.runId,
          sourceCheckSucceeded: false,
        });
    }).catch(async () => {
      await spoolFailure(
        resources.space,
        options.environment,
        failure,
        context.step,
        context.runId || null,
        context.artifact?.id ?? null,
        {
          code: config.code,
          image: config[options.environment]!.image,
          archive: context.pending?.archive ?? context.artifact?.archive_sha256 ?? null,
          source: context.pending?.observation ?? context.observation ?? null,
          postSuccess: completed,
          suppressFile: processingFile(context),
          preflight: context.preflightActive,
          workKind:
            context.recertifying || options.recertify ? 'recertification' : 'import',
        },
      ).catch(() => undefined);
    });
    const success = succeeded as Awaited<ReturnType<typeof committedSuccess>>;
    if (completed)
      return steps.report(
        context,
        success?.kind === 'publication' ? 'published' : 'unchanged',
        null,
      );
    process.stdout.write(
      `${safeLog(context.step, context.blocked ? 'waiting' : failure.result, failure.reason)}\n`,
    );
    failure.logged = true;
    throw failure;
  }
}

export async function runImport(
  config: ImporterConfig,
  options: RunOptions,
): Promise<RunReport> {
  const appConfig = environmentConfig(config, options.environment);
  const db = createDb(appConfig.databaseIngestUrl!, {
    max: 10,
    applicationName: 'aviation-importer',
    execution: {
      statementTimeoutMs: 600_000,
      idleInTransactionTimeoutMs: 120_000,
      transportTimeoutMs: 660_000,
    },
    onConnectionError: () => {},
  });
  const rawEs = createEsClient(appConfig.elasticsearch, 'write', {
    requestTimeoutMs: 120_000,
    maxRetries: 0,
  });
  try {
    return await runWithResources(config, options, {
      db,
      es: certificationClient(rawEs),
      appConfig,
      space: new ManagedSpace(config.root),
      source: new AvallSource(),
      hostFacts: workerHostFacts(),
    });
  } finally {
    await rawEs.close().catch(() => undefined);
    await closeDb(db);
  }
}
