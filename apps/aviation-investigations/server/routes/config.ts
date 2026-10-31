/** `GET /api/config`: public client configuration and coverage facts. */
import type { FastifyInstance } from 'fastify';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import { sendJson } from '../http/reply.js';
import { PUBLIC_CACHE, type ApiContext } from './context.js';

export function configRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/config', async (request, reply) => {
    const pinned = await ctx.datasets.current();
    const automaticField = ctx.ai?.evidenceAutoFilters?.field;
    const body = ConfigResponseSchema.parse({
      // The widget's site key once the anonymous gate is configured.
      turnstileSiteKey: ctx.ai?.gate?.siteKey ?? null,
      // Sign-in is offered only while Google sign-in is configured (server/auth/better-auth.ts).
      googleEnabled: ctx.auth !== null,
      aiAutomaticFilters: automaticField ? [automaticField] : [],
      aiLimits: { anonymousDaily: ctx.ai?.policy?.limits.trialRequests ?? 10, accountDaily: ctx.ai?.policy?.limits.accountDailyRequests ?? 50,
        newAccountDaily: ctx.ai?.policy?.limits.newAccountDailyRequests ?? 20, newAccountDays: ctx.ai?.policy?.limits.newAccountDays ?? 3,
        accountMonthly: ctx.ai?.policy?.limits.accountMonthlyRequests ?? 600, reset: '00:00 UTC', pageSize: 10, candidateCeiling: 100,
        briefsEnabled: ctx.briefsEnabled === true },
      snapshotDate: pinned.dataset.snapshotDate,
      datasetRevision: pinned.dataset.revision,
      coverage: pinned.coverage,
    });
    return sendJson(request, reply, body, { cacheControl: PUBLIC_CACHE, etagPrefix: pinned.dataset.revision });
  });
}
