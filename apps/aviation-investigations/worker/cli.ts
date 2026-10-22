import { parseArgs } from 'node:util';
import { closeDb, createDb, type Db } from '../server/db/client.js';
import { listGenerations } from '../server/db/generations.js';
import { createEsClient } from '../server/search/es.js';
import { workerConfig } from './config.js';
import { rebuildCasesIndex, type IndexReport } from './index/cases-index.js';
import { cleanupStaleBuilds, reconcileAlias } from './index/publications.js';
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
  '  worker index reconcile --alias <alias> [--settle-seconds <n>]',
  '  worker index cleanup-builds --older-than <hours>',
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
    if (target === 'reconcile') {
      const { values } = parseArgs({
        args,
        options: { alias: { type: 'string' }, 'settle-seconds': { type: 'string' } },
        strict: true,
      });
      const settle = values['settle-seconds'] === undefined ? 60 : Number(values['settle-seconds']);
      if (!values.alias || !Number.isFinite(settle) || settle < 0) {
        console.error(USAGE);
        return 2;
      }
      const alias = values.alias;
      const es = createEsClient(config, 'write');
      try {
        console.error(`waiting ${settle} s for pending alias requests of ${alias} to settle`);
        const r = await withDb((db) => reconcileAlias(es, db, alias, { settleMs: settle * 1000 }));
        console.log(`alias: ${r.alias} -> ${r.targets.join(', ') || 'nothing'}`);
        console.log(`committed: ${r.committed.join(', ') || 'none'}`);
        console.log(`abandoned (deleted by cleanup-builds): ${r.abandoned.join(', ') || 'none'}`);
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
      const es = createEsClient(config, 'write');
      try {
        const r = await withDb((db) => cleanupStaleBuilds(es, db, { olderThanHours: hours }));
        console.log(`pins removed: ${r.pinsRemoved.map((p) => `${p.buildId} (generation ${p.generationId})`).join(', ') || 'none'}`);
        console.log(`indices deleted: ${r.indicesDeleted.join(', ') || 'none'}`);
        console.log(`running builds skipped: ${r.skippedRunning.join(', ') || 'none'}`);
        if (r.keptTargets.length > 0) console.log(`kept (alias targets; check manually): ${r.keptTargets.join(', ')}`);
      } finally {
        await es.close();
      }
      return 0;
    }
    console.error(USAGE);
    return 2;
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
