/**
 * MSW handlers for the public API, answered from the fixture-built mock files in
 * `web/mock/` (scripts/build-mock-api.ts). Used by the dev mock mode
 * (`WEB_MOCK_API=1`), the component tests and the end-to-end tests. Never part of
 * a production bundle.
 */
import { delay, http, HttpResponse } from 'msw';
import type { CaseDetail } from '../../../shared/contracts/cases';
import type { ErrorResponse } from '../../../shared/contracts/common';
import { SearchRequestSchema, paramsToQuery } from '../../../shared/contracts/search';
import cases from '../../mock/cases.json';
import config from '../../mock/config.json';
import dashboardAll from '../../mock/dashboard-all.json';
import dashboardDefault from '../../mock/dashboard-default.json';
import index from '../../mock/search-index.json';
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
}

export function createHandlers({ latencyMs = 0 }: HandlerOptions = {}) {
  const wait = async (): Promise<void> => {
    if (latencyMs > 0) await delay(latencyMs);
  };
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
  ];
}
