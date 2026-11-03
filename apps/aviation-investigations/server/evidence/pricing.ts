/** One rounded reservation for scope, embedding, the selected optional reranker and the automatic-filter check. */
import { evidenceRankingConfig, assertEvidenceRanking, type EvidenceRankingConfig } from './ranking-config.js';
import { assertAutoFilterPolicy, attributionStage, autoFilterPolicy, type AttributionStageConfig, type EvidenceAutoFilterPolicy } from './auto-filters.js';
import type { AppConfig } from '../../shared/config.js';
import { CACHED_PREFIX_MAX, embeddingWorstCaseUsd, stageWorstCaseUsd, EVIDENCE_SCOPE_CAPS, startupAiCheck, type AiStartupCheck } from '../ai/pricing.js';

/** The attribution check at its caps, the whole input a cache write (as scope's prefix): $0.000625 on Haiku 5.5. */
export const attributionWorstCaseUsd = (a: AttributionStageConfig): number => stageWorstCaseUsd(a.model, a.caps, CACHED_PREFIX_MAX);

export function evidenceReservation(scope: string, embed: string, config: EvidenceRankingConfig = evidenceRankingConfig(),
  policy: EvidenceAutoFilterPolicy = autoFilterPolicy()): { worstCaseUsd: number; reservationUsd: number } {
  assertEvidenceRanking(config);
  assertAutoFilterPolicy(policy);
  if (scope !== config.scope.model || embed !== config.embedding.model) throw new Error('evidence model does not match ranking configuration');
  const attribution = attributionStage(policy);
  const worstCaseUsd = stageWorstCaseUsd(scope, EVIDENCE_SCOPE_CAPS) + embeddingWorstCaseUsd(embed) +
    (config.rerank ? stageWorstCaseUsd(config.rerank.model, config.rerank.caps, config.rerank.cachePrefixTokens) : 0) +
    (attribution ? attributionWorstCaseUsd(attribution) : 0);
  // One rounding upward to a hundredth of a cent after summing every enabled stage.
  const reservationUsd = Math.ceil(worstCaseUsd * 10_000) / 10_000;
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0 || reservationUsd > 1) throw new Error('invalid evidence reservation');
  return { worstCaseUsd, reservationUsd };
}

export function evidenceStartupCheck(config: Pick<AppConfig, 'nodeEnv' | 'ai'>): AiStartupCheck {
  // Reuse the provider/key allowlist, but unreachable answer/check models cannot price this flow.
  const checked = startupAiCheck({ ...config, ai: { ...config.ai, anthropic: {
    ...config.ai.anthropic, answerModel: 'claude-haiku-5-5', checkModel: 'claude-haiku-5-5',
  } } });
  if (!checked.enabled || !checked.models) return checked;
  try {
    return { ...checked, ...evidenceReservation(checked.models.scope, checked.models.embed, evidenceRankingConfig(config.ai.evidenceRanking),
      autoFilterPolicy(config.ai.evidenceAutoFilters)),
      models: { ...checked.models, answer: config.ai.anthropic.answerModel, check: config.ai.anthropic.checkModel } };
  } catch { return { enabled: false, reason: 'The evidence reservation could not be validated' }; }
}
