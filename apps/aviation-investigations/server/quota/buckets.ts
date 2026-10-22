/**
 * Fixed-window usage buckets (UTC). Every writer creates the rows it needs and then
 * locks them with `SELECT … FOR UPDATE` in ascending `bucket_key` order. Keys start
 * with a scope rank, so the order is principal, then network, then global, and it is
 * the same in every transaction (no lock-order deadlocks). The spend advisory lock,
 * when needed, is always taken after the bucket rows.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import type { BucketPeriod, BucketScope } from '../db/schema/index.js';
import { WINDOW_RETENTION_MS } from './policy.js';

const DAY_MS = 86_400_000;

export function windowStart(period: BucketPeriod, now: Date): Date {
  const t = now.getTime();
  switch (period) {
    case 'minute':
      return new Date(t - (t % 60_000));
    case 'hour':
      return new Date(t - (t % 3_600_000));
    case 'day':
      return new Date(t - (t % DAY_MS));
    case 'month':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}

export function windowEnd(period: BucketPeriod, start: Date): Date {
  switch (period) {
    case 'minute':
      return new Date(start.getTime() + 60_000);
    case 'hour':
      return new Date(start.getTime() + 3_600_000);
    case 'day':
      return new Date(start.getTime() + DAY_MS);
    case 'month':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
}

/** The UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const nextUtcMidnight = (now: Date): Date => windowEnd('day', windowStart('day', now));
export const monthStart = (now: Date): Date => windowStart('month', now);
export const nextMonthStart = (now: Date): Date => windowEnd('month', windowStart('month', now));

const SCOPE_RANK: Record<BucketScope, number> = { principal: 1, network: 2, global: 3 };

export interface BucketRef {
  /** Canonical lock key: `<rank>|<scope>|<subject>|<period>|<window start ISO>`. ASCII only. */
  key: string;
  scope: BucketScope;
  subject: string;
  period: BucketPeriod;
  start: Date;
  end: Date;
  expiresAt: Date;
}

export function bucketRef(scope: BucketScope, subject: string, period: BucketPeriod, now: Date): BucketRef {
  const start = windowStart(period, now);
  const end = windowEnd(period, start);
  return {
    key: `${SCOPE_RANK[scope]}|${scope}|${subject}|${period}|${start.toISOString()}`,
    scope,
    subject,
    period,
    start,
    end,
    expiresAt: new Date(end.getTime() + WINDOW_RETENTION_MS),
  };
}

export interface BucketCounts {
  attempts: number;
  requests: number;
}

/** Distinct refs in lock order (code-unit order equals `COLLATE "C"` for ASCII keys). */
function lockOrder(refs: readonly BucketRef[]): BucketRef[] {
  const byKey = new Map(refs.map((r) => [r.key, r]));
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Create missing bucket rows, then lock all of them in key order. Must run inside a
 * transaction, before any other lock the caller takes on buckets or spend.
 */
export async function lockBuckets(tx: DbOrTx, refs: readonly BucketRef[]): Promise<Map<string, BucketCounts>> {
  const ordered = lockOrder(refs);
  if (ordered.length === 0) return new Map();
  const values = sql.join(
    ordered.map((r) => sql`(${r.key}, ${r.scope}, ${r.subject}, ${r.period}, ${r.start}, ${r.expiresAt})`),
    sql`, `,
  );
  // VALUES rows are inserted in order, so concurrent creators also meet in key order.
  await tx.execute(sql`
    INSERT INTO usage_buckets (bucket_key, scope, subject, period, period_start, expires_at)
    VALUES ${values}
    ON CONFLICT (bucket_key) DO NOTHING`);
  const keys = ordered.map((r) => r.key);
  const res = await tx.execute(sql`
    SELECT bucket_key, attempts, requests FROM usage_buckets
    WHERE bucket_key = ANY(${sql.param(keys)}::text[])
    ORDER BY bucket_key COLLATE "C"
    FOR UPDATE`);
  const out = new Map<string, BucketCounts>();
  for (const row of res.rows as { bucket_key: string; attempts: number; requests: number }[]) {
    out.set(row.bucket_key, { attempts: row.attempts, requests: row.requests });
  }
  if (out.size !== ordered.length) throw new Error('usage bucket rows missing after creation');
  return out;
}

/** Read bucket counts without locking (status display). Missing rows count as zero. */
export async function readBuckets(db: DbOrTx, refs: readonly BucketRef[]): Promise<Map<string, BucketCounts>> {
  const out = new Map<string, BucketCounts>(refs.map((r) => [r.key, { attempts: 0, requests: 0 }]));
  if (refs.length === 0) return out;
  const res = await db.execute(sql`
    SELECT bucket_key, attempts, requests FROM usage_buckets WHERE bucket_key = ANY(${sql.param(refs.map((r) => r.key))}::text[])`);
  for (const row of res.rows as { bucket_key: string; attempts: number; requests: number }[]) {
    out.set(row.bucket_key, { attempts: row.attempts, requests: row.requests });
  }
  return out;
}

/** Add `delta` to one counter of buckets the caller has already locked (never below zero). */
export async function addToBuckets(
  tx: DbOrTx,
  refs: readonly BucketRef[],
  field: 'attempts' | 'requests',
  delta: number,
): Promise<void> {
  if (refs.length === 0 || delta === 0) return;
  const keys = lockOrder(refs).map((r) => r.key);
  const update =
    field === 'attempts'
      ? sql`UPDATE usage_buckets SET attempts = greatest(0, attempts + ${delta}) WHERE bucket_key = ANY(${sql.param(keys)}::text[])`
      : sql`UPDATE usage_buckets SET requests = greatest(0, requests + ${delta}) WHERE bucket_key = ANY(${sql.param(keys)}::text[])`;
  await tx.execute(update);
}

export const countsOf = (m: Map<string, BucketCounts>, ref: BucketRef): BucketCounts =>
  m.get(ref.key) ?? { attempts: 0, requests: 0 };
