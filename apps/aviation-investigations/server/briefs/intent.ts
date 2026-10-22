/**
 * The server-owned search intent of a brief (DESIGN §2, §6 "History"): the question,
 * the text refinement in effect, validated filters, readings of vague terms and the
 * case numbers shown before. It is the only history a refinement sees, it is treated
 * as untrusted input by every scope check, and earlier generated answers are never
 * part of it.
 *
 * A step stores two pieces:
 * - `StepRequest` (immutable, written at admission): what the reader asked for;
 * - `StepIntent` (written after the scope stage): the effective intent the step ran with.
 *
 * Filter rules (later explicit actions win):
 * - the question: the planner's filters, with the request's own filters winning per facet;
 * - a text refinement: the previous filters, with the facets the planner returns for the
 *   refined search winning (the planner sees the previous filters);
 * - a filters refinement: exactly the reader's filters (the planner's are ignored);
 * - an interpretation refinement: the previous filters unchanged.
 */
import { canonicalRequestHash } from '../quota/policy.js';
import {
  BRIEF_FILTER_FACETS,
  BriefFiltersSchema,
  type BriefFilters,
  type RefinementChange,
} from '../../shared/contracts/briefs.js';
import { FACET_VALUES } from '../../shared/contracts/search.js';
import type { Intent, PriorReading, ScopeFilters, ScopeInput, ScopeOutput } from '../ai/provider.js';
import { isPinned, timingToken, withDefaultReading, type ReadingState } from './clarify.js';

export type StepOrigin = 'question' | 'text' | 'interpretation' | 'filters';

/** The intent in effect before a refinement step. */
export interface PriorState {
  intent: Intent;
  filters: BriefFilters;
  readings: ReadingState;
  /** Event numbers of the previous step's evidence (context only). */
  caseNumbers: string[];
  /** The text refinement in effect before this step. */
  refinement?: string;
}

export interface StepRequest {
  origin: StepOrigin;
  /** The brief's question. */
  question: string;
  /** The text refinement in effect for this step: new for `text`, carried otherwise. */
  refinement?: string;
  /** Filters the request sets: the question's own filters, or a filters refinement. */
  filters?: BriefFilters;
  /** For `interpretation` and `filters` steps. */
  change?: RefinementChange;
  /** Readings in effect before the planner runs (the reader's pins included). */
  readings: ReadingState;
  prior?: PriorState;
}

export interface StepIntent {
  intent: Intent;
  mechanicalCause: boolean;
  filters: BriefFilters;
  keywordText: string;
  readings: ReadingState;
  /** Set after retrieval: event numbers of the bundle. */
  caseNumbers: string[];
}

// ---------------------------------------------------------------------------
// Filters

/** Filters in canonical form: known facets only, deduplicated in vocabulary order, empty lists dropped. */
export function canonicalFilters(f: BriefFilters): BriefFilters {
  const out: Record<string, unknown> = {};
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = f[facet];
    if (!values || values.length === 0) continue;
    const order = FACET_VALUES[facet] as readonly string[];
    out[facet] = order.filter((v) => (values as readonly string[]).includes(v));
  }
  if (f.yearFrom !== undefined) out.yearFrom = f.yearFrom;
  if (f.yearTo !== undefined) out.yearTo = f.yearTo;
  return out as BriefFilters;
}

/** Facets set in `over` replace those in `base`. */
export function mergeFilters(base: BriefFilters, over: BriefFilters): BriefFilters {
  const out: Record<string, unknown> = { ...canonicalFilters(base) };
  const o = canonicalFilters(over);
  for (const [k, v] of Object.entries(o)) out[k] = v;
  const merged = out as BriefFilters;
  if (merged.yearFrom !== undefined && merged.yearTo !== undefined && merged.yearFrom > merged.yearTo) {
    delete merged.yearFrom;
    delete merged.yearTo;
  }
  return merged;
}

/**
 * The planner's filters as brief filters: values outside Explore's vocabularies are
 * dropped (Task 14 offers codes the snapshot may not use), and a reversed year range
 * is dropped.
 */
