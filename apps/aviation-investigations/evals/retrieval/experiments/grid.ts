/**
 * The machine-readable pre-registration of the task 10d phase A retrieval experiments
 * (`grid.json`, explained in `PREREG.md`): what is frozen before any experiment runs.
 *
 * - `frozen`: the dataset file and specs (sha256), the generation identity, the target
 *   indices, the embedding and the scope stage's model and prompt version; a run refuses
 *   a target that differs.
 * - `baseline`: today's production behaviour (`BASELINE_CONFIG`, checked equal).
 * - `variants`: every selectable configuration, as overrides of the baseline, with its
 *   family and declared target metric.
 * - `pools`: bounded candidate pools (the input a phase B reranker would see), measured
 *   by their oracle ceiling; never selectable for production in phase A.
 * - `channelsAlone`: single-channel rankings, diagnostics only.
 * - `rule`, `bootstrap`, `latency`, `cost`, `scope`, `diagnostics`, `holdout`: the
 *   registered selection rule, uncertainty method, limits and procedures.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CaseChannelSchema, ExperimentConfigSchema, ExperimentOverridesSchema, canonicalConfig, experimentConfig, type ExperimentConfig } from './config.js';
import { GATE_METRICS } from './stats.js';

export const GRID_VERSION = '10d-phase-a-v1';

const Id = z.string().regex(/^[a-z0-9][a-z0-9+./=@-]{0,47}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const VariantSchema = z.strictObject({
  id: Id,
  family: z.string().min(1),
  target: z.enum(GATE_METRICS),
  description: z.string().min(1),
  config: ExperimentOverridesSchema,
});
export type VariantSpec = z.infer<typeof VariantSchema>;

export const PoolSchema = z.strictObject({
  id: Id,
  description: z.string().min(1),
  /** The configuration whose channels and ranking the pool is drawn from. */
  config: ExperimentOverridesSchema,
  /** `ranking`: the configuration's first `size` cases; `balanced`: the channels' cases in turn. */
  method: z.enum(['ranking', 'balanced']),
  /** `balanced`: the channel order of the round robin. */
  channels: z.array(z.enum(['vector', 'keyword', 'cases'])).min(1).optional(),
  size: z.number().int().min(1).max(400),
});
export type PoolSpec = z.infer<typeof PoolSchema>;

export const ChannelAloneSchema = z.strictObject({
  id: Id,
  channel: z.enum(['keyword', 'vector', 'cases']),
  /** Passages (keyword, vector) or cases (cases) the channel returns. */
  depth: z.number().int().min(1).max(200),
  caseChannel: CaseChannelSchema.optional(),
});
export type ChannelAloneSpec = z.infer<typeof ChannelAloneSchema>;

