/**
 * `GET /api/health`: whether the database and the active manifest's cases index can
 * be reached. 200 when both answer, 503 otherwise. It reports states only: no
 * addresses, index names, versions or error messages.
 *
 * The probe result is shared for `HEALTH_CACHE_MS` (concurrent callers wait for one
 * probe), so the endpoint cannot be used to hammer PostgreSQL or Elasticsearch; callers
 * other than the container's loopback check are also rate limited (server/app.ts).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { JSON_TYPE } from '../http/reply.js';
import { DatasetUnavailableError } from '../dataset.js';
import type { ApiContext } from './context.js';

export const HEALTH_CACHE_MS = 2_000;

type Check = 'ok' | 'error';

interface Health {
  status: 'ok' | 'unavailable';
  database: Check;
  search: Check | 'no_dataset';
}

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(ctx: ApiContext): Promise<Health> {
  let database: Check = 'ok';
  let search: Health['search'] = 'ok';
  try {
    await within(2_000, ctx.db.execute(sql`select 1`));
  } catch {
    database = 'error';
  }
  if (database === 'ok') {
    try {
      const pinned = await within(3_000, ctx.datasets.current());
      await within(2_000, ctx.es.count({ index: pinned.manifest.casesIndex }));
    } catch (err) {
      search = err instanceof DatasetUnavailableError ? 'no_dataset' : 'error';
      ctx.log.warn({ err: { name: (err as Error).name } }, 'health: search check failed');
    }
  } else {
    search = 'error';
  }
  return { status: database === 'ok' && search === 'ok' ? 'ok' : 'unavailable', database, search };
}

export function healthRoutes(app: FastifyInstance, ctx: ApiContext, cacheMs = HEALTH_CACHE_MS): void {
  let last: { at: number; result: Promise<Health> } | null = null;

  app.get('/api/health', async (_request, reply) => {
    const now = Date.now();
    if (!last || now - last.at >= cacheMs) last = { at: now, result: probe(ctx) };
    const health = await last.result;
    return reply
      .code(health.status === 'ok' ? 200 : 503)
      .header('cache-control', 'no-store')
      .type(JSON_TYPE)
      .send(JSON.stringify(health));
  });
}
