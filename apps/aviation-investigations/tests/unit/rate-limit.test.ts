import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../server/http/rate-limit.js';

describe('RateLimiter', () => {
  it('allows 60 requests a minute per identity and refuses the 61st with a retry time', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ limit: 60, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 60; i++) expect(limiter.take('192.0.2.1').ok).toBe(true);
    expect(limiter.take('192.0.2.1')).toEqual({ ok: false, retryAfterSeconds: 1 });
    // Another identity has its own bucket.
    expect(limiter.take('192.0.2.2').ok).toBe(true);
    // Tokens come back evenly: one a second.
    now += 1_000;
    expect(limiter.take('192.0.2.1').ok).toBe(true);
    expect(limiter.take('192.0.2.1').ok).toBe(false);
    now += 60_000;
    for (let i = 0; i < 60; i++) expect(limiter.take('192.0.2.1').ok).toBe(true);
    expect(limiter.take('192.0.2.1').ok).toBe(false);
  });

  it('sweeps refilled buckets and bounds the number of identities', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 1_000, maxKeys: 3, now: () => now });
    for (const key of ['a', 'b', 'c', 'd']) limiter.take(key);
    expect(limiter.size).toBe(3);
    now += 2_000;
    limiter.take('e');
    expect(limiter.size).toBe(1);
  });
});
