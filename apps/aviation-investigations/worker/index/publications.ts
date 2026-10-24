/**
 * Index builds: identity, liveness, switch reconciliation and explicit cleanup
 * (`index_builds`, `index_switch_attempts`; schema in `server/db/schema/search.ts`).
 *
 * Every build has a random `build_id`, part of its index name and of its generation
 * pin (`index-build:<build_id>`, no expiry), recorded in `index_builds` before its
 * index exists. While it runs, the build holds a session advisory lock on its id, so
 * other commands can tell a running build (lock held) from a stopped one.
 *
 * Irreversible steps are explicit and revalidated under locks:
 *
 * - A build deletes its own index automatically only if the index was never part of
 *   an alias request (`deleteUnsubmittedIndex`). Every other index is kept.
 * - `reconcileAlias` resolves an `unknown` (or `pending`) attempt only when the alias
 *   read-back includes its index (`committed`). Time never resolves it: an absent
 *   target keeps the alias blocked until an operator runs `declareAbandoned` with a
 *   reason, which only unblocks switching and deletes nothing.
 * - `deleteUnusedIndices` (dry run unless told otherwise) deletes old indices of
 *   stopped builds that are no alias target, appear in no dataset manifest, are used by
 *   no unexpired AI brief and have no pending or unknown switch attempt, rechecking all
 *   of it under the build, alias and lifecycle locks just before deleting. A committed
 *   attempt does not keep an index: once the alias read-back no longer shows it, a later
 *   switch replaced it.
 * - `cleanupStalePins` removes the pins of stopped builds, and nothing else.
 */
import type { Client } from '@elastic/elasticsearch';
import type pg from 'pg';
import type { Db } from '../../server/db/client.js';
import { BRIEF_REFERENCES_LOCK_KEY, LIFECYCLE_LOCK_KEY } from '../../server/db/generations.js';
import { aliasTargets, withAliasLock, type AliasLockOptions } from './aliases.js';

/** First key of the two-key advisory locks held by running builds. */
export const BUILD_LOCK_NAMESPACE = 731_190_504;
export const BUILD_PIN_PREFIX = 'index-build:';
const BUILD_ID = /^[a-z0-9]{4,32}$/;

export function buildPinReason(buildId: string): string {
  return `${BUILD_PIN_PREFIX}${buildId}`;
}

export function checkBuildId(buildId: string): void {
  if (!BUILD_ID.test(buildId)) throw new Error(`invalid build id: ${JSON.stringify(buildId)}`);
}

const statusOf = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;
type Queryable = Pick<pg.PoolClient, 'query'> | Pick<pg.Pool, 'query'>;

