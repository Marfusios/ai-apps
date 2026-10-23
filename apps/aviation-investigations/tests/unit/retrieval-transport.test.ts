/**
 * Retrieval's transport options (server/search/hybrid.ts `transport`): an aborted search
 * ends at once. The load test of task 10e found cancelled retrievals ending 1 to 2 s
 * after the abort: when an abort surfaces as a connection error, @elastic/transport
 * retries after its backoff and only then sees the abort. A real client over a
 * connection that fails exactly that way shows the wait, and that the options skip it.
 */
import { BaseConnection, Client, errors } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { transport } from '../../server/search/hybrid.js';
import { abortAwareBackoff } from '../../server/search/index-meta.js';

/** A connection that answers nothing and, once the request's signal aborts, fails as a lost connection. */
class AbortsAsConnectionError extends BaseConnection {
  override async request(_params: unknown, options: { signal?: AbortSignal }): Promise<never> {
    return new Promise<never>((_, reject) => {
      const fail = () => reject(new errors.ConnectionError('the socket closed under the abort'));
      if (options.signal?.aborted) fail();
      else options.signal?.addEventListener('abort', fail, { once: true });
    });
  }
}

async function abortAfter(client: Client, opts: Record<string, unknown>, controller: AbortController): Promise<number> {
  const pending = client.search({ index: 'any' }, opts);
  pending.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 10));
  const t0 = performance.now();
  controller.abort();
  await expect(pending).rejects.toThrow();
  return performance.now() - t0;
}

describe('retrieval transport options', () => {
  const client = new Client({ node: 'http://127.0.0.1:9', Connection: AbortsAsConnectionError, maxRetries: 1 });

  it('end an aborted search at once, even when the abort surfaces as a connection error', async () => {
    const c = new AbortController();
    expect(await abortAfter(client, transport({ timeoutMs: 5_000 }, c.signal), c)).toBeLessThan(300);
    // Without them the transport waits out its backoff (1 to 2 s) before it notices the abort.
    const d = new AbortController();
    expect(await abortAfter(client, { requestTimeout: 5_000, signal: d.signal }, d)).toBeGreaterThan(900);
  }, 10_000);

  it('keep the transport’s own backoff while the request is live', () => {
    const c = new AbortController();
    const backoff = abortAwareBackoff(c.signal);
    for (let i = 0; i < 50; i += 1) {
      const wait = backoff(0, 4, 1);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(2);
    }
    c.abort();
    expect(backoff(0, 4, 1)).toBe(0);
    expect(transport({ timeoutMs: 123 })).toEqual({ requestTimeout: 123 });
    expect(transport({ timeoutMs: 123 }, c.signal)).toMatchObject({ requestTimeout: 123, signal: c.signal, retryBackoff: expect.any(Function) });
  });
});
