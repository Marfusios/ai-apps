/**
 * Search aliases.
 *
 * An alias such as `aviation-cases` means "the index built last" for operators and
 * tools. The API never reads it: every request uses the index names of the active
 * `dataset_manifests` row (`getActiveManifest`), which is published separately once
 * both indices of a generation exist.
 *
 * Switches are serialized per alias across workers with a PostgreSQL advisory lock
 * keyed on the alias name, held from reading the current targets until the outcome
 * has been read back. Under the lock one `_aliases` request removes every current
 * target and adds the new index, so the alias never points at two indices and a
 * reader sees either the old or the new index. Previous indices are kept (a rollback
 * is another switch); removing them is a separate, explicit step.
 *
 * The request can commit even when its response is lost, so the outcome is always
 * read back: `AliasSwitchError.outcome` tells the caller whether the new index is
 * certainly not the alias target (`not_switched`, safe to delete) or may be
 * (`unknown`, `inconsistent`: keep it).
 */
import type { Client } from '@elastic/elasticsearch';
import type { Db } from '../../server/db/client.js';

/** First key of the two-key advisory locks for aliases (the single-key lifecycle locks are a separate key space). */
export const ALIAS_LOCK_NAMESPACE = 731_190_503;

const status = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Concrete indices the alias points at (empty when it does not exist). */
export async function aliasTargets(es: Client, alias: string): Promise<string[]> {
  try {
    const found = await es.indices.getAlias({ name: alias });
    return Object.keys(found).sort();
  } catch (e) {
    if (status(e) === 404) return [];
    throw e;
  }
}

export interface AliasLockOptions {
  /** Give up waiting for another worker's switch after this long (default 120 s). */
  lockTimeoutMs?: number;
}

/**
 * Run `fn` holding the advisory lock of `alias` on a dedicated connection. The lock
 * is released with the connection if the process dies.
 */
export async function withAliasLock<T>(db: Db, alias: string, fn: () => Promise<T>, opts: AliasLockOptions = {}): Promise<T> {
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
    return await fn();
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

export interface AliasSwitch {
  alias: string;
  index: string;
  /** Indices the alias pointed at before (kept, not deleted). */
  previous: string[];
  /** The request failed or its result could not be read at first, but read-back showed the switch committed. */
  reconciled: boolean;
}

export type AliasSwitchOutcome = 'not_switched' | 'unknown' | 'inconsistent';

export class AliasSwitchError extends Error {
  constructor(
    message: string,
    /** `not_switched`: the alias certainly does not include the new index. Otherwise it may: keep the index. */
    readonly outcome: AliasSwitchOutcome,
    /** Alias targets read back, when they could be read. */
    readonly targets: string[] | null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'AliasSwitchError';
  }
}

export interface SwitchAliasOptions extends AliasLockOptions {
  /** Read-back attempts after the request (default 5). */
  readAttempts?: number;
  /** Delay before the second read-back attempt, doubled for each further one (default 200 ms). */
  readRetryDelayMs?: number;
}

async function readBack(
  es: Client,
  alias: string,
  attempts: number,
  delayMs: number,
): Promise<{ targets: string[] | null; failedReads: number; error?: unknown }> {
  let error: unknown;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(delayMs * 2 ** (i - 1));
    try {
      return { targets: await aliasTargets(es, alias), failedReads: i };
    } catch (e) {
      error = e;
    }
  }
  return { targets: null, failedReads: attempts, error };
}

/**
 * Point `alias` at `index` only, serialized with every other switch of the alias.
 * Throws `AliasSwitchError`; its `outcome` says whether the caller may delete `index`.
 */
export async function switchAlias(
  es: Client,
  db: Db,
  alias: string,
  index: string,
  opts: SwitchAliasOptions = {},
): Promise<AliasSwitch> {
  if (alias === index) throw new AliasSwitchError('alias and index names must differ', 'not_switched', null);
  const attempts = Math.max(1, opts.readAttempts ?? 5);
  const delayMs = opts.readRetryDelayMs ?? 200;
  const switching = withAliasLock(
    db,
    alias,
    async () => {
      // Before the request nothing has changed: any failure leaves the alias as it was.
      let previous: string[];
      try {
        previous = await aliasTargets(es, alias);
        if (previous.length === 0 && (await es.indices.exists({ index: alias }))) {
          throw new Error(`${alias} is a concrete index, not an alias`);
        }
      } catch (err) {
        throw new AliasSwitchError(`alias ${alias} not switched: ${String(err)}`, 'not_switched', null, err);
      }

      let requestError: unknown;
      try {
        await es.indices.updateAliases({
          actions: [
            ...previous.filter((p) => p !== index).map((p) => ({ remove: { index: p, alias, must_exist: true } })),
            { add: { index, alias } },
          ],
        });
      } catch (err) {
        requestError = err;
      }

      // The request may have committed although its response was lost: read the outcome.
      const back = await readBack(es, alias, attempts, delayMs);
      if (back.targets === null) {
        throw new AliasSwitchError(
          `alias ${alias}: outcome of switching to ${index} unknown (targets unreadable); ${index} is kept`,
          'unknown',
          null,
          requestError ?? back.error,
        );
      }
      const targets = back.targets;
      if (targets.length === 1 && targets[0] === index) {
        return { alias, index, previous, reconciled: requestError !== undefined || back.failedReads > 0 };
      }
      if (!targets.includes(index)) {
        throw new AliasSwitchError(
          `alias ${alias} was not switched to ${index}; it points at ${targets.join(', ') || 'nothing'}`,
          'not_switched',
          targets,
          requestError,
        );
      }
      throw new AliasSwitchError(
        `alias ${alias} points at ${targets.join(', ')} after switching to ${index}; ${index} is kept`,
        'inconsistent',
        targets,
        requestError,
      );
    },
    opts,
  );
  try {
    return await switching;
  } catch (err) {
    if (err instanceof AliasSwitchError) throw err;
    // Only taking the lock can fail outside the switch itself, before any request.
    throw new AliasSwitchError(`alias ${alias} not switched: ${String(err)}`, 'not_switched', null, err);
  }
}
