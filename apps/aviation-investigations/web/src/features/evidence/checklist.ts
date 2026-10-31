/**
 * The search checklist (UI_DESIGN §4.10, Task 25): what an AI search is doing while `POST
 * /api/evidence` runs, read from `GET /api/evidence/progress/:key` (contract
 * `EvidenceProgressSchema`): the question, the search and the order of the leading results, each
 * row filling in its result as its stage ends. Statuses and counts only: nothing here is model
 * text. The copy is Builder copy for the owner's review.
 */
import type { EvidenceProgress } from '../../../../shared/contracts/evidence';
import { ApiError } from '../../api';
import { formatCount } from '../../lib/format';

// ---------------------------------------------------------------------------
// Builder copy (Task 25), for the owner's review.

export const SEARCH_CHECKLIST_TITLE = 'Search checklist';
export const SEARCH_CHECKLIST_NOTE = 'AirCase shows NTSB investigations; nothing is written by AI. Usually 5–10 seconds.';

/** The rows' challenges ("Search 24,291 investigations": the default cohort from `/api/config`). */
export const CHALLENGES = {
  question: 'Question',
  search: (cohort: number | null): string => (cohort === null ? 'Search investigations' : `Search ${formatCount(cohort)} investigations`),
  order: 'Order the leading results',
} as const;

/** The rows' results, in the checklist's capitals. */
export const RESULTS = {
  suggestions: 'READ · SUGGESTIONS READY',
  nothingToSuggest: 'READ · NOTHING TO SUGGEST',
  note: 'NOTE ADDED',
  unavailable: 'NOT AVAILABLE',
  /** The question row of an edited search, which reads no question. */
  yourEdit: 'SKIPPED · YOUR EDIT',
  /** The question row when the server skipped the question stage of a question search. */
  skipped: 'SKIPPED',
  /** The search row when the server gave no count. */
  done: 'DONE',
  aiOrder: 'ORDERED BY AI',
  matchOrder: 'MATCH ORDER',
  /** The order row when the configuration has no AI ordering, or it was skipped. */
  notUsed: 'NOT USED',
  failed: 'DIDN’T FINISH',
  inProgress: 'IN PROGRESS',
  notYet: '—',
} as const;

/** What the polite live region says as each row completes (skipped rows are not announced). */
export const SPOKEN = {
  suggestions: 'Question read: suggestions ready.',
  nothingToSuggest: 'Question read: nothing to suggest.',
  note: 'Question read: note added.',
  unavailable: 'Question: suggestions not available.',
  searched: (cases: number): string => `Search done: ${formatCount(cases)} ${cases === 1 ? 'case' : 'cases'}.`,
  aiOrder: 'Leading results ordered by AI.',
  matchOrder: 'Leading results kept in match order.',
  failed: 'The search didn’t finish.',
} as const;

// ---------------------------------------------------------------------------
// Reading the progress

/** The progress is read about this often while the search runs. */
export const PROGRESS_POLL_MS = 500;
/**
 * A 404 is normal while the server has not registered the search yet (it does once the Turnstile
 * check and admission are through, a second or two after the request left), and stays possible
 * through the whole search (a network identity that changed meanwhile): the progress is read again
 * every `PROGRESS_POLL_MS` until this many 404s in a row, then every `PROGRESS_SLOW_POLL_MS`, for as
 * long as the search's POST runs.
 */
export const PROGRESS_NOT_FOUND_BEFORE_SLOWING = 10;
export const PROGRESS_SLOW_POLL_MS = 1_000;
/** Reads that fail otherwise are tried again, later each time, up to this pause. */
export const PROGRESS_MAX_BACKOFF_MS = 4_000;
/**
 * The longest `Retry-After` the checklist waits out: a longer one (the server's limit for this
 * network) ends the reading, and the card stays as it is until the search's POST settles. It never
 * reads sooner than the server asks.
 */
export const PROGRESS_LONGEST_RETRY_AFTER_MS = 30_000;
/** A read that gets no answer in this long counts as failed: the next one is more use. */
export const PROGRESS_READ_TIMEOUT_MS = 4_000;

/** The query state the schedule reads (a TanStack `Query` satisfies it). */
export interface ProgressPollState {
  state: {
    data: EvidenceProgress | undefined;
    status: 'pending' | 'error' | 'success';
    error: unknown;
    dataUpdatedAt: number;
    errorUpdateCount: number;
  };
}

