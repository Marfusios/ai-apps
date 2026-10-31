import { describe,it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { withScratchEnvironment,localAdminUrl } from '../../scripts/scratch-env.js';
import { createDb,closeDb,type Db } from '../../server/db/client.js';
import { publishManifest,pruneGenerations } from '../../server/db/generations.js';
import { loadFromExtract,readExtractManifest } from '../../worker/ingest/load.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { rebuildPassagesIndex } from '../../worker/index/passages-index.js';
import { publishGeneration } from '../../worker/index/publish.js';
import { createFakeEmbedder,cacheOnlyEmbedder } from '../../worker/index/embed.js';
import { createMemorySpendGate,createDryRunSpendGate } from '../../worker/index/spend-gate.js';
import { certificationClient,validateRecord } from '../../worker/importer/strict-es.js';
import { withImportSession,registerArtifact,linkGeneration,registerCandidate,manifest,saveCertificate,artifact,
  type Certificate,type ImportSession } from '../../worker/importer/store.js';
import { activate,protectBaseline,rollback } from '../../worker/importer/lifecycle.js';
import { makeCombinedExtractDir,writeCsv,writeManifest } from '../support/extract-dir.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';
import { testEs,testConfig } from './helpers.js';
import { sourceFacts } from '../../worker/importer/provenance.js';
import { readProjectedTables } from '../../worker/ingest/normalize.js';
import { compareSnapshots } from '../../worker/importer/compare.js';
import { probeCandidate } from '../../worker/importer/probes.js';

const embedding={model:'text-embedding-3-small',dims:1536,usdPerMillionTokens:0};
async function prepared(fn:(v:{db:Db;es:ReturnType<typeof testEs>;s:ImportSession;certificate:Certificate})=>Promise<void>){
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(testConfig().elasticsearch.url).hostname))throw new Error('local test service required');
  await withScratchEnvironment(localAdminUrl(),'importerpublish',async urls=>{
    const db=createDb(urls.ingest,{max:10}),raw=testEs(),es=certificationClient(raw),prefix=`aviation-test-import-${randomBytes(6).toString('hex')}`;
    const dir=await makeCombinedExtractDir(),reports=await mkdtemp(join(tmpdir(),'import-verify-'));
    for(const table of TABLE_NAMES)if(!existsSync(join(dir,`${table}.csv`)))writeCsv(join(dir,`${table}.csv`),table,[]);
    await writeManifest(dir);
    try {await withImportSession(db,async s=>{
      const first=await loadFromExtract(db,dir);
      expect((await verifyCorpus(db,first.generationId,{outDir:reports,profile:null})).ok).toBe(true);
      const cases=await rebuildCasesIndex(es,db,{generationId:first.generationId,prefix,log:()=>{}});
      const passages=await rebuildPassagesIndex(es,db,createFakeEmbedder(1536,embedding.model),{generationId:first.generationId,prefix,
        confirmCost:true,gate:createMemorySpendGate(0),log:()=>{},mapRecord:validateRecord});
      await publishGeneration(es,db,{generationId:first.generationId,casesIndex:cases.index,passagesIndex:passages.index,embedding});
      const baseline=(await manifest(db))!;
      const facts=sourceFacts(await readProjectedTables(dir)),comparison=compareSnapshots(facts,facts,new Date('2026-10-31T12:00:00Z'));
      const a=await registerArtifact(db,s,'dev',readExtractManifest(dir).archive.sha256,facts.digest,baseline);
      const next=await loadFromExtract(db,dir,{onGeneration:(tx,id)=>linkGeneration(tx,s,a.id,id)});
      const verified=await verifyCorpus(db,next.generationId,{outDir:reports,profile:null});expect(verified.ok).toBe(true);
      const register=(c:{index:string;buildId:string;generationId:number})=>registerCandidate(db,s,a.id,c.index,c.buildId,c.generationId);
      const c2=await rebuildCasesIndex(es,db,{generationId:next.generationId,prefix,log:()=>{},onReady:register});
      // This second build must use the existing exact-input cache; a provider call is impossible.
      const p2=await rebuildPassagesIndex(es,db,cacheOnlyEmbedder(embedding),{generationId:next.generationId,prefix,
        cacheOnly:true,confirmCost:false,gate:createDryRunSpendGate(),log:()=>{},onReady:register,mapRecord:validateRecord});
      expect(p2.embedded.requests).toBe(0);
      await protectBaseline(db,s,a.id,baseline);
      const pair={generationId:next.generationId,casesIndex:c2.index,passagesIndex:p2.index};
      const probe=await probeCandidate(db,es,pair,facts,comparison,embedding);
      const certificate:Certificate={version:'import-certificate.v1',artifactId:a.id,archive:a.archive_sha256,content:facts.digest,
        environment:'dev',baseline,candidate:{...pair,casesBuildId:c2.buildId,passagesBuildId:p2.buildId},code:'c'.repeat(40),
        deployedCode:'sha256:'+'d'.repeat(64),policy:'snapshot-monthly.v1',genericReport:verified.reportSha256,
        comparison:comparison.hash,probes:probe.hash,approvedReasons:[],dev:null};
      await saveCertificate(db,s,certificate);await fn({db,es,s,certificate});
    });}finally{
      try {
        const found=await raw.indices.get({index:`${prefix}-*`,allow_no_indices:true,ignore_unavailable:true});
        const names=Object.keys(found);
        if(names.length)await raw.indices.delete({index:names});
      }finally{
        await raw.close();await closeDb(db);
        await rm(dir,{recursive:true,force:true});await rm(reports,{recursive:true,force:true});
      }
    }
  });
}

