/**
 * Task 30's pure parts: the parts and their sizing, the provider stop, the retrieval rows' requests,
 * per-field scoring, exact binomial bounds and the pre-registered per-field decision (spec.md
 * "Evaluation"). Nothing here dispatches, reads files or knows a question's words.
 */
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import type { EvidenceScopeOutput } from '../../server/ai/prompts/scope.e1.js';
import type { EvidenceAutoFilterPolicy } from '../../server/evidence/auto-filters.js';
import type { EvidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import type { LexicalSource } from '../../server/evidence/pipeline.js';
import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import { wilson } from '../search-quality/field-score.js';
import { scoreC2, type C2Dataset } from '../search-quality/part5/field-score.js';
import type { FieldObservation } from '../search-quality/types.js';
import type { SearchObservation, SearchRequest } from '../search-quality/ab-types.js';
import { INFRASTRUCTURE, applyFiltersRequest, stageMicros } from '../applied-filters/plan.js';

export const AUTO_FIELDS = ['state', 'years', 'category'] as const;
export type AutoField = typeof AUTO_FIELDS[number];

export const PARTS = ['dev-forced', 'dev-e2e', 'state-replay', 'c2', 'confirm-forced', 'confirm-e2e', 'retrieval'] as const;
export type PartName = typeof PARTS[number];
export type AttributionPart = Exclude<PartName, 'retrieval'>;
export interface PartSpec {
  family: 'dev' | 'confirm' | 'retrieval';
  data: 'probes-dev' | 'probes-confirm' | 'replay' | 'c2' | 'retrieval';
  /** Samples per item; the retrieval part takes Task 29's per-set samples. */
  samples: number;
  /** `forced`/`replay`: a scripted scope at $0; `real`: scope.e3; `retrieval`: the production search on dev. */
  scope: 'forced' | 'replay' | 'real' | 'retrieval';
  phase: 'selection' | 'confirmation';
}
export const PART_SPECS: Readonly<Record<PartName, PartSpec>> = Object.freeze({
  'dev-forced': { family: 'dev', data: 'probes-dev', samples: 3, scope: 'forced', phase: 'selection' },
  'dev-e2e': { family: 'dev', data: 'probes-dev', samples: 3, scope: 'real', phase: 'selection' },
  'state-replay': { family: 'dev', data: 'replay', samples: 1, scope: 'replay', phase: 'selection' },
  c2: { family: 'dev', data: 'c2', samples: 1, scope: 'real', phase: 'selection' },
  'confirm-forced': { family: 'confirm', data: 'probes-confirm', samples: 3, scope: 'forced', phase: 'confirmation' },
  'confirm-e2e': { family: 'confirm', data: 'probes-confirm', samples: 1, scope: 'real', phase: 'confirmation' },
  retrieval: { family: 'retrieval', data: 'retrieval', samples: 0, scope: 'retrieval', phase: 'selection' },
} satisfies Record<PartName, PartSpec>);
export const isPart = (v: unknown): v is PartName => typeof v === 'string' && (PARTS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Money: worst cases as `rankEvidence` reserves them, and estimates of what is charged.

/** Worst-case microdollars of each stage, as `rankEvidence` reserves them (the check's figure is the pipeline's own `attributionWorstCaseUsd`). */
export interface StageMicros30 { scope: number; attribution: number; embed: number; rerank: number }
export function stageMicros30(q0: EvidenceRankingConfig, qh50: EvidenceRankingConfig, attributionWorstUsd: number): StageMicros30 {
  if (!(attributionWorstUsd > 0)) throw new Error('The policy has no attribution check to size');
  return { ...stageMicros(q0, qh50), attribution: Math.ceil(attributionWorstUsd * 1e6 - 1e-6) };
}
/** Reservations of one attribution-part sample: the (scripted or real) scope, the check, and the embedding the pipeline reserves before the offline retriever. */
export const attributionSampleMicros = (s: StageMicros30): number => s.scope + s.attribution + s.embed;
/** What such a sample can be charged at most: the scripted scope and the offline retriever settle at zero. */
export const chargeableSampleMicros = (s: StageMicros30, scripted: boolean): number => (scripted ? 0 : s.scope) + s.attribution;
/** One retrieval question at worst: `Q0` once, then per sample `QH50`, its edit, `QH50+A` and its edit. */
export const retrievalQuestionMicros = (s: StageMicros30, samples: number): number =>
  s.embed + samples * ((s.scope + s.embed + s.rerank) + (s.embed + s.rerank) + (s.scope + s.attribution + s.embed + s.rerank) + (s.embed + s.rerank));
/**
 * Expected charge per call in microdollars: estimates for the size of the report, never gates. Scope
 * (scope.e3, about 5,700 input tokens, mostly cache reads) and the check (about 2,000 input tokens,
 * uncached, and about 120 output tokens) are sized from their prompts; the rerank from Task 29's
 * measured $0.006 per sample (a scope and two reranks).
 */
export const EXPECTED_MICROS = Object.freeze({ scope: 300, attribution: 300, rerank: 2_900, embed: 1 });
export function expectedSampleMicros(scripted: boolean): number { return (scripted ? 0 : EXPECTED_MICROS.scope) + EXPECTED_MICROS.attribution; }
export function expectedRetrievalQuestionMicros(samples: number): number {
  const e = EXPECTED_MICROS;
  return e.embed + samples * ((e.scope + e.embed + e.rerank) + (e.embed + e.rerank) + (e.scope + e.attribution + e.embed + e.rerank) + (e.embed + e.rerank));
}

// ---------------------------------------------------------------------------
// The provider stop (Task 24): three consecutive infrastructure outcomes among the AI calls.

/** The outcomes of the AI calls one search made; a call it did not make is absent. */
export interface AiCalls { scope?: string; attribution?: string; rerank?: string }
/** Searches without an AI call (a scripted scope with no candidate, Elasticsearch alone) neither count nor reset the streak. */
export function nextStreak30(streak: number, calls: AiCalls): number {
  const outcomes = [calls.scope, calls.attribution, calls.rerank].filter((o): o is string => o !== undefined);
  if (!outcomes.length) return streak;
  return outcomes.some(o => INFRASTRUCTURE.has(o)) ? streak + 1 : 0;
}
export const STOP_STREAK = 3;

// ---------------------------------------------------------------------------
// Scripted scope outputs: exactly what the brief prescribes, valid for `validateEvidenceScope`.

/** The question as editable terms: whitespace-normalised and cut at a word boundary to at most 300 characters. */
export function fittedTerms(question: string, max = 300): string {
  const normal = question.replace(/\s+/gu, ' ').trim();
  if (normal.length <= max) return normal;
  const cut = normal.slice(0, max + 1), space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : normal.slice(0, max)).trim();
}
/** What a scripted scope answers: a search with these filters, a non-search intent, or the recorded failure (unbilled). */
export type ScriptedScope = { kind: 'search'; filters: BriefFilters } | { kind: 'intent'; intent: Exclude<EvidenceScopeOutput['intent'], 'case_search'> } | { kind: 'failure' };
export function scriptedScopeOutput(question: string, s: Exclude<ScriptedScope, { kind: 'failure' }>): EvidenceScopeOutput {
  return s.kind === 'search' ? { intent: 'case_search', filters: s.filters, terms: fittedTerms(question) } : { intent: s.intent, filters: {} };
}
/** A recorded scope.e3 answer of the state replay: its intent and emitted states. A null intent was a scope failure. */
export function replayScope(intent: string | null, emitted: readonly string[]): ScriptedScope {
  if (intent === null) return { kind: 'failure' };
  if (intent === 'case_search') return { kind: 'search', filters: emitted.length ? { state: [...emitted] } as BriefFilters : {} };
  if (!['out_of_scope', 'operational_advice', 'corpus_statistics', 'case_comparison'].includes(intent)) throw new Error(`unknown recorded intent ${intent}`);
  return { kind: 'intent', intent: intent as Exclude<EvidenceScopeOutput['intent'], 'case_search'> };
}

// ---------------------------------------------------------------------------
// Retrieval rows (Task 29's sets on dev) and the requests each sends.

export const ROWS30 = ['Q0', 'QH50', 'QH50+F', 'QH50+A', 'QH50+A+F'] as const;
export type Row30 = typeof ROWS30[number];
/** `Q0` and `QH50` are Task 29's rows; `QH50+A` is the live ranking with the automatic policy, what a visitor gets on the first search. */
export const liveRequest = (): SearchRequest => ({ filters: {} });
export const q0Request = (): SearchRequest => ({ filters: {}, skipScope: true });
export const attributedRequest = (policy: EvidenceAutoFilterPolicy): SearchRequest => ({ filters: {}, autoFilters: policy });
/**
 * "Apply these filters" on a search's page, or null when the page shows no such button: the remaining
 * suggestion's filters added to what the search applied (its automatic filters stay applied), exactly as
 * SearchPanel sends it. For a search without automatic filters this is Task 29's request.
 */
export function buttonFilters(parent: Pick<SearchObservation, 'lexicalSource' | 'addedTerms' | 'suggestion' | 'appliedFilters'>): BriefFilters | null {
  return applyFiltersRequest(parent.lexicalSource as LexicalSource, parent.addedTerms ?? null, parent.suggestion ?? null, parent.appliedFilters ?? {});
}
/** The edit that button runs: the parent's executed texts, no scope stage; the policy goes along as the site's would (edits never add automatic filters). */
export function editRequest(filters: BriefFilters, parent: SearchObservation, policy?: EvidenceAutoFilterPolicy): SearchRequest {
  if (!parent.executed) throw new Error('an edit needs its parent search');
  return { filters, edited: { executed: parent.executed, lexicalSource: parent.lexicalSource as LexicalSource, addedTerms: parent.addedTerms ?? null },
    ...(policy ? { autoFilters: policy } : {}) };
}

// ---------------------------------------------------------------------------
// Scoring: one sample's automatic filters against gold, per field and as a whole object.

export interface AutoFilters { state?: string[]; yearFrom?: number; yearTo?: number; category?: string[] }
type FilterLike = { readonly state?: readonly string[]; readonly yearFrom?: number; readonly yearTo?: number; readonly category?: readonly string[] } | null | undefined;
/** Only the automatic fields, sets sorted and de-duplicated, empty sets dropped. */
export function autoFilters(f: FilterLike): AutoFilters {
  const out: AutoFilters = {};
  if (!f) return out;
  const set = (v?: readonly string[]) => (v && v.length ? [...new Set(v)].sort() : undefined);
  const state = set(f.state), category = set(f.category);
  if (state) out.state = state;
  if (f.yearFrom !== undefined) out.yearFrom = f.yearFrom;
  if (f.yearTo !== undefined) out.yearTo = f.yearTo;
  if (category) out.category = category;
  return out;
}
/** A field's value as one comparable key, or null when absent. Years are one field: both bounds together. */
export function fieldKey(f: AutoFilters, field: AutoField): string | null {
  if (field === 'years') return f.yearFrom === undefined && f.yearTo === undefined ? null : `${f.yearFrom ?? ''}..${f.yearTo ?? ''}`;
  const v = f[field];
  return v && v.length ? [...new Set(v)].sort().join(',') : null;
}
export function restrictFields(f: AutoFilters, fields: readonly AutoField[]): AutoFilters {
  const out: AutoFilters = {};
  if (fields.includes('state') && f.state) out.state = f.state;
  if (fields.includes('years')) { if (f.yearFrom !== undefined) out.yearFrom = f.yearFrom; if (f.yearTo !== undefined) out.yearTo = f.yearTo; }
  if (fields.includes('category') && f.category) out.category = f.category;
  return out;
}

export type FieldOutcome = 'tp' | 'wrong_value' | 'applied_on_trap' | 'fn' | 'tn';
/** TP: applied exactly gold. FP: applied anything else, `applied_on_trap` when gold lacks the field. FN: gold has it and it was not applied exactly. */
export function fieldOutcome(applied: AutoFilters, gold: AutoFilters, field: AutoField): FieldOutcome {
  const a = fieldKey(applied, field), g = fieldKey(gold, field);
  if (a !== null) return g === null ? 'applied_on_trap' : a === g ? 'tp' : 'wrong_value';
  return g === null ? 'tn' : 'fn';
}
export const falseApplication = (s: Pick<ScoredSample, 'applied' | 'gold'>, field: AutoField): boolean => {
  const a = fieldKey(s.applied, field);
  return a !== null && a !== fieldKey(s.gold, field);
};

/** One scored sample: what was applied, gold, what the scope proposed for the item (probes: `forced`), the field reasons and stage outcomes. */
export interface ScoredSample {
  itemId: string; sample: number;
  applied: AutoFilters; gold: AutoFilters;
  /** The item's proposed values (a probe's `forced`, a replay's case_search emission); null when the item has none (C2). */
  forced: AutoFilters | null;
  reasons: Partial<Record<AutoField, string>>;
  scopeOutcome: string; attributionOutcome: string;
  tags: Readonly<Record<string, string>>;
}

export interface Confusion { samples: number; tp: number; fp: number; wrongValue: number; appliedOnTrap: number; fn: number; tn: number }
export function confusion(rows: readonly Pick<ScoredSample, 'applied' | 'gold'>[], field: AutoField): Confusion {
  const c: Confusion = { samples: rows.length, tp: 0, fp: 0, wrongValue: 0, appliedOnTrap: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    switch (fieldOutcome(r.applied, r.gold, field)) {
      case 'tp': c.tp += 1; break;
      case 'wrong_value': c.fp += 1; c.wrongValue += 1; c.fn += 1; break;
      case 'applied_on_trap': c.fp += 1; c.appliedOnTrap += 1; break;
      case 'fn': c.fn += 1; break;
      case 'tn': c.tn += 1; break;
    }
  }
  return c;
}

/** One-sided 95% normal quantile, and the two-sided one C2 registered for its simultaneous bound. */
export const Z_ONE_SIDED_95 = 1.6448536269514722;
export const Z_SIMULTANEOUS = 1.959963984540054;
export const EXACT_ALPHA = 0.05;
/** Sample-level precision: Wilson one-sided 95% and simultaneous lower bounds, and the exact lower bound. */
export function precisionOf(c: Confusion) {
  const n = c.tp + c.fp;
  return { applied: n, correct: c.tp, rate: n ? c.tp / n : null, lower95: wilson(c.tp, n, Z_ONE_SIDED_95).lower,
    simultaneousLower: wilson(c.tp, n, Z_SIMULTANEOUS).lower, exactLower95: n ? exactLower(c.tp, n) : null };
}
export function recallOf(c: Confusion) {
  const n = c.tp + c.fn;
  return { gold: n, found: c.tp, rate: n ? c.tp / n : null, lower95: wilson(c.tp, n, Z_ONE_SIDED_95).lower };
}

/** P(X ≤ x) for X ~ Binomial(n, p), summed in log space. */
export function binomialCdf(x: number, n: number, p: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(n) || n < 0 || !(p >= 0 && p <= 1)) throw new Error('invalid binomial arguments');
  if (x < 0) return 0;
  if (x >= n || p === 0) return 1;
  if (p === 1) return 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let lt = n * lq, sum = Math.exp(lt);
  for (let k = 0; k < x; k += 1) { lt += Math.log(n - k) - Math.log(k + 1) + lp - lq; sum += Math.exp(lt); }
  return Math.min(1, sum);
}
/** One-sided exact (Clopper–Pearson) upper bound on a rate of `x` events in `n`: the p at which P(X ≤ x) = alpha. */
export function exactUpper(x: number, n: number, alpha = EXACT_ALPHA): number {
  if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n < 0 || x > n || !(alpha > 0 && alpha < 1)) throw new Error('invalid exact bound arguments');
  if (n === 0 || x === n) return 1;
  if (x === 0) return 1 - Math.pow(alpha, 1 / n);
  let lo = 0, hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(x, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
/** One-sided exact lower bound on a rate of `x` successes in `n` (the upper bound of the failures, mirrored). */
export function exactLower(x: number, n: number, alpha = EXACT_ALPHA): number {
  if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n < 0 || x > n) throw new Error('invalid exact bound arguments');
  if (n === 0 || x === 0) return 0;
  return 1 - exactUpper(n - x, n, alpha);
}

