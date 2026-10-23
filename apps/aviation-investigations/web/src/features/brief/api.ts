/**
 * Client for the AI brief endpoints (shared/contracts/briefs.ts). Every read is private
 * to the brief's read owner and `no-store`, and dropped if the visitor changes while it
 * is in flight (web/src/features/auth/visitor.ts); AI context is never merged into the
 * public case or search caches. Kept out of the entry chunk: it loads with the first AI request
 * or a page that shows AI output.
 */
import { queryOptions, type Query } from '@tanstack/react-query';
import {
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  StartBriefResponseSchema,
  type BriefStepResponse,
  type CreateBriefRequest,
  type RefinementRequest,
  type StartBriefResponse,
} from '../../../../shared/contracts/briefs';
import { ApiError, getJson, postJson, retry } from '../../api';
import { privateRead } from '../auth/visitor';

/** The checklist polls the running step once a second (UI_DESIGN §4.4). */
export const BRIEF_POLL_MS = 1_000;
/** Polling after failed reads backs off exponentially up to this. */
export const MAX_POLL_BACKOFF_MS = 30_000;

export const isFinished = (step: Pick<BriefStepResponse, 'stage'>): boolean => step.stage === 'done' || step.stage === 'failed';

/** The query state the poll schedule reads (a TanStack `Query` satisfies it). */
export interface PollState {
  state: {
    data: BriefStepResponse | undefined;
    status: 'pending' | 'error' | 'success';
    error: unknown;
    dataUpdatedAt: number;
    errorUpdateCount: number;
  };
}

/**
 * Failed reads since the last good one. Derived from the query's own counters (the
 * schedule is computed many times per update, so it must not count by itself).
 */
const sinceGood = new WeakMap<object, { dataUpdatedAt: number; errors: number }>();
function consecutiveFailures(query: PollState): number {
  const { dataUpdatedAt, errorUpdateCount, status } = query.state;
  let mark = sinceGood.get(query);
  if (!mark || mark.dataUpdatedAt !== dataUpdatedAt) {
    // A good read since the last look (or the first look): failures count from it. A
    // query that never succeeded counts from zero; one first seen failing, from just
    // before that failure.
    const before = status === 'error' ? Math.max(0, errorUpdateCount - 1) : errorUpdateCount;
    mark = { dataUpdatedAt, errors: dataUpdatedAt === 0 ? 0 : before };
    sinceGood.set(query, mark);
  }
  return Math.max(0, errorUpdateCount - mark.errors);
}

/**
 * When to read a step again: every second while it runs; never once it is finished, or
 * after a 404 (expired, not this visitor's, or gone) or another refusal; after a 429 when
 * the server says (`Retry-After`); after other failures with exponential backoff up to
 * 30 s, back to every second after the next good read.
 */
export function briefPollDelay(query: PollState): number | false {
  const { data, status, error } = query.state;
  // Always read, so a good read is remembered as the point failures count from.
  const failures = consecutiveFailures(query);
  if (data && isFinished(data)) return false;
  if (status !== 'error') return BRIEF_POLL_MS;
  const backoff = Math.min(MAX_POLL_BACKOFF_MS, BRIEF_POLL_MS * 2 ** failures);
  if (error instanceof ApiError) {
    if (error.status === 429) return error.retryAfter !== null ? Math.min(MAX_POLL_BACKOFF_MS * 10, error.retryAfter * 1000) : backoff;
    if (error.status < 500) return false;
  }
  return backoff;
}

/** `GET /api/briefs/:id?step=n`; `step` null reads the latest step. Polls while the step runs. */
export const briefStepQuery = (id: string, step: number | null) =>
  queryOptions({
    queryKey: ['brief', id, step ?? 'latest'],
    queryFn: ({ signal }) =>
      privateRead(() => getJson(`/api/briefs/${encodeURIComponent(id)}${step === null ? '' : `?step=${step}`}`, BriefStepResponseSchema, signal)),
    refetchInterval: (query: Query<BriefStepResponse, Error, BriefStepResponse, readonly unknown[]>) => briefPollDelay(query),
    // A finished step never changes; a running one is always re-read.
    staleTime: (query) => (query.state.data && isFinished(query.state.data) ? Infinity : 0),
    retry,
  });

/** `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`: the brief's private AI context for one case. */
export const caseContextQuery = (id: string, step: number, ntsbNo: string) =>
  queryOptions({
    queryKey: ['brief-case', id, step, ntsbNo],
    queryFn: ({ signal }) =>
      privateRead(() =>
        getJson(`/api/briefs/${encodeURIComponent(id)}/steps/${step}/cases/${encodeURIComponent(ntsbNo)}`, CaseContextResponseSchema, signal),
      ),
    staleTime: Infinity,
    retry,
  });

export async function createBrief(request: CreateBriefRequest): Promise<StartBriefResponse> {
  return (await postJson('/api/briefs', request, StartBriefResponseSchema)) as StartBriefResponse;
}

export async function refineBrief(id: string, request: RefinementRequest): Promise<StartBriefResponse> {
  return (await postJson(`/api/briefs/${encodeURIComponent(id)}/refine`, request, StartBriefResponseSchema)) as StartBriefResponse;
}

/** Cancels the running step `step` (it still counts as a search). */
export async function cancelBrief(id: string, step: number): Promise<void> {
  await postJson(`/api/briefs/${encodeURIComponent(id)}/cancel?step=${step}`, {}, null);
}
