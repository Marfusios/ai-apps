/**
 * The Track N commands that read the target (cli.ts): the free dry run (`plan`), and the
 * paid commands (`pools`, `judge`, `answerability`), which print their plan and pay
 * nothing without `--confirm-cost`. Read-only against the target: Elasticsearch with the
 * read key, PostgreSQL with the app role; the only writes are the evaluation ledger's
 * reservations (`DATABASE_INGEST_URL`) and files under `--out-dir`.
 *
 * **Preflight** (every command, before anything is paid): the dataset parses, has no
 * problems and was built from the committed specs; the calibration labels are the frozen
 * ones; the active manifest names a passages index that meets the passages contract and a
 * servable cases index of the same generation; that generation's identity is the
 * dataset's; every family's cohort on the passages index equals the dataset's (bounded
 * cohorts case by case, broad questions by size); and the cases channel's filter reaches
 * the passages filter's cases for every family (the N channel of the methods). Any
 * problem stops a paid command; `plan` reports them.
 *
 * **Money.** Every paid attempt reserves its worst case on the evaluation ledger and
 * settles. Each run writes its own spend log (`<out-dir>/spend/<run>.jsonl`) and stops
 * before a reservation that would take its own spend above its limit (`RUN_LIMITS_USD`,
 * or `--max-usd`), the cap of its allocation (`--allocation <name>`, a log under
 * `<out-dir>/allocations/` shared by the runs of one phase or month, its cap fixed when it
 * is created with `--allocation-usd`), or what remains of the monthly indexing and
 * evaluation allowance on the ledger. The judgment cache (`<out-dir>/cache.jsonl`) is
 * shared by every run and allocation, so a new month resumes from it under its own cap.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { createAnthropicProvider } from '../../../server/ai/anthropic.js';
import { closeDb, createDb, type Db } from '../../../server/db/client.js';
import { getActiveManifest } from '../../../server/db/generations.js';
import { readIndexMeta } from '../../../server/search/index-meta.js';
import { createEsClient } from '../../../server/search/es.js';
import { remainingCategoryUsd } from '../../../server/quota/pacing.js';
import type { AppConfig } from '../../../shared/config.js';
import { isServableCasesIndex } from '../../../worker/index/cases-index.js';
import { createLedgerSpendGate, type SpendGate } from '../../../worker/index/spend-gate.js';
import { readGenerationSource, type GenerationSource } from '../generation.js';
import { describePlan, embedPlan, indexReport, planQueryEmbeddings, resolveRunTarget, stamp, type RunTarget } from '../harness.js';
import { BASELINE_CONFIG, experimentConfig } from '../experiments/config.js';
import { DEFAULT_GRID, filterConsistency, gitState } from '../experiments/cli.js';
import { loadGrid } from '../experiments/grid.js';
import { providerScopeCaller, runScopeSamples, scopeInventory, type ScopeRun } from '../experiments/scope.js';
import { DEFAULT_CALIBRATION, DEFAULT_NARRATIVE_DATASET, HOLDOUT_LOCK_FILE } from './build.js';
import { CalibrationDatasetSchema, calibrationProblems, controlEvidence, itemKey, itemPassages, resolveRecord, type CalibrationDataset, type ControlBundle } from './calibration.js';
import { CALIBRATION_CRITERIA, CRITERIA_SHA256 } from './criteria.js';
import { experimentIdentity, joinJudgments, type ExperimentData, type JudgmentFile, type JudgmentSet } from './identity.js';
import { attemptReserveUsd, createAnthropicJudge, createOpenAIJudge, type JudgeCaller } from './clients.js';
import { ADJUDICATOR, DEFAULT_CONCURRENCY, JUDGE_A, JUDGE_B, JUDGE_TIMEOUT_MS, RUN_LIMITS_USD } from './config.js';
import { NarrativeDatasetSchema, families, narrativeDatasetProblems, type NarrativeDataset, type NarrativeItem } from './dataset.js';
import { CASE_TOKEN_BUDGET, bundleFingerprint, fingerprint, loadCaseEvidence, planChunks, type CaseEvidence, type DeliveredPassage } from './evidence.js';
import {
  AttemptSender,
  JudgmentCache,
  answerabilitySubject,
  bundleKeyOf,
  byPriority,
  judgePairs,
  lockAllocation,
  loggedSpendUsd,
  openAllocation,
  recoverAllocation,
  relevanceSubject,
  type Allocation,
  type FamilyRef,
  type PairPlanItem,
  type PairRecord,
  type RecoveryLedger,
  type RunReservation,
} from './judging.js';
import {
  ASSUMPTIONS,
  addRuns,
  adjudicationBlockTokens,
  caseCost,
  expectedOutputs,
  likelyPool,
  measureAnswerability,
  measureBundle,
  measureCase,
  poolEstimates,
  prefixTokens,
  sampleEvidence,
  scaleRun,
  statsOf,
  type CaseSample,
  type Measured,
  type RunCost,
  type Samples,
  canaryOf,
  fullEscalationUsd,
  measuredUsage,
  outputsFor,
  planInputs,
  protocolArithmetic,
  type MeasuredUsage,
} from './plan.js';
import { POOL_RULE, SCHEDULE, buildPools, bundlePairs, casePriority, indexCohort, poolFileVersion, tierOf, verifyPoolFile, withFingerprints, type FamilyPool, type PoolFile, type Stage } from './pool.js';
import { NARRATIVE_PARAPHRASES, NARRATIVE_QUESTIONS } from './questions.js';
import {
  agreementReport,
  auditSamples,
  answerabilityLabels,
  calibrationReport,
  compareMethods,
  methodDifferences,
  type CompareMetric,
  type DifferenceBounds,
  discoveryByDepth,
  discrepancies,
  familyReference,
  judgedCoverage,
  methodExclusive,
  questionGroups,
  questionValues,
  relevanceLabels,
  scoreRuns,
  tailEstimate,
  type QuestionValue,
} from './score.js';
import { canonicalJson, specSha256, sha256 } from './spec.js';

export interface CommandOptions {
  config: AppConfig;
  outDir: string;
  confirm: boolean;
  log: (m: string) => void;
}

// ---------------------------------------------------------------------------
// Context and preflight

export interface NarrativeContext {
  config: AppConfig;
  dataset: NarrativeDataset;
  calibration: CalibrationDataset;
  es: Client;
  app: Db;
  run: RunTarget;
  casesIndex: string;
  source: GenerationSource;
  problems: string[];
  preflight: Record<string, unknown>;
}

export function readDataset(file = DEFAULT_NARRATIVE_DATASET): NarrativeDataset {
  return NarrativeDatasetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function readCalibration(file = DEFAULT_CALIBRATION): CalibrationDataset {
  return CalibrationDatasetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Load, connect and check (module comment). Never throws for a check that fails: it lists it in `problems`. */
export async function openContext(config: AppConfig, log: (m: string) => void): Promise<NarrativeContext> {
  const dataset = readDataset();
  const calibration = readCalibration();
  const problems: string[] = [...narrativeDatasetProblems(dataset), ...calibrationProblems(calibration)];
  if (dataset.source.specSha256 !== specSha256(NARRATIVE_QUESTIONS, NARRATIVE_PARAPHRASES)) problems.push('dataset: built from other question specs than the committed ones (rebuild it)');
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-narrative' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 60_000 });
  try {
    const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
    const run = await resolveRunTarget(es, app, undefined, { model, dims });
    if ('refused' in run) throw new Error(`${run.refused}; nothing paid`);
    const manifest = await getActiveManifest(app);
    const casesIndex = manifest?.casesIndex ?? '';
    const casesMeta = await readIndexMeta(es, casesIndex);
    if (!isServableCasesIndex(casesMeta.indexVersion, casesMeta.fingerprint)) problems.push('target: the cases index is not a servable version and fingerprint');
    if (casesMeta.generationId !== run.target.generationId) problems.push(`target: the cases index records generation ${casesMeta.generationId}, the passages index ${run.target.generationId}`);
    const client = new pg.Client({ connectionString: config.databaseUrl, application_name: 'aviation-eval-narrative-preflight' });
    await client.connect();
    let source: GenerationSource;
    try {
      source = await readGenerationSource(client, run.target.generationId);
    } finally {
      await client.end();
    }
    for (const k of ['generationId', 'archiveSha256', 'mappingVersion', 'fieldNormalizationVersion', 'citationTextVersion'] as const) {
      if (dataset.source[k] !== source[k]) problems.push(`generation: the dataset has ${k} ${dataset.source[k]}, the target ${source[k]}`);
      if (k !== 'generationId' && calibration.source[k] !== source[k]) problems.push(`generation: the calibration has ${k} ${calibration.source[k]}, the target ${source[k]}`);
    }
    const qualification = run.contract.eventAircraftQualification;
    const cohorts: Record<string, { dataset: number; index: number }> = {};
    for (const f of families(dataset)) {
      const index = await indexCohort(es, run.index, f, qualification);
      cohorts[f.id] = { dataset: f.cohort.size, index: index.length };
      if (index.length !== f.cohort.size) problems.push(`cohort ${f.id}: the passages index reaches ${index.length} cases, the dataset ${f.cohort.size}`);
      else if (f.cohort.cases && JSON.stringify(index) !== JSON.stringify(f.cohort.cases)) problems.push(`cohort ${f.id}: the passages index reaches other cases than the dataset`);
    }
    const consistency = await filterConsistency(
      es,
      { passagesIndex: run.index, casesIndex, qualification },
      families(dataset).map((f) => ({ id: f.id, split: 'dev', group: f.id, class: 'broad', area: 'narrative', paraphraseOf: null, question: f.question, filters: f.filters, relevant: [] })),
    );
    for (const c of consistency) {
      if (c.onlyPassages.length > 0 || c.onlyCasesIndex.length > 0) problems.push(`filters ${JSON.stringify(c.filters)}: the cases channel reaches ${c.casesIndexCases} cases, the passages filter ${c.passagesCases}`);
    }
    log(`preflight: generation ${source.generationId}, ${run.index}, ${casesIndex}; ${families(dataset).length} family cohorts checked on the passages index; ${problems.length} problem(s)`);
    return {
      config,
      dataset,
      calibration,
      es,
      app,
      run,
      casesIndex,
      source,
      problems,
      preflight: { index: indexReport(run), casesIndex: casesMeta, source, cohorts, filterConsistency: consistency.map((c) => ({ questions: c.questions, passagesCases: c.passagesCases, casesIndexCases: c.casesIndexCases })) },
    };
  } catch (err) {
    await es.close();
    await closeDb(app);
    throw err;
  }
}

