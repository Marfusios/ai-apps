/**
 * The search checklist's client (UI_DESIGN §4.10): the progress of a search on its way. Its own
 * module, apart from the search client (web/src/features/evidence/api.ts), so that loading the
 * checklist as an AI request starts never loads (or holds up) the client the request sends with.
 */
import { queryOptions, type Query } from '@tanstack/react-query';
import { EvidenceProgressSchema, type EvidenceProgress } from '../../../../shared/contracts/evidence';
import { getJson } from '../../api';
import { privateRead } from '../auth/visitor';
import { PROGRESS_READ_TIMEOUT_MS, progressPollDelay } from './checklist';

/**
 * `GET /api/evidence/progress/:key`: how far the visitor's own search, sent under the idempotency
 * key `key`, has got (the search checklist, UI_DESIGN §4.10). Read about every 500 ms while it
 * runs (`progressPollDelay`), 404s included (the server registers a search a moment after it
 * arrives), by the checklist only, which goes once the search's POST settles. Private like the
 * pages (`evidence-progress`), and never kept once the checklist is gone.
 */
export const evidenceProgressQuery = (key: string) =>
  queryOptions({
    queryKey: ['evidence-progress', key] as const,
    queryFn: ({ signal }) =>
      privateRead(() => getJson(`/api/evidence/progress/${encodeURIComponent(key)}`, EvidenceProgressSchema, signal, { timeoutMs: PROGRESS_READ_TIMEOUT_MS })),
    refetchInterval: (query: Query<EvidenceProgress, Error, EvidenceProgress, readonly unknown[]>) => progressPollDelay(query),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
