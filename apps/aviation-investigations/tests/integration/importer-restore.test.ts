/** Actual PostgreSQL 16.2 backup/restore, including an upgrade from a pre-importer dump. Never uses shared services. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { POSTGRES_TOOLS_IMAGE } from '../../scripts/restore-drill.js';
import { provisionPostgres, roleUrl } from '../../scripts/provision.js';
import { dropEnvironment } from '../../scripts/scratch-env.js';
import { runMigrations } from '../../server/db/migrate.js';
import { createDb, closeDb } from '../../server/db/client.js';
import { privilegeSnapshot, comparePrivileges } from '../../server/db/privileges.js';
import { EXPECTED_PRIVILEGES } from '../../server/db/privileges-expected.js';
import { restoreCheck } from '../../server/db/backup.js';
import { paidOperationsHeld, reconcileRestore } from '../../server/quota/hold.js';
import { reserveSpend, settleSpend } from '../../server/quota/spend.js';
import {
  withImportSession,
  registerArtifact,
  registerCandidate,
  beginRun,
  updateRun,
  fenced,
  budgetRemaining,
  resumeArtifact,
} from '../../worker/importer/store.js';
import { setPending } from '../../worker/importer/durable.js';

const budgets = {
  monthlyUsd: 100,
  interactiveMonthlyUsd: 80,
  ingestionMonthlyUsd: 20,
  interactiveDailyUsd: 3,
  anonymousShare: 0.25,
};
const request = { provider: 'offline', model: 'synthetic', stage: 'embed' };
const baseline = {
  generationId: 1,
  casesIndex: 'restore-cases',
  passagesIndex: 'restore-passages',
  publishedAt: '2026-10-31T00:00:00.000001Z',
};
function docker(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 ** 2,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('isolated PostgreSQL drill command failed');
  return result.stdout.trim();
}

it('restores importer identities, references and tagged money with both holds, including a pre-0027 upgrade', async () => {
  const name = `ai-aviation-import-drill-${randomBytes(5).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const root = await mkdtemp(join(tmpdir(), 'importer-pg16-drill-'));
  const labels = [
    '--label',
    'ai-apps.app=aviation-investigations',
    '--label',
    'ai-apps.component=restore-drill',
  ];
  let network = false,
    server = false;
  try {
    docker(['network', 'create', ...labels, name]);
    network = true;
    docker(
      [
        'run',
        '-d',
        '--name',
        name,
        '--network',
        name,
        ...labels,
        '--log-driver=none',
        '-e',
        'POSTGRES_PASSWORD',
        '-p',
        '127.0.0.1::5432',
        POSTGRES_TOOLS_IMAGE,
      ],
      { POSTGRES_PASSWORD: password },
    );
    server = true;
    const port = /:(\d+)\s*$/.exec(docker(['port', name, '5432/tcp']).split('\n')[0] ?? '')?.[1];
    if (!port) throw new Error('isolated drill published no port');
    const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    for (let retry = 0; ; retry++) {
      const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
      try {
        await client.connect();
        await client.end();
        break;
      } catch {
        await client.end().catch(() => undefined);
        if (retry >= 30) throw new Error('isolated drill did not start');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const runTool = (command: 'backup' | 'restore', url: string, file?: string) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          name,
          ...labels,
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--log-driver=none',
          '--user',
          `${process.getuid!()}:${process.getgid!()}`,
          '-e',
          'DATABASE_MIGRATOR_URL',
          '-e',
          'APP_ENV',
          '-v',
          `${resolve('docker/postgres')}:/opt/aviation:ro`,
          '-v',
          `${root}:/backup${command === 'restore' ? ':ro' : ''}`,
          '--entrypoint',
          'bash',
          POSTGRES_TOOLS_IMAGE,
          `/opt/aviation/${command}.sh`,
          ...(file ? [file] : []),
        ],
        { DATABASE_MIGRATOR_URL: url, APP_ENV: 'importdrill' },
      );
    for (const preImporter of [false, true]) {
      const environment = 'importdrill';
      let passwords = await provisionPostgres({ env: environment, adminUrl, log: () => {} });
      let migratorUrl = roleUrl(adminUrl, environment, 'migrator', passwords.migrator);
      await runMigrations(migratorUrl, preImporter ? { upTo: '0026_search_observability' } : {});
      const source = createDb(roleUrl(adminUrl, environment, 'ingest', passwords.ingest), {
        max: 6,
      });
      const owner = createDb(migratorUrl);
      let original: Record<string, unknown> | null = null;
      let id = '',
        staleFence = '';
      try {
        const version = (await owner.execute(sql`show server_version`)).rows[0]?.server_version;
        expect(String(version)).toMatch(/^16\.2/);
        if (!preImporter) {
          await withImportSession(source, async (session) => {
            staleFence = session.fence;
            const artifact = await registerArtifact(
              source,
              session,
              'dev',
              'a'.repeat(64),
              'b'.repeat(64),
              baseline,
            );
            id = artifact.id;
            await resumeArtifact(source, session, id);
            // Paused concrete candidate metadata; no Elasticsearch is involved in a PostgreSQL restore.
            await source.execute(sql`insert into index_builds(build_id,index_name,alias,generation_id)
              values('restorebuild','restore-candidate','restore-alias',1)`);
            await registerCandidate(source, session, id, 'restore-candidate', 'restorebuild', 1);
            const run = await beginRun(source, session, 'automatic');
            await updateRun(source, session, run, {
              step: 'plan',
              result: 'deferred',
              reason: 'interrupted',
              artifactId: id,
            });
            await setPending(source, session, {
              archive: artifact.archive_sha256,
              content: artifact.content_sha256,
              artifactId: id,
              observation: { advertisedAtLocal: '2026-10-01T00:00:00', bytes: 100 },
              fetchedAt: new Date().toISOString(),
              runId: run,
              attempts: 1,
              needsReview: false,
              reason: null,
            });
            const reservation = await reserveSpend(source, {
              import: { artifactId: id, fence: session.fence },
              category: 'indexing',
              usd: 0.2,
              request,
              budgets,
            });
            if (!reservation.ok) throw new Error('synthetic reservation refused');
            await settleSpend(
              source,
              { reservationId: reservation.reservationId },
              'uncertain',
              reservation.fencingToken,
            );
            expect(await budgetRemaining(source, session, id)).toBe(0.3);
            await expect(
              source.execute(
                sql`update reservations set import_artifact_id=null where id=${reservation.reservationId}`,
              ),
            ).rejects.toThrow();
            await expect(
              source.execute(
                sql`update import_artifacts set first_reservation_at=clock_timestamp() where id=${id}::uuid`,
              ),
            ).rejects.toThrow();
            original = (
              await source.execute(sql`select id,archive_sha256,content_sha256,attempts,
              to_char(first_reservation_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first from import_artifacts`)
            ).rows[0]!;
          });
        }
      } finally {
        await closeDb(source);
        await closeDb(owner);
      }
      const before = new Set(await readdir(root));
      runTool(
        'backup',
        roleUrl(
          `postgres://postgres@${name}:5432/postgres`,
          environment,
          'migrator',
          passwords.migrator,
        ),
      );
      const backup = (await readdir(root)).find(
        (file) => file.endsWith('.dump') && !before.has(file),
      );
      if (!backup) throw new Error('no isolated backup created');
      await dropEnvironment(adminUrl, environment);
      passwords = await provisionPostgres({ env: environment, adminUrl, log: () => {} });
      migratorUrl = roleUrl(adminUrl, environment, 'migrator', passwords.migrator);
      runTool(
        'restore',
        roleUrl(
          `postgres://postgres@${name}:5432/postgres`,
          environment,
          'migrator',
          passwords.migrator,
        ),
        backup,
      );
      const migrated = await runMigrations(migratorUrl);
      if (preImporter) {
        expect(migrated.applied).toContain('0027_snapshot_importer');
        expect(migrated.applied).toContain('0028_importer_recovery');
      }
      const restored = createDb(migratorUrl),
        ingest = createDb(roleUrl(adminUrl, environment, 'ingest', passwords.ingest));
      try {
        expect(comparePrivileges(await privilegeSnapshot(restored), EXPECTED_PRIVILEGES)).toEqual({
          missing: [],
          unexpected: [],
        });
        expect((await restoreCheck(restored)).ok).toBe(true);
        expect(await paidOperationsHeld(ingest)).toBe(true);
        expect(
          (await restored.execute(sql`select restore_required from import_control`)).rows[0]
            ?.restore_required,
        ).toBe(true);
        if (!preImporter) {
          expect(
            (
              await restored.execute(sql`select id,archive_sha256,content_sha256,attempts,
            to_char(first_reservation_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first from import_artifacts`)
            ).rows[0],
          ).toEqual(original);
          expect(
            (
              await restored.execute(
                sql`select artifact_id,index_name,released_at from import_index_refs`,
              )
            ).rows[0],
          ).toEqual({ artifact_id: id, index_name: 'restore-candidate', released_at: null });
          expect(
            (
              await restored.execute(
                sql`select import_artifact_id,charged_usd::float8 as charged,uncertain from reservations`,
              )
            ).rows[0],
          ).toEqual({ import_artifact_id: id, charged: 0.2, uncertain: true });
          expect(
            (await restored.execute(sql`select pending->>'artifactId' as id from import_control`))
              .rows[0]?.id,
          ).toBe(id);
        }
        await reconcileRestore(restored, {
          interactiveUsd: 0,
          ingestionUsd: 0,
          note: 'isolated importer drill',
          budgets,
        });
        expect(await paidOperationsHeld(ingest)).toBe(false);
        await expect(withImportSession(ingest, async () => {})).rejects.toThrow();
        if (!preImporter) {
          // Simulate the next ledger month in this disposable restore. The durable import hold does not depend on a month key.
          await restored.execute(sql`alter table reservations disable trigger user`);
          await restored.execute(
            sql`update reservations set accounting_day=(current_date-interval '1 month')::date`,
          );
          await restored.execute(sql`alter table reservations enable trigger user`);
          const nextMonth = new Date();
          nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
          await expect(
            reserveSpend(ingest, {
              import: { artifactId: id, fence: staleFence },
              category: 'indexing',
              usd: 0.01,
              request,
              budgets,
              now: nextMonth,
            }),
          ).rejects.toThrow();
          await expect(withImportSession(ingest, async () => {})).rejects.toThrow();
          expect(
            (await restored.execute(sql`select restore_required from import_control`)).rows[0]
              ?.restore_required,
          ).toBe(true);
        }
      } finally {
        await closeDb(restored);
        await closeDb(ingest);
      }
      await dropEnvironment(adminUrl, environment);
      await rm(join(root, backup));
    }
  } finally {
    if (server) docker(['rm', '-f', name]);
    if (network) docker(['network', 'rm', name]);
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
