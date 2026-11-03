/**
 * The search checklist's client (UI_DESIGN §4.10): the progress of a search on its way. Its own
 * module, apart from the search client (web/src/features/evidence/api.ts), so that loading the
 * checklist as an AI request starts never loads (or holds up) the client the request sends with.
 */
import { queryOptions, type Query } from '@tanstack/react-query';
import { EvidenceProgressSchema, type EvidenceProgress } from '../../../../shared/contracts/evidence';
import { ApiError, getJson } from '../../api';
import { VisitorChangedError, privateRead, visitorGeneration } from '../auth/visitor';
import { PROGRESS_READ_TIMEOUT_MS, progressPollDelay, progressRetryAfterMs } from './checklist';

/**
 * The searches whose progress the server asked to wait for (a 429), by key: until when (the
 * server's own deadline, however long), and that refusal. The latest few only.
 */
const held = new Map<string, { until: number; refusal: ApiError }>();
const HELD_KEYS = 16;

/**
 * One read of a search's progress, for the visitor it was sent for (`visitor`: their generation).
 * Once the visitor has changed nothing is sent: it is the previous visitor's search. Within a
 * 429's wait, whatever asks for the read (the schedule, a reset, a replay of the same key), it gets
 * that refusal again and nothing is sent: the server is never asked sooner than it said. Once the
 * wait has passed, a replay of the key reads again.
 */
async function readProgress(key: string, visitor: number, signal: AbortSignal): Promise<EvidenceProgress> {
  if (visitorGeneration() !== visitor) throw new VisitorChangedError('the visitor changed since this search was sent');
  const wait = held.get(key);
  if (wait !== undefined) {
    if (Date.now() < wait.until) throw wait.refusal;
    held.delete(key);
  }
  try {
    return await getJson(`/api/evidence/progress/${encodeURIComponent(key)}`, EvidenceProgressSchema, signal, { timeoutMs: PROGRESS_READ_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      held.delete(key);
      held.set(key, { until: Date.now() + progressRetryAfterMs(err), refusal: err });
      if (held.size > HELD_KEYS) held.delete(held.keys().next().value as string);
    }
    throw err;
  }
}

/**
 * `GET /api/evidence/progress/:key`: how far the visitor's own search, sent under the idempotency
 * key `key` by the visitor of generation `visitor`, has got (the search checklist, UI_DESIGN
 * §4.10). Read about every 500 ms while it runs (`progressPollDelay`), 404s included (the server
 * registers a search a moment after it arrives), by the checklist only, which goes once the
 * search's POST settles or the visitor changes. Private like the pages (`evidence-progress`), and
 * never kept once the checklist is gone.
 */
export const evidenceProgressQuery = (key: string, visitor: number) =>
  queryOptions({
    queryKey: ['evidence-progress', key] as const,
    queryFn: ({ signal }) => privateRead(() => readProgress(key, visitor, signal)),
    refetchInterval: (query: Query<EvidenceProgress, Error, EvidenceProgress, readonly unknown[]>) => progressPollDelay(query),
    // The schedule above is the only way it reads again: no retry, and no re-read on focus or
    // reconnect, which could come sooner than a `Retry-After` allows (`readProgress` holds any
    // other read, such as a reset's, until it has passed).
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
