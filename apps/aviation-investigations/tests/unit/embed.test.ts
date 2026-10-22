import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { describeWorkerError } from '../../worker/errors.js';
import {
  EMBEDDING_LIMITS,
  EmbeddingDeferredError,
  EmbeddingRequestError,
  CacheOnlyEmbeddingError,
  RESERVATION_SAFETY_FACTOR,
  batchByLimits,
  cacheOnlyEmbedder,
  checkBatch,
  createFakeEmbedder,
  createOpenAIEmbedder,
  fakeVector,
  parseResetDuration,
  reservationUsd,
} from '../../worker/index/embed.js';
import { bytesToVector, vectorToBytes } from '../../worker/index/embedding-cache.js';
import {
  SpendRefusedError,
  ceilUsd,
  createDryRunSpendGate,
  createMemorySpendGate,
  type SpendGate,
} from '../../worker/index/spend-gate.js';
import { countTokens } from '../../worker/index/tokens.js';

const DIMS = 8;
const PRICE = 0.02;
const API_KEY = 'sk-test-not-a-real-key';

type Step = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | { throw: Error };

function vectorB64(seed: number): string {
  const v = new Float32Array(DIMS).map((_, i) => (i + seed) / 10);
  return Buffer.from(v.buffer).toString('base64');
}

function okBody(n: number, promptTokens: number) {
  return {
    object: 'list',
    model: 'text-embedding-3-small',
    data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', index: n - 1 - i, embedding: vectorB64(n - 1 - i) })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

/** A fake `fetch` that plays `steps` in order and logs each call into `events`. */
function scriptedFetch(steps: Step[], events: string[]) {
  const requests: { body: Record<string, unknown>; auth: string | null }[] = [];
  const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const step = steps.shift();
    events.push('fetch');
    const headers = new Headers(init?.headers);
    requests.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, auth: headers.get('authorization') });
    if (!step) throw new Error('unexpected request');
    if ('throw' in step) throw step.throw;
    return new Response(step.raw ?? JSON.stringify(step.body ?? { error: { message: 'failure', type: 'server_error', code: null } }), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...step.headers },
    });
  };
  return { fetch: impl as typeof fetch, requests };
}

/** Wrap a gate so reservations and settlements land in the same event log as requests. */
function logged(gate: SpendGate, events: string[]): SpendGate {
  return {
    reserve: async (req) => {
      const r = await gate.reserve(req);
      events.push(`reserve ${req.usd.toFixed(6)}`);
      return r;
    },
    settle: async (res, outcome) => {
      await gate.settle(res, outcome);
      events.push(outcome === 'uncertain' ? 'settle uncertain' : `settle ${outcome.usd.toFixed(6)}`);
    },
    remainingUsd: (c) => gate.remainingUsd(c),
  };
}

/** An embedder on a scripted fetch, an in-memory gate and a fake clock that sleeping advances. */
function embedderWith(steps: Step[], allowance = 1) {
  const events: string[] = [];
  const memory = createMemorySpendGate(allowance);
  const sleeps: number[] = [];
  const clock = { now: Date.parse('2026-10-22T12:00:00Z') };
  const { fetch, requests } = scriptedFetch(steps, events);
  const embedder = createOpenAIEmbedder({
    apiKey: API_KEY,
    model: 'text-embedding-3-small',
    dims: DIMS,
    gate: logged(memory, events),
    purpose: 'test',
    fetch,
    baseURL: 'http://embeddings.test/v1',
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      events.push(`sleep ${ms}`);
      clock.now += ms;
    },
  });
  return { embedder, events, memory, sleeps, requests, clock };
}

const TEXTS = ['Probable cause · CESSNA 172S · Landing\nThe pilot’s failure to flare.', 'Analysis · PIPER PA-28\nFuel exhaustion.'];
const TOKENS = TEXTS.reduce((n, t) => n + countTokens(t), 0);
const RESERVE = reservationUsd(TOKENS, PRICE);

