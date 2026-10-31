import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { loadConfig } from '../../shared/config.js';
import { stageSpan } from '../../server/observability/tracing.js';
import { loadDatasets, datasetItem, itemScores, meanScores, stable } from '../../evals/langfuse/data.js';
import { syncDataset, publishScores, scorePayload, type PublicApi } from '../../evals/langfuse/api.js';
import { projectEnvironment } from '../../evals/langfuse/bootstrap.js';
import { experimentTracing, experimentAttributes, type ExperimentContext } from '../../evals/langfuse/tracing.js';
import { checkTaskCap, decimalMicros } from '../../evals/langfuse/money.js';
import { readResults } from '../../evals/langfuse/run.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aircase-langfuse-offline-')); });
afterEach(() => rmSync(dir, { force: true, recursive: true }));
describe('Langfuse evaluation reference data and scores', () => {
  it('uses only the 21 dev questions and frozen 48, with stable item identities and independent gold hashes', () => {
    const [core, confirmation] = loadDatasets();
    expect(core!.questions).toHaveLength(21); expect(confirmation!.questions).toHaveLength(48);
    expect(core!.questions.filter(q => q.class === 'narrow')).toHaveLength(12);
    expect(new Set(core!.questions.map(q => q.group)).size).toBe(9);
    const q = core!.questions[0]!, first = datasetItem(core!, q), edited = datasetItem(core!, { ...q, question: 'Changed synthetic fixture' });
    expect(first.id).toBe(edited.id); expect(first.metadata.itemSha256).not.toBe(edited.metadata.itemSha256);
    expect(first.input).toBe(q.question); expect(first.expectedOutput.caseNumbers).toEqual(q.relevant);
    expect(first.metadata.connectedGroup).toBe(q.group);
  });
  it('uses the full recall denominator, fixed precision denominator, discounted binary gold and class-specific averages', () => {
    const narrow = { id: 'n', question: 'Synthetic', class: 'narrow' as const, group: 'g1', area: 'test', relevant: Array.from({ length: 20 }, (_, i) => String(i)) };
    const broad = { ...narrow, id: 'b', class: 'broad' as const };
    expect(itemScores(narrow, narrow.relevant.slice(0, 10))).toEqual({ narrow_R20: .5, narrow_R10: .5 });
    const b = itemScores(broad, ['0']);
    expect(b.broad_P10).toBe(.1); expect(b.broad_nDCG10).toBeCloseTo(1 / Array.from({ length: 10 }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, x) => a + x), 12);
    const means = meanScores([itemScores(narrow, []), itemScores(narrow, narrow.relevant), itemScores(broad, broad.relevant)]);
    expect(means.narrow_R20).toEqual({ value: .5, count: 2 }); expect(means.broad_P10).toEqual({ value: 1, count: 1 });
    expect(() => itemScores(narrow, ['0', '0'])).toThrow();
  });
});
describe('dataset and score upload integrity', () => {
  it('uploads once, then only reads; refuses changed, archived or extra items without overwriting', async () => {
    const d = loadDatasets()[0]!, items = new Map<string, any>(); let dataset: any = null; let writes = 0;
    const api: PublicApi = { async request(path, method = 'GET', body: any) {
      if (method === 'POST') { writes++; if (path === '/api/public/v2/datasets') return dataset = { ...body, id: 'dataset1' };
        const item = { ...body, datasetId: 'dataset1' }; items.set(item.id, item); return item; }
      if (path.startsWith('/api/public/v2/datasets/')) return dataset;
      if (path.startsWith('/api/public/dataset-items?')) return { data: [...items.values()], meta: { totalPages: 1 } };
      return items.get(path.split('/').at(-1)!) ?? null;
    } };
    expect((await syncDataset(api, d)).createdItems).toBe(21); expect(writes).toBe(22);
    expect((await syncDataset(api, d)).createdItems).toBe(0); expect(writes).toBe(22);
    const item = [...items.values()][0], saved = structuredClone(item);
    item.input = 'Modified data'; await expect(syncDataset(api, d)).rejects.toThrow('conflicts'); expect(writes).toBe(22);
    items.set(saved.id, { ...saved, status: 'ARCHIVED' }); await expect(syncDataset(api, d)).rejects.toThrow('conflicts');
    items.set(saved.id, saved); items.set('foreign', { id: 'foreign' }); await expect(syncDataset(api, d)).rejects.toThrow('unexpected items');
  });
  it('reuses numeric scores by exact ID and subject and never silently changes a value', async () => {
    const s = scorePayload('narrow_R20', .5, 'config', '2026-10-31T00:00:00.000Z', { traceId: 'trace', observationId: 'root' });
    let existing: any; let writes = 0;
    const api: PublicApi = { async request(_path, method = 'GET', body: any) {
      if (method === 'POST') { writes++; existing = { ...body[0], subject: { kind: 'observation', id: 'root', traceId: 'trace' } }; return { accepted: 1, rejected: 0, errors: [] }; }
      return { data: existing ? [existing] : [] };
    } };
    await publishScores(api, [s]); await publishScores(api, [s]); expect(writes).toBe(1);
    await expect(publishScores(api, [{ ...s, value: .6 }])).rejects.toThrow('conflicts');
    existing.subject.id = 'other'; await expect(publishScores(api, [s])).rejects.toThrow('conflicts');
    expect(() => scorePayload('narrow_R20', 1.01, 'c', s.timestamp, { datasetRunId: 'run' })).toThrow();
  });
});
describe('task-wide money and resumption', () => {
  const totals = { chargedMicros: 741_029, ledgerMicros: 741_029, openMicros: 0, open: 0, reservations: 10 };
  it('allows an exact microdollar fit, rejects one extra and never trusts unresolved or mismatched accounting', () => {
    expect(() => checkTaskCap(totals, 8971)).not.toThrow();
    expect(() => checkTaskCap(totals, 8972)).toThrow('$0.75');
    expect(() => checkTaskCap({ ...totals, open: 1, openMicros: 10 }, 1)).toThrow('unresolved');
    expect(() => checkTaskCap({ ...totals, ledgerMicros: 0 }, 1)).toThrow('disagree');
    expect(() => checkTaskCap(totals, .1)).toThrow('arithmetic');
    expect(decimalMicros('0.006538')).toBe(6538); expect(decimalMicros('10')).toBe(10_000_000);
    expect(() => decimalMicros('0.0000001')).toThrow();
  });
  it('refuses interrupted or duplicate attempt journals instead of repeating a paid search', () => {
    const path = join(dir, 'results.jsonl'); expect(readResults(path)).toEqual([]);
    const started = { event: 'started', key: 'one', traceId: 't', observationId: 's' };
    writeFileSync(path, JSON.stringify(started) + '\n'); expect(() => readResults(path)).toThrow('reconcile');
    const result = { ...started, event: 'result', observation: {} };
    writeFileSync(path, [started, result].map(v => JSON.stringify(v)).join('\n') + '\n'); expect(readResults(path)).toEqual([result]);
    writeFileSync(path, [started, result, started, result].map(v => JSON.stringify(v)).join('\n') + '\n'); expect(() => readResults(path)).toThrow('repeated');
  });
});
describe('connection isolation and metadata-only app tracing', () => {
  it('rejects partial/mixed process credentials and preserves matching settings', () => {
    const file = join(dir, 'project.env'); writeFileSync(file, 'LANGFUSE_BASE_URL=https://example.invalid\nLANGFUSE_PUBLIC_KEY=synthetic-pub\nLANGFUSE_SECRET_KEY=synthetic-secret\nNODE_EXTRA_CA_CERTS=/tmp/synthetic-ca.pem\n');
    expect(() => projectEnvironment(file, { LANGFUSE_PUBLIC_KEY: 'synthetic-pub' })).toThrow('Incomplete');
    expect(() => projectEnvironment(file, { LANGFUSE_PUBLIC_KEY: 'other', LANGFUSE_SECRET_KEY: 'other' })).toThrow('differ');
    expect(projectEnvironment(file, { APP_ENV: 'dev' }).APP_ENV).toBe('dev');
    expect(projectEnvironment(file, {}).NODE_EXTRA_CA_CERTS).toBe('/tmp/synthetic-ca.pem');
  });
  const meta: ExperimentContext = { experimentId: 'run1', experimentName: 'er-q-v1-2026-10-31-core', datasetId: 'dataset1', itemId: 'item1',
    configuration: 'er-q-v1', configurationSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), goldSha256: 'c'.repeat(64),
    codeCommit: 'd'.repeat(40), corpusRevision: 'e'.repeat(64), scopeVersion: 'scope.e3', scopeSha256: 'f'.repeat(64), rerankVersion: 'disabled', rerankSha256: 'none' };
  const config = () => loadConfig({ files: [], env: { APP_ENV: 'dev', NODE_ENV: 'test', AVIATION_TRACING_ENABLED: 'true',
    LANGFUSE_BASE_URL: 'https://example.invalid', LANGFUSE_PUBLIC_KEY: 'synthetic-pub', LANGFUSE_SECRET_KEY: 'synthetic-secret' } });
  it('links all app spans to the item and preserves nested model usage without exporting text, exceptions or credentials', async () => {
    const spans: ReadableSpan[] = [];
    const inner: SpanExporter = { export(xs, done) { spans.push(...xs); done({ code: 0 }); }, async shutdown() {} };
    const archive = join(dir, 'spans.jsonl'), tracing = experimentTracing(config(), archive, inner);
    let root = '';
    try {
      await expect(tracing.run(meta, async id => { root = id.observationId;
        return stageSpan('evidence.scope', { stage: 'scope', model: 'claude-haiku-5-5', inputTokens: 3, outputTokens: 2, usd: .001,
          question: 'Secret question text', email: 'private@example.invalid' } as never, () => { throw new Error('Secret question text private@example.invalid'); });
      })).rejects.toThrow('Secret question text');
    } finally { await tracing.handle.shutdown(); }
    expect(spans).toHaveLength(2); expect(tracing.failures()).toBe(0);
    expect(spans.every(s => s.attributes['langfuse.experiment.item.root_observation_id'] === root)).toBe(true);
    expect(spans[0]!.parentSpanContext?.spanId).toBe(root);
    expect(spans[0]!.attributes['gen_ai.usage.input_tokens']).toBe(3);
    expect(spans[0]!.attributes['langfuse.observation.type']).toBe('generation');
    const text = readFileSync(archive, 'utf8');
    expect(text).not.toMatch(/Secret question|private@|synthetic-secret|synthetic-pub|observation.input|observation.output/);
    expect(stable(spans.map(s => s.attributes))).not.toContain('Secret question');
    expect(() => experimentAttributes({ ...meta, configuration: 'question text' }, root)).toThrow();
  });
  it('an unavailable exporter cannot repeat or change the app operation', async () => {
    let calls = 0;
    const inner: SpanExporter = { export(_xs, done) { done({ code: 1 }); }, async shutdown() {} };
    const tracing = experimentTracing(config(), join(dir, 'spans.jsonl'), inner);
    try { expect(await tracing.run(meta, async () => { calls++; return 17; })).toBe(17); }
    finally { await tracing.handle.shutdown(); }
    expect(calls).toBe(1); expect(tracing.failures()).toBeGreaterThan(0);
  });
});
