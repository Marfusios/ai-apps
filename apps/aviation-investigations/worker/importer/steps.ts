/** State path: baseline → detect/acquire → extract/register → compare → load/verify → plan/index
 * → validate/publish → canary/accept → retention. A latch or pending fetch always precedes detection. */
import { sql } from 'drizzle-orm';
import { join } from 'node:path';
import { APP_DIR } from '../config.js';
import { CASES_INDEX_VERSION } from '../index/cases-index.js';
import { cacheOnlyEmbedder, embeddingUsdPerMillion } from '../index/embed.js';
import { createDryRunSpendGate, createLedgerSpendGate } from '../index/spend-gate.js';
import { reconcileAlias } from '../index/publications.js';
import { compareSnapshots, type Comparison } from './compare.js';
import { adoptServing, servingCounts, checkShrink, compareServing, suppressed, resolveIssues, runMetadata, checkSwitchHold } from './automatic.js';
import { ImportFailure, POLICY_VERSION, safeLog, sameManifest } from './contracts.js';
import { checkExtraction, privateDirectory, fileDigest } from './files.js';
import { recoverExtraction, seedArchive } from './extraction.js';
import { digest } from './provenance.js';
import { refreshOwed, sameObservation } from './source.js';
import { matchingDev } from './facts.js';
import {
  PendingSchema,
  recordSuccess,
  setPending,
  linkPendingArtifact,
} from './durable.js';
import {
  accept,
  artifact,
  beginRun,
  budgetRemaining,
  fenced,
  control,
  findContent,
  linkGeneration,
  manifest,
  registerArtifact,
  registerCandidate,
  admitArtifact,
  startAttempt,
  startRecertification,
  outstandingArtifacts,
  originalFetch,
  reusableReference,
  latestCanary,
  saveCertificate,
  updateRun,
  accountingReport,
  type Artifact,
  type Canary,
} from './store.js';
import { replayOutage } from './recovery.js';
import { activate, protectBaseline } from './lifecycle.js';
import { validateRecord } from './strict-es.js';
import { requireState, type ImportContext, type RunReport } from './runtime.js';
import type { ImportStep } from './contracts.js';

export function currentArtifact(context: ImportContext): Artifact {
  if (!context.artifact) throw new ImportFailure('integrity');
  return context.artifact;
}
export async function stage(context: ImportContext, step: ImportStep): Promise<void> {
  requireState(context, 'session');
  context.step = step;
  context.session.assertLocked();
  await updateRun(context.db, context.session, context.runId, {
    step,
    result: 'running',
    artifactId: context.artifact?.id,
    pendingRunId: context.pending?.runId,
    observedSha256: context.pending?.archive,
  });
  process.stdout.write(`${safeLog(step, 'running', null)}\n`);
}

