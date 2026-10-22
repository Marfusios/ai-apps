/** `GET /api/dashboard?cohort=default|all`: corpus aggregates, cached per dataset revision and cohort. */
import type { FastifyInstance } from 'fastify';
import { DashboardRequestSchema, type DashboardResponse } from '../../shared/contracts/dashboard.js';
import { issuesOf, sendError, sendJson } from '../http/reply.js';
import { buildDashboard } from '../search/dashboard.js';
import { PUBLIC_CACHE, type ApiContext } from './context.js';

export function dashboardRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // Keyed `<revision>|<cohort>`; only the current revision's entries are kept.
  const cache = new Map<string, Promise<DashboardResponse>>();

  app.get('/api/dashboard', async (request, reply) => {
    const parsed = DashboardRequestSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', { message: 'The dashboard parameters are not valid.', issues: issuesOf(parsed.error.issues) });
    }
    const pinned = await ctx.datasets.current();
    const key = `${pinned.dataset.revision}|${parsed.data.cohort}`;
    let pending = cache.get(key);
    if (!pending) {
      for (const k of cache.keys()) if (!k.startsWith(`${pinned.dataset.revision}|`)) cache.delete(k);
      pending = buildDashboard(ctx, pinned, parsed.data.cohort);
      cache.set(key, pending);
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    const body = await pending;
    return sendJson(request, reply, body, { cacheControl: PUBLIC_CACHE, etagPrefix: pinned.dataset.revision });
  });
}