/** A probe's role for a field: a trap when it proposes a value gold does not hold, a positive when it proposes exactly gold. */
export type ItemRole = 'trap' | 'positive' | 'gold_not_forced';
export function itemRole(forced: AutoFilters | null, gold: AutoFilters, field: AutoField): ItemRole | null {
  if (!forced) return null;
  const f = fieldKey(forced, field), g = fieldKey(gold, field);
  if (f === null) return g === null ? null : 'gold_not_forced';
  return f === g ? 'positive' : 'trap';
}
/** The check answered for this field: its call returned a usable answer (applied, another `about`, or a quote the validator refused). */
export const judged = (reason: string | undefined): boolean => reason === 'applied' || reason === 'bad_quote' || (reason?.startsWith('attribution:') ?? false);
/** Why a sample's field ended as it did: the pipeline's field reason, else the scope's outcome. */
export function stopReason(s: Pick<ScoredSample, 'reasons' | 'scopeOutcome'>, field: AutoField): string {
  return s.reasons[field] ?? (s.scopeOutcome === 'used' ? 'none' : `scope:${s.scopeOutcome}`);
}
export const stopCategory = (reason: string): string => {
  for (const prefix of ['not_candidate', 'attribution', 'scope']) if (reason.startsWith(`${prefix}:`)) return prefix;
  return reason;
};
const tally = (xs: readonly string[]): Record<string, number> => Object.fromEntries([...new Set(xs)].sort().map(k => [k, xs.filter(x => x === k).length]));
function byItem<T extends { itemId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.itemId, [...(out.get(r.itemId) ?? []), r]);
  return out;
}

