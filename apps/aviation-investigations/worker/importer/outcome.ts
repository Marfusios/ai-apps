/** Host-only, bounded dev failure metadata. No environment child reads another environment's DB. */
import { sql } from 'drizzle-orm';
import { createDb,closeDb } from '../../server/db/client.js';
import { environmentConfig,type ImporterConfig } from './config.js';
import { SkipSchema,type Skip } from './recovery.js';
export async function readDevOutcome(config:ImporterConfig):Promise<Skip> {
 const cfg=environmentConfig(config,'dev',true),db=createDb(cfg.databaseIngestUrl!,{max:1,applicationName:'aviation-import-host-outcome'});
 try {
  const r=(await db.execute(sql`select i.reason,i.step,r.id as "runId",i.source,i.archive_sha256 as archive,i.fixed,i.code,i.image
    from import_issues i left join import_runs r on r.id=i.run_id where i.resolved_at is null order by i.last_at desc limit 1`)).rows[0];
  if(r) return SkipSchema.parse(r);
  return {reason:'interrupted',step:'check',runId:null,source:null,archive:null,fixed:false,code:config.code,image:config.dev.image};
 }catch { return {reason:'interrupted',step:'check',runId:null,source:null,archive:null,fixed:false,code:config.code,image:config.dev.image}; }finally{await closeDb(db);}
}
