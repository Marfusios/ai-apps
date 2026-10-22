import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { hashBrief, resetTracingStats, sanitizeAttrs, tracingStats } from '../../server/observability/attributes.js';
import { stageSpan, startTracing } from '../../server/observability/tracing.js';

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

  it('keeps allowlisted values and drops unknown keys, long strings, free text', () => {
    const out = sanitizeAttrs({
      stage: 'compose', model: 'claude-opus-5-5', inputTokens: 12, usd: 0.09, extra: 'x',
      outcome: 'two words', promptVersion: 'v'.repeat(65), caseCount: Number.NaN, briefHash: hashBrief('brief-1', 'salt'),
    });
    expect(Object.keys(out).sort()).toEqual(['briefHash', 'inputTokens', 'model', 'stage', 'usd']);
    expect(tracingStats.droppedAttrs).toBe(4);
    expect(out.briefHash).not.toContain('brief-1');
    expect(hashBrief('brief-1', 'salt')).not.toBe(hashBrief('brief-1', 'other'));
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
