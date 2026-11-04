/** Decorate the application's metadata-only spans with v4 experiment identity; never attach IO. */
import { context, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import type { AppConfig } from '../../shared/config.js';
import { SPAN_ATTR_KEYS } from '../../server/observability/attributes.js';
import { startTracing, startRequestSpan } from '../../server/observability/tracing.js';
import { appendDurable } from '../search-quality/money.js';
import { EVALUATOR_VERSION } from './data.js';

export interface ExperimentContext {
  experimentId: string; experimentName: string; datasetId: string; itemId: string; itemVersion?: string;
  configuration: string; configurationSha256: string; datasetSha256: string; goldSha256: string;
  codeCommit: string; corpusRevision: string; scopeVersion: string; scopeSha256: string;
  rerankVersion: string; rerankSha256: string;
}
export interface TraceIdentity { traceId: string; observationId: string }
export function experimentAttributes(c: ExperimentContext, root: string): Record<string, string> {
  const metadata = { rankingVersion: c.configuration, rankingSha256: c.configurationSha256, datasetSha256: c.datasetSha256,
    goldSha256: c.goldSha256, codeCommit: c.codeCommit, corpusRevision: c.corpusRevision, evaluatorVersion: EVALUATOR_VERSION,
    scopeVersion: c.scopeVersion, scopeSha256: c.scopeSha256, rerankVersion: c.rerankVersion, rerankSha256: c.rerankSha256 };
  const out: Record<string, string> = { 'langfuse.environment': 'dev', 'langfuse.trace.name': 'aircase.ranking-evaluation',
    'langfuse.release': c.codeCommit, 'langfuse.experiment.id': c.experimentId, 'langfuse.experiment.name': c.experimentName,
    'langfuse.experiment.dataset.id': c.datasetId, 'langfuse.experiment.item.id': c.itemId,
    'langfuse.experiment.item.root_observation_id': root };
  if (c.itemVersion) out['langfuse.experiment.item.version'] = c.itemVersion;
  for (const [k, v] of Object.entries(metadata)) out[`langfuse.experiment.metadata.${k}`] = v;
  for (const v of Object.values(out)) if (!/^[A-Za-z0-9._:@+-]{1,160}$/.test(v)) throw new Error('Invalid experiment metadata');
  return out;
}
export function decoratedSpan(span: ReadableSpan, attrs: Record<string, string>): ReadableSpan {
  if (span.events.length || span.links.length || Object.keys(span.attributes).some(k => !SPAN_ATTR_KEYS.includes(k))) throw new Error('Unexpected span content');
  const metadata = Object.fromEntries(Object.entries(span.attributes).filter(([k]) => !k.startsWith('gen_ai.'))
    .map(([k, v]) => [`langfuse.observation.metadata.${k}`, v]));
  return { ...span, spanContext: () => span.spanContext(), attributes: { ...span.attributes, ...metadata, ...attrs,
    'langfuse.observation.type': span.attributes.model ? (span.name === 'evidence.embed' ? 'embedding' : 'generation') : 'span' } };
}
const nanos = (t: readonly [number, number]) => (BigInt(t[0]) * 1_000_000_000n + BigInt(t[1])).toString();
function attributes(values: Record<string, unknown>) {
  return Object.entries(values).map(([key, v]) => ({ key, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) } }));
}
/** An exact completed-span archive permits upload repair without repeating inference. No credentials are serialized. */
export function otlpPayload(spans: ReadableSpan[]) {
  return { resourceSpans: spans.map(s => ({ resource: { attributes: attributes(s.resource.attributes) },
    scopeSpans: [{ scope: { name: 'aviation-casebook' }, spans: [{ traceId: s.spanContext().traceId, spanId: s.spanContext().spanId,
      ...(s.parentSpanContext ? { parentSpanId: s.parentSpanContext.spanId } : {}), name: s.name, kind: s.kind + 1,
      startTimeUnixNano: nanos(s.startTime), endTimeUnixNano: nanos(s.endTime), attributes: attributes(s.attributes),
      status: { code: s.status.code }, droppedAttributesCount: s.droppedAttributesCount }] }] })) };
}
export function experimentTracing(config: AppConfig, archive: string, injected?: SpanExporter) {
  const contexts = new Map<string, Record<string, string>>();
  const exported = new Set<string>();
  let failures = 0;
  const inner = injected ?? new OTLPTraceExporter({ url: `${config.tracing.baseUrl!.replace(/\/+$/, '')}/api/public/otel/v1/traces`,
    headers: { Authorization: `Basic ${Buffer.from(`${config.tracing.publicKey}:${config.tracing.secretKey}`).toString('base64')}`,
      'x-langfuse-ingestion-version': '4' }, timeoutMillis: 3000 });
  const exporter: SpanExporter = {
    export(spans, done) {
      try {
        const prepared = spans.map(s => {
          const attrs = contexts.get(s.spanContext().traceId);
          if (!attrs) throw new Error('Experiment context missing');
          const id = s.spanContext().spanId;
          if (exported.has(id)) throw new Error('Completed span exported twice');
          exported.add(id);
          return decoratedSpan(s, attrs);
        });
        appendDurable(archive, otlpPayload(prepared));
        inner.export(prepared, result => { if (result.code !== 0) failures++; done(result); });
      } catch { failures++; done({ code: 1 }); }
    },
    async shutdown() { await inner.shutdown(); },
    async forceFlush() { await inner.forceFlush?.(); },
  };
  const handle = startTracing(config, { exporter, scheduledDelayMillis: 1000 });
  if (!handle.enabled) throw new Error('Application tracing is disabled');
  return {
    handle, failures: () => failures,
    async run<T>(meta: ExperimentContext, fn: (identity: TraceIdentity) => Promise<T>): Promise<T> {
      return startRequestSpan('evidence.request', { stage: 'pipeline' }, async span => {
        const current = trace.getSpan(context.active())?.spanContext();
        if (!current) throw new Error('Application root trace was not created');
        const identity = { traceId: current.traceId, observationId: current.spanId };
        contexts.set(identity.traceId, experimentAttributes(meta, identity.observationId));
        const result = await fn(identity);
        span.setAttrs({ outcome: 'completed' });
        return result;
      });
    },
  };
}
