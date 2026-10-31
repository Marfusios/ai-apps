/** State path: baseline → detect/acquire → extract/register → compare → load/verify → plan/index
 * → validate/publish → canary/accept → retention. A latch or pending fetch always precedes detection. */
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { APP_DIR } from '../config.js';
import { CASES_INDEX_VERSION } from '../index/cases-index.js';
import { cacheOnlyEmbedder, embeddingUsdPerMillion } from '../index/embed.js';
import { createDryRunSpendGate, createLedgerSpendGate } from '../index/spend-gate.js';
import { reconcileAlias } from '../index/publications.js';
import { compareSnapshots } from './compare.js';
import { checkApproval } from './approval.js';
import { ImportFailure, POLICY_VERSION, safeLog, sameManifest } from './contracts.js';
import { checkExtraction, privateDirectory } from './files.js';
import { privateJson, recoverExtraction, seedArchive } from './extraction.js';
import { digest } from './provenance.js';
import { refreshOwed, sameObservation } from './source.js';
import { matchingDev } from './facts.js';
import {
  observePending,
  PendingSchema,
  recordSuccess,
  setPending,
  setPendingTransaction,
} from './durable.js';
import {
  accept,
  artifact,
  beginRun,
  budgetRemaining,
  control,
  findContent,
  fenced,
  linkGeneration,
  manifest,
  registerArtifact,
  registerCandidate,
  resumeArtifact,
  saveCertificate,
  updateRun,
  accountingReport,
  type Artifact,
  type Canary,
} from './store.js';
import { replayOutage } from './recovery.js';
import { activate, protectBaseline } from './lifecycle.js';
import { validateRecord } from './strict-es.js';
import type { ImportContext, RunReport } from './runtime.js';
import type { ImportStep, ManifestIdentity } from './contracts.js';

export function currentArtifact(context: ImportContext): Artifact {
  if (!context.artifact) throw new ImportFailure('integrity');
  return context.artifact;
}
export async function stage(context: ImportContext, step: ImportStep): Promise<void> {
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
  await privateDirectory(context.space.root);
  await privateDirectory(context.reports);
  await replayOutage(context.db, context.session, context.space, context.options.environment);
  context.runId = await beginRun(
    context.db,
    context.session,
    context.options.forcedDev ? 'forced_dev' : 'automatic',
  );
  await recoverExtraction(context.space);
  const state = await control(context.db);
  context.pending = state.pending ? PendingSchema.parse(state.pending) : null;
  const latched = await context.db.execute(sql`select * from import_artifacts
    where needs_review and resolved_at is null order by created_at limit 1`);
  const prior = await context.db
    .execute(sql`select reason from import_runs r where result='needs_review' and artifact_id is null
    and acknowledged_at is null and not exists(select 1 from import_attestations t
      where t.kind='rebaseline' and t.accepted->>'resolvedPendingRun' in (r.id::text,r.pending_run_id::text)) order by checked_at limit 1`);
  if (latched.rows.length || context.pending?.needsReview || prior.rows.length) {
    context.blocked = true;
    if (latched.rows[0]) context.artifact = latched.rows[0] as unknown as Artifact;
    // A newer upstream advertisement is recorded without downloading or moving the candidate.
    try {
      await observePending(context.db, context.session, await context.source.inspect());
    } catch {
      /* original review remains authoritative */
    }
    throw new ImportFailure(context.artifact?.reason ?? context.pending?.reason ?? 'verification');
  }
}

/** Availability precedes extraction/builds and does not create a source-data review. */
export async function preflight(context: ImportContext): Promise<void> {
  if (context.options.noChange) return;
  await context.effects.deployedImage(context.config[context.options.environment]!);
  await context.effects.applicationAvailable(context.config[context.options.environment]!);
}

