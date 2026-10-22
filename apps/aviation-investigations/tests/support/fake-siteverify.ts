/**
 * An offline stand-in for Cloudflare's siteverify endpoint, as documented
 * (developers.cloudflare.com/turnstile: server-side validation and testing) and as the
 * real endpoint answered for the test keys on 2026-10-22:
 *
 * - test secret `1x…AA`: every token passes, `hostname` `example.com`, no `action`,
 *   `metadata.result_with_testing_key` true;
 * - test secret `2x…AA`: `invalid-input-response`; test secret `3x…AA`: `timeout-or-duplicate`;
 * - the "real" secret `REAL_SECRET`: only tokens from `issue()` pass, each once, within 5
 *   minutes, reporting the hostname and action they were solved for. A retry with the
 *   same `idempotency_key` gets the first answer again, as Cloudflare documents;
 * - a missing token is `missing-input-response`, an unknown secret `invalid-input-secret`.
 *
 * `fail()` queues transport failures for the next calls: a network error, a timeout
 * (waits for the request's abort signal), HTTP 500, `internal-error`, a malformed
 * body, or `lost` (the verification runs, then the response is lost).
 */
import { randomBytes } from 'node:crypto';
import { SITEVERIFY_URL, TOKEN_LIFETIME_MS, TURNSTILE_TEST_SECRET_KEYS } from '../../server/identity/turnstile.js';

export const REAL_SECRET = 'synthetic-turnstile-secret-for-tests';
export const REAL_SITE_KEY = 'synthetic-turnstile-site-key';

export type Failure = 'network' | 'timeout' | 'http500' | 'internal-error' | 'malformed' | 'lost';

interface Issued {
  hostname: string;
  action: string;
  solvedAt: Date;
}

export interface SiteverifyCall {
  secret: string | null;
  response: string | null;
  idempotencyKey: string | null;
  remoteip: string | null;
}

export class FakeSiteverify {
  readonly calls: SiteverifyCall[] = [];
  private readonly issued = new Map<string, Issued>();
  private readonly redeemed = new Map<string, { key: string | null; body: unknown }>();
  private readonly failures: Failure[] = [];

  constructor(
    private readonly now: () => Date,
    private readonly defaults: { hostname: string; action: string },
  ) {}

  /** A token as the widget would produce it, solved now (or at `solvedAt`). */
  issue(opts: Partial<Issued> = {}): string {
    const token = `0.${randomBytes(48).toString('base64url')}`;
    this.issued.set(token, {
      hostname: opts.hostname ?? this.defaults.hostname,
      action: opts.action ?? this.defaults.action,
      solvedAt: opts.solvedAt ?? this.now(),
    });
    return token;
  }

  fail(...failures: Failure[]): void {
    this.failures.push(...failures);
  }

  private answer(secret: string | null, response: string | null, key: string | null): unknown {
    if (!secret) return { success: false, 'error-codes': ['missing-input-secret'], messages: [] };
    const testing = { result_with_testing_key: true };
    if (secret === TURNSTILE_TEST_SECRET_KEYS[0]) {
      if (!response) return { success: false, 'error-codes': ['missing-input-response'], messages: [] };
      return { success: true, 'error-codes': [], challenge_ts: this.now().toISOString(), hostname: 'example.com', metadata: testing };
    }
    if (secret === TURNSTILE_TEST_SECRET_KEYS[1]) return { success: false, 'error-codes': ['invalid-input-response'], messages: [], metadata: testing };
    if (secret === TURNSTILE_TEST_SECRET_KEYS[2]) return { success: false, 'error-codes': ['timeout-or-duplicate'], messages: [], metadata: testing };
    if (secret !== REAL_SECRET) return { success: false, 'error-codes': ['invalid-input-secret'], messages: [] };
    if (!response) return { success: false, 'error-codes': ['missing-input-response'], messages: [] };
    const previous = this.redeemed.get(response);
    if (previous) {
      return key !== null && previous.key === key ? previous.body : { success: false, 'error-codes': ['timeout-or-duplicate'], messages: [] };
    }
    const t = this.issued.get(response);
    if (!t) return { success: false, 'error-codes': ['invalid-input-response'], messages: [] };
    if (this.now().getTime() - t.solvedAt.getTime() > TOKEN_LIFETIME_MS) {
      return { success: false, 'error-codes': ['timeout-or-duplicate'], messages: [] };
    }
    const body = {
      success: true,
      'error-codes': [],
      challenge_ts: t.solvedAt.toISOString(),
      hostname: t.hostname,
      action: t.action,
      cdata: '',
      metadata: { interactive: false },
    };
    this.redeemed.set(response, { key, body });
    return body;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== SITEVERIFY_URL || init?.method !== 'POST') throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    const form = new URLSearchParams(String(init.body ?? ''));
    const call: SiteverifyCall = {
      secret: form.get('secret'),
      response: form.get('response'),
      idempotencyKey: form.get('idempotency_key'),
      remoteip: form.get('remoteip'),
    };
    this.calls.push(call);
    const failure = this.failures.shift();
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure === 'timeout') {
      const signal = init.signal;
      await new Promise<void>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) reject(signal.reason as Error);
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      });
    }
    if (failure === 'http500') return new Response('upstream error', { status: 500 });
    if (failure === 'internal-error') return Response.json({ success: false, 'error-codes': ['internal-error'], messages: [] });
    if (failure === 'malformed') return new Response('<html>not json</html>', { status: 200 });
    const body = this.answer(call.secret, call.response, call.idempotencyKey);
    if (failure === 'lost') throw new TypeError('fetch failed');
    return Response.json(body);
  };
}