export interface TrapResult {
  /** Question level: an item fails when any of its samples applied a value gold does not hold. */
  items: number; failures: number; rate: number | null; upper95: number | null; failedItems: string[];
  /** Samples pooled (a stability diagnostic: repeats of one question are not independent). */
  samples: number; failedSamples: number; sampleRate: number | null; sampleUpper95: number | null;
}
/**
 * False applications on a field's trap items, with one-sided 95% exact upper bounds. `modelOnly` keeps
 * only the samples whose check answered for the field (the candidate rules let the field through).
 */
export function trapFailures(samples: readonly ScoredSample[], field: AutoField, modelOnly = false): TrapResult {
  let items = 0, failures = 0, n = 0, failed = 0;
  const failedItems: string[] = [];
  for (const [id, rows] of byItem(samples.filter(s => itemRole(s.forced, s.gold, field) === 'trap'))) {
    const counted = modelOnly ? rows.filter(r => judged(r.reasons[field])) : rows;
    if (!counted.length) continue;
    const bad = counted.filter(r => falseApplication(r, field)).length;
    items += 1; n += counted.length; failed += bad;
    if (bad) { failures += 1; failedItems.push(id); }
  }
  return { items, failures, rate: items ? failures / items : null, upper95: items ? exactUpper(failures, items) : null, failedItems: failedItems.sort(),
    samples: n, failedSamples: failed, sampleRate: n ? failed / n : null, sampleUpper95: n ? exactUpper(failed, n) : null };
}
/** How each trap sample ended: by category (not_candidate / attribution / bad_quote / attribution_unavailable / applied / scope) and by full reason. */
export function trapStops(samples: readonly ScoredSample[], field: AutoField) {
  const reasons = samples.filter(s => itemRole(s.forced, s.gold, field) === 'trap')
    .map(s => falseApplication(s, field) ? 'applied' : fieldKey(s.applied, field) !== null ? 'applied_gold' : stopReason(s, field));
  return { byCategory: tally(reasons.map(stopCategory)), byReason: tally(reasons) };
}
/** Question-level precision over the items that applied the field in any sample; an item is wrong if any sample applied a wrong value. */
export function questionPrecision(samples: readonly ScoredSample[], field: AutoField) {
  let applications = 0, wrong = 0;
  const wrongItems: string[] = [];
  for (const [id, rows] of byItem(samples)) {
    if (!rows.some(r => fieldKey(r.applied, field) !== null)) continue;
    applications += 1;
    if (rows.some(r => falseApplication(r, field))) { wrong += 1; wrongItems.push(id); }
  }
  const correct = applications - wrong;
  return { applications, wrong, correct, rate: applications ? correct / applications : null,
    lower95: applications ? exactLower(correct, applications) : null, wrongItems: wrongItems.sort() };
}
/** Recall on positive items (the proposed value is gold): samples, all/any samples per question, candidate coverage and the check's own share. */
export function positiveRecall(samples: readonly ScoredSample[], field: AutoField) {
  const rows = samples.filter(s => itemRole(s.forced, s.gold, field) === 'positive');
  const hit = (r: ScoredSample) => fieldKey(r.applied, field) === fieldKey(r.gold, field);
  const groups = [...byItem(rows).values()];
  const reached = rows.filter(r => r.reasons[field] !== undefined && !r.reasons[field]!.startsWith('not_candidate:'));
  const answered = rows.filter(r => judged(r.reasons[field]));
  const found = rows.filter(hit).length;
  return { items: groups.length, samples: rows.length, found, rate: rows.length ? found / rows.length : null,
    allSamples: groups.filter(g => g.every(hit)).length, anySample: groups.filter(g => g.some(hit)).length,
    candidateSamples: reached.length, candidateRate: rows.length ? reached.length / rows.length : null,
    modelOnly: { samples: answered.length, found: answered.filter(hit).length, rate: answered.length ? answered.filter(hit).length / answered.length : null } };
}

