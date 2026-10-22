/**
 * Retrieval experiment knobs (task 10d, phase A). Every knob is a parameter whose
 * default is today's production behaviour (`BASELINE_CONFIG`, derived from
 * `RETRIEVAL_DEFAULTS`): passage BM25 and passage kNN, 50 passages each, kNN
 * `num_candidates` 4 × 50, reciprocal rank fusion with k = 60 and equal weights over
 * the passage lists, cases at their best passage, the question as BM25 text, no
 * case-level channel. Production retrieval is never changed: an experiment runs the
 * production stages (`retrieveCandidates`, `fetchAndPack`) with parameters and fuses
 * their channel lists here (`variant.ts`).
 *
 * - `perChannel`, `numCandidatesFactor`, `rrfK`: as in `RetrievalParams`.
 * - `weights`: each channel's RRF weight, `w / (k + rank)` (keyword: passage BM25,
 *   vector: passage kNN, cases: the case-level channel).
 * - `fusion`: `passage` (production: RRF over the passage lists, then each case at
 *   its best passage) or `case` (each channel first collapsed to its unique cases at
 *   their best passage, then RRF over the case lists, so two channels agreeing on a
 *   case through different passages both count).
 * - `caseChannel`: BM25 over the cases index (`narratives`: probable cause, analysis
 *   and factual; `narratives+findings`: also `findings_text`), `depth` cases, as a
 *   `third` channel or replacing passage BM25 (`replace-keyword`); case-level fusion
 *   only.
 * - `keywordText`: `question`, or `scope`: the scope stage's keyword text (E3) for
 *   every BM25 channel; the vector channel always embeds the question.
 */
import { z } from 'zod';
import { RETRIEVAL_DEFAULTS, retrievalParams, type RetrievalParams } from '../../../server/search/hybrid.js';

/** Cases-index text fields a case-level channel searches. */
export const CASE_FIELD_SETS = {
  narratives: ['probable_cause', 'analysis', 'factual'],
  'narratives+findings': ['probable_cause', 'analysis', 'factual', 'findings_text'],
} as const;
export type CaseFieldSet = keyof typeof CASE_FIELD_SETS;
const FIELD_SETS = Object.keys(CASE_FIELD_SETS) as [CaseFieldSet, ...CaseFieldSet[]];

const Weight = z.number().min(0).max(10);

export const CaseChannelSchema = z.strictObject({
  fields: z.enum(FIELD_SETS),
  /** Cases the channel returns. */
  depth: z.number().int().min(1).max(200),
  role: z.enum(['third', 'replace-keyword']),
});
export type CaseChannel = z.infer<typeof CaseChannelSchema>;

export const ExperimentConfigSchema = z
  .strictObject({
    perChannel: z.number().int().min(1).max(200),
    numCandidatesFactor: z.number().int().min(1).max(50),
    rrfK: z.number().min(0).max(1000),
    weights: z.strictObject({ keyword: Weight, vector: Weight, cases: Weight }),
    fusion: z.enum(['passage', 'case']),
    caseChannel: CaseChannelSchema.nullable(),
    keywordText: z.enum(['question', 'scope']),
  })
  .refine((c) => c.caseChannel === null || c.fusion === 'case', { message: 'a case-level channel needs case-level fusion' });
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

/** Overrides of the baseline, as the grid writes them. */
export const ExperimentOverridesSchema = z.strictObject({
  perChannel: z.number().optional(),
  numCandidatesFactor: z.number().optional(),
  rrfK: z.number().optional(),
  weights: z.strictObject({ keyword: Weight.optional(), vector: Weight.optional(), cases: Weight.optional() }).optional(),
  fusion: z.enum(['passage', 'case']).optional(),
  caseChannel: CaseChannelSchema.nullable().optional(),
  keywordText: z.enum(['question', 'scope']).optional(),
});
export type ExperimentOverrides = z.infer<typeof ExperimentOverridesSchema>;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Today's production behaviour (`RETRIEVAL_DEFAULTS`, the question as BM25 text, no case channel). */
export const BASELINE_CONFIG: Readonly<ExperimentConfig> = deepFreeze({
  perChannel: RETRIEVAL_DEFAULTS.perChannel,
  numCandidatesFactor: RETRIEVAL_DEFAULTS.numCandidatesFactor,
  rrfK: RETRIEVAL_DEFAULTS.rrfK,
  weights: { keyword: 1, vector: 1, cases: 1 },
  fusion: 'passage',
  caseChannel: null,
  keywordText: 'question',
});

/** The production retrieval parameters a config runs the passage channels and packing with. */
export function paramsOf(c: Pick<ExperimentConfig, 'perChannel' | 'numCandidatesFactor' | 'rrfK'>): RetrievalParams {
  return retrievalParams({ perChannel: c.perChannel, numCandidatesFactor: c.numCandidatesFactor, rrfK: c.rrfK });
}

/** The baseline with `over` applied, validated (including the production parameter limits). */
export function experimentConfig(over: ExperimentOverrides = {}): ExperimentConfig {
  const merged = {
    ...BASELINE_CONFIG,
    ...over,
    weights: { ...BASELINE_CONFIG.weights, ...over.weights },
  };
  const parsed = ExperimentConfigSchema.parse(merged);
  paramsOf(parsed);
  return parsed;
}

/** Canonical JSON (sorted keys): two configs are the same experiment exactly when this is equal. */
export function canonicalConfig(c: ExperimentConfig): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
      : v;
  return JSON.stringify(sort(c));
}

export const isBaseline = (c: ExperimentConfig): boolean => canonicalConfig(c) === canonicalConfig(BASELINE_CONFIG);

/** The knobs a config changes from the baseline (tie-breaks prefer fewer). */
export function changedKnobs(c: ExperimentConfig): string[] {
  const out: string[] = [];
  for (const k of ['perChannel', 'numCandidatesFactor', 'rrfK', 'fusion', 'keywordText'] as const) if (c[k] !== BASELINE_CONFIG[k]) out.push(k);
  for (const w of ['keyword', 'vector'] as const) if (c.weights[w] !== BASELINE_CONFIG.weights[w]) out.push(`weights.${w}`);
  if (c.caseChannel !== null) {
    out.push('caseChannel');
    if (c.weights.cases !== BASELINE_CONFIG.weights.cases) out.push('weights.cases');
  }
  return out;
}