export async function initialize(context: ImportContext): Promise<void> {
  requireState(context,'session');
  await privateDirectory(context.space.root); await privateDirectory(context.reports);
  await replayOutage(context.db,context.session,context.space,context.options.environment,context.config.schedule.timeZone);
  context.runId=await beginRun(context.db,context.session,context.options.forcedDev?'forced_dev':'automatic',context.config.schedule.timeZone);
  await runMetadata(context);
  await recoverExtraction(context.space);
  const state=await control(context.db);
  context.pending=state.pending?PendingSchema.parse(state.pending):null;
  if(context.pending) context.pending.needsReview=false;
  if(context.pending?.artifactId) context.artifact=await artifact(context.db,context.pending.artifactId);
}
export async function preflight(context: ImportContext): Promise<void> {
  if(context.options.noChange) return;
  await context.effects.deployedImage(context.config[context.options.environment]!);
  await context.effects.applicationAvailable(context.config[context.options.environment]!);
}
export async function establishBaseline(context: ImportContext): Promise<void> {
  requireState(context,'session');
  context.current=(await manifest(context.db))??undefined;
  if(!context.current) throw new ImportFailure('configuration');
  const unfinished=await outstandingArtifacts(context.db,context.options.environment);
  if(unfinished.length>1) throw new ImportFailure('accounting');
  if(unfinished[0] && !context.options.recertify) {
    context.artifact=unfinished[0];
    if(!context.pending || context.pending.artifactId!==context.artifact.id) {
      const original=await originalFetch(context.db,context.artifact.id);
      context.pending={archive:context.artifact.archive_sha256,content:context.artifact.content_sha256,
        artifactId:context.artifact.id,runId:original.id,observation:original.source,fetchedAt:original.checked,
        attempts:0,needsReview:false,reason:null};
      await setPending(context.db,context.session,context.pending);
    }
  }
  // While a switch awaits its canary, accepted still describes the protected previous data.
  const state=await control(context.db);
  const recovering=context.artifact && ['switching','published','rolling_back'].includes(context.artifact.phase) && !context.options.recertify;
  context.accepted=recovering && state.accepted ? state.accepted : await adoptServing(context.db,context.session,context.config.code);
  if(context.options.seed) {
    await seedArchive(context.space,context.options.seed.path,context.options.seed.sha256);
  }
  try { context.baseline=await context.effects.readSnapshot(context.space,context.accepted.archive); }
  catch { context.baseline=undefined; } // The canonical serving corpus is sufficient; no old ZIP is required.
  if(context.baseline && context.accepted.csvHash && context.baseline.csvHash!==context.accepted.csvHash) throw new ImportFailure('integrity');
}
export async function detect(context: ImportContext): Promise<'pending'|'unchanged'|'acquire'|'waiting'> {
  requireState(context,'session','accepted');
  if(context.options.recertify) return 'unchanged';
  await checkSwitchHold(context);
  if(context.artifact && ['switching','published','rolling_back'].includes(context.artifact.phase)) return 'pending';
  if(context.options.forcedDev) return 'acquire';
  if(context.options.environment==='live' && context.config.live) {
    if(!context.hostFacts.serving) throw new ImportFailure('configuration');
    const dev=await context.hostFacts.serving('dev');
    // Do not independently fetch a moving upstream file after dev has certified its bytes.
    await matchingDev(context.config,{archive_sha256:dev.archive,content_sha256:dev.content},context.hostFacts,context.effects.deployedImage,context.effects.now());
    if(dev.archive===context.accepted.archive && dev.content===context.accepted.content) return 'unchanged';
    if(!dev.observation) throw new ImportFailure('configuration');
    context.promotion=dev;
    context.observation=dev.observation;
    if(await suppressed(context,dev.archive,dev.observation)) return 'waiting';
    if(context.pending?.archive===dev.archive) return 'pending';
    return 'acquire';
  }
  context.observation=await context.source.inspect(); context.sourceChecked=true;
  await updateRun(context.db,context.session,context.runId,{step:'check',result:'running',source:context.observation});
  const state=await control(context.db);
  if(context.pending) {
    const same=sameObservation(context.observation,context.pending.observation);
    if(!same || refreshOwed(state.lastRemoteFetchAt,context.effects.now())) return 'acquire';
    return await suppressed(context,context.pending.archive,context.pending.observation)?'waiting':'pending';
  }
  if(context.accepted.observation && sameObservation(context.observation,context.accepted.observation)
    && !refreshOwed(state.lastRemoteFetchAt,context.effects.now())) return 'unchanged';
  return 'acquire';
}
export async function acquire(context: ImportContext):Promise<'pending'|'unchanged'|'waiting'> {
  requireState(context,'session','accepted');
  const previousPending=context.pending,previousArtifact=context.artifact;
  context.pending=null; context.artifact=null;
  await stage(context,'acquire');
  const target=context.options.forcedDev?context.accepted.archive:context.promotion?.archive;
  context.observation ??= context.accepted.observation??undefined;
  requireState(context,'observation');
  let fetchedAt=context.effects.now().toISOString(), archive:string;
  if(target) {
    const path=join(context.space.root,'archives',target);
    try { if(await fileDigest(path)!==target) throw new ImportFailure('integrity'); }
    catch {
      if(context.options.forcedDev) throw new ImportFailure('cache_miss');
      const got=await context.source.acquire(context.observation,context.space);
      if(got.sha256!==target) throw new ImportFailure('source_changed_during_download');
      fetchedAt=got.fetchedAt;
    }
    archive=target;
  } else {
    const got=await context.source.acquire(context.observation,context.space); archive=got.sha256; fetchedAt=got.fetchedAt;
  }
  context.pending=previousPending;
  if(context.pending?.archive!==archive) {
    if(previousArtifact?.processingId && !previousArtifact.publication)
      await fenced(context.db,context.session,tx=>tx.execute(sql`update import_processing set phase='abandoned' where id=${previousArtifact.processingId}::uuid`));
    context.artifact=null;
    context.pending={archive,observation:context.observation,fetchedAt,runId:context.runId,artifactId:null,content:null,attempts:0,needsReview:false,reason:null};
  } else context.pending={...context.pending,observation:context.observation,fetchedAt,needsReview:false};
  await setPending(context.db,context.session,context.pending,!target);
  await context.effects.fault('fetched');
  if(await suppressed(context,archive,context.observation)) return 'waiting';
  return 'pending';
}
export async function waiting(context:ImportContext):Promise<RunReport> {
  requireState(context,'session');
  context.blocked=true;
  await updateRun(context.db,context.session,context.runId,{step:'check',result:'waiting',source:context.observation??context.pending?.observation,
    artifactId:context.pending?.artifactId??undefined,observedSha256:context.pending?.archive,sourceCheckSucceeded:false});
  await fenced(context.db,context.session,tx=>tx.execute(sql`update import_runs set suppressed=true where id=${context.runId}::uuid`));
  return report(context,'waiting',null);
}
export async function extract(context:ImportContext):Promise<void> {
  requireState(context,'session','pending'); await stage(context,'extract');
  context.pending.attempts++; await setPending(context.db,context.session,context.pending);
  context.candidate=await context.effects.extractSnapshot(context.space,context.pending.archive,context.options.environment,context.session.assertLocked);
  // Digests include normalization versions, so a code upgrade may legitimately change them.
  context.pending.content=context.candidate.facts.digest;
  await setPending(context.db,context.session,context.pending); await context.effects.fault('extracted');
}
export async function register(context:ImportContext):Promise<'same_archive'|'same_content'|'candidate'> {
  requireState(context,'session','candidate','accepted','current','pending');
  const {db,session,options,pending}=context;
  if(!options.forcedDev && context.candidate.facts.digest===context.accepted.content && sameManifest(context.current,context.accepted.manifest)) {
    await accept(db,session,{...context.accepted,observation:pending.observation}); (context as ImportContext).pending=null;
    return context.candidate.archive===context.accepted.archive?'same_archive':'same_content';
  }
  const before=await servingCounts(db,context.accepted.manifest);
  const candidate={total:context.candidate.facts.normalized.cases.length,eligible:context.candidate.facts.normalized.cases.filter(c=>c.answerEligible).length};
  checkShrink(candidate,before);
  if(options.environment==='dev' && context.config.live) {
    if(!context.hostFacts.serving) throw new ImportFailure('configuration');
    checkShrink(candidate,(await context.hostFacts.serving('live')).counts);
  }
  const recovering=context.artifact && ['switching','published','rolling_back'].includes(context.artifact.phase);
  const saved=recovering?context.artifact!:await registerArtifact(db,session,options.environment,context.candidate.archive,
    context.candidate.facts.digest,context.accepted.manifest,{code:context.config.code,image:context.config[options.environment]!.image});
  context.artifact=saved; pending.artifactId=saved.id;
  await linkPendingArtifact(db,session,pending,context.runId,saved.id);
  await context.effects.fault('registered');
  if(options.environment==='live') await matchingDev(context.config,saved,context.hostFacts,context.effects.deployedImage,context.effects.now());
  await admitArtifact(db,session,saved.id);
  await protectBaseline(db,session,saved.id,saved.baseline??context.accepted.manifest);
  return 'candidate';
}
export async function compare(context:ImportContext):Promise<void> {
  requireState(context,'session','candidate','accepted'); const saved=currentArtifact(context);
  context.comparison=await compareServing(context.db,context.accepted.manifest,context.candidate.facts);
  const raw=context.baseline ? compareSnapshots(context.baseline.facts,context.candidate.facts,context.effects.now(),
    context.accepted.observation && context.pending ? {accepted:context.accepted.observation,candidate:context.pending.observation}:undefined) : null;
  await context.space.json(join(context.reports,`${saved.id}-comparison.json`),{...context.comparison,raw});
  await fenced(context.db,context.session,tx=>tx.execute(sql`update import_runs set changes=${JSON.stringify({new:context.comparison!.added.length,updated:context.comparison!.changed.length,removed:context.comparison!.removed.length})}::jsonb where id=${context.runId}::uuid`));
}

