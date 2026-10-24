/** A canonical evidence snapshot must end with its retrieval deadline, even on a stalled database. */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { untilAborted } from '../db/bounded-read.js';
import type { Db, DbOrTx } from '../db/client.js';
import * as schema from '../db/schema/index.js';

export async function evidenceSnapshot<T>(db: Db, signal: AbortSignal, read: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const bound = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  bound.throwIfAborted();
  const acquiring = db.$client.connect();
  let client: pg.PoolClient;
  try { client = await untilAborted(acquiring, bound); }
  catch (error) {
    // Acquisition can finish after the request has gone; never strand that connection.
    acquiring.then((late) => late.release(), () => undefined);
    throw error;
  }
  try {
    bound.throwIfAborted();
    const work = drizzle({ client, schema }).transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
      bound.throwIfAborted();
      return read(tx);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    const value = await untilAborted(work, bound);
    client.release();
    return value;
  } catch (error) {
    // Destroy instead of returning a connection that may still have a statement in flight.
    // untilAborted observes the late rejection, including Drizzle's rollback after destruction.
    client.release(error instanceof Error ? error : new Error('evidence snapshot stopped'));
    throw error;
  }
}
