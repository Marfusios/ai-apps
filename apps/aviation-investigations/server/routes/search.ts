/** `GET /api/search`: keyword search with disjunctive facets. */
import type { FastifyInstance } from 'fastify';
import { SearchRequestSchema } from '../../shared/contracts/search.js';
import { issuesOf, sendError, sendJson } from '../http/reply.js';
import { startRequestSpan } from '../observability/tracing.js';
import { keywordSearch } from '../search/keyword.js';
import { SEARCH_CACHE, type ApiContext } from './context.js';

const status = (err: unknown): number | undefined => (err as { meta?: { statusCode?: number } }).meta?.statusCode;

export function searchRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/search', async (request, reply) => {
    const parsed = SearchRequestSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', {
        message: 'The search parameters are not valid.',
        issues: issuesOf(parsed.error.issues),
      });
    }
    const pinned = await ctx.datasets.current();
    try {
      const body = await startRequestSpan(
        'api.search',
        { stage: 'keyword', datasetGeneration: String(pinned.manifest.generationId), indexVersion: pinned.indexVersion },
        async (span) => {
          const result = await keywordSearch(ctx, pinned, parsed.data);
          span.setAttrs({ caseCount: result.total, outcome: 'ok' });
          return result;
        },
      );
      return sendJson(request, reply, body, { cacheControl: SEARCH_CACHE });
    } catch (err) {
      // A query the engine refuses (e.g. too many clauses from a very long text) is the request's problem.
      if (status(err) === 400) {
        request.log.warn({ err: { name: (err as Error).name } }, 'search refused by Elasticsearch');
        return sendError(reply, 400, 'bad_request', { message: 'The search could not be run. Try fewer words or phrases.' });
      }
      throw err;
    }
  });
}