export async function load(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'candidate');
  const saved = currentArtifact(context);
  await startAttempt(context.db, context.session, context.runId, saved.id);
  await stage(context, 'load');
  if (!saved.generation_id) {
    await checkExtraction(context.candidate.dir, context.candidate.hashes);
    await context.effects.loadFromExtract(context.db, context.candidate.dir, {
      privateErrors: true,
      onGeneration: (tx, id) => linkGeneration(tx, context.session, saved.id, id),
    });
    context.artifact = await artifact(context.db, saved.id);
  }
  context.generation = Number(currentArtifact(context).generation_id);
  await context.effects.fault('loaded');
}
export async function verify(context: ImportContext): Promise<void> {
  requireState(context, 'generation');
  await stage(context, 'verify');
  const result = await context.effects.verifyCorpus(context.db, context.generation, {
    outDir: context.reports,
    maxReportBytes: context.space.limits.report,
    readOnly: context.recertifying,
  });
  if (!result.ok || result.conflict) throw new ImportFailure('verification');
  context.genericReport = result.reportSha256;
}
export async function plan(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'generation', 'comparison');
  await stage(context, 'plan');
  const saved = currentArtifact(context);
  const { embeddingModel: model, embeddingDimensions: dims } = context.appConfig.ai.openai;
  context.embedding = { model, dims, usdPerMillionTokens: embeddingUsdPerMillion(model) };
  context.plan = await context.effects.planPassages(context.db, {
    generationId: context.generation,
    embedding: context.embedding,
    log: () => {},
    mapRecord: validateRecord,
  });
  if (!context.plan.cache.available) throw new ImportFailure('interrupted', false);
  if (context.options.cacheOnly && context.plan.toEmbed.inputs !== 0)
    throw new ImportFailure('cache_miss', false);
  const ledger = createLedgerSpendGate(context.db, {
    import: { artifactId: saved.id, fence: context.session.fence },
    budgets: context.appConfig.ai.budgets,
    provider: 'openai',
    model,
    stage: 'embed',
  });
  const required = context.plan.reservationUsd * 3;
  if (required > (await budgetRemaining(context.db, context.session, saved.id)) + 1e-9)
    throw new ImportFailure('import_cap');
  if (required > (await ledger.remainingUsd('indexing')) + 1e-9)
    throw new ImportFailure('monthly_budget', false);
  context.gate = {
    async reserve(request) {
      context.session.assertLocked();
      return ledger.reserve(request);
    },
    settle: (reservation, outcome) => ledger.settle(reservation, outcome),
    async remainingUsd(category) {
      return Math.min(
        await budgetRemaining(context.db, context.session, saved.id),
        await ledger.remainingUsd(category),
      );
    },
  };
  await context.space.json(join(context.reports, `${saved.id}-plan.json`), {
    archive: saved.archive_sha256,
    content: saved.content_sha256,
    generation: context.generation,
    comparison: context.comparison.hash,
    embedding: context.embedding,
    priceIdentity: digest([context.embedding, context.config.code, 3]),
    maxAttempts: 3,
    plan: {
      passages: context.plan.passages,
      cacheHits: context.plan.cache.hits,
      cacheMisses: context.plan.toEmbed.inputs,
      reservationUsd: context.plan.reservationUsd,
    },
  });
}

