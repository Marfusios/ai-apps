/** State path: baseline → detect/acquire → extract/register → compare → load/verify → plan/index
 * → validate/publish → canary/accept → retention. A latch or pending fetch always precedes detection. */
import { join } from 'node:path';
import { APP_DIR } from '../config.js';
import { CASES_INDEX_VERSION } from '../index/cases-index.js';
import { cacheOnlyEmbedder, embeddingUsdPerMillion } from '../index/embed.js';
import { createDryRunSpendGate, createLedgerSpendGate } from '../index/spend-gate.js';
import { reconcileAlias } from '../index/publications.js';
import { compareSnapshots } from './compare.js';
import { checkApproval } from './approval.js';
import { ImportFailure, POLICY_VERSION, safeLog, sameManifest } from './contracts.js';
import { checkExtraction, privateDirectory } from './files.js';
import { recoverExtraction, seedArchive } from './extraction.js';
import { digest } from './provenance.js';
import { refreshOwed, sameObservation } from './source.js';
import { matchingDev } from './facts.js';
import {
  observePending,
  PendingSchema,
  recordSuccess,
  setPending,
  recordLegacy,
  linkPendingArtifact,
  resolveAbandonedFetch,
} from './durable.js';
import {
  accept,
  artifact,
  beginRun,
  budgetRemaining,
  control,
  findContent,
  linkGeneration,
  manifest,
  registerArtifact,
  registerCandidate,
  admitArtifact,
  startAttempt,
  startRecertification,
  unresolvedArtifacts,
  unresolvedPreartifactReviews,
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
  requireState(context, 'session');
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
  const latched = await unresolvedArtifacts(context.db);
  const prior = await unresolvedPreartifactReviews(context.db);
  if (latched.length || context.pending?.needsReview || prior.length) {
    context.blocked = true;
    context.artifact = latched[0] ?? null;
    // A newer upstream advertisement is recorded without downloading or moving the candidate.
    try {
      await observePending(context.db, context.session, await context.source.inspect());
    } catch {
      /* original review remains authoritative */
    }
    throw new ImportFailure(
      context.artifact?.reason ??
        context.pending?.reason ??
        prior[0]?.reason ??
        'verification',
    );
  }
}

/** Availability precedes extraction/builds and does not create a source-data review. */
export async function preflight(context: ImportContext): Promise<void> {
  if (context.options.noChange) return;
  await context.effects.deployedImage(context.config[context.options.environment]!);
  await context.effects.applicationAvailable(context.config[context.options.environment]!);
}

export async function establishBaseline(context: ImportContext): Promise<void> {
  requireState(context, 'session');
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
    await recordLegacy(context.db, context.session, context.accepted);
  } else {
    context.accepted = state.accepted;
    context.baseline = await context.effects.readSnapshot(
      context.space,
      state.accepted.archive,
    );
    if (
      context.baseline.csvHash !== state.accepted.csvHash ||
      context.baseline.facts.digest !== state.accepted.content
    ) {
      throw new ImportFailure('integrity');
    }
    await context.effects.verifyBaseline(
      context.db,
      context.baseline,
      state.accepted.manifest,
      false,
    );
  }
  // Upgrade recovery for 0027 candidates: preserve their original identity and never fetch a replacement first.
  if (!context.pending) {
    const outstanding = await outstandingArtifacts(context.db, context.options.environment);
    if (outstanding.length > 1) throw new ImportFailure('accounting');
    if (outstanding[0]) {
      const saved = outstanding[0];
      const original = await originalFetch(context.db, saved.id);
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

export async function detect(
  context: ImportContext,
): Promise<'pending' | 'unchanged' | 'acquire'> {
  requireState(context, 'session', 'accepted');
  if (context.pending) {
    if (context.options.noChange || context.options.recertify)
      throw new ImportFailure('interrupted', false);
    context.observation = context.pending.observation;
    context.sourceChecked = false;
    return 'pending';
  }
  if (context.options.forcedDev) {
    const completed = await findContent(
      context.db,
      context.options.environment,
      context.accepted.content,
    );
    if (completed?.canary) throw new ImportFailure('configuration', false);
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
    state.lastFetched?.state === 'reviewed_abandoned' &&
    sameObservation(context.observation, state.lastFetched.observation)
  )
    return 'unchanged';
  if (
    !context.options.forcedDev &&
    sameObservation(context.observation, context.accepted.observation) &&
    !refreshOwed(state.lastRemoteFetchAt, context.effects.now())
  )
    return 'unchanged';
  return 'acquire';
}

export async function acquire(context: ImportContext): Promise<'pending' | 'unchanged'> {
  requireState(context, 'session', 'accepted', 'observation');
  if (context.pending) return 'pending';
  await stage(context, 'acquire');
  const acquired = context.options.forcedDev
    ? { sha256: context.accepted.archive, fetchedAt: context.effects.now().toISOString() }
    : await context.source.acquire(context.observation, context.space);
  context.pending = {
    archive: acquired.sha256,
    observation: context.options.forcedDev
      ? context.accepted.observation
      : context.observation,
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
  if (await resolveAbandonedFetch(context.db, context.session)) {
    context.pending = null;
    return 'unchanged';
  }
  return 'pending';
}

export async function extract(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'pending');
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

export async function register(
  context: ImportContext,
): Promise<'same_archive' | 'same_content' | 'candidate'> {
  requireState(context, 'session', 'candidate', 'accepted', 'current');
  const { db, session, options, pending } = context;
  if (!pending) throw new ImportFailure('integrity');
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
    return context.candidate.archive === context.accepted.archive
      ? 'same_archive'
      : 'same_content';
  }
  if (await resolveAbandonedFetch(db, session)) {
    context.pending = null;
    return 'same_content';
  }
  if (saved?.resolved_at || saved?.rollback || saved?.needs_review)
    throw new ImportFailure(saved.reason ?? 'baseline_changed');
  if (saved?.archive_sha256 && saved.archive_sha256 !== context.candidate.archive) {
    context.candidate = await context.effects.readSnapshot(
      context.space,
      saved.archive_sha256,
    );
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
  await linkPendingArtifact(db, session, pending, context.runId, saved.id);
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
  await admitArtifact(db, session, saved.id);
  await protectBaseline(db, session, saved.id, context.accepted.manifest);
  return 'candidate';
}

export async function compare(context: ImportContext): Promise<void> {
  requireState(context, 'session', 'baseline', 'candidate', 'accepted', 'pending');
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
  if (result.unresolved.length) throw new ImportFailure('alias_unknown', false);
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
    'approvedReasons',
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
  requireState(context, 'session', 'candidate', 'comparison');
  await startAttempt(context.db, context.session, context.runId, currentArtifact(context).id);
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
  requireState(context, 'session', 'accepted');
  if (recertification) requireState(context, 'baseline');
  else requireState(context, 'candidate', 'publication');
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
  if (!snapshot || !publication) throw new ImportFailure('integrity');
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
  requireState(context, 'session', 'accepted', 'baseline');
  context.recertifying = true;
  await startRecertification(
    context.db,
    context.session,
    context.runId,
    context.accepted.archive,
  );
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
  await context.effects.verifyBaseline(
    context.db,
    context.baseline,
    context.accepted.manifest,
    false,
  );
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
    return report(context, 'unchanged', reason);
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