export type WholeOutcome = 'exact' | 'unsafe' | 'partial' | 'missed' | 'abstained';
/** The whole automatic filter object against gold (restricted to the policy's fields): all fields at once. */
export function wholeOutcome(s: Pick<ScoredSample, 'applied' | 'gold'>, fields: readonly AutoField[]): WholeOutcome {
  const gold = restrictFields(s.gold, fields);
  if (AUTO_FIELDS.some(f => falseApplication({ applied: s.applied, gold }, f))) return 'unsafe';
  if (fields.every(f => fieldKey(s.applied, f) === fieldKey(gold, f))) return fields.some(f => fieldKey(gold, f) !== null) ? 'exact' : 'abstained';
  return fields.some(f => fieldKey(s.applied, f) !== null) ? 'partial' : 'missed';
}
export function wholeObject(samples: readonly ScoredSample[], fields: readonly AutoField[]) {
  const outcomes = samples.map(s => ({ itemId: s.itemId, o: wholeOutcome(s, fields) }));
  const questions = [...byItem(outcomes).values()].map(rows => rows.some(r => r.o === 'unsafe') ? 'unsafe'
    : rows.every(r => r.o === 'exact') ? 'exact' : rows.every(r => r.o === 'abstained') ? 'abstained' : 'incomplete');
  return { samples: tally(outcomes.map(o => o.o)), questions: tally(questions) };
}

