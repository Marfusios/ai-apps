import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { homedir } from 'node:os';
import { FAILURE_CATEGORIES, hashBrief, resetTracingStats, sanitizeAttrs, tracingStats } from '../../server/observability/attributes.js';
import { SERVICE_NAME, stageSpan, startRequestSpan, startTracing } from '../../server/observability/tracing.js';

const QUESTION = 'Why did the pilot lose control after the flaps were retracted near Denver?';
const ENV = {
  AVIATION_TRACING_ENABLED: 'true',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:1',
  LANGFUSE_PUBLIC_KEY: 'pk-test',
  LANGFUSE_SECRET_KEY: 'sk-test',
};
const cfg = (env: Record<string, string> = ENV): AppConfig => loadConfig({ env: { NODE_ENV: 'test', ...env }, files: [] });

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  resetTracingStats();
});

describe('tracing attributes', () => {
  it('no question or answer text in span attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const h = startTracing(cfg(), { exporter, scheduledDelayMillis: 10 });
    stop = () => h.shutdown();
    const attrs: Record<string, unknown> = {};
    for (const k of [
      'stage', 'provider', 'model', 'promptVersion', 'outcome', 'briefHash', 'datasetGeneration', 'indexVersion',
      'inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'usd', 'durationMs', 'passageCount', 'caseCount',
      'question', 'answer', 'passage', 'email', 'ip', 'cookie', 'apiKey',
    ]) attrs[k] = QUESTION;
    await stageSpan('compose', attrs, (s) => {
      s.setAttrs({ outcome: QUESTION, model: `${QUESTION}${QUESTION}` });
    });
    await stageSpan(QUESTION, {}, () => 1);
    await new Promise((r) => setTimeout(r, 100));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes })))).not.toMatch(/pilot|Denver|flaps/);
    expect(spans[0]!.attributes).toEqual({ durationMs: expect.any(Number) });
    expect(tracingStats.droppedAttrs).toBeGreaterThan(20);
    expect(tracingStats.droppedNames).toBe(1);
  });

  it('keeps allowlisted values and drops unknown keys, long strings, free text, paths and values outside an enum', () => {
    const out = sanitizeAttrs({
      stage: 'compose', model: 'claude-opus-5-5', inputTokens: 12, usd: 0.09, extra: 'x',
      outcome: 'two words', datasetGeneration: 'a<b>', indexVersion: 'ok-1.2+x@y:z', promptVersion: 'v'.repeat(65), caseCount: Number.NaN, briefHash: hashBrief('brief-1', 'salt'),
      failure: 'cap_exceeded', failureStage: 'scope',
    });
    expect(Object.keys(out).sort()).toEqual(['briefHash', 'failure', 'failureStage', 'indexVersion', 'inputTokens', 'model', 'stage', 'usd']);
    expect(tracingStats.droppedAttrs).toBe(5);
    resetTracingStats();
    // No path separators, so no filesystem path; enum attributes take their values only.
    expect(sanitizeAttrs({ model: '/usr/local/bin/node', indexVersion: 'C:\\node', failure: 'disk_full', failureStage: 'ingest' })).toEqual({});
    expect(tracingStats.droppedAttrs).toBe(4);
    expect(FAILURE_CATEGORIES).toContain('cap_exceeded');
    expect(out.briefHash).not.toContain('brief-1');
    expect(hashBrief('brief-1', 'salt')).not.toBe(hashBrief('brief-1', 'other'));
  });

  it('the resource is the service and environment only, and no resource or span attribute holds a filesystem path', async () => {
    const exporter = new InMemorySpanExporter();
    const h = startTracing(cfg({ ...ENV, APP_ENV: 'live' }), { exporter, scheduledDelayMillis: 10 });
    stop = () => h.shutdown();
    // The Node executable (the SDK's default `service.name` suffix), the home directory, and other paths.
    const paths = [process.execPath, homedir(), '/opt/node/bin/node', 'D:\\node\\node.exe'];
    await startRequestSpan('brief.step', { outcome: 'failed', failure: 'cap_exceeded', failureStage: 'scope' }, () =>
      stageSpan('brief.scope', { stage: 'scope', model: paths[0]!, promptVersion: paths[2]!, indexVersion: paths[3]! }, (s) => {
        s.setAttrs({ outcome: paths[1]!, failure: 'cap_exceeded' });
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    // Without an explicit resource the SDK would name the service after the Node executable's path.
    for (const span of spans) {
      expect(span.resource.attributes).toEqual({ 'service.name': SERVICE_NAME, 'deployment.environment': 'live', 'deployment.environment.name': 'live' });
    }
    const values = spans.flatMap((sp) => [...Object.values(sp.resource.attributes), ...Object.values(sp.attributes)].map(String));
    for (const v of values) {
      expect(v).not.toMatch(/[\\/]/);
      for (const p of paths) expect(v).not.toContain(p);
    }
    expect(spans.find((sp) => sp.name === 'brief.step')!.attributes).toMatchObject({ failure: 'cap_exceeded', failureStage: 'scope' });
  });

  it('tracing outage does not fail request', async () => {
    const h = startTracing(cfg(), { scheduledDelayMillis: 10, exportTimeoutMillis: 500, shutdownTimeoutMillis: 2000 });
    stop = () => h.shutdown();
    const t0 = performance.now();
    const results: number[] = [];
    for (let i = 0; i < 50; i++) results.push(await stageSpan('retrieve', { stage: 'retrieve' }, () => i));
    expect(results).toHaveLength(50);
    expect(performance.now() - t0).toBeLessThan(500);
    await expect(stageSpan('check', {}, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 300));
    await h.shutdown();
    expect(tracingStats.exportFailures).toBeGreaterThan(0);
  });

  it('stage spans inside a request span share its trace and parent', async () => {
    const exporter = new InMemorySpanExporter();
    const h = startTracing(cfg(), { exporter, scheduledDelayMillis: 10 });
    stop = () => h.shutdown();
    await startRequestSpan('request', { outcome: 'ok' }, async () => {
      await stageSpan('scope', { stage: 'scope' }, () => stageSpan('inner', {}, () => 1));
      await stageSpan('compose', { stage: 'compose' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    });
    await startRequestSpan('other', {}, () => 1);
    await new Promise((r) => setTimeout(r, 100));
    const by = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s]));
    const id = (s: { parentSpanContext?: { spanId: string } }) => s.parentSpanContext?.spanId;
    const root = by.request!;
    expect(id(root)).toBeUndefined();
    expect(by.scope!.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(by.compose!.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(id(by.scope!)).toBe(root.spanContext().spanId);
    expect(id(by.compose!)).toBe(root.spanContext().spanId);
    expect(id(by.inner!)).toBe(by.scope!.spanContext().spanId);
    expect(by.other!.spanContext().traceId).not.toBe(root.spanContext().traceId);
  });

  it('requires https unless loopback or test', async () => {
    const prod = { NODE_ENV: 'production' };
    const run = async (url: string, nodeEnv: string) => {
      const exporter = new InMemorySpanExporter();
      const h = startTracing(loadConfig({ env: { ...ENV, LANGFUSE_BASE_URL: url, NODE_ENV: nodeEnv }, files: [] }), {
        exporter,
        scheduledDelayMillis: 10,
      });
      await stageSpan('x', {}, () => 1);
      await new Promise((r) => setTimeout(r, 50));
      const n = exporter.getFinishedSpans().length;
      await h.shutdown();
      return n;
    };
    expect(await run('http://langfuse.example.com', prod.NODE_ENV)).toBe(0);
    expect(await run('https://langfuse.example.com', prod.NODE_ENV)).toBe(1);
    expect(await run('http://localhost:3000', prod.NODE_ENV)).toBe(1);
    expect(await run('http://langfuse.example.com', 'test')).toBe(1);
  });

  it('is disabled when the config is incomplete', async () => {
    for (const missing of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'AVIATION_TRACING_ENABLED']) {
      const env: Record<string, string> = { ...ENV };
      delete env[missing];
      const exporter = new InMemorySpanExporter();
      const h = startTracing(cfg(env), { exporter, scheduledDelayMillis: 10 });
      expect(await stageSpan('x', { stage: 's' }, () => 'ok')).toBe('ok');
      await h.shutdown();
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    }
  });
});
