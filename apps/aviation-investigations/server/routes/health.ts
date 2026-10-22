/**
 * `GET /api/health`: whether the database and the active manifest's cases index can
 * be reached. 200 when both answer, 503 otherwise. It reports states only: no
 * addresses, index names, versions or error messages.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { JSON_TYPE } from '../http/reply.js';
import { DatasetUnavailableError } from '../dataset.js';
import type { ApiContext } from './context.js';

type Check = 'ok' | 'error';

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

export function healthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/health', async (request, reply) => {
    let database: Check = 'ok';
    let search: Check | 'no_dataset' = 'ok';
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
        request.log.warn({ err: { name: (err as Error).name } }, 'health: search check failed');
      }
    } else {
      search = 'error';
    }
    const ok = database === 'ok' && search === 'ok';
    return reply
      .code(ok ? 200 : 503)
      .header('cache-control', 'no-store')
      .type(JSON_TYPE)
      .send(JSON.stringify({ status: ok ? 'ok' : 'unavailable', database, search }));
  });
}
