import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture } from '../support/importer.js';
import { readImportStatus } from '../../server/db/import-status.js';

const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
it('a normal pending switch has no alert; only unresolved unknowns hold the status', async () =>
  importerFixture(async (f) => {
    const original = f.resources.es.indices.updateAliases.bind(f.resources.es.indices);
    let checked = 0;
    f.resources.es.indices.updateAliases = (async (
      ...args: Parameters<typeof original>
    ) => {
      const pending = await f.owner.execute(sql`select a.id from import_index_refs r
    join index_switch_attempts a on a.index_name=r.index_name
    where r.released_at is null and a.outcome='pending'`);
      if (pending.rows.length) {
        checked++;
        expect((await readImportStatus(f.app, schedule)).alert).toBeNull();
      }
      return original(...args);
    }) as typeof f.resources.es.indices.updateAliases;
    expect((await f.run()).result).toBe('published');
    expect(checked).toBeGreaterThan(0);
    const inserted = await f.owner
      .execute(sql`insert into index_switch_attempts(alias,index_name,outcome,resolved_at)
   select alias,index_name,'unknown',clock_timestamp() from index_switch_attempts a
   where exists(select 1 from import_index_refs r where r.index_name=a.index_name and r.released_at is null)
   limit 1 returning id`);
    expect(inserted.rows).toHaveLength(1);
    expect((await readImportStatus(f.app, schedule)).alert).toMatchObject({
      cause: 'alias_unknown',
      siteState: 'uncertain',
    });
    await f.owner
      .execute(sql`update index_switch_attempts set declared_abandoned_at=clock_timestamp(),declared_reason='offline fixture'
   where id=${inserted.rows[0]!.id}`);
    expect((await readImportStatus(f.app, schedule)).alert).toBeNull();
  }));