export async function establishBaseline(context: ImportContext): Promise<void> {
  const state = await control(context.db);
  const current = await manifest(context.db);
  if (!current) throw new ImportFailure('baseline_required');
  context.current = current;
  if (!state.accepted) {
    const seed = context.options.seed;
    if (!seed) throw new ImportFailure('baseline_required');
    await seedArchive(context.space, seed.path, seed.sha256);
    context.baseline = await context.effects.extractSnapshot(
      context.space,
      seed.sha256,
      context.options.environment,
      context.session.assertLocked,
    );
    await context.effects.verifyBaseline(context.db, context.baseline, current);
    context.accepted = {
      archive: seed.sha256,
      content: context.baseline.facts.digest,
      csvHash: context.baseline.csvHash,
      manifest: current,
      observation: seed.observation,
      code: context.config.code,
    };
    await fenced(context.db, context.session, async (tx) => {
      await tx.execute(sql`insert into import_attestations(kind,publication,accepted,evidence_sha256)
        values('legacy',${JSON.stringify(current)}::jsonb,${JSON.stringify(context.accepted)}::jsonb,${digest(context.accepted)})`);
      await tx.execute(
        sql`select import_accept(${context.session.fence}::uuid,${JSON.stringify(context.accepted)}::jsonb,false)`,
      );
    });
  } else {
    context.accepted = state.accepted;
    context.baseline = await context.effects.readSnapshot(context.space, state.accepted.archive);
    if (
      context.baseline.csvHash !== state.accepted.csvHash ||
      context.baseline.facts.digest !== state.accepted.content
    ) {
      throw new ImportFailure('integrity');
    }
    await context.effects.verifyBaseline(context.db, context.baseline, state.accepted.manifest);
  }
  // Upgrade recovery for 0027 candidates: preserve their original identity and never fetch a replacement first.
  if (!context.pending) {
    const outstanding = await context.db.execute(sql`select * from import_artifacts
      where environment=${context.options.environment} and canary is null and resolved_at is null order by created_at limit 2`);
    if (outstanding.rows.length > 1) throw new ImportFailure('accounting');
    if (outstanding.rows[0]) {
      const saved = outstanding.rows[0] as unknown as Artifact;
      const runs = await context.db
        .execute(sql`select id,source,to_char(checked_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as checked from import_runs where artifact_id=${saved.id}::uuid order by checked_at limit 1`);
      const original = runs.rows[0];
      if (!original?.source) throw new ImportFailure('accounting');
      context.pending = PendingSchema.parse({
        archive: saved.archive_sha256,
        content: saved.content_sha256,
        artifactId: saved.id,
        runId: original.id,
        observation: original.source,
        fetchedAt: original.checked,
        attempts: 0,
        needsReview: false,
        reason: null,
      });
      await setPending(context.db, context.session, context.pending);
    }
  }
  if (context.pending?.artifactId)
    context.artifact = await artifact(context.db, context.pending.artifactId);
  if (
    !sameManifest(current, context.accepted.manifest) &&
    !sameManifest(current, context.artifact?.publication ?? null)
  )
    throw new ImportFailure('baseline_changed');
}

export async function detect(context: ImportContext): Promise<'pending' | 'unchanged' | 'acquire'> {
  if (context.pending) {
    if (context.options.noChange || context.options.recertify)
      throw new ImportFailure('interrupted', false);
    context.observation = context.pending.observation;
    context.sourceChecked = false;
    return 'pending';
  }
  if (context.options.recertify) {
    context.observation = context.accepted.observation;
    context.sourceChecked = false;
    return 'unchanged';
  }
  context.observation = await context.source.inspect();
  context.sourceChecked = true;
  await updateRun(context.db, context.session, context.runId, {
    step: 'check',
    result: 'running',
    source: context.observation,
  });
  if (context.options.noChange) {
    if (!sameObservation(context.observation, context.accepted.observation))
      throw new ImportFailure('source_reissued', false);
    return 'unchanged';
  }
  const state = await control(context.db);
  if (
    !context.options.forcedDev &&
    sameObservation(context.observation, context.accepted.observation) &&
    !refreshOwed(state.lastRemoteFetchAt, context.effects.now())
  )
    return 'unchanged';
  return 'acquire';
}

export async function acquire(context: ImportContext): Promise<void> {
  if (context.pending) return;
  await stage(context, 'acquire');
  const acquired = context.options.forcedDev
    ? { sha256: context.accepted.archive, fetchedAt: context.effects.now().toISOString() }
    : await context.source.acquire(context.observation, context.space);
  context.pending = {
    archive: acquired.sha256,
    observation: context.options.forcedDev ? context.accepted.observation : context.observation,
    fetchedAt: acquired.fetchedAt,
    runId: context.runId,
    artifactId: null,
    content: null,
    attempts: 0,
    needsReview: false,
    reason: null,
  };
  // No refresh clock can advance without the fetched identity that must be resolved next.
  await setPending(context.db, context.session, context.pending, !context.options.forcedDev);
  await context.effects.fault('fetched');
}

