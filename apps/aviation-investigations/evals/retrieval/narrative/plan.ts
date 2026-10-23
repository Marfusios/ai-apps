/**
 * The Track N dry run (task 10c protocol v4, section 7): an inventory of what the paid
 * phase would send and what it would cost, computed without paying anything.
 *
 * **Free inputs only.** The dataset and calibration files; the target's identity and
 * indices (Elasticsearch read key); the sampled cases' complete records (PostgreSQL app
 * role, one read-only snapshot); Anthropic's token counter, which is free and generates
 * nothing, for the scope stage and the Claude judges' requests. OpenAI request sizes are
 * local `o200k_base` estimates with a margin (`estimateOpenAIInput`), because whether its
 * counting endpoint is billed is not documented. No query is embedded and no model
 * generates anything.
 *
 * **Inventory.**
 * - Pool building: the scope-stage samples (members x samples, counted) and the query
 *   embeddings (local count), with cost and reservations.
 * - Pool sizes: exact for bounded cohorts; for broad questions an estimate from the
 *   production retrievers' runs on phase A's 21 development questions with their cached
 *   inputs (`PRODUCTION_*`: the union of the three versions' first 100 cases, what a
 *   paraphrase adds, the delivered pairs per question, the mapping diagnostic's cases)
 *   plus the related positives, hard negatives and tail samples of the rule; mean and
 *   largest. A diagnostic with a frozen scope output counts its distinct keyword texts
 *   as its samples.
 * - Judge inputs: every bounded-cohort case and every calibration item exactly, and for
 *   each broad question a sample of its likely pool (first cases by passage BM25 on the
 *   question, lure cases, random cohort cases), rendered as a judge reads them and
 *   counted; long cases chunked as the judges chunk them.
 * - Costs: each sampled case's calls (both judges; the adjudicator's two steps for the
 *   escalated share) with the family prefix cached, the expected output
 *   (`EXPECTED_OUTPUT`), and 5% of judge calls retried; scaled to the estimated pairs.
 *   Reservations are every attempt at its caps.
 */
import type { Client } from '@elastic/elasticsearch';
import type pg from 'pg';
import { llmPrice } from '../../../server/ai/pricing.js';
import { countTokens } from '../../../server/ai/tokens.js';
import { compileFilters } from '../../../server/search/filters.js';
import { assertCompleteResponse, keywordChannelBody, toHit } from '../../../server/search/hybrid.js';
import { uniqueTop } from '../metrics.js';
import { controlEvidence, resolveRecord, seededSample, type CalibrationDataset } from './calibration.js';
import { attemptReserveUsd, estimateOpenAIInput, type JudgeCaller, type JudgeModelConfig } from './clients.js';
import { ADJUDICATOR, EXPECTED_OUTPUT, JUDGE_A, JUDGE_B } from './config.js';
import { families, membersOf, type NarrativeDataset, type NarrativeItem } from './dataset.js';
import { loadCaseEvidence, planChunks, renderBundleCase, type CaseEvidence, type DeliveredPassage } from './evidence.js';
import { adjudicationBlock, answerabilityRequest, chunkRequest, consolidateRequest, relevanceRequest, type JudgeRequest } from './prompts.js';
import { POOL_RULE, SCHEDULE, bundlePairs, casePriority, lureCases, tierOf, type FamilyPool, type PoolFile } from './pool.js';
import { bundleKeyOf, type PairRecord } from './judging.js';
import type { Rubric } from './spec.js';

/*
 * Measured on 2026-10-23 (round 4) with the pool builder itself (`poolRun`: the
 * production retrievers retrieval.v1, retrieval.v2 and retrieval.v2-nf) on phase A's 21
 * development questions, their cached scope samples (task 10d) and task 10e's saved
 * query vectors, fixed filters, read-only against the shared development target. Every
 * one of the 189 runs reproduced task 10e's production run (first 100 cases and bundle);
 * no run needed the mapping. Per question, by scope samples (1: the first only).
 */
