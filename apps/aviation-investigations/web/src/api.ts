/**
 * Client for the public API (shared/contracts). Every response is validated
 * against its contract before the interface sees it, so a server change that
 * breaks a contract fails loudly instead of rendering wrong data.
 */
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import { CaseDetailSchema } from '../../shared/contracts/cases';
import { ErrorResponseSchema, type ErrorResponse } from '../../shared/contracts/common';
import { ConfigResponseSchema } from '../../shared/contracts/config';
import { SearchResponseSchema, searchRequestToParams, type SearchRequest } from '../../shared/contracts/search';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse | null;
  constructor(status: number, body: ErrorResponse | null) {
    super(body?.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin), {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    let body: ErrorResponse | null = null;
    try {
      body = ErrorResponseSchema.parse(await response.json());
    } catch {
      body = null;
    }
    throw new ApiError(response.status, body);
  }
  return schema.parse(await response.json());
}

/** Retry once on network or server errors, never on 4xx. */
function retry(failures: number, err: unknown): boolean {
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