export async function extract(context: ImportContext): Promise<void> {
  await stage(context, 'extract');
  const pending = context.pending!;
  if (!pending.artifactId) {
    if (pending.attempts >= 4) throw new ImportFailure('interrupted', true);
    pending.attempts++;
    await setPending(context.db, context.session, pending);
  }
  context.candidate = await context.effects.extractSnapshot(
    context.space,
    pending.archive,
    context.options.environment,
    context.session.assertLocked,
  );
  if (pending.content && pending.content !== context.candidate.facts.digest)
    throw new ImportFailure('integrity');
  pending.content = context.candidate.facts.digest;
  await setPending(context.db, context.session, pending);
  await context.effects.fault('extracted');
}

export async function register(context: ImportContext): Promise<'unchanged' | 'candidate'> {
  const { db, session, options, pending } = context;
  let saved = await findContent(db, options.environment, context.candidate.facts.digest);
  if (
    !options.forcedDev &&
    context.candidate.facts.digest === context.accepted.content &&
    sameManifest(context.current, context.accepted.manifest) &&
    (!saved || saved.canary || saved.resolved_at)
  ) {
    // Packaging alone updates the advertisement, not the corpus identity or original artifact allowance.
    await accept(db, session, { ...context.accepted, observation: pending!.observation });
    context.accepted = { ...context.accepted, observation: pending!.observation };
    context.pending = null;
    return 'unchanged';
  }
  if (saved?.resolved_at || saved?.rollback || saved?.needs_review)
    throw new ImportFailure(saved.reason ?? 'baseline_changed');
  if (saved?.archive_sha256 && saved.archive_sha256 !== context.candidate.archive) {
    context.candidate = await context.effects.readSnapshot(context.space, saved.archive_sha256);
  }
  saved ??= await registerArtifact(
    db,
    session,
    options.environment,
    context.candidate.archive,
    context.candidate.facts.digest,
    context.accepted.manifest,
  );
  context.artifact = saved;
  pending!.artifactId = saved.id;
  await fenced(db, session, async (tx) => {
    await setPendingTransaction(tx, session, pending!);
    await tx.execute(sql`update import_runs set artifact_id=${saved.id}::uuid where id in (${context.runId}::uuid,${pending!.runId}::uuid)
      and artifact_id is null`);
  });
  await context.effects.fault('registered');
  if (
    saved.canary ||
    !sameManifest(saved.baseline, context.accepted.manifest) ||
    !(
      sameManifest(context.current, context.accepted.manifest) ||
      sameManifest(context.current, saved.publication)
    )
  ) {
    throw new ImportFailure('baseline_changed');
  }
  if (options.environment === 'live')
    await matchingDev(
      context.config,
      saved,
      context.hostFacts,
      context.effects.deployedImage,
      context.effects.now(),
    );
  await resumeArtifact(db, session, saved.id);
  await protectBaseline(db, session, saved.id, context.accepted.manifest);
  return 'candidate';
}

export async function compare(context: ImportContext): Promise<void> {
  const saved = currentArtifact(context);
  context.comparison = compareSnapshots(
    context.baseline.facts,
    context.candidate.facts,
    context.effects.now(),
    {
      accepted: context.accepted.observation,
      candidate: context.pending!.observation,
    },
  );
  await context.space.json(
    join(context.reports, `${saved.id}-comparison.json`),
    context.comparison,
  );
  await context.space.json(
    join(context.reports, `comparison-${context.comparison.hash}.json`),
    context.comparison,
  );
  context.approvedReasons = checkApproval(
    saved.approved,
    saved,
    context.accepted.manifest,
    context.config.code,
    context.comparison,
  );
}

