/** Automatic policy state. All writes retain the importer fence and original monetary identity. */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../server/db/client.js';
import { ImportFailure, sameManifest, type ManifestIdentity, type SourceObservation, type ImportReason, type ImportStep } from './contracts.js';
import { digest } from './provenance.js';
import { fenced, manifest, type ImportSession, type AcceptedSnapshot } from './store.js';
import type { ImportContext } from './runtime.js';
import { localClock } from './status.js';
import type { SnapshotFacts } from './provenance.js';
import { POLICY_VERSION } from './contracts.js';
import type { Comparison } from './compare.js';

export interface ServingCounts { total: number; eligible: number; us: number; sample: string; }
export async function servingCounts(db: DbOrTx, publication: ManifestIdentity): Promise<ServingCounts> {
  const r = await db.execute(sql`select count(*)::int as total,count(*) filter(where answer_eligible)::int as eligible,
    count(*) filter(where is_us)::int as us,min(ntsb_no) filter(where answer_eligible) as sample
    from cases where generation_id=${publication.generationId}`);
  const v=r.rows[0]!;
  if (!v || !Number(v.total) || !Number(v.eligible) || typeof v.sample !== 'string') throw new ImportFailure('verification');
  return {total:Number(v.total),eligible:Number(v.eligible),us:Number(v.us),sample:v.sample};
}
export function checkShrink(candidate: Pick<ServingCounts,'total'|'eligible'>, serving: Pick<ServingCounts,'total'|'eligible'>): void {
  for(const key of ['total','eligible'] as const) {
    if (![candidate[key],serving[key]].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new ImportFailure('integrity');
    if (BigInt(candidate[key])*10n < BigInt(serving[key])*9n) throw new ImportFailure('shrunk');
  }
}
export async function adoptServing(db: Db, s: ImportSession, code: string): Promise<AcceptedSnapshot> {
  return fenced(db,s,async tx=> {
    await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
    const current=await manifest(tx);
    if(!current) throw new ImportFailure('configuration');
    const control=(await tx.execute(sql`select accepted from import_control where id=1`)).rows[0];
    const old=control?.accepted as AcceptedSnapshot|null;
    if(old && sameManifest(old.manifest,current)) return old;
    const row=(await tx.execute(sql`select archive_sha256 from dataset_generations where id=${current.generationId}`)).rows[0];
    if(!row) throw new ImportFailure('integrity');
    const prior=(await tx.execute(sql`select accepted from import_attestations where publication->>'generationId'=${String(current.generationId)}
      and accepted->>'archive'=${String(row.archive_sha256)} order by created_at desc limit 1`)).rows[0]?.accepted as AcceptedSnapshot|undefined;
    const cases=await tx.execute(sql`select ntsb_no,source_revision from cases where generation_id=${current.generationId} order by ntsb_no`);
    const next:AcceptedSnapshot={archive:String(row.archive_sha256),content:prior?.content??digest(cases.rows),csvHash:prior?.csvHash??null,
      observation:prior?.observation??null,manifest:current,code};
    await tx.execute(sql`select import_adopt(${s.fence}::uuid,${JSON.stringify(next)}::jsonb)`);
    return next;
  });
}
export async function compareServing(db: Db, current: ManifestIdentity, next: SnapshotFacts): Promise<Comparison> {
  const rows=await db.execute(sql`select ntsb_no,source_revision from cases where generation_id=${current.generationId} order by ntsb_no`);
  const previous=new Map(rows.rows.map(r=>[String(r.ntsb_no),String(r.source_revision)]));
  const candidates=new Map(next.normalized.cases.map(c=>[c.ntsbNo,c.sourceRevision]));
  const added=[...candidates.keys()].filter(k=>!previous.has(k)).sort();
  const changed=[...candidates].filter(([k,v])=>previous.has(k)&&previous.get(k)!==v).map(([k])=>k).sort();
  const removed=[...previous.keys()].filter(k=>!candidates.has(k)).sort();
  const report={policy:POLICY_VERSION as typeof POLICY_VERSION,baseline:digest(rows.rows),candidate:next.digest,ok:true,failures:[],added,changed,removed,
    reassociated:[],usMembershipLost:[],cases:[...added,...changed,...removed].sort(),
    counts:{events:candidates.size,eligible:next.normalized.cases.filter(c=>c.answerEligible).length,
      added:added.length,changed:changed.length,removed:removed.length,rawComparisonAvailable:0}};
  return {...report,hash:digest(report)};
}
export function suppressionKey(environment: string, archive: string|null, source: SourceObservation|null, code: string,image: string): string {
  return digest([environment,archive??source??'source',code,image]);
}
export async function suppressed(c: ImportContext, archive: string|null, source:SourceObservation|null): Promise<boolean> {
  const key=suppressionKey(c.options.environment,archive,source,c.config.code,c.config[c.options.environment]!.image);
  return (await c.db.execute(sql`select 1 from import_issues where key=${key} and fixed and resolved_at is null`)).rows.length>0;
}
export async function incident(c: ImportContext, failure: ImportFailure, opts: {postSuccess?:boolean; siteState?:'unchanged'|'restored'|'uncertain'; origin?:'dev'|'live'|'host'}={}): Promise<void> {
  if(!c.session) throw failure;
  const post=opts.postSuccess===true, fixed=post ? failure.reason==='storage' : failure.fix;
  const archive=c.pending?.archive??c.artifact?.archive_sha256??null;
  const source=c.pending?.observation??c.observation??null;
  const image=c.config[c.options.environment]!.image;
  const key=fixed&&!post ? suppressionKey(c.options.environment,archive,source,c.config.code,image) : digest([c.runId,post,failure.reason]);
  const day=localClock(c.effects.now(),c.config.schedule.timeZone).day;
  await fenced(c.db,c.session,async tx=> {
    await tx.execute(sql`insert into import_issues(key,run_id,artifact_id,code,image,archive_sha256,source,reason,step,origin,fixed,site_state,post_success,failure_day)
      values(${key},${c.runId||null}::uuid,${c.artifact?.id??null}::uuid,${c.config.code},${image},${archive},${source?JSON.stringify(source):null}::jsonb,
        ${failure.reason},${c.step},${opts.origin??c.options.environment},${fixed},${opts.siteState??'unchanged'},${post},${day})
      on conflict(key) do update set last_at=clock_timestamp(),resolved_at=null,site_state=excluded.site_state`);
  });
}
export async function resolveIssues(db:Db,s:ImportSession,all=false,includePostSuccess=true):Promise<void> {
  await fenced(db,s,tx=>tx.execute(sql`update import_issues set resolved_at=clock_timestamp() where resolved_at is null
    and (${includePostSuccess} or not post_success) and (${all} or not fixed or post_success)`));
}
export async function holdSwitch(c:ImportContext, reason:ImportReason):Promise<void> {
  await fenced(c.db,c.session!,tx=>tx.execute(sql`select import_switch_hold(${c.session!.fence}::uuid,
    ${JSON.stringify({code:c.config.code,image:c.config[c.options.environment]!.image,reason,artifactId:c.artifact?.id??null})}::jsonb)`));
}
export async function checkSwitchHold(c:ImportContext):Promise<void> {
  const hold=(await c.db.execute(sql`select switch_hold from import_control where id=1`)).rows[0]?.switch_hold as {code:string;image:string;reason:ImportReason}|null;
  if(hold && hold.code===c.config.code && hold.image===c.config[c.options.environment]!.image) {c.blocked=true; throw new ImportFailure(hold.reason);}
  // A release only permits recovery; callers must prove both aliases reconciled before clearing.
}
export async function runMetadata(c:ImportContext):Promise<void> {
  await fenced(c.db,c.session!,tx=>tx.execute(sql`update import_runs set code=${c.config.code},image=${c.config[c.options.environment]!.image},origin=${c.options.environment} where id=${c.runId}::uuid`));
}
