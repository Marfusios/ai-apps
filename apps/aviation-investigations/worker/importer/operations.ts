/** Reviewed, free operator recovery. These operations never create a generation or reserve money. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { ImportFailure, Sha256, SourceSchema, sameManifest } from './contracts.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { privateBytes, privateJson, seedArchive } from './extraction.js';
import { ManagedSpace, privateDirectory } from './files.js';
import { digest } from './provenance.js';
import { compareSnapshots } from './compare.js';
import {
  control,
  fenced,
  manifest,
  withImportSession,
  type Artifact,
  type AcceptedSnapshot,
  type ImportSession,
} from './store.js';
import { acknowledgePreartifact, preartifactFingerprint, recordRebaseline } from './durable.js';
import {
  productionEffects,
  type ImportEffects,
  type ImportResources,
  type RunOptions,
} from './runtime.js';
import { certificationClient } from './strict-es.js';
import { workerHostFacts } from './facts.js';
import { AvallSource } from './source.js';

const exec = promisify(execFile);
export async function noExtractionContainers(environment: 'dev' | 'live'): Promise<void> {
  try {
    const result = await exec(
      'docker',
      [
        'ps',
        '-a',
        '-q',
        '--filter',
        'label=ai-apps.component=extract',
        '--filter',
        `label=ai-apps.environment=${environment}`,
      ],
      { timeout: 10_000, maxBuffer: 16_384 },
    );
    if (result.stdout.trim()) throw new ImportFailure('cleanup');
  } catch {
    throw new ImportFailure('cleanup');
  }
}

/** Host locks must already be held. Absence is proved, not manufactured by cleanup in this command. */
export async function assertNoActiveWork(
  space: ManagedSpace,
  inspect: () => Promise<void>,
): Promise<void> {
  for (const name of ['extraction.json', 'status-dev.json', 'status-live.json']) {
    const exists = await lstat(join(space.root, name)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) throw new ImportFailure('cleanup');
  }
  if ((await space.registered()).some((name) => name.endsWith('.part')))
    throw new ImportFailure('cleanup');
  const names = await readdir(join(space.root, 'extracts')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  if (names.length > 1024 || names.some((name) => name.includes('.staging-')))
    throw new ImportFailure('cleanup');
  await inspect();
}
const AcknowledgementSchema = z.strictObject({
  version: z.literal('preartifact-ack.v1'),
  environment: z.enum(['dev', 'live']),
  runId: z.uuid(),
  runFingerprint: Sha256,
  cleanupChecked: z.literal(true),
});
export async function acknowledgeWithResources(
  db: Db,
  session: ImportSession,
  space: ManagedSpace,
  environment: 'dev' | 'live',
  runId: string,
  evidenceSha256: string,
  apply: boolean,
  inspect = () => noExtractionContainers(environment),
): Promise<void> {
  z.uuid().parse(runId);
  Sha256.parse(evidenceSha256);
  await assertNoActiveWork(space, inspect);
  const bytes = await privateBytes(
    join(space.root, 'reconciliation', `preartifact-${evidenceSha256}.json`),
  );
  if (createHash('sha256').update(bytes).digest('hex') !== evidenceSha256)
    throw new ImportFailure('integrity');
  const evidence = AcknowledgementSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (
    evidence.environment !== environment ||
    evidence.runId !== runId ||
    evidence.runFingerprint !== (await preartifactFingerprint(db, runId))
  )
    throw new ImportFailure('integrity');
  await acknowledgePreartifact(db, session, runId, evidence.runFingerprint, evidenceSha256, apply);
}

async function baselineObservation(
  resources: ImportResources,
  archive: string,
  seed?: RunOptions['seed'],
) {
  const state = await control(resources.db);
  if (state.accepted?.archive === archive) return state.accepted.observation;
  if (state.pending?.archive === archive) return state.pending.observation;
  const history = await resources.db
    .execute(sql`select accepted->'observation' as observation from import_attestations
    where accepted->>'archive'=${archive} order by created_at desc limit 1`);
  if (history.rows[0]?.observation) return SourceSchema.parse(history.rows[0].observation);
  if (seed?.sha256 === archive) return seed.observation;
  const saved = (await privateJson(
    join(resources.space.root, 'archives', archive, 'manifest.json'),
  ).catch(() => {
    throw new ImportFailure('baseline_required');
  })) as { sha256?: unknown; observation?: unknown };
  if (saved.sha256 !== archive) throw new ImportFailure('integrity');
  return SourceSchema.parse(saved.observation);
}

export async function rebaselineWithResources(
  config: ImporterConfig,
  environment: 'dev' | 'live',
  resources: ImportResources,
  session: ImportSession,
  publicationHash: string,
  apply: boolean,
  overrides: Partial<ImportEffects> = {},
  seed?: RunOptions['seed'],
): Promise<{
  publicationSha256: string;
  applied: boolean;
  resolvedArtifact: string | null;
  resolvedPendingRun: string | null;
}> {
  Sha256.parse(publicationHash);
  const effects = { ...productionEffects, ...overrides };
  // A database-outage spool may contain an uncommitted review. Replay it in an ordinary
  // run before an operator can adopt a baseline; adoption must not erase that outcome.
  for (const name of ['status-dev.json', 'status-live.json', 'extraction.json']) {
    const exists = await lstat(join(resources.space.root, name)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) throw new ImportFailure('cleanup');
  }
  const current = await manifest(resources.db);
  if (!current || digest(current) !== publicationHash) throw new ImportFailure('baseline_changed');
  const unknown = await resources.db.execute(
    sql`select 1 from index_switch_attempts where outcome in ('pending','unknown') limit 1`,
  );
  if (unknown.rows.length) throw new ImportFailure('alias_unknown', false);
  const state = await control(resources.db);
  const latches = await resources.db.execute(
    sql`select * from import_artifacts where needs_review and resolved_at is null order by created_at limit 2`,
  );
  if (latches.rows.length > 1) throw new ImportFailure('verification');
  const abandoned = latches.rows[0] as unknown as Artifact | undefined;
  if (abandoned && ['accounting', 'restore_hold', 'import_cap'].includes(abandoned.reason ?? ''))
    throw new ImportFailure('accounting');
  if (state.pending?.artifactId && state.pending.artifactId !== abandoned?.id)
    throw new ImportFailure('interrupted', false);
  const generation = (
    await resources.db.execute(
      sql`select archive_sha256 from dataset_generations where id=${current.generationId}`,
    )
  ).rows[0];
  if (!generation) throw new ImportFailure('baseline_required');
  const archive = Sha256.parse(generation.archive_sha256);
  if (seed) {
    if (seed.sha256 !== archive) throw new ImportFailure('integrity');
    await seedArchive(resources.space, seed.path, seed.sha256);
    await effects.extractSnapshot(resources.space, seed.sha256, environment, session.assertLocked);
  }
  const snapshot = await effects.readSnapshot(resources.space, archive);
  const reports = join(resources.space.root, 'reports', environment);
  await privateDirectory(reports);
  const verified = await effects.verifyCorpus(resources.db, current.generationId, {
    outDir: reports,
    maxReportBytes: resources.space.limits.report,
    readOnly: !apply,
  });
  if (!verified.ok || verified.conflict) throw new ImportFailure('verification');
  await effects.verifyBaseline(resources.db, snapshot, current);
  const comparison = compareSnapshots(snapshot.facts, snapshot.facts, effects.now());
  const probes = await effects.probeCandidate(
    resources.db,
    resources.es,
    current,
    snapshot.facts,
    comparison,
    {
      model: resources.appConfig.ai.openai.embeddingModel,
      dims: resources.appConfig.ai.openai.embeddingDimensions,
    },
  );
  const stamp = (
    await resources.db
      .execute(sql`select verification_report_sha256,verifier_version from dataset_generations
    where id=${current.generationId} and verification_status='ok'`)
  ).rows[0];
  if (!stamp) throw new ImportFailure('verification');
  const accepted: AcceptedSnapshot = {
    archive,
    content: snapshot.facts.digest,
    csvHash: snapshot.csvHash,
    manifest: current,
    observation: await baselineObservation(resources, archive, seed),
    code: config.code,
    validation: {
      genericReport: String(stamp.verification_report_sha256),
      verifier: verified.verifierVersion,
      probes: probes.hash,
    },
    ...(state.pending ? { resolvedPendingRun: state.pending.runId } : {}),
  };
  const evidence = {
    publication: current,
    verification: verified.reportSha256,
    provenance: snapshot.csvHash,
    probes: probes.hash,
    code: config.code,
    abandonedArtifact: abandoned?.id ?? null,
    pending: state.pending,
  };
  await resources.space.json(join(reports, `rebaseline-${digest(evidence)}.json`), evidence);
  await fenced(resources.db, session, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
    if (!sameManifest(await manifest(tx), current)) throw new ImportFailure('baseline_changed');
    // Dry-run executes the same guarded adoption and rolls it back to its savepoint.
    await tx.execute(sql`savepoint importer_rebaseline_preview`);
    await recordRebaseline(
      tx,
      session,
      accepted,
      evidence,
      abandoned?.id ?? null,
      state.pending?.runId ?? null,
    );
    if (!apply) await tx.execute(sql`rollback to savepoint importer_rebaseline_preview`);
    await tx.execute(sql`release savepoint importer_rebaseline_preview`);
  });
  return {
    publicationSha256: publicationHash,
    applied: apply,
    resolvedArtifact: abandoned?.id ?? null,
    resolvedPendingRun: state.pending?.runId ?? null,
  };
}