export const GridSchema = z.strictObject({
  version: z.literal(GRID_VERSION),
  registered: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  frozen: z.strictObject({
    dataset: z.strictObject({ file: z.string(), sha256: Sha, specSha256: Sha, version: z.string() }),
    generation: z.strictObject({
      id: z.number().int().positive(),
      archiveSha256: Sha,
      mappingVersion: z.string(),
      fieldNormalizationVersion: z.string(),
      citationTextVersion: z.string(),
    }),
    passagesIndex: z.strictObject({ name: z.string(), version: z.string(), fingerprint: Sha }),
    casesIndex: z.strictObject({ name: z.string(), version: z.string(), fingerprint: Sha }),
    embedding: z.strictObject({ model: z.string(), dims: z.number().int().positive() }),
    scope: z.strictObject({ model: z.string(), promptVersion: z.string() }),
    /** The questions the experiments may tune on. */
    split: z.literal('dev'),
  }),
  baseline: ExperimentConfigSchema,
  variants: z.array(VariantSchema).min(1),
  pools: z.array(PoolSchema),
  channelsAlone: z.array(ChannelAloneSchema),
  rule: z.strictObject({
    improvementPp: z.number().positive(),
    regressionTolerancePp: z.number().nonnegative(),
    tieWindowPp: z.number().nonnegative(),
    /** Pools: the registered minimum ceiling gain over the baseline pool (pp) for a phase B recommendation. */
    poolImprovementPp: z.number().positive(),
  }),
  bootstrap: z.strictObject({ resamples: z.number().int().min(1000), seed: z.number().int().nonnegative(), lowerBound: z.literal('one-sided-95') }),
  latency: z.strictObject({ repetitions: z.number().int().min(1), p95AddedMs: z.number().positive(), p95TotalMs: z.number().positive() }),
  cost: z.strictObject({ phaseAUsd: z.number().positive(), maxAddedPaidCallsPerRequest: z.number().int().nonnegative() }),
  scope: z.strictObject({ samples: z.number().int().min(1), timeoutMs: z.number().int().positive(), retries: z.number().int().nonnegative(), maxUsd: z.number().positive() }),
  diagnostics: z.strictObject({
    perChannel: z.number().int().positive(),
    backgroundSample: z.number().int().min(50),
    percentile: z.number().gt(0).lt(1),
    sensitivity: z.array(z.number().gt(0).lt(1)),
    seed: z.number().int().nonnegative(),
  }),
  holdout: z.strictObject({ confirmations: z.literal(1) }),
});
export type Grid = z.infer<typeof GridSchema>;

export interface ResolvedVariant extends Omit<VariantSpec, 'config'> {
  config: ExperimentConfig;
}

/** Problems beyond the schema: unique ids, valid configurations, the baseline, scope samples. Empty when usable. */
export function gridProblems(g: Grid, baseline: ExperimentConfig): string[] {
  const problems: string[] = [];
  if (canonicalConfig(g.baseline) !== canonicalConfig(baseline)) problems.push('the grid baseline is not the production baseline (BASELINE_CONFIG)');
  const ids = new Set<string>();
  const configs = new Map<string, string>();
  for (const v of [...g.variants, ...g.pools, ...g.channelsAlone]) {
    if (ids.has(v.id)) problems.push(`duplicate id ${v.id}`);
    ids.add(v.id);
  }
  for (const v of g.variants) {
    try {
      const c = canonicalConfig(experimentConfig(v.config));
      if (c === canonicalConfig(baseline)) problems.push(`${v.id}: is the baseline`);
      const twin = configs.get(c);
      if (twin) problems.push(`${v.id}: the same configuration as ${twin}`);
      configs.set(c, v.id);
    } catch (err) {
      problems.push(`${v.id}: invalid configuration (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`);
    }
  }
  for (const p of g.pools) {
    try {
      const c = experimentConfig(p.config);
      if (p.method === 'balanced' && !p.channels) problems.push(`${p.id}: a balanced pool names its channel order`);
      if (p.channels?.includes('cases') && c.caseChannel === null) problems.push(`${p.id}: a cases channel needs a case-level channel configured`);
    } catch (err) {
      problems.push(`${p.id}: invalid configuration (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`);
    }
  }
  for (const a of g.channelsAlone) if ((a.channel === 'cases') !== (a.caseChannel !== undefined)) problems.push(`${a.id}: only a cases channel names its case channel`);
  return problems;
}

/** Each variant's full configuration. */
export const resolveVariants = (g: Grid): ResolvedVariant[] => g.variants.map((v) => ({ ...v, config: experimentConfig(v.config) }));

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Read and validate a grid file; throws with the problems. */
export function loadGrid(path: string, baseline: ExperimentConfig): { grid: Grid; sha256: string } {
  const raw = readFileSync(path, 'utf8');
  const parsed = GridSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`grid: ${parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const problems = gridProblems(parsed.data, baseline);
  if (problems.length > 0) throw new Error(`grid: ${problems.join('; ')}`);
  return { grid: parsed.data, sha256: sha256(raw) };
}