async function reusable(
  context: ImportContext,
  kind: 'cases' | 'passages',
): Promise<{ index: string; buildId: string } | null> {
  requireState(context, 'session');
  context.session.assertLocked();
  const alias = `${context.appConfig.elasticsearch.indexPrefix}-${kind}`;
  const result = await reconcileAlias(context.es, context.db, alias, {
    lockTimeoutMs: 5000,
  });
  if (result.unresolved.length || result.targets.length > 1) throw new ImportFailure('alias_unknown', false);
  const saved = currentArtifact(context);
  return reusableReference(context.db, saved.id, Number(saved.generation_id), alias);
}
export async function indexCases(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'generation');
  await stage(context, 'index_cases');
  const saved = currentArtifact(context);
  context.cases =
    (await reusable(context, 'cases')) ??
    (await context.effects.rebuildCasesIndex(context.es, context.db, {
      generationId: context.generation,
      prefix: context.appConfig.elasticsearch.indexPrefix,
      log: () => {},
      onReady: (candidate) =>
        registerCandidate(
          context.db,
          context.session,
          saved.id,
          candidate.index,
          candidate.buildId,
          context.generation,
        ),
    }));
  await context.effects.fault('cases_built');
}
export async function indexPassages(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'generation', 'plan', 'embedding', 'gate');
  await stage(context, 'index_passages');
  const saved = currentArtifact(context);
  const cacheOnly = context.options.cacheOnly || context.plan.toEmbed.inputs === 0;
  const embedder = cacheOnly
    ? cacheOnlyEmbedder(context.embedding)
    : context.effects.paidEmbedder(
        context.config,
        context.options.environment,
        context.embedding,
        context.gate,
        saved.id,
      );
  context.passages =
    (await reusable(context, 'passages')) ??
    (await context.effects.rebuildPassagesIndex(context.es, context.db, embedder, {
      generationId: context.generation,
      prefix: context.appConfig.elasticsearch.indexPrefix,
      cacheOnly,
      confirmCost: !cacheOnly,
      mapRecord: validateRecord,
      gate: cacheOnly ? createDryRunSpendGate(context.gate) : context.gate,
      log: () => {},
      onReady: (candidate) =>
        registerCandidate(
          context.db,
          context.session,
          saved.id,
          candidate.index,
          candidate.buildId,
          context.generation,
        ),
    }));
  await context.effects.fault('passages_built');
}
export async function validate(context: ImportContext): Promise<void> {
  requireState(
    context,
    'session',
    'generation',
    'cases',
    'passages',
    'candidate',
    'comparison',
    'embedding',
    'accepted',
    'genericReport',
  );
  await stage(context, 'validate');
  const saved = currentArtifact(context);
  const pair = {
    generationId: context.generation,
    casesIndex: context.cases.index,
    passagesIndex: context.passages.index,
  };
  const probes = await context.effects.probeCandidate(
    context.db,
    context.es,
    pair,
    context.candidate.facts,
    context.comparison,
    context.embedding,
  );
  const dev =
    context.options.environment === 'live'
      ? await matchingDev(
          context.config,
          saved,
          context.hostFacts,
          context.effects.deployedImage,
          context.effects.now(),
        )
      : null;
  context.certificate = {
    version: 'import-certificate.v2',
    artifactId: saved.id,
    archive: saved.archive_sha256,
    content: saved.content_sha256,
    environment: context.options.environment,
    baseline: context.accepted.manifest,
    candidate: {
      ...pair,
      casesBuildId: context.cases.buildId,
      passagesBuildId: context.passages.buildId,
    },
    code: context.config.code,
    deployedCode: context.config[context.options.environment]!.image,
    policy: POLICY_VERSION,
    genericReport: context.genericReport,
    comparison: context.comparison.hash,
    probes: probes.hash,
    dev,
  };
  await context.space.json(
    join(context.reports, `${saved.id}-certificate.json`),
    context.certificate,
  );
  await context.space.json(
    join(context.reports, `certificate-${digest(context.certificate)}.json`),
    context.certificate,
  );
  await saveCertificate(context.db, context.session, context.certificate);
}
export async function publish(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'certificate', 'embedding');
  await stage(context, 'publish');
  context.publication = await activate(
    context.db,
    context.es,
    context.session,
    context.certificate,
    context.embedding,
    async () => {
      await context.effects.workerIdentity(context.config.code, APP_DIR);
      await context.effects.deployedImage(context.config[context.options.environment]!);
      if (context.options.environment === 'live') {
        await matchingDev(
          context.config,
          currentArtifact(context),
          context.hostFacts,
          context.effects.deployedImage,
          context.effects.now(),
        );
      }
    },
  );
  await context.effects.fault('published');
}
/** A publication committed before an interruption is revalidated under the running worker before canary acceptance. */
export async function resumePublished(context: ImportContext): Promise<void> {
  requireState(context,'session'); const a=currentArtifact(context);
  if(!a.publication) throw new ImportFailure('integrity');
  context.publication=a.publication; context.generation=a.publication.generationId;
  await verify(context);
  const comparison:Comparison={policy:POLICY_VERSION,baseline:a.content_sha256,candidate:a.content_sha256,ok:true,failures:[],changed:[],added:[],removed:[],reassociated:[],usMembershipLost:[],cases:[],counts:{},hash:digest([])};
  await context.effects.probeCandidate(context.db,context.es,a.publication,undefined,comparison,
    {model:context.appConfig.ai.openai.embeddingModel,dims:context.appConfig.ai.openai.embeddingDimensions});
}
export async function canary(context: ImportContext, recertification = false): Promise<void> {
  requireState(context, 'session', 'accepted');
  if (!recertification) requireState(context, 'publication');
  await stage(context, 'canary');
  const snapshot = recertification ? context.baseline : context.candidate;
  const publication = recertification ? context.accepted.manifest : context.publication;
  if (context.artifact && !recertification) {
    await context.space.json(
      join(context.reports, `${context.artifact.id}-publication.json`),
      {
        publication,
        sha256: digest(publication),
      },
    );
  }
  if (!publication) throw new ImportFailure('integrity');
  const counts=await servingCounts(context.db,publication);
  const app=context.effects.applicationProbe(context.config[context.options.environment]!,CASES_INDEX_VERSION,
    {cases:counts.us,eligible:counts.eligible,sample:counts.sample});
  await context.effects.propagate(app, publication);
  const probes = await context.effects.runCanary(context.db, publication, app);
  const evidence: Canary = {
    publication,
    archive: recertification?context.accepted.archive:context.artifact!.archive_sha256,
    content: recertification?context.accepted.content:context.artifact!.content_sha256,
    code: context.config.code,
    deployedCode: app.deployedCode,
    probes,
    checkedAt: context.effects.now().toISOString(),
  };
  await recordSuccess(context.db, context.session, {
    runId: context.runId,
    artifactId: context.artifact?.id ?? null,
    kind: recertification ? 'recertification' : 'publication',
    canary: evidence,
    accepted: {
      archive: recertification?context.accepted.archive:context.artifact!.archive_sha256,
      content: recertification?context.accepted.content:context.artifact!.content_sha256,
      csvHash: snapshot?.csvHash??context.accepted.csvHash,
      manifest: publication,
      observation: recertification ? context.accepted.observation : context.pending?.observation ?? context.accepted.observation,
      code: context.config.code,
    },
    evidence: digest([evidence, context.genericReport ?? null, context.certificate ?? null]),
    sourceChecked: context.sourceChecked,
  });
  if(!recertification) context.pending = null;
  await context.effects.fault('accepted');
}

