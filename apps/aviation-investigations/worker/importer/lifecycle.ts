import { sql } from 'drizzle-orm';
import type { Client } from '@elastic/elasticsearch';
import type { Db } from '../../server/db/client.js';
import { pinGeneration } from '../../server/db/generations.js';
import { publishGeneration } from '../index/publish.js';
import { ImportFailure, sameManifest, type ManifestIdentity } from './contracts.js';
import {
  assertFence,
  artifact,
  checkCertificate,
  fenced,
  IMPORT_TRANSACTION_LOCK,
  manifest,
  registerCandidate,
  type Certificate,
  type ImportSession,
} from './store.js';
import { servingCounts, checkShrink } from './automatic.js';
import { certificationClient } from './strict-es.js';

/** Pin the exact previous pair too: a later same-generation operator publication may replace its manifest row. */
export async function protectBaseline(
  db: Db,
  s: ImportSession,
  id: string,
  baseline: ManifestIdentity,
): Promise<void> {
  await fenced(db, s, (tx) =>
    pinGeneration(tx, baseline.generationId, `import-previous:${id}`),
  );
  for (const index of [baseline.casesIndex, baseline.passagesIndex]) {
    const r =
      await db.execute(sql`select build_id from index_builds where index_name=${index}
      and generation_id=${baseline.generationId} and deletion_requested_at is null and deleted_at is null`);
    if (r.rows.length !== 1) throw new ImportFailure('baseline_required');
    await registerCandidate(
      db,
      s,
      id,
      index,
      String(r.rows[0]!.build_id),
      baseline.generationId,
    );
  }
}
export async function activate(
  db: Db,
  es: Client,
  s: ImportSession,
  certificate: Certificate,
  embedding: { model: string; dims: number },
  validateDev?: () => Promise<void>,
): Promise<ManifestIdentity> {
  const a = await artifact(db, certificate.artifactId);
  if (a.publication) {
    if (!a.rollback && sameManifest(a.publication, await manifest(db)))
      return a.publication;
    throw new ImportFailure('baseline_changed');
  }
  await fenced(db, s, (tx) =>
    tx.execute(
      sql`update import_processing set phase='switching' where artifact_id=${certificate.artifactId}::uuid and active`,
    ),
  );
  try {
    await publishGeneration(certificationClient(es), db, {
      ...certificate.candidate,
      embedding,
      importGuard: {
        lockKey: IMPORT_TRANSACTION_LOCK,
        async validate(tx) {
          await assertFence(tx, s);
          const before = await manifest(tx);
          if (!before) throw new ImportFailure('configuration');
          checkShrink(
            await servingCounts(tx, {
              ...before,
              generationId: certificate.candidate.generationId,
            }),
            await servingCounts(tx, before),
          );
          if (!sameManifest(before, certificate.baseline)) {
            // The lifecycle lock is held. A legitimate external publication becomes the
            // rollback target; informational comparisons never require permission.
            await pinGeneration(
              tx,
              before.generationId,
              `import-previous:${certificate.artifactId}`,
            );
            for (const index of [before.casesIndex, before.passagesIndex]) {
              const r = await tx.execute(
                sql`select build_id from index_builds where index_name=${index} and generation_id=${before.generationId} and deletion_requested_at is null and deleted_at is null`,
              );
              if (r.rows.length !== 1) throw new ImportFailure('integrity');
              await tx.execute(sql`insert into import_index_refs(index_name,artifact_id,build_id,generation_id)
                values(${index},${certificate.artifactId}::uuid,${String(r.rows[0]!.build_id)},${before.generationId}) on conflict do nothing`);
            }
            certificate = { ...certificate, baseline: before };
            await tx.execute(sql`update import_processing set baseline=${JSON.stringify(before)}::jsonb,certificate=${JSON.stringify(certificate)}::jsonb
              where artifact_id=${certificate.artifactId}::uuid and active and publication is null`);
          }
          await checkCertificate(tx, s, certificate);
          await validateDev?.();
        },
        async record(tx) {
          const current = await manifest(tx);
          if (!current) throw new ImportFailure('integrity');
          await tx.execute(sql`update import_processing set publication=${JSON.stringify(current)}::jsonb,phase='published'
          where artifact_id=${certificate.artifactId}::uuid and active and publication is null`);
        },
      },
    });
  } catch (error) {
    // Commit acknowledgement loss: only the jointly committed identity proves completion.
    const saved = await artifact(db, certificate.artifactId).catch(() => null);
    const current = await manifest(db).catch(() => null);
    if (saved?.publication && !saved.rollback && sameManifest(saved.publication, current))
      return saved.publication;
    throw error;
  }
  const saved = await artifact(db, certificate.artifactId);
  if (!saved.publication || !sameManifest(saved.publication, await manifest(db)))
    throw new ImportFailure('baseline_changed');
  return saved.publication;
}
/** One conditional switch. No operational alias request, ledger mutation or database restore. */
export async function rollback(
  db: Db,
  es: Client,
  s: ImportSession,
  id: string,
  expected: ManifestIdentity,
  embedding: { model: string; dims: number },
  onStarted?: () => Promise<void>,
): Promise<ManifestIdentity> {
  const a = await artifact(db, id);
  if (a.rollback && sameManifest(a.rollback, await manifest(db))) return a.rollback; // lost acknowledgement
  if (!a.baseline || !sameManifest(a.publication, expected) || a.rollback)
    throw new ImportFailure('baseline_changed');
  await fenced(db, s, (tx) =>
    tx.execute(
      sql`update import_processing set phase='rolling_back' where artifact_id=${id}::uuid and active`,
    ),
  );
  await onStarted?.();
  try {
    await publishGeneration(certificationClient(es), db, {
      ...a.baseline,
      embedding,
      importGuard: {
        lockKey: IMPORT_TRANSACTION_LOCK,
        async validate(tx) {
          await assertFence(tx, s);
          const fresh = await artifact(tx, id);
          if (
            fresh.rollback ||
            !sameManifest(await manifest(tx), expected) ||
            !sameManifest(fresh.publication, expected)
          ) {
            throw new ImportFailure('baseline_changed');
          }
          for (const index of [a.baseline!.casesIndex, a.baseline!.passagesIndex]) {
            const r =
              await tx.execute(sql`select 1 from import_index_refs where index_name=${index}
            and artifact_id=${id}::uuid and released_at is null`);
            if (!r.rows.length) throw new ImportFailure('integrity');
          }
        },
        async record(tx) {
          const current = await manifest(tx);
          await tx.execute(sql`update import_processing set rollback=${JSON.stringify(current)}::jsonb,
          canary=null,phase='rolling_back',reason='site_check' where artifact_id=${id}::uuid and active`);
        },
      },
    });
  } catch (error) {
    const saved = await artifact(db, id).catch(() => null);
    if (
      saved?.rollback &&
      sameManifest(saved.rollback, await manifest(db).catch(() => null))
    )
      return saved.rollback;
    throw error;
  }
  const saved = await artifact(db, id);
  if (!saved.rollback) throw new ImportFailure('integrity');
  return saved.rollback;
}
