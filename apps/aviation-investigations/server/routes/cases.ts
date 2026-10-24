/**
 * `GET /api/cases/:ntsbNo`: one investigation from PostgreSQL for the active
 * manifest's generation, NTSB data only, validated against `CaseDetailSchema`
 * (strict objects, no AI fields, the A3 section-scope rule) before it is sent.
 * `findCase` is the lookup: the case page (server/routes/pages.ts) serves exactly the
 * cases this route answers 200 for.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { CaseDetailSchema, type CaseDetail } from '../../shared/contracts/cases.js';
import { NtsbNoSchema } from '../../shared/contracts/common.js';
import type { PinnedDataset } from '../dataset.js';
import { readCaseDetail } from '../db/queries/case-views.js';
import { sendError, sendJson } from '../http/reply.js';
import { PUBLIC_CACHE, type ApiContext } from './context.js';

const NOT_FOUND = 'No investigation has that number.';

/**
 * The case served for a requested number (trimmed, upper case) from the active dataset; null
 * when no case has it (404); `'invalid'` when the record fails its contract (logged; 500).
 * Throws when the dataset or the database is unavailable.
 */
export async function findCase(
  ctx: ApiContext,
  requested: string,
  log: FastifyBaseLogger,
): Promise<{ detail: CaseDetail; pinned: PinnedDataset } | 'invalid' | null> {
  const number = NtsbNoSchema.safeParse(requested.trim().toUpperCase());
  if (!number.success) return null;
  const pinned = await ctx.datasets.current();
  const detail = await readCaseDetail(ctx.db, pinned.manifest.generationId, number.data, {
    dataset: pinned.dataset,
    citationTextVersion: pinned.manifest.citationTextVersion,
    fieldNormalizationVersion: pinned.fieldNormalizationVersion,
    mappingVerified: pinned.manifest.mappingVerified,
  });
  if (!detail) return null;
  const valid = CaseDetailSchema.safeParse(detail);
  if (!valid.success) {
    log.error({ issues: valid.error.issues.slice(0, 5).map((i) => i.path.join('.')) }, 'case detail failed its contract');
    return 'invalid';
  }
  return { detail: valid.data, pinned };
}

export function caseRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Params: { ntsbNo: string } }>('/api/cases/:ntsbNo', async (request, reply) => {
    const found = await findCase(ctx, String(request.params.ntsbNo ?? ''), request.log);
    if (found === null) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    if (found === 'invalid') return sendError(reply, 500, 'internal');
    return sendJson(request, reply, found.detail, { cacheControl: PUBLIC_CACHE, etagPrefix: found.pinned.dataset.revision });
  });
}
