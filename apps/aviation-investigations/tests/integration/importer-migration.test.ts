import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {sql} from 'drizzle-orm';
import {createDb,closeDb} from '../../server/db/client.js';
import {withScratchEnvironment,localAdminUrl} from '../../scripts/scratch-env.js';
import {runMigrations} from '../../server/db/migrate.js';
import {withImportSession,fenced,budgetRemaining,artifact} from '../../worker/importer/store.js';

it('0029 preserves a pre-migration review, pending file and money; reapplying it changes nothing',async()=>withScratchEnvironment(localAdminUrl(),'importupgrade',async urls=>{
 const db=createDb(urls.ingest),owner=createDb(urls.migrator),app=createDb(urls.app);
 try {
 let id='';
 await withImportSession(db,s=>fenced(owner,s,async tx=>{
  const r=(await tx.execute(sql`insert into import_artifacts(environment,archive_sha256,content_sha256,attempts,needs_review,reason,baseline,first_reservation_at)
    values('dev',${'a'.repeat(64)},${'b'.repeat(64)},3,true,'cohort_bounds',${JSON.stringify({generationId:1,casesIndex:'synthetic-cases',passagesIndex:'synthetic-passages',publishedAt:'2026-11-01T05:30:00Z'})}::jsonb,clock_timestamp()) returning id`)).rows[0]!;id=String(r.id);
  const run=(await tx.execute(sql`insert into import_runs(mode,result,reason,finished_at,artifact_id) values('automatic','needs_review','cohort_bounds',clock_timestamp(),${id}::uuid) returning id`)).rows[0]!;
  const pending={archive:'a'.repeat(64),content:'b'.repeat(64),observation:{advertisedAtLocal:'2026-11-01T07:30:00',bytes:100},fetchedAt:'2026-11-01T05:30:00Z',runId:run.id,artifactId:id,attempts:3,needsReview:true,reason:'cohort_bounds'};
  await tx.execute(sql`select import_set_pending(${s.fence}::uuid,${JSON.stringify(pending)}::jsonb,true)`);
 }));
 const before=(await owner.execute(sql`select to_jsonb(a) value from import_artifacts a`)).rows;
 const pending=(await owner.execute(sql`select pending from import_control`)).rows;
 await runMigrations(urls.migrator);
 const migration=await readFile('server/db/migrations/0029_automatic_import.sql','utf8');
 await owner.transaction(async tx=>{for(const statement of migration.split('--> statement-breakpoint'))if(statement.trim())await tx.execute(sql.raw(statement));});
 expect((await owner.execute(sql`select to_jsonb(a) value from import_artifacts a`)).rows).toEqual(before);
 expect((await owner.execute(sql`select pending from import_control`)).rows).toEqual(pending);
 expect((await owner.execute(sql`select count(*)::int n from import_processing`)).rows[0]!.n).toBe(1);
 await withImportSession(db,async s=>{expect(await budgetRemaining(db,s,id)).toBe(2);expect((await artifact(db,id)).phase).toBe('building');});
 for(const table of ['import_processing','import_issues'])await expect(app.execute(sql.raw(`select * from ${table}`))).rejects.toThrow();
 expect((await owner.execute(sql`select count(*)::int n from pg_proc where proname in ('import_approve_pending','import_acknowledge_preartifact','import_rebaseline','import_resolve_abandoned_fetch')`)).rows[0]!.n).toBe(0);
 }finally{await Promise.all([closeDb(db),closeDb(owner),closeDb(app)]);}
},{upTo:'0028_importer_recovery'}));
