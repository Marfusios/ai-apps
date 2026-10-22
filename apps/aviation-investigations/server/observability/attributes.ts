import { createHmac } from 'node:crypto';

/**
 * Why a brief step's stage failed: the closed set recorded in the step's `meta.failure`,
 * its `brief step finished` log line and the `failure` span attribute. Provider stages
 * (`StageError`): `timeout` … `provider_error`; retrieval: `unavailable`, `timeout`,
 * `failed`, and `integrity` for a bundle that broke the provenance or completeness
 * checks; the step: `claims_overflow`, `result_contract`, `shutdown`, `orphaned`,
 * `unexpected`.
 */
export const FAILURE_CATEGORIES = [
  'timeout',
  'refusal',
  'truncated',
  'invalid_output',
  'cap_exceeded',
  'count_failed',
  'invalid_input',
  'rate_limited',
  'overloaded',
  'auth',
  'bad_request',
  'network',
  'provider_error',
  'unavailable',
  'failed',
  'integrity',
  'claims_overflow',
  'result_contract',
  'shutdown',
  'orphaned',
  'unexpected',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** The stage a failure belongs to (`pipeline`: the step as a whole). */
export const FAILURE_STAGES = ['scope', 'retrieve', 'compose', 'validate', 'check', 'pipeline'] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

/**
 * The closed set of span attributes. Question, answer and passage text, emails, IPs,
 * cookies, keys and filesystem paths have no place here. `briefHash` is a salted hash
 * (see `hashBrief`); `failure` and `failureStage` take only their enum values.
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
  /** A failed stage's category (on its stage span, and on the request span with `failureStage`). */
  failure?: FailureCategory;
  failureStage?: FailureStage;
  /** Of `outputTokens`, the reasoning the provider reports (`output_tokens_details.thinking_tokens`). */
  thinkingTokens?: number;
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
  failure: 'string',
  failureStage: 'string',
  thinkingTokens: 'number',
};

/** Attributes that take only the values of a closed set. */
const ENUMS: Readonly<Partial<Record<keyof AllowedAttrs, ReadonlySet<string>>>> = {
  failure: new Set(FAILURE_CATEGORIES),
  failureStage: new Set(FAILURE_STAGES),
};

export const ALLOWED_ATTR_KEYS: readonly string[] = Object.keys(KINDS);

export const MAX_ATTR_STRING = 64;
const MAX_SPAN_NAME = 64;
/** No whitespace (free text) and no path separators (`/`, `\`), so no value can carry a filesystem path. */
const VALUE_RE = /^[A-Za-z0-9._:@+-]+$/;
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
 * over 64 characters, anything with whitespace (free text) or a path separator, and
 * enum attributes outside their set, counting each drop.
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
      const allowed = ENUMS[key as keyof AllowedAttrs];
      if (ok && allowed) ok = allowed.has(value as string);
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
