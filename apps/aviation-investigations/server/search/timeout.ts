/**
 * Elasticsearch search time limit for API requests. The body `timeout` stops each
 * shard's work after this long; a response that reports `timed_out` holds partial
 * counts, so it is never served: the API answers 503 instead (server/app.ts).
 * It is shorter than the API client's request timeout (10 s, server/main.ts).
 */
export const SEARCH_TIMEOUT = '5s';

export class SearchTimedOutError extends Error {
  constructor() {
    super('Elasticsearch search timed out; partial results are not served');
    this.name = 'SearchTimedOutError';
  }
}

/** Throws `SearchTimedOutError` for a search that ran out of time. */
export function assertComplete(response: { timed_out?: boolean }): void {
  if (response.timed_out === true) throw new SearchTimedOutError();
}
