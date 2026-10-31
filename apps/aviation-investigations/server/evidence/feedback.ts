import { and, eq, gt, sql } from 'drizzle-orm';
import type { EvidenceFeedbackRating } from '../../shared/contracts/evidence.js';
import type { BriefReader } from '../briefs/store.js';
import type { DbOrTx } from '../db/client.js';
import { evidenceSearches } from '../db/schema/evidence.js';
import { readersWhere } from './store.js';

/** Ownership is part of the writing statement; the trigger updates the daily total atomically. */
export async function rateEvidence(db: DbOrTx, id: string, readers: readonly BriefReader[], rating: EvidenceFeedbackRating, now: Date): Promise<boolean> {
  if (!readers.length) return false;
  const rows = await db.update(evidenceSearches).set({ feedbackRating: rating }).where(and(
    eq(evidenceSearches.id, id), eq(evidenceSearches.status, 'results'), readersWhere(readers),
    gt(evidenceSearches.expiresAt, now), sql`${evidenceSearches.expiresAt} > clock_timestamp()`,
  )).returning({ id: evidenceSearches.id });
  return rows.length === 1;
}

/** Bounded serial work queue. Reads the latest committed rating, not a stale request body.
 * One score id and timestamp per trace make changing a rating replace that score. */
export function feedbackExporter(db: DbOrTx, api: (path: string, body: object) => Promise<unknown>, environment: 'dev' | 'live', warn: () => void) {
  const pending = new Set<string>(); let running = false; let draining: Promise<void> = Promise.resolve();
  let stopped = false;
  async function drain() {
    running = true;
    try {
      while (pending.size && !stopped) {
        const id = pending.values().next().value!; pending.delete(id);
        try {
          const [row] = await db.select({ traceId: evidenceSearches.traceId, rating: evidenceSearches.feedbackRating, createdAt: evidenceSearches.createdAt }).from(evidenceSearches)
            .where(and(eq(evidenceSearches.id, id), gt(evidenceSearches.expiresAt, new Date())));
          if (!row?.traceId || !row.rating) continue;
          await api('scores', { id: `visitor-feedback-${row.traceId}`, traceId: row.traceId, name: 'visitor_feedback',
            value: row.rating === 'useful' ? 1 : 0, dataType: 'NUMERIC', environment, timestamp: row.createdAt.toISOString() });
        } catch { try { warn(); } catch { /* optional */ } }
      }
    } finally { running = false; }
  }
  return {
    enqueue(id: string) {
      if (stopped || pending.size >= 256) return;
      pending.add(id);
      if (!running) draining = drain();
    },
    settled: () => draining,
    stop() { stopped = true; pending.clear(); },
  };
}