describe('guarded publication with real local indexes and offline cached embeddings',()=>{
  it('refuses a manual same-generation republication made after certification, preserving the operator manifest',async()=>prepared(async({db,es,s,certificate:c})=>{
    await publishManifest(db,c.baseline.generationId,c.baseline.casesIndex,c.baseline.passagesIndex);
    const current=await manifest(db);expect(current?.publishedAt).not.toBe(c.baseline.publishedAt);
    await expect(activate(db,es,s,c,embedding)).rejects.toMatchObject({reason:'baseline_changed'});
    expect(await manifest(db)).toEqual(current);
    expect((await pruneGenerations(db,{keep:1,graceHours:0,dryRun:true})).skippedPinned).toContain(c.candidate.generationId);
  }));
  it('fences activation and refuses rollback over an operator publication during canary',async()=>prepared(async({db,es,s,certificate:c})=>{
    await expect(activate(db,es,{...s,fence:'00000000-0000-0000-0000-000000000000'},c,embedding)).rejects.toThrow();
    expect(await manifest(db)).toEqual(c.baseline);
    const published=await activate(db,es,s,c,embedding);
    expect(published.generationId).toBe(c.candidate.generationId);
    await publishManifest(db,c.candidate.generationId,c.candidate.casesIndex,c.candidate.passagesIndex);
    const operator=await manifest(db);
    await expect(rollback(db,es,s,c.artifactId,published,embedding)).rejects.toMatchObject({reason:'baseline_changed'});
    expect(await manifest(db)).toEqual(operator);
  }));
  it('reconciles a lost COMMIT acknowledgement and rolls back once without moving aliases',async()=>prepared(async({db,es,s,certificate:c})=>{
    const original=db.$client.connect.bind(db.$client);let injected=false;
    // Driver fault: PostgreSQL commits, but the publisher sees a broken acknowledgement.
    db.$client.connect=((...connectArgs:unknown[])=>{
      if(connectArgs.length)return Reflect.apply(original,db.$client,connectArgs);
      return original().then(client=>{
      const query=client.query.bind(client);let armed=false;
      client.query=(async(...args:unknown[])=>{
        const text=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text??'';
        if(text.includes('update import_artifacts set publication='))armed=true;
        const result=await (query as (...args:unknown[])=>Promise<unknown>)(...args);
        if(armed&&!injected&&/^commit$/i.test(text.trim())){injected=true;client.query=query;throw new Error('synthetic lost acknowledgement');}
        return result;
      }) as pg.PoolClient['query'];
      return client;});
    }) as typeof db.$client.connect;
    let published;
    try{published=await activate(db,es,s,c,embedding);}finally{db.$client.connect=original;}
    expect(injected).toBe(true);expect(await manifest(db)).toEqual(published);
    expect((await artifact(db,c.artifactId)).publication).toEqual(published);
    const before=await es.indices.getAlias({index:[c.candidate.casesIndex,c.candidate.passagesIndex]});
    const restored=await rollback(db,es,s,c.artifactId,published,embedding);
    expect(restored.generationId).toBe(c.baseline.generationId);
    expect(await rollback(db,es,s,c.artifactId,published,embedding)).toEqual(restored);
    expect(await es.indices.getAlias({index:[c.candidate.casesIndex,c.candidate.passagesIndex]})).toEqual(before);
    expect((await db.execute(sql`select count(*)::int as n from reservations`)).rows[0]?.n).toBe(0);
  }));
});