/** The attribution parts' stage fallbacks: failed real scopes among scope attempts, failed checks among check calls. */
export function attributionRates(rows: readonly { scopeOutcome: string; attributionOutcome: string; attributionCalled: boolean; scopeReal: boolean }[]) {
  const scope = rows.filter(r => r.scopeReal && r.scopeOutcome !== 'skipped'), checks = rows.filter(r => r.attributionCalled);
  const scopeFailures = scope.filter(r => !['used', 'non_search'].includes(r.scopeOutcome)).length;
  const checkFailures = checks.filter(r => !['applied', 'not_run'].includes(r.attributionOutcome)).length;
  return { scope: { attempts: scope.length, failures: scopeFailures, rate: scope.length ? scopeFailures / scope.length : 0, outcomes: tally(scope.map(r => r.scopeOutcome)) },
    attribution: { attempts: checks.length, failures: checkFailures, rate: checks.length ? checkFailures / checks.length : 0, outcomes: tally(checks.map(r => r.attributionOutcome)) } };
}

/** Everything one field of one part reports. The probe-only figures need `forced`. */
export function fieldSummary(samples: readonly ScoredSample[], field: AutoField, enabled: boolean) {
  const c = confusion(samples, field);
  const probes = samples.some(s => s.forced !== null);
  return { field, enabled, confusion: c, precision: precisionOf(c), recall: recallOf(c),
    reasons: tally(samples.map(s => stopReason(s, field))),
    questionPrecision: questionPrecision(samples, field),
    ...(probes ? {
      traps: { policy: trapFailures(samples, field), modelOnly: trapFailures(samples, field, true), stops: trapStops(samples, field) },
      positives: positiveRecall(samples, field),
      goldNotForced: new Set(samples.filter(s => itemRole(s.forced, s.gold, field) === 'gold_not_forced').map(s => s.itemId)).size,
    } : {}) };
}
export type FieldSummary = ReturnType<typeof fieldSummary>;

