/** Durable recovery boundaries. Local reports are evidence; PostgreSQL alone decides acceptance. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../server/db/client.js';
import {
  ImportFailure,
  IMPORT_REASONS,
  Sha256,
  SourceSchema,
  sameManifest,
} from './contracts.js';
import { digest } from './provenance.js';
import {
  artifact,
  fenced,
  manifest,
  updateRunTransaction,
  type AcceptedSnapshot,
  type Canary,
  type ImportSession,
  type PendingFetch,
} from './store.js';

export const PendingSchema = z.strictObject({
  archive: Sha256,
  observation: SourceSchema,
  fetchedAt: z.iso.datetime(),
  runId: z.uuid(),
  artifactId: z.uuid().nullable(),
  content: Sha256.nullable(),
  attempts: z.number().int().min(0),
  needsReview: z.boolean(),
  reason: z.enum(IMPORT_REASONS).nullable(),
});

export async function setPendingTransaction(
  tx: DbOrTx,
  session: ImportSession,
  value: PendingFetch,
  fetched = false,
): Promise<void> {
  const safe = PendingSchema.safeParse(value);
  if (!safe.success) throw new ImportFailure('integrity');
  await tx.execute(
    sql`select import_set_pending(${session.fence}::uuid,${JSON.stringify(safe.data)}::jsonb,${fetched})`,
  );
}

export async function setPending(
  db: Db,
  session: ImportSession,
  value: PendingFetch,
  fetched = false,
): Promise<void> {
  await fenced(db, session, (tx) => setPendingTransaction(tx, session, value, fetched));
}

/** A review blocks acquisition; a later listing is only an observation, never a new candidate. */
export async function observePending(
  db: Db,
  session: ImportSession,
  value: z.infer<typeof SourceSchema>,
): Promise<void> {
  const observation = SourceSchema.parse(value);
  await fenced(db, session, (tx) =>
    tx.execute(
      sql`select import_observe_pending(${session.fence}::uuid,${JSON.stringify(observation)}::jsonb)`,
    ),
  );
}

export interface Success {
  runId: string;
  artifactId: string | null;
  kind: 'publication' | 'recertification';
  accepted: AcceptedSnapshot;
  canary: Canary;
  evidence: string;
  sourceChecked: boolean;
}

/** The run and its exact canary become successful at the same commit as acceptance. */
export async function recordSuccess(
  db: Db,
  session: ImportSession,
  success: Success,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
    const publication = success.accepted.manifest;
    if (
      !sameManifest(await manifest(tx), publication) ||
      !sameManifest(success.canary.publication, publication)
    ) {
      throw new ImportFailure('baseline_changed');
    }
    if (
      success.canary.archive !== success.accepted.archive ||
      success.canary.content !== success.accepted.content ||
      success.canary.code !== success.accepted.code
    )
      throw new ImportFailure('integrity');
    if (success.artifactId) {
      const saved = await artifact(tx, success.artifactId);
      if (saved.rollback && success.kind === 'publication') throw new ImportFailure('integrity');
      if (
        saved.archive_sha256 !== success.accepted.archive ||
        saved.content_sha256 !== success.accepted.content ||
        !sameManifest(saved.publication, publication)
      )
        throw new ImportFailure('integrity');
      if (success.kind === 'publication') {
        await tx.execute(
          sql`select import_check_budget(${saved.id}::uuid,${session.fence}::uuid,0::bigint)`,
        );
      }
      await tx.execute(
        sql`update import_processing set canary=${JSON.stringify(success.canary)}::jsonb,phase='complete' where artifact_id=${saved.id}::uuid and active`,
      );
    }
    await tx.execute(sql`select import_record_attestation(${session.fence}::uuid,
      ${success.runId}::uuid,${success.artifactId}::uuid,${success.kind},${JSON.stringify(publication)}::jsonb,
      ${JSON.stringify(success.accepted)}::jsonb,${JSON.stringify(success.canary)}::jsonb,${success.evidence})`);
    if (success.kind === 'recertification') {
      await tx.execute(sql`select import_adopt(${session.fence}::uuid,${JSON.stringify(success.accepted)}::jsonb)`);
    } else {
      await tx.execute(sql`select import_accept(${session.fence}::uuid,${JSON.stringify(success.accepted)}::jsonb,false)`);
      await tx.execute(sql`update import_issues set resolved_at=clock_timestamp() where resolved_at is null`);
      await tx.execute(sql`update import_runs set good_check=true where id=${success.runId}::uuid`);
    }
    await tx.execute(
      sql`update import_runs set success_publication=${JSON.stringify(publication)}::jsonb where id=${success.runId}::uuid`,
    );
    await updateRunTransaction(tx, success.runId, {
      step: 'complete',
      result: success.kind === 'publication' ? 'published' : 'unchanged',
      artifactId: success.artifactId,
      observedSha256: success.accepted.archive,
      sourceCheckSucceeded: success.sourceChecked,
      canaryPassed: success.kind === 'publication',
    });
  });
}

/** An acknowledgement/report failure after commit cannot turn committed acceptance into a review. */
export async function committedSuccess(db: Db, runId: string | null): Promise<Success | null> {
  if (!runId) return null;
  const result =
    await db.execute(sql`select t.*,r.source_check_succeeded from import_attestations t
    join import_runs r on r.id=t.run_id where t.run_id=${runId}::uuid
    and ((t.kind='publication' and r.canary_passed and r.result='published')
      or (t.kind='recertification' and not r.canary_passed and r.result='unchanged'))`);
  const row = result.rows[0];
  if (!row) return null;
  const accepted = row.accepted as AcceptedSnapshot;
  return {
    runId,
    artifactId: row.artifact_id as string | null,
    kind: row.kind as Success['kind'],
    accepted,
    canary: row.canary as Canary,
    evidence: String(row.evidence_sha256),
    sourceChecked: row.source_check_succeeded === true,
  };
}

export async function recordLegacy(
  db: Db,
  session: ImportSession,
  accepted: AcceptedSnapshot,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await tx.execute(sql`select import_record_attestation(${session.fence}::uuid,null::uuid,null::uuid,
      'legacy',${JSON.stringify(accepted.manifest)}::jsonb,${JSON.stringify(accepted)}::jsonb,null::jsonb,${digest(accepted)})`);
    await tx.execute(
      sql`select import_accept(${session.fence}::uuid,${JSON.stringify(accepted)}::jsonb,false)`,
    );
  });
}

export async function linkPendingArtifact(
  db: Db,
  session: ImportSession,
  pending: PendingFetch,
  runId: string,
  artifactId: string,
): Promise<void> {
  await fenced(db, session, async (tx) => {
    await setPendingTransaction(tx, session, pending);
    await tx.execute(sql`update import_runs set artifact_id=${artifactId}::uuid
      where id in (${runId}::uuid,${pending.runId}::uuid) and artifact_id is null`);
  });
}
