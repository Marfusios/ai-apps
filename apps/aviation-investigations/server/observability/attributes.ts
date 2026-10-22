import { createHmac } from 'node:crypto';

/**
 * The closed set of span attributes. Question, answer and passage text, emails, IPs,
 * cookies and keys have no place here. `briefHash` is a salted hash (see `hashBrief`).
 */
export interface AllowedAttrs {
  stage?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  usd?: number;
  durationMs?: number;
  outcome?: string;
  briefHash?: string;
  datasetGeneration?: string;
  indexVersion?: string;
  passageCount?: number;
  caseCount?: number;
}

const KINDS: Readonly<Record<keyof AllowedAttrs, 'string' | 'number'>> = {
  stage: 'string',
  provider: 'string',
  model: 'string',
  promptVersion: 'string',
  inputTokens: 'number',
  outputTokens: 'number',
  cacheWriteTokens: 'number',
  cacheReadTokens: 'number',
  usd: 'number',
  durationMs: 'number',
  outcome: 'string',
  briefHash: 'string',
  datasetGeneration: 'string',
  indexVersion: 'string',
  passageCount: 'number',
  caseCount: 'number',
};

export const ALLOWED_ATTR_KEYS: readonly string[] = Object.keys(KINDS);

export const MAX_ATTR_STRING = 64;
const MAX_SPAN_NAME = 64;
const VALUE_RE = /^[A-Za-z0-9._:/@+-]+$/;
const NAME_RE = /^[A-Za-z0-9_.:-]+$/;

/** Operational counters; no content. */
export const tracingStats = { droppedAttrs: 0, droppedNames: 0, exportFailures: 0 };

export function resetTracingStats(): void {
  tracingStats.droppedAttrs = 0;
  tracingStats.droppedNames = 0;
  tracingStats.exportFailures = 0;
}

/**
 * Runtime guard for untyped callers. Drops unknown keys, wrongly typed values, strings
 * over 64 characters and anything with whitespace (free text), counting each drop.
 */
export function sanitizeAttrs(attrs: object): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const kind = Object.hasOwn(KINDS, key) ? KINDS[key as keyof AllowedAttrs] : undefined;
    let ok = false;
    if (kind === 'number') ok = typeof value === 'number' && Number.isFinite(value);
    else if (kind === 'string') {
      ok = typeof value === 'string' && value.length > 0 && value.length <= MAX_ATTR_STRING && VALUE_RE.test(value);
    }
    if (ok) out[key] = value as string | number;
    else tracingStats.droppedAttrs += 1;
  }
  return out;
}

/** Span names are fixed identifiers; anything else is replaced and counted. */
export function safeSpanName(name: string): string {
  if (name.length > 0 && name.length <= MAX_SPAN_NAME && NAME_RE.test(name)) return name;
  tracingStats.droppedNames += 1;
  return 'invalid_span_name';
}

/** Salted, truncated HMAC of a brief id; the raw id never reaches a span. */
export function hashBrief(briefId: string, salt: string): string {
  return createHmac('sha256', salt).update(briefId).digest('hex').slice(0, 16);
}
