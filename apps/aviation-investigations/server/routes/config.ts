/** `GET /api/config`: public client configuration and coverage facts. */
import type { FastifyInstance } from 'fastify';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import { sendJson } from '../http/reply.js';
import { PUBLIC_CACHE, type ApiContext } from './context.js';

export function configRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/config', async (request, reply) => {
    const pinned = await ctx.datasets.current();
    const body = ConfigResponseSchema.parse({
      // AI requests are not offered yet: no Turnstile challenge, no Google sign-in.
      turnstileSiteKey: null,
      googleEnabled: false,
      snapshotDate: pinned.dataset.snapshotDate,
      datasetRevision: pinned.dataset.revision,
      coverage: pinned.coverage,
    });
    return sendJson(request, reply, body, { cacheControl: PUBLIC_CACHE, etagPrefix: pinned.dataset.revision });
  });
}