export async function closeContext(ctx: NarrativeContext): Promise<void> {
  await ctx.es.close();
  await closeDb(ctx.app);
}

const writeJson = (outDir: string, name: string, body: unknown): string => {
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
};

const usd = (x: number) => `$${x.toFixed(x < 0.01 ? 6 : 4)}`;

/** What remains of the evaluation allowance, when the app role may read the ledger; null otherwise. */
async function remainingAllowance(ctx: NarrativeContext): Promise<number | null> {
  try {
    return await remainingCategoryUsd(ctx.app, 'evaluation', new Date(), ctx.config.ai.budgets);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// plan (free)

/** The members (questions) of the dataset as scope-stage items. */
const scopeItems = (d: NarrativeDataset) => d.questions.map((q) => ({ id: q.id, question: q.question }));

export async function planCommand(
  opts: CommandOptions & {
    samples: Samples;
    broadSample: { bm25: number; lure: number; random: number };
    allocationUsd?: number;
    /** Judgment files whose records give the measured output tokens and disagreement (review N13). */
    measured?: string[];
    /** Mean output tokens per judge call (visible plus thinking or reasoning), judge A and judge B. */
    outputTokens?: { a: number; b: number };
    /** The share of pairs whose judges disagree. */
    disagreement?: number;
  },
): Promise<number> {
  const { log } = opts;
  const usage: MeasuredUsage | null = opts.measured && opts.measured.length > 0 ? measuredUsage(opts.measured.flatMap((f) => (JSON.parse(readFileSync(resolve(f), 'utf8')) as { records: PairRecord[] }).records)) : null;
  const inputs = planInputs(usage, { ...(opts.outputTokens ? { outputTokens: opts.outputTokens } : {}), ...(opts.disagreement !== undefined ? { disagreement: opts.disagreement } : {}) });
  const ctx = await openContext(opts.config, log);
  try {
    const d = ctx.dataset;
    if (usage) log(`measured (${opts.measured?.join(', ')}): ${usage.pairs} finished pairs, disagreement ${usage.disagreement === null ? 'n/a' : `${(usage.disagreement * 100).toFixed(1)}%`}; mean output tokens per call: judge A ${usage.outputTokens.a?.toFixed(0) ?? 'n/a'} (${usage.calls.a} calls), judge B ${usage.outputTokens.b?.toFixed(0) ?? 'n/a'} (${usage.calls.b}), adjudicator ${usage.outputTokens.adj?.toFixed(0) ?? 'n/a'} (${usage.calls.adj})`);
    log(`inputs: output tokens per call A ${Math.round(inputs.outputs.a)}, B ${Math.round(inputs.outputs.b)}, adjudicator ${Math.round(inputs.outputs.adj)} (${inputs.source.outputs}); escalation ${(inputs.escalation * 100).toFixed(1)}% of pool pairs, ${(inputs.calibrationDisagreement * 100).toFixed(1)}% of calibration items (${inputs.source.escalation})`);
    const anthropicKey = ctx.config.ai.anthropic.apiKey;
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required for the free token counts (pass --keys-file)');
    // Pool building: scope samples and query embeddings.
    const adapter = createAnthropicProvider({ apiKey: anthropicKey, models: { scope: ctx.config.ai.anthropic.scopeModel, answer: ctx.config.ai.anthropic.answerModel, check: ctx.config.ai.anthropic.checkModel } });
    const caller = providerScopeCaller(adapter);
    const scope = await scopeInventory(caller, scopeItems(d), opts.samples);
    const inventory = scope;
    const emb = planQueryEmbeddings(d.questions.map((q) => q.question), ctx.config.ai.openai.embeddingModel, ctx.config.ai.openai.embeddingDimensions);
    log(`pool building: scope stage ${scope.model}, ${scope.calls} calls (${d.questions.length} questions x ${opts.samples} samples), ${scope.inputTokens} input tokens counted; at most ${usd(scope.upperUsd)} at the output cap, reservations ${usd(scope.reserveUsd)}`);
    log(`pool building: ${describePlan(emb)}`);
    // Pool sizes.
    const estimates = { 1: poolEstimates(d, 1), 3: poolEstimates(d, 3) } as const;
    const sum = (s: Samples, k: 'mean' | 'max') => estimates[s].reduce((n, e) => n + e[k], 0);
    const pairsAns = (s: Samples, k: 'mean' | 'max') => estimates[s].reduce((n, e) => n + e.answerabilityPairs[k], 0);
    log(`pools (rule ${POOL_RULE.version}): relevance pairs about ${Math.round(sum(opts.samples, 'mean'))} (largest ${Math.round(sum(opts.samples, 'max'))}); answerability pairs about ${Math.round(pairsAns(opts.samples, 'mean'))}`);
    // Samples of judge inputs.
    const qualification = ctx.run.contract.eventAircraftQualification;
    const samples: CaseSample[] = [];
    for (const f of families(d)) {
      if (f.type === 'bounded-cohort') samples.push(...(f.cohort.cases ?? []).map((ntsbNo) => ({ family: f.id, ntsbNo, origin: 'cohort' as const })));
      else samples.push(...(await likelyPool(ctx.es, { passagesIndex: ctx.run.index, casesIndex: ctx.casesIndex, qualification }, f, await indexCohort(ctx.es, ctx.run.index, f, qualification), opts.broadSample)));
    }
    const client = new pg.Client({ connectionString: ctx.config.databaseUrl as string, application_name: 'aviation-eval-narrative-plan' });
    await client.connect();
    let loaded: Awaited<ReturnType<typeof sampleEvidence>>;
    try {
      loaded = await sampleEvidence(client, ctx.source.generationId, samples.map((s) => s.ntsbNo), ctx.calibration);
    } finally {
      await client.end();
    }
    log(`judge inputs: ${samples.length} sampled pool cases (${samples.filter((s) => s.origin === 'cohort').length} bounded-cohort cases, ${samples.filter((s) => s.origin !== 'cohort').length} likely-pool cases of broad questions), ${ctx.calibration.items.length} calibration items; counting with the provider (free)`);
    const haiku = createAnthropicJudge(JUDGE_A, { apiKey: anthropicKey });
    const sonnet = createAnthropicJudge(ADJUDICATOR, { apiKey: anthropicKey });
    const byFamily = new Map(families(d).map((f) => [f.id, f]));
    const measured: Measured[] = [];
    const queue = [...samples];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const e = loaded.evidence.get(s.ntsbNo);
        const f = byFamily.get(s.family) as NarrativeItem;
        if (e) measured.push(await measureCase(haiku, s.family, f, e));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    // Calibration items.
    const calMeasured: Measured[] = [];
    const calSplit = new Map<Measured, 'dev' | 'holdout'>();
    const calByItem = new Map<string, Measured>();
    for (const item of ctx.calibration.items) {
      const record = ctx.calibration.records[item.case.ntsbNo];
      const e = item.case.source === 'synthetic' ? (record ? controlEvidence(resolveRecord(record, ctx.calibration.fillers)) : undefined) : loaded.evidence.get(item.case.ntsbNo);
      const q = ctx.calibration.questions[item.question];
      if (!e || !q) continue;
      const m = item.kind === 'answerability' ? await measureBundle(haiku, item.question, q, e, itemPassages(e, item.bundle as ControlBundle)) : await measureCase(haiku, item.question, q, e);
      calMeasured.push(m);
      calSplit.set(m, item.split);
      calByItem.set(item.id, m);
    }
    // Sonnet counts like Haiku? A subset.
    const check = measured.filter((m) => m.chunks === 1).slice(0, 25);
    const ratios: number[] = [];
    for (const m of check) {
      const f = byFamily.get(m.family) as NarrativeItem;
      const e = loaded.evidence.get(m.ntsbNo) as CaseEvidence;
      const s = await measureCase(sonnet, m.family, f, e);
      ratios.push((s.claude[0] as number) / (m.claude[0] as number));
    }
    // Family prefixes.
    const prefixes = new Map<string, { claude: number; openai: number }>();
    for (const f of families(d)) {
      const any = measured.find((m) => m.family === f.id);
      const e = any ? loaded.evidence.get(any.ntsbNo) : undefined;
      if (e) prefixes.set(f.id, await prefixTokens(haiku, f, e));
    }
    // Answerability proxies: the first five sampled cases of each family.
    const ansMeasured: Measured[] = [];
    for (const f of families(d)) {
      for (const s of samples.filter((x) => x.family === f.id).slice(0, 5)) {
        const e = loaded.evidence.get(s.ntsbNo);
        if (e) ansMeasured.push(await measureAnswerability(haiku, f.id, f, e));
      }
    }
    const block = adjudicationBlockTokens();
    const defaultPrefix = { claude: 1_500, openai: 1_400 };
    const costOf = (m: Measured) => caseCost(m, prefixes.get(m.family) ?? defaultPrefix, block, inputs.outputs);
    // (b) the full pooled run: per family, the mean cost of its sampled cases scaled to its estimated pairs.
    const familyRuns = (s: Samples, k: 'mean' | 'max', escalation: number): RunCost[] =>
      estimates[s].map((e) => scaleRun(measured.filter((m) => m.family === e.family && !m.uncovered).map(costOf), e[k], escalation));
    const answerRuns = (s: Samples, k: 'mean' | 'max', escalation: number): RunCost[] =>
      estimates[s].map((e) => scaleRun(ansMeasured.filter((m) => m.family === e.family).map(costOf), e.answerabilityPairs[k], escalation));
    const relevance = addRuns(familyRuns(opts.samples, 'mean', inputs.escalation));
    const relevanceMax = addRuns(familyRuns(opts.samples, 'max', inputs.escalation));
    const answerability = addRuns(answerRuns(opts.samples, 'mean', inputs.escalation));
    const alternative: Samples = opts.samples === 3 ? 1 : 3;
    const relevanceAlt = addRuns(familyRuns(alternative, 'mean', inputs.escalation));
    const answerabilityAlt = addRuns(answerRuns(alternative, 'mean', inputs.escalation));
    // (a) the calibration run: every item once, every disagreement adjudicated.
    const calCost = (m: Measured) => caseCost(m, defaultPrefix, block, inputs.outputs);
    const calibration = scaleRun(calMeasured.map(calCost), ctx.calibration.items.length, inputs.calibrationDisagreement, 1);
    const poolBuilding = scope.upperUsd + (emb.inputTokens * emb.usdPerMillionTokens) / 1e6;
    const pooled = relevance.usd.total + answerability.usd.total + poolBuilding;
    const pooledBound = relevance.totalAtBoundUsd + answerability.totalAtBoundUsd + poolBuilding;
    // The frozen schedule's stages (pool.ts SCHEDULE): stage 1, and what stage 2 adds.
    const stageRuns = (part: 'stage1' | 'rest', escalation: number): RunCost =>
      addRuns(estimates[opts.samples].map((e) => scaleRun(measured.filter((m) => m.family === e.family && !m.uncovered).map(costOf), part === 'stage1' ? e.stage1.mean : e.mean - e.stage1.mean, escalation)));
    const stage1 = stageRuns('stage1', inputs.escalation);
    const stage2 = stageRuns('rest', inputs.escalation);
    // Calibration by split: dev first, then the holdout once (criteria.ts).
    const calibrationOf = (split: 'dev' | 'holdout') => {
      const mine = calMeasured.filter((m) => calSplit.get(m) === split);
      return scaleRun(mine.map(calCost), mine.length, inputs.calibrationDisagreement, 1);
    };
    const calibrationDev = calibrationOf('dev');
    const calibrationHoldout = calibrationOf('holdout');
    // The canary (review N9): the first dev item in the schedule's order; its cap covers one full escalation at the caps, and the dev run does not pay for it again (cached).
    const canaryItem = canaryOf(ctx.calibration.items);
    const canaryMeasured = canaryItem ? calByItem.get(canaryItem.id) : undefined;
    const canaryCost = canaryMeasured ? calCost(canaryMeasured) : null;
    const canaryRun = canaryCost ? scaleRun([canaryCost], 1, inputs.calibrationDisagreement, 1) : null;
    const canary = {
      item: canaryItem?.id ?? null,
      expectedUsd: canaryRun?.usd.total ?? 0,
      adjudicatedUsd: canaryRun?.totalAtBoundUsd ?? 0,
      fullEscalationAtCapsUsd: canaryCost ? fullEscalationUsd(canaryCost) : 0,
      // The limit to pass: one full escalation at the caps, rounded up to the cent.
      maxUsd: canaryCost ? Math.ceil(fullEscalationUsd(canaryCost) * 100) / 100 : 0.1,
    };
    // Where the relevance money goes, and the protocol's own estimate at the same prices (review M14).
    const relevanceWith = (part: 'input' | 'visible' | 'full') =>
      addRuns(estimates[opts.samples].map((e) => scaleRun(measured.filter((m) => m.family === e.family && !m.uncovered).map((m) => caseCost(m, prefixes.get(m.family) ?? defaultPrefix, block, outputsFor(part, inputs.outputs))), e.mean, inputs.escalation)));
    const inputRun = relevanceWith('input');
    const visibleRun = relevanceWith('visible');
    const judges = (r: RunCost) => r.usd.judgeA + r.usd.judgeB;
    const breakdown = {
      judgesInputUsd: judges(inputRun),
      judgesVisibleOutputUsd: judges(visibleRun) - judges(inputRun),
      judgesReasoningUsd: judges(relevance) - judges(visibleRun),
      adjudicationUsd: relevance.usd.adjudicator,
      totalUsd: relevance.usd.total,
      protocol: protocolArithmetic(),
    };
    // The month's sequence (the gate's ruling): canary, dev calibration, holdout once, pools, relevance stage 1, answerability.
    const sequence = [
      { step: `canary: one dev calibration pair (--max-pairs 1 --max-usd ${canary.maxUsd.toFixed(2)})`, expectedUsd: canary.expectedUsd, boundUsd: canary.maxUsd },
      { step: 'calibration, dev split, the rest, one pair at a time (--concurrency 1)', expectedUsd: calibrationDev.usd.total - canary.expectedUsd, boundUsd: calibrationDev.totalAtBoundUsd - canary.adjudicatedUsd },
      { step: 'calibration, holdout split, once', expectedUsd: calibrationHoldout.usd.total, boundUsd: calibrationHoldout.totalAtBoundUsd },
      { step: 'pools (scope samples and query embeddings)', expectedUsd: poolBuilding, boundUsd: scope.reserveUsd + emb.reserveUsd },
      { step: 'relevance, stage 1 (bounded cohorts; broad delivered and first-20 cases)', expectedUsd: stage1.usd.total, boundUsd: stage1.totalAtBoundUsd },
      { step: 'answerability (every delivered bundle)', expectedUsd: answerability.usd.total, boundUsd: answerability.totalAtBoundUsd },
    ];
    const sequenceTotal = { expectedUsd: sequence.reduce((n, x) => n + x.expectedUsd, 0), boundUsd: sequence.reduce((n, x) => n + x.boundUsd, 0) };
    // Sensitivity of the pooled run (relevance and answerability, the chosen samples): judges' thinking or reasoning tokens, escalation share, batch pricing.
    const pooledWith = (reasoning: number, escalation: number) =>
      addRuns([
        ...estimates[opts.samples].map((e) => scaleRun(measured.filter((m) => m.family === e.family && !m.uncovered).map((m) => caseCost(m, prefixes.get(m.family) ?? defaultPrefix, block, expectedOutputs(reasoning))), e.mean, escalation)),
        ...estimates[opts.samples].map((e) => scaleRun(ansMeasured.filter((m) => m.family === e.family).map((m) => caseCost(m, prefixes.get(m.family) ?? defaultPrefix, block, expectedOutputs(reasoning))), e.answerabilityPairs.mean, escalation)),
      ]).usd.total + poolBuilding;
    const sensitivity = [500, 1_000, 1_500].flatMap((reasoning) =>
      [0.1, 0.15, 0.25].map((escalation) => {
        const total = pooledWith(reasoning, escalation);
        return { reasoningTokens: reasoning, escalation, totalUsd: total, withBatchApisUsd: poolBuilding + (total - poolBuilding) / 2 };
      }),
    );
    const perFamily = estimates[opts.samples].map((e) => {
      const mine = measured.filter((m) => m.family === e.family);
      const run = scaleRun(mine.filter((m) => !m.uncovered).map(costOf), e.mean, inputs.escalation);
      return { family: e.family, type: e.type, members: e.members, pairs: e.mean, pairsLargest: e.max, sampled: mine.length, claudeMean: statsOf(mine.map((m) => m.claude.reduce((a, b) => a + b, 0))).mean, chunked: mine.filter((m) => m.chunks > 1).length, expectedUsd: run.usd.total };
    });
    const remaining = await remainingAllowance(ctx);
    const tokens = {
      relevanceClaude: statsOf(measured.flatMap((m) => m.claude.slice(0, 1))),
      relevanceOpenai: statsOf(measured.flatMap((m) => m.openai.slice(0, 1))),
      caseCl100k: statsOf(measured.map((m) => m.caseTokens)),
      bounded: statsOf(measured.filter((m) => byFamily.get(m.family)?.type === 'bounded-cohort').map((m) => m.claude.reduce((a, b) => a + b, 0))),
      broadLikely: statsOf(measured.filter((m) => byFamily.get(m.family)?.type === 'broad').map((m) => m.claude.reduce((a, b) => a + b, 0))),
      calibration: statsOf(calMeasured.map((m) => m.claude.reduce((a, b) => a + b, 0))),
      answerability: statsOf(ansMeasured.map((m) => m.claude[0] as number)),
      prefixClaude: statsOf([...prefixes.values()].map((p) => p.claude)),
      prefixOpenai: statsOf([...prefixes.values()].map((p) => p.openai)),
      sonnetOverHaiku: statsOf(ratios.map((r) => Math.round(r * 1000) / 1000)),
    };
    const chunked = measured.filter((m) => m.chunks > 1);
    const report = {
      kind: 'track-n-plan',
      reference: d.reference,
      createdAt: new Date().toISOString(),
      git: gitState(),
      problems: ctx.problems,
      preflight: ctx.preflight,
      judges: { judgeA: JUDGE_A, judgeB: JUDGE_B, adjudicator: ADJUDICATOR },
      assumptions: ASSUMPTIONS,
      inputs: { ...inputs, measured: usage ? { files: opts.measured, ...usage } : null },
      canary,
      samples: opts.samples,
      poolBuilding: { scope, embeddings: { tokens: emb.inputTokens, usd: (emb.inputTokens * emb.usdPerMillionTokens) / 1e6, reserveUsd: emb.reserveUsd }, usd: poolBuilding },
      pools: { estimates: estimates[opts.samples], relevancePairs: { mean: sum(opts.samples, 'mean'), max: sum(opts.samples, 'max') }, answerabilityPairs: { mean: pairsAns(opts.samples, 'mean'), max: pairsAns(opts.samples, 'max') } },
      tokens,
      chunked: { sampled: measured.length, chunked: chunked.length, uncovered: measured.filter((m) => m.uncovered).length, cases: chunked.map((m) => ({ ntsbNo: m.ntsbNo, family: m.family, caseTokens: m.caseTokens, chunks: m.chunks })) },
      perFamily,
      sensitivity,
      stages: { schedule: SCHEDULE, stage1: { pairs: stage1.pairs, run: stage1 }, stage2: { pairs: stage2.pairs, run: stage2 } },
      month: { allocationUsd: opts.allocationUsd ?? null, sequence, total: sequenceTotal, nextMonth: { step: 'relevance, stage 2 (the rest of the pools)', expectedUsd: stage2.usd.total, boundUsd: stage2.totalAtBoundUsd } },
      breakdown,
      costs: {
        calibration,
        calibrationDev,
        calibrationHoldout,
        relevance,
        relevanceLargestPools: relevanceMax,
        answerability,
        alternative: { samples: alternative, relevance: relevanceAlt, answerability: answerabilityAlt, poolBuilding: poolBuilding * (alternative / opts.samples) },
        pooledTotalUsd: pooled,
        pooledTotalAtEscalationBoundUsd: pooledBound,
        worstCaseUsd: relevance.worstCaseUsd + answerability.worstCaseUsd + scope.reserveUsd + emb.reserveUsd,
        perAttemptReservationUsd: {
          judgeA: { typical: attemptReserveUsd(JUDGE_A, tokens.relevanceClaude.mean), largest: attemptReserveUsd(JUDGE_A, tokens.relevanceClaude.max) },
          judgeB: { typical: attemptReserveUsd(JUDGE_B, tokens.relevanceOpenai.mean), largest: attemptReserveUsd(JUDGE_B, tokens.relevanceOpenai.max) },
          adjudicator: { typical: attemptReserveUsd(ADJUDICATOR, tokens.relevanceClaude.mean + block), largest: attemptReserveUsd(ADJUDICATOR, tokens.relevanceClaude.max + block) },
          scope: inventory.perCallReserveUsd,
          // In flight at the default concurrency, at the largest inputs: both judges of each pair while judging, one adjudicator attempt per pair while escalating (review M10).
          concurrentLargestUsd: {
            judging: DEFAULT_CONCURRENCY * (attemptReserveUsd(JUDGE_A, tokens.relevanceClaude.max) + attemptReserveUsd(JUDGE_B, tokens.relevanceOpenai.max)),
            adjudicating: DEFAULT_CONCURRENCY * attemptReserveUsd(ADJUDICATOR, tokens.relevanceClaude.max + block),
          },
        },
      },
      remainingAllowanceUsd: remaining,
    };
    const file = writeJson(opts.outDir, `narrative-plan-${stamp(new Date())}.json`, report);
    log('');
    log(`token counts (Claude, provider counter): relevance request mean ${tokens.relevanceClaude.mean}, p90 ${tokens.relevanceClaude.p90}, max ${tokens.relevanceClaude.max}; OpenAI estimate mean ${tokens.relevanceOpenai.mean}, max ${tokens.relevanceOpenai.max}; family prefix about ${tokens.prefixClaude.mean} (Claude)`);
    log(`long cases: ${chunked.length} of ${measured.length} sampled cases above ${CASE_TOKEN_BUDGET.toLocaleString('en-US')} cl100k tokens (chunked), ${report.chunked.uncovered} uncovered; Sonnet/Haiku count ratio ${tokens.sonnetOverHaiku.mean}`);
    const n = (x: number, w: number) => String(Math.round(x)).padStart(w);
    const line = (name: string, r: RunCost, bound = `at the ${ASSUMPTIONS.escalationBound * 100}% escalation bound`) =>
      log(`  ${name.padEnd(32)} ${n(r.pairs, 6)} pairs  A ${n(r.calls.judgeA, 6)} / B ${n(r.calls.judgeB, 6)} / adj ${n(r.calls.adjudicator, 5)} calls  expected ${usd(r.usd.total)} (A ${usd(r.usd.judgeA)}, B ${usd(r.usd.judgeB)}, adj ${usd(r.usd.adjudicator)}); ${bound} ${usd(r.totalAtBoundUsd)}; every call at its caps ${usd(r.worstCaseUsd)}`);
    log('costs:');
    line(`(a) calibration (${ctx.calibration.items.length} items)`, calibration, 'with every item adjudicated');
    line('    of which the dev split', calibrationDev, 'with every item adjudicated');
    line('    of which the holdout split', calibrationHoldout, 'with every item adjudicated');
    line(`(b) relevance, ${opts.samples} scope sample(s)`, relevance);
    line('    with the largest pools', relevanceMax);
    line('    answerability', answerability);
    log(`  pool building (scope samples and embeddings): ${usd(poolBuilding)}`);
    log(`  (b) full pooled run: expected ${usd(pooled)}; at the escalation bound ${usd(pooledBound)}`);
    log(`  with ${alternative} scope sample(s) instead: relevance ${usd(relevanceAlt.usd.total)}, answerability ${usd(answerabilityAlt.usd.total)}`);
    line('    relevance stage 1', stage1);
    line('    relevance stage 2 (the rest)', stage2);
    log(
      `where the relevance money goes: judges' input ${usd(breakdown.judgesInputUsd)}, judges' visible output ${usd(breakdown.judgesVisibleOutputUsd)}, judges' reasoning ${usd(breakdown.judgesReasoningUsd)}, adjudication ${usd(breakdown.adjudicationUsd)}; ` +
        `the protocol's estimate at the same prices (${breakdown.protocol.pairs} pairs, ${breakdown.protocol.input} input and ${breakdown.protocol.output} output tokens, ${breakdown.protocol.escalation * 100}% to one Sonnet call) ${usd(breakdown.protocol.usd.total)}`,
    );
    log(
      `canary: ${canary.item ?? 'none'}; expected ${usd(canary.expectedUsd)}, adjudicated ${usd(canary.adjudicatedUsd)}; one full escalation at its caps ${usd(canary.fullEscalationAtCapsUsd)}, so --max-usd ${canary.maxUsd.toFixed(2)} lets it finish (the adjudicator runs only if the judges disagree on it)`,
    );
    log(`this month's sequence${opts.allocationUsd !== undefined ? ` against an allocation of $${opts.allocationUsd}` : ''}:`);
    let running = 0;
    let runningBound = 0;
    for (const x of sequence) {
      running += x.expectedUsd;
      runningBound += x.boundUsd;
      log(`  ${x.step.padEnd(76)} expected ${usd(x.expectedUsd).padStart(9)} (cumulative ${usd(running)}), bound ${usd(x.boundUsd).padStart(9)} (cumulative ${usd(runningBound)})`);
    }
    if (opts.allocationUsd !== undefined) log(`  the sequence ${sequenceTotal.expectedUsd <= opts.allocationUsd ? 'fits' : 'does not fit'} the allocation at the expected cost (${usd(sequenceTotal.expectedUsd)}); at its bounds ${usd(sequenceTotal.boundUsd)}`);
    log(`  next month, from the cache: relevance stage 2 expected ${usd(stage2.usd.total)}, at the escalation bound ${usd(stage2.totalAtBoundUsd)}`);
    log('sensitivity of the full pooled run (judges\' thinking or reasoning tokens per call, escalation share; batch pricing halves every model call):');
    for (const x of sensitivity) log(`  reasoning ${String(x.reasoningTokens).padStart(5)}  escalation ${(x.escalation * 100).toFixed(0).padStart(2)}%  ${usd(x.totalUsd).padStart(9)}  with batch APIs ${usd(x.withBatchApisUsd)}`);
    log(`remaining evaluation allowance: ${remaining === null ? 'not readable with the app role' : usd(remaining)}`);
    for (const p of ctx.problems) log(`problem: ${p}`);
    log(`plan: ${file}`);
    log('nothing was sent to a paid endpoint');
    return ctx.problems.length > 0 ? 1 : 0;
  } finally {
    await closeContext(ctx);
  }
}

// ---------------------------------------------------------------------------
// Paid commands

/** A run's own spend log: a new file for every run, so no limit is ever summed over earlier runs. */
const runSpendLog = (outDir: string, runId: string): string => resolve(outDir, 'spend', `${runId}.jsonl`);

function ledgerGates(ingest: Db, config: AppConfig): (c: JudgeCaller['config']) => SpendGate {
  const gates = new Map<string, SpendGate>();
  return (c) => {
    const key = `${c.provider}:${c.model}`;
    let g = gates.get(key);
    if (!g) {
      g = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: c.provider, model: c.model, stage: c.role === 'adjudicator' ? 'adjudicate' : 'judge' });
      gates.set(key, g);
    }
    return g;
  };
}

