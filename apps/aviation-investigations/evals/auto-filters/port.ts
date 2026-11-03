/**
 * Task 30's attribution parts through the production `rankEvidence` and the allocation's spend gate:
 * a scripted scope (settled at $0) or the real scope.e3, the real attribution check, and an offline
 * retriever that returns no cases (no embedding, no Elasticsearch). Ranking `er-q-v1`: no rerank.
 */
import { join } from 'node:path';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { StageError, type LlmProvider } from '../../server/ai/provider.js';
import { EVIDENCE_SCOPE_VERSION } from '../../server/ai/prompts/scope.e1.js';
import { stageWorstCaseUsd, embeddingWorstCaseUsd } from '../../server/ai/pricing.js';
import { attributionWorstCaseUsd } from '../../server/evidence/pricing.js';
import { rankEvidence, RankingFailure, type RankingExecution, type RankingResult } from '../../server/evidence/pipeline.js';
import { attributionStage, autoFilterIdentity, automaticFieldsOf, type EvidenceAutoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import type { EvidenceRetriever } from '../../server/evidence/retrieve.js';
import { evaluationRankingSpendGate } from '../../server/evidence/spend.js';
import type { PinnedDataset } from '../../server/dataset.js';
import type { SpendLine } from '../../server/quota/settle.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import type { EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
import { ceilUsd, type SpendReservation } from '../../worker/index/spend-gate.js';
import type { CappedAllocation } from '../langfuse/money.js';
import type { EvaluationSettings } from '../search-quality/config.js';
import { filterIdentity } from '../search-quality/ab-production.js';
import { appendDurable, EvaluationError } from '../search-quality/money.js';
import type { StageTiming } from '../search-quality/ab-types.js';
import { scriptedScopeOutput, type AttributionPart, type AutoField, type ScriptedScope } from './plan.js';

export const ATTRIBUTION_RANKING = 'er-q-v1' as const;
export const MODEL = 'claude-haiku-5-5';
export const EMBEDDING_MODEL = 'text-embedding-3-small';
/** Only the offline retriever sees it. */
const OFFLINE_DATASET = { manifest: { generationId: 0, casesIndex: 'task30-offline', passagesIndex: 'task30-offline' } } as unknown as PinnedDataset;
const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });

/** The policy's extra time on the outer deadline (the site adds the same, server/routes/evidence.ts). */
export const attributionTimeoutMs = (policy: EvidenceAutoFilterPolicy): number => attributionStage(policy)?.timeoutMs ?? 0;
/** The automatic fields a filter object holds (both year bounds are one field). */
export function automaticFieldsIn(filters: EvidenceAutomaticFilters | BriefFilters | null | undefined): AutoField[] {
  if (!filters) return [];
  const f = filters as { state?: unknown[]; yearFrom?: number; yearTo?: number; category?: unknown[] };
  return [...(f.state?.length ? ['state' as const] : []), ...(f.yearFrom !== undefined || f.yearTo !== undefined ? ['years' as const] : []),
    ...(f.category?.length ? ['category' as const] : [])];
}

export interface AttributionAttempt { key: string; part: AttributionPart; itemId: string; sample: number }
export interface AttributionItem { id: string; question: string; scripted: ScriptedScope | null }
export interface AttributionObservation extends AttributionAttempt {
  scope: 'scripted' | 'real';
  configuration: { version: string; sha256: string };
  policy: { version: string; sha256: string };
  /** What the scope answered: its intent and filters (null when it failed). */
  intent: string | null; emitted: BriefFilters | null;
  scopeOutcome: string;
  automaticFilters: EvidenceAutomaticFilters | null;
  autoFilterFields: Partial<Record<AutoField, string>>;
  autoFilterReason: string;
  attributionOutcome: string;
  attributionCalled: boolean;
  /** The candidates the check was given (field ids and AirCase-rendered values), never the question. */
  candidates: { id: string; values: string[] }[] | null;
  appliedFilters: BriefFilters;
  usage: SpendLine[]; actualUsd: number; boundUsd: number; reservationIds: string[];
  timing: { scope: StageTiming; attribution: StageTiming; retrieve: StageTiming }; totalMs: number;
  failure: string | null; safetyFaults: string[];
}
export interface AttributionPort { run(attempt: AttributionAttempt, item: AttributionItem): Promise<AttributionObservation> }

