/**
 * Index builds: identity, liveness and cleanup (`index_publications`, schema in
 * `server/db/schema/search.ts`).
 *
 * Every build has a random `build_id`, part of its index name and of its generation
 * pin (`index-build:<build_id>`, no expiry). While it runs, the build holds a session
 * advisory lock on its id, so `cleanupStaleBuilds` can tell a running build (lock
 * held) from one whose process died (lock free) and only then removes that build's
 * pin and abandoned index.
 *
 * `reconcileAlias` settles switches recorded as `unknown` (or `switching`, left by a
 * crash): it waits longer than the master timeout of the alias request, reads the
 * alias, and records each as `committed` (it is a target) or `abandoned` (it is not,
 * and can no longer become one). Only then can cleanup delete an abandoned index.
 */
import type { Client } from '@elastic/elasticsearch';
import type pg from 'pg';
import type { Db } from '../../server/db/client.js';
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * Run `fn` only if no process holds the build's lock (the build is not running),
 * holding the lock meanwhile so the build cannot be resumed concurrently. Returns
 * `skipped` when the build is still running.
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

/** Record a build before its index is created. */
export async function recordBuild(db: Db, b: { indexName: string; alias: string; buildId: string; generationId: number }): Promise<void> {
  await db.$client.query(
    `insert into index_publications (index_name, alias, build_id, generation_id, status) values ($1, $2, $3, $4, 'building')`,
    [b.indexName, b.alias, b.buildId, b.generationId],
  );
}

/**
 * Delete an index that is certainly not an alias target, and record it as abandoned
 * and deleted. A missing index counts as deleted. Deleting by name is safe: the name
 * carries the build id, reserved by the build's row before the index was created.
 */
export async function abandonIndex(
  es: Client,
  q: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  indexName: string,
): Promise<void> {
  await q.query(`update index_publications set status = 'abandoned', updated_at = now() where index_name = $1`, [indexName]);
  await es.indices.delete({ index: indexName }).catch((e: unknown) => {
    if (statusOf(e) !== 404) throw e;
  });
  await q.query(`update index_publications set deleted_at = now(), updated_at = now() where index_name = $1`, [indexName]);
}

export interface ReconcileOptions extends AliasLockOptions {
  /** Wait before reading the alias (default 60 s, beyond the request's 30 s master timeout). */
  settleMs?: number;
}

export interface ReconcileReport {
  alias: string;
  targets: string[];
  committed: string[];
  abandoned: string[];
}

/**
 * Settle the alias's `unknown` and `switching` builds: after the settle delay, a build
 * whose index is an alias target is `committed`, any other is `abandoned`. Holds the
 * alias lock throughout, so no switch interleaves. Fails without recording anything
 * if the alias cannot be read.
 */
export async function reconcileAlias(es: Client, db: Db, alias: string, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const settleMs = opts.settleMs ?? 60_000;
  return withAliasLock(
    db,
    alias,
    async (client) => {
      const r = await client.query<{ index_name: string }>(
        `select index_name from index_publications where alias = $1 and status in ('unknown', 'switching') order by created_at`,
        [alias],
      );
      const pending = r.rows.map((x) => x.index_name);
      if (pending.length === 0) return { alias, targets: await aliasTargets(es, alias), committed: [], abandoned: [] };
      await sleep(settleMs);
      const targets = await aliasTargets(es, alias);
      const committed = pending.filter((i) => targets.includes(i));
      const abandoned = pending.filter((i) => !targets.includes(i));
      for (const i of committed) {
        await client.query(`update index_publications set status = 'committed', updated_at = now() where index_name = $1`, [i]);
      }
      for (const i of abandoned) {
        await client.query(`update index_publications set status = 'abandoned', updated_at = now() where index_name = $1`, [i]);
      }
      return { alias, targets, committed, abandoned };
    },
    opts,
  );
}

export interface CleanupOptions {
  /** Only builds (pins and rows) last touched at least this many hours ago. */
  olderThanHours: number;
}

export interface CleanupReport {
  pinsRemoved: { generationId: number; buildId: string }[];
  indicesDeleted: string[];
  /** Builds still running (their lock is held). */
  skippedRunning: string[];
  /** Rows that claim to be abandoned or building but whose index is an alias target: left for an operator. */
  keptTargets: string[];
}

/**
 * Remove what stopped builds left behind: their `index-build:` pins, and the indices
 * of their `building` (crashed before publishing) or `abandoned` rows that still
 * exist. A build whose lock is held is running and skipped. `switching` and `unknown`
 * rows are left to `reconcileAlias`. An index that is an alias target is never deleted.
 */
export async function cleanupStaleBuilds(es: Client, db: Db, opts: CleanupOptions): Promise<CleanupReport> {
  if (!(opts.olderThanHours >= 0)) throw new Error('olderThanHours must be zero or positive');
  const seconds = opts.olderThanHours * 3600;
  const report: CleanupReport = { pinsRemoved: [], indicesDeleted: [], skippedRunning: [], keptTargets: [] };

  const rows = await db.$client.query<{ index_name: string; alias: string; build_id: string }>(
    `select index_name, alias, build_id from index_publications
      where deleted_at is null and status in ('building', 'abandoned')
        and updated_at < now() - make_interval(secs => $1)
      order by created_at`,
    [seconds],
  );
  for (const row of rows.rows) {
    const done = await ifBuildStopped(db, row.build_id, () =>
      withAliasLock(db, row.alias, async (client) => {
        if ((await aliasTargets(es, row.alias)).includes(row.index_name)) {
          report.keptTargets.push(row.index_name);
          return;
        }
        await abandonIndex(es, client, row.index_name);
        report.indicesDeleted.push(row.index_name);
      }),
    );
    if (done.skipped) report.skippedRunning.push(row.build_id);
  }

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
      await db.$client.query('select unpin_generation($1, $2)', [generationId, pin.reason]);
    });
    if (done.skipped) {
      if (!report.skippedRunning.includes(buildId)) report.skippedRunning.push(buildId);
    } else {
      report.pinsRemoved.push({ generationId, buildId });
    }
  }
  return report;
}