/** `pools`: scope samples and query embeddings (paid, reserved per attempt), then the method runs (Elasticsearch reads) and the pool file. */
export async function poolsCommand(opts: CommandOptions & { samples: Samples; maxUsd?: number; allocation?: string; allocationUsd?: number }): Promise<number> {
  const { log } = opts;
  const ctx = await openContext(opts.config, log);
  try {
    if (ctx.problems.length > 0) throw new Error(`preflight failed; nothing paid:\n  ${ctx.problems.join('\n  ')}`);
    const d = ctx.dataset;
    const a = ctx.config.ai.anthropic;
    if (!a.apiKey) throw new Error('ANTHROPIC_API_KEY is required (pass --keys-file)');
    const adapter = createAnthropicProvider({ apiKey: a.apiKey, models: { scope: a.scopeModel, answer: a.answerModel, check: a.checkModel } });
    const caller = providerScopeCaller(adapter);
    const items = scopeItems(d);
    const inventory = await scopeInventory(caller, items, opts.samples);
    const emb = planQueryEmbeddings(d.questions.map((q) => q.question), ctx.config.ai.openai.embeddingModel, ctx.config.ai.openai.embeddingDimensions);
    log(`scope samples: ${inventory.calls} calls, reservations ${usd(inventory.reserveUsd)}; ${describePlan(emb)}`);
    const { grid } = loadGrid(DEFAULT_GRID, BASELINE_CONFIG);
    const methods = POOL_RULE.methods.map((id) => {
      const v = grid.variants.find((x) => x.id === id);
      if (!v) throw new Error(`method ${id} is not in the experiments grid`);
      return { id, config: experimentConfig(v.config) };
    });
    if (!opts.confirm) {
      log('nothing sent: run with --confirm-cost to take the scope samples, embed the questions and build the pools');
      return 0;
    }
    if (!opts.allocation) throw new Error('--allocation is required for a paid command (the phase or month budget it spends from); nothing sent');
    const allocation = openAllocation(opts.outDir, opts.allocation, opts.allocationUsd);
    const purpose = `eval-10c2-pools-${stamp(new Date())}`;
    // One run at a time per allocation (review N12): the lock is held from before the allocation's spend is read until the run ends.
    const held = lockAllocation(allocation, purpose);
    try {
      const spendLog = runSpendLog(opts.outDir, purpose);
      const limit = Math.min(opts.maxUsd ?? RUN_LIMITS_USD.pools, allocation.capUsd - loggedSpendUsd(allocation.log));
      if (inventory.reserveUsd + emb.reserveUsd > limit + 1e-12) throw new Error(`the pool reservations ($${(inventory.reserveUsd + emb.reserveUsd).toFixed(6)}) exceed the run limit or what remains of allocation ${allocation.name} ($${limit.toFixed(6)}); nothing sent`);
      if (!ctx.config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
      const ingest = createDb(ctx.config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-narrative-ledger' });
      let run: ScopeRun;
      try {
        const gate = createLedgerSpendGate(ingest, { budgets: ctx.config.ai.budgets, provider: 'anthropic', model: a.scopeModel, stage: 'scope' });
        run = await runScopeSamples(caller, gate, items, { samples: opts.samples, retries: 1, maxUsd: limit - emb.reserveUsd, purpose, log });
      } finally {
        await closeDb(ingest);
      }
      const charge = (entry: Record<string, unknown>) => {
        for (const file of [spendLog, allocation.log]) {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), run: purpose, ...entry })}\n`);
        }
      };
      charge({ purpose: 'scope', provider: 'anthropic', model: a.scopeModel, reservedUsd: run.reservedUsd, chargedUsd: run.chargedUsd });
      const { embedder, billed } = await embedPlan(emb, { fake: false, config: ctx.config, purpose, log });
      charge({ purpose: 'embed', provider: 'openai', model: emb.model, reservedUsd: emb.reserveUsd, chargedUsd: billed.usd });
      const texts = new Map<string, string[]>();
      for (const q of d.questions) texts.set(q.id, run.samples.filter((s) => s.id === q.id).sort((x, y) => x.sample - y.sample).map((s) => s.keywordText));
      const built = await buildPools(
        { es: ctx.es, dataset: ctx.run.target, passagesIndex: ctx.run.index, casesIndex: ctx.casesIndex, eventAircraftQualification: ctx.run.contract.eventAircraftQualification },
        d,
        embedder,
        methods,
        texts,
        log,
      );
      // Every pool case's complete-input fingerprint, from one read-only snapshot: the evidence identity the judgments must match.
      const client = new pg.Client({ connectionString: ctx.config.databaseUrl as string, application_name: 'aviation-eval-narrative-pools' });
      await client.connect();
      let fingerprints: Map<string, string>;
      try {
        const loaded = await loadCaseEvidence(client, ctx.source.generationId, [...new Set(built.flatMap((f) => f.cases.map((c) => c.ntsbNo)))]);
        if (loaded.integrity.length > 0) log(`warning: ${loaded.integrity.length} pool case(s) failed the section hash check and stay unknown: ${loaded.integrity.slice(0, 5).map((x) => x.ntsbNo).join(', ')}`);
        fingerprints = new Map([...loaded.evidence.entries()].map(([n, e]) => [n, fingerprint(e)]));
      } finally {
        await client.end();
      }
      const pools = built.map((f) => withFingerprints(POOL_RULE, f, fingerprints));
      const body: Omit<PoolFile, 'version'> = {
        kind: 'track-n-pools',
        rule: POOL_RULE,
        datasetSpecSha256: d.source.specSha256,
        generationId: ctx.source.generationId,
        target: { ...indexReport(ctx.run), casesIndex: ctx.casesIndex, scope: { model: a.scopeModel, promptVersion: run.promptVersion, samples: run.samples.map((s) => ({ id: s.id, sample: s.sample, status: s.status, keywordTextSha256: sha256(s.keywordText) })) } },
        methods,
        families: pools,
      };
      const file = writeJson(opts.outDir, `narrative-pools-${stamp(new Date())}.json`, { ...body, version: poolFileVersion(body), git: gitState() });
      log(`pools: ${pools.reduce((n, p) => n + p.cases.length, 0)} cases in ${pools.length} families; ${file}`);
      return 0;
    } finally {
      held.release();
    }
  } finally {
    await closeContext(ctx);
  }
}

/** A pool file, every family's version and the file's version recomputed from the content (nothing stored is trusted). */
export function readPools(file: string): PoolFile {
  const p = JSON.parse(readFileSync(resolve(file), 'utf8')) as PoolFile;
  if (p.kind !== 'track-n-pools') throw new Error(`${file} is not a Track N pool file`);
  const problems = verifyPoolFile(p);
  if (problems.length > 0) throw new Error(`${file}: ${problems.slice(0, 5).join('; ')}`);
  return p;
}

const refOf = (q: { question: string; rubric: NarrativeItem['rubric']; questionVersion: string; rubricVersion: string }, family: string): FamilyRef => ({
  family,
  question: q.question,
  rubric: q.rubric,
  questionVersion: q.questionVersion,
  rubricVersion: q.rubricVersion,
});

/** The relevance pairs of a pool file, in the frozen schedule's priority order (`SCHEDULE`). */
export async function poolSubjects(ctx: NarrativeContext, pools: PoolFile): Promise<{ items: PairPlanItem[]; missing: string[] }> {
  const client = new pg.Client({ connectionString: ctx.config.databaseUrl as string, application_name: 'aviation-eval-narrative-judge' });
  await client.connect();
  try {
    const wanted = [...new Set(pools.families.flatMap((f) => f.cases.map((c) => c.ntsbNo)))];
    const loaded = await loadCaseEvidence(client, ctx.source.generationId, wanted);
    const byId = new Map(families(ctx.dataset).map((f) => [f.id, f]));
    const items: PairPlanItem[] = [];
    for (const pool of pools.families) {
      const f = byId.get(pool.family);
      if (!f || f.questionVersion !== pool.questionVersion || f.rubricVersion !== pool.rubricVersion) throw new Error(`pool ${pool.family}: the dataset's question or rubric version differs from the pool's`);
      for (const c of pool.cases) {
        const e = loaded.evidence.get(c.ntsbNo);
        if (!e) continue;
        const fp = fingerprint(e);
        const recorded = pool.fingerprints[c.ntsbNo];
        if (recorded !== undefined && recorded !== fp) {
          throw new Error(`pool ${pool.family}: the record of ${c.ntsbNo} changed since the pool was built (fingerprint differs); build a new pool version; nothing paid`);
        }
        items.push({ subject: relevanceSubject(refOf(f, f.id), e, planChunks(e), fp), priority: casePriority(c, pool.type) });
      }
    }
    return { items: items.sort(byPriority), missing: [...loaded.missing, ...loaded.integrity.map((x) => x.ntsbNo)] };
  } finally {
    await client.end();
  }
}

/** The calibration pairs (one split or both), each case's evidence checked against the fingerprint its label was made against. */
export async function calibrationSubjects(ctx: NarrativeContext, split: 'dev' | 'holdout'): Promise<{ items: PairPlanItem[]; problems: string[] }> {
  const cal = ctx.calibration;
  const chosen = cal.items.filter((i) => i.split === split);
  const client = new pg.Client({ connectionString: ctx.config.databaseUrl as string, application_name: 'aviation-eval-narrative-judge' });
  await client.connect();
  try {
    const loaded = await loadCaseEvidence(client, ctx.source.generationId, chosen.filter((i) => i.case.source === 'canonical').map((i) => i.case.ntsbNo));
    const problems: string[] = [];
    const items: PairPlanItem[] = [];
    for (const i of chosen) {
      const record = cal.records[i.case.ntsbNo];
      const e = i.case.source === 'synthetic' ? (record ? controlEvidence(resolveRecord(record, cal.fillers)) : undefined) : loaded.evidence.get(i.case.ntsbNo);
      const q = cal.questions[i.question];
      if (!e || !q) {
        problems.push(`${i.id}: no evidence or question`);
        continue;
      }
      if (i.kind === 'answerability') {
        let passages: DeliveredPassage[];
        try {
          passages = itemPassages(e, i.bundle as ControlBundle);
        } catch (err) {
          problems.push(`${i.id}: ${(err as Error).message}`);
          continue;
        }
        const subject = answerabilitySubject(refOf(q, i.question), e, passages, bundleFingerprint(e.ntsbNo, e.event, e.aircraft, passages));
        if (subject.fingerprint !== i.case.fingerprint || subject.bundleKey !== i.bundle?.key) {
          problems.push(`${i.id}: the bundle changed since its label was made (fingerprint or key differs)`);
          continue;
        }
        items.push({ subject, priority: 0 });
        continue;
      }
      if (fingerprint(e) !== i.case.fingerprint) {
        problems.push(`${i.id}: the case's record changed since its label was made (fingerprint differs)`);
        continue;
      }
      items.push({ subject: relevanceSubject(refOf(q, i.question), e, planChunks(e), i.case.fingerprint), priority: 0 });
    }
    return { items, problems };
  } finally {
    await client.end();
  }
}

