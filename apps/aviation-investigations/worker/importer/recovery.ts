/** A single bounded owner-only outage record per environment. It is never a successful source check. */
import { join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { ImportFailure, IMPORT_STEPS, IMPORT_REASONS, type ImportStep } from './contracts.js';
import { ManagedSpace, ownedPath } from './files.js';
import { privateJson } from './extraction.js';
import { beginRun, review, updateRun, withImportSession, type ImportSession } from './store.js';
import { environmentConfig, type ImporterConfig } from './config.js';

export const OutageSchema = z.strictObject({
  version: z.literal(1),
  recordedAt: z.iso.datetime(),
  runId: z.uuid().nullable(),
  artifactId: z.uuid().nullable(),
  step: z.enum(IMPORT_STEPS),
  reason: z.enum(IMPORT_REASONS),
  review: z.boolean(),
});
export type Outage = z.infer<typeof OutageSchema>;

export async function spoolFailure(
  space: ManagedSpace,
  environment: 'dev' | 'live',
  failure: ImportFailure,
  step: ImportStep,
  runId: string | null = null,
  artifactId: string | null = null,
): Promise<void> {
  const path = join(space.root, `status-${environment}.json`);
  // Preserve an older unresolved artifact rather than overwrite its only review evidence.
  await ownedPath(space.root, path);
  const existing = await privateJson(path).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (existing !== null) {
    OutageSchema.parse(existing);
    return;
  }
  await space.json(
    path,
    OutageSchema.parse({
      version: 1,
      recordedAt: new Date().toISOString(),
      runId,
      artifactId,
      step,
      reason: failure.reason,
      review: failure.review,
    }),
  );
}
export async function replayOutage(
  db: Db,
  s: ImportSession,
  space: ManagedSpace,
  environment: 'dev' | 'live',
): Promise<void> {
  const path = join(space.root, `status-${environment}.json`);
  await ownedPath(space.root, path);
  const raw = await privateJson(path).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (raw === null) return;
  const parsed = OutageSchema.safeParse(raw);
  if (!parsed.success) throw new ImportFailure('integrity');
  const r = parsed.data;
  if (r.artifactId && r.review) await review(db, s, r.artifactId, r.reason);
  const id = r.runId ?? (await beginRun(db, s, 'automatic'));
  // Save the generated ID before updating: replay after a lost acknowledgment updates the same row.
  if (!r.runId) await space.json(path, { ...r, runId: id });
  await updateRun(db, s, id, {
    step: r.step,
    result: r.review ? 'needs_review' : 'deferred',
    reason: r.reason,
    artifactId: r.artifactId,
    sourceCheckSucceeded: false,
  });
  await unlink(path);
  const dir = await open(space.root, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
/** The dev-first scheduler records a skip without a listing read, ES client or provider configuration. */
export async function recordSkippedLive(config: ImporterConfig): Promise<void> {
  const cfg = environmentConfig(config, 'live'),
    space = new ManagedSpace(config.root);
  const db = createDb(cfg.databaseIngestUrl!, {
    max: 2,
    applicationName: 'aviation-import-skip',
  });
  try {
    await withImportSession(db, async (s) => {
      await replayOutage(db, s, space, 'live');
      const id = await beginRun(db, s, 'automatic');
      await updateRun(db, s, id, {
        step: 'check',
        result: 'skipped_dev_failed',
        reason: 'dev_failed',
        sourceCheckSucceeded: false,
      });
    });
  } catch {
    await spoolFailure(space, 'live', new ImportFailure('dev_failed', false), 'check');
  } finally {
    await closeDb(db);
  }
}
