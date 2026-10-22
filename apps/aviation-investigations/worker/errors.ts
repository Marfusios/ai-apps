/**
 * The worker's terminal error line. Every failure is printed through
 * `describeWorkerError`: embedding failures by their own message, which carries only
 * sanitized provider metadata (status, error code, request id); anything else through
 * `describeLoadError`, which reports database errors without statement parameters.
 */
import { EmbeddingDeferredError, EmbeddingRequestError } from './index/embed.js';
import { describeLoadError } from './ingest/load.js';

export function describeWorkerError(err: unknown): string {
  if (err instanceof EmbeddingRequestError || err instanceof EmbeddingDeferredError) return err.message;
  return describeLoadError(err);
}