/** The answerability pairs of a pool file: every distinct delivered (case, passages), its passage texts read back from the stored sections and checked. */
export async function answerabilitySubjects(ctx: NarrativeContext, pools: PoolFile): Promise<{ items: PairPlanItem[]; problems: string[] }> {
  const client = new pg.Client({ connectionString: ctx.config.databaseUrl as string, application_name: 'aviation-eval-narrative-judge' });
  await client.connect();
  try {
    const pairs = pools.families.flatMap((p) => bundlePairs(p).map((x) => ({ pool: p, ...x })));
    const loaded = await loadCaseEvidence(client, ctx.source.generationId, [...new Set(pairs.map((x) => x.ntsbNo))]);
    const byId = new Map(families(ctx.dataset).map((f) => [f.id, f]));
    const problems: string[] = [];
    const items: PairPlanItem[] = [];
    for (const x of pairs) {
      const f = byId.get(x.pool.family) as NarrativeItem;
      const e = loaded.evidence.get(x.ntsbNo);
      if (!e) {
        problems.push(`${x.ntsbNo}: no evidence`);
        continue;
      }
      const passages: DeliveredPassage[] = [];
      for (const p of x.passages) {
        const s = e.sections.find((sec) => sec.sectionId === p.sectionId && sec.revisionId === p.revisionId);
        const text = s?.text.slice(p.start, p.end);
        if (text === undefined || sha256(text) !== p.textSha256) {
          problems.push(`${x.ntsbNo}: passage ${p.passageId.slice(0, 12)} does not match its stored section text`);
          continue;
        }
        passages.push({ ...p, text });
      }
      if (passages.length !== x.passages.length) continue;
      // Every delivered bundle case is tier 0 of the schedule, ordered by its best case rank.
      const best = Math.min(...x.runs.map((r) => r.caseRank));
      items.push({ subject: answerabilitySubject(refOf(f, f.id), e, passages, bundleFingerprint(e.ntsbNo, e.event, e.aircraft, passages)), priority: best });
    }
    return { items: items.sort(byPriority), problems };
  } finally {
    await client.end();
  }
}

