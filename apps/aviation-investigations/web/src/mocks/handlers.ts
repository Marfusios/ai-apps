/**
 * MSW handlers for the public API, answered from the fixture-built mock files in
 * `web/mock/` (scripts/build-mock-api.ts). Used by the dev mock mode
 * (`WEB_MOCK_API=1`), the component tests and the end-to-end tests. Never part of
 * a production bundle.
 *
 * AI briefs (`/api/briefs*`) are answered by an in-memory `MockBriefs` per handler set
 * (web/mock/briefs.ts): request bodies are validated with the real contracts, and a
 * running step moves one checklist row per poll.
 */
import { delay, http, HttpResponse } from 'msw';
import type { AiStatusResponse } from '../../../shared/contracts/ai';
import type { CaseDetail } from '../../../shared/contracts/cases';
import { CreateBriefRequestSchema, RefinementRequestSchema } from '../../../shared/contracts/briefs';
import type { ErrorResponse } from '../../../shared/contracts/common';
import { SearchRequestSchema, paramsToQuery } from '../../../shared/contracts/search';
import cases from '../../mock/cases.json';
import config from '../../mock/config.json';
import dashboardAll from '../../mock/dashboard-all.json';
import dashboardDefault from '../../mock/dashboard-default.json';
import index from '../../mock/search-index.json';
import { AI_STATUS_SAMPLES } from '../../mock/ai-status';
import { MockBriefs, type MockReply } from '../../mock/briefs';
import { searchCorpus, type MockCorpus } from '../../mock/engine';

export const mockCorpus: MockCorpus = {
  dataset: index.dataset,
  docs: index.docs as unknown as MockCorpus['docs'],
  cases: cases as unknown as Record<string, CaseDetail>,
};

function error(status: number, body: ErrorResponse): Response {
  return HttpResponse.json(body, { status });
}

export interface HandlerOptions {
  /** Simulated server time per request, so loading states are visible in dev. */
  latencyMs?: number;
  /** What `GET /api/ai/status` answers (default: a fresh anonymous visitor). */
  aiStatus?: AiStatusResponse;
  /** Polls of a running brief step until it is done (default 4: one per checklist row). */
  briefPolls?: number;
}

const NO_STORE = { 'cache-control': 'private, no-store' };

function briefReply<T>(r: MockReply<T>): Response {
  if (r.status === 204) return new HttpResponse(null, { status: 204, headers: NO_STORE });
  return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status, headers: NO_STORE });
}

function badRequest(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Response {
  return HttpResponse.json(
    {
      error: 'bad_request',
      message: 'The request is not valid.',
      issues: issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message })),
    } satisfies ErrorResponse,
    { status: 400, headers: NO_STORE },
  );
}

export function createHandlers({ latencyMs = 0, aiStatus = AI_STATUS_SAMPLES.fresh, briefPolls }: HandlerOptions = {}) {
  const wait = async (): Promise<void> => {
    if (latencyMs > 0) await delay(latencyMs);
  };
  const briefs = new MockBriefs(briefPolls === undefined ? {} : { pollsToFinish: briefPolls });
  return [
    http.get('*/api/config', async () => {
      await wait();
      return HttpResponse.json(config);
    }),
    http.get('*/api/search', async ({ request }) => {
      await wait();
      const parsed = SearchRequestSchema.safeParse(paramsToQuery(new URL(request.url).searchParams));
      if (!parsed.success) {
        return error(400, {
          error: 'bad_request',
          message: 'The search parameters are not valid.',
          issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return HttpResponse.json(searchCorpus(mockCorpus, parsed.data));
    }),
    http.get('*/api/cases/:ntsbNo', async ({ params }) => {
      await wait();
      const ntsbNo = String(params.ntsbNo ?? '');
      const detail = Object.hasOwn(mockCorpus.cases, ntsbNo) ? mockCorpus.cases[ntsbNo] : undefined;
      if (!detail) return error(404, { error: 'not_found', message: 'No investigation has that number.' });
      return HttpResponse.json(detail);
    }),
    http.get('*/api/dashboard', async ({ request }) => {
      await wait();
      const cohort = new URL(request.url).searchParams.get('cohort');
      return HttpResponse.json(cohort === 'all' ? dashboardAll : dashboardDefault);
    }),
    http.get('*/api/ai/status', async () => {
      await wait();
      return HttpResponse.json(aiStatus, { headers: { 'cache-control': 'no-store' } });
    }),
    http.post('*/api/briefs', async ({ request }) => {
      await wait();
      const parsed = CreateBriefRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      return briefReply(briefs.create(parsed.data));
    }),
    http.post('*/api/briefs/:id/refine', async ({ request, params }) => {
      await wait();
      const parsed = RefinementRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      return briefReply(briefs.refine(String(params.id), parsed.data));
    }),
    http.post('*/api/briefs/:id/cancel', async ({ params }) => {
      await wait();
      return briefReply(briefs.cancel(String(params.id)));
    }),
    http.get('*/api/briefs/:id/steps/:n/cases/:ntsbNo', async ({ params }) => {
      await wait();
      return briefReply(briefs.context(String(params.id), Number(params.n), String(params.ntsbNo)));
    }),
    http.get('*/api/briefs/:id', async ({ request, params }) => {
      await wait();
      const step = new URL(request.url).searchParams.get('step');
      return briefReply(briefs.read(String(params.id), step === null ? undefined : Number(step)));
    }),
  ];
}