/**
 * Failed reads since the last good one. Derived from the query's own counters (the schedule is
 * computed many times per update, so it must not count by itself), as the brief poll does
 * (web/src/features/brief/api.ts).
 */
const sinceGood = new WeakMap<object, { dataUpdatedAt: number; errors: number }>();
function consecutiveFailures(query: ProgressPollState): number {
  const { dataUpdatedAt, errorUpdateCount, status } = query.state;
  let mark = sinceGood.get(query);
  if (!mark || mark.dataUpdatedAt !== dataUpdatedAt) {
    // A good read since the last look (or the first look): failures count from it. A query that
    // never succeeded counts from zero; one first seen failing, from just before that failure.
    const before = status === 'error' ? Math.max(0, errorUpdateCount - 1) : errorUpdateCount;
    mark = { dataUpdatedAt, errors: dataUpdatedAt === 0 ? 0 : before };
    sinceGood.set(query, mark);
  }
  return Math.max(0, errorUpdateCount - mark.errors);
}

/**
 * How long a 429 asks the progress to wait, in milliseconds: its whole `Retry-After` (without one,
 * the longest backoff), or `Infinity` when that is longer than `PROGRESS_LONGEST_RETRY_AFTER_MS`:
 * the checklist then reads no more.
 */
export function progressRetryAfterMs(refusal: ApiError): number {
  if (refusal.retryAfter === null) return PROGRESS_MAX_BACKOFF_MS;
  const wait = refusal.retryAfter * 1000;
  return wait > PROGRESS_LONGEST_RETRY_AFTER_MS ? Infinity : wait;
}

/**
 * When to read the progress again: every `PROGRESS_POLL_MS` while the search runs; never once it
 * has ended; after a 404, again (more slowly after `PROGRESS_NOT_FOUND_BEFORE_SLOWING` in a row);
 * after a 429, once its whole `Retry-After` has passed, or never when that is longer than
 * `PROGRESS_LONGEST_RETRY_AFTER_MS` (without one, after the longest backoff); after another
 * refusal, never; after a network or server failure, a little later each time. The checklist goes,
 * and with it the reading, as soon as the search's POST settles; its query re-reads nothing else
 * by itself (no focus, reconnect or retry re-read), and a read started any other way within a
 * 429's wait (a reset when the visitor changes) gets the same refusal without a request
 * (web/src/features/evidence/progress.ts).
 */
export function progressPollDelay(query: ProgressPollState): number | false {
  const { data, status, error } = query.state;
  // Always read, so a good read is remembered as the point failures count from.
  const failures = consecutiveFailures(query);
  if (data && data.state !== 'running') return false;
  if (status !== 'error') return PROGRESS_POLL_MS;
  if (error instanceof ApiError) {
    if (error.status === 404) return failures < PROGRESS_NOT_FOUND_BEFORE_SLOWING ? PROGRESS_POLL_MS : PROGRESS_SLOW_POLL_MS;
    if (error.status === 429) {
      // The whole wait, never shortened; one too long to be of use ends the reading.
      const wait = progressRetryAfterMs(error);
      return wait === Infinity ? false : wait;
    }
    if (error.status < 500) return false;
  }
  return Math.min(PROGRESS_MAX_BACKOFF_MS, PROGRESS_POLL_MS * 2 ** Math.min(4, Math.max(1, failures)));
}

// ---------------------------------------------------------------------------
// The rows

/** `done`: its result, with a tick (or none, for a stage that had nothing to give); `current`: under way; `todo`: not reached; `skipped`: not run, or not available. */
export type ChecklistTone = 'done' | 'current' | 'todo' | 'skipped';

export interface ChecklistRow {
  id: 'question' | 'search' | 'order';
  challenge: string;
  result: string;
  tone: ChecklistTone;
  /** The magenta ✓ of a completed stage. */
  tick: boolean;
  /** What the live region says once it is done; null for a row that is not announced. */
  spoken: string | null;
}

export interface ChecklistInput {
  kind: 'question' | 'edited';
  /** The latest progress read; null until the first good read (the card stays unticked). */
  progress: EvidenceProgress | null;
  /** The default cohort from `/api/config`, null while unknown. */
  cohort: number | null;
}