export interface JudgingDeps {
  /** The judges and the adjudicator (created only after `--confirm-cost`). */
  callers: () => { judges: readonly [JudgeCaller, JudgeCaller]; adjudicator: JudgeCaller };
  /** The evaluation ledger's gates (opened only after `--confirm-cost`). */
  ledger: () => { gate: SpendGate | ((c: JudgeCaller['config']) => SpendGate); close: () => Promise<void> };
}

/** What a judgment run records about its schedule: the version, the stage and the pairs per tier. */
export interface ScheduleInfo {
  version: string;
  stage: Stage | null;
  tiers: Record<string, number>;
}

export const scheduleInfo = (items: readonly PairPlanItem[], stage: Stage | null): ScheduleInfo => {
  const tiers: Record<string, number> = {};
  for (const i of items) tiers[String(tierOf(i.priority))] = (tiers[String(tierOf(i.priority))] ?? 0) + 1;
  return { version: SCHEDULE.version, stage, tiers };
};

/**
 * The paid part of `judge` and `answerability`: without `confirm` it prints the plan and
 * creates nothing (no client, no ledger connection); with it, every pair is judged in the
 * schedule's order with per-attempt reservations against the run's own limit, its
 * allocation and the ledger, and a budget stop ends the run with its records kept.
 */
