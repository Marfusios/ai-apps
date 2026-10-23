/**
 * Client for the public API (shared/contracts). Every response is validated
 * against its contract before the interface sees it, so a server change that
 * breaks a contract fails loudly instead of rendering wrong data.
 */
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import { AiStatusResponseSchema } from '../../shared/contracts/ai';
import { CaseDetailSchema } from '../../shared/contracts/cases';
import { ErrorResponseSchema, type ErrorResponse } from '../../shared/contracts/common';
import { ConfigResponseSchema } from '../../shared/contracts/config';
import { DashboardResponseSchema, type DashboardRequest } from '../../shared/contracts/dashboard';
import { SearchResponseSchema, searchRequestToParams, type SearchRequest } from '../../shared/contracts/search';
import { VisitorChangedError, privateRead, visitorGeneration } from './features/auth/visitor';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse | null;
  /** Seconds to wait before asking again: the body's `retryAfter`, else the `Retry-After` header. */
  readonly retryAfter: number | null;
  constructor(status: number, body: ErrorResponse | null, retryAfter: number | null = body?.retryAfter ?? null) {
    super(body?.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/** Delay-seconds form of `Retry-After` (the server never sends the date form). */
function retryAfterHeader(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  const seconds = raw === null ? NaN : Number(raw);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

async function errorOf(response: Response): Promise<ApiError> {
  let body: ErrorResponse | null = null;
  try {
    body = ErrorResponseSchema.parse(await response.json());
  } catch {
    body = null;
  }
  return new ApiError(response.status, body, body?.retryAfter ?? retryAfterHeader(response));
}

export async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin), {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw await errorOf(response);
  return schema.parse(await response.json());
}

/**
 * POSTs JSON; `schema` null for an empty (204) answer. With `visitor`, the visitor
 * generation the request belongs to (web/src/features/auth/visitor.ts), nothing is sent
 * once the visitor changed (`VisitorChangedError`): the check runs right before the send,
 * with nothing awaited between them, however long the caller waited before calling.
 */
export async function postJson<T>(path: string, body: unknown, schema: z.ZodType<T> | null, visitor?: number): Promise<T | null> {
  if (visitor !== undefined && visitor !== visitorGeneration()) throw new VisitorChangedError('the visitor changed before this was sent');
  const response = await fetch(new URL(path, window.location.origin), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw await errorOf(response);
  if (schema === null || response.status === 204) return null;
  return schema.parse(await response.json());
}

/** Retry once on network or server errors, never on 4xx. */
export function retry(failures: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status < 500) return false;
  return failures < 1;
}

export const configQuery = () =>
  queryOptions({
    queryKey: ['config'],
    queryFn: ({ signal }) => getJson('/api/config', ConfigResponseSchema, signal),
    staleTime: 10 * 60_000,
    retry,
  });

/** Canonical query string of a request: equal requests share a cache entry. */
export function searchQueryString(request: SearchRequest): string {
  return searchRequestToParams(request).toString();
}

export const searchQuery = (request: SearchRequest) => {
  const qs = searchQueryString(request);
  return queryOptions({
    queryKey: ['search', qs],
    queryFn: ({ signal }) => getJson(`/api/search${qs ? `?${qs}` : ''}`, SearchResponseSchema, signal),
    placeholderData: keepPreviousData,
    retry,
  });
};

export const caseQuery = (ntsbNo: string) =>
  queryOptions({
    queryKey: ['case', ntsbNo],
    queryFn: ({ signal }) => getJson(`/api/cases/${encodeURIComponent(ntsbNo)}`, CaseDetailSchema, signal),
    staleTime: 5 * 60_000,
    retry,
  });

export const dashboardQuery = (cohort: DashboardRequest['cohort']) =>
  queryOptions({
    queryKey: ['dashboard', cohort],
    queryFn: ({ signal }) => getJson(`/api/dashboard?cohort=${cohort}`, DashboardResponseSchema, signal),
    staleTime: 10 * 60_000,
    retry,
  });

/**
 * AI availability for this visitor (UI_DESIGN §5): the header counter and the Ask AI
 * label read it before anyone clicks. Per visitor and never cached by the server;
 * refetch it after an AI request. A private read (web/src/features/auth/visitor.ts).
 */
export const aiStatusQuery = () =>
  queryOptions({
    queryKey: ['ai-status'],
    queryFn: ({ signal }) => privateRead(() => getJson('/api/ai/status', AiStatusResponseSchema, signal)),
    staleTime: 30_000,
    retry,
  });
