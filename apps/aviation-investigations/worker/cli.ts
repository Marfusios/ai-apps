import { parseArgs } from 'node:util';
import { closeDb, createDb, type Db } from '../server/db/client.js';
import { listGenerations } from '../server/db/generations.js';
import { workerConfig } from './config.js';
import { extractArchive, isTerminating } from './ingest/extract.js';
import { describeLoadError, loadFromExtract, type LoadReport } from './ingest/load.js';
import { readProfile, verifyCorpus, type VerifyReport } from './ingest/verify.js';

const USAGE = [
  'usage:',
  '  worker extract --archive <zip> --sha256 <hex> --out <dir>',
  '  worker load --from <extractDir>',
  '  worker verify --generation <id> [--profile <file>]',
  '  worker generations',
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
    ['generation', `${r.generationId} (status loading; next: pnpm worker verify --generation ${r.generationId})`],
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
  console.log(`generation ${r.generationId}: ${r.ok ? 'verified' : 'FAILED'} (status ${r.statusBefore} -> ${r.status})`);
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
    return report.ok ? 0 : 1;
  }
  if (command === 'generations') {
    parseArgs({ args: rest, options: {}, strict: true });
    const list = await withDb((db) => listGenerations(db));
    if (list.length === 0) console.log('no generations');
    for (const g of list) {
      const manifest = g.publishedAt ? ` published ${g.publishedAt.toISOString()}${g.active ? ' ACTIVE' : ''}` : '';
      console.log(
        `${g.id}\t${g.status}\tcreated ${g.createdAt.toISOString()}\tevents ${g.events ?? '?'}\tarchive ${g.archiveSha256.slice(0, 12)}\tmapping ${g.mappingVersion}${g.mappingVerified ? '' : ' (unverified)'}\tcitation ${g.citationTextVersion}${manifest}`,
      );
    }
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