type Stage = EvidenceProgress['question']['status'];

const row = (id: ChecklistRow['id'], challenge: string, tone: ChecklistTone, result: string, tick = false, spoken: string | null = null): ChecklistRow => ({
  id,
  challenge,
  result,
  tone,
  tick,
  spoken,
});

/** A row whose stage has not ended: under way, or not reached. */
const open = (id: ChecklistRow['id'], challenge: string, current: boolean): ChecklistRow =>
  row(id, challenge, current ? 'current' : 'todo', current ? RESULTS.inProgress : RESULTS.notYet);

function questionRow(input: ChecklistInput, current: boolean): ChecklistRow {
  const challenge = CHALLENGES.question;
  if (input.kind === 'edited') return row('question', challenge, 'skipped', RESULTS.yourEdit);
  const q = input.progress?.question;
  if (!q || q.status === 'pending' || q.status === 'running') return open('question', challenge, current);
  if (q.status === 'skipped') return row('question', challenge, 'skipped', RESULTS.skipped);
  if (q.status === 'failed' || q.result === 'unavailable') return row('question', challenge, 'skipped', RESULTS.unavailable, false, SPOKEN.unavailable);
  if (q.result === 'note') return row('question', challenge, 'done', RESULTS.note, true, SPOKEN.note);
  if (q.result === 'nothing_to_suggest') return row('question', challenge, 'done', RESULTS.nothingToSuggest, true, SPOKEN.nothingToSuggest);
  return row('question', challenge, 'done', RESULTS.suggestions, true, SPOKEN.suggestions);
}

function searchRow(input: ChecklistInput, current: boolean): ChecklistRow {
  const challenge = CHALLENGES.search(input.cohort);
  const s = input.progress?.search;
  if (!s || s.status === 'pending' || s.status === 'running') return open('search', challenge, current);
  if (s.status === 'failed') return row('search', challenge, 'skipped', RESULTS.failed, false, SPOKEN.failed);
  if (s.status === 'skipped') return row('search', challenge, 'skipped', RESULTS.notUsed);
  const cases = s.cases;
  if (cases === null) return row('search', challenge, 'done', RESULTS.done, true, null);
  return row('search', challenge, 'done', `${formatCount(cases)} ${cases === 1 ? 'CASE' : 'CASES'}`, true, SPOKEN.searched(cases));
}

function orderRow(input: ChecklistInput, current: boolean): ChecklistRow {
  const challenge = CHALLENGES.order;
  const o = input.progress?.order;
  if (!o || o.status === 'pending' || o.status === 'running') return open('order', challenge, current);
  if (o.status === 'skipped') return row('order', challenge, 'skipped', RESULTS.notUsed);
  if (o.status === 'failed') return o.result === 'match' ? row('order', challenge, 'skipped', RESULTS.matchOrder) : row('order', challenge, 'skipped', RESULTS.failed);
  if (o.result === 'match') return row('order', challenge, 'done', RESULTS.matchOrder, true, SPOKEN.matchOrder);
  return row('order', challenge, 'done', RESULTS.aiOrder, true, SPOKEN.aiOrder);
}

/**
 * The three rows: the question (an edit's skips it), the search with its count of cases and the
 * order of the leading results. The current row is the stage under way (or, while the search
 * runs, the first not reached). Until the first good read the card is unticked: no row is
 * current, and only an edit's question row, which no search of its kind runs, says so.
 */
export function checklistRows(input: ChecklistInput): ChecklistRow[] {
  const p = input.progress;
  let current = -1;
  if (p) {
    const stages: Stage[] = [p.question.status, p.search.status, p.order.status];
    current = stages.indexOf('running');
    if (current < 0 && p.state === 'running') current = stages.indexOf('pending');
  }
  return [questionRow(input, current === 0), searchRow(input, current === 1), orderRow(input, current === 2)];
}

/** "0:07": the time since the request left, as the card's timer shows it. */
export function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What the live region says: the latest completion, so reads that bring nothing new say nothing new. */
export function checklistAnnouncement(rows: readonly ChecklistRow[]): string {
  return rows.filter((r) => r.spoken !== null && (r.tone === 'done' || r.tone === 'skipped')).at(-1)?.spoken ?? '';
}
