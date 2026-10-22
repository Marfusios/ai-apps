/**
 * Lock waits in the cost gate are bounded. Admission, settlement and spend reservation
 * set a 2-second `lock_timeout` for their transaction; a timeout rolls everything back
 * and is reported as `busy` (fail closed: nothing is admitted, reserved or refunded).
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';

/** Must be the first statement of the transaction. Applies to row and advisory locks. */
export async function setLockTimeout(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
}

/** True for PostgreSQL `lock_not_available` (55P03), however deeply the driver error is wrapped. */
export function isLockTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === '55P03') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
