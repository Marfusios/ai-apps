/**
 * Restore drill (docs/RUNBOOK.md, "Backups"): prove that a backup restores, without touching
 * any environment.
 *
 *   pnpm db:restore-drill <backup file>      # an unencrypted .dump written by pnpm app:backup
 *
 * It starts a throwaway PostgreSQL server of the shared server's version (the backup tools'
 * image, compose.yaml) on its own Docker network with a random password and a loopback port,
 * provisions environment `drill` on it, restores the file with docker/postgres/restore.sh
 * exactly as `pnpm app:restore` does, applies the migrations, runs the restore check and reads
 * the hold on paid operations, prints a summary, and removes the server and network again. It
 * exits 0 only when the restore and the check passed. Needs Docker, not the shared services.
 * Never prints credentials.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { restoreCheck } from '../server/db/backup.js';
import { closeDb, createDb } from '../server/db/client.js';
import { runMigrations } from '../server/db/migrate.js';
import { readPaidOperationsHold } from '../server/quota/hold.js';
import { APP_DIR } from './local-env.js';
import { provisionPostgres, roleUrl } from './provision.js';

/** The backup tools' image (compose.yaml, `x-postgres-tools`; tests/unit/backup.test.ts keeps them equal). */
export const POSTGRES_TOOLS_IMAGE = 'postgres:16.2@sha256:4aea012537edfad80f98d870a36e6b90b4c09b27be7f4b4759d72db863baeebb';
const ENV = 'drill';

function docker(args: string[], opts: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): { status: number; out: string; err: string } {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'pipe' : 'inherit'],
    ...(opts.env ? { env: opts.env } : {}),
  });
  return { status: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drill(file: string): Promise<number> {
  const id = randomBytes(4).toString('hex');
  const name = `ai-aviation-drill-${id}`;
  const password = randomBytes(24).toString('hex');
  const labels = ['--label', 'ai-apps.app=aviation-investigations', '--label', 'ai-apps.component=restore-drill'];
  if (docker(['network', 'create', ...labels, name], { quiet: true }).status !== 0) throw new Error('could not create the drill network');
  try {
    // The password goes through the environment, never the command line.
    const started = docker(
      ['run', '-d', '--name', name, '--network', name, ...labels, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', POSTGRES_TOOLS_IMAGE],
      { quiet: true, env: { ...process.env, POSTGRES_PASSWORD: password } },
    );
    if (started.status !== 0) throw new Error('could not start the drill server');
    const port = /:(\d+)\s*$/.exec(docker(['port', name, '5432/tcp'], { quiet: true }).out.trim().split('\n')[0] ?? '')?.[1];
    if (!port) throw new Error('the drill server published no port');
    const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    for (let i = 0; ; i++) {
      const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 });
      try {
        await c.connect();
        await c.end();
        break;
      } catch {
        await c.end().catch(() => undefined);
        if (i >= 60) throw new Error('the drill server did not start');
        await sleep(1000);
      }
    }
    const passwords = await provisionPostgres({ env: ENV, adminUrl, log: () => undefined });
    const hostUrl = roleUrl(adminUrl, ENV, 'migrator', passwords.migrator);
    const containerUrl = roleUrl(`postgres://postgres@${name}:5432/postgres`, ENV, 'migrator', passwords.migrator);
    console.log(`drill: restoring ${basename(file)} into a throwaway PostgreSQL server`);
    const restored = spawnSync(
      'docker',
      [
        'run', '--rm', '--network', name, ...labels, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-e', 'DATABASE_MIGRATOR_URL', '-v', `${resolve(APP_DIR, 'docker/postgres')}:/opt/aviation:ro`,
        '-v', `${dirname(file)}:/backup:ro`, '--entrypoint', 'bash', POSTGRES_TOOLS_IMAGE, '/opt/aviation/restore.sh', basename(file),
      ],
      { stdio: 'inherit', env: { ...process.env, DATABASE_MIGRATOR_URL: containerUrl } },
    );
    if (restored.status !== 0) {
      console.error('drill FAILED: the restore did not complete (nothing was restored)');
      return 1;
    }
    await runMigrations(hostUrl);
    const db = createDb(hostUrl, { max: 1, applicationName: 'aviation-drill' });
    try {
      const check = await restoreCheck(db);
      const hold = await readPaidOperationsHold(db);
      const counts = (
        await db.$client.query<{ generations: string; active: string | null; ledger: string; usd: string }>(
          `select (select count(*) from dataset_generations) as generations,
             (select generation_id::text from dataset_manifests where active) as active,
             (select count(*) from cost_ledger) as ledger, (select coalesce(sum(usd), 0)::text from cost_ledger) as usd`,
        )
      ).rows[0]!;
      console.log(`drill: ${counts.generations} generations (active ${counts.active ?? 'none'}), ${counts.ledger} ledger lines, ${counts.usd} USD`);
      console.log(`drill: paid operations ${hold.held ? `held (${hold.reason})` : 'NOT held'}`);
      for (const { table, rows } of check.rows) console.error(`drill: ${table} holds ${rows} rows (a backup must not hold them)`);
      for (const l of check.privileges.unexpected) console.error(`drill: found    ${l}`);
      for (const l of check.privileges.missing) console.error(`drill: expected ${l}`);
      console.log(check.ok ? 'drill passed: restored, migrated, owners and grants as expected' : 'drill FAILED: see the differences above');
      return check.ok ? 0 : 1;
    } finally {
      await closeDb(db);
    }
  } finally {
    docker(['rm', '-f', '-v', name], { quiet: true });
    docker(['network', 'rm', name], { quiet: true });
  }
}

async function main(): Promise<number> {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length > 0 || !file.endsWith('.dump')) {
    console.error('usage: pnpm db:restore-drill <backup file>.dump');
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    console.error(`no such backup file: ${file}`);
    return 2;
  }
  return drill(path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`drill failed: ${(e instanceof Error ? e.message : String(e)).replace(/:\/\/[^@\s]+@/g, '://<credentials>@')}`);
      process.exit(1);
    },
  );
}
