import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { closeDb, createDb, type Db } from '../server/db/client.js';
import { listGenerations } from '../server/db/generations.js';
import { readAiSwitch, setAiSwitch } from '../server/quota/switch.js';
import { workerConfig } from './config.js';
import { importAviationSearchExport, importSeedLinks, type ImportReport } from './ingest/report-links.js';
import { extractArchive, isTerminating } from './ingest/extract.js';
import { describeLoadError, loadFromExtract, type LoadReport } from './ingest/load.js';
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
  '  worker fail-stale-runs --older-than-minutes <n>',
  '  worker ai-switch [--on | --off --note <text>]',
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

function printLinks(r: ImportReport): void {
  console.log(`report links (${r.source}, ${r.layout}) against generation ${r.generationId}`);
  console.log(`  file sha256 ${r.sourceFileSha256}, retrieved ${r.retrievedAt.toISOString()}`);
  console.log(`  label: ${r.sourceLabel}`);
  console.log(`  rows ${r.rows}, matched ${r.matched}, inserted ${r.inserted}, already present ${r.alreadyPresent}`);
  if (!r.dateChecked) console.warn(`  WARNING: ${r.dateUnchecked} row(s) were not date-checked (no --date-col or no event date); matches rest on case number alone`);
  for (const u of r.unmatched) console.log(`  unmatched ${u.ntsbNo} -> ${u.reportId} (${u.reason})`);
  for (const i of r.invalid) console.log(`  invalid row ${i.row}: ${i.reason}`);
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
      options: { on: { type: 'boolean' }, off: { type: 'boolean' }, note: { type: 'string' } },
      strict: true,
    });
    if ((values.on && values.off) || (values.note !== undefined && !values.off)) {
      console.error(USAGE);
      return 2;
    }
    const state = await withDb((db) =>
      values.on || values.off ? setAiSwitch(db, values.on === true, values.note ?? null) : readAiSwitch(db),
    );
    const note = state.note ? ` (${state.note})` : '';
    console.log(`interactive AI ${state.enabled ? 'enabled' : 'PAUSED (maintenance)'}${note}, changed ${state.updatedAt?.toISOString() ?? '-'}`);
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