export async function runJudging(
  items: readonly PairPlanItem[],
  opts: {
    set: 'calibration' | 'relevance' | 'answerability';
    confirm: boolean;
    limitUsd: number;
    allocation: { name: string; capUsd?: number } | null;
    maxEscalationShare: number;
    concurrency: number;
    outDir: string;
    reference: string;
    schedule: ScheduleInfo;
    /** The frozen experiment identity the records are made under (`identity.ts`). */
    experiment?: Record<string, unknown>;
    log: (m: string) => void;
  },
  deps: JudgingDeps,
): Promise<number> {
  const { log } = opts;
  log(`${opts.set}: ${items.length} pairs (schedule ${opts.schedule.version}${opts.schedule.stage ? `, stage ${opts.schedule.stage}` : ''}: ${Object.entries(opts.schedule.tiers).map(([t, n]) => `tier ${t} ${n}`).join(', ')}); judges ${JUDGE_A.model} and ${JUDGE_B.model}, adjudicator ${ADJUDICATOR.model} (at most ${Math.floor(opts.maxEscalationShare * items.length)} escalations); run limit $${opts.limitUsd}`);
  if (!opts.confirm) {
    log('nothing sent: run `plan` for the cost, then this command with --confirm-cost and --allocation');
    return 0;
  }
  if (!opts.allocation) throw new Error('--allocation is required for a paid command (the phase or month budget it spends from); nothing sent');
  const allocation: Allocation = openAllocation(opts.outDir, opts.allocation.name, opts.allocation.capUsd);
  const runId = `eval-10c2-${opts.set}-${stamp(new Date())}`;
  // One run at a time per allocation (review N12): held from before the allocation's spend is read until the run ends.
  const held = lockAllocation(allocation, runId);
  let ledger: ReturnType<JudgingDeps['ledger']> | null = null;
  try {
    const callers = deps.callers();
    ledger = deps.ledger();
    const sender = new AttemptSender({ gate: ledger.gate, limitUsd: opts.limitUsd, spendLog: runSpendLog(opts.outDir, runId), allocation, run: runId }, JUDGE_TIMEOUT_MS);
    log(`allocation ${allocation.name}: $${sender.allocationSpentUsd.toFixed(4)} of $${allocation.capUsd} spent before this run`);
    const cache = new JudgmentCache(resolve(opts.outDir, 'cache.jsonl'));
    const { records, stopped } = await judgePairs(items, { judges: callers.judges, adjudicator: callers.adjudicator, sender, cache, concurrency: opts.concurrency, maxEscalationShare: opts.maxEscalationShare, log: (m) => console.error(m) });
    const file = writeJson(opts.outDir, `narrative-judgments-${opts.set}-${stamp(new Date())}.json`, {
      kind: 'track-n-judgments',
      set: opts.set,
      reference: opts.reference,
      run: runId,
      allocation: allocation.name,
      git: gitState(),
      ...(opts.experiment ? { experiment: opts.experiment } : {}),
      schedule: opts.schedule,
      stopped,
      records,
    });
    log(`${records.length} pair records; run spend ${usd(sender.spentUsd)}; allocation ${allocation.name} ${usd(sender.allocationSpentUsd)} of $${allocation.capUsd}; ${stopped ? `stopped: ${stopped}; ` : ''}${file}`);
    return stopped ? 1 : 0;
  } finally {
    try {
      await ledger?.close();
    } finally {
      held.release();
    }
  }
}

/** What a holdout run records in the lock. */
export interface HoldoutRun {
  kind: 'track-n-holdout-run';
  at: string;
  /** The holdout split's identity: its items' kind, question, case and bundle (labels, rubrics and texts excluded). */
  holdoutSha256: string;
  /** What the holdout is judged under: the experiment identity without the whole-file label hash, with each holdout item's question and rubric versions and evidence fingerprint. */
  configurationSha256: string;
  /** Each holdout item's key, case and label at the run. */
  items: { key: string; ntsbNo: string; label: 0 | 1 | 2 }[];
}

/** The holdout split's identity and configuration (module comment of `guardHoldout`). */
export function holdoutIdentity(calibration: Pick<CalibrationDataset, 'items'>, experiment: Record<string, unknown>): Omit<HoldoutRun, 'kind' | 'at'> {
  const items = calibration.items.filter((i) => i.split === 'holdout').sort((x, y) => (itemKey(x) < itemKey(y) ? -1 : itemKey(x) > itemKey(y) ? 1 : 0));
  const data = (experiment.data ?? {}) as Record<string, unknown>;
  const { labelsSha256: _wholeFile, ...rest } = data;
  return {
    holdoutSha256: sha256(canonicalJson(items.map((i) => itemKey(i)))),
    configurationSha256: sha256(
      canonicalJson({
        experiment: { ...experiment, data: rest },
        items: items.map((i) => ({ key: itemKey(i), questionVersion: i.questionVersion, rubricVersion: i.rubricVersion, fingerprint: i.case.fingerprint })),
      }),
    ),
    items: items.map((i) => ({ key: itemKey(i), ntsbNo: i.case.ntsbNo, label: i.label })),
  };
}

