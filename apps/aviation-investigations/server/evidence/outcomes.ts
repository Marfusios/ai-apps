/** Closed, content-free stage failure categories shared by scope and rerank. */
import { StageError } from '../ai/provider.js';

export const RANKING_FAILURE_OUTCOMES = [
  'stopped', 'aborted', 'count_failed', 'rate_limited', 'overloaded',
  'input_too_large', 'unbilled_provider_error', 'timeout', 'refusal', 'truncated',
  'invalid_output', 'provider_error',
] as const;
export type RankingFailureOutcome = (typeof RANKING_FAILURE_OUTCOMES)[number];

/** A lifecycle check refused dispatch. Never attach the underlying DB error or abort reason. */
export class RankingStopped extends Error {
  constructor() { super('evidence stage stopped before dispatch'); }
}

export function rankingFailureOutcome(error: unknown, signal: AbortSignal): RankingFailureOutcome {
  if (error instanceof RankingStopped) return 'stopped';
  if (error instanceof StageError) {
    if (signal.aborted) return error.billing.kind === 'none' ? 'stopped' : 'aborted';
    if (error.billing.kind === 'none') {
      switch (error.category) {
        // The adapter's unbilled timeout is in preparation/counting, before generation.
        case 'count_failed': case 'timeout': return 'count_failed';
        case 'rate_limited': return 'rate_limited';
        case 'overloaded': return 'overloaded';
        case 'cap_exceeded': return 'input_too_large';
        default: return 'unbilled_provider_error';
      }
    }
    switch (error.category) {
      case 'timeout': return 'timeout';
      case 'refusal': return 'refusal';
      case 'truncated': return 'truncated';
      case 'invalid_output': return 'invalid_output';
      default: return 'provider_error';
    }
  }
  // Plain validation errors occur after a usable response, outside the adapter.
  // Unexpected adapter errors are normalized to a billed/uncertain StageError by the meter.
  return signal.aborted ? 'aborted' : 'invalid_output';
}
