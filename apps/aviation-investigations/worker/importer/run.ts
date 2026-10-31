/** Avall orchestration. All public status is fixed vocabulary; private reports are bounded and content addressed. */
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Client } from '@elastic/elasticsearch';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { VERIFIER_VERSION } from '../../server/db/generations.js';
import { createEsClient } from '../../server/search/es.js';
import { loadFromExtract } from '../ingest/load.js';
import { verifyCorpus } from '../ingest/verify.js';
import { rebuildCasesIndex, CASES_INDEX_VERSION } from '../index/cases-index.js';
import { rebuildPassagesIndex, planPassages } from '../index/passages-index.js';
import { cacheOnlyEmbedder, createOpenAIEmbedder, embeddingUsdPerMillion } from '../index/embed.js';
import { createLedgerSpendGate, createDryRunSpendGate, type SpendGate } from '../index/spend-gate.js';
import { reconcileAlias } from '../index/publications.js';
import { AvallSource, refreshOwed, sameObservation,type SnapshotSource } from './source.js';
import { ManagedSpace, FILE_LIMITS, privateDirectory, checkExtraction } from './files.js';
import { extractSnapshot, readSnapshot, seedArchive, recoverExtraction, type ExtractedSnapshot } from './extraction.js';
import { ImportFailure, POLICY_VERSION, safeFailure, safeLog, sameManifest, type ImportStep, type ImportReason,
  type ManifestIdentity, type SourceObservation } from './contracts.js';
import { compareSnapshots } from './compare.js';
import { digest } from './provenance.js';
import { checkApproval, checkDevCanary } from './approval.js';
import { applicationProbe, deployedImage, propagate, workerIdentity } from './application.js';
import { APP_DIR } from '../config.js';
import { runCanary, probeCandidate } from './probes.js';
import { certificationClient, validateRecord } from './strict-es.js';
import { activate, protectBaseline } from './lifecycle.js';
import { artifact, accept, assertFence, beginRun, budgetRemaining, control, fenced, findContent, linkGeneration,
  manifest, registerArtifact, registerCandidate, resumeArtifact, review, saveCertificate, updateRun, withImportSession,
  accountingReport,type Artifact, type AcceptedSnapshot, type Certificate, type ImportSession, type Canary } from './store.js';
import { environmentConfig,providerKey, type ImporterConfig } from './config.js';
import { retainDatabase,retainFiles } from './retention.js';
import { replayOutage,spoolFailure } from './recovery.js';

export interface RunOptions { environment:'dev'|'live'; noChange?:boolean; forcedDev?:boolean; cacheOnly:boolean;
  seed?:{path:string;sha256:string;observation:SourceObservation} }
export interface RunReport { result:'unchanged'|'published'; reason:'same_archive'|'same_content'|'metadata_unchanged'|null;
  archive:string; content:string; generationId:number; elapsedMs:number; peakBytes:number;
  remoteRefreshOwed:boolean; cacheMisses:number; reservationUsd:number; chargedUsd:number }
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

