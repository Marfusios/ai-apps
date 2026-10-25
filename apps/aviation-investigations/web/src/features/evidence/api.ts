/**
 * Client for the AI evidence view's endpoints (shared/contracts/evidence.ts, `evidence.v3`).
 * A stored search is private to its owner: every read is `no-store` on the server, goes
 * through `privateRead` (dropped if the visitor changes while it is on its way) and lives in
 * the private `evidence` query namespace (web/src/features/auth/visitor.ts). Kept out of the
 * entry chunk: it loads with the first AI request or the evidence page.
 */
import { queryOptions } from '@tanstack/react-query';
import { CaseDetailSchema } from '../../../../shared/contracts/cases';
import { CreateEvidenceResponseSchema, EvidencePageSchema, type CreateEvidenceRequest, type CreateEvidenceResponse } from '../../../../shared/contracts/evidence';
import { READ_TIMEOUT_MS, getJson, postJson, retry } from '../../api';
import { privateRead } from '../auth/visitor';

/**
 * `GET /api/evidence/:id?page=n`: free, from the pinned ranking, so a page never changes while
 * the search lives. A read that gets no answer gives up after `READ_TIMEOUT_MS`.
 */
export const evidencePageQuery = (id: string, page: number) =>
  queryOptions({
    // The same key as `evidencePageKey` (web/src/features/evidence/keys.ts), which the ask seeds page 1 under.
    queryKey: ['evidence', id, page] as const,
    queryFn: ({ signal }) =>
      privateRead(() => getJson(`/api/evidence/${encodeURIComponent(id)}?page=${page}`, EvidencePageSchema, signal, { timeoutMs: READ_TIMEOUT_MS })),
    staleTime: Infinity,
    retry,
  });

/**
 * `GET /api/evidence/:id/cases/:ntsbNo`: a case the search ranked, at the search's own dataset
 * generation, for "Show the full section". Its sections' `revision`s are the ones the excerpts
 * name, so a paragraph's offsets hold; the public case (`GET /api/cases/:ntsbNo`) is the active
 * generation's and never resolves an excerpt. Private like the pages (`evidence-case`).
 */
export const evidenceCaseQuery = (id: string, ntsbNo: string) =>
  queryOptions({
    queryKey: ['evidence-case', id, ntsbNo] as const,
    queryFn: ({ signal }) =>
      privateRead(() => getJson(`/api/evidence/${encodeURIComponent(id)}/cases/${encodeURIComponent(ntsbNo)}`, CaseDetailSchema, signal, { timeoutMs: READ_TIMEOUT_MS })),
    staleTime: Infinity,
    retry,
  });

/**
 * `POST /api/evidence` for the visitor generation `visitor` the request started under: never
 * sent once that visitor signed out or deleted the account (`VisitorChangedError`).
 */
export async function createEvidence(request: CreateEvidenceRequest, visitor: number): Promise<CreateEvidenceResponse> {
  return (await postJson('/api/evidence', request, CreateEvidenceResponseSchema, visitor)) as CreateEvidenceResponse;
}