/** Run `fn` while holding the build's liveness lock on a dedicated connection. */
export async function withBuildLock<T>(db: Db, buildId: string, fn: () => Promise<T>): Promise<T> {
  checkBuildId(buildId);
  const client = await db.$client.connect();
  let locked = false;
  let broken: Error | undefined;
  try {
    await client.query('select pg_advisory_lock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, buildId]);
    locked = true;
    return await fn();
  } finally {
    if (locked) {
      await client.query('select pg_advisory_unlock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, buildId]).catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
    }
    client.release(broken);
  }
}

/**
 * Run `fn` only if no process holds the build's lock (the build has stopped), holding
 * it meanwhile so the build cannot run concurrently. `skipped` when it is running.
 */
async function ifBuildStopped<T>(db: Db, buildId: string, fn: () => Promise<T>): Promise<{ skipped: true } | { skipped: false; value: T }> {
  const client = await db.$client.connect();
  let broken: Error | undefined;
  try {
    const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, hashtext($2)) as ok', [BUILD_LOCK_NAMESPACE, buildId]);
    if (r.rows[0]?.ok !== true) return { skipped: true };
    try {
      return { skipped: false, value: await fn() };
    } finally {
      await client.query('select pg_advisory_unlock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, buildId]).catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
    }
  } finally {
    client.release(broken);
  }
}

/** Record a build (and reserve its index name) before its index is created. */
export async function recordBuild(db: Db, b: { indexName: string; alias: string; buildId: string; generationId: number }): Promise<void> {
  await db.$client.query(`insert into index_builds (build_id, index_name, alias, generation_id) values ($1, $2, $3, $4)`, [
    b.buildId,
    b.indexName,
    b.alias,
    b.generationId,
  ]);
}

/**
 * A build's cleanup of its own index after a failure: delete it only if no alias
 * request was ever recorded for it (the name is reserved for this build, so no other
 * index can carry it). Returns false, deleting nothing, if an attempt exists.
 */
export async function deleteUnsubmittedIndex(es: Client, q: Queryable, indexName: string): Promise<boolean> {
  const attempts = await q.query('select 1 from index_switch_attempts where index_name = $1 limit 1', [indexName]);
  if ((attempts.rowCount ?? 0) > 0) return false;
  await es.indices.delete({ index: indexName }).catch((e: unknown) => {
    if (statusOf(e) !== 404) throw e;
  });
  await q.query('update index_builds set deleted_at = now() where index_name = $1 and deleted_at is null', [indexName]);
  return true;
}

// ---------------------------------------------------------------------------
// Reconciliation

export interface ReconcileReport {
  alias: string;
  targets: string[];
  /** Attempts resolved as committed because the read-back includes their index. */
  committed: { id: number; indexName: string }[];
  /** Attempts still unknown (absent from the alias); `declared` ones no longer block. */
  unresolved: { id: number; indexName: string; declared: boolean }[];
  /** The alias still refuses automatic switches. */
  blocked: boolean;
}

/**
 * Resolve the alias's pending and unknown attempts from a read-back, under the alias
 * lock: an attempt whose index is a target is `committed`; any other stays (or, if
 * pending, becomes) `unknown`. No waiting: elapsed time proves nothing. Fails without
 * recording anything if the alias cannot be read.
 */
export async function reconcileAlias(es: Client, db: Db, alias: string, opts: AliasLockOptions = {}): Promise<ReconcileReport> {
  return withAliasLock(
    db,
    alias,
    async (client) => {
      const r = await client.query<{ id: string; index_name: string; outcome: string; declared: boolean }>(
        `select id, index_name, outcome, declared_abandoned_at is not null as declared from index_switch_attempts
          where alias = $1 and outcome in ('pending', 'unknown') order by id`,
        [alias],
      );
      const targets = await aliasTargets(es, alias);
      const report: ReconcileReport = { alias, targets, committed: [], unresolved: [], blocked: false };
      for (const a of r.rows) {
        const id = Number(a.id);
        if (targets.includes(a.index_name)) {
          await client.query(`update index_switch_attempts set outcome = 'committed', resolved_at = now() where id = $1`, [id]);
          report.committed.push({ id, indexName: a.index_name });
          continue;
        }
        if (a.outcome === 'pending') {
          await client.query(`update index_switch_attempts set outcome = 'unknown', resolved_at = now() where id = $1`, [id]);
        }
        report.unresolved.push({ id, indexName: a.index_name, declared: a.declared });
      }
      report.blocked = report.unresolved.some((u) => !u.declared);
      return report;
    },
    opts,
  );
}

/**
 * An operator's assertion that an unknown attempt will never be applied: recorded with
 * the reason, it stops blocking switches of the alias. The attempt stays `unknown` (so
 * its index is never deleted by automation), and nothing is deleted.
 */
export async function declareAbandoned(db: Db, alias: string, attemptId: number, reason: string, opts: AliasLockOptions = {}): Promise<void> {
  const text = reason.trim();
  if (text === '' || text.length > 500) throw new Error('a reason (1-500 characters) is required');
  await withAliasLock(
    db,
    alias,
    async (client) => {
      const r = await client.query(
        `update index_switch_attempts set declared_abandoned_at = now(), declared_reason = $3
          where id = $1 and alias = $2 and outcome = 'unknown' and declared_abandoned_at is null`,
        [attemptId, alias, text],
      );
      if (r.rowCount !== 1) {
        throw new Error(`attempt ${attemptId} of alias ${alias} is not an undeclared unknown attempt; run reconcile first`);
      }
    },
    opts,
  );
}

// ---------------------------------------------------------------------------
// Explicit deletion of unused indices

export interface DeleteUnusedOptions {
  /** Only builds started at least this many hours ago. */
  olderThanHours: number;
  /** Delete; without it, only report what would be deleted. */
  yes?: boolean;
  /** Restrict to these aliases. */
  aliases?: string[];
  /** Test seam: runs after candidates are chosen, before any lock is taken. */
  afterSelect?: (indexNames: string[]) => Promise<void> | void;
  /** Test seam: runs for each index about to be deleted, after its last check, before Elasticsearch deletes it, holding the brief-references lock. */
  beforeDelete?: (indexName: string) => Promise<void> | void;
}

export interface DeleteUnusedReport {
  dryRun: boolean;
  deleted: string[];
  wouldDelete: string[];
  /** Already gone from Elasticsearch; recorded as deleted when `yes`. */
  missing: string[];
  refused: { indexName: string; reason: string }[];
}

/** Why an index must be kept, rechecked under the locks; null when it may be deleted. */
async function refusal(es: Client, q: pg.PoolClient, buildId: string, seconds: number): Promise<string | 'missing' | null> {
  const row = await q.query<{ index_name: string; deleted: boolean; old: boolean }>(
    `select index_name, deleted_at is not null as deleted, created_at < now() - make_interval(secs => $2) as old
       from index_builds where build_id = $1`,
    [buildId, seconds],
  );
  const b = row.rows[0];
  if (!b) return 'no build record';
  if (b.deleted) return 'already deleted';
  if (!b.old) return 'younger than the threshold';
  // A pending or unknown request may still land and make the index a target; a committed one
  // made it a target once, which the alias read-back below settles, and a rejected one never did.
  const attempts = await q.query<{ outcome: string }>(
    `select outcome from index_switch_attempts where index_name = $1 and outcome in ('pending', 'unknown') order by id limit 1`,
    [b.index_name],
  );
  if (attempts.rows[0]) return `has a switch attempt that is ${attempts.rows[0].outcome}`;
  const manifests = await q.query(`select 1 from dataset_manifests where cases_index = $1 or passages_index = $1 limit 1`, [b.index_name]);
  if ((manifests.rowCount ?? 0) > 0) return 'referenced by a dataset manifest';
  // An unexpired brief's passages index, or the cases index its pair was published with
  // (migration 0021): the brief's later steps read them until it expires.
  const cited = await q.query(`select 1 from indices_cited_by_live_briefs() as i where i = $1 limit 1`, [b.index_name]);
  if ((cited.rowCount ?? 0) > 0) return 'used by an unexpired AI brief';
  try {
    const found = await es.indices.getAlias({ index: b.index_name });
    const aliases = Object.keys(found[b.index_name]?.aliases ?? {});
    if (aliases.length > 0) return `is a target of ${aliases.join(', ')}`;
  } catch (e) {
    if (statusOf(e) === 404) return 'missing';
    throw e;
  }
  return null;
}

/**
 * Delete (with `yes`; otherwise report) indices of stopped builds that nothing uses.
 * Candidates are chosen first, then each is rechecked after taking its build lock (it
 * must be free), its alias lock and the lifecycle lock (so no switch, manifest
 * publication or pruning interleaves): still recorded and not deleted, older than the
 * threshold, no pending or unknown switch attempt, in no dataset manifest (active or
 * retained), and no alias target. The API reads only manifest indices, so an index the
 * alias moved away from and no manifest names serves nothing.
 */
export async function deleteUnusedIndices(es: Client, db: Db, opts: DeleteUnusedOptions): Promise<DeleteUnusedReport> {
  if (!(opts.olderThanHours >= 0)) throw new Error('olderThanHours must be zero or positive');
  const seconds = opts.olderThanHours * 3600;
  const report: DeleteUnusedReport = { dryRun: !opts.yes, deleted: [], wouldDelete: [], missing: [], refused: [] };
  const candidates = await db.$client.query<{ build_id: string; index_name: string; alias: string }>(
    `select build_id, index_name, alias from index_builds
      where deleted_at is null and created_at < now() - make_interval(secs => $1)
        and ($2::text[] is null or alias = any($2::text[]))
      order by created_at`,
    [seconds, opts.aliases ?? null],
  );
  await opts.afterSelect?.(candidates.rows.map((c) => c.index_name));

  for (const c of candidates.rows) {
    const done = await ifBuildStopped(db, c.build_id, () =>
      withAliasLock(db, c.alias, async (client) => {
        await client.query('select pg_advisory_lock($1)', [LIFECYCLE_LOCK_KEY]);
        try {
          // One transaction holds the brief-references lock from the check of what unexpired
          // briefs use until the deletion is recorded in index_builds: a brief claiming this
          // index meanwhile waits, then finds it deleted; one that committed first is seen by
          // the check (gate finding 4). A failed deletion rolls the record back.
          await client.query('BEGIN');
          try {
            await client.query('select pg_advisory_xact_lock($1)', [BRIEF_REFERENCES_LOCK_KEY]);
            const why = await refusal(es, client, c.build_id, seconds);
            if (why === 'missing') {
              report.missing.push(c.index_name);
              if (opts.yes) await client.query('update index_builds set deleted_at = now() where build_id = $1 and deleted_at is null', [c.build_id]);
            } else if (why !== null) {
              report.refused.push({ indexName: c.index_name, reason: why });
            } else if (!opts.yes) {
              report.wouldDelete.push(c.index_name);
            } else {
              await opts.beforeDelete?.(c.index_name);
              await es.indices.delete({ index: c.index_name }).catch((e: unknown) => {
                if (statusOf(e) !== 404) throw e;
              });
              await client.query('update index_builds set deleted_at = now() where build_id = $1 and deleted_at is null', [c.build_id]);
              report.deleted.push(c.index_name);
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        } finally {
          await client.query('select pg_advisory_unlock($1)', [LIFECYCLE_LOCK_KEY]);
        }
      }),
    );
    if (done.skipped) report.refused.push({ indexName: c.index_name, reason: 'its build is still running' });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Stale pins

export interface CleanupPinsOptions {
  /** Only pins created at least this many hours ago. */
  olderThanHours: number;
}

export interface CleanupPinsReport {
  pinsRemoved: { generationId: number; buildId: string }[];
  /** Builds still running (their lock is held). */
  skippedRunning: string[];
}

/**
 * Remove the `index-build:` pins of builds that have stopped (their lock is free),
 * rechecking each pin under that lock. Deletes no index.
 */
export async function cleanupStalePins(db: Db, opts: CleanupPinsOptions): Promise<CleanupPinsReport> {
  if (!(opts.olderThanHours >= 0)) throw new Error('olderThanHours must be zero or positive');
  const seconds = opts.olderThanHours * 3600;
  const report: CleanupPinsReport = { pinsRemoved: [], skippedRunning: [] };
  const pins = await db.$client.query<{ generation_id: string; reason: string }>(
    `select generation_id, reason from generation_pins
      where starts_with(reason, $1) and created_at < now() - make_interval(secs => $2)
      order by created_at`,
    [BUILD_PIN_PREFIX, seconds],
  );
  for (const pin of pins.rows) {
    const buildId = pin.reason.slice(BUILD_PIN_PREFIX.length);
    if (!BUILD_ID.test(buildId)) continue;
    const generationId = Number(pin.generation_id);
    const done = await ifBuildStopped(db, buildId, async () => {
      // Recheck under the build lock: still there and still old enough.
      const still = await db.$client.query(
        `select 1 from generation_pins where generation_id = $1 and reason = $2 and created_at < now() - make_interval(secs => $3)`,
        [generationId, pin.reason, seconds],
      );
      if ((still.rowCount ?? 0) === 0) return false;
      await db.$client.query('select unpin_generation($1, $2)', [generationId, pin.reason]);
      return true;
    });
    if (done.skipped) report.skippedRunning.push(buildId);
    else if (done.value) report.pinsRemoved.push({ generationId, buildId });
  }
  return report;
}
