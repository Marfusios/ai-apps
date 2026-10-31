import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../server/db/client.js';
import {
  LIFECYCLE_LOCK_KEY,
  pinGeneration,
  VERIFIER_VERSION,
} from '../../server/db/generations.js';
import { digest } from './provenance.js';
import {
  ImportFailure,
  sameManifest,
  type ManifestIdentity,
  type ImportStep,
  type ImportResult,
  type ImportReason,
  type SourceObservation,
} from './contracts.js';

export const IMPORT_SESSION_LOCK = 7_311_905_027;
export const IMPORT_TRANSACTION_LOCK = 7_311_905_028;
export interface ImportSession {
  fence: string;
  assertLocked(): void;
}
export interface Artifact {
  id: string;
  environment: 'dev' | 'live';
  archive_sha256: string;
  content_sha256: string;
  needs_review: boolean;
  reason: ImportReason | null;
  generation_id: string | null;
  attempts: number;
  baseline: ManifestIdentity | null;
  publication: ManifestIdentity | null;
  certificate: Certificate | null;
  canary: Canary | null;
  approved: Approval | null;
  rollback: ManifestIdentity | null;
  resolved_at: string | null;
}
export interface Certificate {
  version: 'import-certificate.v1';
  artifactId: string;
  archive: string;
  content: string;
  environment: 'dev' | 'live';
  baseline: ManifestIdentity;
  candidate: {
    generationId: number;
    casesIndex: string;
    passagesIndex: string;
    casesBuildId: string;
    passagesBuildId: string;
  };
  code: string;
  deployedCode: string;
  policy: 'snapshot-monthly.v1';
  genericReport: string;
  comparison: string;
  probes: string;
  approvedReasons: string[];
  dev: Canary | null;
}
export interface Canary {
  publication: ManifestIdentity;
  archive: string;
  content: string;
  code: string;
  deployedCode: string;
  probes: string;
  checkedAt: string;
}
export interface Approval {
  archive: string;
  environment: 'dev' | 'live';
  baseline: ManifestIdentity;
  policy: string;
  code: string;
  report: string;
  reasons: string[];
  cases: string[];
}

