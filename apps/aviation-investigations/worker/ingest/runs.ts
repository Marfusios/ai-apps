/**
 * Ingestion runs left `running` by a process that died mid-load. Their transaction
 * rolled back, so no generation exists for them; they only need closing.
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../server/db/client.js';
import { ingestionRuns } from '../../server/db/schema/index.js';

/** A run still `running` after this long is reported as stale. */
export const STALE_RUN_MINUTES = 60;

export interface RunningRun {
  id: number;
  startedAt: Date;
  ageMinutes: number;
}

export async function listRunningRuns(db: DbOrTx): Promise<RunningRun[]> {
  const rows = await db
    .select({
      id: ingestionRuns.id,
      startedAt: ingestionRuns.startedAt,
      ageMinutes: sql<number>`floor(extract(epoch from now() - ${ingestionRuns.startedAt}) / 60)::int`,
    })
    .from(ingestionRuns)
    .where(eq(ingestionRuns.status, 'running'))
    .orderBy(asc(ingestionRuns.id));
  return rows;
}

/**
 * Mark runs `running` for longer than `olderThanMinutes` as failed. A load that is in
 * fact still alive then fails at its end (it requires its run to be `running` when it
 * records success), so its generation is never committed.
 */
export async function failStaleRuns(db: DbOrTx, olderThanMinutes: number): Promise<number[]> {
  if (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 1) throw new Error('olderThanMinutes must be a positive integer');
  const rows = await db
    .update(ingestionRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      error: `marked failed: still running after more than ${olderThanMinutes} minutes`,
    })
    .where(
      and(
        eq(ingestionRuns.status, 'running'),
        lt(ingestionRuns.startedAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .returning({ id: ingestionRuns.id });
  return rows.map((r) => r.id).sort((a, b) => a - b);
}
