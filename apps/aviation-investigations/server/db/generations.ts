/**
 * Dataset generations and manifests (amendment A6). The active manifest names the
 * generation and the two search indices built for it; the API pins every request to
 * it. Status changes happen only in the migrator-owned database functions of
 * migration 0003 (`publish_manifest`, `prune_generation`, `record_verification`,
 * `seal_generation`), which share one advisory lock with verification.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx, Schema } from './client.js';
import * as schema from './schema/index.js';
import {
  datasetGenerations,
  datasetManifests,
  generationPins,
  type GenerationStatus,
  type VerificationStatus,
} from './schema/index.js';

/** Advisory lock shared by verification, publication and pruning (also in migration 0003). */
export const LIFECYCLE_LOCK_KEY = 7_311_905_022;

/**
 * Version of the generation verifier (`worker/ingest/verify.ts`). Bump it whenever its
 * checks change: publication requires a successful verification by this version.
 */
export const VERIFIER_VERSION = 'verify-v2';

/** A refusal or conflict raised by a lifecycle function, with its SQLSTATE. */
export class LifecycleError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined, cause?: unknown) {
    super(message, { cause });
    this.name = 'LifecycleError';
    this.code = code;
  }
}

/** Unwrap Drizzle's query error into the database message (never the query parameters). */
export function lifecycleError(err: unknown): unknown {
  const cause = (err as { cause?: unknown }).cause;
  const pg = (cause instanceof Error ? cause : err) as Error & { code?: string };
  if (pg instanceof Error && typeof pg.code === 'string') return new LifecycleError(pg.message, pg.code, err);
  return err;
}

async function call(db: DbOrTx | NodePgDatabase<Schema>, query: SQL): Promise<Record<string, unknown>[]> {
  try {
    return (await db.execute(query)).rows as Record<string, unknown>[];
  } catch (err) {
    throw lifecycleError(err);
  }
}

/**
 * Run `fn` on one dedicated connection that holds the lifecycle advisory lock for its
 * whole duration (session level, so a transaction started inside `fn` takes its
 * snapshot only after the lock is held).
 */
export async function withLifecycleLock<T>(
  db: Db,
  fn: (q: NodePgDatabase<Schema>, client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.$client.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LIFECYCLE_LOCK_KEY]);
    locked = true;
    return await fn(drizzle({ client, schema }), client);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LIFECYCLE_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export interface ActiveManifest {
  generationId: number;
  casesIndex: string;
  passagesIndex: string;
  publishedAt: Date;
  archiveSha256: string;
  mappingVersion: string;
  mappingVerified: boolean;
  citationTextVersion: string;
  verificationStatus: VerificationStatus | null;
  verifierVersion: string | null;
}

/** The active manifest with its generation's versions, or null before the first publish. */
export async function getActiveManifest(db: DbOrTx): Promise<ActiveManifest | null> {
  const [row] = await db
    .select({
      generationId: datasetManifests.generationId,
      casesIndex: datasetManifests.casesIndex,
      passagesIndex: datasetManifests.passagesIndex,
      publishedAt: datasetManifests.publishedAt,
      archiveSha256: datasetGenerations.archiveSha256,
      mappingVersion: datasetGenerations.mappingVersion,
      mappingVerified: datasetGenerations.mappingVerified,
      citationTextVersion: datasetGenerations.citationTextVersion,
      verificationStatus: datasetGenerations.verificationStatus,
      verifierVersion: datasetGenerations.verifierVersion,
    })
    .from(datasetManifests)
    .innerJoin(datasetGenerations, eq(datasetGenerations.id, datasetManifests.generationId))
    .where(eq(datasetManifests.active, true));
  if (!row) return null;
  return { ...row, publishedAt: row.publishedAt as Date };
}

/** Elasticsearch index names: lower-case, no path or wildcard characters (checked again in SQL). */
const INDEX_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;

/**
 * Make `generationId` the active dataset with the given indices, atomically
 * (`publish_manifest`): the previous active generation becomes `retired`, this one
 * `published`. Requires the generation's latest verification to be ok and made by
 * the current `VERIFIER_VERSION`, also when re-publishing a retired generation
 * (rollback).
 */
export async function publishManifest(
  db: Db,
  generationId: number,
  casesIndex: string,
  passagesIndex: string,
): Promise<ActiveManifest> {
  for (const name of [casesIndex, passagesIndex]) {
    if (!INDEX_NAME.test(name)) throw new Error(`invalid index name: ${JSON.stringify(name)}`);
  }
  await call(db, sql`select publish_manifest(${generationId}, ${casesIndex}, ${passagesIndex}, ${VERIFIER_VERSION})`);
  const active = await getActiveManifest(db);
  if (!active || active.generationId !== generationId) throw new Error('manifest activation failed');
  return active;
}

export interface PruneOptions {
  /** Published generations to retain, newest publication first; the active one is always among them. */
  keep?: number;
  /** Never-published generations are kept this long after sealing or their latest verification (default 24). */
  graceHours?: number;
  /** Test seam: runs under the lifecycle lock after planning, before any deletion. */
  afterPlan?: (candidates: number[]) => Promise<void> | void;
}

export interface PruneReport {
  /** Retained by publication: the active generation and the next most recently published. */
  retained: number[];
  deleted: number[];
  /** Candidates left in place because a pin protects them. */
  skippedPinned: number[];
}

