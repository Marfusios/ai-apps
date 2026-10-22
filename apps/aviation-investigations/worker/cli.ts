import { parseArgs } from 'node:util';
import { closeDb, createDb, type Db } from '../server/db/client.js';
import { listGenerations } from '../server/db/generations.js';
import { createEsClient } from '../server/search/es.js';
import { workerConfig } from './config.js';
import { rebuildCasesIndex, type IndexReport } from './index/cases-index.js';
import { EMBEDDING_PRICES, createOpenAIEmbedder } from './index/embed.js';
import { MAX_INPUT_TOKENS } from './index/passages.js';
import { planPassages, rebuildPassagesIndex, type PassagePlan, type PassagesIndexReport } from './index/passages-index.js';
import { createLedgerSpendGate } from './index/spend-gate.js';
import { extractArchive, isTerminating } from './ingest/extract.js';
import { describeLoadError, loadFromExtract, type LoadReport } from './ingest/load.js';
import { STALE_RUN_MINUTES, failStaleRuns, listRunningRuns } from './ingest/runs.js';
import { readProfile, verifyCorpus, type VerifyReport } from './ingest/verify.js';

const USAGE = [
  'usage:',
  '  worker extract --archive <zip> --sha256 <hex> --out <dir>',
  '  worker load --from <extractDir>',
  '  worker verify --generation <id> [--profile <file>]',
  '  worker generations',
  '  worker fail-stale-runs --older-than-minutes <n>',
  '  worker index cases --generation <id>',
  '  worker index passages --generation <id> [--dry-run | --confirm-cost]',
].join('\n');

/** Ingestion commands connect as aviation_ingest (DATABASE_INGEST_URL). */
function ingestDb(): Db {
  const url = workerConfig().databaseIngestUrl;
  if (!url) throw new Error('DATABASE_INGEST_URL is not set; run pnpm services:setup');
  return createDb(url, { max: 2, applicationName: 'aviation-worker' });
}

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = ingestDb();
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

function printIndex(r: IndexReport): void {
  const lines: [string, string | number][] = [
    ['index', r.index],
    ['alias (last built; the API reads the manifest)', `${r.alias} -> ${r.index}${r.aliasReconciled ? ' (confirmed by read-back)' : ''}`],
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
    ['to embed', `${int(p.toEmbed.inputs)} inputs, ${int(p.toEmbed.tokens)} tokens, ${int(p.toEmbed.requests)} requests`],
    ['estimated cost', usd(p.estimatedUsd)],
    ['reservations (sum of single attempts, A7)', `$${p.reservationUsd.toFixed(6)}`],
    ['duration', `${(p.durationMs / 1000).toFixed(1)} s`],
  );
  for (const [k, v] of lines) console.log(`${k}: ${v}`);
}

function printPassagesIndex(r: PassagesIndexReport): void {
  const lines: [string, string | number][] = [
    ['index', r.index],
    ['alias (last built; the API reads the manifest)', `${r.alias} -> ${r.index}${r.aliasReconciled ? ' (confirmed by read-back)' : ''}`],
    ['previous indices (kept)', r.previousIndices.join(', ') || 'none'],
    ['generation', r.generationId],
    ['version', `${r.version} (${r.fingerprint.slice(0, 12)}), ${r.model} ${r.dims} dims`],
    ['passages', `${int(r.passages)} (${int(r.passagesAlreadyStored)} already stored)`],
    ['cache hits', int(r.cacheHits)],
    ['embedded', `${int(r.embedded.inputs)} inputs, ${int(r.embedded.tokens)} tokens, ${int(r.embedded.requests)} requests, ${usd(r.embedded.usd)}`],
    ['duration', `${(r.durationMs / 1000).toFixed(1)} s`],
  ];
  for (const [k, v] of lines) console.log(`${k}: ${v}`);
}

async function indexPassages(id: number, confirmCost: boolean): Promise<number> {
  const config = workerConfig();
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;
  const price = EMBEDDING_PRICES[model];
  if (price === undefined) throw new Error(`no price for embedding model ${model}`);
  if (!confirmCost) {
    const plan = await withDb((db) =>
      planPassages(db, { generationId: id, embedding: { model, dims, usdPerMillionTokens: price }, log: (m) => console.error(m) }),
    );
    printPlan(plan);
    console.log('dry run: nothing written, no paid request made; run with --confirm-cost to build the index');
    return 0;
  }
  return withDb(async (db) => {
    // Fails closed until the spend ledger is wired: nothing is sent before a gate exists.
    const gate = createLedgerSpendGate(db);
    const embedder = createOpenAIEmbedder({
      apiKey: config.ai.openai.apiKey ?? '',
      model,
      dims,
      gate,
      purpose: `index passages g${id}`,
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
  });
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
    const report = await withDb((db) => verifyCorpus(db, id, profile ? { profile } : {}));
    printVerify(report);
    return report.ok && !report.conflict ? 0 : 1;
  }
  if (command === 'index') {
    const [target, ...args] = rest;
    const { values } = parseArgs({
      args,
      options: {
        generation: { type: 'string' },
        ...(target === 'passages' ? { 'dry-run': { type: 'boolean' }, 'confirm-cost': { type: 'boolean' } } : {}),
      },
      strict: true,
    });
    const id = Number(values.generation);
    if ((target !== 'cases' && target !== 'passages') || !values.generation || !Number.isSafeInteger(id) || id < 1) {
      console.error(USAGE);
      return 2;
    }
    if (target === 'passages') {
      const flags = values as { 'dry-run'?: boolean; 'confirm-cost'?: boolean };
      if (flags['dry-run'] && flags['confirm-cost']) {
        console.error('--dry-run and --confirm-cost exclude each other');
        return 2;
      }
      return indexPassages(id, flags['confirm-cost'] === true);
    }
    const config = workerConfig().elasticsearch;
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
    console.error(describeLoadError(err));
    process.exit(1);
  },
);