/** The read-only seed proves that these projected bytes built this serving corpus. No profile is generated. */
export async function verifyBaseline(db:Db,snapshot:ExtractedSnapshot,baseline:ManifestIdentity):Promise<void> {
  await checkExtraction(snapshot.dir,snapshot.hashes);
  const g=(await db.execute(sql`select archive_sha256,mapping_version,mapping_verified,citation_text_version,
    field_normalization_version,verification_status,verifier_version from dataset_generations where id=${baseline.generationId}`)).rows[0];
  const facts=snapshot.facts.normalized;
  if(!g || g.archive_sha256!==snapshot.archive || g.mapping_version!==facts.completionMapping.version
    || g.mapping_verified!==facts.completionMapping.verified || g.citation_text_version!==facts.citationTextVersion
    || g.field_normalization_version!==facts.fieldNormalizationVersion || g.verification_status!=='ok'
    || g.verifier_version!==VERIFIER_VERSION)throw new ImportFailure('baseline_required');
  const rows=await db.execute(sql`select ntsb_no,source_revision from cases where generation_id=${baseline.generationId}`);
  const revisions=new Map(facts.cases.map(c=>[c.ntsbNo,c.sourceRevision]));
  if(rows.rows.length!==revisions.size || rows.rows.some(r=>revisions.get(String(r.ntsb_no))!==r.source_revision)) {
    throw new ImportFailure('baseline_required');
  }
  // sourceRevision is only a tie to the historical load. All new comparison digests are canonical raw-row digests.
}
export function unchangedDecision(accepted:AcceptedSnapshot,observed:SourceObservation,lastFetch:string|null,now:Date):boolean {
  return sameObservation(accepted.observation,observed)&&!refreshOwed(lastFetch,now);
}
async function reusable(db:Db,es:Client,s:ImportSession,a:Artifact,kind:'cases'|'passages',prefix:string):Promise<{index:string;buildId:string}|null> {
  s.assertLocked();
  const alias=`${prefix}-${kind}`;
  const result=await reconcileAlias(es,db,alias,{lockTimeoutMs:5000});
  if(result.unresolved.length)throw new ImportFailure('alias_unknown',false);
  const rows=await db.execute(sql`select r.index_name,r.build_id from import_index_refs r join index_builds b
    on b.build_id=r.build_id where r.artifact_id=${a.id}::uuid and r.generation_id=${Number(a.generation_id)}
    and b.alias=${alias} and r.released_at is null and b.deletion_requested_at is null and b.deleted_at is null
    order by r.created_at desc`);
  if(rows.rows.length>1)throw new ImportFailure('integrity');
  const r=rows.rows[0];
  // A candidate registered before its alias request can be certified as a concrete pair; the alias is not serving.
  return r?{index:String(r.index_name),buildId:String(r.build_id)}:null;
}
function importGate(db:Db,s:ImportSession,a:Artifact,base:SpendGate):SpendGate {
  return {async reserve(r){s.assertLocked();return base.reserve(r);},settle:(r,o)=>base.settle(r,o),
    async remainingUsd(category){return Math.min(await budgetRemaining(db,s,a.id),await base.remainingUsd(category));}};
}
async function matchingDev(config:ImporterConfig,a:Artifact):Promise<Canary> {
  const cfg=environmentConfig(config,'dev',true);
  const db=createDb(cfg.databaseIngestUrl!,{max:2,applicationName:'aviation-import-dev-check'});
  try {
    const saved=await findContent(db,'dev',a.content_sha256);
    const c=saved?.canary??null;
    checkDevCanary(c,await manifest(db),{archive:a.archive_sha256,content:a.content_sha256,code:config.code,
      deployedCode:config.live!.image},new Date());
    await deployedImage(config.dev);
    return c;
  } finally{await closeDb(db);}
}
async function finishCanary(db:Db,s:ImportSession,a:Artifact,config:ImporterConfig,snapshot:ExtractedSnapshot,
  observation:SourceObservation,publication:ManifestIdentity):Promise<void> {
  const rows=snapshot.facts.normalized.cases;
  const app=applicationProbe(config[a.environment]!,CASES_INDEX_VERSION,
    {cases:rows.filter(c=>c.isUs).length,eligible:rows.filter(c=>c.answerEligible).length});
  await propagate(app,publication);
  const probes=await runCanary(db,publication,app);
  const c:Canary={publication,archive:a.archive_sha256,content:a.content_sha256,code:config.code,
    deployedCode:app.deployedCode,probes,checkedAt:new Date().toISOString()};
  // Recheck and record under the publication lifecycle boundary, including same-generation operator changes.
  await fenced(db,s,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(7311905022)`);
    if(!sameManifest(await manifest(tx),publication))throw new ImportFailure('baseline_changed');
    await tx.execute(sql`update import_artifacts set canary=${JSON.stringify(c)}::jsonb where id=${a.id}::uuid`);
    const accepted:AcceptedSnapshot={archive:a.archive_sha256,content:a.content_sha256,csvHash:snapshot.csvHash,
      manifest:publication,observation,code:config.code};
    await tx.execute(sql`select import_accept(${s.fence}::uuid,${JSON.stringify(accepted)}::jsonb,false)`);
  });
}

export async function runImport(config:ImporterConfig,options:RunOptions):Promise<RunReport> {
  if(options.forcedDev && (options.environment!=='dev'||options.noChange))throw new ImportFailure('configuration');
  const started=Date.now(),cfg=environmentConfig(config,options.environment),envConfig=config[options.environment]!;
  const db=createDb(cfg.databaseIngestUrl!,{max:10,applicationName:'aviation-importer',
    execution:{statementTimeoutMs:600_000,idleInTransactionTimeoutMs:120_000,transportTimeoutMs:660_000}});
  const rawEs=createEsClient(cfg.elasticsearch,'write',{requestTimeoutMs:120_000,maxRetries:0});
  const es=certificationClient(rawEs),space=new ManagedSpace(config.root);
  const privateReports=join(space.root,'reports',options.environment);
  let runId:string|null=null,a:Artifact|null=null,session:ImportSession|null=null,step:ImportStep='check';
  const stage=async(next:ImportStep)=>{step=next;session!.assertLocked();
    await updateRun(db,session!,runId!,{step,result:'running',artifactId:a?.id});
    process.stdout.write(`${safeLog(step,'running',null)}\n`);};
  try {
    await privateDirectory(space.root);await privateDirectory(privateReports);
    return await withImportSession(db,async s=>{
    session=s;await replayOutage(db,s,space,options.environment);
    runId=await beginRun(db,s,options.forcedDev?'forced_dev':'automatic');
    await recoverExtraction(space);
    const source:SnapshotSource=new AvallSource(),observed=await source.inspect();
    await updateRun(db,s,runId,{step,result:'running',source:observed});
    const current=await manifest(db);
    if(!current)throw new ImportFailure('baseline_required');
    const state=await control(db);
    let accepted=state.accepted,base:ExtractedSnapshot;
    if(!accepted){
      if(!options.seed)throw new ImportFailure('baseline_required');
      await seedArchive(space,options.seed.path,options.seed.sha256);
      base=await extractSnapshot(space,options.seed.sha256,options.environment,()=>s.assertLocked());
      await verifyBaseline(db,base,current);
      accepted={archive:base.archive,content:base.facts.digest,csvHash:base.csvHash,manifest:current,observation:options.seed.observation,code:config.code};
      await accept(db,s,accepted); // never marks a local read as an upstream refresh
    }else{
      base=await readSnapshot(space,accepted.archive);
      if(base.csvHash!==accepted.csvHash||base.facts.digest!==accepted.content)throw new ImportFailure('integrity');
      await verifyBaseline(db,base,accepted.manifest);
    }
    const unchanged=async(reason:'metadata_unchanged'|'same_archive'|'same_content',sha:string):Promise<RunReport>=>{
      if(!sameManifest(await manifest(db),accepted!.manifest))throw new ImportFailure('baseline_changed');
      a=await findContent(db,options.environment,accepted!.content);
      if(a)await updateRun(db,s,runId!,{step,result:'running',artifactId:a.id});
      if(!options.noChange && options.environment==='dev' && config.live){
        const saved=a;
        // A delayed live attempt needs fresh availability evidence. Recheck the SAME publication, without a new load or cap.
        if(saved?.canary && Date.now()-Date.parse(saved.canary.checkedAt)>23*3_600_000){
          if(saved.canary.code!==config.code||saved.canary.deployedCode!==config.dev.image
            ||!sameManifest(saved.canary.publication,accepted!.manifest))throw new ImportFailure('dev_failed');
          await stage('canary');await finishCanary(db,s,saved,config,base,accepted!.observation,accepted!.manifest);
        }
      }
      if(!options.noChange){await stage('cleanup');await retainDatabase(db,es,s);await retainFiles(config,space);}
      await updateRun(db,s,runId!,{step:'complete',result:'unchanged',reason,observedSha256:sha,sourceCheckSucceeded:true});
      return {result:'unchanged',reason,archive:sha,content:accepted!.content,generationId:accepted!.manifest.generationId,
        elapsedMs:Date.now()-started,peakBytes:space.peakBytes,remoteRefreshOwed:refreshOwed((await control(db)).lastRemoteFetchAt,new Date()),
        cacheMisses:0,reservationUsd:0,chargedUsd:0}; // this invocation dispatched no embedding attempt
    };
    // The authorized no-download exercise proves only local sameness. Its report explicitly retains an overdue refresh.
    if(options.noChange){
      if(!sameObservation(observed,accepted.observation))throw new ImportFailure('source_reissued',false);
      return unchanged('same_archive',accepted.archive);
    }
    if(!options.forcedDev && unchangedDecision(accepted,observed,state.lastRemoteFetchAt,new Date())) {
      const pending=await findContent(db,options.environment,accepted.content);
      if(!pending || pending.canary)return unchanged('metadata_unchanged',accepted.archive);
    }
    let candidate:ExtractedSnapshot=base;
    let observedSha=accepted.archive;
    if(!options.forcedDev){
      await stage('acquire');
      const acquired=await source.acquire(observed,space);observedSha=acquired.sha256;
      await accept(db,s,null,true); // only after the actual, bounded, unconditional retrieval succeeded
      await updateRun(db,s,runId,{step,result:'running',sourceCheckSucceeded:true});
      await stage('extract');
      candidate=observedSha===base.archive?base:await extractSnapshot(space,observedSha,options.environment,()=>s.assertLocked());
    }
    a=await findContent(db,options.environment,candidate.facts.digest);
    if(!options.forcedDev && candidate.facts.digest===accepted.content && (!a || a.canary)){
      await accept(db,s,{...accepted,observation:observed});
      return unchanged(observedSha===accepted.archive?'same_archive':'same_content',observedSha);
    }
    // Same content in different packaging is the SAME logical attempt, archive identity, retry allowance and cap.
    if(a && a.archive_sha256!==candidate.archive)candidate=await readSnapshot(space,a.archive_sha256);
    a??=await registerArtifact(db,s,options.environment,candidate.archive,candidate.facts.digest,accepted.manifest);
    await updateRun(db,s,runId,{step,result:'running',artifactId:a.id,observedSha256:observedSha});
    if(a.rollback)throw new ImportFailure('baseline_changed');
    if(a.canary)throw new ImportFailure('baseline_changed'); // no unbounded repeated forced generation on one artifact
    if(a.needs_review)throw new ImportFailure(a.reason??'verification');
    if(!sameManifest(a.baseline,accepted.manifest) || !(sameManifest(current,accepted.manifest)||sameManifest(current,a.publication))) {
      throw new ImportFailure('baseline_changed');
    }
    if(options.environment==='live')await matchingDev(config,a);
    await resumeArtifact(db,s,a.id);
    await protectBaseline(db,s,a.id,accepted.manifest);
    const comparison=compareSnapshots(base.facts,candidate.facts,new Date());
    const acceptedObservation=options.forcedDev?accepted.observation:observed;
    await space.json(join(privateReports,`${a.id}-comparison.json`),comparison);
    await space.json(join(privateReports,`comparison-${comparison.hash}.json`),comparison);
    const approvals=checkApproval(a.approved,a,accepted.manifest,config.code,comparison);
    if(a.publication){
      await space.json(join(privateReports,`${a.id}-publication.json`),{publication:a.publication,sha256:digest(a.publication)});
      await stage('canary');await finishCanary(db,s,a,config,candidate,acceptedObservation,a.publication);
      const accounting=await accountingReport(db,a.id);
      await space.json(join(privateReports,`${a.id}-accounting.json`),accounting);
      await updateRun(db,s,runId,{step:'complete',result:'published',canaryPassed:true,sourceCheckSucceeded:true});
      return {result:'published',reason:null,archive:a.archive_sha256,content:a.content_sha256,generationId:a.publication.generationId,
        elapsedMs:Date.now()-started,peakBytes:space.peakBytes,
        remoteRefreshOwed:refreshOwed((await control(db)).lastRemoteFetchAt,new Date()),cacheMisses:0,
        reservationUsd:accounting.reservationUsd,chargedUsd:accounting.chargedUsd};
    }
    await deployedImage(envConfig);
    if(!a.generation_id){
      await stage('load');await checkExtraction(candidate.dir,candidate.hashes);
      await loadFromExtract(db,candidate.dir,{privateErrors:true,onGeneration:(tx,id)=>linkGeneration(tx,s,a!.id,id)});
      a=await artifact(db,a.id);
    }
    const generation=Number(a.generation_id);
    await stage('verify');await space.check(FILE_LIMITS.report);
    const verified=await verifyCorpus(db,generation,{outDir:privateReports,maxReportBytes:FILE_LIMITS.report});
    if(!verified.ok||verified.conflict)throw new ImportFailure('verification');
    const {embeddingModel:model,embeddingDimensions:dims}=cfg.ai.openai;
    const embedding={model,dims,usdPerMillionTokens:embeddingUsdPerMillion(model)};
    await stage('plan');
    const plan=await planPassages(db,{generationId:generation,embedding,log:()=>{},mapRecord:validateRecord});
    if(!plan.cache.available || (options.cacheOnly && plan.toEmbed.inputs!==0))throw new ImportFailure('import_cap');
    const ledger=createLedgerSpendGate(db,{import:{artifactId:a.id,fence:s.fence},budgets:cfg.ai.budgets,provider:'openai',model,stage:'embed'});
    const gate=importGate(db,s,a,ledger);
    if(plan.reservationUsd*3>await gate.remainingUsd('indexing')+1e-9)throw new ImportFailure('import_cap');
    const checkpoint={archive:a.archive_sha256,content:a.content_sha256,generation,comparison:comparison.hash,
      embedding,priceIdentity:digest([embedding,config.code,3]),maxAttempts:3,
      plan:{passages:plan.passages,cacheHits:plan.cache.hits,cacheMisses:plan.toEmbed.inputs,reservationUsd:plan.reservationUsd}};
    await space.json(join(privateReports,`${a.id}-plan.json`),checkpoint);
    await stage('index_cases');
    const cases=await reusable(db,es,s,a,'cases',cfg.elasticsearch.indexPrefix)??await rebuildCasesIndex(es,db,{
      generationId:generation,prefix:cfg.elasticsearch.indexPrefix,log:()=>{},
      onReady:c=>registerCandidate(db,s,a!.id,c.index,c.buildId,generation)});
    await stage('index_passages');
    const cacheOnly=options.cacheOnly||plan.toEmbed.inputs===0;
    const embedder=cacheOnly?cacheOnlyEmbedder(embedding):createOpenAIEmbedder({apiKey:providerKey(config,options.environment),model,dims,gate,
      purpose:`import:${a.id}`,log:()=>{}});
    const passages=await reusable(db,es,s,a,'passages',cfg.elasticsearch.indexPrefix)??await rebuildPassagesIndex(es,db,embedder,{
      generationId:generation,prefix:cfg.elasticsearch.indexPrefix,cacheOnly,confirmCost:!cacheOnly,
      mapRecord:validateRecord,
      gate:cacheOnly?createDryRunSpendGate(gate):gate,log:()=>{},
      onReady:c=>registerCandidate(db,s,a!.id,c.index,c.buildId,generation)});
    await stage('validate');
    const pair={generationId:generation,casesIndex:cases.index,passagesIndex:passages.index};
    const probes=await probeCandidate(db,es,pair,candidate.facts,comparison,embedding);
    const dev=options.environment==='live'?await matchingDev(config,a):null;
    const certificate:Certificate={version:'import-certificate.v1',artifactId:a.id,archive:a.archive_sha256,
      content:a.content_sha256,environment:options.environment,baseline:accepted.manifest,
      candidate:{...pair,casesBuildId:cases.buildId,passagesBuildId:passages.buildId},code:config.code,deployedCode:envConfig.image,
      policy:POLICY_VERSION,genericReport:verified.reportSha256,comparison:comparison.hash,probes:probes.hash,approvedReasons:approvals,dev};
    await space.json(join(privateReports,`${a.id}-certificate.json`),certificate);
    await space.json(join(privateReports,`certificate-${digest(certificate)}.json`),certificate);
    await saveCertificate(db,s,certificate);
    await stage('cleanup');await retainDatabase(db,es,s);await retainFiles(config,space);
    await stage('publish');
    const publication=await activate(db,es,s,certificate,embedding,async()=>{
      await workerIdentity(config.code,APP_DIR);await deployedImage(envConfig);if(options.environment==='live')await matchingDev(config,a!);
    });
    await space.json(join(privateReports,`${a.id}-publication.json`),{publication,sha256:digest(publication)});
    await stage('canary');await finishCanary(db,s,a,config,candidate,acceptedObservation,publication);
    await space.check();
    const accounting=await accountingReport(db,a.id);
    await space.json(join(privateReports,`${a.id}-accounting.json`),accounting);
    const report:RunReport={result:'published',reason:null,archive:a.archive_sha256,content:a.content_sha256,generationId:generation,
      elapsedMs:Date.now()-started,peakBytes:space.peakBytes,remoteRefreshOwed:refreshOwed((await control(db)).lastRemoteFetchAt,new Date()),
      cacheMisses:plan.toEmbed.inputs,reservationUsd:accounting.reservationUsd,chargedUsd:accounting.chargedUsd};
    await space.json(join(privateReports,`${a.id}-result.json`),report);
    await updateRun(db,s,runId,{step:'complete',result:'published',canaryPassed:true,sourceCheckSucceeded:true});
    return report;
  });}catch(error){
    const failure=classify(error);
    // Session has closed when withImportSession rejects. Claim a new fence before recording the safe outcome.
    await withImportSession(db,async s=>{
      if(a && failure.review)await review(db,s,a.id,failure.reason);
      if(runId)await updateRun(db,s,runId,{step,result:failure.review?'needs_review':'deferred',reason:failure.reason,
        sourceCheckSucceeded:false});
    }).catch(async()=>{await spoolFailure(space,options.environment,failure,step,runId,a?.id??null).catch(()=>undefined);});
    process.stdout.write(`${safeLog(step,failure.review?'needs_review':'deferred',failure.reason)}\n`);
    throw failure;
  }finally{await rawEs.close().catch(()=>undefined);await closeDb(db);}
}
export function classify(error:unknown):ImportFailure {
  if(error instanceof ImportFailure)return error;
  for(let e:unknown=error,depth=0;e&&depth<5;depth++){
    const x=e as {code?:string;name?:string;cause?:unknown};
    if(x.code==='54000')return new ImportFailure('import_cap');
    if(x.code==='55000')return new ImportFailure('accounting');
    if(x.code==='ENOSPC')return new ImportFailure('storage');
    if(['23502','23503','23505','23514'].includes(x.code??''))return new ImportFailure('integrity');
    if(x.name==='SpendRefusedError')return new ImportFailure('monthly_budget',false);
    if(['AliasSwitchError','UnresolvedAliasError'].includes(x.name??''))return new ImportFailure('alias_unknown',false);
    if(['EmbeddingDeferredError','DatabaseTimeoutError','ConnectionError','TimeoutError'].includes(x.name??''))return new ImportFailure('interrupted',false);
    e=x.cause;
  }
  return safeFailure(error);
}
