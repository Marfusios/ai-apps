/** Evidence uses only scope.e1 and one embedding. No generated-answer reservation. */
import type { AppConfig } from '../../shared/config.js';
import { embeddingWorstCaseUsd, stageWorstCaseUsd, STAGE_CAPS, startupAiCheck, type AiStartupCheck } from '../ai/pricing.js';

export function evidenceReservation(scope: string, embed: string): { worstCaseUsd: number; reservationUsd: number } {
  const worstCaseUsd = stageWorstCaseUsd(scope, STAGE_CAPS.scope) + embeddingWorstCaseUsd(embed);
  // Round upward to a hundredth of a cent: $0.0011325 -> $0.0012.
  const reservationUsd = Math.ceil(worstCaseUsd * 10_000) / 10_000;
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0 || reservationUsd > 0.05) throw new Error('invalid evidence reservation');
  return { worstCaseUsd, reservationUsd };
}

export function evidenceStartupCheck(config: Pick<AppConfig, 'nodeEnv' | 'ai'>): AiStartupCheck {
  // Reuse the provider/key allowlist, but unreachable answer/check models cannot price this flow.
  const checked = startupAiCheck({ ...config, ai: { ...config.ai, anthropic: {
    ...config.ai.anthropic, answerModel: 'claude-haiku-5-5', checkModel: 'claude-haiku-5-5',
  } } });
  if (!checked.enabled || !checked.models) return checked;
  try {
    return { ...checked, ...evidenceReservation(checked.models.scope, checked.models.embed),
      models: { ...checked.models, answer: config.ai.anthropic.answerModel, check: config.ai.anthropic.checkModel } };
  } catch { return { enabled: false, reason: 'The evidence reservation could not be validated' }; }
}