describe('OpenAI embedder', () => {
  it('reserves before dispatch, settles at the reported usage and decodes vectors in input order', async () => {
    const { embedder, events, memory, requests } = embedderWith([{ status: 200, body: okBody(2, TOKENS) }]);
    const res = await embedder.embed(TEXTS);
    expect(events).toEqual([`reserve ${RESERVE.toFixed(6)}`, 'fetch', `settle ${ceilUsd((TOKENS * PRICE) / 1e6).toFixed(6)}`]);
    expect(res.tokens).toBe(TOKENS);
    expect(Array.from(res.vectors[0] as Float32Array)).toEqual(Array.from(new Float32Array(DIMS).map((_, i) => i / 10)));
    expect(Array.from(res.vectors[1] as Float32Array)).toEqual(Array.from(new Float32Array(DIMS).map((_, i) => (i + 1) / 10)));
    expect(requests[0]?.body).toMatchObject({ model: 'text-embedding-3-small', input: TEXTS, dimensions: DIMS, encoding_format: 'base64' });
    expect(memory.records).toEqual([expect.objectContaining({ category: 'indexing', status: 'settled', reservedUsd: RESERVE })]);
    expect(RESERVE).toBeGreaterThanOrEqual((TOKENS * PRICE * RESERVATION_SAFETY_FACTOR) / 1e6);
  });

  it('reserves and settles every attempt separately: 429 at zero, 5xx and lost connections in full', async () => {
    const { embedder, events, memory, sleeps } = embedderWith([
      { status: 429, body: { error: { message: 'slow down', type: 'requests', code: 'rate_limit_exceeded' } } },
      { status: 503 },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    await embedder.embed(TEXTS);
    const reserve = `reserve ${RESERVE.toFixed(6)}`;
    expect(events).toEqual([
      reserve, 'fetch', 'settle 0.000000', 'sleep 1000',
      reserve, 'fetch', 'settle uncertain', 'sleep 2000',
      reserve, 'fetch', `settle ${ceilUsd((TOKENS * PRICE) / 1e6).toFixed(6)}`,
    ]);
    expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([
      ['settled', 0],
      ['uncertain', RESERVE],
      ['settled', ceilUsd((TOKENS * PRICE) / 1e6)],
    ]);
    expect(memory.chargedUsd('indexing')).toBeCloseTo(RESERVE + ceilUsd((TOKENS * PRICE) / 1e6), 9);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('treats a 408 as uncertain and retryable', async () => {
    const { embedder, memory } = embedderWith([{ status: 408 }, { status: 200, body: okBody(2, TOKENS) }]);
    await embedder.embed(TEXTS);
    expect(memory.records.map((r) => r.status)).toEqual(['uncertain', 'settled']);
  });

  it('gives up after three attempts, leaving uncertain attempts charged at their reservation', async () => {
    const lost = () => ({ throw: Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }) });
    const { embedder, events, memory } = embedderWith([lost(), lost(), lost(), { status: 200, body: okBody(2, TOKENS) }]);
    const err = await embedder.embed(TEXTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingRequestError);
    expect((err as EmbeddingRequestError).attempts).toBe(3);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(3);
    expect(memory.records.map((r) => r.status)).toEqual(['uncertain', 'uncertain', 'uncertain']);
    expect(memory.chargedUsd('indexing')).toBeCloseTo(3 * RESERVE, 9);
  });

  it('does not retry client errors or an exhausted quota, and never puts the key in the error', async () => {
    for (const step of [
      { status: 400, body: { error: { message: 'bad input', type: 'invalid_request_error', code: null } } },
      { status: 401, body: { error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' } } },
      { status: 429, body: { error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' } } },
    ]) {
      const { embedder, events, memory } = embedderWith([step, { status: 200, body: okBody(2, TOKENS) }]);
      const err = (await embedder.embed(TEXTS).catch((e: unknown) => e)) as EmbeddingRequestError;
      expect(err).toBeInstanceOf(EmbeddingRequestError);
      expect(err.status).toBe(step.status);
      expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
      expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([['settled', 0]]);
      expect(String(err.message)).not.toContain(API_KEY);
    }
  });

  it('honours a long Retry-After in full; only the local backoff is capped', async () => {
    const limited = { error: { message: 'slow', type: 'requests', code: 'rate_limit_exceeded' } };
    const { embedder, sleeps, events } = embedderWith([
      { status: 429, headers: { 'retry-after': '120' }, body: limited },
      { status: 429, headers: { 'retry-after-ms': '450000' }, body: limited },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    await embedder.embed(TEXTS);
    expect(sleeps).toEqual([120_000, 450_000]);
    // No request is sent before the provider's deadline has passed.
    expect(events.filter((e) => e === 'fetch' || e.startsWith('sleep'))).toEqual(['fetch', 'sleep 120000', 'fetch', 'sleep 450000', 'fetch']);

    const backoff = embedderWith([{ status: 503 }, { status: 503 }, { status: 200, body: okBody(2, TOKENS) }]);
    const capped = createOpenAIEmbedder({
      apiKey: API_KEY, model: 'text-embedding-3-small', dims: DIMS, gate: createMemorySpendGate(1), purpose: 't',
      baseURL: 'http://embeddings.test/v1', fetch: scriptedFetch([{ status: 503 }, { status: 503 }, { status: 200, body: okBody(2, TOKENS) }], []).fetch,
      baseDelayMs: 50_000, maxBackoffMs: 60_000, sleep: async (ms) => void backoff.sleeps.push(ms),
    });
    await capped.embed(TEXTS);
    expect(backoff.sleeps).toEqual([50_000, 60_000]);
  });

  it('stops resumably when the provider asks to wait longer than the limit, with nothing left open', async () => {
    const { embedder, events, memory, clock } = embedderWith([
      { status: 429, headers: { 'retry-after': String(11 * 60) }, body: { error: { message: 'slow', type: 'requests', code: 'rate_limit_exceeded' } } },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    const err = await embedder.embed(TEXTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingDeferredError);
    expect((err as EmbeddingDeferredError).retryAt.getTime()).toBe(clock.now + 11 * 60_000);
    expect(String((err as Error).message)).toMatch(/rerun after .* cached/);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
    expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([['settled', 0]]);
  });

  it('waits for the token rate limit to reset before the next request, or stops when the reset is too far', async () => {
    const low = (reset: string) => ({ status: 200, body: okBody(2, TOKENS), headers: { 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': reset } });
    const { embedder, events } = embedderWith([low('2m0s'), { status: 200, body: okBody(2, TOKENS) }]);
    await embedder.embed(TEXTS);
    await embedder.embed(TEXTS);
    expect(events.filter((e) => e === 'fetch' || e.startsWith('sleep') || e.startsWith('reserve'))).toEqual([
      `reserve ${RESERVE.toFixed(6)}`, 'fetch', 'sleep 120000', `reserve ${RESERVE.toFixed(6)}`, 'fetch',
    ]);

    const far = embedderWith([low('15m0s'), { status: 200, body: okBody(2, TOKENS) }]);
    await far.embedder.embed(TEXTS);
    await expect(far.embedder.embed(TEXTS)).rejects.toBeInstanceOf(EmbeddingDeferredError);
    // Stopped before reserving or sending anything.
    expect(far.events.filter((e) => e === 'fetch')).toHaveLength(1);
    expect(far.memory.records).toHaveLength(1);
  });

  it('waits for rate-limit resets reported on a 429, taking the latest deadline', async () => {
    const limited = { error: { message: 'slow', type: 'tokens', code: 'rate_limit_exceeded' } };
    const cases: [Record<string, string>, number][] = [
      // No remaining tokens: wait for the token reset, not the 1 s local backoff.
      [{ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m0s' }, 120_000],
      // Remaining count not reported on a 429: the reset still applies; the later of it and Retry-After wins.
      [{ 'retry-after': '30', 'x-ratelimit-reset-tokens': '2m0s' }, 120_000],
      [{ 'retry-after': '200', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m0s' }, 200_000],
      // Out of requests.
      [{ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m30s', 'x-ratelimit-remaining-tokens': '900000', 'x-ratelimit-reset-tokens': '5s' }, 90_000],
    ];
    for (const [headers, wait] of cases) {
      const { embedder, events, sleeps } = embedderWith([{ status: 429, headers, body: limited }, { status: 200, body: okBody(2, TOKENS) }]);
      await embedder.embed(TEXTS);
      expect(sleeps).toEqual([wait]);
      expect(events.filter((e) => e === 'fetch' || e.startsWith('sleep') || e.startsWith('reserve'))).toEqual([
        `reserve ${RESERVE.toFixed(6)}`, 'fetch', `sleep ${wait}`, `reserve ${RESERVE.toFixed(6)}`, 'fetch',
      ]);
    }
    // Plenty of tokens left: the token reset does not apply; the local backoff does.
    const plenty = embedderWith([
      { status: 429, headers: { 'x-ratelimit-remaining-tokens': '900000', 'x-ratelimit-reset-tokens': '2m0s' }, body: limited },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    await plenty.embedder.embed(TEXTS);
    expect(plenty.sleeps).toEqual([1000]);
  });

  it('stops resumably when a 429 reports a rate-limit reset beyond the limit', async () => {
    const { embedder, events, memory, clock } = embedderWith([
      { status: 429, headers: { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '15m0s' }, body: { error: { message: 'slow', type: 'tokens', code: 'rate_limit_exceeded' } } },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    const err = await embedder.embed(TEXTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingDeferredError);
    expect((err as EmbeddingDeferredError).retryAt.getTime()).toBe(clock.now + 15 * 60_000);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
    // The rejected attempt was settled at zero before stopping; nothing is left open.
    expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([['settled', 0]]);
  });

  it('reports malformed successful responses by fixed categories, never by their content', async () => {
    const S = 'SENTINEL_RESPONSE';
    const item = (index: unknown, embedding: unknown = vectorB64(0)) => ({ object: 'embedding', index, embedding });
    const body = (data: unknown, usage: unknown = { prompt_tokens: TOKENS, total_tokens: TOKENS }) => ({ object: 'list', model: S, data, usage });
    const short = Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64');
    const cases: [Step, string][] = [
      [{ status: 200, body: body([item(S), item(1)]) }, 'invalid embedding response: invalid_response_shape'],
      [{ status: 200, body: body([item(0), item(99)]) }, 'invalid embedding response: index_out_of_range'],
      [{ status: 200, body: body([item(0), item(0)]) }, 'invalid embedding response: index_out_of_range'],
      [{ status: 200, body: body([item(0), item(1, short)]) }, 'invalid embedding response: dimension_mismatch'],
      [{ status: 200, body: body([item(0), item(1, { [S]: S })]) }, 'invalid embedding response: invalid_response_shape'],
      [{ status: 200, body: body(S) }, 'invalid embedding response: invalid_response_shape'],
      [{ status: 200, body: body([item(0)]) }, 'invalid embedding response: count_mismatch'],
      [{ status: 200, raw: `${S} is not JSON` }, 'embedding request failed after 1 attempt(s): unexpected client error'],
    ];
    for (const [step, message] of cases) {
      const events: string[] = [];
      const gate = createMemorySpendGate(1);
      const embedder = createOpenAIEmbedder({
        apiKey: API_KEY, model: 'text-embedding-3-small', dims: DIMS, gate, purpose: 'test',
        fetch: scriptedFetch([step, { status: 200, body: okBody(2, TOKENS) }], events).fetch, baseURL: 'http://embeddings.test/v1',
        sleep: async () => undefined, log: (m) => events.push(m),
      });
      const err = await embedder.embed(TEXTS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingRequestError);
      expect((err as Error).message).toBe(message);
      expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
      for (const text of [describeWorkerError(err), inspect(err, { depth: 10 }), JSON.stringify(err), ...events]) {
        expect(text).not.toContain('SENTINEL');
      }
      // Processed requests stay charged: at the reported usage, or in full when it is unusable.
      // (A body that is not JSON cannot be checked for usage: uncertain.)
      expect(gate.records.map((r) => r.status)).toEqual(['raw' in step ? 'uncertain' : 'settled']);
    }

    // A usable response without a usable usage report succeeds and is charged in full.
    const events: string[] = [];
    const gate = createMemorySpendGate(1);
    const embedder = createOpenAIEmbedder({
      apiKey: API_KEY, model: 'text-embedding-3-small', dims: DIMS, gate, purpose: 'test',
      fetch: scriptedFetch([{ status: 200, body: { ...okBody(2, TOKENS), usage: { prompt_tokens: S } } }], events).fetch,
      baseURL: 'http://embeddings.test/v1', log: (m) => events.push(m),
    });
    const res = await embedder.embed(TEXTS);
    expect(res.tokens).toBe(TOKENS);
    expect(gate.records.map((r) => [r.status, r.chargedUsd])).toEqual([['uncertain', RESERVE]]);
    for (const text of events) expect(text).not.toContain('SENTINEL');
  });

  it('keeps provider messages, keys and inputs out of errors and the worker error line', async () => {
    // Shaped like a project key, assembled so the repository scanner does not mistake it for one.
    const KEY = ['sk', 'proj', 'SENTINELKEY0123456789'].join('-');
    const INPUT = 'INPUT-SENTINEL narrative text';
    const leaky = (status: number) => ({
      status,
      body: { error: { message: `Incorrect API key provided: ${KEY}. Input was: ${INPUT}`, type: 'invalid_request_error', code: `bad code ${INPUT}` } },
      headers: { 'x-request-id': `req ${KEY}` },
    });
    const lost = { throw: Object.assign(new TypeError(`fetch failed for ${KEY} ${INPUT}`), { cause: new Error(`${KEY} ${INPUT}`) }) };
    for (const steps of [[leaky(401)], [leaky(400)], [leaky(500), leaky(500), leaky(500)], [lost, lost, lost]] as Step[][]) {
      const events: string[] = [];
      const embedder = createOpenAIEmbedder({
        apiKey: KEY,
        model: 'text-embedding-3-small',
        dims: DIMS,
        gate: createMemorySpendGate(1),
        purpose: 'test',
        fetch: scriptedFetch(steps, events).fetch,
        baseURL: 'http://embeddings.test/v1',
        sleep: async () => undefined,
        log: (m) => events.push(m),
      });
      const err = await embedder.embed([INPUT]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingRequestError);
      expect((err as Error).cause).toBeUndefined();
      for (const text of [describeWorkerError(err), inspect(err, { depth: 10 }), JSON.stringify(err), ...events]) {
        expect(text).not.toContain('SENTINEL');
      }
    }
  });

  it('sends nothing when the reservation is refused', async () => {
    const { embedder, events } = embedderWith([{ status: 200, body: okBody(2, TOKENS) }], 0);
    await expect(embedder.embed(TEXTS)).rejects.toBeInstanceOf(SpendRefusedError);
    expect(events).toEqual([]);
  });

  it('settles a malformed response at its usage and fails without retrying', async () => {
    const { embedder, memory, events } = embedderWith([{ status: 200, body: okBody(1, TOKENS) }, { status: 200, body: okBody(2, TOKENS) }]);
    await expect(embedder.embed(TEXTS)).rejects.toThrow(/invalid embedding response/);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
    expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([['settled', ceilUsd((TOKENS * PRICE) / 1e6)]]);
  });

  it('refuses batches over the request limits before reserving anything', async () => {
    const { embedder, events } = embedderWith([]);
    await expect(embedder.embed([])).rejects.toThrow(/1\.\.96 inputs/);
    await expect(embedder.embed(Array.from({ length: 97 }, () => 'x'))).rejects.toThrow(/1\.\.96 inputs/);
    await expect(embedder.embed(['word '.repeat(8200)])).rejects.toThrow(/limit is 8192/);
    expect(events).toEqual([]);
  });

  it('refuses a model without a known price', () => {
    expect(() =>
      createOpenAIEmbedder({ apiKey: API_KEY, model: 'text-embedding-9', dims: DIMS, gate: createMemorySpendGate(1), purpose: 't' }),
    ).toThrow(/text-embedding-9/);
  });
});

describe('batching', () => {
  it('groups at most 96 inputs and 250,000 tokens per request', () => {
    const many = Array.from({ length: 200 }, (_, i) => i);
    expect(batchByLimits(many, () => 10).map((b) => b.length)).toEqual([96, 96, 8]);
    const heavy = Array.from({ length: 70 }, (_, i) => i);
    const batches = batchByLimits(heavy, () => 8000);
    expect(batches.map((b) => b.length)).toEqual([31, 31, 8]);
    for (const b of batches) expect(b.length * 8000).toBeLessThanOrEqual(EMBEDDING_LIMITS.maxBatchTokens);
    expect(() => batchByLimits([1], () => 9000)).toThrow(/exceeds the limit/);
    expect(checkBatch(['a b c', 'd'])).toBe(countTokens('a b c') + countTokens('d'));
  });

  it('parses rate-limit reset durations', () => {
    expect(parseResetDuration('6m0s')).toBe(360_000);
    expect(parseResetDuration('1.5s')).toBe(1500);
    expect(parseResetDuration('120ms')).toBe(120);
    expect(parseResetDuration('soon')).toBeUndefined();
    expect(parseResetDuration(null)).toBeUndefined();
  });
});

describe('cache-only embedder', () => {
  it('keeps the model, dimensions and price and refuses every call without reaching the wrapped embedder', async () => {
    const wrapped = { ...createFakeEmbedder(DIMS, 'text-embedding-3-small'), usdPerMillionTokens: PRICE };
    const refusing = cacheOnlyEmbedder(wrapped);
    expect(refusing).toMatchObject({ model: 'text-embedding-3-small', dims: DIMS, usdPerMillionTokens: PRICE });
    await expect(refusing.embed(['a', 'b'])).rejects.toBeInstanceOf(CacheOnlyEmbeddingError);
    await expect(refusing.embed(['a'])).rejects.toThrow(/cache-only build asked to embed 1 input\(s\); nothing was sent/);
    expect(wrapped.calls).toEqual([]);
    // It holds no reference to the wrapped embedder's request function.
    expect(Object.values(refusing)).not.toContain(wrapped.embed);
  });
});

describe('fake embedder and vector bytes', () => {
  it('is deterministic, unit-length and free', async () => {
    const fake = createFakeEmbedder(32);
    const a = await fake.embed(['one', 'two']);
    const b = await fake.embed(['one']);
    expect(Array.from(a.vectors[0] as Float32Array)).toEqual(Array.from(b.vectors[0] as Float32Array));
    expect(Array.from(a.vectors[0] as Float32Array)).not.toEqual(Array.from(a.vectors[1] as Float32Array));
    const norm = Math.sqrt((a.vectors[1] as Float32Array).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(fake.usdPerMillionTokens).toBe(0);
    expect(fake.calls).toEqual([['one', 'two'], ['one']]);
  });

  it('round-trips float32 vectors through cache bytes', () => {
    const v = fakeVector('x', 1536);
    expect(Array.from(bytesToVector(vectorToBytes(v), 1536))).toEqual(Array.from(v));
    expect(() => bytesToVector(Buffer.alloc(12), 4)).toThrow();
  });
});

describe('spend gates', () => {
  it('shares one allowance and charges open and uncertain reservations in full', async () => {
    const gate = createMemorySpendGate(0.01);
    const a = await gate.reserve({ category: 'indexing', usd: 0.004, purpose: 'a' });
    const b = await gate.reserve({ category: 'evaluation', usd: 0.004, purpose: 'b' });
    await expect(gate.reserve({ category: 'indexing', usd: 0.004, purpose: 'c' })).rejects.toBeInstanceOf(SpendRefusedError);
    await gate.settle(a, { usd: 0.001 });
    await gate.settle(b, 'uncertain');
    expect(await gate.remainingUsd('indexing')).toBeCloseTo(0.005, 9);
    await expect(gate.settle(a, { usd: 0 })).rejects.toThrow(/already settled/);
    await expect(gate.settle({ reservationId: 'nope', fencingToken: 'x' }, { usd: 0 })).rejects.toThrow(/unknown/);
  });

  it('never lets a dry run reserve', async () => {
    const dry = createDryRunSpendGate(createMemorySpendGate(20));
    await expect(dry.reserve({ category: 'indexing', usd: 0.001, purpose: 'x' })).rejects.toBeInstanceOf(SpendRefusedError);
    expect(await dry.remainingUsd('indexing')).toBe(20);
  });
});