/** Unique cases in the union of the three versions' first 100. */
export const PRODUCTION_UNION = Object.freeze({ 1: { mean: 111.5, max: 133 }, 3: { mean: 126.3, max: 163 } });
/** Cases a paraphrase adds to its original's union (the six dev paraphrase pairs). */
export const PRODUCTION_PARAPHRASE_ADDS = Object.freeze({ 1: { mean: 27.7, max: 52 }, 3: { mean: 32.3, max: 73 } });
/** Distinct delivered (case, passages) pairs per question over the three versions and the samples. */
export const PRODUCTION_BUNDLE_PAIRS = Object.freeze({ 1: { mean: 8.7, max: 11 }, 3: { mean: 11.4, max: 16 } });
/** The union of the versions' first 20 unique cases (stage 1 of a broad question: its delivered and first-20 cases). */
export const PRODUCTION_TOP20 = Object.freeze({ 1: { mean: 26.2, max: 33 }, 3: { mean: 30, max: 41 } });
/** What a paraphrase adds to the first-20 union. */
export const PRODUCTION_PARAPHRASE_ADDS_TOP20 = Object.freeze({ 1: { mean: 11.2, max: 19 }, 3: { mean: 13.5, max: 27 } });
/**
 * The mapping diagnostic per question (`POOL_RULE.mappingDiagnostic`): distinct delivered
 * (case, passages) bundles, every one of them a case outside the first 20 (so a stage 1
 * relevance pair), and how many of those cases were outside the union of the first 100
 * (new pool cases). Every forced case was mapped.
 */
export const PRODUCTION_MAPPING_DIAGNOSTIC = Object.freeze({
  1: { delivered: { mean: 3.2, max: 4 }, newCases: { mean: 3.0, max: 4 } },
  3: { delivered: { mean: 5.4, max: 10 }, newCases: { mean: 3.9, max: 7 } },
});

export const ASSUMPTIONS = Object.freeze({
  escalationExpected: 0.15,
  escalationBound: 0.25,
  /** The calibration run adjudicates every disagreement; the expected share of disagreements. */
  calibrationDisagreement: 0.25,
  /** Judge calls retried after an invalid output. */
  invalidRetryShare: 0.05,
});

export type Samples = 1 | 3;

export interface FamilyPoolEstimate {
  family: string;
  role: NarrativeItem['role'];
  type: NarrativeItem['type'];
  members: number;
  /** Relevance pairs; exact for a bounded cohort. */
  mean: number;
  max: number;
  /** Stage 1 of the schedule (pool.ts `SCHEDULE`): every bounded-cohort case, or a broad question's delivered and first-20 cases, and the mapping diagnostic's cases. */
  stage1: { mean: number; max: number };
  /** Every delivered bundle: the retrieval runs' and the mapping diagnostic's. */
  answerabilityPairs: { mean: number; max: number };
  /** Of those, the mapping diagnostic's (its stage 1 relevance pairs are as many). */
  mappingDiagnostic: { mean: number; max: number };
}

/** The scope samples a family's members run with: a diagnostic's distinct frozen keyword texts, otherwise the plan's samples. */
const samplesOf = (f: NarrativeItem, samples: Samples): Samples => {
  const frozen = f.diagnostic?.scope?.samples;
  if (!frozen) return samples;
  return new Set(frozen.map((s) => s.keywordText)).size === 1 ? 1 : 3;
};

