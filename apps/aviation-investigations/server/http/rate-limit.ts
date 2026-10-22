/**
 * In-memory browsing rate limit per network identity (DESIGN §8): a token bucket of
 * `limit` requests refilled evenly over `windowMs` (60 a minute by default), so a
 * burst of `limit` is allowed and the next request waits for a token.
 *
 * Buckets live in this process only (one app container per environment). Memory is
 * bounded: full buckets are swept, and beyond `maxKeys` the least recently used
 * buckets are dropped (a dropped identity starts again with a full bucket).
 */

export interface RateLimitOptions {
  /** Requests per window (bucket capacity). */
  limit: number;
  windowMs: number;
  /** Most identities tracked at once (default 50,000). */
  maxKeys?: number;
  now?: () => number;
}

export type RateDecision = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly perMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(opts: RateLimitOptions) {
    if (!(opts.limit >= 1) || !(opts.windowMs > 0)) throw new Error('rate limit needs limit >= 1 and windowMs > 0');
    this.limit = opts.limit;
    this.perMs = opts.limit / opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 50_000;
    this.now = opts.now ?? Date.now;
    this.lastSweep = this.now();
  }

  /** Take one token for `key`. */
  take(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Re-inserted below, so iteration order is least recently used first.
      this.buckets.delete(key);
    } else {
      while (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (oldest.done) break;
        this.buckets.delete(oldest.value);
      }
      bucket = { tokens: this.limit, updated: now };
    }
    bucket.tokens = Math.min(this.limit, bucket.tokens + (now - bucket.updated) * this.perMs);
    bucket.updated = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000)) };
  }

  /** Identities currently tracked (tests). */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    // At most once per window: drop buckets that have refilled completely.
    if (now - this.lastSweep < this.limit / this.perMs) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.updated) * this.perMs >= this.limit) this.buckets.delete(key);
    }
  }
}
