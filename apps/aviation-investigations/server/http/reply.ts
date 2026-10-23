/**
 * JSON replies for the public API: cacheable bodies with ETags, and redacted errors.
 *
 * Errors are `ErrorResponse` bodies with fixed, plain messages and `no-store`. Internal
 * details (database or Elasticsearch messages, stack traces, query text) never reach a
 * response; the server log gets only the error's type.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorResponse } from '../../shared/contracts/common.js';

export const JSON_TYPE = 'application/json; charset=utf-8';

export interface CacheOptions {
  /** `Cache-Control` value. */
  cacheControl: string;
  /** Prefix of the ETag (the dataset revision); the body hash follows it. */
  etagPrefix?: string;
}

/** The ETag of a body: `"<revision>-<16 hex of sha256(body)>"`, so it changes with the data and the bytes. */
export function etagOf(prefix: string, body: string): string {
  return `"${prefix}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
}

function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

/** Send a JSON body with caching headers; answers 304 when the client's ETag matches. */
export function sendJson(request: FastifyRequest, reply: FastifyReply, value: unknown, cache: CacheOptions): FastifyReply {
  const body = JSON.stringify(value);
  reply.header('cache-control', cache.cacheControl);
  if (cache.etagPrefix) {
    const etag = etagOf(cache.etagPrefix, body);
    reply.header('etag', etag);
    if (matches(request.headers['if-none-match'], etag)) return reply.code(304).send();
  }
  return reply.code(200).type(JSON_TYPE).send(body);
}

export const ERROR_MESSAGES = {
  bad_request: 'The request is not valid.',
  forbidden: 'This request is not allowed.',
  not_found: 'Not found.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  unavailable: 'The service is temporarily unavailable. Try again shortly.',
  internal: 'Something went wrong on our side.',
  challenge_required: 'A quick check is needed before this AI search.',
  challenge_failed: "The quick check didn't go through. Try again.",
  sign_in_required: 'Sign in to ask the AI.',
  ai_paused: 'AI search is temporarily unavailable.',
  trial_used: 'Your free AI searches are used up.',
  free_searches_paused: 'Free AI searches are used up for today.',
  quota_exhausted: "You've used your AI searches for now.",
  in_flight: 'An AI search is already running. Wait for it to finish.',
  conflict: 'This request conflicts with an earlier one.',
  refinement_limit: 'This brief has used its three refinements. Start a new search to keep going.',
  moved: 'This AI search moved to the account that signed in. Sign in to view it.',
} as const satisfies Record<ErrorResponse['error'], string>;

export function sendError(
  reply: FastifyReply,
  status: number,
  error: ErrorResponse['error'],
  extra: Partial<Pick<ErrorResponse, 'message' | 'issues' | 'retryAfter'>> = {},
): FastifyReply {
  const body: ErrorResponse = { error, message: extra.message ?? ERROR_MESSAGES[error] };
  if (extra.issues && extra.issues.length > 0) body.issues = extra.issues;
  if (extra.retryAfter !== undefined) body.retryAfter = extra.retryAfter;
  return reply.code(status).header('cache-control', 'no-store').type(JSON_TYPE).send(JSON.stringify(body));
}

/** Zod issues as `ErrorResponse.issues`: paths and messages only, bounded. */
export function issuesOf(issues: readonly { path: readonly PropertyKey[]; message: string }[]): NonNullable<ErrorResponse['issues']> {
  return issues.slice(0, 20).map((i) => ({
    path: (i.path.map(String).join('.') || '(query)').slice(0, 80),
    message: i.message.slice(0, 200),
  }));
}
