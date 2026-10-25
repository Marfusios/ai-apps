/** Thin instrumentation around the shared HTTP/evaluation ranking pipeline; no duplicate ranking logic. */
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import type { Db } from '../../server/db/client.js';
import type { PinnedDataset } from '../../server/dataset.js';
import { getActiveManifest } from '../../server/db/generations.js';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { createOpenAIQueryEmbedder, type QueryEmbedder } from '../../server/ai/embeddings.js';
import type { LlmProvider } from '../../server/ai/provider.js';
import { rankEvidence, RankingFailure } from '../../server/evidence/pipeline.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { createEvidenceRetriever, type EvidenceRetriever } from '../../server/evidence/retrieve.js';
import { evaluationRankingSpendGate } from '../../server/evidence/spend.js';
import { ceilUsd, type SpendReservation } from '../../worker/index/spend-gate.js';
import { appendDurable, EvaluationError, TaskAllocation } from './money.js';
import { ARM_IDS, type ArmIdentity, type Arm, type RankingPort, type SearchObservation, type StageTiming } from './ab-types.js';
import type { EvaluationSettings } from './config.js';

export function productionPort(settings: EvaluationSettings, db: Db, es: Client, pinned: PinnedDataset,
  allocation: TaskAllocation, phase: 'selection' | 'confirmation', hash: string, directory: string,
  identities: Readonly<Record<Arm, ArmIdentity>>): RankingPort {
  const baseLlm = createAnthropicProvider({ apiKey: settings.config.ai.anthropic.apiKey!, models: {
    scope: 'claude-haiku-5-5', answer: 'claude-haiku-5-5', check: 'claude-haiku-5-5' } });
  const baseEmbed = createOpenAIQueryEmbedder({ apiKey: settings.config.ai.openai.apiKey!, model: 'text-embedding-3-small', dims: 1536 });
  return { async run(attempt, question) {
    const c = evidenceRankingConfig(ARM_IDS[attempt.arm]), identity = evidenceRankingIdentity(c), expected = identities[attempt.arm];
    if (identity.sha256 !== expected.sha256 || identity.version !== expected.version) throw new EvaluationError('Configuration identity changed before dispatch');
    const active = await getActiveManifest(db);
    if (!active || active.generationId !== pinned.manifest.generationId || active.casesIndex !== pinned.manifest.casesIndex || active.passagesIndex !== pinned.manifest.passagesIndex) throw new EvaluationError('Active target changed before dispatch');
    const stage = (): StageTiming => ({ attempted: false, ms: 0 });
    const timing = { scope: stage(), embed: stage(), retrieve: stage(), rerank: stage() };
    const reservationIds: string[] = [], settlements = new Map<string, number>();
    let fused: string[] = [], embedReported = false;
    const timed = async <T>(s: keyof typeof timing, fn: () => Promise<T>): Promise<T> => {
      timing[s].attempted = true; const started = performance.now();
      try { return await fn(); } finally { timing[s].ms += performance.now() - started; }
    };
    const llm: LlmProvider = { ...baseLlm,
      evidenceScope: (...args) => timed('scope', async () => {
        const result = await baseLlm.evidenceScope!(...args);
        appendDurable(join(directory, 'model-results.jsonl'), { key: attempt.key, stage: 'scope', output: result.output, usage: result.usage });
        return result;
      }),
      rerank: (...args) => timed('rerank', async () => {
        const result = await baseLlm.rerank!(...args);
        appendDurable(join(directory, 'model-results.jsonl'), { key: attempt.key, stage: 'rerank', output: result.output, usage: result.usage });
        return result;
      }),
    };
    const embedder: QueryEmbedder = { ...baseEmbed,
      embed: texts => timed('embed', () => baseEmbed.embed(texts)),
      embedWithSignal: (texts, signal) => timed('embed', () => baseEmbed.embedWithSignal(texts, signal)),
    };
    const baseRetriever = createEvidenceRetriever(db, es, embedder);
    const retriever: EvidenceRetriever = { ...baseRetriever, search: (...args) => timed('retrieve', async () => {
      if (Object.keys(args[1].filters).length) throw new EvaluationError('Gold filters reached execution');
      const report = args[3];
      const found = await baseRetriever.search(args[0], args[1], args[2], u => { embedReported = true; report(u); }, args[4]);
      fused = found.ranking.map(r => r.ntsbNo);
      return found;
    }) };
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
          appendDurable(join(directory, 'stage-results.jsonl'), { key: attempt.key, stage: call.stage,
            reservationId: reservation.reservationId, chargedUsd: usd, uncertain: outcome === 'uncertain' });
        },
      };
    }, attempt.key);
    const started = performance.now();
    let currentStage: 'scope' | 'retrieve' | 'rerank' | null = null, stageStarted = started;
    const finishStage = () => { if (currentStage) timing[currentStage].ms = performance.now() - stageStarted; };
    let result, failure: string | null = null, usage: SearchObservation['usage'] = [];
    try {
      result = await rankEvidence(c, { question: question.question, filters: {}, dataset: pinned, signal: AbortSignal.timeout(c.deadlineMs) },
        { llm, retriever, embeddingModel: 'text-embedding-3-small' }, spend, undefined, {
          onStage: stage => {
            finishStage(); currentStage = stage === 'retrieval' ? 'retrieve' : stage;
            timing[currentStage].attempted = true; stageStarted = performance.now();
          },
        });
      usage = result.usage;
    } catch (e) {
      // Accounting exceptions are not repaired; the journal and database retain any outstanding liability.
      failure = e instanceof RankingFailure ? e.stage : 'unexpected';
      if (e instanceof RankingFailure) usage = [...e.usage];
    }
    finishStage();
    const totalMs = performance.now() - started;
    const ranking = result?.ranking.map(r => r.ntsbNo) ?? [];
    const safetyFaults: string[] = [];
    if (result && (new Set(ranking).size !== ranking.length || ranking.length !== fused.length || [...ranking].sort().join('\n') !== [...fused].sort().join('\n'))) safetyFaults.push('case_membership_changed');
    if (result && c.rerank && ranking.slice(c.rerank.depth).join('\n') !== fused.slice(c.rerank.depth).join('\n')) safetyFaults.push('tail_changed');
    if (result && (result.configuration.sha256 !== expected.sha256 || result.cases.some((v, i) => v.case.ntsbNo !== ranking[i]))) safetyFaults.push('configuration_or_projection_changed');
    if (reservationIds.some(id => !settlements.has(id))) safetyFaults.push('unsettled_stage');
    const actualUsd = [...settlements.values()].reduce((a, b) => a + b, 0);
    if (actualUsd > expected.reservationUsd + 1e-9) safetyFaults.push('search_charge_exceeds_bound');
    // A bounded-input rejection is still a rerank attempt, despite making no generation call.
    if (c.rerank && fused.length && result && !['empty', 'disabled', 'not_run', 'skipped_uncertain_allowance'].includes(result.rerankOutcome)) timing.rerank.attempted = true;
    const observation: SearchObservation = { ...attempt, configuration: identity, ranking, fused,
      scopeOutcome: result?.scopeOutcome ?? 'search_failed', lexicalSource: result?.lexicalSource ?? 'unavailable',
      rerankOutcome: result?.rerankOutcome ?? 'not_run', executed: result?.executed ?? null,
      usage, actualUsd, reservationUsd: expected.reservationUsd, reservationIds, timing, totalMs,
      embeddingCacheHit: timing.retrieve.attempted && !timing.embed.attempted && !embedReported,
      failure, safetyFaults };
    return observation;
  } };
}