/**
 * Counts per value of a tag (pattern, source, kind, field, stratum): sample-level TP/FP/FN, and at question
 * level traps and their failures, applications and wrong ones, positives found (the last need `forced`).
 */
export function groupSummary(samples: readonly ScoredSample[], tag: string) {
  const values = [...new Set(samples.map(s => s.tags[tag] ?? '(none)'))].sort();
  return Object.fromEntries(values.map(v => {
    const rows = samples.filter(s => (s.tags[tag] ?? '(none)') === v);
    return [v, { items: new Set(rows.map(r => r.itemId)).size, samples: rows.length,
      fields: Object.fromEntries(AUTO_FIELDS.map(f => {
        const c = confusion(rows, f), t = trapFailures(rows, f), p = questionPrecision(rows, f), r = positiveRecall(rows, f);
        return [f, { tp: c.tp, fp: c.fp, fn: c.fn, traps: t.items, trapFailures: t.failures, applications: p.applications, wrong: p.wrong,
          positives: r.items, positiveSamples: r.samples, found: r.found }];
      })) }];
  }));
}

/** Unsafe applications on the review-24 regression probes (a veto in any development run). */
export function review24Unsafe(samples: readonly ScoredSample[], field: AutoField) {
  const rows = samples.filter(s => s.tags.source === 'review-24' && falseApplication(s, field));
  return { samples: rows.length, items: [...new Set(rows.map(r => r.itemId))].sort() };
}

