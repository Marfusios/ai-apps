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
  /** Whether spans are exported. */
  readonly enabled: boolean;
  /** Why they are not: setting names only, never their values (logged at startup). */
  readonly reason?: string;
  shutdown(): Promise<void>;
}

export interface StartTracingOptions {
  /** Replaces the OTLP exporter (tests). The config must still be complete. */
  exporter?: SpanExporter;
  warn?: (metadata: { category: string; failedExports: number }, message: string) => void;
  now?: () => number;
  scheduledDelayMillis?: number;
  exportTimeoutMillis?: number;
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  /** Upper bound on `shutdown()`. */
  shutdownTimeoutMillis?: number;
}

/** Content-free operational JSON, including before the HTTP logger exists. */
export const tracingExportWarning: NonNullable<StartTracingOptions['warn']> = (metadata, message) => {
  process.stderr.write(`${JSON.stringify({ level: 40, msg: message, category: 'tracing_export_failed', failedExports: metadata.failedExports })}\n`);
};

/**
 * Why the Langfuse address is refused, or null (gate 22 finding 4). https always; plain
 * http only to a loopback host, to a host the operator listed in AVIATION_TRACING_HTTP_HOSTS
 * (a private container network such as the shared observability one, where Langfuse's web
 * service is reached by its service name: configured, never guessed from the address), or
 * under NODE_ENV=test. The reason names settings only.
 */
export function transportProblem(cfg: AppConfig, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'LANGFUSE_BASE_URL is not a valid URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'LANGFUSE_BASE_URL must be an https or http URL';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  if (loopback || cfg.nodeEnv === 'test' || cfg.tracing.httpHosts.includes(host)) return null;
  return 'LANGFUSE_BASE_URL uses plain http to a host that is not loopback: use https, or list the host in AVIATION_TRACING_HTTP_HOSTS (a private network you trust)';
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

const off = (reason: string): TracingHandle => ({ enabled: false, reason, async shutdown() {} });
let tracer: Tracer | undefined;
let active: TracingHandle | undefined;

/** Operational status only; no endpoint, project key or content. */
let lastExportOkAt: string | null = null;
export function tracingHealth() {
  return { enabled: active?.enabled ?? false, lastExportOkAt, failedExports: tracingStats.exportFailures };
}

/** Failed exports never change search results. A stuck exporter is bounded too. */
export function observableExporter(inner: SpanExporter, opts: StartTracingOptions = {}): SpanExporter {
  const now = opts.now ?? Date.now;
  let warnedAt = -Infinity;
  const failure = () => {
    tracingStats.exportFailures += 1;
    if (now() - warnedAt < 300_000) return;
    warnedAt = now();
    try { (opts.warn ?? ((meta, message) => console.warn(message, meta)))({ category: 'tracing_export_failed', failedExports: tracingStats.exportFailures }, 'tracing export failed'); } catch { /* logging is optional */ }
  };
  return {
    export(spans: ReadableSpan[], done) {
      let finished = false;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (ok) lastExportOkAt = new Date(now()).toISOString(); else failure();
        done({ code: 0 });
      };
      const timer = setTimeout(() => finish(false), opts.exportTimeoutMillis ?? 3000);
      timer.unref();
      try { inner.export(spans, result => finish(result.code === 0)); } catch { finish(false); }
    },
    async shutdown() { try { await inner.shutdown(); } catch { tracingStats.internalErrors += 1; } },
    async forceFlush() { try { await inner.forceFlush?.(); } catch { tracingStats.internalErrors += 1; } },
  };
}

function bounded(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { tracingStats.internalErrors += 1; resolve(); }, ms);
    t.unref();
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        tracingStats.internalErrors += 1;
        resolve();
      },
    );
  });
}

/**
 * Starts OTLP export to the configured Langfuse project. A no-op unless tracing is
 * enabled, the base URL and both keys are set and the address is allowed
 * (`transportProblem`); there is no cloud fallback. The handle says whether it exports and,
 * if not, why (server/main.ts logs it).
 */
export function startTracing(cfg: AppConfig, opts: StartTracingOptions = {}): TracingHandle {
  const { enabled, baseUrl, publicKey, secretKey } = cfg.tracing;
  if (!enabled) return off('AVIATION_TRACING_ENABLED is not true');
  if (!baseUrl || !publicKey || !secretKey) return off('LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must all be set');
  const problem = transportProblem(cfg, baseUrl);
  if (problem) return off(problem);

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
        exporter: observableExporter(inner, opts),
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
    enabled: true,
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
  /** Private trace identifier, never a public response field. */
  readonly traceId?: string;
  /** Adds allowlisted attributes (e.g. usage known only after the call). */
  setAttrs(attrs: AllowedAttrs): void;
  /**
   * The work was stopped (the reader's cancel or a server shutdown), not failed: the span
   * ends without an error status even though `fn` throws. Its `outcome` says why.
   */
  markStopped(): void;
}

const NOOP_HANDLE: StageSpanHandle = { setAttrs() {}, markStopped() {} };

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    tracingStats.internalErrors += 1;
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
    tracingStats.internalErrors += 1;
  }
  const s = span;
  const started = performance.now();
  let stopped = false;
  const handle: StageSpanHandle = {
    ...(s ? { traceId: s.spanContext().traceId } : {}),
    setAttrs(more) {
      if (s) safely(() => apply(s, more));
    },
    markStopped() {
      stopped = true;
    },
  };
  const active = s ? trace.setSpan(context.active(), s) : context.active();
  const finish = (ok: boolean) =>
    safely(() => {
      if (!s) return;
      // A stop is not an error: the status stays unset.
      if (!ok && !stopped) s.setStatus({ code: SpanStatusCode.ERROR });
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