export function scopeFiltersToBrief(f: ScopeFilters): BriefFilters {
  const keep = (facet: (typeof BRIEF_FILTER_FACETS)[number], values: readonly string[] | undefined) => {
    const allowed = FACET_VALUES[facet] as readonly string[];
    const kept = (values ?? []).filter((v) => allowed.includes(v));
    return kept.length > 0 ? kept : undefined;
  };
  const out: Record<string, unknown> = {
    phase: keep('phase', f.phase),
    injury: keep('injury', f.injury),
    conditions: keep('conditions', f.conditions),
    light: keep('light', f.light),
    category: keep('category', f.category),
    state: keep('state', f.state),
  };
  if (f.yearFrom !== undefined && (f.yearTo === undefined || f.yearFrom <= f.yearTo)) out.yearFrom = f.yearFrom;
  if (f.yearTo !== undefined && (f.yearFrom === undefined || f.yearFrom <= f.yearTo)) out.yearTo = f.yearTo;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  const parsed = BriefFiltersSchema.safeParse(out);
  return parsed.success ? canonicalFilters(parsed.data) : {};
}

const SCOPE_VOCAB = {
  injury: ['FATL', 'SERS', 'MINR', 'NONE'],
  conditions: ['VMC', 'IMC'],
  light: ['DAYL', 'DAWN', 'DUSK', 'NITE', 'NDRK', 'NBRT'],
  category: ['AIR', 'HELI', 'GLI', 'BALL', 'GYRO', 'PPAR', 'WSFT', 'PLFT', 'ULTR', 'BLIM', 'RCKT'],
} as const;

/** Brief filters in the planner's vocabulary (for `<prior>`); facets it cannot express are left out. */
export function briefFiltersToScope(f: BriefFilters): ScopeFilters {
  const pick = <T extends string>(values: readonly string[] | undefined, allowed: readonly T[]) => {
    const kept = (values ?? []).filter((v): v is T => (allowed as readonly string[]).includes(v));
    return kept.length > 0 ? kept : undefined;
  };
  const out: ScopeFilters = {};
  const phase = (f.phase ?? []).filter((p) => p !== 'blank');
  if (phase.length > 0) out.phase = phase as ScopeFilters['phase'];
  const injury = pick(f.injury, SCOPE_VOCAB.injury);
  if (injury) out.injury = injury;
  const conditions = pick(f.conditions, SCOPE_VOCAB.conditions);
  if (conditions) out.conditions = conditions;
  const light = pick(f.light, SCOPE_VOCAB.light);
  if (light) out.light = light;
  const category = pick(f.category, SCOPE_VOCAB.category);
  if (category) out.category = category;
  const state = (f.state ?? []).filter((s) => /^[A-Z]{2}$/.test(s)).slice(0, 10);
  if (state.length > 0) out.state = state;
  if (f.yearFrom !== undefined && f.yearFrom >= 2008) out.yearFrom = f.yearFrom;
  if (f.yearTo !== undefined && f.yearTo >= 2008) out.yearTo = f.yearTo;
  return out;
}

// ---------------------------------------------------------------------------
// Requests

export function questionRequest(question: string, filters: BriefFilters | undefined): StepRequest {
  return {
    origin: 'question',
    question,
    ...(filters ? { filters: canonicalFilters(filters) } : {}),
    readings: {},
  };
}

/** What a previous step leaves for the next: its effective intent, or what it asked for when it ended before scope. */
export function priorOf(previous: { request: StepRequest; intent: StepIntent | null }): PriorState {
  const { request, intent } = previous;
  return {
    intent: intent?.intent ?? request.prior?.intent ?? 'case_search',
    filters: intent?.filters ?? (request.origin === 'filters' ? (request.filters ?? {}) : (request.prior?.filters ?? request.filters ?? {})),
    readings: intent?.readings ?? request.readings,
    caseNumbers: intent?.caseNumbers ?? [],
    ...(request.refinement ? { refinement: request.refinement } : {}),
  };
}

