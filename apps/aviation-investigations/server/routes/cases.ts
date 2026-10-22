/**
 * `GET /api/cases/:ntsbNo`: one investigation from PostgreSQL for the active
 * manifest's generation, NTSB data only, validated against `CaseDetailSchema`
 * (strict objects, no AI fields, the A3 section-scope rule) before it is sent.
 */
import type { FastifyInstance } from 'fastify';
import { CaseDetailSchema } from '../../shared/contracts/cases.js';
import { NtsbNoSchema } from '../../shared/contracts/common.js';
import { readCaseDetail } from '../db/queries/case-views.js';
import { sendError, sendJson } from '../http/reply.js';
import { PUBLIC_CACHE, type ApiContext } from './context.js';

const NOT_FOUND = 'No investigation has that number.';

export function caseRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Params: { ntsbNo: string } }>('/api/cases/:ntsbNo', async (request, reply) => {
    const number = NtsbNoSchema.safeParse(String(request.params.ntsbNo ?? '').trim().toUpperCase());
    if (!number.success) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const pinned = await ctx.datasets.current();
    const detail = await readCaseDetail(ctx.db, pinned.manifest.generationId, number.data, {
      dataset: pinned.dataset,
      citationTextVersion: pinned.manifest.citationTextVersion,
      fieldNormalizationVersion: pinned.fieldNormalizationVersion,
      mappingVerified: pinned.manifest.mappingVerified,
    });
    if (!detail) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const valid = CaseDetailSchema.safeParse(detail);
    if (!valid.success) {
      request.log.error(
        { issues: valid.error.issues.slice(0, 5).map((i) => i.path.join('.')) },
        'case detail failed its contract',
      );
      return sendError(reply, 500, 'internal');
    }
    return sendJson(request, reply, valid.data, { cacheControl: PUBLIC_CACHE, etagPrefix: pinned.dataset.revision });
  });
}
