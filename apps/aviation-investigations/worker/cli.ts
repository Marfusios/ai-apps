import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { closeDb, createDb, type Db } from '../server/db/client.js';
import { listGenerations, pruneGenerations } from '../server/db/generations.js';
import { runMigrations } from '../server/db/migrate.js';
import { pruneControls } from '../server/quota/retention.js';
import { expireLeases } from '../server/quota/settle.js';
import { readAiSwitch, setAiSwitch, setAnonymousAi } from '../server/quota/switch.js';
import { createEsClient } from '../server/search/es.js';
import { APP_DIR, workerConfig } from './config.js';
import { rebuildCasesIndex, type IndexReport } from './index/cases-index.js';
import { cacheOnlyEmbedder, createOpenAIEmbedder, embeddingUsdPerMillion } from './index/embed.js';
import { MAX_INPUT_TOKENS } from './index/passages.js';
import {
  PASSAGES_BUILD_MIN_POOL,
  planPassages,
  rebuildPassagesIndex,
  type PassagePlan,
  type PassagesIndexReport,
} from './index/passages-index.js';
import { createLedgerSpendGate, createMemorySpendGate } from './index/spend-gate.js';
import { cleanupStalePins, declareAbandoned, deleteUnusedIndices, reconcileAlias } from './index/publications.js';
import { PublishRefusedError, publishGeneration } from './index/publish.js';
import { importAviationSearchExport, importSeedLinks, type ImportReport } from './ingest/report-links.js';
import { extractArchive, isTerminating, setExtractEnvironment } from './ingest/extract.js';
import { describeWorkerError } from './errors.js';
import { loadFromExtract, type LoadReport } from './ingest/load.js';
import { STALE_RUN_MINUTES, failStaleRuns, listRunningRuns } from './ingest/runs.js';
import { readProfile, verifyCorpus, type VerifyReport } from './ingest/verify.js';

const USAGE = [
  'usage:',
  '  worker extract --archive <zip> --sha256 <hex> --out <dir>',
  '  worker load --from <extractDir>',
  '  worker verify --generation <id> [--profile <file>]',
  '  worker report-links --seed',
  '  worker report-links --export <file> --case-col <name> (--id-col <name> | --url-col <name>) [--aircraft-col <name>] [--date-col <name>] --retrieved-at <ISO date>',
  '  worker generations',
  '  worker prune-generations [--dry-run] [--grace-hours <n>]',
  '  worker prune-controls',
  '  worker fail-stale-runs --older-than-minutes <n>',
  '  worker index cases --generation <id>',
  '  worker index passages --generation <id> [--dry-run | --confirm-cost | --cache-only]',
  '  worker index reconcile --alias <alias> [--declare-abandoned <attempt-id> --reason <text>]',
  '  worker index delete-unused --older-than <hours> [--alias <alias>] [--yes]',
  '  worker index cleanup-builds --older-than <hours>',
  '  worker publish --generation <id> --cases-index <name> [--passages-index <name>]',
  '  worker ai-switch [--on | --off --note <text>] [--anonymous on | --anonymous off [--note <text>]]',
  '  worker migrate',
].join('\n');

/** Ingestion commands connect as aviation_ingest (DATABASE_INGEST_URL). */
function ingestDb(max = 2): Db {
  const url = workerConfig().databaseIngestUrl;
  if (!url) throw new Error('DATABASE_INGEST_URL is not set; run pnpm services:setup');
  return createDb(url, { max, applicationName: 'aviation-worker' });
}

async function withDb<T>(fn: (db: Db) => Promise<T>, max = 2): Promise<T> {
  const db = ingestDb(max);
  try {
    return await fn(db);
  } finally {
    await closeDb(db);
  }
}

