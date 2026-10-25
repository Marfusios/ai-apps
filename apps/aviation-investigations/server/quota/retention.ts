/**
 * Retention of the control tables (DESIGN §7), run periodically by the app:
 * idempotency records after 24 hours, quota buckets and anti-abuse records after their
 * window plus 7 days, trial identities after 30 days, redeemed Turnstile tokens after
 * 15 minutes, ledger lines and closed reservations after 90 days, AI briefs and their steps
 * once expired (24 hours). Open reservations are never pruned. The deletes run in the
 * migrator-owned `prune_controls()` (migration 0014), the only path that may delete
 * ledger lines, briefs and brief steps.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';

export interface PruneReport {
  idempotency: number;
  usageBuckets: number;
  trialIdentities: number;
  turnstileRedemptions: number;
  abuseRecords: number;
  costLedger: number;
  leases: number;
  reservations: number;
  evidenceSearches: number;
  briefs: number;
  briefSteps: number;
}

export async function pruneControls(db: DbOrTx): Promise<PruneReport> {
  const res = await db.execute(sql`SELECT prune_controls() AS report`);
  return (res.rows[0] as { report: PruneReport }).report;
}
