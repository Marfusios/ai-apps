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
 *   an alias request or a manifest (`deleteUnsubmittedIndex`). Every other index is kept.
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
 * - Every deletion is recorded as requested (`deletion_requested_at`, committed) before
 *   Elasticsearch is asked, and as done (`deleted_at`) once it confirmed it or reports the
 *   index missing (Task 22 fix round 3). From the request on, no new brief, publication or
 *   alias switch takes the index, whatever became of the request (a lost response, a failed
 *   write afterwards, the process killed); the next `deleteUnusedIndices` with `yes`
 *   completes it.
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

/** Run `fn` while holding the build's liveness lock on a dedicated connection. */
export async function withBuildLock<T>(db: Db, buildId: string, fn: () => Promise<T>): Promise<T> {
  checkBuildId(buildId);
  const client = await db.$client.connect();
  let locked = false;
  let broken: Error | undefined;
  const discard = (e: unknown): void => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  // A session that ends meanwhile must not end the process on an unhandled `error`.
  client.on('error', discard);
  try {
    await client.query('select pg_advisory_lock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, buildId]);
    locked = true;
    return await fn();
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, buildId]).catch(discard);
    client.off('error', discard);
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
  const discard = (e: unknown): void => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  client.on('error', discard);
  try {
    const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, hashtext($2)) as ok', [BUILD_LOCK_NAMESPACE, buildId]);
    if (r.rows[0]?.ok !== true) return { skipped: true };
    try {
      return { skipped: false, value: await fn() };
    } finally {
      await client.query('select pg_advisory_unlock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, buildId]).catch(discard);
    }
  } finally {
    client.off('error', discard);
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
 * A build's cleanup of its own index after a failure: delete it only if no alias request
 * was ever recorded for it and no manifest ever named it (the name is reserved for this
 * build, so no other index can carry it). Returns false, deleting nothing, otherwise.
 *
 * Like `deleteUnusedIndices`, it records the deletion as requested before it asks
 * Elasticsearch, deciding under the lifecycle lock (a publication holds it from its checks to
 * its manifest) and the brief-references lock; a deletion left unconfirmed is completed by
 * the next `deleteUnusedIndices` with `yes`.
 */
export async function deleteUnsubmittedIndex(es: Client, pool: pg.Pool, indexName: string): Promise<boolean> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const discard = (e: unknown): void => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  client.on('error', discard);
  try {
    await client.query('BEGIN');
    try {
      await client.query('select pg_advisory_xact_lock($1)', [LIFECYCLE_LOCK_KEY]);
      await client.query('select pg_advisory_xact_lock($1)', [BRIEF_REFERENCES_LOCK_KEY]);
      const used = await client.query(
        `select 1 from index_switch_attempts where index_name = $1
         union all select 1 from dataset_manifests where cases_index = $1 or passages_index = $1
         union all select 1 from manifest_pairings where cases_index = $1 or passages_index = $1
         limit 1`,
        [indexName],
      );
      if ((used.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('update index_builds set deletion_requested_at = now() where index_name = $1 and deletion_requested_at is null', [indexName]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.off('error', discard);
    client.release(broken);
  }
  await es.indices.delete({ index: indexName }).catch((e: unknown) => {
    if (statusOf(e) !== 404) throw e;
  });
  await pool.query('update index_builds set deleted_at = now() where index_name = $1 and deleted_at is null', [indexName]);
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
  /** Test seam: runs for each index about to be deleted, once its deletion request is committed, before Elasticsearch is asked. */
  beforeDelete?: (indexName: string) => Promise<void> | void;
  /** Test seam: runs for each index Elasticsearch deleted, before the deletion is recorded. */
  afterDelete?: (indexName: string) => Promise<void> | void;
}

export interface DeleteUnusedReport {
  dryRun: boolean;
  deleted: string[];
  wouldDelete: string[];
  /** Dry run: deletions an earlier run requested and never confirmed; `yes` completes them. */
  pending: string[];
  /** Already gone from Elasticsearch; recorded as deleted when `yes`. */
  missing: string[];
  refused: { indexName: string; reason: string }[];
}

/** Where Elasticsearch has the index: `missing`, or the aliases that point at it. */
async function aliasState(es: Client, indexName: string): Promise<'missing' | string[]> {
  try {
    const found = await es.indices.getAlias({ index: indexName });
    return Object.keys(found[indexName]?.aliases ?? {});
  } catch (e) {
    if (statusOf(e) === 404) return 'missing';
    throw e;
  }
}

/**
 * Why PostgreSQL says the build's index must be kept; null when nothing there keeps it.
 * `requested`: an earlier run requested its deletion, which is past the age threshold by
 * that decision; the other checks still run, and nothing should fail them, since nothing
 * takes such an index again.
 */
async function storedRefusal(q: pg.PoolClient, buildId: string, seconds: number): Promise<{ reason: string | null; requested: boolean }> {
  const row = await q.query<{ index_name: string; deleted: boolean; requested: boolean; old: boolean }>(
    `select index_name, deleted_at is not null as deleted, deletion_requested_at is not null as requested,
            created_at < now() - make_interval(secs => $2) as old
       from index_builds where build_id = $1`,
    [buildId, seconds],
  );
  const b = row.rows[0];
  if (!b) return { reason: 'no build record', requested: false };
  const keep = (reason: string | null) => ({ reason, requested: b.requested });
  if (b.deleted) return keep('already deleted');
  if (!b.old && !b.requested) return keep('younger than the threshold');
  // A pending or unknown request may still land and make the index a target; a committed one
  // made it a target once, which the alias read-back settles, and a rejected one never did.
  const attempts = await q.query<{ outcome: string }>(
    `select outcome from index_switch_attempts where index_name = $1 and outcome in ('pending', 'unknown') order by id limit 1`,
    [b.index_name],
  );
  if (attempts.rows[0]) return keep(`has a switch attempt that is ${attempts.rows[0].outcome}`);
  const manifests = await q.query(`select 1 from dataset_manifests where cases_index = $1 or passages_index = $1 limit 1`, [b.index_name]);
  if ((manifests.rowCount ?? 0) > 0) return keep('referenced by a dataset manifest');
  // An unexpired brief's passages index, or the cases index its pair was published with
  // (migration 0021): the brief's later steps read them until it expires.
  const cited = await q.query(`select 1 from indices_cited_by_live_briefs() as i where i = $1 limit 1`, [b.index_name]);
  if ((cited.rowCount ?? 0) > 0) return keep('used by an unexpired AI brief');
  return keep(null);
}

/**
 * Delete (with `yes`; otherwise report) indices of stopped builds that nothing uses.
 * Candidates are chosen first, then each is rechecked after taking its build lock (it
 * must be free) and its alias lock (no switch of the alias interleaves): its alias
 * read-back from Elasticsearch, then, under the lifecycle lock (no manifest publication or
 * pruning interleaves), what PostgreSQL records: still recorded and not deleted, older than
 * the threshold, no pending or unknown switch attempt, in no dataset manifest (active or
 * retained), used by no unexpired AI brief. The API reads only manifest indices, so an
 * index the alias moved away from and no manifest names serves nothing.
 *
 * Only a run with `yes` takes the brief-references lock, and only for that last check and
 * the commit of the deletion request: Elasticsearch is never asked anything while new briefs
 * wait for it (re-check N11). The request is committed before the delete is sent, and the
 * lifecycle lock released, so whatever becomes of the request the index stays unavailable.
 * Deletions an earlier run requested and never confirmed are candidates at any age, and a
 * run with `yes` completes them (Elasticsearch deletes the index again, or reports it
 * missing; then `deleted_at`).
 */
export async function deleteUnusedIndices(es: Client, db: Db, opts: DeleteUnusedOptions): Promise<DeleteUnusedReport> {
  if (!(opts.olderThanHours >= 0)) throw new Error('olderThanHours must be zero or positive');
  const seconds = opts.olderThanHours * 3600;
  const report: DeleteUnusedReport = { dryRun: !opts.yes, deleted: [], wouldDelete: [], pending: [], missing: [], refused: [] };
  const candidates = await db.$client.query<{ build_id: string; index_name: string; alias: string }>(
    `select build_id, index_name, alias from index_builds
      where deleted_at is null and (deletion_requested_at is not null or created_at < now() - make_interval(secs => $1))
        and ($2::text[] is null or alias = any($2::text[]))
      order by created_at`,
    [seconds, opts.aliases ?? null],
  );
  await opts.afterSelect?.(candidates.rows.map((c) => c.index_name));

  for (const c of candidates.rows) {
    const done = await ifBuildStopped(db, c.build_id, () =>
      withAliasLock(db, c.alias, async (client) => {
        const state = await aliasState(es, c.index_name);
        const send = opts.yes ? await decide(client, c, state, seconds, report) : await preview(client, c, state, seconds, report);
        if (!send) return;
        // The request is committed: a lost response, a failed write or a killed process from
        // here on leaves the deletion requested, and the next run completes it.
        await opts.beforeDelete?.(c.index_name);
        await es.indices.delete({ index: c.index_name }).catch((e: unknown) => {
          if (statusOf(e) !== 404) throw e;
        });
        await opts.afterDelete?.(c.index_name);
        await client.query('update index_builds set deleted_at = now() where build_id = $1 and deleted_at is null', [c.build_id]);
        report.deleted.push(c.index_name);
      }),
    );
    if (done.skipped) report.refused.push({ indexName: c.index_name, reason: 'its build is still running' });
  }
  return report;
}

/** The report of a dry run: no lock beyond the build's and the alias's, nothing written. */
async function preview(
  client: pg.PoolClient,
  c: { build_id: string; index_name: string },
  state: 'missing' | string[],
  seconds: number,
  report: DeleteUnusedReport,
): Promise<false> {
  const { reason, requested } = await storedRefusal(client, c.build_id, seconds);
  if (reason !== null) report.refused.push({ indexName: c.index_name, reason: requested ? `its deletion was requested, but it ${reason}` : reason });
  else if (state === 'missing') report.missing.push(c.index_name);
  else if (state.length > 0) report.refused.push({ indexName: c.index_name, reason: `is a target of ${state.join(', ')}` });
  else (requested ? report.pending : report.wouldDelete).push(c.index_name);
  return false;
}

/**
 * A run with `yes`: decide under the lifecycle lock, in one transaction that holds the
 * brief-references lock from the check of what unexpired briefs use to the commit of the
 * deletion request (gate finding 4): a brief claiming the index meanwhile waits, then finds
 * its deletion requested; one that committed first is seen by the check. True when the
 * delete is to be sent.
 */
async function decide(
  client: pg.PoolClient,
  c: { build_id: string; index_name: string },
  state: 'missing' | string[],
  seconds: number,
  report: DeleteUnusedReport,
): Promise<boolean> {
  await client.query('select pg_advisory_lock($1)', [LIFECYCLE_LOCK_KEY]);
  try {
    await client.query('BEGIN');
    try {
      await client.query('select pg_advisory_xact_lock($1)', [BRIEF_REFERENCES_LOCK_KEY]);
      const { reason, requested } = await storedRefusal(client, c.build_id, seconds);
      let send = false;
      if (reason !== null) {
        // A requested deletion stays requested (the index stays unavailable) until a run completes it.
        report.refused.push({ indexName: c.index_name, reason: requested ? `its deletion was requested, but it ${reason}` : reason });
      } else if (state === 'missing') {
        report.missing.push(c.index_name);
        await client.query(
          `update index_builds set deletion_requested_at = coalesce(deletion_requested_at, now()), deleted_at = now()
            where build_id = $1 and deleted_at is null`,
          [c.build_id],
        );
      } else if (state.length > 0) {
        report.refused.push({ indexName: c.index_name, reason: `${requested ? 'its deletion was requested, but it ' : ''}is a target of ${state.join(', ')}` });
      } else {
        await client.query('update index_builds set deletion_requested_at = now() where build_id = $1 and deletion_requested_at is null', [c.build_id]);
        send = true;
      }
      await client.query('COMMIT');
      return send;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    // On a broken session the server has released it; withAliasLock then discards the connection.
    await client.query('select pg_advisory_unlock($1)', [LIFECYCLE_LOCK_KEY]).catch(() => undefined);
  }
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
