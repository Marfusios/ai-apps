/** Orchestration only. Step effects live in steps.ts; every acceptance boundary is fenced in durable.ts. */
import { join } from 'node:path';
import { createDb, closeDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { ImportFailure, safeLog, type ImportStep } from './contracts.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { ManagedSpace } from './files.js';
import { AvallSource, refreshOwed, sameObservation } from './source.js';
import { workerHostFacts } from './facts.js';
import { certificationClient } from './strict-es.js';
import { committedSuccess, setPending } from './durable.js';
import { classify } from './failure.js';
import {
  accountingReport,
  artifact,
  control,
  review,
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
  return sameObservation(accepted.observation, observed) && !refreshOwed(lastFetch, now);
}

async function dispatch(context: ImportContext): Promise<RunReport> {
  await steps.initialize(context);
  await steps.preflight(context);
  await steps.establishBaseline(context);
  const decision = await steps.detect(context);
  if (decision === 'unchanged')
    return steps.unchanged(
      context,
      context.options.noChange ? 'same_archive' : 'metadata_unchanged',
    );
  await steps.acquire(context);
  await steps.extract(context);
  if ((await steps.register(context)) === 'unchanged')
    return steps.unchanged(context, 'same_content');
  await steps.compare(context);
  if (context.artifact!.publication) {
    await steps.resumePublished(context);
  } else {
    await steps.load(context);
    await steps.verify(context);
    await steps.plan(context);
    await steps.indexCases(context);
    await steps.indexPassages(context);
    await steps.validate(context);
    await steps.publish(context);
  }
  await steps.canary(context);
  await steps.cleanup(context);
  await context.effects.fault('before_report');
  const result = await steps.report(context, 'published', null);
  await context.space.json(
    join(context.reports, `${context.artifact!.id}-accounting.json`),
    await accountingReport(context.db, context.artifact!.id),
  );
  await context.space.json(join(context.reports, `${context.artifact!.id}-result.json`), result);
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
  const context = {
    ...resources,
    config,
    options,
    effects: { ...productionEffects, ...effects },
    started: Date.now(),
    reports: join(resources.space.root, 'reports', options.environment),
    runId: '',
    step: 'check' as ImportStep,
    artifact: null,
    pending: null,
    blocked: false,
    sourceChecked: false,
  } as ImportContext;
  try {
    return await withImportSession(resources.db, async (session) => {
      context.session = session;
      return dispatch(context);
    });
  } catch (error) {
    const success = await committedSuccess(resources.db, context.runId).catch(() => null);
    if (success) return steps.report(context, 'published', null);
    const failure = classify(error);
    await withImportSession(resources.db, async (session) => {
      // Re-read after acquiring a fresh fence: another worker or a lost COMMIT may already have resolved this run.
      if (await committedSuccess(resources.db, context.runId)) return;
      if (!context.blocked && failure.review) {
        if (context.artifact) {
          const fresh = await artifact(resources.db, context.artifact.id);
          if (!fresh.needs_review && !fresh.resolved_at)
            await review(resources.db, session, fresh.id, failure.reason);
        }
        const pending = (await control(resources.db)).pending;
        if (pending && pending.runId === context.pending?.runId && !pending.needsReview) {
          await setPending(resources.db, session, {
            ...pending,
            needsReview: true,
            reason: failure.reason,
          });
        }
      }
      if (context.runId)
        await updateRun(resources.db, session, context.runId, {
          step: context.step,
          result: context.blocked ? 'deferred' : failure.result,
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
      ).catch(() => undefined);
    });
    process.stdout.write(
      `${safeLog(context.step, context.blocked ? 'deferred' : failure.result, failure.reason)}\n`,
    );
    throw failure;
  }
}

export async function runImport(config: ImporterConfig, options: RunOptions): Promise<RunReport> {
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
