/**
 * Search aliases.
 *
 * An alias such as `aviation-cases` means "the index built last" for operators and
 * tools. The API never reads it: every request uses the index names of the active
 * `dataset_manifests` row (`getActiveManifest`), which is published separately once
 * both indices of a generation exist.
 *
 * Switches are serialized per alias across workers with a PostgreSQL advisory lock
 * keyed on the alias name. Under the lock a switch:
 *
 * 1. refuses while the alias has a `pending` attempt or an `unknown` one that no
 *    operator has declared abandoned (`pnpm worker index reconcile --alias <alias>`),
 *    and runs the caller's `beforeSwitch` check (e.g. the build still holds its pin);
 * 2. returns `already_current` without recording or sending anything when the alias
 *    already points solely at the index (an add-only request for the current target
 *    could fail in transport, and a later read-back would then wrongly show it as
 *    committed while the request might still land after another switch);
 * 3. appends a `pending` row to `index_switch_attempts`;
 * 4. sends one `_aliases` request, without client retries, that removes every current
 *    target (`must_exist`) and adds the index;
 * 5. resolves that attempt: a success response is `committed`, a 4xx response (other
 *    than 408) `rejected`, anything else (transport failure, timeout, 5xx) `unknown`,
 *    whatever the alias shows afterwards, because Elasticsearch may apply a queued
 *    request later and its master timeout does not bound execution. Only a later
 *    read-back that includes the index resolves `unknown` (to `committed`).
 *
 * Nothing here deletes an index. Previous indices are kept (a rollback is another
 * switch); deleting unused indices is the explicit `worker index delete-unused`.
 */
import type { Client } from '@elastic/elasticsearch';
import type pg from 'pg';
import type { Db } from '../../server/db/client.js';

/** First key of the two-key advisory locks for aliases (the single-key lifecycle locks are a separate key space). */
export const ALIAS_LOCK_NAMESPACE = 731_190_503;

/** How long the master may queue the alias request before giving up on it. */
export const ALIAS_MASTER_TIMEOUT = '30s';

const statusOf = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Queryable = Pick<pg.PoolClient, 'query'> | Pick<pg.Pool, 'query'>;

/** Concrete indices the alias points at (empty when it does not exist). */
export async function aliasTargets(es: Client, alias: string): Promise<string[]> {
  try {
    const found = await es.indices.getAlias({ name: alias });
    return Object.keys(found).sort();
  } catch (e) {
    if (statusOf(e) === 404) return [];
    throw e;
  }
}

export interface AliasLockOptions {
  /** Give up waiting for another worker's switch after this long (default 120 s). */
  lockTimeoutMs?: number;
}

/**
 * Run `fn` holding the advisory lock of `alias` on a dedicated connection, which `fn`
 * receives (write the alias's attempt rows on it). The lock is released with the
 * connection if the process dies.
 */
