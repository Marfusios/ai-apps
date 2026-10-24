/**
 * Dataset generations and manifests (amendment A6). The active manifest names the
 * generation and the two search indices built for it; the API pins every request to
 * it. Status changes happen only in the migrator-owned database functions of
 * migration 0003 (`publish_manifest`, `prune_generation`, `record_verification`,
 * `seal_generation`), which share one advisory lock with verification.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { boundedRead } from './bounded-read.js';
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
 * Bound on every statement of the lifecycle connection, the wait for the lock included.
 * Verifying generation 1 takes about 7 s; a statement that stalls must not hold the lock,
 * and with it every publication, pruning and pin, until an operator interrupts it.
 */
export const LIFECYCLE_STATEMENT_TIMEOUT_MS = 10 * 60_000;

/**
 * Run `fn` on one dedicated connection that holds the lifecycle advisory lock for its
 * whole duration (session level, so a transaction started inside `fn` takes its
 * snapshot only after the lock is held). Every statement on it is bounded by
 * `statementTimeoutMs` (default `LIFECYCLE_STATEMENT_TIMEOUT_MS`); the connection goes
 * back to the pool without the bound, or is discarded (which also releases the lock) if
 * unlocking or resetting fails.
 */
export async function withLifecycleLock<T>(
  db: Db,
  fn: (q: NodePgDatabase<Schema>, client: import('pg').PoolClient) => Promise<T>,
  opts: { statementTimeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.statementTimeoutMs ?? LIFECYCLE_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('statementTimeoutMs must be a positive integer');
  const client = await db.$client.connect();
  let locked = false;
  let broken: Error | undefined;
  const discard = (e: unknown): void => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    await client.query('SELECT pg_advisory_lock($1)', [LIFECYCLE_LOCK_KEY]);
    locked = true;
    return await fn(drizzle({ client, schema }), client);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LIFECYCLE_LOCK_KEY]).catch(discard);
    if (!broken) await client.query('RESET statement_timeout').catch(discard);
    client.release(broken);
  }
}

export interface ActiveManifest {
  generationId: number;
  casesIndex: string;
  /** Null for a keyword-only manifest: AI routes stay off until a passages index is published. */
  passagesIndex: string | null;
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

/**
 * The cases index `generationId` was last published with together with `passagesIndex`
 * (`manifest_pairings`, migration 0021: every pair a generation was ever published with,
 * kept while the generation exists), or null when the generation never had that pair or is
 * gone. AI retrieval with the cases channel reads the cases index a brief's pinned passages
 * index was published with, never the active manifest's (task 10e); publishing the
 * generation again with another passages index leaves the brief's pair resolvable.
 *
 * It runs on the request path, so it is one bounded read (`boundedRead`): pool
 * acquisition and the statement end within `timeoutMs` or when `signal` aborts, and an
 * abandoned connection is destroyed, never returned busy.
 */
export async function manifestCasesIndex(
  db: Db,
  generationId: number,
  passagesIndex: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<string | null> {
  const rows = await boundedRead<{ cases_index: string }>(
    db.$client,
    'select cases_index from manifest_pairings where generation_id = $1 and passages_index = $2',
    [generationId, passagesIndex],
    opts,
  );
  return rows[0]?.cases_index ?? null;
}

/** Elasticsearch index names: lower-case, no path or wildcard characters (checked again in SQL). */
const INDEX_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;

/**
 * Make `generationId` the active dataset with the given indices, atomically
 * (`publish_manifest`): the previous active generation becomes `retired`, this one
 * `published`. Requires the generation's latest verification to be ok and made by
 * the current `VERIFIER_VERSION`, also when re-publishing a retired generation
 * (rollback). `passagesIndex` null publishes a keyword-only manifest.
 */
export async function publishManifest(
  db: Db,
  generationId: number,
  casesIndex: string,
  passagesIndex: string | null,
): Promise<ActiveManifest> {
  for (const name of passagesIndex === null ? [casesIndex] : [casesIndex, passagesIndex]) {
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
  /** Plan only: nothing is deleted and `deleted` lists what a real run would delete. */
  dryRun?: boolean;
  /** Test seam: runs under the lifecycle lock after planning, before any deletion. */
  afterPlan?: (candidates: number[]) => Promise<void> | void;
}

export interface PruneReport {
  /** Retained by publication: the active generation and the next most recently published. */
  retained: number[];
  deleted: number[];
  /** Candidates left in place because a pin protects them. */
  skippedPinned: number[];
  /** Candidates left in place because an unexpired AI brief cites them (migration 0021). */
  skippedLiveBriefs: number[];
}

/**
 * Retention by publication, not by id: keep the last `keep` published generations by
 * `published_at` (the active one first) and delete every other published or retired
 * generation. Never-published generations are deleted when `failed`, or when sealed
 * and unverified/verified for longer than the grace period (counted from the seal,
 * i.e. the load's commit, the latest verification or the latest index build whose index
 * still exists), so a slow load committing late or a generation awaiting publication
 * of its (possibly paid) indices is kept. `loading`, active and pinned
 * generations are never deleted, and neither is a generation an unexpired AI brief cites
 * (`generations_cited_by_live_briefs()`, migration 0021; amendment A6): briefs are made
 * only on the active generation, which publication changes only under the lifecycle
 * lock held here, so no brief can start citing a candidate meanwhile. Runs under the
 * lifecycle lock; each deletion is one `prune_generation` call.
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
            g.id in (select b from generations_cited_by_live_briefs() as b) as cited,
            greatest(g.sealed_at, g.verified_at,
              (select max(b.created_at) from index_builds b where b.generation_id = g.id and b.deleted_at is null))
              < now() - make_interval(secs => ${graceHours * 3600}) as past_grace
          from dataset_generations g left join dataset_manifests m on m.generation_id = g.id
          order by m.active desc nulls last, m.published_at desc nulls last, g.id`,
    );
    const published = generations.filter((g) => g.was_published === true);
    const retained = published.slice(0, keep).map((g) => Number(g.id));
    const deleted: number[] = [];
    const skippedPinned: number[] = [];
    const skippedLiveBriefs: number[] = [];
    const candidates = generations
      .filter((g) => !retained.includes(Number(g.id)) && g.active !== true && g.status !== 'loading')
      .filter((g) => g.was_published === true || g.status === 'failed' || g.past_grace === true)
      .map((g) => ({ id: Number(g.id), pinned: g.pinned === true, cited: g.cited === true }))
      .sort((a, b) => a.id - b.id);
    await opts.afterPlan?.(candidates.filter((c) => !c.pinned && !c.cited).map((c) => c.id));
    for (const c of candidates) {
      if (c.pinned) {
        skippedPinned.push(c.id);
        continue;
      }
      if (c.cited) {
        skippedLiveBriefs.push(c.id);
        continue;
      }
      if (opts.dryRun !== true) await call(q, sql`select prune_generation(${c.id})`);
      deleted.push(c.id);
    }
    return { retained, deleted, skippedPinned, skippedLiveBriefs };
  });
}

/**
 * Protect a generation from pruning (an index build's pin, or an operator's), until `until` or
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