function printLoad(r: LoadReport): void {
  const s = r.stats;
  const lines: [string, string | number][] = [
    ['run', r.runId],
    ['generation', `${r.generationId} (sealed, status loaded; next: pnpm worker verify --generation ${r.generationId})`],
    ['events', s.events],
    ['US events', s.usEvents],
    ['multi-aircraft events', s.multiAircraftEvents],
    ['aircraft', s.aircraft],
    ['sections', `${s.sections} (event-scoped ${s.eventScopedSections}, HTML-converted ${s.htmlTransformedSections})`],
    ['answer-eligible US', s.answerEligibleUs],
    ['completed without cause (US)', s.completedWithoutCauseUs],
    ['completed with cause (any country)', s.completedWithCause],
    ['events with several defining phases', s.eventsWithSeveralDefiningPhases],
    ['quarantine', Object.entries(s.quarantineByReason).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'],
    ['rows', Object.entries(r.rows).map(([k, v]) => `${k}=${v}`).join(', ')],
    ['completion mapping', `${r.mappingVersion}${r.cohortProvisional ? ' (unverified: answer cohort is provisional)' : ''}`],
    ['duration', `${(r.durationMs / 1000).toFixed(1)} s`],
  ];
  for (const [k, v] of lines) console.log(`${k}: ${v}`);
}

function printVerify(r: VerifyReport): void {
  const outcome = r.conflict ? 'CONFLICT (generation changed during verification; nothing recorded, run again)' : r.ok ? 'verified' : 'FAILED';
  console.log(`generation ${r.generationId}: ${outcome} (status ${r.statusBefore} -> ${r.status}, verifier ${r.verifierVersion})`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` (${c.failures})`}`);
  if (r.profile) {
    console.log(`profile ${r.profile.name}: ${r.profile.ok ? 'ok' : 'MISMATCH'}`);
    for (const m of r.profile.mismatches) console.log(`  ${m.measure}: expected ${m.expected}, got ${m.actual ?? 'missing'}`);
  } else {
    console.log('profile: none for this archive');
  }
  for (const key of ['events', 'usEvents', 'answerEligibleUs', 'completedWithoutCauseUs', 'uniqueNtsbNo', 'multiAircraftEvents']) {
    console.log(`  ${key}: ${r.counts[key] ?? 'n/a'}`);
  }
  console.log(`report: ${r.reportPath}`);
}

function printLinks(r: ImportReport): void {
  console.log(`report links (${r.source}, ${r.layout}) against generation ${r.generationId}`);
  console.log(`  file sha256 ${r.sourceFileSha256}, retrieved ${r.retrievedAt.toISOString()}`);
  console.log(`  label: ${r.sourceLabel}`);
  console.log(`  rows ${r.rows}, matched ${r.matched}, inserted ${r.inserted}, already present ${r.alreadyPresent}`);
  if (!r.dateChecked) console.warn(`  WARNING: ${r.dateUnchecked} row(s) were not date-checked (no --date-col or no event date); matches rest on case number alone`);
  for (const u of r.unmatched) console.log(`  unmatched ${u.ntsbNo} -> ${u.reportId} (${u.reason})`);
  for (const i of r.invalid) console.log(`  invalid row ${i.row}: ${i.reason}`);
}

function printIndex(r: IndexReport): void {
  const lines: [string, string | number][] = [
    ['index', r.index],
    ['build', r.buildId],
    ['alias (last built; the API reads the manifest)', `${r.alias} -> ${r.index}${r.aliasVerified ? '' : ' (committed; read-back failed)'}`],
    ['previous indices (kept)', r.previousIndices.join(', ') || 'none'],
    ['generation', r.generationId],
    ['version', `${r.version} (${r.fingerprint.slice(0, 12)})`],
    ['documents (US events)', r.documents],
    ['aircraft', r.aircraft],
    ['answer-eligible', r.answerEligible],
    ['multi-aircraft events (aircraft facets overlap)', r.multiAircraftEvents],
    ['events with several defining phases', r.eventsWithSeveralDefiningPhases],
    ['events without a defining phase', r.eventsWithoutDefiningPhase],
    ['unparsed defining-event labels', r.unparsedEventLabels],
    ['duration', `${(r.durationMs / 1000).toFixed(1)} s`],
  ];
  for (const [k, v] of lines) console.log(`${k}: ${v}`);
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const int = (n: number) => n.toLocaleString('en-US');

function printPlan(p: PassagePlan): void {
  const pct = p.inputTokenPercentiles;
  const lines: [string, string | number][] = [
    ['generation', p.generationId],
    ['chunker', `${p.chunkerVersion} (target ${p.chunkOptions.targetTokens}, max ${p.chunkOptions.maxTokens}, min ${p.chunkOptions.minTokens}, overlap ${p.chunkOptions.overlapTokens} tokens)`],
    ['embedding', `${p.embedding.model}, ${p.embedding.dims} dims, $${p.embedding.usdPerMillionTokens}/M tokens; input template ${p.templateVersion}; tokenizer ${p.tokenizer}`],
    ['US cases', `${int(p.usCases)} (answer-eligible ${int(p.answerEligibleCases)}, with passages ${int(p.casesWithPassages)})`],
    ['sections', int(p.sections)],
    ['passages', `${int(p.passages)} (aircraft-specific ${int(p.aircraftSpecific)}, event-scoped ${int(p.eventScoped)})`],
    [
      'event aircraft sets (checked against case_aircraft)',
      `${int(p.eventAircraft.events)} events complete: ${int(p.eventAircraft.passages)} event-scoped passages, ${int(p.eventAircraft.aircraft)} nested event aircraft`,
    ],
  ];
  for (const k of p.byKindScope) {
    lines.push([
      `  ${k.kind}/${k.scope}`,
      `${int(k.passages)} passages from ${int(k.sections)} sections (${int(k.wholeSections)} whole), ${int(k.inputTokens)} input tokens`,
    ]);
  }
  lines.push(
    ['input tokens (header + text, overlap included)', int(p.tokens.input)],
    ['  passage text', int(p.tokens.text)],
    ['  headers and separators', int(p.tokens.header)],
    ['  overlap (repeated text)', int(p.tokens.overlap)],
    ['input tokens per passage', `min ${pct.min}, p50 ${pct.p50}, p90 ${pct.p90}, p95 ${pct.p95}, p99 ${pct.p99}, max ${pct.max}, mean ${pct.mean.toFixed(1)}`],
    ['largest passage text', `${p.maxPassageTextTokens} tokens (input limit ${MAX_INPUT_TOKENS})`],
    ['largest whole probable cause', `${p.maxProbableCauseTokens} tokens (split above ${p.chunkOptions.maxTokens})`],
    ['continuation passages (A16)', int(p.continuations)],
    ['oversized units split (A16)', `probable causes ${p.oversized.probableCauses}, sentences ${p.oversized.longSentences}, character cuts ${p.oversized.forcedCharSplits}`],
    ['cases affected by A16 splits', p.oversized.cases.length === 0 ? 'none' : `${p.oversized.cases.length}: ${p.oversized.cases.join(', ')}`],
    ['distinct inputs', `${int(p.uniqueInputs)} (${int(p.duplicateInputs)} duplicates embedded once)`],
    ['cache hits expected', p.cache.available ? `${int(p.cache.hits)} inputs, ${int(p.cache.hitTokens)} tokens` : '0 (embedding_cache table not present in this database yet)'],
    ['to embed', `${int(p.toEmbed.inputs)} inputs, ${int(p.toEmbed.tokens)} tokens, ${int(p.toEmbed.requests)} requests${p.toEmbed.inputs === 0 && p.cache.available ? ' (every input is cached: --cache-only builds with no embedding call)' : ''}`],
    ['estimated cost', usd(p.estimatedUsd)],
    ['reservations (sum of single attempts, A7)', `$${p.reservationUsd.toFixed(6)}`],
    ['duration', `${(p.durationMs / 1000).toFixed(1)} s`],
  );
  for (const [k, v] of lines) console.log(`${k}: ${v}`);
}

function printPassagesIndex(r: PassagesIndexReport): void {
  const lines: [string, string | number][] = [
    ['index', r.index],
    ['alias (last built; the API reads the manifest)', `${r.alias} -> ${r.index}${r.aliasVerified ? '' : ' (committed, not read back)'}`],
    ['build', `${r.buildId} (switch attempt ${r.attemptId ?? 'none'})`],
    ['previous indices (kept)', r.previousIndices.join(', ') || 'none'],
    ['generation', r.generationId],
    ['version', `${r.version} (${r.fingerprint.slice(0, 12)}), ${r.model} ${r.dims} dims`],
    ['passages', `${int(r.passages)} (${int(r.passagesAlreadyStored)} already stored)`],
    ['cache hits (distinct inputs cached before this build)', int(r.cacheHits)],
    ['deduplicated (passages sharing an input)', int(r.deduplicated)],
    ['mode', r.cacheOnly ? 'cache only (no embedder; nothing paid)' : 'paid misses (--confirm-cost)'],
    ['embedded', `${int(r.embedded.inputs)} inputs, ${int(r.embedded.tokens)} tokens, ${int(r.embedded.requests)} requests, ${usd(r.embedded.usd)}`],
    ['duration', `${(r.durationMs / 1000).toFixed(1)} s`],
  ];
  for (const [k, v] of lines) console.log(`${k}: ${v}`);
}

async function indexPassages(id: number, mode: 'dry-run' | 'confirm-cost' | 'cache-only'): Promise<number> {
  const config = workerConfig();
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  const price = embeddingUsdPerMillion(model);
  if (mode === 'dry-run') {
    const plan = await withDb((db) =>
      planPassages(db, { generationId: id, embedding: { model, dims, usdPerMillionTokens: price }, log: (m) => console.error(m) }),
    );
    printPlan(plan);
    console.log(
      plan.toEmbed.inputs === 0 && plan.cache.available
        ? 'dry run: nothing written, no paid request made; 0 to embed: run with --cache-only to build the index from the cache'
        : 'dry run: nothing written, no paid request made; run with --confirm-cost to build the index',
    );
    return 0;
  }
  if (mode === 'cache-only') {
    // No OpenAI client and no ledger: the embedder throws on any call and the gate holds nothing.
    return withDb(async (db) => {
      const es = createEsClient(config.elasticsearch, 'write', { requestTimeoutMs: 120_000 });
      try {
        const report = await rebuildPassagesIndex(es, db, cacheOnlyEmbedder({ model, dims, usdPerMillionTokens: price }), {
          generationId: id,
          prefix: config.elasticsearch.indexPrefix,
          gate: createMemorySpendGate(0),
          confirmCost: false,
          cacheOnly: true,
          log: (m) => console.error(m),
        });
        printPlan(report.plan);
        printPassagesIndex(report);
      } finally {
        await es.close();
      }
      return 0;
    }, PASSAGES_BUILD_MIN_POOL);
  }
  return withDb(async (db) => {
    const gate = createLedgerSpendGate(db, { budgets: config.ai.budgets, provider: 'openai', model, stage: 'embed' });
    const embedder = createOpenAIEmbedder({
      apiKey: config.ai.openai.apiKey ?? '',
      model,
      dims,
      gate,
      purpose: `passages-g${id}`,
      log: (m) => console.error(m),
    });
    const es = createEsClient(config.elasticsearch, 'write', { requestTimeoutMs: 120_000 });
    try {
      const report = await rebuildPassagesIndex(es, db, embedder, {
        generationId: id,
        prefix: config.elasticsearch.indexPrefix,
        gate,
        confirmCost: true,
        log: (m) => console.error(m),
      });
      printPlan(report.plan);
      printPassagesIndex(report);
    } finally {
      await es.close();
    }
    return 0;
  }, PASSAGES_BUILD_MIN_POOL);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'extract') {
    const { values } = parseArgs({
      args: rest,
      options: {
        archive: { type: 'string' },
        sha256: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    });
    if (!values.archive || !values.sha256 || !values.out) {
      console.error(USAGE);
      return 2;
    }
    setExtractEnvironment(workerConfig().appEnv);
    const manifest = await extractArchive({ archive: values.archive, sha256: values.sha256, out: values.out });
    for (const [table, t] of Object.entries(manifest.tables)) {
      console.log(`${table}: ${t.rows} rows, ${t.columns} columns, ${t.bytes} bytes`);
    }
    return 0;
  }
  if (command === 'load') {
    const { values } = parseArgs({ args: rest, options: { from: { type: 'string' } }, strict: true });
    if (!values.from) {
      console.error(USAGE);
      return 2;
    }
    const from = values.from;
    const report = await withDb((db) => loadFromExtract(db, from));
    printLoad(report);
    return 0;
  }
  if (command === 'verify') {
    const { values } = parseArgs({
      args: rest,
      options: { generation: { type: 'string' }, profile: { type: 'string' } },
      strict: true,
    });
    const id = Number(values.generation);
    if (!values.generation || !Number.isSafeInteger(id) || id < 1) {
      console.error(USAGE);
      return 2;
    }
    const profile = values.profile ? readProfile(values.profile) : undefined;
    // AVIATION_VERIFY_DIR (absolute or app-relative); the ingest container sets a writable one.
    const verifyDir = workerConfig().verifyDir;
    const outDir = verifyDir ? resolve(APP_DIR, verifyDir) : undefined;
    const report = await withDb((db) =>
      verifyCorpus(db, id, { ...(profile ? { profile } : {}), ...(outDir ? { outDir } : {}) }),
    );
    printVerify(report);
    return report.ok && !report.conflict ? 0 : 1;
  }
  if (command === 'report-links') {
    const { values } = parseArgs({
      args: rest,
      options: {
        seed: { type: 'boolean' },
        export: { type: 'string' },
        'case-col': { type: 'string' },
        'id-col': { type: 'string' },
        'url-col': { type: 'string' },
        'aircraft-col': { type: 'string' },
        'date-col': { type: 'string' },
        'retrieved-at': { type: 'string' },
      },
      strict: true,
    });
    const file = values.export;
    const retrievedAt = values['retrieved-at'] ? new Date(values['retrieved-at']) : undefined;
    const caseCol = values['case-col'];
    const idCol = values['id-col'];
    const urlCol = values['url-col'];
    const valid = file
      ? !values.seed && caseCol && !!idCol !== !!urlCol && retrievedAt && !Number.isNaN(retrievedAt.getTime())
      : values.seed && !caseCol && !idCol && !urlCol && !retrievedAt;
    if (!valid) {
      console.error(USAGE);
      return 2;
    }
    const seedFile = fileURLToPath(new URL('../fixtures/report-links-seed.json', import.meta.url));
    const report = await withDb((db) =>
      file && caseCol && retrievedAt
        ? importAviationSearchExport(db, file, {
            retrievedAt,
            mapping: {
              caseCol,
              ...(idCol ? { idCol } : {}),
              ...(urlCol ? { urlCol } : {}),
              ...(values['aircraft-col'] ? { aircraftCol: values['aircraft-col'] } : {}),
              ...(values['date-col'] ? { dateCol: values['date-col'] } : {}),
            },
          })
        : importSeedLinks(db, seedFile),
    );
    printLinks(report);
    return report.unmatched.length || report.invalid.length ? 1 : 0;
  }
  if (command === 'index') {
    const [target, ...args] = rest;
    const config = workerConfig().elasticsearch;
    if (target === 'cases') {
      const { values } = parseArgs({ args, options: { generation: { type: 'string' } }, strict: true });
      const id = Number(values.generation);
      if (!values.generation || !Number.isSafeInteger(id) || id < 1) {
        console.error(USAGE);
        return 2;
      }
      const es = createEsClient(config, 'write', { requestTimeoutMs: 120_000 });
      try {
        const report = await withDb((db) =>
          rebuildCasesIndex(es, db, { generationId: id, prefix: config.indexPrefix, log: (m) => console.error(m) }),
        );
        printIndex(report);
      } finally {
        await es.close();
      }
      return 0;
    }
    if (target === 'passages') {
      const { values } = parseArgs({
        args,
        options: {
          generation: { type: 'string' },
          'dry-run': { type: 'boolean' },
          'confirm-cost': { type: 'boolean' },
          'cache-only': { type: 'boolean' },
        },
        strict: true,
      });
      const id = Number(values.generation);
      if (!values.generation || !Number.isSafeInteger(id) || id < 1) {
        console.error(USAGE);
        return 2;
      }
      if ([values['dry-run'], values['confirm-cost'], values['cache-only']].filter(Boolean).length > 1) {
        console.error('--dry-run, --confirm-cost and --cache-only exclude each other');
        return 2;
      }
      return indexPassages(id, values['cache-only'] ? 'cache-only' : values['confirm-cost'] ? 'confirm-cost' : 'dry-run');
    }
    if (target === 'reconcile') {
      const { values } = parseArgs({
        args,
        options: { alias: { type: 'string' }, 'declare-abandoned': { type: 'string' }, reason: { type: 'string' } },
        strict: true,
      });
      const declared = values['declare-abandoned'] === undefined ? null : Number(values['declare-abandoned']);
      if (!values.alias || (declared !== null && (!Number.isSafeInteger(declared) || declared < 1 || !values.reason))) {
        console.error(USAGE);
        return 2;
      }
      const alias = values.alias;
      const es = createEsClient(config, 'write');
      try {
        if (declared !== null) {
          const reason = values.reason as string;
          await withDb((db) => declareAbandoned(db, alias, declared, reason));
          // An operator's assertion: logged with its reason; it unblocks switching and deletes nothing.
          console.log(`attempt ${declared} of ${alias} declared abandoned: ${reason}`);
          return 0;
        }
        const r = await withDb((db) => reconcileAlias(es, db, alias));
        console.log(`alias: ${r.alias} -> ${r.targets.join(', ') || 'nothing'}`);
        console.log(`committed: ${r.committed.map((c) => `${c.id} (${c.indexName})`).join(', ') || 'none'}`);
        for (const u of r.unresolved) {
          console.log(`unknown: attempt ${u.id} (${u.indexName})${u.declared ? ' declared abandoned' : ''}`);
        }
        if (r.blocked) {
          console.log(
            `alias ${alias} stays blocked. Rerun once the request may have completed, or declare an attempt abandoned: ` +
              `pnpm worker index reconcile --alias ${alias} --declare-abandoned <attempt-id> --reason <text>`,
          );
          return 1;
        }
      } finally {
        await es.close();
      }
      return 0;
    }
    if (target === 'delete-unused') {
      const { values } = parseArgs({
        args,
        options: { 'older-than': { type: 'string' }, alias: { type: 'string', multiple: true }, yes: { type: 'boolean' } },
        strict: true,
      });
      const hours = Number(values['older-than']);
      if (values['older-than'] === undefined || !Number.isFinite(hours) || hours < 0) {
        console.error(USAGE);
        return 2;
      }
      const es = createEsClient(config, 'write');
      try {
        const r = await withDb((db) =>
          deleteUnusedIndices(es, db, { olderThanHours: hours, yes: values.yes === true, ...(values.alias ? { aliases: values.alias } : {}) }),
        );
        if (r.dryRun) console.log(`would delete (dry run; pass --yes): ${r.wouldDelete.join(', ') || 'none'}`);
        else console.log(`deleted: ${r.deleted.join(', ') || 'none'}`);
        if (r.missing.length > 0) console.log(`already missing: ${r.missing.join(', ')}`);
        for (const k of r.refused) console.log(`kept ${k.indexName}: ${k.reason}`);
      } finally {
        await es.close();
      }
      return 0;
    }
    if (target === 'cleanup-builds') {
      const { values } = parseArgs({ args, options: { 'older-than': { type: 'string' } }, strict: true });
      const hours = Number(values['older-than']);
      if (values['older-than'] === undefined || !Number.isFinite(hours) || hours < 0) {
        console.error(USAGE);
        return 2;
      }
      const r = await withDb((db) => cleanupStalePins(db, { olderThanHours: hours }));
      console.log(`pins removed: ${r.pinsRemoved.map((p) => `${p.buildId} (generation ${p.generationId})`).join(', ') || 'none'}`);
      console.log(`running builds skipped: ${r.skippedRunning.join(', ') || 'none'}`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  }
  if (command === 'publish') {
    const { values } = parseArgs({
      args: rest,
      options: {
        generation: { type: 'string' },
        'cases-index': { type: 'string' },
        'passages-index': { type: 'string' },
      },
      strict: true,
    });
    const id = Number(values.generation);
    const casesIndex = values['cases-index'];
    if (!values.generation || !Number.isSafeInteger(id) || id < 1 || !casesIndex) {
      console.error(USAGE);
      return 2;
    }
    const passagesIndex = values['passages-index'] ?? null;
    const es = createEsClient(workerConfig().elasticsearch, 'write');
    try {
      const { embeddingModel: model, embeddingDimensions: dims } = workerConfig().ai.openai;
      const r = await withDb((db) => publishGeneration(es, db, { generationId: id, casesIndex, passagesIndex, embedding: { model, dims } }));
      console.log(`active manifest: generation ${r.manifest.generationId}, published ${r.manifest.publishedAt.toISOString()}`);
      console.log(`cases index: ${r.manifest.casesIndex} (${r.casesDocuments} documents = US events)`);
      console.log(
        r.manifest.passagesIndex === null
          ? 'passages index: none (keyword-only; AI routes stay off until a passages index is published)'
          : `passages index: ${r.manifest.passagesIndex} (${r.passagesDocuments} documents)`,
      );
    } catch (err) {
      if (!(err instanceof PublishRefusedError)) throw err;
      console.error(err.message);
      return 1;
    } finally {
      await es.close();
    }
    return 0;
  }
  if (command === 'generations') {
    parseArgs({ args: rest, options: {}, strict: true });
    const [list, running] = await withDb((db) => Promise.all([listGenerations(db), listRunningRuns(db)]));
    if (list.length === 0) console.log('no generations');
    for (const g of list) {
      const manifest = g.publishedAt ? ` published ${g.publishedAt.toISOString()}${g.active ? ' ACTIVE' : ''}` : '';
      const verification = g.verificationStatus
        ? `verification ${g.verificationStatus} (${g.verifierVersion}) ${g.verifiedAt?.toISOString() ?? ''}`
        : 'not verified';
      console.log(
        `${g.id}\t${g.status}\tsealed ${g.sealedAt?.toISOString() ?? '-'}\t${verification}\tevents ${g.events ?? '?'}\tarchive ${g.archiveSha256.slice(0, 12)}\tmapping ${g.mappingVersion}${g.mappingVerified ? '' : ' (unverified)'}\tcitation ${g.citationTextVersion}${manifest}`,
      );
    }
    for (const run of running) {
      const stale = run.ageMinutes >= STALE_RUN_MINUTES;
      console.log(
        `run ${run.id} running since ${run.startedAt.toISOString()} (${run.ageMinutes} min)${stale ? ' STALE: close with pnpm worker fail-stale-runs --older-than-minutes <n>' : ''}`,
      );
    }
    return 0;
  }
  if (command === 'fail-stale-runs') {
    const { values } = parseArgs({ args: rest, options: { 'older-than-minutes': { type: 'string' } }, strict: true });
    const minutes = Number(values['older-than-minutes']);
    if (!values['older-than-minutes'] || !Number.isSafeInteger(minutes) || minutes < 1) {
      console.error(USAGE);
      return 2;
    }
    const ids = await withDb((db) => failStaleRuns(db, minutes));
    console.log(ids.length === 0 ? 'no stale runs' : `marked failed: ${ids.join(', ')}`);
    return 0;
  }
  if (command === 'ai-switch') {
    const { values } = parseArgs({
      args: rest,
      options: {
        on: { type: 'boolean' },
        off: { type: 'boolean' },
        note: { type: 'string' },
        // The login-required emergency mode: `--anonymous off` refuses anonymous trials.
        anonymous: { type: 'string' },
      },
      strict: true,
    });
    const anonymous = values.anonymous;
    const noteAllowed = values.off === true || anonymous === 'off';
    if (
      (values.on && values.off) ||
      (anonymous !== undefined && anonymous !== 'on' && anonymous !== 'off') ||
      (values.note !== undefined && !noteAllowed)
    ) {
      console.error(USAGE);
      return 2;
    }
    const state = await withDb(async (db) => {
      if (values.on || values.off) await setAiSwitch(db, values.on === true, values.note ?? null);
      if (anonymous !== undefined) {
        // A note given with --anonymous off is recorded; --anonymous on clears the note
        // unless interactive AI is still paused (its note stays).
        const paused = !(await readAiSwitch(db)).enabled;
        const note = anonymous === 'off' ? (values.off ? undefined : values.note) : paused ? undefined : null;
        await setAnonymousAi(db, anonymous === 'on', note);
      }
      return readAiSwitch(db);
    });
    const note = state.note ? ` (${state.note})` : '';
    const free = state.anonymousEnabled ? 'anonymous trials allowed' : 'LOGIN REQUIRED (anonymous trials refused)';
    console.log(
      `interactive AI ${state.enabled ? 'enabled' : 'PAUSED (maintenance)'}; ${free}${note}, changed ${state.updatedAt?.toISOString() ?? '-'}`,
    );
    return 0;
  }
  if (command === 'prune-generations') {
    const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' }, 'grace-hours': { type: 'string' } }, strict: true });
    const grace = values['grace-hours'];
    if (grace !== undefined && !/^\d+(\.\d+)?$/.test(grace)) {
      console.error(USAGE);
      return 2;
    }
    const dryRun = values['dry-run'] === true;
    const report = await withDb((db) => pruneGenerations(db, { dryRun, ...(grace !== undefined ? { graceHours: Number(grace) } : {}) }));
    const list = (ids: number[]) => (ids.length === 0 ? 'none' : ids.join(', '));
    console.log(`retained (active and most recently published): ${list(report.retained)}`);
    console.log(`${dryRun ? 'would delete (dry run, nothing deleted)' : 'deleted'}: ${list(report.deleted)}`);
    console.log(`skipped (pinned): ${list(report.skippedPinned)}`);
    return 0;
  }
  if (command === 'prune-controls') {
    // Retention of the control tables runs as aviation_app (DATABASE_URL): prune_controls() is granted to
    // that role only, which is also the role the API's periodic job uses.
    parseArgs({ args: rest, options: {}, strict: true });
    const url = workerConfig().databaseUrl;
    if (!url) throw new Error('DATABASE_URL is not set (the aviation_app login); run pnpm services:setup');
    const db = createDb(url, { max: 2, applicationName: 'aviation-worker-controls' });
    try {
      const leases = await expireLeases(db);
      const pruned = await pruneControls(db);
      console.log(`leases expired: ${leases.expired} (charged ${leases.chargedUsd} USD)`);
      for (const [k, v] of Object.entries(pruned)) console.log(`pruned ${k}: ${v}`);
    } finally {
      await closeDb(db);
    }
    return 0;
  }
  if (command === 'migrate') {
    // Schema migrations as aviation_migrator (DATABASE_MIGRATOR_URL); the URL is never printed.
    parseArgs({ args: rest, options: {}, strict: true });
    const url = workerConfig().databaseMigratorUrl;
    if (!url) {
      console.error('DATABASE_MIGRATOR_URL is not set');
      return 2;
    }
    await runMigrations(url);
    console.log(`migrations applied to ${new URL(url).pathname.slice(1)}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (!isTerminating()) process.exit(code);
  },
  (err: unknown) => {
    // A signal handler owns the exit (it waits for container removal and sets the code).
    if (isTerminating()) return;
    console.error(describeWorkerError(err));
    process.exit(1);
  },
);
