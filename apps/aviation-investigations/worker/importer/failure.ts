/** Fixed classifications only: provider, SQL and source diagnostics never cross the worker boundary. */
import { ImportFailure, safeFailure } from './contracts.js';

export function classify(error: unknown): ImportFailure {
  if (error instanceof ImportFailure) return error;
  for (let value: unknown = error, depth = 0; value && depth < 5; depth++) {
    const current = value as {
      code?: string;
      name?: string;
      cause?: unknown;
      reason?: string;
    };
    if (['NormalizationError', 'ExtractDirError', 'CsvError'].includes(current.name ?? '')) {
      return new ImportFailure('schema');
    }
    if (current.name === 'LoadValueError') return new ImportFailure('integrity');
    if (current.code === 'P2601') return new ImportFailure('lock_lost', false, 'cancelled');
    if (current.code === 'P2602') return new ImportFailure('restore_hold');
    if (current.code === 'P2603') return new ImportFailure('import_cap');
    if (current.code === 'P2604') return new ImportFailure('accounting');
    if (current.code === 'P2605') return new ImportFailure('alias_unknown', false);
    if (current.code === '55000') return new ImportFailure('integrity');
    if (current.code === 'ENOSPC') return new ImportFailure('storage');
    if (['23502', '23503', '23505', '23514'].includes(current.code ?? ''))
      return new ImportFailure('integrity');
    if (current.name === 'SpendRefusedError') {
      if (current.reason === 'busy') return new ImportFailure('busy', false);
      if (current.reason === 'restore_hold') return new ImportFailure('restore_hold');
      return new ImportFailure('monthly_budget', false);
    }
    if (['AliasSwitchError', 'UnresolvedAliasError'].includes(current.name ?? '')) {
      return new ImportFailure('alias_unknown', false);
    }
    if (current.name === 'AbortError')
      return new ImportFailure('interrupted', false, 'cancelled');
    if (
      [
        'EmbeddingDeferredError',
        'DatabaseTimeoutError',
        'ConnectionError',
        'TimeoutError',
      ].includes(current.name ?? '') ||
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
        'EPIPE',
        '57014',
        '57P01',
        '08000',
        '08001',
        '08003',
        '08004',
        '08006',
      ].includes(current.code ?? '')
    ) {
      return new ImportFailure('interrupted', false);
    }
    value = current.cause;
  }
  return safeFailure(error);
}
