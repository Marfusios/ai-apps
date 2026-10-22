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
 * 1. refuses while any build of the alias is `unknown` or `switching` in
 *    `index_publications` (an earlier request may still be applied; run
 *    `pnpm worker index reconcile --alias <alias>`), and runs the caller's
 *    `beforeSwitch` check (e.g. the build still holds its pin);
 * 2. records the build as `switching`;
 * 3. sends one `_aliases` request, without client retries, that removes every current
 *    target and adds the new index;
 * 4. records the outcome. A response settles it: success is `committed`, a 4xx
 *    rejection (other than 408) is `abandoned`. A transport failure, timeout or 5xx is
 *    `unknown` whatever a read-back shows, because Elasticsearch may still apply a
 *    queued request afterwards; the new index is then kept and the alias blocked until
 *    `reconcileAlias` settles it.
 *
 * Previous indices are kept (a rollback is another switch); deleting abandoned ones is
 * `cleanupStaleBuilds`'s job.
 */
import { randomBytes } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import type pg from 'pg';
import type { Db } from '../../server/db/client.js';

/** First key of the two-key advisory locks for aliases (the single-key lifecycle locks are a separate key space). */
export const ALIAS_LOCK_NAMESPACE = 731_190_503;

/** Upper bound for the master to process the alias request; reconcile waits longer than this. */
export const ALIAS_MASTER_TIMEOUT = '30s';

const statusOf = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * receives (write the alias's publication rows on it). The lock is released with the
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
    if (locked) {
      await client.query('select pg_advisory_unlock($1, hashtext($2))', [ALIAS_LOCK_NAMESPACE, alias]).catch((e: unknown) => {
        // Discard the connection: closing the session releases the lock.
        broken = e instanceof Error ? e : new Error(String(e));
      });
    }
    client.release(broken);
  }
}

/** Builds of the alias whose switch is unresolved (`unknown`, or `switching` left by a crash). */
export async function unresolvedPublications(
  q: Pick<pg.PoolClient, 'query'> | Pick<pg.Pool, 'query'>,
  alias: string,
): Promise<{ indexName: string; status: string }[]> {
  const r = await q.query<{ index_name: string; status: string }>(
    `select index_name, status from index_publications where alias = $1 and status in ('unknown', 'switching') order by created_at`,
    [alias],
  );
  return r.rows.map((x) => ({ indexName: x.index_name, status: x.status }));
}

export function unresolvedMessage(alias: string, rows: { indexName: string; status: string }[]): string {
  return `alias ${alias} has an unresolved switch (${rows.map((r) => `${r.indexName}: ${r.status}`).join(', ')}); run pnpm worker index reconcile --alias ${alias}`;
}

export interface AliasSwitch {
  alias: string;
  index: string;
  /** Indices the alias pointed at before (kept, not deleted). */
  previous: string[];
  /** A read-back after the committed request showed exactly the new index. */
  verified: boolean;
}

export type AliasSwitchOutcome = 'not_switched' | 'unknown' | 'inconsistent';

export class AliasSwitchError extends Error {
  constructor(
    message: string,
    /**
     * `not_switched`: no request was sent, or it was rejected; the index is certainly
     * not the alias target. `unknown`: the request may still be applied; keep the index
     * and reconcile. `inconsistent`: committed, but the alias has other targets too.
     */
    readonly outcome: AliasSwitchOutcome,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'AliasSwitchError';
  }
}

export interface SwitchAliasOptions extends AliasLockOptions {
  /** Build that owns `index` (its `index_publications` row); default a fresh manual id. */
  buildId?: string;
  generationId?: number | null;
  /** Runs under the alias lock before anything is recorded or sent; throwing refuses the switch. */
  beforeSwitch?: (client: pg.PoolClient) => Promise<void>;
  /** Read-back attempts after a committed request (default 3). */
  readAttempts?: number;
  /** Delay before the second read-back attempt, doubled for each further one (default 200 ms). */
  readRetryDelayMs?: number;
}

/** A response from Elasticsearch that rejected the request: it was never applied. */
function definitelyRejected(err: unknown): boolean {
  const code = statusOf(err);
  return typeof code === 'number' && code >= 400 && code < 500 && code !== 408;
}

async function setStatus(client: pg.PoolClient, index: string, status: string): Promise<void> {
  await client.query(`update index_publications set status = $2, updated_at = now() where index_name = $1`, [index, status]);
}

/**
 * Point `alias` at `index` only, serialized with every other switch of the alias,
 * and record the outcome in `index_publications`. Throws `AliasSwitchError`; its
 * `outcome` says whether the caller may delete `index` (`not_switched` only).
 */
export async function switchAlias(
  es: Client,
  db: Db,
  alias: string,
  index: string,
  opts: SwitchAliasOptions = {},
): Promise<AliasSwitch> {
  if (alias === index) throw new AliasSwitchError('alias and index names must differ', 'not_switched');
  const attempts = Math.max(1, opts.readAttempts ?? 3);
  const delayMs = opts.readRetryDelayMs ?? 200;
  const buildId = opts.buildId ?? `manual-${randomBytes(4).toString('hex')}`;
  let sent = false;
  try {
    return await withAliasLock(
      db,
      alias,
      async (client) => {
        const unresolved = await unresolvedPublications(client, alias);
        if (unresolved.length > 0) throw new Error(unresolvedMessage(alias, unresolved));
        await opts.beforeSwitch?.(client);
        const previous = await aliasTargets(es, alias);
        if (previous.length === 0 && (await es.indices.exists({ index: alias }))) {
          throw new Error(`${alias} is a concrete index, not an alias`);
        }
        await client.query(
          `insert into index_publications (index_name, alias, build_id, generation_id, status)
           values ($1, $2, $3, $4, 'switching')
           on conflict (index_name) do update set alias = excluded.alias, status = 'switching', deleted_at = null, updated_at = now()`,
          [index, alias, buildId, opts.generationId ?? null],
        );

        sent = true;
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
            await setStatus(client, index, 'abandoned');
            throw new AliasSwitchError(`alias ${alias} not switched to ${index}: rejected (${String(err)})`, 'not_switched', err);
          }
          await setStatus(client, index, 'unknown');
          throw new AliasSwitchError(
            `alias ${alias}: switch to ${index} failed in transport and may still be applied; ${index} is kept and the alias is blocked until pnpm worker index reconcile --alias ${alias}`,
            'unknown',
            err,
          );
        }
        await setStatus(client, index, 'committed');

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
          );
        }
        return { alias, index, previous, verified: targets !== null };
      },
      opts,
    );
  } catch (err) {
    if (err instanceof AliasSwitchError) throw err;
    if (!sent) {
      // Taking the lock, the checks before the request, or recording `switching` failed.
      throw new AliasSwitchError(`alias ${alias} not switched: ${err instanceof Error ? err.message : String(err)}`, 'not_switched', err);
    }
    // Recording the outcome failed after the request: the row still says `switching`, which blocks the alias.
    throw new AliasSwitchError(`alias ${alias}: outcome of switching to ${index} not recorded; ${index} is kept`, 'unknown', err);
  }
}
