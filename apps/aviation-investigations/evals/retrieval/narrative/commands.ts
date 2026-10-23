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
 * settles; each command appends to `<out-dir>/spend.jsonl` and stops before a reservation
 * that would take that log above the command's limit (`RUN_LIMITS_USD`, or `--max-usd`)
 * or above what remains of the monthly indexing and evaluation allowance.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
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
import { DEFAULT_CALIBRATION, DEFAULT_NARRATIVE_DATASET } from './build.js';
import { CalibrationDatasetSchema, calibrationProblems, controlEvidence, type CalibrationDataset } from './calibration.js';
import { attemptReserveUsd, createAnthropicJudge, createOpenAIJudge, type JudgeCaller } from './clients.js';
import { ADJUDICATOR, DEFAULT_CONCURRENCY, JUDGE_A, JUDGE_B, JUDGE_TIMEOUT_MS, RUN_LIMITS_USD } from './config.js';
import { NarrativeDatasetSchema, families, narrativeDatasetProblems, type NarrativeDataset, type NarrativeItem } from './dataset.js';
import { CASE_TOKEN_BUDGET, bundleFingerprint, fingerprint, loadCaseEvidence, planChunks, type CaseEvidence, type DeliveredPassage } from './evidence.js';
import { AttemptSender, JudgmentCache, answerabilitySubject, judgePairs, relevanceSubject, type FamilyRef, type PairPlanItem, type PairRecord } from './judging.js';
import {
  ASSUMPTIONS,
  addRuns,
  adjudicationBlockTokens,
  caseCost,
  expectedOutputs,
  likelyPool,
  measureAnswerability,
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
} from './plan.js';
import { POOL_RULE, buildPools, bundlePairs, casePriority, indexCohort, poolFileVersion, type FamilyPool, type PoolFile } from './pool.js';
import { NARRATIVE_PARAPHRASES, NARRATIVE_QUESTIONS } from './questions.js';
import {
  agreementReport,
  auditSamples,
  answerabilityLabels,
  calibrationReport,
  compareMethods,
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
import { specSha256, sha256 } from './spec.js';

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

export async function planCommand(opts: CommandOptions & { samples: Samples; broadSample: { bm25: number; lure: number; random: number } }): Promise<number> {
  const { log } = opts;
  const ctx = await openContext(opts.config, log);
  try {
    const d = ctx.dataset;
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
    for (const item of ctx.calibration.items) {
      const e = item.case.source === 'synthetic' ? controlEvidence(ctx.calibration.records[item.case.ntsbNo] as never) : loaded.evidence.get(item.case.ntsbNo);
      const q = ctx.calibration.questions[item.question];
      if (e && q) calMeasured.push(await measureCase(haiku, item.question, q, e));
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
    const costOf = (m: Measured) => caseCost(m, prefixes.get(m.family) ?? defaultPrefix, block);
    // (b) the full pooled run: per family, the mean cost of its sampled cases scaled to its estimated pairs.
    const familyRuns = (s: Samples, k: 'mean' | 'max', escalation: number): RunCost[] =>
      estimates[s].map((e) => scaleRun(measured.filter((m) => m.family === e.family && !m.uncovered).map(costOf), e[k], escalation));
    const answerRuns = (s: Samples, k: 'mean' | 'max', escalation: number): RunCost[] =>
      estimates[s].map((e) => scaleRun(ansMeasured.filter((m) => m.family === e.family).map(costOf), e.answerabilityPairs[k], escalation));
    const relevance = addRuns(familyRuns(opts.samples, 'mean', ASSUMPTIONS.escalationExpected));
    const relevanceMax = addRuns(familyRuns(opts.samples, 'max', ASSUMPTIONS.escalationExpected));
    const answerability = addRuns(answerRuns(opts.samples, 'mean', ASSUMPTIONS.escalationExpected));
    const alternative: Samples = opts.samples === 3 ? 1 : 3;
    const relevanceAlt = addRuns(familyRuns(alternative, 'mean', ASSUMPTIONS.escalationExpected));
    const answerabilityAlt = addRuns(answerRuns(alternative, 'mean', ASSUMPTIONS.escalationExpected));
    // (a) the calibration run: every item once, every disagreement adjudicated.
    const calibration = scaleRun(calMeasured.map((m) => caseCost(m, defaultPrefix, block)), ctx.calibration.items.length, ASSUMPTIONS.calibrationDisagreement, 1);
    const poolBuilding = scope.upperUsd + (emb.inputTokens * emb.usdPerMillionTokens) / 1e6;
    const pooled = relevance.usd.total + answerability.usd.total + poolBuilding;
    const pooledBound = relevance.totalAtBoundUsd + answerability.totalAtBoundUsd + poolBuilding;
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
      const run = scaleRun(mine.filter((m) => !m.uncovered).map(costOf), e.mean, ASSUMPTIONS.escalationExpected);
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
      samples: opts.samples,
      poolBuilding: { scope, embeddings: { tokens: emb.inputTokens, usd: (emb.inputTokens * emb.usdPerMillionTokens) / 1e6, reserveUsd: emb.reserveUsd }, usd: poolBuilding },
      pools: { estimates: estimates[opts.samples], relevancePairs: { mean: sum(opts.samples, 'mean'), max: sum(opts.samples, 'max') }, answerabilityPairs: { mean: pairsAns(opts.samples, 'mean'), max: pairsAns(opts.samples, 'max') } },
      tokens,
      chunked: { sampled: measured.length, chunked: chunked.length, uncovered: measured.filter((m) => m.uncovered).length, cases: chunked.map((m) => ({ ntsbNo: m.ntsbNo, family: m.family, caseTokens: m.caseTokens, chunks: m.chunks })) },
      perFamily,
      sensitivity,
      costs: {
        calibration,
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
          concurrentLargestUsd: (DEFAULT_CONCURRENCY * (attemptReserveUsd(JUDGE_A, tokens.relevanceClaude.max) + attemptReserveUsd(JUDGE_B, tokens.relevanceOpenai.max))),
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
    line(`(b) relevance, ${opts.samples} scope sample(s)`, relevance);
    line('    with the largest pools', relevanceMax);
    line('    answerability', answerability);
    log(`  pool building (scope samples and embeddings): ${usd(poolBuilding)}`);
    log(`  (b) full pooled run: expected ${usd(pooled)}; at the escalation bound ${usd(pooledBound)}`);
    log(`  with ${alternative} scope sample(s) instead: relevance ${usd(relevanceAlt.usd.total)}, answerability ${usd(answerabilityAlt.usd.total)}`);
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

/** Logged spend of a command's spend log, and the limit check before anything is reserved. */
function spentOf(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .reduce((n, l) => n + (JSON.parse(l) as { chargedUsd: number }).chargedUsd, 0);
}

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
export async function poolsCommand(opts: CommandOptions & { samples: Samples; maxUsd?: number }): Promise<number> {
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
    const spendLog = resolve(opts.outDir, 'spend.jsonl');
    const limit = opts.maxUsd ?? RUN_LIMITS_USD.pools;
    if (spentOf(spendLog) + inventory.reserveUsd + emb.reserveUsd > limit + 1e-12) throw new Error(`the pool reservations would exceed the limit of $${limit}; nothing sent`);
    if (!ctx.config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
    const ingest = createDb(ctx.config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-narrative-ledger' });
    let run: ScopeRun;
    const purpose = `eval-10c2-pools-${stamp(new Date())}`;
    try {
      const gate = createLedgerSpendGate(ingest, { budgets: ctx.config.ai.budgets, provider: 'anthropic', model: a.scopeModel, stage: 'scope' });
      run = await runScopeSamples(caller, gate, items, { samples: opts.samples, retries: 1, maxUsd: limit - spentOf(spendLog), purpose, log });
    } finally {
      await closeDb(ingest);
    }
    mkdirSync(opts.outDir, { recursive: true });
    appendFileSync(spendLog, `${JSON.stringify({ at: new Date().toISOString(), run: purpose, purpose: 'scope', provider: 'anthropic', model: a.scopeModel, reservedUsd: run.reservedUsd, chargedUsd: run.chargedUsd })}\n`);
    const { embedder, billed } = await embedPlan(emb, { fake: false, config: ctx.config, purpose, log });
    appendFileSync(spendLog, `${JSON.stringify({ at: new Date().toISOString(), run: purpose, purpose: 'embed', provider: 'openai', model: emb.model, reservedUsd: emb.reserveUsd, chargedUsd: billed.usd })}\n`);
    const texts = new Map<string, string[]>();
    for (const q of d.questions) texts.set(q.id, run.samples.filter((s) => s.id === q.id).sort((x, y) => x.sample - y.sample).map((s) => s.keywordText));
    const pools = await buildPools(
      { es: ctx.es, dataset: ctx.run.target, passagesIndex: ctx.run.index, casesIndex: ctx.casesIndex, eventAircraftQualification: ctx.run.contract.eventAircraftQualification },
      d,
      embedder,
      methods,
      texts,
      log,
    );
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
    await closeContext(ctx);
  }
}

export function readPools(file: string): PoolFile {
  const p = JSON.parse(readFileSync(resolve(file), 'utf8')) as PoolFile;
  if (p.kind !== 'track-n-pools') throw new Error(`${file} is not a Track N pool file`);
  const { version, ...body } = p;
  if (poolFileVersion(body) !== version) throw new Error(`${file}: the pool version does not match its content`);
  return p;
}

const refOf = (q: { question: string; rubric: NarrativeItem['rubric']; questionVersion: string; rubricVersion: string }, family: string): FamilyRef => ({
  family,
  question: q.question,
  rubric: q.rubric,
  questionVersion: q.questionVersion,
  rubricVersion: q.rubricVersion,
});

/** The relevance pairs of a pool file, in priority order (bundle cases first). */
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
        items.push({ subject: relevanceSubject(refOf(f, f.id), e, planChunks(e), fingerprint(e)), priority: casePriority(c, pool.type) });
      }
    }
    return { items: items.sort((x, y) => (x.subject.ref.family < y.subject.ref.family ? -1 : x.subject.ref.family > y.subject.ref.family ? 1 : 0)), missing: [...loaded.missing, ...loaded.integrity.map((x) => x.ntsbNo)] };
  } finally {
    await client.end();
  }
}

/** The calibration pairs (one split or both), each case's evidence checked against the fingerprint its label was made against. */
export async function calibrationSubjects(ctx: NarrativeContext, split: 'dev' | 'holdout' | 'all'): Promise<{ items: PairPlanItem[]; problems: string[] }> {
  const cal = ctx.calibration;
  const chosen = cal.items.filter((i) => split === 'all' || i.split === split);
  const client = new pg.Client({ connectionString: ctx.config.databaseUrl as string, application_name: 'aviation-eval-narrative-judge' });
  await client.connect();
  try {
    const loaded = await loadCaseEvidence(client, ctx.source.generationId, chosen.filter((i) => i.case.source === 'canonical').map((i) => i.case.ntsbNo));
    const problems: string[] = [];
    const items: PairPlanItem[] = [];
    for (const i of chosen) {
      const e = i.case.source === 'synthetic' ? controlEvidence(cal.records[i.case.ntsbNo] as never) : loaded.evidence.get(i.case.ntsbNo);
      const q = cal.questions[i.question];
      if (!e || !q) {
        problems.push(`${i.id}: no evidence or question`);
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
      const best = Math.min(...x.runs.map((r) => r.caseRank));
      items.push({ subject: answerabilitySubject(refOf(f, f.id), e, passages, bundleFingerprint(e.ntsbNo, e.event, e.aircraft, passages)), priority: best });
    }
    return { items, problems };
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

/**
 * The paid part of `judge` and `answerability`: without `confirm` it prints the plan and
 * creates nothing (no client, no ledger connection); with it, every pair is judged with
 * per-attempt reservations, and a budget stop ends the run with its records kept.
 */
export async function runJudging(
  items: readonly PairPlanItem[],
  opts: { set: 'calibration' | 'relevance' | 'answerability'; confirm: boolean; limitUsd: number; maxEscalationShare: number; concurrency: number; outDir: string; reference: string; log: (m: string) => void },
  deps: JudgingDeps,
): Promise<number> {
  const { log } = opts;
  log(`${opts.set}: ${items.length} pairs; judges ${JUDGE_A.model} and ${JUDGE_B.model}, adjudicator ${ADJUDICATOR.model} (at most ${Math.floor(opts.maxEscalationShare * items.length)} escalations); limit $${opts.limitUsd}`);
  if (!opts.confirm) {
    log('nothing sent: run `plan` for the cost, then this command with --confirm-cost');
    return 0;
  }
  const callers = deps.callers();
  const ledger = deps.ledger();
  const runId = `eval-10c2-${opts.set}-${stamp(new Date())}`;
  try {
    const sender = new AttemptSender({ gate: ledger.gate, limitUsd: opts.limitUsd, spendLog: resolve(opts.outDir, 'spend.jsonl'), run: runId }, JUDGE_TIMEOUT_MS);
    const cache = new JudgmentCache(resolve(opts.outDir, 'cache.jsonl'));
    const { records, stopped } = await judgePairs(items, { judges: callers.judges, adjudicator: callers.adjudicator, sender, cache, concurrency: opts.concurrency, maxEscalationShare: opts.maxEscalationShare, log: (m) => console.error(m) });
    const file = writeJson(opts.outDir, `narrative-judgments-${opts.set}-${stamp(new Date())}.json`, { kind: 'track-n-judgments', set: opts.set, reference: opts.reference, run: runId, git: gitState(), stopped, records });
    log(`${records.length} pair records; spend ${usd(sender.spentUsd)}; ${stopped ? `stopped: ${stopped}; ` : ''}${file}`);
    return stopped ? 1 : 0;
  } finally {
    await ledger.close();
  }
}

/** `judge` / `answerability`: plan, then (with `--confirm-cost`) judge every pair with per-attempt reservations. */
export async function judgeCommand(
  opts: CommandOptions & { set: 'calibration' | 'relevance' | 'answerability'; split: 'dev' | 'holdout' | 'all'; pools?: string; maxUsd?: number; concurrency?: number; maxEscalationShare?: number },
): Promise<number> {
  const { log } = opts;
  const ctx = await openContext(opts.config, log);
  try {
    if (ctx.problems.length > 0) throw new Error(`preflight failed; nothing paid:\n  ${ctx.problems.join('\n  ')}`);
    let items: PairPlanItem[];
    if (opts.set === 'calibration') {
      const r = await calibrationSubjects(ctx, opts.split);
      if (r.problems.length > 0) throw new Error(`calibration inputs: ${r.problems.join('; ')}; nothing paid`);
      items = r.items;
    } else {
      if (!opts.pools) throw new Error('--pools is required');
      const pools = readPools(opts.pools);
      if (pools.datasetSpecSha256 !== ctx.dataset.source.specSha256 || pools.generationId !== ctx.source.generationId) throw new Error('the pool file is of another dataset or generation; nothing paid');
      if (opts.set === 'relevance') {
        const r = await poolSubjects(ctx, pools);
        if (r.missing.length > 0) log(`warning: ${r.missing.length} pool case(s) without usable evidence are unknown: ${r.missing.slice(0, 5).join(', ')}`);
        items = r.items;
      } else {
        const r = await answerabilitySubjects(ctx, pools);
        if (r.problems.length > 0) throw new Error(`answerability inputs: ${r.problems.slice(0, 5).join('; ')}; nothing paid`);
        items = r.items;
      }
    }
    const share = opts.maxEscalationShare ?? (opts.set === 'calibration' ? 1 : ASSUMPTIONS.escalationBound);
    if (opts.set !== 'calibration' && share > ASSUMPTIONS.escalationBound) throw new Error(`escalation is bounded at ${ASSUMPTIONS.escalationBound} of the pairs`);
    const limit = opts.maxUsd ?? (opts.set === 'calibration' ? RUN_LIMITS_USD.calibration : opts.set === 'relevance' ? RUN_LIMITS_USD.relevance : RUN_LIMITS_USD.answerability);
    const a = ctx.config.ai.anthropic.apiKey;
    const o = ctx.config.ai.openai.apiKey;
    const ingestUrl = ctx.config.databaseIngestUrl;
    return await runJudging(
      items,
      { set: opts.set, confirm: opts.confirm, limitUsd: limit, maxEscalationShare: share, concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY, outDir: opts.outDir, reference: ctx.dataset.reference, log },
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

interface JudgmentFile {
  kind: 'track-n-judgments';
  set: 'calibration' | 'relevance' | 'answerability';
  records: PairRecord[];
}

const readJudgments = (file: string): JudgmentFile => {
  const j = JSON.parse(readFileSync(resolve(file), 'utf8')) as JudgmentFile;
  if (j.kind !== 'track-n-judgments') throw new Error(`${file} is not a Track N judgments file`);
  return j;
};

/** `report`: metrics and diagnostics from a pool file and judgment files (no target, nothing paid). */
export async function reportCommand(opts: { outDir: string; pools?: string; judgments: readonly string[]; log: (m: string) => void }): Promise<number> {
  const { log } = opts;
  const d = readDataset();
  const files = opts.judgments.map(readJudgments);
  const records = (set: JudgmentFile['set']) => files.filter((f) => f.set === set).flatMap((f) => f.records);
  const tagsOf = (family: string) => d.questions.find((q) => q.id === family)?.tags ?? [];
  const out: Record<string, unknown> = { kind: 'track-n-report', reference: d.reference, caveat: d.caveat, createdAt: new Date().toISOString(), git: gitState() };
  const cal = records('calibration');
  if (cal.length > 0) {
    const c = readCalibration();
    const calTags = (family: string) => [...new Set(c.items.filter((i) => i.question === family).flatMap((i) => i.tags))];
    out.calibration = { report: calibrationReport(c.items, cal), agreement: agreementReport(cal, calTags) };
    log(`calibration: ${cal.length} pair records`);
  }
  const rel = records('relevance');
  if (rel.length > 0) {
    if (!opts.pools) throw new Error('--pools is required to score relevance judgments');
    const pools = readPools(opts.pools);
    const labels = relevanceLabels(rel);
    const answer = answerabilityLabels(records('answerability'));
    const groups = questionGroups(d, labels);
    const values: QuestionValue[] = [];
    const diagnostics: Record<string, unknown>[] = [];
    for (const pool of pools.families) {
      const f = families(d).find((x) => x.id === pool.family);
      const l = labels.get(pool.family) ?? new Map();
      const ref = familyReference({ type: pool.type, cases: pool.cases, cohort: f?.cohort.cases ?? null }, l);
      const runs = scoreRuns(pool, ref, answer.get(pool.family) ?? new Map());
      values.push(...questionValues(pool, runs));
      diagnostics.push({ family: pool.family, coverage: judgedCoverage(pool, l, f?.cohort.cases ?? null), discovery: discoveryByDepth(pool, l), exclusive: methodExclusive(pool, l), tail: tailEstimate(pool, l) });
    }
    const boot = { resamples: 10_000, seed: 20261023 };
    const methods = [...POOL_RULE.methods];
    const comparisons: Record<string, unknown> = {};
    for (let i = 0; i < methods.length; i += 1) {
      for (let j = i + 1; j < methods.length; j += 1) {
        const [a, b] = [methods[i] as string, methods[j] as string];
        comparisons[`${b} vs ${a}`] = Object.fromEntries((['recallGate', 'p6', 'ndcg6', 'supported'] as const).map((m) => [m, compareMethods(values, (member) => groups.get(member) ?? member, a, b, m, boot)]));
      }
    }
    const flagged = (k: 'noPositivePossible' | 'abstention') => values.filter((v) => v[k]).map((v) => ({ member: v.member, method: v.method }));
    out.relevance = { poolVersion: pools.version, values, comparisons, noPositivePossible: flagged('noPositivePossible'), abstentions: flagged('abstention'), diagnostics, agreement: agreementReport(rel, tagsOf), discrepancies: discrepancies(d, rel), audit: auditSamples(rel, tagsOf) };
    log(`relevance: ${rel.length} pair records over ${pools.families.length} families`);
  }
  const ans = records('answerability');
  if (ans.length > 0) out.answerability = { agreement: agreementReport(ans, tagsOf), audit: auditSamples(ans, tagsOf) };
  const file = writeJson(opts.outDir, `narrative-report-${stamp(new Date())}.json`, out);
  log(`report: ${file}`);
  return 0;
}