export async function withImportSession<T>(
  db: Db,
  fn: (session: ImportSession) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    ...db.$client.options,
    application_name: 'aviation-import-lock',
  });
  let lost = false;
  client.on('error', () => {
    lost = true;
  });
  client.on('end', () => {
    lost = true;
  });
  try {
    await client.connect();
    const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
      IMPORT_SESSION_LOCK,
    ]);
    if (!r.rows[0]?.ok) throw new ImportFailure('busy', false);
    const claim = await client.query<{ fence: string }>('select import_claim()::text as fence');
    const fence = claim.rows[0]?.fence;
    if (!fence) throw new ImportFailure('accounting');
    return await fn({
      fence,
      assertLocked() {
        if (lost) throw new ImportFailure('lock_lost', false, 'cancelled');
      },
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
export async function assertFence(tx: DbOrTx, session: ImportSession): Promise<void> {
  session.assertLocked();
  await tx.execute(sql`select set_config('aviation.import_fence',${session.fence},true)`);
  await tx.execute(sql`select import_assert_fence(${session.fence}::uuid)`);
}
export async function fenced<T>(
  db: Db,
  session: ImportSession,
  fn: (tx: DbOrTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await assertFence(tx, session);
    return fn(tx);
  });
}
export async function manifest(db: DbOrTx): Promise<ManifestIdentity | null> {
  // Retain PostgreSQL's full precision: JS Date milliseconds would miss a fast same-generation republication.
  const r = await db.execute(sql`select generation_id, cases_index, passages_index,
    to_char(published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at
    from dataset_manifests where active`);
  const v = r.rows[0] as
    | {
        generation_id: string;
        cases_index: string;
        passages_index: string | null;
        published_at: string;
      }
    | undefined;
  return v?.passages_index
    ? {
        generationId: Number(v.generation_id),
        casesIndex: v.cases_index,
        passagesIndex: v.passages_index,
        publishedAt: v.published_at,
      }
    : null;
}
export async function artifact(db: DbOrTx, id: string): Promise<Artifact> {
  const r = await db.execute(sql`select * from import_artifacts where id=${id}::uuid`);
  if (!r.rows[0]) throw new ImportFailure('integrity');
  return r.rows[0] as unknown as Artifact;
}
export async function registerArtifact(
  db: Db,
  session: ImportSession,
  environment: 'dev' | 'live',
  archive: string,
  content: string,
  baseline: ManifestIdentity,
): Promise<Artifact> {
  return fenced(db, session, async (tx) => {
    await tx.execute(sql`insert into import_artifacts(environment,archive_sha256,content_sha256,baseline)
      values(${environment},${archive},${content},${JSON.stringify(baseline)}::jsonb)
      on conflict(environment,archive_sha256) do nothing`);
    const r = await tx.execute(
      sql`select * from import_artifacts where environment=${environment} and archive_sha256=${archive}`,
    );
    const a = r.rows[0] as unknown as Artifact;
    if (a.content_sha256 !== content) throw new ImportFailure('integrity');
    return a;
  });
}
/** Checks age even for cache-only resumes, while locks prevent spending/publication races. */
export async function resumeArtifact(db: Db, session: ImportSession, id: string): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(sql`select import_check_budget(${id}::uuid,${session.fence}::uuid,0::bigint)`);
    const r = await tx.execute(
      sql`update import_artifacts set attempts=attempts+1 where id=${id}::uuid and attempts<4 returning id`,
    );
    if (r.rows.length !== 1) throw new ImportFailure('interrupted', true);
  });
}
export async function budgetRemaining(db: Db, session: ImportSession, id: string): Promise<number> {
  return fenced(db, session, async (tx) => {
    const r = await tx.execute(
      sql`select import_check_budget(${id}::uuid,${session.fence}::uuid,0::bigint) as charged`,
    );
    return (500_000 - Number(r.rows[0]?.charged)) / 1e6;
  });
}
/** Private bounded evidence only, never admission state. No request text, keys, lease tokens or account identifiers. */
export async function accountingReport(
  db: Db,
  id: string,
): Promise<{ reservationUsd: number; chargedUsd: number; attempts: unknown[] }> {
  const rows =
    await db.execute(sql`select id::text,status,usd::float8 as reserved,"charged_usd"::float8 as charged,
    uncertain,created_at::text,settled_at::text from reservations where import_artifact_id=${id}::uuid order by id limit 10001`);
  if (rows.rows.length > 10_000) throw new ImportFailure('storage');
  return {
    reservationUsd: rows.rows.reduce((n, r) => n + Number(r.reserved), 0),
    chargedUsd: rows.rows.reduce(
      (n, r) => n + Number(r.status === 'open' ? r.reserved : r.charged),
      0,
    ),
    attempts: rows.rows,
  };
}
export async function linkGeneration(
  tx: DbOrTx,
  session: ImportSession,
  id: string,
  generation: number,
): Promise<void> {
  await assertFence(tx, session);
  const r = await tx.execute(sql`update import_artifacts set generation_id=${generation}
    where id=${id}::uuid and generation_id is null returning id`);
  if (r.rows.length !== 1) throw new ImportFailure('integrity');
  await pinGeneration(tx, generation, `import:${id}`);
}
/** Called before a builder releases its own pin/liveness lock. */
export async function registerCandidate(
  db: Db,
  session: ImportSession,
  id: string,
  indexName: string,
  buildId: string,
  generation: number,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LIFECYCLE_LOCK_KEY})`);
    await tx.execute(sql`insert into import_index_refs(index_name,artifact_id,build_id,generation_id)
      values(${indexName},${id}::uuid,${buildId},${generation}) on conflict(index_name,artifact_id) do nothing`);
    const r =
      await tx.execute(sql`select 1 from import_index_refs where index_name=${indexName} and artifact_id=${id}::uuid
      and build_id=${buildId} and generation_id=${generation} and released_at is null`);
    if (r.rows.length !== 1) throw new ImportFailure('integrity');
  });
}
export async function review(
  db: Db,
  session: ImportSession,
  id: string,
  reason: ImportReason,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(
      sql`update import_artifacts set needs_review=true,reason=${reason} where id=${id}::uuid`,
    );
  });
}
export async function beginRun(
  db: Db,
  session: ImportSession,
  mode: 'automatic' | 'forced_dev',
): Promise<string> {
  return fenced(db, session, async (tx) => {
    // Claiming this fence proves the former lock session is gone. Keep failed daily checks bounded too.
    await tx.execute(sql`update import_runs set result='deferred',reason='interrupted',finished_at=clock_timestamp(),
      source_check_succeeded=false where result='running'`);
    const r = await tx.execute(sql`insert into import_runs(mode) values(${mode}) returning id`);
    await tx.execute(sql`select import_prune_runs(${session.fence}::uuid)`);
    return String(r.rows[0]?.id);
  });
}
export async function updateRun(
  db: Db,
  session: ImportSession,
  id: string,
  value: {
    step: ImportStep;
    result: ImportResult;
    reason?: ImportReason | null;
    source?: SourceObservation | null;
    artifactId?: string | null;
    sourceCheckSucceeded?: boolean;
    canaryPassed?: boolean;
    observedSha256?: string;
    pendingRunId?: string;
  },
): Promise<void> {
  await fenced(db, session, (tx) => updateRunTransaction(tx, id, value));
}

/** Caller holds the fresh fence; canary acceptance records the run in that same transaction. */
export async function updateRunTransaction(
  tx: DbOrTx,
  id: string,
  value: Parameters<typeof updateRun>[3],
): Promise<void> {
  await tx.execute(sql`update import_runs set step=${value.step},result=${value.result},reason=${value.reason ?? null},
      heartbeat_at=clock_timestamp(),finished_at=case when ${value.result}='running' then null else clock_timestamp() end,
      source=coalesce(${value.source ? JSON.stringify(value.source) : null}::jsonb,source),
      observed_sha256=coalesce(${value.observedSha256 ?? null},observed_sha256),
      pending_run_id=coalesce(${value.pendingRunId ?? null}::uuid,pending_run_id),
      artifact_id=coalesce(${value.artifactId ?? null}::uuid,artifact_id),
      source_check_succeeded=coalesce(${value.sourceCheckSucceeded ?? null}::boolean,source_check_succeeded),
      canary_passed=canary_passed or ${value.canaryPassed === true} where id=${id}::uuid
      and (not canary_passed or ${value.result}='published')`);
  // A post-success report/spool failure cannot erase an acknowledged canary. Only guarded rollback can.
  // After the retention cutoff copy the last report snapshot, never a pruned ledger total; this is not admission state.
  await tx.execute(sql`update import_runs r set reported_cost_usd=case when exists(
      select 1 from import_artifacts a where a.id=r.artifact_id
        and a.first_reservation_at<=clock_timestamp()-interval '2136 hours')
      then coalesce((select rr.reported_cost_usd from import_runs rr where rr.artifact_id=r.artifact_id and rr.id<>r.id
        order by rr.checked_at desc limit 1),r.reported_cost_usd)
      else coalesce((select sum(case when status='open' then usd else charged_usd end)
        from reservations where import_artifact_id=r.artifact_id),0) end where r.id=${id}::uuid`);
}

export async function saveCertificate(
  db: Db,
  session: ImportSession,
  certificate: Certificate,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(
      sql`update import_artifacts set certificate=${JSON.stringify(certificate)}::jsonb where id=${certificate.artifactId}::uuid`,
    );
  });
}

export interface AcceptedSnapshot {
  archive: string;
  content: string;
  csvHash: string;
  manifest: ManifestIdentity;
  observation: SourceObservation;
  code: string;
  resolvedPendingRun?: string;
  validation?: { genericReport: string; verifier: string; probes: string };
}
export interface PendingFetch {
  archive: string;
  observation: SourceObservation;
  fetchedAt: string;
  runId: string;
  artifactId: string | null;
  content: string | null;
  attempts: number;
  needsReview: boolean;
  reason: ImportReason | null;
}
export async function control(
  db: Db,
): Promise<{
  accepted: AcceptedSnapshot | null;
  lastRemoteFetchAt: string | null;
  pending: PendingFetch | null;
  lastFetched:
    | (PendingFetch & { state: 'pending' | 'needs_review' | 'accepted' | 'reviewed_abandoned' })
    | null;
  pendingObservation: SourceObservation | null;
}> {
  const r = await db.execute(
    sql`select accepted,pending,last_fetched,pending_observation,last_remote_fetch_at::text as fetched from import_control where id=1`,
  );
  if (!r.rows[0]) throw new ImportFailure('accounting');
  return {
    accepted: r.rows[0].accepted as AcceptedSnapshot | null,
    lastRemoteFetchAt: r.rows[0].fetched as string | null,
    pending: r.rows[0].pending as PendingFetch | null,
    lastFetched: r.rows[0].last_fetched as
      | (PendingFetch & { state: 'pending' | 'needs_review' | 'accepted' | 'reviewed_abandoned' })
      | null,
    pendingObservation: r.rows[0].pending_observation as SourceObservation | null,
  };
}
export async function accept(
  db: Db,
  session: ImportSession,
  value: AcceptedSnapshot | null,
  fetched = false,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(sql`select import_accept(${session.fence}::uuid,
    ${value ? JSON.stringify(value) : null}::jsonb,${fetched})`);
  });
}
/** Packaging changes reuse the logical import identity and its original cap/attempt counter. */
export async function findContent(
  db: Db,
  environment: 'dev' | 'live',
  content: string,
): Promise<Artifact | null> {
  const r =
    await db.execute(sql`select * from import_artifacts where environment=${environment} and content_sha256=${content}
    order by created_at limit 1`);
  return (r.rows[0] as unknown as Artifact | undefined) ?? null;
}
/** Executes ON the publication connection, from before validation through the guarded activation transaction. */
export async function checkCertificate(
  tx: DbOrTx,
  session: ImportSession,
  expected: Certificate,
): Promise<void> {
  await assertFence(tx, session);
  const a = await artifact(tx, expected.artifactId);
  if (expected.environment === 'live') {
    const canary = expected.dev;
    if (
      !canary ||
      canary.archive !== expected.archive ||
      canary.content !== expected.content ||
      canary.code !== expected.code ||
      canary.deployedCode !== expected.deployedCode ||
      !Number.isFinite(Date.parse(canary.checkedAt)) ||
      Date.parse(canary.checkedAt) > Date.now() ||
      Date.now() - Date.parse(canary.checkedAt) > 86_400_000
    ) {
      throw new ImportFailure('dev_failed', false);
    }
  }
  if (
    !a.certificate ||
    a.needs_review ||
    Number(a.generation_id) !== expected.candidate.generationId ||
    expected.policy !== 'snapshot-monthly.v1' ||
    expected.version !== 'import-certificate.v1' ||
    a.archive_sha256 !== expected.archive ||
    a.content_sha256 !== expected.content ||
    a.environment !== expected.environment ||
    digest(a.certificate) !== digest(expected)
  )
    throw new ImportFailure('integrity');
  if (!sameManifest(await manifest(tx), expected.baseline))
    throw new ImportFailure('baseline_changed');
  await tx.execute(sql`select import_check_budget(${a.id}::uuid,${session.fence}::uuid,0::bigint)`);
  const r =
    await tx.execute(sql`select archive_sha256,verification_status,verifier_version,verification_report_sha256
    from dataset_generations where id=${expected.candidate.generationId}`);
  const g = r.rows[0];
  if (
    g?.archive_sha256 !== expected.archive ||
    g.verification_status !== 'ok' ||
    g.verifier_version !== VERIFIER_VERSION ||
    g.verification_report_sha256 !== expected.genericReport
  )
    throw new ImportFailure('verification');
  for (const [index, build] of [
    [expected.candidate.casesIndex, expected.candidate.casesBuildId],
    [expected.candidate.passagesIndex, expected.candidate.passagesBuildId],
  ]) {
    const refs =
      await tx.execute(sql`select 1 from import_index_refs where artifact_id=${a.id}::uuid
      and index_name=${index} and build_id=${build} and generation_id=${expected.candidate.generationId} and released_at is null`);
    if (refs.rows.length !== 1) throw new ImportFailure('integrity');
  }
}