/**
 * A scripted scope answers exactly what the item prescribes, with zero usage, so the meter settles
 * it at $0 through the same gate. It reports the provider (the adapter's own name) and model the
 * pipeline checks; the stage journal marks its lines as scripted. A recorded failure replays as an
 * unbilled stage error.
 */
export function scriptedScope(question: string, s: ScriptedScope, provider: LlmProvider['name']): NonNullable<LlmProvider['evidenceScope']> {
  return async () => {
    if (s.kind === 'failure') throw new StageError('invalid_output', { stage: 'scope', provider, model: MODEL, promptVersion: EVIDENCE_SCOPE_VERSION, billing: { kind: 'none' } });
    return { output: scriptedScopeOutput(question, s), usage: { ...ZERO_USAGE }, provider, model: MODEL,
      promptVersion: EVIDENCE_SCOPE_VERSION, stopReason: 'end_turn', warnings: [] };
  };
}

export function attributionPort(settings: EvaluationSettings, allocation: Pick<CappedAllocation, 'gate'>, phase: 'selection' | 'confirmation',
  hash: string, directory: string, policy: EvidenceAutoFilterPolicy): AttributionPort {
  const check = attributionStage(policy);
  if (!check) throw new EvaluationError('The selected automatic filter policy has no attribution check');
  const base = createAnthropicProvider({ apiKey: settings.config.ai.anthropic.apiKey!, models: { scope: MODEL, answer: MODEL, check: MODEL } });
  if (!base.evidenceScope || !base.evidenceAttribution) throw new EvaluationError('The provider has no scope or attribution stage');
  const config = evidenceRankingConfig(ATTRIBUTION_RANKING), configuration = evidenceRankingIdentity(config), identity = autoFilterIdentity(policy);
  const enabled = automaticFieldsOf(policy) as readonly AutoField[];
  const scopeWorst = stageWorstCaseUsd(config.scope.model, config.scope.caps, config.scope.cachePrefixTokens);
  return { async run(attempt, item) {
    const scripted = item.scripted !== null;
    const stage = (): StageTiming => ({ attempted: false, ms: 0 });
    const timing = { scope: stage(), attribution: stage(), retrieve: stage() };
    const timed = async <T>(s: keyof typeof timing, fn: () => Promise<T>): Promise<T> => {
      timing[s].attempted = true; const started = performance.now();
      try { return await fn(); } finally { timing[s].ms += performance.now() - started; }
    };
    const reservationIds: string[] = [], settlements = new Map<string, number>(), faults = new Set<string>();
    let intent: string | null = null, emitted: BriefFilters | null = null, candidates: AttributionObservation['candidates'] = null;
    let attributionCalled = false, execution: RankingExecution | undefined;
    const record = (line: object) => appendDurable(join(directory, 'model-results.jsonl'), { key: attempt.key, ...line });
    const evidenceScope: NonNullable<LlmProvider['evidenceScope']> = scripted
      ? async (...args) => {
        const result = await timed('scope', () => scriptedScope(item.question, item.scripted!, base.name)(...args));
        intent = result.output.intent; emitted = result.output.filters;
        return result;
      }
      : (...args) => timed('scope', async () => {
        const result = await base.evidenceScope!(...args);
        intent = result.output.intent; emitted = result.output.filters;
        record({ stage: 'scope', output: result.output, usage: result.usage });
        return result;
      });
    const llm: LlmProvider = { ...base, evidenceScope,
      evidenceAttribution: (input, ctx) => timed('attribution', async () => {
        attributionCalled = true;
        candidates = input.candidates.map(c => ({ id: c.id, values: [...c.values] }));
        const result = await base.evidenceAttribution!(input, ctx);
        record({ stage: 'attribution', candidates, output: result.output, usage: result.usage });
        return result;
      }),
    };
    const retriever: EvidenceRetriever = {
      available: async () => true,
      search: (_dataset, plan) => timed('retrieve', async () => {
        // The request sends no filters: only the policy's automatic filters may reach retrieval.
        if (filterIdentity(plan.filters) !== filterIdentity(execution?.automaticFilters ?? {})) {
          faults.add('unexpected_filters');
          throw new EvaluationError('Unexpected filters reached retrieval');
        }
        return { ranking: [], cases: [] };
      }),
    };
    const spend = evaluationRankingSpendGate(call => {
      const gate = allocation.gate(phase, hash, call.provider, call.model, call.stage);
      return { ...gate,
        reserve: async req => {
          const reservation = await gate.reserve(req); reservationIds.push(reservation.reservationId);
          return reservation;
        },
        settle: async (reservation: SpendReservation, outcome) => {
          await gate.settle(reservation, outcome);
          const usd = outcome === 'uncertain' ? ceilUsd(call.worstCaseUsd) : ceilUsd(outcome.usd);
          settlements.set(reservation.reservationId, usd);
          appendDurable(join(directory, 'stage-results.jsonl'), { key: attempt.key, stage: call.stage, reservationId: reservation.reservationId,
            chargedUsd: usd, uncertain: outcome === 'uncertain', ...(call.stage === 'scope' && scripted ? { scripted: true } : {}) });
        },
      };
    }, attempt.key);
    const started = performance.now();
    let result: RankingResult | undefined, failure: string | null = null, usage: SpendLine[] = [];
    try {
      result = await rankEvidence(config, { question: item.question, filters: {}, autoFilters: policy, dataset: OFFLINE_DATASET,
        signal: AbortSignal.timeout(config.deadlineMs + attributionTimeoutMs(policy)) },
        { llm, retriever, embeddingModel: EMBEDDING_MODEL }, spend, undefined, { onExecution: e => { execution = e; } });
      usage = result.usage;
    } catch (e) {
      // Accounting exceptions are not repaired; the journal and the ledger keep any outstanding liability.
      failure = e instanceof RankingFailure ? e.stage : 'unexpected';
      if (e instanceof RankingFailure) usage = [...e.usage];
    }
    const totalMs = performance.now() - started;
    const actualUsd = [...settlements.values()].reduce((a, b) => a + b, 0);
    // Each stage settles at most its worst case rounded up to the ledger's micro-dollar (an uncertain line keeps all of it).
    const boundUsd = (scripted ? 0 : ceilUsd(scopeWorst)) + ceilUsd(attributionWorstCaseUsd(check)) + ceilUsd(embeddingWorstCaseUsd(EMBEDDING_MODEL));
    if (reservationIds.some(id => !settlements.has(id))) faults.add('unsettled_stage');
    if (scripted && usage.some(l => l.stage === 'scope' && l.usd > 0)) faults.add('scripted_scope_charged');
    if (actualUsd > boundUsd + 1e-9) faults.add('search_charge_exceeds_bound');
    if (result && (result.autoFilterPolicy.sha256 !== identity.sha256 || result.configuration.sha256 !== configuration.sha256)) faults.add('identity_changed');
    if (result && automaticFieldsIn(result.automaticFilters).some(f => !enabled.includes(f))) faults.add('automatic_outside_policy');
    return { ...attempt, scope: scripted ? 'scripted' : 'real', configuration, policy: identity, intent, emitted,
      scopeOutcome: result?.scopeOutcome ?? 'search_failed', automaticFilters: result?.automaticFilters ?? null,
      autoFilterFields: (result?.autoFilterFields ?? {}) as Partial<Record<AutoField, string>>, autoFilterReason: result?.autoFilterReason ?? 'search_failed',
      attributionOutcome: result?.attributionOutcome ?? 'not_run', attributionCalled, candidates,
      appliedFilters: result?.appliedFilters ?? {}, usage, actualUsd, boundUsd, reservationIds, timing, totalMs,
      failure, safetyFaults: [...faults].sort() };
  } };
}