/**
 * Retention by publication, not by id: keep the last `keep` published generations by
 * `published_at` (the active one first) and delete every other published or retired
 * generation. Never-published generations are deleted when `failed`, or when sealed
 * and unverified/verified for longer than the grace period (counted from the seal,
 * i.e. the load's commit, or the latest verification), so a slow load committing
 * late or a generation awaiting its indices is kept. `loading`, active and pinned
 * generations are never deleted. Runs under the lifecycle lock; each deletion is one
 * `prune_generation` call.
 */
export async function pruneGenerations(db: Db, opts: PruneOptions = {}): Promise<PruneReport> {
  const keep = opts.keep ?? 2;
  const graceHours = opts.graceHours ?? 24;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  if (!(graceHours >= 0)) throw new Error('graceHours must be zero or positive');
  return withLifecycleLock(db, async (q) => {
    const generations = await call(
      q,
      sql`select g.id::int as id, g.status, m.published_at is not null as was_published, coalesce(m.active, false) as active,
            exists (select 1 from generation_pins p where p.generation_id = g.id
              and (p.pinned_until is null or p.pinned_until > now())) as pinned,
            greatest(g.sealed_at, g.verified_at) < now() - make_interval(secs => ${graceHours * 3600}) as past_grace
          from dataset_generations g left join dataset_manifests m on m.generation_id = g.id
          order by m.active desc nulls last, m.published_at desc nulls last, g.id`,
    );
    const published = generations.filter((g) => g.was_published === true);
    const retained = published.slice(0, keep).map((g) => Number(g.id));
    const deleted: number[] = [];
    const skippedPinned: number[] = [];
    const candidates = generations
      .filter((g) => !retained.includes(Number(g.id)) && g.active !== true && g.status !== 'loading')
      .filter((g) => g.was_published === true || g.status === 'failed' || g.past_grace === true)
      .map((g) => ({ id: Number(g.id), pinned: g.pinned === true }))
      .sort((a, b) => a.id - b.id);
    await opts.afterPlan?.(candidates.filter((c) => !c.pinned).map((c) => c.id));
    for (const c of candidates) {
      if (c.pinned) {
        skippedPinned.push(c.id);
        continue;
      }
      await call(q, sql`select prune_generation(${c.id})`);
      deleted.push(c.id);
    }
    return { retained, deleted, skippedPinned };
  });
}

/**
 * Protect a generation from pruning (e.g. for a live brief), until `until` or
 * `unpinGeneration`; creating and renewing pins both go through `pin_generation`,
 * which takes the lifecycle lock. While pruning runs it waits, and fails with "does
 * not exist" if pruning removed the generation meanwhile.
 */
export async function pinGeneration(db: DbOrTx, generationId: number, reason: string, until: Date | null = null): Promise<void> {
  await call(db, sql`select pin_generation(${generationId}, ${reason}, ${until ? until.toISOString() : null}::timestamptz)`);
}

export async function unpinGeneration(db: DbOrTx, generationId: number, reason: string): Promise<boolean> {
  const [row] = await call(db, sql`select unpin_generation(${generationId}, ${reason}) as removed`);
  return row?.removed === true;
}

/** Pins in force for a generation. */
export async function activePins(db: DbOrTx, generationId: number): Promise<{ reason: string; pinnedUntil: Date | null }[]> {
  return db
    .select({ reason: generationPins.reason, pinnedUntil: generationPins.pinnedUntil })
    .from(generationPins)
    .where(
      and(
        eq(generationPins.generationId, generationId),
        or(isNull(generationPins.pinnedUntil), gt(generationPins.pinnedUntil, sql`now()`)),
      ),
    );
}

export interface GenerationSummary {
  id: number;
  status: GenerationStatus;
  createdAt: Date;
  sealedAt: Date | null;
  verificationStatus: VerificationStatus | null;
  verifiedAt: Date | null;
  verifierVersion: string | null;
  archiveSha256: string;
  mappingVersion: string;
  mappingVerified: boolean;
  citationTextVersion: string;
  events: number | null;
  active: boolean;
  publishedAt: Date | null;
}

export async function listGenerations(db: DbOrTx): Promise<GenerationSummary[]> {
  return db
    .select({
      id: datasetGenerations.id,
      status: datasetGenerations.status,
      createdAt: datasetGenerations.createdAt,
      sealedAt: datasetGenerations.sealedAt,
      verificationStatus: datasetGenerations.verificationStatus,
      verifiedAt: datasetGenerations.verifiedAt,
      verifierVersion: datasetGenerations.verifierVersion,
      archiveSha256: datasetGenerations.archiveSha256,
      mappingVersion: datasetGenerations.mappingVersion,
      mappingVerified: datasetGenerations.mappingVerified,
      citationTextVersion: datasetGenerations.citationTextVersion,
      events: sql<number | null>`(${datasetGenerations.stats} -> 'rows' ->> 'cases')::int`,
      active: sql<boolean>`coalesce(${datasetManifests.active}, false)`,
      publishedAt: datasetManifests.publishedAt,
    })
    .from(datasetGenerations)
    .leftJoin(datasetManifests, eq(datasetManifests.generationId, datasetGenerations.id))
    .orderBy(datasetGenerations.id);
}