export async function load(context: ImportContext): Promise<void> {
  await stage(context, 'load');
  const saved = currentArtifact(context);
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
  await stage(context, 'verify');
  const result = await context.effects.verifyCorpus(context.db, context.generation, {
    outDir: context.reports,
    maxReportBytes: context.space.limits.report,
  });
  if (!result.ok || result.conflict) throw new ImportFailure('verification');
  context.genericReport = result.reportSha256;
}
export async function plan(context: ImportContext): Promise<void> {
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
    throw new ImportFailure('import_cap');
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
  context.session.assertLocked();
  const alias = `${context.appConfig.elasticsearch.indexPrefix}-${kind}`;
  const result = await reconcileAlias(context.es, context.db, alias, { lockTimeoutMs: 5000 });
  if (result.unresolved.length) throw new ImportFailure('alias_unknown', false);
  const saved = currentArtifact(context);
  const rows = await context.db
    .execute(sql`select r.index_name,r.build_id from import_index_refs r join index_builds b on b.build_id=r.build_id
    where r.artifact_id=${saved.id}::uuid and r.generation_id=${Number(saved.generation_id)} and b.alias=${alias}
    and r.released_at is null and b.deletion_requested_at is null and b.deleted_at is null order by r.created_at desc`);
  if (rows.rows.length > 1) throw new ImportFailure('integrity');
  const row = rows.rows[0];
  return row ? { index: String(row.index_name), buildId: String(row.build_id) } : null;
}
export async function indexCases(context: ImportContext): Promise<void> {
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
    version: 'import-certificate.v1',
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
    approvedReasons: context.approvedReasons,
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
  context.publication = currentArtifact(context).publication!;
  context.generation = context.publication.generationId;
  await verify(context);
  await context.effects.verifyBaseline(context.db, context.candidate, context.publication);
  await context.effects.probeCandidate(
    context.db,
    context.es,
    context.publication,
    context.candidate.facts,
    context.comparison,
    {
      model: context.appConfig.ai.openai.embeddingModel,
      dims: context.appConfig.ai.openai.embeddingDimensions,
    },
  );
}
export async function canary(context: ImportContext, recertification = false): Promise<void> {
  await stage(context, 'canary');
  const snapshot = recertification ? context.baseline : context.candidate;
  const publication = recertification ? context.accepted.manifest : context.publication;
  if (context.artifact && !recertification) {
    await context.space.json(join(context.reports, `${context.artifact.id}-publication.json`), {
      publication,
      sha256: digest(publication),
    });
  }
  const rows = snapshot.facts.normalized.cases;
  const app = context.effects.applicationProbe(
    context.config[context.options.environment]!,
    CASES_INDEX_VERSION,
    {
      cases: rows.filter((row) => row.isUs).length,
      eligible: rows.filter((row) => row.answerEligible).length,
    },
  );
  await context.effects.propagate(app, publication);
  const probes = await context.effects.runCanary(context.db, publication, app);
  const evidence: Canary = {
    publication,
    archive: snapshot.archive,
    content: snapshot.facts.digest,
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
      archive: snapshot.archive,
      content: snapshot.facts.digest,
      csvHash: snapshot.csvHash,
      manifest: publication,
      observation: context.pending?.observation ?? context.accepted.observation,
      code: context.config.code,
    },
    evidence: digest([evidence, context.genericReport ?? null, context.certificate ?? null]),
    sourceChecked: context.sourceChecked,
  });
  context.pending = null;
  await context.effects.fault('accepted');
}

/** Free re-certification validates the serving pair without a load, provider, attempt increment or cap reset. */
export async function recertify(context: ImportContext): Promise<void> {
  const saved = await findContent(
    context.db,
    context.options.environment,
    context.accepted.content,
  );
  if (saved?.needs_review && !saved.resolved_at)
    throw new ImportFailure(saved.reason ?? 'verification');
  context.artifact =
    saved &&
    !saved.resolved_at &&
    !saved.rollback &&
    sameManifest(saved.publication, context.accepted.manifest)
      ? saved
      : null;
  context.generation = context.accepted.manifest.generationId;
  await verify(context);
  await context.effects.verifyBaseline(context.db, context.baseline, context.accepted.manifest);
  const comparison = compareSnapshots(
    context.baseline.facts,
    context.baseline.facts,
    context.effects.now(),
  );
  await context.effects.probeCandidate(
    context.db,
    context.es,
    context.accepted.manifest,
    context.baseline.facts,
    comparison,
    {
      model: context.appConfig.ai.openai.embeddingModel,
      dims: context.appConfig.ai.openai.embeddingDimensions,
    },
  );
  await canary(context, true);
}
export async function cleanup(context: ImportContext): Promise<void> {
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
  if (!sameManifest(await manifest(context.db), context.accepted.manifest))
    throw new ImportFailure('baseline_changed');
  const latest = await context.db
    .execute(sql`select canary from import_attestations where canary is not null
    and canary->>'content'=${context.accepted.content} order by created_at desc limit 1`);
  const saved = latest.rows[0]?.canary as Canary | undefined;
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
    return report(context, 'published', null);
  }
  if (!context.options.noChange) await cleanup(context);
  await updateRun(context.db, context.session, context.runId, {
    step: 'complete',
    result: 'unchanged',
    reason,
    observedSha256: context.accepted.archive,
    sourceCheckSucceeded: context.sourceChecked,
  });
  return report(context, 'unchanged', reason);
}