export async function withAliasLock<T>(
  db: Db,
  alias: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  opts: AliasLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.lockTimeoutMs ?? 120_000;
  const client = await db.$client.connect();
  let locked = false;
  let broken: Error | undefined;
  // A session that ends meanwhile fails the statement that was running; without a listener its
  // `error` event would also end the process.
  const discard = (e: unknown): void => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  client.on('error', discard);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, hashtext($2)) as ok', [ALIAS_LOCK_NAMESPACE, alias]);
      if (r.rows[0]?.ok === true) break;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for another switch of alias ${alias}`);
      await sleep(50);
    }
    locked = true;
    return await fn(client);
  } finally {
    // On failure, discard the connection: closing the session releases the lock.
    if (locked) await client.query('select pg_advisory_unlock($1, hashtext($2))', [ALIAS_LOCK_NAMESPACE, alias]).catch(discard);
    client.off('error', discard);
    client.release(broken);
  }
}

export interface BlockingAttempt {
  id: number;
  indexName: string;
  outcome: 'pending' | 'unknown';
}

/** Attempts that block switching the alias: `pending`, or `unknown` and not declared abandoned. */
export async function blockingAttempts(q: Queryable, alias: string): Promise<BlockingAttempt[]> {
  const r = await q.query<{ id: string; index_name: string; outcome: 'pending' | 'unknown' }>(
    `select id, index_name, outcome from index_switch_attempts
      where alias = $1 and (outcome = 'pending' or (outcome = 'unknown' and declared_abandoned_at is null))
      order by id`,
    [alias],
  );
  return r.rows.map((x) => ({ id: Number(x.id), indexName: x.index_name, outcome: x.outcome }));
}

export function blockedMessage(alias: string, attempts: BlockingAttempt[]): string {
  const list = attempts.map((a) => `attempt ${a.id} to ${a.indexName}: ${a.outcome}`).join(', ');
  return `alias ${alias} is blocked by an unresolved switch (${list}); run pnpm worker index reconcile --alias ${alias}`;
}

export interface AliasSwitch {
  alias: string;
  index: string;
  /** `already_current`: the alias already pointed solely at the index; nothing was recorded or sent. */
  status: 'switched' | 'already_current';
  /** The committed attempt; null when already current. */
  attemptId: number | null;
  /** Indices the alias pointed at before (kept, not deleted). */
  previous: string[];
  /** A read-back after the committed request showed exactly the new index. */
  verified: boolean;
}

/**
 * `not_submitted`: no request was sent (blocked, refused by `beforeSwitch`, lock not
 * taken): the index was never part of an alias request. `rejected`: Elasticsearch
 * refused the request. `unknown`: it may still be applied; the alias is blocked.
 * `inconsistent`: committed, but the alias has other targets too.
 */
export type AliasSwitchOutcome = 'not_submitted' | 'rejected' | 'unknown' | 'inconsistent';

export class AliasSwitchError extends Error {
  constructor(
    message: string,
    readonly outcome: AliasSwitchOutcome,
    readonly attemptId: number | null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'AliasSwitchError';
  }
}

export interface SwitchAliasOptions extends AliasLockOptions {
  /** Build that owns the index; null for a manual switch such as a rollback. */
  buildId?: string | null;
  /** Runs under the alias lock before anything is recorded or sent; throwing refuses the switch. */
  beforeSwitch?: (client: pg.PoolClient) => Promise<void>;
  /** Read-back attempts after a committed request (default 3). */
  readAttempts?: number;
  /** Delay before the second read-back attempt, doubled for each further one (default 200 ms). */
  readRetryDelayMs?: number;
}

/** A response from Elasticsearch that refused the request: it was never applied. */
function definitelyRejected(err: unknown): boolean {
  const code = statusOf(err);
  return typeof code === 'number' && code >= 400 && code < 500 && code !== 408;
}

async function resolve(client: pg.PoolClient, attemptId: number, outcome: 'committed' | 'rejected' | 'unknown'): Promise<void> {
  await client.query(`update index_switch_attempts set outcome = $2, resolved_at = now() where id = $1 and outcome = 'pending'`, [
    attemptId,
    outcome,
  ]);
}

/**
 * Point `alias` at `index` only, serialized with every other switch of the alias,
 * and record the attempt. Throws `AliasSwitchError`; only `not_submitted` means the
 * index was never part of an alias request.
 */
export async function switchAlias(
  es: Client,
  db: Db,
  alias: string,
  index: string,
  opts: SwitchAliasOptions = {},
): Promise<AliasSwitch> {
  if (alias === index) throw new AliasSwitchError('alias and index names must differ', 'not_submitted', null);
  const attempts = Math.max(1, opts.readAttempts ?? 3);
  const delayMs = opts.readRetryDelayMs ?? 200;
  let attemptId: number | null = null;
  try {
    return await withAliasLock(
      db,
      alias,
      async (client) => {
        const blocking = await blockingAttempts(client, alias);
        if (blocking.length > 0) throw new Error(blockedMessage(alias, blocking));
        // An index whose deletion was requested (index delete-unused, migration 0021) is never a target again.
        const gone = await client.query(
          'select 1 from index_builds where index_name = $1 and (deletion_requested_at is not null or deleted_at is not null)',
          [index],
        );
        if ((gone.rowCount ?? 0) > 0) throw new Error(`the deletion of ${index} was requested; it is never switched to again`);
        await opts.beforeSwitch?.(client);
        const previous = await aliasTargets(es, alias);
        if (previous.length === 0 && (await es.indices.exists({ index: alias }))) {
          throw new Error(`${alias} is a concrete index, not an alias`);
        }
        if (previous.length === 1 && previous[0] === index) {
          return { alias, index, status: 'already_current', attemptId: null, previous, verified: true };
        }
        const inserted = await client.query<{ id: string }>(
          `insert into index_switch_attempts (alias, index_name, build_id) values ($1, $2, $3) returning id`,
          [alias, index, opts.buildId ?? null],
        );
        attemptId = Number(inserted.rows[0]?.id);
        const id = attemptId;

        try {
          await es.indices.updateAliases(
            {
              master_timeout: ALIAS_MASTER_TIMEOUT,
              actions: [
                ...previous.filter((p) => p !== index).map((p) => ({ remove: { index: p, alias, must_exist: true } })),
                { add: { index, alias } },
              ],
            },
            // A retry of a request that committed would fail on must_exist and look like a rejection.
            { maxRetries: 0 },
          );
        } catch (err) {
          if (definitelyRejected(err)) {
            await resolve(client, id, 'rejected');
            throw new AliasSwitchError(`alias ${alias} not switched to ${index}: rejected (${String(err)})`, 'rejected', id, err);
          }
          await resolve(client, id, 'unknown');
          throw new AliasSwitchError(
            `alias ${alias}: switch attempt ${id} to ${index} failed in transport and may still be applied; ${index} is kept and the alias is blocked until pnpm worker index reconcile --alias ${alias}`,
            'unknown',
            id,
            err,
          );
        }
        await resolve(client, id, 'committed');

        // The response settled the outcome; a read-back only confirms it.
        let targets: string[] | null = null;
        for (let i = 0; i < attempts && targets === null; i += 1) {
          if (i > 0) await sleep(delayMs * 2 ** (i - 1));
          targets = await aliasTargets(es, alias).catch(() => null);
        }
        if (targets !== null && !(targets.length === 1 && targets[0] === index)) {
          throw new AliasSwitchError(
            `alias ${alias} points at ${targets.join(', ') || 'nothing'} after switching to ${index}; ${index} is kept`,
            'inconsistent',
            id,
          );
        }
        return { alias, index, status: 'switched', attemptId: id, previous, verified: targets !== null };
      },
      opts,
    );
  } catch (err) {
    if (err instanceof AliasSwitchError) throw err;
    if (attemptId === null) {
      // Taking the lock, the checks, or recording the attempt failed: nothing was sent.
      throw new AliasSwitchError(`alias ${alias} not switched: ${err instanceof Error ? err.message : String(err)}`, 'not_submitted', null, err);
    }
    // Recording the outcome failed after the attempt was recorded: it stays pending, which blocks the alias.
    throw new AliasSwitchError(`alias ${alias}: outcome of attempt ${attemptId} to ${index} not recorded; ${index} is kept`, 'unknown', attemptId, err);
  }
}
