/** Real ledger arithmetic; synthetic rows only, no providers or shared-dev writes. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDb, resetControls } from './helpers.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { adminOverview } from '../../server/routes/admin.js';
import type { ApiContext } from '../../server/routes/context.js';
import { accountIdentityHash } from '../../server/quota/policy.js';
import { GOOGLE_ISSUER } from '../../server/auth/better-auth.js';

let db:Db;
beforeAll(async()=>{db=testDb();await resetControls();});
afterAll(async()=>{await resetControls();await closeDb(db);});
it('counts charged searches once, separates undo/failure, and sums every ledger category on UTC accounting days',async()=>{
 const secret='test-admin-secret'.repeat(3),subject='google-subject',hash=accountIdentityHash(secret,GOOGLE_ISSUER,subject);
 const now=new Date('2026-10-31T12:00:00Z'), uid=randomUUID();
 await db.execute(sql`INSERT INTO auth_users(id,name,email,email_verified,created_at,updated_at) VALUES(${uid},'Reader','reader@example.test',true,'2026-10-30','2026-10-30')`);
 await db.execute(sql`INSERT INTO auth_accounts(id,user_id,account_id,provider_id,created_at,updated_at) VALUES(${randomUUID()},${uid},${subject},'google','2026-10-30','2026-10-30')`);
 async function charge(day:string,usd:number,category='interactive',outcome:'paid'|'failed'|'undo'='paid') {
  const created=new Date(`${day}T10:00:00Z`),kind=category==='interactive'?'account':'system',principal=kind==='account'?hash:null;
  const counted=kind==='account' && outcome!=='undo';
  const row=(await db.execute(sql`INSERT INTO reservations(category,principal_kind,principal_hash,usd,status,lease_expires_at,accounting_day,quota_counted,request_id,created_at)
    VALUES(${category},${kind},${principal},1,'open',${new Date(created.getTime()+120000)},${day}::date,${counted},${`evidence:${randomUUID()}`},${created}) RETURNING id`)).rows[0]!;
  if(outcome==='failed') await db.execute(sql`UPDATE reservations SET quota_counted=false WHERE id=${row.id}`);
  await db.execute(sql`UPDATE reservations SET status='settled',settled_at=${created},charged_usd=${usd},uncertain=false WHERE id=${row.id}`);
  // Two ledger rows for a single charged search must not multiply the search count.
  for(const stage of ['scope','embed']) await db.execute(sql`INSERT INTO cost_ledger(reservation_id,category,principal_kind,principal_hash,provider,model,stage,usd,uncertain,accounting_day,created_at)
    VALUES(${row.id},${category},${kind},${principal},'test','test-model',${stage},${usd/2},false,${day}::date,${created})`);
 }
 await charge('2026-10-31',0.1); await charge('2026-10-30',0.2); await charge('2026-09-30',0.4);
 await charge('2026-07-31',0.8); // Outside last90Days even if retention has not swept yet.
 await charge('2026-10-31',0.3,'evaluation'); await charge('2026-10-31',0.2,'indexing');
 await charge('2026-10-31',0.05,'interactive','undo'); await charge('2026-10-31',0.01,'interactive','failed');
 const ctx={db,datasets:{current:async()=>{throw new Error('no published dataset');}}} as unknown as ApiContext;
 const result=await adminOverview(ctx,{emails:[],identitySecret:secret,appEnv:'dev',startedAt:now.toISOString(),ranking:'er-q-v1',automaticFilters:'none'},now);
 expect(result.users.list[0]!.aiSearches).toEqual({today:1,last7Days:2,last30Days:2,last90Days:3});
 expect(result.users.list[0]!.lastAiSearchAt).toBe('2026-10-31T10:00:00.000Z');
 expect(result.usage.days.at(-1)).toMatchObject({accountSearches:1,trialSearches:0,freeUndos:1,failedSearches:2}); // The undo has no completed result.
 expect(result.costs.today).toBeCloseTo(0.66); expect(result.costs.monthToDate).toBeCloseTo(0.86); expect(result.costs.previousMonth).toBeCloseTo(0.4);
 expect(result.costs.byCategory).toEqual({interactive:0.36,indexing:0.2,evaluation:0.3});
 expect(result.costs.perSearch.searches).toBe(2); expect(result.costs.perSearch.meanUsd).toBeCloseTo(0.18);
 expect(result.system.dataset).toBeNull();
});