/**
 * D3 (criteria.ts): the holdout runs once per frozen configuration. A holdout run records
 * the holdout split's identity, its configuration and its labels in the fixed lock
 * (`HOLDOUT_LOCK_FILE`). A later holdout run is refused when any of its cases was in a
 * holdout run under another configuration (a configuration chosen after seeing the
 * holdout needs a fresh holdout with new cases), or when a label of an item already run
 * changed (a relabelled holdout is no longer held out). Edits that touch only the dev
 * split change neither, so the same configuration may resume.
 */
export function guardHoldout(lockFile: string, id: Omit<HoldoutRun, 'kind' | 'at'>): 'recorded' | 'resumed' {
  const runs = existsSync(lockFile)
    ? readFileSync(lockFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as HoldoutRun)
    : [];
  const cases = new Set(id.items.map((i) => i.ntsbNo));
  const other = runs.find((r) => r.configurationSha256 !== id.configurationSha256 && r.items.some((i) => cases.has(i.ntsbNo)));
  if (other) {
    throw new Error(
      `cases of this holdout were already judged in a holdout run under another configuration (${other.at}); a configuration chosen after seeing the holdout needs a fresh holdout with new cases (D3); nothing paid`,
    );
  }
  const labels = new Map(id.items.map((i) => [i.key, i.label]));
  for (const r of runs) {
    const changed = r.items.find((i) => labels.has(i.key) && labels.get(i.key) !== i.label);
    if (changed) throw new Error(`the label of holdout item ${changed.key} changed after the holdout ran (${r.at}); a relabelled holdout is no longer held out (D3); nothing paid`);
  }
  if (runs.some((r) => r.holdoutSha256 === id.holdoutSha256 && r.configurationSha256 === id.configurationSha256)) return 'resumed';
  const line: HoldoutRun = { kind: 'track-n-holdout-run', at: new Date().toISOString(), ...id };
  mkdirSync(dirname(lockFile), { recursive: true });
  appendFileSync(lockFile, `${JSON.stringify(line)}\n`);
  return 'recorded';
}