/** Pool size estimates per family (module comment). */
export function poolEstimates(d: NarrativeDataset, samples: Samples): FamilyPoolEstimate[] {
  return families(d).map((f) => {
    const members = membersOf(d, f.id);
    const paraphrases = members.length - 1;
    const s = samplesOf(f, samples);
    const m = PRODUCTION_MAPPING_DIAGNOSTIC[s];
    const mapping = { mean: m.delivered.mean * members.length, max: m.delivered.max * members.length };
    const pairs = { mean: PRODUCTION_BUNDLE_PAIRS[s].mean * members.length + mapping.mean, max: PRODUCTION_BUNDLE_PAIRS[s].max * members.length + mapping.max };
    const base = { family: f.id, role: f.role, type: f.type, members: members.length, answerabilityPairs: pairs, mappingDiagnostic: mapping };
    // A bounded cohort is judged whole in stage 1: the mapping diagnostic's cases are among its cases.
    if (f.type === 'bounded-cohort') return { ...base, mean: f.cohort.size, max: f.cohort.size, stage1: { mean: f.cohort.size, max: f.cohort.size } };
    const extra = POOL_RULE.hardNegatives + POOL_RULE.tail.near + POOL_RULE.tail.far;
    const capped = (x: number) => Math.min(f.cohort.size, Math.round(x));
    return {
      ...base,
      mean: capped(PRODUCTION_UNION[s].mean + paraphrases * PRODUCTION_PARAPHRASE_ADDS[s].mean + f.relatedPositives.length / 2 + extra + m.newCases.mean * members.length),
      max: capped(PRODUCTION_UNION[s].max + paraphrases * PRODUCTION_PARAPHRASE_ADDS[s].max + f.relatedPositives.length + extra + m.newCases.max * members.length),
      stage1: {
        mean: capped(PRODUCTION_TOP20[s].mean + paraphrases * PRODUCTION_PARAPHRASE_ADDS_TOP20[s].mean + mapping.mean),
        max: capped(PRODUCTION_TOP20[s].max + paraphrases * PRODUCTION_PARAPHRASE_ADDS_TOP20[s].max + mapping.max),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Prices and calls

/**
 * USD per token, from the repository price rows (`server/ai/pricing.ts`) with no override:
 * the estimate and the ledger settlement use the same prices. Claude Sonnet 5.5 cache
 * reads are $0.10 per million (0.05 times its input price), as Anthropic's pricing page
 * (platform.claude.com/docs/en/about-claude/pricing) listed on 2026-10-23.
 */
export function rates(model: string): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  const p = llmPrice(model);
  return { input: p.input / 1e6, output: p.output / 1e6, cacheWrite: p.cacheWrite / 1e6, cacheRead: p.cacheRead / 1e6 };
}

/** One call's expected cost: its family prefix read from the cache, the rest at the input rate, the expected output. */
export function callUsd(model: string, input: number, prefix: number, output: number): number {
  const r = rates(model);
  const p = Math.min(prefix, input);
  return (input - p) * r.input + p * r.cacheRead + output * r.output;
}

/** The measured judge inputs of one case: each call's input tokens (one call, or each part and the consolidation). */
export interface Measured {
  ntsbNo: string;
  family: string;
  /** Claude tokens per call (provider count; Haiku and Sonnet count alike, checked on a subset). */
  claude: number[];
  /** Local OpenAI estimate per call. */
  openai: number[];
  /** cl100k tokens of the rendered case. */
  caseTokens: number;
  chunks: number;
  uncovered: boolean;
}

/** Count a request with the provider (free), retrying a transient failure. */
export async function countRequest(caller: JudgeCaller, req: JudgeRequest): Promise<number> {
  for (let i = 0; ; i += 1) {
    try {
      return await caller.inputTokens(req, 30_000);
    } catch (err) {
      if (i >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1_500 * (i + 1)));
    }
  }
}

/** Every relevance call a judge makes for a case, rendered (a whole case, or each part with full notes and the consolidation). */
export function relevanceCalls(q: { question: string; rubric: Rubric }, e: CaseEvidence): { requests: JudgeRequest[]; chunks: number; uncovered: boolean; caseTokens: number } {
  const plan = planChunks(e);
  if (plan.uncovered !== null) return { requests: [], chunks: 0, uncovered: true, caseTokens: plan.tokens };
  if (plan.chunks.length === 1) return { requests: [relevanceRequest(q, e)], chunks: 1, uncovered: false, caseTokens: plan.tokens };
  const notes = 'n'.repeat(1_100);
  const parts = plan.chunks.map((pieces, i) => chunkRequest(q, e, pieces, i + 1, plan.chunks.length, notes));
  const summaries = plan.chunks.map((_, i) => ({ part: i + 1, grade: 1 as const, evidence: [{ source: 'S1', quote: 'q '.repeat(120) }, { source: 'S2', quote: 'q '.repeat(120) }], notes }));
  return { requests: [...parts, consolidateRequest(q, e, summaries)], chunks: plan.chunks.length, uncovered: false, caseTokens: plan.tokens };
}

export async function measureCase(claude: JudgeCaller, family: string, q: { question: string; rubric: Rubric }, e: CaseEvidence): Promise<Measured> {
  const c = relevanceCalls(q, e);
  const counts: number[] = [];
  for (const r of c.requests) counts.push(await countRequest(claude, r));
  return { ntsbNo: e.ntsbNo, family, claude: counts, openai: c.requests.map(estimateOpenAIInput), caseTokens: c.caseTokens, chunks: c.chunks, uncovered: c.uncovered };
}

/** The adjudication block of two typical verdicts (instructions and quotes), Claude tokens estimated at 1.6 per cl100k token. */
export function adjudicationBlockTokens(): number {
  const v = { grade: 'relevant' as const, evidence: [{ source: 'S1', quote: 'q '.repeat(90) }, { source: 'S2', quote: 'q '.repeat(90) }], absent: null, rationale: 'r '.repeat(90) };
  return Math.round(countTokens(adjudicationBlock(v, [v, { ...v, grade: 'partial' }])) * 1.6);
}

export interface CaseCost {
  judgeA: number;
  judgeB: number;
  /** The adjudicator's two steps, if this case escalates. */
  adjudication: number;
  /** Every call at its caps (the reservations): judges, and adjudication if it escalates. */
  worstJudges: number;
  worstAdjudication: number;
  calls: { judgeA: number; judgeB: number; adjudication: number };
}

/** The expected and worst-case cost of judging one measured case (module comment). */
/** Expected output tokens per call (visible plus thinking or reasoning) of each role. */
export const expectedOutputs = (reasoning?: number) => ({
  a: EXPECTED_OUTPUT['judge-a'].visible + (reasoning ?? EXPECTED_OUTPUT['judge-a'].reasoning),
  b: EXPECTED_OUTPUT['judge-b'].visible + (reasoning ?? EXPECTED_OUTPUT['judge-b'].reasoning),
  adj: EXPECTED_OUTPUT.adjudicator.visible + EXPECTED_OUTPUT.adjudicator.reasoning,
});

export function caseCost(m: Measured, prefix: { claude: number; openai: number }, adjudicationBlock: number, out = expectedOutputs()): CaseCost {
  const outA = out.a;
  const outB = out.b;
  const outAdj = out.adj;
  const judgeA = m.claude.reduce((n, input) => n + callUsd(JUDGE_A.model, input, prefix.claude, outA), 0);
  const judgeB = m.openai.reduce((n, input) => n + callUsd(JUDGE_B.model, input, prefix.openai, outB), 0);
  const r = rates(ADJUDICATOR.model);
  const last = m.claude[m.claude.length - 1] ?? 0;
  // First step: graded like a judge, with the case (or the consolidation) written to the cache; second: that prefix read back, plus the adjudication block.
  const first = m.claude.reduce((n, input) => n + callUsd(ADJUDICATOR.model, input, prefix.claude, outAdj), 0) + Math.max(0, last - prefix.claude) * (r.cacheWrite - r.input);
  const second = last * r.cacheRead + adjudicationBlock * r.input + outAdj * r.output;
  const worst = (c: JudgeModelConfig, inputs: number[]) => inputs.reduce((n, input) => n + attemptReserveUsd(c, input), 0);
  return {
    judgeA,
    judgeB,
    adjudication: first + second,
    worstJudges: worst(JUDGE_A, m.claude) + worst(JUDGE_B, m.openai),
    worstAdjudication: worst(ADJUDICATOR, m.claude) + attemptReserveUsd(ADJUDICATOR, last + adjudicationBlock),
    calls: { judgeA: m.claude.length, judgeB: m.openai.length, adjudication: m.claude.length + 1 },
  };
}

/**
 * The protocol's own estimate (section 7: 2,500 pairs, 2,000 input and 200 output tokens per
 * judgment, 15% escalated to one Sonnet call, no retries) at the repository prices: the
 * reference the plan's figures are reconciled with (review M14).
 */
export function protocolArithmetic(): { pairs: number; input: number; output: number; escalation: number; usd: { judgeA: number; judgeB: number; adjudicator: number; total: number } } {
  const pairs = 2_500;
  const input = 2_000;
  const output = 200;
  const escalation = 0.15;
  const one = (model: string) => input * rates(model).input + output * rates(model).output;
  const judgeA = pairs * one(JUDGE_A.model);
  const judgeB = pairs * one(JUDGE_B.model);
  const adjudicator = pairs * escalation * one(ADJUDICATOR.model);
  return { pairs, input, output, escalation, usd: { judgeA, judgeB, adjudicator, total: judgeA + judgeB + adjudicator } };
}

/** Outputs for a cost breakdown: none, visible verdicts only, or visible verdicts with the judges' reasoning (`full`, the assumptions unless given). */
export const outputsFor = (part: 'input' | 'visible' | 'full', full: { a: number; b: number; adj: number } = expectedOutputs()) => {
  if (part === 'full') return full;
  if (part === 'visible') return { a: Math.min(full.a, EXPECTED_OUTPUT['judge-a'].visible), b: Math.min(full.b, EXPECTED_OUTPUT['judge-b'].visible), adj: full.adj };
  return { a: 0, b: 0, adj: full.adj };
};

// ---------------------------------------------------------------------------
// Measured inputs (review N13)

/** What judged pairs measured: each role's mean output tokens per call with a reported usage (visible plus thinking or reasoning), and the escalated share. */
export interface MeasuredUsage {
  /** Pairs both judges finished (neither failed). */
  pairs: number;
  outputTokens: { a: number | null; b: number | null; adj: number | null };
  calls: { a: number; b: number; adj: number };
  /** Of those pairs, the share that escalated to the adjudicator (or would have, but for the escalation bound). */
  disagreement: number | null;
}

/** Measured usage of judgment records (a dev calibration run's records, for example). */
export function measuredUsage(records: readonly Pick<PairRecord, 'judges' | 'adjudication' | 'status' | 'attempts'>[]): MeasuredUsage {
  const outputs = (role: string) =>
    records.flatMap((r) => r.attempts).filter((a) => a.role === role && a.status === 'ok' && a.usage !== null).map((a) => (a.usage as NonNullable<typeof a.usage>).outputTokens);
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((n, x) => n + x, 0) / xs.length);
  const [a, b, adj] = [outputs('judge-a'), outputs('judge-b'), outputs('adjudicator')];
  const finished = records.filter((r) => r.judges.length === 2 && r.judges.every((j) => j.status !== 'failed'));
  const escalated = finished.filter((r) => r.adjudication !== null || r.status === 'escalation-budget-exhausted');
  return {
    pairs: finished.length,
    outputTokens: { a: mean(a), b: mean(b), adj: mean(adj) },
    calls: { a: a.length, b: b.length, adj: adj.length },
    disagreement: finished.length === 0 ? null : escalated.length / finished.length,
  };
}

/** The plan's inputs: the assumptions (config.ts, `ASSUMPTIONS`), replaced by measured usage, then by values given explicitly. */
export interface PlanInputs {
  /** Expected output tokens per call (visible plus thinking or reasoning) of each role. */
  outputs: { a: number; b: number; adj: number };
  /** The escalated share of pool pairs (relevance and answerability) and of calibration items. */
  escalation: number;
  calibrationDisagreement: number;
  source: { outputs: 'assumed' | 'measured' | 'given'; escalation: 'assumed' | 'measured' | 'given' };
}

export function planInputs(measured: MeasuredUsage | null, given: { outputTokens?: { a: number; b: number }; disagreement?: number } = {}): PlanInputs {
  const assumed = expectedOutputs();
  const outputs = {
    a: given.outputTokens?.a ?? measured?.outputTokens.a ?? assumed.a,
    b: given.outputTokens?.b ?? measured?.outputTokens.b ?? assumed.b,
    adj: measured?.outputTokens.adj ?? assumed.adj,
  };
  const disagreement = given.disagreement ?? measured?.disagreement ?? null;
  return {
    outputs,
    // A measured disagreement (calibration items are harder than most pool pairs) stands in for the pool escalation share too, within the bound.
    escalation: disagreement === null ? ASSUMPTIONS.escalationExpected : Math.min(disagreement, ASSUMPTIONS.escalationBound),
    calibrationDisagreement: disagreement ?? ASSUMPTIONS.calibrationDisagreement,
    source: {
      outputs: given.outputTokens ? 'given' : measured && (measured.outputTokens.a !== null || measured.outputTokens.b !== null) ? 'measured' : 'assumed',
      escalation: given.disagreement !== undefined ? 'given' : measured?.disagreement !== null && measured !== null ? 'measured' : 'assumed',
    },
  };
}

// ---------------------------------------------------------------------------
// The canary (review N9)

/**
 * The canary pair: the first dev calibration item in the schedule's order (every item has
 * priority 0, so `byPriority` orders them by case, family and bundle key), and the cap
 * that lets one full escalation finish: both judges, the adjudicator's blind step and its
 * decision, each at its caps (no retry). The canary reaches the adjudicator only when the
 * judges disagree on it.
 */
export function canaryOf<T extends { split: string; question: string; case: { ntsbNo: string }; bundle: { key: string } | null }>(items: readonly T[]): T | undefined {
  const key = (i: T): [string, string, string] => [i.case.ntsbNo, i.question, i.bundle?.key ?? ''];
  return items
    .filter((i) => i.split === 'dev')
    .sort((x, y) => {
      const [a, b] = [key(x), key(y)];
      for (let k = 0; k < 3; k += 1) if ((a[k] as string) !== (b[k] as string)) return (a[k] as string) < (b[k] as string) ? -1 : 1;
      return 0;
    })[0];
}

/** One full escalation of a measured case at its caps: what the canary's limit must cover. */
export const fullEscalationUsd = (c: CaseCost): number => c.worstJudges + c.worstAdjudication;

export interface RunCost {
  /** Expected pairs and calls, unrounded (so per-family runs add up); round when printing. */
  pairs: number;
  calls: { judgeA: number; judgeB: number; adjudicator: number };
  usd: { judgeA: number; judgeB: number; adjudicator: number; total: number };
  /** The total with escalations at the bound. */
  totalAtBoundUsd: number;
  /** Every call at its caps. */
  worstCaseUsd: number;
}

/** Cost of judging `pairs` pairs like the sampled `costs` (their mean, scaled), with `escalation` of them adjudicated. */
export function scaleRun(costs: readonly CaseCost[], pairs: number, escalation: number, bound: number = ASSUMPTIONS.escalationBound): RunCost {
  if (costs.length === 0 || pairs === 0) return { pairs: 0, calls: { judgeA: 0, judgeB: 0, adjudicator: 0 }, usd: { judgeA: 0, judgeB: 0, adjudicator: 0, total: 0 }, totalAtBoundUsd: 0, worstCaseUsd: 0 };
  const mean = (f: (c: CaseCost) => number) => costs.reduce((n, c) => n + f(c), 0) / costs.length;
  const retry = 1 + ASSUMPTIONS.invalidRetryShare;
  const a = pairs * retry * mean((c) => c.judgeA);
  const b = pairs * retry * mean((c) => c.judgeB);
  const adj = pairs * escalation * retry * mean((c) => c.adjudication);
  const adjBound = pairs * Math.max(escalation, bound) * retry * mean((c) => c.adjudication);
  return {
    pairs,
    calls: {
      judgeA: pairs * retry * mean((c) => c.calls.judgeA),
      judgeB: pairs * retry * mean((c) => c.calls.judgeB),
      adjudicator: pairs * escalation * retry * mean((c) => c.calls.adjudication),
    },
    usd: { judgeA: a, judgeB: b, adjudicator: adj, total: a + b + adj },
    totalAtBoundUsd: a + b + adjBound,
    worstCaseUsd: pairs * retry * (mean((c) => c.worstJudges) + Math.max(escalation, bound) * mean((c) => c.worstAdjudication)),
  };
}

export const addRuns = (runs: readonly RunCost[]): RunCost =>
  runs.reduce(
    (x, r) => ({
      pairs: x.pairs + r.pairs,
      calls: { judgeA: x.calls.judgeA + r.calls.judgeA, judgeB: x.calls.judgeB + r.calls.judgeB, adjudicator: x.calls.adjudicator + r.calls.adjudicator },
      usd: { judgeA: x.usd.judgeA + r.usd.judgeA, judgeB: x.usd.judgeB + r.usd.judgeB, adjudicator: x.usd.adjudicator + r.usd.adjudicator, total: x.usd.total + r.usd.total },
      totalAtBoundUsd: x.totalAtBoundUsd + r.totalAtBoundUsd,
      worstCaseUsd: x.worstCaseUsd + r.worstCaseUsd,
    }),
    { pairs: 0, calls: { judgeA: 0, judgeB: 0, adjudicator: 0 }, usd: { judgeA: 0, judgeB: 0, adjudicator: 0, total: 0 }, totalAtBoundUsd: 0, worstCaseUsd: 0 },
  );

export interface CallStats {
  n: number;
  mean: number;
  p90: number;
  max: number;
}

export const statsOf = (xs: readonly number[]): CallStats => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return { n: 0, mean: 0, p90: 0, max: 0 };
  return { n: s.length, mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p90: s[Math.min(s.length - 1, Math.floor(0.9 * s.length))] as number, max: s[s.length - 1] as number };
};

// ---------------------------------------------------------------------------
// Samples (Elasticsearch and PostgreSQL reads)

export interface CaseSample {
  family: string;
  ntsbNo: string;
  /** `cohort`: an exact pool member (bounded cohort); `bm25`, `lure`, `random`: a broad question's likely pool; `pool`: a case of a built pool. */
  origin: 'cohort' | 'bm25' | 'lure' | 'random' | 'pool';
}

/**
 * The exact pairs of a built pool file, per family, in the plan's estimate shape (the
 * re-plan from actual counts): relevance pairs (every pool case), stage 1 (tiers 0 to 2
 * of the frozen schedule), answerability pairs (every distinct delivered bundle) and the
 * mapping diagnostic's bundles among them.
 */
export function poolCounts(p: Pick<PoolFile, 'families'>, d: NarrativeDataset): FamilyPoolEstimate[] {
  const byId = new Map(families(d).map((f) => [f.id, f]));
  return p.families.map((f) => {
    const stage1 = f.cases.filter((c) => tierOf(casePriority(c, f.type)) <= SCHEDULE.stages[1]).length;
    const answerability = bundlePairs(f).length;
    const runBundles = new Set(bundlePairs({ runs: f.runs, mappingDiagnostic: [] }).map((x) => `${x.ntsbNo}|${bundleKeyOf(x.passages)}`));
    const mapping = bundlePairs({ runs: [], mappingDiagnostic: f.mappingDiagnostic }).filter((x) => !runBundles.has(`${x.ntsbNo}|${bundleKeyOf(x.passages)}`)).length;
    return {
      family: f.family,
      role: byId.get(f.family)?.role ?? 'benchmark',
      type: f.type,
      members: f.members.length,
      mean: f.cases.length,
      max: f.cases.length,
      stage1: { mean: stage1, max: stage1 },
      answerabilityPairs: { mean: answerability, max: answerability },
      mappingDiagnostic: { mean: mapping, max: mapping },
    };
  });
}

/** A built pool's cases to measure for a broad family: a seeded sample of its stage 1 cases and of the rest. */
export function poolSample(f: Pick<FamilyPool, 'family' | 'type' | 'cases'>, n: { stage1: number; rest: number }): CaseSample[] {
  const first = f.cases.filter((c) => tierOf(casePriority(c, f.type)) <= SCHEDULE.stages[1]).map((c) => c.ntsbNo);
  const rest = f.cases.filter((c) => tierOf(casePriority(c, f.type)) > SCHEDULE.stages[1]).map((c) => c.ntsbNo);
  return [...seededSample(first, n.stage1, `${f.family}|plan-pool-1`), ...seededSample(rest, n.rest, `${f.family}|plan-pool-2`)].map((ntsbNo) => ({ family: f.family, ntsbNo, origin: 'pool' as const }));
}

/** A broad question's likely pool: first cases by passage BM25 on the question, the lure's first cases, a random cohort sample. */
export async function likelyPool(es: Client, t: { passagesIndex: string; casesIndex: string; qualification: boolean }, f: NarrativeItem, cohort: readonly string[], n: { bm25: number; lure: number; random: number }): Promise<CaseSample[]> {
  const filter = compileFilters(f.filters, { eventAircraftQualification: t.qualification }).bool.filter;
  const res = await es.search<Record<string, unknown>>(keywordChannelBody(t.passagesIndex, f.question, filter, 400), { requestTimeout: 30_000 });
  assertCompleteResponse(res, 'keyword');
  const bm25 = uniqueTop(res.hits.hits.map((h) => toHit(String(h._id), h._source).ntsbNo), n.bm25);
  const lure = (await lureCases(es, t.casesIndex, f, t.qualification)).filter((x) => !bm25.includes(x)).slice(0, n.lure);
  const random = seededSample(cohort.filter((x) => !bm25.includes(x) && !lure.includes(x)), n.random, `${f.id}|plan-random`);
  return [
    ...bm25.map((ntsbNo) => ({ family: f.id, ntsbNo, origin: 'bm25' as const })),
    ...lure.map((ntsbNo) => ({ family: f.id, ntsbNo, origin: 'lure' as const })),
    ...random.map((ntsbNo) => ({ family: f.id, ntsbNo, origin: 'random' as const })),
  ];
}

/** The complete records of the sampled cases and the calibration items (synthetic records built locally). */
export async function sampleEvidence(client: pg.ClientBase, generationId: number, ntsbNos: readonly string[], calibration: CalibrationDataset): Promise<{ evidence: Map<string, CaseEvidence>; missing: string[]; integrity: string[] }> {
  const loaded = await loadCaseEvidence(client, generationId, [...ntsbNos, ...calibration.items.filter((i) => i.case.source === 'canonical').map((i) => i.case.ntsbNo)]);
  const evidence = new Map(loaded.evidence);
  for (const r of Object.values(calibration.records)) evidence.set(r.ntsbNo, controlEvidence(resolveRecord(r, calibration.fillers)));
  return { evidence, missing: loaded.missing, integrity: loaded.integrity.map((x) => x.sectionId) };
}

/** The family prefix (system prompt, schema, question and rubric) per provider: a request with an empty case, minus that empty case. */
export async function prefixTokens(claude: JudgeCaller, q: { question: string; rubric: Rubric }, e: CaseEvidence): Promise<{ claude: number; openai: number }> {
  const req = relevanceRequest(q, { ...e, sections: [], findings: [], occurrences: [] });
  const rest = countTokens(req.blocks.slice(1).map((b) => b.text).join('\n'));
  return { claude: Math.max(0, (await countRequest(claude, req)) - Math.round(rest * 1.6)), openai: Math.max(0, estimateOpenAIInput(req) - Math.round(rest * 1.25)) };
}

/** A proxy of a delivered bundle case for sizing answerability: its probable cause and the start of its first factual section (about two passages). */
export function proxyBundle(e: CaseEvidence): string {
  const factual = e.sections.find((s) => s.kind === 'factual');
  const chosen = [...(factual ? [{ s: factual, text: factual.text.slice(0, 2_400) }] : []), ...e.sections.filter((s) => s.kind === 'probable_cause').map((s) => ({ s, text: s.text }))];
  return renderBundleCase(
    e,
    chosen.map(({ s, text }) => ({ passageId: 'p'.repeat(64), sectionId: s.sectionId, revisionId: s.revisionId, kind: s.kind, scope: s.scope, aircraftKey: s.aircraftKey, start: 0, end: text.length, text })),
  );
}

export async function measureAnswerability(claude: JudgeCaller, family: string, q: { question: string; rubric: Rubric }, e: CaseEvidence): Promise<Measured> {
  const req = answerabilityRequest(q, proxyBundle(e));
  return { ntsbNo: e.ntsbNo, family, claude: [await countRequest(claude, req)], openai: [estimateOpenAIInput(req)], caseTokens: countTokens(req.blocks[1]?.text ?? ''), chunks: 1, uncovered: false };
}

/** An answerability judgment of a known bundle (calibration items), measured like a pool pair's. */
export async function measureBundle(claude: JudgeCaller, family: string, q: { question: string; rubric: Rubric }, e: CaseEvidence, passages: readonly DeliveredPassage[]): Promise<Measured> {
  const req = answerabilityRequest(q, renderBundleCase(e, passages));
  return { ntsbNo: e.ntsbNo, family, claude: [await countRequest(claude, req)], openai: [estimateOpenAIInput(req)], caseTokens: countTokens(req.blocks[1]?.text ?? ''), chunks: 1, uncovered: false };
}