/** Free re-certification validates the serving pair without a load, provider, attempt increment or cap reset. */
export async function recertify(context: ImportContext): Promise<void> {
  requireState(context,'session','accepted'); context.recertifying=true;
  await startRecertification(context.db,context.session,context.runId,context.accepted.archive);
  // Keep the waiting artifact out of the serving-data attestation.
  context.artifact=null;
  context.generation=context.accepted.manifest.generationId;
  await verify(context);
  const empty:Comparison={policy:POLICY_VERSION,baseline:context.accepted.content,candidate:context.accepted.content,
    ok:true,failures:[],changed:[],added:[],removed:[],reassociated:[],usMembershipLost:[],cases:[],counts:{},hash:digest([])};
  await context.effects.probeCandidate(context.db,context.es,context.accepted.manifest,undefined,empty,
    {model:context.appConfig.ai.openai.embeddingModel,dims:context.appConfig.ai.openai.embeddingDimensions});
  await canary(context,true);
}
export async function cleanup(context: ImportContext): Promise<void> {
  requireState(context, 'session');
  // Do not downgrade an already committed successful run to the intermediate cleanup step.
  context.step = 'cleanup';
  await context.effects.retainDatabase(context.db, context.es, context.session);
  await context.effects.retainFiles(
    context.db,
    context.config,
    context.options.environment,
    context.space,
    context.hostFacts,
  );
}
export async function report(
  context: ImportContext,
  result: RunReport['result'],
  reason: RunReport['reason'],
): Promise<RunReport> {
  const state = await control(context.db);
  const accepted = state.accepted!;
  const accounting = context.artifact
    ? await accountingReport(context.db, context.artifact.id)
    : { reservationUsd: 0, chargedUsd: 0, attempts: [] };
  return {
    result,
    reason,
    archive: accepted.archive,
    content: accepted.content,
    generationId: accepted.manifest.generationId,
    elapsedMs: Date.now() - context.started,
    peakBytes: context.space.peakBytes,
    remoteRefreshOwed: refreshOwed(state.lastRemoteFetchAt, context.effects.now()),
    cacheMisses: context.plan?.toEmbed.inputs ?? 0,
    reservationUsd: result === 'unchanged' ? 0 : accounting.reservationUsd,
    chargedUsd: result === 'unchanged' ? 0 : accounting.chargedUsd,
  };
}
export async function unchanged(
  context: ImportContext,
  reason: NonNullable<RunReport['reason']>,
): Promise<RunReport> {
  requireState(context, 'session', 'accepted');
  if (!sameManifest(await manifest(context.db), context.accepted.manifest))
    throw new ImportFailure('baseline_changed');
  const saved = await latestCanary(context.db, context.accepted.content);
  const refresh =
    context.options.recertify ||
    (!context.options.noChange &&
      context.options.environment === 'dev' &&
      context.config.live &&
      (!saved ||
        saved.code !== context.config.code ||
        saved.deployedCode !== context.config.dev.image ||
        !sameManifest(saved.publication, context.accepted.manifest) ||
        context.effects.now().getTime() - Date.parse(saved.checkedAt) > 23 * 3_600_000));
  if (refresh) {
    await recertify(context);
    await cleanup(context);
    if(!context.options.recertify && !context.pending) {
      await resolveIssues(context.db,context.session,true,false);
      await fenced(context.db,context.session,tx=>tx.execute(sql`update import_runs set good_check=true where id=${context.runId}::uuid`));
    }
    return report(context, 'unchanged', reason);
  }
  if (!context.options.noChange) await cleanup(context);
  if(!context.pending) {
    await resolveIssues(context.db,context.session,true,false);
    await fenced(context.db,context.session,tx=>tx.execute(sql`update import_runs set good_check=true where id=${context.runId}::uuid`));
  }
  await updateRun(context.db, context.session, context.runId, {
    step: 'complete',
    result: 'unchanged',
    reason,
    observedSha256: context.accepted.archive,
    sourceCheckSucceeded: context.sourceChecked,
  });
  return report(context, 'unchanged', reason);
}
