import { createHmac } from 'node:crypto';
import { CRITERIA, WITHHELD_REASONS, type WithheldReason } from '../../shared/contracts/briefs.js';
import { RETRIEVAL_VERSIONS, type RetrievalVersion } from '../../shared/contracts/retrieval.js';
import { STAGE_WARNINGS } from '../ai/provider.js';
import { VALIDATION_CODES } from '../briefs/validate.js';
import { DISPLAY_WITHHELD_CODES } from '../briefs/display.js';
import { CHECK_CODES } from '../briefs/verdicts.js';

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

/** A provider call's stop reason (Anthropic's values; `other` for anything else). */
export const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded', 'other'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export function stopReasonOf(raw: string | null | undefined): StopReason | undefined {
  if (raw === null || raw === undefined) return undefined;
  return (STOP_REASONS as readonly string[]).includes(raw) ? (raw as StopReason) : 'other';
}

/**
 * The codes a withheld summary records with its reason (`withheldCodes`): the validation
 * codes of a `citation_check`, the criteria a case failed in a `criteria_check`, and in an
 * `evidence_check` the judged check's codes (server/briefs/verdicts.ts: verdicts other than
 * `supported`, `chronology_missed`, and incomplete or invalid check output) with the
 * display projection's (server/briefs/display.ts: a failed or structurally unusable check,
 * more than a third of the summary removed, two contradictions, no minimum content, or
 * anything removed in `whole` mode).
 */
export const WITHHELD_CODES = [...new Set<string>([...VALIDATION_CODES, ...CRITERIA, ...CHECK_CODES, ...DISPLAY_WITHHELD_CODES])];

/**
 * Values of a closed set joined with `+` (a span attribute holds one string), in order,
 * without repeats, as many as fit `MAX_ATTR_STRING`; undefined when there are none.
 */
export function enumList(values: readonly string[]): string | undefined {
  let out = '';
  for (const v of new Set(values)) {
    const next = out ? `${out}+${v}` : v;
    if (next.length > MAX_ATTR_STRING) break;
    out = next;
  }
  return out || undefined;
}

/**
 * The closed set of span attributes. Question, answer and passage text, emails, IPs,
 * cookies, keys and filesystem paths have no place here. `briefHash` is a salted hash
 * (see `hashBrief`); `failure`, `failureStage`, `stopReason` and `withheld` take only
 * their enum values, `warnings` and `withheldCodes` only `+`-joined enum values. A span
 * with a `model` also carries the GenAI keys derived from these (`genAiAttributes`).
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
  depth?: number;
  passageCount?: number;
  caseCount?: number;
  /** A failed stage's category (on its stage span, and on the request span with `failureStage`). */
  failure?: FailureCategory;
  failureStage?: FailureStage;
  /** Of `outputTokens`, the reasoning the provider reports (`output_tokens_details.thinking_tokens`). */
  thinkingTokens?: number;
  /** A provider call's stop reason (`STOP_REASONS`). */
  stopReason?: StopReason;
  /** A provider call's warnings, `+`-joined (`STAGE_WARNINGS`). */
  warnings?: string;
  /** Why a summary was withheld (`WITHHELD_REASONS`), on the request span. */
  withheld?: WithheldReason;
  /** Its codes, `+`-joined (`WITHHELD_CODES`). */
  withheldCodes?: string;
  /** The frozen retrieval configuration a `brief.retrieve` span ran (`RETRIEVAL_VERSIONS`). */
  retrievalVersion?: RetrievalVersion;
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
  depth: 'number',
  passageCount: 'number',
  caseCount: 'number',
  failure: 'string',
  failureStage: 'string',
  thinkingTokens: 'number',
  stopReason: 'string',
  warnings: 'string',
  withheld: 'string',
  withheldCodes: 'string',
  retrievalVersion: 'string',
};

/** Attributes that take only the values of a closed set. */
const ENUMS: Readonly<Partial<Record<keyof AllowedAttrs, ReadonlySet<string>>>> = {
  failure: new Set(FAILURE_CATEGORIES),
  failureStage: new Set(FAILURE_STAGES),
  stopReason: new Set(STOP_REASONS),
  withheld: new Set(WITHHELD_REASONS),
  retrievalVersion: new Set(RETRIEVAL_VERSIONS),
};

/** Attributes that take `+`-joined values of a closed set (`enumList`). */
const ENUM_LISTS: Readonly<Partial<Record<keyof AllowedAttrs, ReadonlySet<string>>>> = {
  warnings: new Set(STAGE_WARNINGS),
  withheldCodes: new Set(WITHHELD_CODES),
};

export const ALLOWED_ATTR_KEYS: readonly string[] = Object.keys(KINDS);

/**
 * OpenTelemetry GenAI semantic attributes, which Langfuse maps to a generation's model,
 * usage and cost (`gen_ai.usage.cost` is Langfuse's key, stored as the `total` cost).
 * Never set directly: a span with a `model` derives them from its own sanitized
 * attributes (`genAiAttributes`). Metadata only: no prompt or completion key.
 */
export const GEN_AI_ATTR_KEYS = ['gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.cost'] as const;

/** Every key an exported span can carry: the allowlist and the derived GenAI keys. */
export const SPAN_ATTR_KEYS: readonly string[] = [...ALLOWED_ATTR_KEYS, ...GEN_AI_ATTR_KEYS];

/**
 * The GenAI attributes of a model call's span, from its sanitized attributes so far:
 * `gen_ai.request.model` from `model`; `gen_ai.usage.input_tokens`, the whole prompt
 * (uncached input plus cache writes and reads, as the semantic conventions count it);
 * `gen_ai.usage.output_tokens`, the billed output (thinking included); and
 * `gen_ai.usage.cost`, the stage's USD cost (`usd`). Nothing for a span without a model.
 */
export function genAiAttributes(a: Readonly<Record<string, string | number>>): Record<string, string | number> {
  if (typeof a.model !== 'string') return {};
  const n = (v: string | number | undefined) => (typeof v === 'number' ? v : 0);
  return {
    'gen_ai.request.model': a.model,
    ...(typeof a.inputTokens === 'number' ? { 'gen_ai.usage.input_tokens': a.inputTokens + n(a.cacheWriteTokens) + n(a.cacheReadTokens) } : {}),
    ...(typeof a.outputTokens === 'number' ? { 'gen_ai.usage.output_tokens': a.outputTokens } : {}),
    ...(typeof a.usd === 'number' ? { 'gen_ai.usage.cost': a.usd } : {}),
  };
}

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
      const listed = ENUM_LISTS[key as keyof AllowedAttrs];
      if (ok && listed) ok = (value as string).split('+').every((v) => listed.has(v));
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
