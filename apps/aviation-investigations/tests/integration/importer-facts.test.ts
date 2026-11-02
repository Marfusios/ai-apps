/** Real host queries and OS child IPC, on dev/live databases in a disposable PostgreSQL 16.2 container. */
import { fork, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { runMigrations } from '../../server/db/migrate.js';
import { publishManifest } from '../../server/db/generations.js';
import { provisionPostgres, roleUrl } from '../../scripts/provision.js';
import { POSTGRES_TOOLS_IMAGE } from '../../scripts/restore-drill.js';
import { readHostFacts, type DevFacts } from '../../worker/importer/facts.js';
import { serveChildFacts } from '../../worker/importer/host.js';
import type { ImporterConfig } from '../../worker/importer/config.js';
import { recordSuccess } from '../../worker/importer/durable.js';
import {
  beginRun,
  manifest,
  registerArtifact,
  startRecertification,
  withImportSession,
} from '../../worker/importer/store.js';
import { makeExtractDir, writeManifest } from '../support/extract-dir.js';
import { loadVerified } from './corpus-helpers.js';

const name = `ai-aviation-import-facts-${randomBytes(5).toString('hex')}`;
const code = 'c'.repeat(40);
const content = 'd'.repeat(64);
const archives = { dev: 'a'.repeat(64), live: 'b'.repeat(64) };
const pendingArchives = { dev: 'e'.repeat(64), live: 'f'.repeat(64) };
let root: string;
let config: ImporterConfig;
let admin: pg.Pool | undefined;
let devFacts: DevFacts;

function docker(args: string[], environment: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('docker', args, {
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('isolated host-facts Docker command failed');
  return result.stdout.trim();
}

async function seed(
  db: Db,
  environment: 'dev' | 'live',
  image: string,
): Promise<DevFacts> {
  const dir = await makeExtractDir();
  try {
    await writeManifest(dir, archives[environment]);
    const generation = await loadVerified(db, dir, root);
    await publishManifest(
      db,
      generation,
      `facts-${environment}-cases`,
      `facts-${environment}-passages`,
    );
    const current = (await manifest(db))!;
    const accepted = {
      archive: archives[environment],
      content,
      csvHash: '0'.repeat(64),
      manifest: current,
      observation: { advertisedAtLocal: '2026-11-01T00:00:00', bytes: 100 },
      code,
    };
    const canary = {
      publication: current,
      archive: accepted.archive,
      content,
      code,
      deployedCode: image,
      probes: '1'.repeat(64),
      checkedAt: new Date().toISOString(),
    };
    await withImportSession(db, async (session) => {
      const runId = await beginRun(db, session, 'automatic');
      await startRecertification(db, session, runId, accepted.archive);
      await recordSuccess(db, session, {
        runId,
        artifactId: null,
        kind: 'recertification',
        accepted,
        canary,
        evidence: '2'.repeat(64),
        sourceChecked: false,
      });
      await registerArtifact(
        db,
        session,
        environment,
        pendingArchives[environment],
        '3'.repeat(64),
        current,
      );
    });
    return { current, canary, observedImage: image };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'importer-facts-'));
  const password = randomBytes(24).toString('hex');
  docker(
    [
      'run',
      '-d',
      '--pull=never',
      '--name',
      name,
      '--log-driver=none',
      '--label',
      'ai-apps.component=importer-facts-test',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      'POSTGRES_PASSWORD',
      '-p',
      '127.0.0.1::5432',
      POSTGRES_TOOLS_IMAGE,
    ],
    { POSTGRES_PASSWORD: password },
  );
  const port = /:(\d+)\s*$/.exec(
    docker(['port', name, '5432/tcp']).split('\n')[0] ?? '',
  )?.[1];
  if (!port) throw new Error('isolated host-facts database has no port');
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  for (let retry = 0; ; retry++) {
    const connection = new pg.Client({
      connectionString: adminUrl,
      connectionTimeoutMillis: 1000,
    });
    try {
      await connection.connect();
      break;
    } catch {
      if (retry >= 30) throw new Error('isolated host-facts database did not start');
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await connection.end().catch(() => undefined);
    }
  }
  admin = new pg.Pool({
    connectionString: adminUrl,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  expect((await admin.query('show server_version')).rows[0].server_version).toMatch(
    /^16\.2/,
  );
  const image = docker([
    'inspect',
    '--type',
    'container',
    '--format',
    '{{.Image}}',
    name,
  ]);
  const environment = (env: 'dev' | 'live') => ({
    envFiles: [join(root, `${env}.env`)],
    applicationUrl: 'http://127.0.0.1:9/',
    container: name,
    image,
  });
  config = {
    version: 'snapshot-importer.v1',
    root,
    code,
    hostLock: join(root, 'host.lock'),
    maintenanceLock: join(root, 'maintenance.lock'),
    schedule: { enabled: false, localTime: '05:30', timeZone: 'Europe/Prague' },
    installation: null,
    dev: environment('dev'),
    live: environment('live'),
  };
  for (const env of ['dev', 'live'] as const) {
    const passwords = await provisionPostgres({ env, adminUrl, log: () => {} });
    await runMigrations(roleUrl(adminUrl, env, 'migrator', passwords.migrator));
    const ingestUrl = roleUrl(adminUrl, env, 'ingest', passwords.ingest);
    const values = {
      APP_ENV: env,
      DATABASE_INGEST_URL: ingestUrl,
      AVIATION_IMPORTS_ENABLED: 'false',
      ELASTICSEARCH_URL: 'http://127.0.0.1:9',
      ELASTICSEARCH_WRITE_API_KEY: 'unused-fixture-key',
      ELASTICSEARCH_INDEX_PREFIX: `ai-aviation-${env}`,
      AI_MONTHLY_BUDGET_USD: '100',
      AI_INTERACTIVE_MONTHLY_BUDGET_USD: '80',
      AI_INGESTION_MONTHLY_BUDGET_USD: '20',
    };
    await writeFile(
      config[env]!.envFiles[0]!,
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
        .join(''),
      { mode: 0o600 },
    );
    const db = createDb(ingestUrl);
    try {
      const facts = await seed(db, env, image);
      if (env === 'dev') devFacts = facts;
    } finally {
      await closeDb(db);
    }
  }
});

afterAll(async () => {
  try {
    await admin?.end();
  } finally {
    try {
      docker(['rm', '-fv', name]);
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
});

async function expectPoolsClosed(): Promise<void> {
  await expect
    .poll(async () =>
      Number(
        (
          await admin!.query(
            "select count(*) from pg_stat_activity where application_name='aviation-import-host-facts'",
          )
        ).rows[0].count,
      ),
    )
    .toBe(0);
}

it.each(['dev', 'live'] as const)(
  'reads real %s retention facts before closing the pool',
  async (environment) => {
    expect(
      (
        (await readHostFacts(config, { kind: 'retention', environment })) as string[]
      ).sort(),
    ).toEqual([archives[environment], pendingArchives[environment]].sort());
    await expectPoolsClosed();
  },
);

it('reads the real canary and publication and inspects a running fixture container', async () => {
  expect(
    await readHostFacts(config, { kind: 'canary', environment: 'dev', content }),
  ).toEqual(devFacts);
  expect(
    await readHostFacts(config, {
      kind: 'canary',
      environment: 'dev',
      content: '9'.repeat(64),
    }),
  ).toEqual({ ...devFacts, canary: null });
  await expectPoolsClosed();
});

it('closes the canary pool when the image check fails', async () => {
  const wrongImage = {
    ...config,
    dev: { ...config.dev, image: 'sha256:' + '0'.repeat(64) },
  };
  await expect(
    readHostFacts(wrongImage, { kind: 'canary', environment: 'dev', content }),
  ).rejects.toMatchObject({ reason: 'source_unavailable' });
  await expectPoolsClosed();
});

it.each(['dev', 'live'] as const)(
  'serves the other environment through actual %s-child IPC',
  async (own) => {
    const child = fork(
      fileURLToPath(new URL('../support/importer-facts-child.ts', import.meta.url)),
      [own, content],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH,
          AVIATION_TRACING_ENABLED: 'false',
          OTEL_SDK_DISABLED: 'true',
        },
      },
    );
    serveChildFacts(child, config, own);
    let message: unknown;
    let stderr = '';
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on('message', (value: unknown) => {
        message = value;
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', () => reject(new Error('host-facts child failed to start')));
      child.once('close', resolve);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      expect(await exit).toBe(0);
      expect(stderr).toBe('');
      const other = own === 'dev' ? 'live' : 'dev';
      const returned = message as {
        type: string;
        retention: string[];
        repeated: string[];
        canary: DevFacts | null;
        serving: unknown;
      };
      expect({
        ...returned,
        retention: returned.retention.sort(),
        repeated: returned.repeated.sort(),
      }).toEqual({
        type: 'facts-test-result',
        retention: [archives[other], pendingArchives[other]].sort(),
        repeated: [archives[other], pendingArchives[other]].sort(),
        canary: own === 'live' ? devFacts : null,
        serving: await readHostFacts(config, { kind: 'serving', environment: other }),
      });
      await expectPoolsClosed();
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exit;
      }
    }
  },
);

it.each(['dev', 'live'] as const)(
  'reads %s serving facts over the production host reader',
  async (environment) => {
    const facts = await readHostFacts(config, { kind: 'serving', environment });
    expect(facts).toMatchObject({
      archive: archives[environment],
      content,
      observation: { advertisedAtLocal: '2026-11-01T00:00:00', bytes: 100 },
      counts: { total: expect.any(Number), eligible: expect.any(Number) },
      publication: { generationId: expect.any(Number) },
    });
    await expectPoolsClosed();
  },
);