/** `judge` / `answerability`: plan, then (with `--confirm-cost`) judge every pair with per-attempt reservations. */
export async function judgeCommand(
  opts: CommandOptions & {
    set: 'calibration' | 'relevance' | 'answerability';
    split?: 'dev' | 'holdout';
    stage?: Stage;
    pools?: string;
    maxUsd?: number;
    concurrency?: number;
    maxEscalationShare?: number;
    allocation?: string;
    allocationUsd?: number;
    /** Judge only the first `maxPairs` pairs of the schedule (the canary). */
    maxPairs?: number;
    /** The holdout lock (tests only; runs use `HOLDOUT_LOCK_FILE`). */
    holdoutLock?: string;
  },
): Promise<number> {
  const { log } = opts;
  const ctx = await openContext(opts.config, log);
  try {
    if (ctx.problems.length > 0) throw new Error(`preflight failed; nothing paid:\n  ${ctx.problems.join('\n  ')}`);
    let items: PairPlanItem[];
    let pools: PoolFile | null = null;
    if (opts.set === 'calibration') {
      if (opts.split !== 'dev' && opts.split !== 'holdout') throw new Error('--split dev|holdout is required for calibration (dev first, holdout once; never both in one run)');
      const r = await calibrationSubjects(ctx, opts.split);
      if (r.problems.length > 0) throw new Error(`calibration inputs: ${r.problems.join('; ')}; nothing paid`);
      items = r.items;
    } else {
      if (!opts.pools) throw new Error('--pools is required');
      pools = readPools(opts.pools);
      if (pools.datasetSpecSha256 !== ctx.dataset.source.specSha256 || pools.generationId !== ctx.source.generationId) throw new Error('the pool file is of another dataset or generation; nothing paid');
      if (opts.set === 'relevance') {
        const r = await poolSubjects(ctx, pools);
        if (r.missing.length > 0) log(`warning: ${r.missing.length} pool case(s) without usable evidence are unknown: ${r.missing.slice(0, 5).join(', ')}`);
        const last = SCHEDULE.stages[opts.stage ?? 2];
        items = r.items.filter((i) => tierOf(i.priority) <= last);
      } else {
        const r = await answerabilitySubjects(ctx, pools);
        if (r.problems.length > 0) throw new Error(`answerability inputs: ${r.problems.slice(0, 5).join('; ')}; nothing paid`);
        items = r.items;
      }
    }
    if (opts.maxPairs !== undefined) items = [...items].sort(byPriority).slice(0, opts.maxPairs);
    const experiment = experimentIdentity(opts.set, experimentData(opts.set, ctx.dataset, ctx.calibration, pools) as ExperimentData);
    if (opts.set === 'calibration' && opts.split === 'holdout' && opts.confirm) {
      const lock = opts.holdoutLock ?? HOLDOUT_LOCK_FILE;
      log(`holdout lock ${lock}: ${guardHoldout(lock, holdoutIdentity(ctx.calibration, experiment)) === 'resumed' ? 'the same configuration resumes' : 'this run recorded; commit the file'}`);
    }
    const share = opts.maxEscalationShare ?? (opts.set === 'calibration' ? 1 : ASSUMPTIONS.escalationBound);
    if (opts.set !== 'calibration' && share > ASSUMPTIONS.escalationBound) throw new Error(`escalation is bounded at ${ASSUMPTIONS.escalationBound} of the pairs`);
    const limit = opts.maxUsd ?? (opts.set === 'calibration' ? RUN_LIMITS_USD.calibration : opts.set === 'relevance' ? RUN_LIMITS_USD.relevance : RUN_LIMITS_USD.answerability);
    const a = ctx.config.ai.anthropic.apiKey;
    const o = ctx.config.ai.openai.apiKey;
    const ingestUrl = ctx.config.databaseIngestUrl;
    return await runJudging(
      items,
      {
        set: opts.set,
        confirm: opts.confirm,
        limitUsd: limit,
        allocation: opts.allocation ? { name: opts.allocation, ...(opts.allocationUsd !== undefined ? { capUsd: opts.allocationUsd } : {}) } : null,
        maxEscalationShare: share,
        concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
        outDir: opts.outDir,
        reference: ctx.dataset.reference,
        schedule: scheduleInfo(items, opts.set === 'relevance' ? (opts.stage ?? 2) : null),
        experiment,
        log,
      },
      {
        callers: () => {
          if (!a || !o) throw new Error('ANTHROPIC_API_KEY and OPENAI_API_KEY are required (pass --keys-file)');
          return { judges: [createAnthropicJudge(JUDGE_A, { apiKey: a }), createOpenAIJudge(JUDGE_B, { apiKey: o })], adjudicator: createAnthropicJudge(ADJUDICATOR, { apiKey: a }) };
        },
        ledger: () => {
          if (!ingestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
          const ingest = createDb(ingestUrl, { max: 4, applicationName: 'aviation-eval-narrative-ledger' });
          return { gate: ledgerGates(ingest, ctx.config), close: () => closeDb(ingest) };
        },
      },
    );
  } finally {
    await closeContext(ctx);
  }
}

export { families };

// ---------------------------------------------------------------------------
// report (free)

const readJudgments = (file: string): { name: string; body: JudgmentFile } => {
  const body = JSON.parse(readFileSync(resolve(file), 'utf8')) as JudgmentFile;
  if (body.kind !== 'track-n-judgments') throw new Error(`${file} is not a Track N judgments file`);
  return { name: file, body };
};

/** The experiment data of a set: the dataset and pool file, or the frozen calibration with its criteria (identity.ts). */
export const experimentData = (set: JudgmentSet, d: NarrativeDataset, c: CalibrationDataset, pools: PoolFile | null): ExperimentData | null =>
  set === 'calibration'
    ? { calibrationVersion: c.version, labelsSha256: c.labels.sha256, criteriaSha256: CRITERIA_SHA256 }
    : pools
      ? { datasetSpecSha256: d.source.specSha256, poolVersion: pools.version }
      : null;

/** The checks of one record against the current data (identity.ts, "Joining records"); null when it passes. */
export function recordCheck(d: NarrativeDataset, c: CalibrationDataset, pools: PoolFile | null): (set: JudgmentSet, r: PairRecord) => string | null {
  const familiesById = new Map(families(d).map((f) => [f.id, f]));
  const itemsByKey = new Map(c.items.map((i) => [itemKey(i), i]));
  const poolsById = new Map((pools?.families ?? []).map((p) => [p.family, p]));
  const bundles = new Map((pools?.families ?? []).map((p) => [p.family, new Set(bundlePairs(p).map((x) => `${x.ntsbNo}|${bundleKeyOf(x.passages)}`))]));
  return (set, r) => {
    if (set === 'calibration') {
      const item = itemsByKey.get(`${r.kind}|${r.family}|${r.ntsbNo}|${r.bundleKey ?? ''}`);
      if (!item) return 'no frozen calibration item matches it';
      if (item.questionVersion !== r.questionVersion || item.rubricVersion !== r.rubricVersion) return 'its question or rubric version is not the frozen item\'s';
      if (item.case.fingerprint !== r.fingerprint) return 'its evidence fingerprint is not the frozen item\'s';
      return null;
    }
    const f = familiesById.get(r.family);
    if (!f) return 'unknown question family';
    if (f.questionVersion !== r.questionVersion || f.rubricVersion !== r.rubricVersion) return 'its question or rubric version is not the dataset\'s';
    const pool = poolsById.get(r.family);
    if (!pool) return 'its family is not in the pool file';
    if (set === 'relevance') {
      if (!pool.cases.some((x) => x.ntsbNo === r.ntsbNo)) return 'its case is not in the family\'s pool';
      const recorded = pool.fingerprints[r.ntsbNo];
      if (recorded !== undefined && recorded !== r.fingerprint) return 'its evidence fingerprint is not the one the pool recorded';
      return null;
    }
    if (!bundles.get(r.family)?.has(`${r.ntsbNo}|${r.bundleKey ?? ''}`)) return 'its bundle is not a delivered bundle of the pool';
    return null;
  };
}

const DIAGNOSTIC_NOTE =
  'Diagnostics, not validation: agreement between model judges (and with the adjudicator) measures their consistency, not their correctness; kappa 0.7 and agreement 0.8 are investigation thresholds.';

/** `report`: metrics and diagnostics from a pool file and judgment files (no target, nothing paid). Refuses incompatible files and conflicting records. */
// ---------------------------------------------------------------------------
// Allocation recovery

/** The run's evaluation reservations on the ledger (read-only; row-level security limits the ingest role to indexing and evaluation). */
export function ledgerRecovery(db: Db): RecoveryLedger {
  return {
    async runReservations(run) {
      const res = await db.execute(sql`
        SELECT id::text AS id, request_id, status, (usd * 1000000)::bigint AS usd_micros,
          (charged_usd * 1000000)::bigint AS charged_micros, uncertain, lease_expires_at
        FROM reservations
        WHERE category = 'evaluation' AND (request_id = ${run} OR starts_with(request_id, ${`${run}-`}))
        ORDER BY id`);
      return (res.rows as { id: string; request_id: string; status: string; usd_micros: string; charged_micros: string | null; uncertain: boolean | null; lease_expires_at: Date | string }[]).map(
        (r): RunReservation => ({
          id: r.id,
          requestId: r.request_id,
          status: r.status,
          reservedUsd: Number(r.usd_micros) / 1e6,
          chargedUsd: r.charged_micros === null ? null : Number(r.charged_micros) / 1e6,
          uncertain: r.uncertain,
          leaseExpiresAt: new Date(r.lease_expires_at),
        }),
      );
    },
  };
}

/**
 * `recover`: remove the lock an interrupted run left on its allocation, after reconciling
 * that run's ledger reservations and allocation charges (`recoverAllocation`). Without
 * `--confirm` it prints what it would reconcile and changes nothing.
 */
export async function recoverCommand(opts: CommandOptions & { allocation: string; run: string }): Promise<number> {
  const { log } = opts;
  const allocation = openAllocation(opts.outDir, opts.allocation, undefined);
  const ingestUrl = opts.config.databaseIngestUrl;
  if (!ingestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger the run reserved on)');
  const ingest = createDb(ingestUrl, { max: 1, applicationName: 'aviation-eval-narrative-recover' });
  try {
    const r = await recoverAllocation(allocation, opts.run, ledgerRecovery(ingest), { confirm: opts.confirm, spendLog: runSpendLog(opts.outDir, opts.run) });
    const h = r.holder;
    const l = r.ledger;
    log(`allocation ${r.allocation} is held by run ${r.run} (process ${h.pid ?? '?'} on ${h.host ?? '?'}, since ${h.at ?? '?'})`);
    log(
      `ledger: ${l.reservations} reservation(s) of the run: ${l.settled.count} settled (${usd(l.settled.usd)}), ${l.chargedInFull.count} charged in full as uncertain or expired (${usd(l.chargedInFull.usd)}), ` +
        `${l.openPastLease.count} open past their lease, which the ledger charges in full (${usd(l.openPastLease.usd)}); the run's ledger charges ${usd(l.chargedUsd)}`,
    );
    log(`allocation log: ${usd(r.loggedUsd)} for the run; reconciliation: ${r.appendedUsd > 0 ? `append ${usd(r.appendedUsd)}` : 'nothing to append'}${r.surplusUsd > 0 ? ` (the log holds ${usd(r.surplusUsd)} more than the ledger charged; kept)` : ''}`);
    if (r.recovered) log(`recovered: ${r.appendedUsd > 0 ? `appended ${usd(r.appendedUsd)} to ${allocation.log} and the run's spend log, ` : ''}lock removed; the allocation now counts ${usd(loggedSpendUsd(allocation.log))} of $${allocation.capUsd}`);
    else log('nothing changed: rerun with --confirm to append the reconciliation and remove the lock');
    return 0;
  } finally {
    await closeDb(ingest);
  }
}

export async function reportCommand(opts: { outDir: string; pools?: string; judgments: readonly string[]; log: (m: string) => void }): Promise<number> {
  const { log } = opts;
  const d = readDataset();
  const c = readCalibration();
  const pools = opts.pools ? readPools(opts.pools) : null;
  const files = opts.judgments.map(readJudgments);
  const joined = joinJudgments(
    files,
    (set) => {
      const data = experimentData(set, d, c, pools);
      return data ? experimentIdentity(set, data) : null;
    },
    recordCheck(d, c, pools),
  );
  if (joined.problems.length > 0) {
    for (const p of joined.problems.slice(0, 50)) log(`refused: ${p}`);
    log(`report refused: ${joined.problems.length} problem(s); no report written`);
    return 1;
  }
  const tagsOf = (family: string) => d.questions.find((q) => q.id === family)?.tags ?? [];
  const out: Record<string, unknown> = {
    kind: 'track-n-report',
    reference: d.reference,
    caveat: d.caveat,
    createdAt: new Date().toISOString(),
    git: gitState(),
    inputs: { files: files.map((f) => ({ file: f.name, set: f.body.set, run: f.body.run, records: f.body.records.length, stopped: f.body.stopped })), merged: joined.merged, superseded: joined.superseded },
  };
  const cal = joined.records.calibration;
  if (cal.length > 0) {
    const calTags = (family: string) => [...new Set(c.items.filter((i) => i.question === family).flatMap((i) => i.tags))];
    const report = calibrationReport(c.items, cal);
    out.calibration = { criteria: CALIBRATION_CRITERIA, report, agreement: { note: DIAGNOSTIC_NOTE, ...agreementReport(cal, calTags) } };
    log(`calibration: ${cal.length} pair records; holdout verdict ${report.verdict.status}${report.verdict.reasons.length > 0 ? ` (${report.verdict.reasons.slice(0, 3).join('; ')})` : ''}`);
  }
  const rel = joined.records.relevance;
  const ans = joined.records.answerability;
  if (rel.length > 0) {
    if (!pools) throw new Error('--pools is required to score relevance judgments');
    const labels = relevanceLabels(rel);
    const answer = answerabilityLabels(ans);
    const groups = questionGroups(d, labels);
    const values: QuestionValue[] = [];
    const diagnostics: Record<string, unknown>[] = [];
    const methods = [...POOL_RULE.methods];
    const metrics: CompareMetric[] = ['recallGate', 'p6', 'ndcg6', 'supported'];
    const diffs = new Map<string, DifferenceBounds[]>();
    for (const pool of pools.families) {
      const f = families(d).find((x) => x.id === pool.family);
      const l = labels.get(pool.family) ?? new Map();
      const ref = familyReference({ type: pool.type, cases: pool.cases, cohort: f?.cohort.cases ?? null }, l);
      const ansLabels = answer.get(pool.family) ?? new Map();
      const runs = scoreRuns(pool, ref, ansLabels);
      const mine = questionValues(pool, runs);
      values.push(...mine);
      for (let i = 0; i < methods.length; i += 1) {
        for (let j = i + 1; j < methods.length; j += 1) {
          const [a, b] = [methods[i] as string, methods[j] as string];
          for (const m of metrics) {
            const key = `${b} vs ${a}|${m}`;
            diffs.set(key, [...(diffs.get(key) ?? []), ...methodDifferences(pool, ref, ansLabels, mine, a, b, m)]);
          }
        }
      }
      diagnostics.push({ family: pool.family, coverage: judgedCoverage(pool, l, f?.cohort.cases ?? null), discovery: discoveryByDepth(pool, l), exclusive: methodExclusive(pool, l), tail: tailEstimate(pool, l) });
    }
    const boot = { resamples: 10_000, seed: 20261023 };
    const comparisons: Record<string, Record<string, unknown>> = {};
    for (const [key, list] of diffs) {
      const [pair, metric] = key.split('|') as [string, string];
      comparisons[pair] = { ...(comparisons[pair] ?? {}), [metric]: { ...compareMethods(list, (member) => groups.get(member) ?? member, boot), perQuestion: list } };
    }
    const flagged = (k: 'noPositivePossible' | 'abstention') => values.filter((v) => v[k]).map((v) => ({ member: v.member, method: v.method }));
    out.relevance = {
      poolVersion: pools.version,
      values,
      comparisons: { note: 'Improvement bounds per question (joint over shared unknowns for P@6 and supported P@6, cross-endpoint for nDCG@6), group-bootstrapped; a method is better only when the whole interval clears zero.', ...comparisons },
      noPositivePossible: flagged('noPositivePossible'),
      abstentions: flagged('abstention'),
      diagnostics,
      agreement: { note: DIAGNOSTIC_NOTE, ...agreementReport(rel, tagsOf) },
      discrepancies: discrepancies(d, rel),
      audit: auditSamples(rel, tagsOf),
    };
    log(`relevance: ${rel.length} pair records over ${pools.families.length} families (${joined.merged} duplicates merged, ${joined.superseded} superseded)`);
  }
  if (ans.length > 0) out.answerability = { agreement: { note: DIAGNOSTIC_NOTE, ...agreementReport(ans, tagsOf) }, audit: auditSamples(ans, tagsOf) };
  const file = writeJson(opts.outDir, `narrative-report-${stamp(new Date())}.json`, out);
  log(`report: ${file}`);
  return 0;
}