// ---------------------------------------------------------------------------
// The pre-registered per-field decision (spec.md, 2026-11-03 22:15 CET), on the confirmation forced run.

export const DECISION_RULE = Object.freeze({ trapUpper: 0.01, precisionLower: 0.98, minTrapItems: 299, minApplications: 149, usefulRecall: 0.5, alpha: EXACT_ALPHA,
  text: '(a) question-level trap failure, one-sided 95% exact upper bound <= 1% (>= 299 trap items with zero failures); (b) question-level precision over applications, one-sided 95% exact lower bound >= 98% (>= 149 applications with zero wrong); (c) veto: any unsafe application on a review-24 probe in any development run; (d) recall on confirmation positives, below 50% end to end the field is not useful. Insufficient denominators, a missing or incomplete run, or a bound straddling the target keep the field off.' });
export type Verdict = 'pass' | 'fail' | 'straddles' | 'insufficient' | 'missing';
export interface DecisionInputs {
  enabled: boolean;
  confirmForced: Pick<FieldSummary, 'traps' | 'questionPrecision' | 'positives'> | null;
  confirmE2e: Pick<FieldSummary, 'positives'> | null;
  /** Every development run's review-24 result for the field; null when that run has no complete summary. */
  development: { part: 'dev-forced' | 'dev-e2e'; unsafe: { samples: number; items: string[] } | null }[];
}
export function decideField(field: AutoField, d: DecisionInputs) {
  const t = d.confirmForced?.traps?.policy, p = d.confirmForced?.questionPrecision;
  const trap: Verdict = !t ? 'missing' : t.items < DECISION_RULE.minTrapItems ? 'insufficient'
    : t.upper95 !== null && t.upper95 <= DECISION_RULE.trapUpper ? 'pass' : (t.rate ?? 1) <= DECISION_RULE.trapUpper ? 'straddles' : 'fail';
  const precision: Verdict = !p ? 'missing' : p.applications < DECISION_RULE.minApplications ? 'insufficient'
    : p.lower95 !== null && p.lower95 >= DECISION_RULE.precisionLower ? 'pass' : (p.rate ?? 0) >= DECISION_RULE.precisionLower ? 'straddles' : 'fail';
  const runs = d.development.filter(r => r.unsafe !== null);
  const unsafeItems = [...new Set(runs.flatMap(r => r.unsafe!.items))].sort();
  const review24: 'pass' | 'veto' | 'missing' = unsafeItems.length ? 'veto' : runs.length < 2 ? 'missing' : 'pass';
  const e2eRecall = d.confirmE2e?.positives?.rate ?? null;
  const useful = e2eRecall === null ? null : e2eRecall >= DECISION_RULE.usefulRecall;
  const on = d.enabled && trap === 'pass' && precision === 'pass' && review24 === 'pass';
  const why = !d.enabled ? 'not in the evaluated policy' : on ? 'all safety rules pass'
    : [trap !== 'pass' ? `trap ${trap}` : '', precision !== 'pass' ? `precision ${precision}` : '', review24 !== 'pass' ? `review-24 ${review24}` : ''].filter(Boolean).join(', ');
  return { field, enabled: d.enabled, on, why,
    trap: { verdict: trap, items: t?.items ?? null, failures: t?.failures ?? null, rate: t?.rate ?? null, upper95: t?.upper95 ?? null },
    precision: { verdict: precision, applications: p?.applications ?? null, wrong: p?.wrong ?? null, rate: p?.rate ?? null, lower95: p?.lower95 ?? null },
    review24: { verdict: review24, runs: runs.map(r => r.part), unsafeItems },
    recall: { forced: d.confirmForced?.positives?.rate ?? null, e2e: e2eRecall, useful } };
}

