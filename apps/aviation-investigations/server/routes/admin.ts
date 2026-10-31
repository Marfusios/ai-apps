import type { FastifyInstance } from 'fastify';
import { adminOverview, AdminOverviewLimitError, AdminOverviewTimeoutError, type AdminSettings } from '../admin/overview.js';
import { isAdmin } from '../auth/admin.js';
import { JSON_TYPE, sendError } from '../http/reply.js';
import type { ApiContext } from './context.js';

export function adminRoutes(app: FastifyInstance, ctx: ApiContext, settings: AdminSettings): void {
  app.get('/api/admin/overview', async (request, reply) => {
    const signed = ctx.auth ? await ctx.auth.signedIn(request.headers.cookie) : null;
    if (!(await isAdmin(ctx.db, signed, settings.emails))) return sendError(reply, 404, 'not_found');
    try {
      return reply.type(JSON_TYPE).send(JSON.stringify(await adminOverview(ctx, settings)));
    } catch (error) {
      if (!(error instanceof AdminOverviewLimitError || error instanceof AdminOverviewTimeoutError)) throw error;
      request.log.warn({ category: error.category }, 'admin overview unavailable');
      return sendError(reply, 503, 'unavailable');
    }
  });
}
