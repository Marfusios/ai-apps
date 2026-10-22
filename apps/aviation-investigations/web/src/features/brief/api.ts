/**
 * Client for the AI brief endpoints (shared/contracts/briefs.ts). Every read is private
 * to the brief's read owner and `no-store`; AI context is never merged into the public
 * case or search caches. Kept out of the entry chunk: it loads with the first AI request
 * or a page that shows AI output.
 */
import { queryOptions } from '@tanstack/react-query';
import {
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  StartBriefResponseSchema,
  type BriefStepResponse,
  type CreateBriefRequest,
  type RefinementRequest,
  type StartBriefResponse,
} from '../../../../shared/contracts/briefs';
import { getJson, postJson, retry } from '../../api';

/** The checklist polls the running step once a second (UI_DESIGN §4.4). */
export const BRIEF_POLL_MS = 1_000;

export const isFinished = (step: Pick<BriefStepResponse, 'stage'>): boolean => step.stage === 'done' || step.stage === 'failed';

/** `GET /api/briefs/:id?step=n`; `step` null reads the latest step. Polls while the step runs. */
export const briefStepQuery = (id: string, step: number | null) =>
  queryOptions({
    queryKey: ['brief', id, step ?? 'latest'],
    queryFn: ({ signal }) =>
      getJson(`/api/briefs/${encodeURIComponent(id)}${step === null ? '' : `?step=${step}`}`, BriefStepResponseSchema, signal),
    refetchInterval: (query) => (query.state.data && isFinished(query.state.data) ? false : BRIEF_POLL_MS),
    // A finished step never changes; a running one is always re-read.
    staleTime: (query) => (query.state.data && isFinished(query.state.data) ? Infinity : 0),
    retry,
  });

/** `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`: the brief's private AI context for one case. */
export const caseContextQuery = (id: string, step: number, ntsbNo: string) =>
  queryOptions({
    queryKey: ['brief-case', id, step, ntsbNo],
    queryFn: ({ signal }) =>
      getJson(
        `/api/briefs/${encodeURIComponent(id)}/steps/${step}/cases/${encodeURIComponent(ntsbNo)}`,
        CaseContextResponseSchema,
        signal,
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
