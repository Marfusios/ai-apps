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

/** A search whose shard report is not whole: a shard failed or did not answer. Never served (503). */
export class SearchIncompleteError extends Error {
  constructor(
    readonly search: string,
    detail: string,
  ) {
    super(`Elasticsearch ${search} search is incomplete (${detail}); partial results are not served`);
    this.name = 'SearchIncompleteError';
  }
}

interface ShardReport {
  total?: number;
  successful?: number;
  skipped?: number;
  failed?: number;
  failures?: readonly unknown[];
}

/**
 * Throws `SearchTimedOutError` for a search that ran out of time and
 * `SearchIncompleteError` for one whose shards did not all succeed (task 22 S-M1). With
 * `allow_partial_search_results: false` in the request as well, "no partial results" holds
 * by construction, not only because the indices have one shard. (Retrieval applies the
 * same rule, `assertCompleteResponse` in server/search/hybrid.ts.)
 */
export function assertComplete(response: { timed_out?: boolean; _shards?: ShardReport }, search = 'keyword'): void {
  if (response.timed_out === true) throw new SearchTimedOutError();
  const s = response._shards;
  if (!s) return;
  const failed = Math.max(s.failed ?? 0, s.failures?.length ?? 0);
  if (failed > 0) throw new SearchIncompleteError(search, `${failed} shard(s) failed`);
  const skipped = s.skipped ?? 0;
  if (typeof s.total === 'number' && (s.successful !== s.total || skipped > (s.successful ?? 0))) {
    throw new SearchIncompleteError(search, `${s.successful ?? 0} of ${s.total} shard(s) successful`);
  }
}
