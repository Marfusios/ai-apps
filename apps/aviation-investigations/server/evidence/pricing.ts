/** One rounded reservation for scope, embedding and the selected optional reranker. */
import { evidenceRankingConfig, assertEvidenceRanking, type EvidenceRankingConfig } from './ranking-config.js';
import type { AppConfig } from '../../shared/config.js';
import { embeddingWorstCaseUsd, stageWorstCaseUsd, EVIDENCE_SCOPE_CAPS, startupAiCheck, type AiStartupCheck } from '../ai/pricing.js';

export function evidenceReservation(scope: string, embed: string, config: EvidenceRankingConfig = evidenceRankingConfig()): { worstCaseUsd: number; reservationUsd: number } {
  assertEvidenceRanking(config);
  if (scope !== config.scope.model || embed !== config.embedding.model) throw new Error('evidence model does not match ranking configuration');
  const worstCaseUsd = stageWorstCaseUsd(scope, EVIDENCE_SCOPE_CAPS) + embeddingWorstCaseUsd(embed) +
    (config.rerank ? stageWorstCaseUsd(config.rerank.model, config.rerank.caps, config.rerank.cachePrefixTokens) : 0);
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
    return { ...checked, ...evidenceReservation(checked.models.scope, checked.models.embed, evidenceRankingConfig(config.ai.evidenceRanking)),
      models: { ...checked.models, answer: config.ai.anthropic.answerModel, check: config.ai.anthropic.checkModel } };
  } catch { return { enabled: false, reason: 'The evidence reservation could not be validated' }; }
}
