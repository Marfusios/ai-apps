/** Bounded owner-only outage evidence; replay cannot erase committed success or reset spend. */
import { join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { ImportFailure, IMPORT_STEPS, IMPORT_REASONS, Sha256, SourceSchema, type ImportStep } from './contracts.js';
import { ManagedSpace, ownedPath } from './files.js';
import { privateJson } from './extraction.js';
import { beginRun, updateRun, fenced, withImportSession, type ImportSession } from './store.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { completedRun } from './durable.js';
import { suppressionKey } from './automatic.js';
import { digest } from './provenance.js';
import { localClock } from './status.js';

const Meta=z.object({code:z.string().regex(/^[0-9a-f]{40}$/),image:z.string().regex(/^sha256:[0-9a-f]{64}$/),archive:Sha256.nullable(),source:SourceSchema.nullable(),postSuccess:z.boolean().default(false),origin:z.enum(['dev','live','host']).optional(),originRunId:z.uuid().nullable().optional()});
export const OutageSchema=z.strictObject({version:z.union([z.literal(1),z.literal(2)]),recordedAt:z.iso.datetime(),runId:z.uuid().nullable(),artifactId:z.uuid().nullable(),
 step:z.enum(IMPORT_STEPS),reason:z.enum(IMPORT_REASONS),review:z.boolean().optional(),meta:Meta.optional()});
export type Outage=z.infer<typeof OutageSchema>;
export async function spoolFailure(space:ManagedSpace,environment:'dev'|'live',failure:ImportFailure,step:ImportStep,
 runId:string|null=null,artifactId:string|null=null,meta?:z.input<typeof Meta>):Promise<void> {
 const path=join(space.root,`status-${environment}.json`);await ownedPath(space.root,path);
 const previous=await privateJson(path).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT') return null;throw e;});
 if(previous!==null) {OutageSchema.parse(previous);return;}
 await space.json(path,OutageSchema.parse({version:2,recordedAt:new Date().toISOString(),runId,artifactId,step,reason:failure.reason,meta}));
}
export async function replayOutage(db:Db,s:ImportSession,space:ManagedSpace,environment:'dev'|'live',zone='Europe/Prague'):Promise<void> {
 const path=join(space.root,`status-${environment}.json`);await ownedPath(space.root,path);
 const raw=await privateJson(path).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT') return null;throw e;});
 if(raw===null)return;
 const parsed=OutageSchema.safeParse(raw);if(!parsed.success)throw new ImportFailure('integrity');
 const r=parsed.data,success=await completedRun(db,r.runId);
 const id=r.runId??await beginRun(db,s,'automatic');
 if(!r.runId)await space.json(path,{...r,runId:id});
 // Legacy failure evidence is retained as history, without resurrecting an approval latch.
 if(!success && !r.meta?.postSuccess)await updateRun(db,s,id,{step:r.step,result:'failed',reason:r.reason,artifactId:r.artifactId,sourceCheckSucceeded:false});
 if(r.meta) {
   const m=r.meta,post=!!success||m.postSuccess,fix=post?r.reason==='storage':new ImportFailure(r.reason).fix;
   const key=fix&&!post?suppressionKey(environment,m.archive,m.source,m.code,m.image):digest([id,post,r.reason]);
   await fenced(db,s,tx=>tx.execute(sql`insert into import_issues(key,run_id,artifact_id,code,image,archive_sha256,source,reason,step,origin,origin_run_id,fixed,post_success,failure_day,created_at,last_at)
     values(${key},${id}::uuid,${r.artifactId}::uuid,${m.code},${m.image},${m.archive},${m.source?JSON.stringify(m.source):null}::jsonb,
       ${r.reason},${r.step},${m.origin??environment},${m.originRunId??null}::uuid,${fix},${post},${localClock(new Date(r.recordedAt),zone).day},${r.recordedAt}::timestamptz,${r.recordedAt}::timestamptz)
     on conflict(key) do nothing`));
 }
 await unlink(path);const dir=await open(space.root,'r');try{await dir.sync();}finally{await dir.close();}
}
export const SkipSchema=z.strictObject({reason:z.enum(IMPORT_REASONS),step:z.enum(IMPORT_STEPS),runId:z.uuid().nullable(),
 source:SourceSchema.nullable(),archive:Sha256.nullable(),fixed:z.boolean(),code:z.string().regex(/^[0-9a-f]{40}$/),image:z.string().regex(/^sha256:[0-9a-f]{64}$/)});
export type Skip=z.infer<typeof SkipSchema>;
export async function recordSkippedLive(config:ImporterConfig,skip:Skip):Promise<void> {
 const cfg=environmentConfig(config,'live'),space=new ManagedSpace(config.root),db=createDb(cfg.databaseIngestUrl!,{max:2,applicationName:'aviation-import-skip'});
 try {await withImportSession(db,async s=> {
   await replayOutage(db,s,space,'live',config.schedule.timeZone);const id=await beginRun(db,s,'automatic',config.schedule.timeZone);
   await updateRun(db,s,id,{step:skip.step,result:'skipped_dev_failed',reason:skip.reason,source:skip.source,observedSha256:skip.archive??undefined,sourceCheckSucceeded:false});
   const key=skip.fixed?suppressionKey('live',skip.archive,skip.source,skip.code,skip.image):digest([id,skip.reason]);
   await fenced(db,s,async tx=> {
     await tx.execute(sql`update import_runs set code=${skip.code},image=${skip.image},origin='dev' where id=${id}::uuid`);
     await tx.execute(sql`insert into import_issues(key,run_id,code,image,archive_sha256,source,reason,step,origin,origin_run_id,fixed,failure_day)
       values(${key},${id}::uuid,${skip.code},${skip.image},${skip.archive},${skip.source?JSON.stringify(skip.source):null}::jsonb,
       ${skip.reason},${skip.step},'dev',${skip.runId}::uuid,${skip.fixed},${localClock(new Date(),config.schedule.timeZone).day})
       on conflict(key) do update set last_at=clock_timestamp(),resolved_at=null`);
   });
 });}catch {await spoolFailure(space,'live',new ImportFailure(skip.reason),skip.step,null,null,{code:skip.code,image:skip.image,archive:skip.archive,source:skip.source,origin:'dev',originRunId:skip.runId});}
 finally{await closeDb(db);}
}