export async function recoveryCommand(
  config: ImporterConfig,
  environment: 'dev' | 'live',
  options:
    | { command: 'acknowledge-preartifact'; run: string; evidence: string; apply: boolean }
    | { command: 'rebaseline'; publication: string; apply: boolean; seed?: RunOptions['seed'] },
): Promise<void> {
  const appConfig = environmentConfig(config, environment);
  const db = createDb(appConfig.databaseIngestUrl!, {
    max: 8,
    applicationName: 'aviation-import-recovery',
    onConnectionError: () => {},
  });
  const es = createEsClient(appConfig.elasticsearch, 'write', { maxRetries: 0 });
  const space = new ManagedSpace(config.root);
  try {
    await withImportSession(db, async (session) => {
      if (options.command === 'acknowledge-preartifact') {
        await acknowledgeWithResources(
          db,
          session,
          space,
          environment,
          options.run,
          options.evidence,
          options.apply,
        );
      } else {
        const result = await rebaselineWithResources(
          config,
          environment,
          {
            db,
            es: certificationClient(es),
            appConfig,
            space,
            source: new AvallSource(),
            hostFacts: workerHostFacts(),
          },
          session,
          options.publication,
          options.apply,
          {},
          options.seed,
        );
        await privateDirectory(join(space.root, 'reports', environment));
        await space.json(
          join(space.root, 'reports', environment, `rebaseline-${options.publication}-result.json`),
          result,
        );
      }
    });
  } finally {
    await es.close();
    await closeDb(db);
  }
}
