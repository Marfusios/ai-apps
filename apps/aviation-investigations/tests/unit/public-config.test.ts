/** Public policy disclosure and cache rollback, without database or provider calls. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import type { EvidenceAutoFilterVersion } from '../../shared/evidence-auto-filters.js';
import { autoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { configRoutes } from '../../server/routes/config.js';
import type { ApiContext } from '../../server/routes/context.js';

async function config(policy: EvidenceAutoFilterVersion | null, etag?: string) {
  const app = Fastify();
  configRoutes(app, { auth: null, ai: policy === null ? null : { evidenceAutoFilters: autoFilterPolicy(policy) },
    datasets: { current: async () => ({ dataset: { snapshotDate: '2026-10-16', revision: 'g1-test' },
      coverage: { defaultCohort: 1, otherRecords: 0, yearFrom: 2008, yearTo: 2026, provisional: true } }) },
  } as unknown as ApiContext);
  try {
    return await app.inject({ url: '/api/config', headers: etag ? { 'if-none-match': etag } : {} });
  } finally { await app.close(); }
}

describe('public automatic-filter policy', () => {
  it.each([
    [null, []], ['none', []], ['state-explicit.v1.2', ['state']],
  ] as const)('reports the fields of the active %s policy', async (policy, expected) => {
    const response = await config(policy);
    expect(response.statusCode).toBe(200);
    expect(ConfigResponseSchema.parse(response.json()).aiAutomaticFilters).toEqual(expected);
  });
  it('changes the ETag when the policy rolls back on an unchanged dataset', async () => {
    const active = await config('state-explicit.v1.2');
    const rollback = await config('none', String(active.headers.etag));
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().datasetRevision).toBe(active.json().datasetRevision);
    expect(rollback.json().aiAutomaticFilters).toEqual([]);
    expect(rollback.headers.etag).not.toBe(active.headers.etag);
    expect(rollback.headers['cache-control']).toBe('public, max-age=300');
    expect((await config('none', String(rollback.headers.etag))).statusCode).toBe(304);
  });
  it('requires an array of enabled fields, with no unknown or duplicate fields', async () => {
    const body = (await config('none')).json();
    for (const aiAutomaticFilters of [undefined, null, 'state', ['none'], ['country'], ['state', 'state']]) {
      expect(ConfigResponseSchema.safeParse({ ...body, aiAutomaticFilters }).success).toBe(false);
    }
  });
});
