import { context, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  TracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import type { AppConfig } from '../../shared/config.js';
import { genAiAttributes, safeSpanName, sanitizeAttrs, tracingStats, type AllowedAttrs } from './attributes.js';

export type { AllowedAttrs } from './attributes.js';

export interface TracingHandle {
  shutdown(): Promise<void>;
}

export interface StartTracingOptions {
  /** Replaces the OTLP exporter (tests). The config must still be complete. */
  exporter?: SpanExporter;
  scheduledDelayMillis?: number;
  exportTimeoutMillis?: number;
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  /** Upper bound on `shutdown()`. */
  shutdownTimeoutMillis?: number;
}

/** https is required except for loopback hosts and the test environment. */
function transportAllowed(cfg: AppConfig, baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  return loopback || cfg.nodeEnv === 'test';
}

/** The traces' `service.name`. */
export const SERVICE_NAME = 'aviation-casebook';

/**
 * The resource every span carries, and nothing else: without one the SDK's default names
 * the service after the Node executable (`unknown_service:<path>`), exporting a
 * filesystem path. `deployment.environment` is APP_ENV (`dev` or `live`), under both its
 * older and current semantic-convention names.
 */
export function tracingResourceAttributes(cfg: Pick<AppConfig, 'appEnv'>): Record<string, string> {
  return { 'service.name': SERVICE_NAME, 'deployment.environment': cfg.appEnv, 'deployment.environment.name': cfg.appEnv };
}

const NOOP: TracingHandle = { async shutdown() {} };
let tracer: Tracer | undefined;
let active: TracingHandle | undefined;

/** Reports every export as a success so a Langfuse outage cannot surface anywhere. */
function swallowing(inner: SpanExporter): SpanExporter {
  return {
    export(spans: ReadableSpan[], done) {
      try {
        inner.export(spans, (result) => {
          if (result.code !== 0) tracingStats.exportFailures += 1;
          done({ code: 0 });
        });
      } catch {
        tracingStats.exportFailures += 1;
        done({ code: 0 });
      }
    },
    async shutdown() {
      try {
        await inner.shutdown();
      } catch {
        tracingStats.exportFailures += 1;
      }
    },
    async forceFlush() {
      try {
        await inner.forceFlush?.();
      } catch {
        tracingStats.exportFailures += 1;
      }
    },
  };
}

function bounded(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        tracingStats.exportFailures += 1;
        resolve();
      },
    );
  });
}

/**
 * Starts OTLP export to the configured Langfuse project. A no-op unless tracing is
 * enabled and the base URL and both keys are set; there is no cloud fallback.
 */
export function startTracing(cfg: AppConfig, opts: StartTracingOptions = {}): TracingHandle {
  const { enabled, baseUrl, publicKey, secretKey } = cfg.tracing;
  if (!enabled || !baseUrl || !publicKey || !secretKey) return NOOP;
  if (!transportAllowed(cfg, baseUrl)) return NOOP;

  // Needed so nested spans find their parent; a no-op if a manager is already set.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  void active?.shutdown();
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const timeout = opts.exportTimeoutMillis ?? 3000;
  const inner =
    opts.exporter ??
    new OTLPTraceExporter({
      url: `${baseUrl.replace(/\/+$/, '')}/api/public/otel/v1/traces`,
      headers: { Authorization: `Basic ${auth}`, 'x-langfuse-ingestion-version': '4' },
      timeoutMillis: timeout,
    });
  const provider = new TracerProvider({
    resource: resourceFromAttributes(tracingResourceAttributes(cfg)),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: swallowing(inner),
        maxQueueSize: opts.maxQueueSize ?? 256,
        maxExportBatchSize: opts.maxExportBatchSize ?? 64,
        scheduledDelayMillis: opts.scheduledDelayMillis ?? 5000,
        exportTimeoutMillis: timeout,
      }),
    ],
  });
  const myTracer = provider.getTracer('aviation-casebook');
  tracer = myTracer;
  const shutdownMs = opts.shutdownTimeoutMillis ?? 5000;
  const handle: TracingHandle = {
    async shutdown() {
      if (tracer === myTracer) tracer = undefined;
      if (active === handle) active = undefined;
      await bounded(provider.shutdown(), shutdownMs);
    },
  };
  active = handle;
  return handle;
}

export interface StageSpanHandle {
  /** Adds allowlisted attributes (e.g. usage known only after the call). */
  setAttrs(attrs: AllowedAttrs): void;
}

const NOOP_HANDLE: StageSpanHandle = { setAttrs() {} };

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    tracingStats.exportFailures += 1;
  }
}

/**
 * Runs `fn` inside a span carrying only allowlisted, content-free attributes, plus the
 * GenAI attributes derived from them on a span with a `model` (Langfuse's token and cost
 * views). Tracing problems never change `fn`'s result or error; error messages are not
 * recorded.
 */
async function runInSpan<T>(
  name: string,
  attrs: AllowedAttrs,
  fn: (span: StageSpanHandle) => Promise<T> | T,
  root = false,
): Promise<T> {
  const t = tracer;
  if (!t) return fn(NOOP_HANDLE);
  // The span's sanitized attributes so far: a model call's GenAI attributes derive from them.
  const kept: Record<string, string | number> = {};
  const apply = (sp: Span, more: AllowedAttrs) => {
    const clean = sanitizeAttrs(more);
    Object.assign(kept, clean);
    sp.setAttributes({ ...clean, ...genAiAttributes(kept) });
  };
  let span: Span | undefined;
  try {
    span = t.startSpan(safeSpanName(name), {}, root ? trace.deleteSpan(context.active()) : undefined);
    apply(span, attrs);
  } catch {
    tracingStats.exportFailures += 1;
  }
  const s = span;
  const started = performance.now();
  const handle: StageSpanHandle = {
    setAttrs(more) {
      if (s) safely(() => apply(s, more));
    },
  };
  const active = s ? trace.setSpan(context.active(), s) : context.active();
  const finish = (ok: boolean) =>
    safely(() => {
      if (!s) return;
      if (!ok) s.setStatus({ code: SpanStatusCode.ERROR });
      s.setAttributes(sanitizeAttrs({ durationMs: Math.round(performance.now() - started) }));
      s.end();
    });
  try {
    const result = await context.with(active, () => fn(handle));
    finish(true);
    return result;
  } catch (err) {
    finish(false);
    throw err;
  }
}


/**
 * Runs `fn` inside a span carrying only allowlisted, content-free attributes. Tracing
 * problems never change `fn`'s result or error; error messages are not recorded.
 * Spans started inside `fn` become its children.
 */
export function stageSpan<T>(
  name: string,
  attrs: AllowedAttrs,
  fn: (span: StageSpanHandle) => Promise<T> | T,
): Promise<T> {
  return runInSpan(name, attrs, fn);
}

/** The root span of one logical request; stage spans run inside it share its trace. */
export function startRequestSpan<T>(
  name: string,
  attrs: AllowedAttrs,
  fn: (span: StageSpanHandle) => Promise<T> | T,
): Promise<T> {
  return runInSpan(name, attrs, fn, true);
}