// ---------------------------------------------------------------------------
// State replay (v1.3 comparison) and C2's registered rule on the attributed fields.

export interface ReplayCase { id: string; question: string; emitted: string[]; gold: string[]; intent: string | null }
/** v1.3's recorded replay of the same 1,040 answers (tests/unit/state-attribution.test.ts): the guard alone, and behind the case_search gate. */
export const V13_RECORDED = Object.freeze({ guard: { tp: 365, fp: 0, fn: 35 }, pipeline: { tp: 363, fp: 0, fn: 37 } });
export function v13Replay(cases: readonly ReplayCase[]) {
  const guard = { tp: 0, fp: 0, fn: 0 }, pipeline = { tp: 0, fp: 0, fn: 0 };
  for (const item of cases) {
    const states = eligibleEmittedStates(item.question, item.emitted).states;
    for (const [counts, applied] of [[guard, states], [pipeline, item.intent === 'case_search' ? states : []]] as const) {
      const same = JSON.stringify(applied) === JSON.stringify([...item.gold].sort());
      if (applied.length && same) counts.tp += 1;
      if (applied.length && !same) counts.fp += 1;
      if (item.gold.length && (!applied.length || !same)) counts.fn += 1;
    }
  }
  return { guard, pipeline };
}
export const C2_RULE = 'C2 registered rule (part5/field-score.ts), on the applied automatic fields: 1,600 processed, own field 800, TP >= 295, FP 0, critical FP 0, simultaneous lower bound >= 0.98, failures <= 5%.';
/** C2's own clearing rule computed on what the policy applied (`scoreC2`'s unguarded metrics over the applied filters). */
export function c2Verdict(dataset: C2Dataset, samples: readonly { id: string; applied: AutoFilters; failed: boolean }[]) {
  const observations: FieldObservation[] = samples.map(s => ({ id: s.id, error: s.failed ? 'failed' : null, usage: null, elapsedMs: 0, reservationId: '', chargedUsd: 0,
    output: s.failed ? null : { intent: 'case_search', filters: s.applied as BriefFilters, terms: 'applied automatic filters' } }));
  const metrics = scoreC2(dataset, observations).raw;
  const complete = dataset.questions.length === 1600 && samples.length === 1600;
  const failures = samples.filter(s => s.failed).length;
  const clears = Object.fromEntries((['yearRange', 'category'] as const).map(f => {
    const m = metrics[f];
    return [f, complete && m.processed === 800 && m.tp >= 295 && m.fp === 0 && m.criticalFp === 0 && (m.simultaneousPrecision.lower ?? 0) >= 0.98
      && m.failures / 800 <= 0.05 && failures / 1600 <= 0.05 && Object.values(m.strata).every(s => s.processed === s.planned)];
  })) as Record<'yearRange' | 'category', boolean>;
  const brief = (f: 'yearRange' | 'category') => {
    const { errors, ...m } = metrics[f];
    return { ...m, errorIds: errors.map(e => e.id) };
  };
  return { rule: C2_RULE, complete, failures, clears, yearRange: brief('yearRange'), category: brief('category') };
}