/** The request of a refinement step, from the previous step and the change. */
export function refinementRequest(previous: { request: StepRequest; intent: StepIntent | null }, change: RefinementChange): StepRequest {
  const prior = priorOf(previous);
  const base = { question: previous.request.question, prior };
  switch (change.kind) {
    case 'text':
      return { ...base, origin: 'text', refinement: change.text, readings: prior.readings };
    case 'filters':
      return {
        ...base,
        origin: 'filters',
        ...(prior.refinement ? { refinement: prior.refinement } : {}),
        filters: canonicalFilters(change.filters),
        change: { kind: 'filters', filters: canonicalFilters(change.filters) },
        readings: prior.readings,
      };
    case 'interpretation': {
      const readings: ReadingState = { ...prior.readings };
      if (change.field === 'timing_window' && typeof change.value === 'object') readings.timingWindow = { value: change.value, pinned: true };
      if (change.field === 'first_flight_only' && typeof change.value === 'boolean') readings.firstFlightOnly = { value: change.value, pinned: true };
      if (change.field === 'failure_type' && typeof change.value === 'string') readings.failureType = { value: change.value, pinned: true };
      return { ...base, origin: 'interpretation', ...(prior.refinement ? { refinement: prior.refinement } : {}), change, readings };
    }
  }
}

/** Readings in the planner's token form. */
export function priorReadings(r: ReadingState): PriorReading[] {
  const out: PriorReading[] = [];
  if (r.timingWindow) out.push({ type: 'timing_window', value: timingToken(r.timingWindow.value), pinned: r.timingWindow.pinned });
  if (r.firstFlightOnly?.value) out.push({ type: 'timing_window', value: 'first_flight', pinned: r.firstFlightOnly.pinned });
  if (r.failureType) out.push({ type: 'failure_type', value: r.failureType.value, pinned: r.failureType.pinned });
  return out;
}

/** The scope stage's input for a step. */
export function scopeInput(req: StepRequest): ScopeInput {
  const question = req.origin === 'text' && req.refinement ? req.refinement : req.question;
  if (!req.prior) return { question };
  const p = req.prior;
  return {
    question,
    prior: {
      question: req.question,
      ...(p.refinement ? { refinement: p.refinement } : {}),
      intent: p.intent,
      filters: briefFiltersToScope(req.origin === 'filters' ? (req.filters ?? {}) : p.filters),
      readings: priorReadings(req.readings),
      caseNumbers: p.caseNumbers.slice(0, 6),
    },
  };
}

/** The keyword channel's text when the planner gives none: the question and the refinement in effect. */
export function fallbackKeywordText(req: StepRequest): string {
  return [req.question, req.refinement].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 3_000);
}

/** The text embedded for the dense channel: the question plus the text refinement in effect. */
export function retrievalText(req: StepRequest): string {
  return req.refinement ? `${req.question}\n${req.refinement}` : req.question;
}

/** The effective intent after the scope stage. */
export function resolveIntent(req: StepRequest, scope: ScopeOutput): StepIntent {
  const planned = scopeFiltersToBrief(scope.filters);
  let filters: BriefFilters;
  switch (req.origin) {
    case 'question':
      filters = mergeFilters(planned, req.filters ?? {});
      break;
    case 'text':
      filters = mergeFilters(req.prior?.filters ?? {}, planned);
      break;
    case 'filters':
      filters = canonicalFilters(req.filters ?? {});
      break;
    case 'interpretation':
      filters = canonicalFilters(req.prior?.filters ?? {});
      break;
  }
  let intent = scope.intent;
  // The reader already chose a reading of this term: never ask again.
  if (intent === 'needs_clarification' && scope.ambiguity && isPinned(req.readings, scope.ambiguity.type)) intent = 'case_search';
  const readings = intent === 'case_search' ? withDefaultReading(req.readings, scope.ambiguity) : req.readings;
  return {
    intent,
    mechanicalCause: scope.mechanicalCause,
    filters,
    keywordText: scope.keywordText.trim() === '' ? fallbackKeywordText(req) : scope.keywordText.trim(),
    readings,
    caseNumbers: [],
  };
}

// ---------------------------------------------------------------------------
// Idempotency hashes (canonical JSON, sha256)

export function createRequestHash(question: string, filters: BriefFilters | undefined): string {
  return canonicalRequestHash({ op: 'brief.create', question, filters: canonicalFilters(filters ?? {}) });
}

export function refineRequestHash(briefId: string, change: RefinementChange): string {
  const c = change.kind === 'filters' ? { ...change, filters: canonicalFilters(change.filters) } : change;
  return canonicalRequestHash({ op: 'brief.refine', briefId, change: c });
}
