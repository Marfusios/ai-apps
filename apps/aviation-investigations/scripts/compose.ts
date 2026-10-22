/**
 * Docker Compose wrapper for the deployment in compose.yaml (docs/RUNBOOK.md).
 *
 *   pnpm app:up               build and start the app (with the tunnel when TUNNEL_TOKEN is set)
 *   pnpm app:down             stop and remove this environment's containers
 *   pnpm app:ps               list this environment's containers, one-offs included
 *   pnpm app:migrate          one-shot schema migrations (migrator role)
 *   pnpm ingest <command>     one-shot worker command (ingestion role), e.g. `pnpm ingest generations`
 *   pnpm extract:image        build the extraction image
 *
 * The env files in AVIATION_ENV_FILES (comma-separated, highest priority first) go
 * to Compose as --env-file, for interpolation only: each container receives just
 * the variables compose.yaml lists for it. Nonempty process values win. APP_ENV
 * (dev or live) selects the project `ai-aviation-<APP_ENV>`. compose.tunnel.yaml is
 * added when TUNNEL_TOKEN is set, compose.tracing.yaml when AVIATION_TRACING_ENABLED
 * is true. Values are never printed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDotenvAllowlisted } from '../shared/env-files.js';
import { APP_DIR } from './local-env.js';

const COMMANDS = ['app-up', 'app-down', 'app-ps', 'migrate', 'ingest', 'extract-image'] as const;
type Command = (typeof COMMANDS)[number];

/** Variables this wrapper reads to choose files and check the setup. */
const NAMES = [
  'APP_ENV',
  'TUNNEL_TOKEN',
  'AVIATION_TRACING_ENABLED',
  'AVIATION_DATA_DIR',
  'SHARED_POSTGRES_NETWORK',
  'SHARED_ELASTICSEARCH_NETWORK',
  'DATABASE_URL',
  'DATABASE_INGEST_URL',
  'DATABASE_MIGRATOR_URL',
  'ELASTICSEARCH_URL',
  'ELASTICSEARCH_READ_API_KEY',
  'ELASTICSEARCH_INDEX_PREFIX',
] as const;
type Name = (typeof NAMES)[number];

const REQUIRED: Record<Command, readonly Name[]> = {
  'app-up': [
    'SHARED_POSTGRES_NETWORK',
    'SHARED_ELASTICSEARCH_NETWORK',
    'DATABASE_URL',
    'ELASTICSEARCH_URL',
    'ELASTICSEARCH_READ_API_KEY',
    'ELASTICSEARCH_INDEX_PREFIX',
  ],
  ingest: ['SHARED_POSTGRES_NETWORK', 'SHARED_ELASTICSEARCH_NETWORK', 'DATABASE_INGEST_URL'],
  migrate: ['SHARED_POSTGRES_NETWORK', 'DATABASE_MIGRATOR_URL'],
  'app-down': [],
  'app-ps': [],
  'extract-image': [],
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [cmd, ...rawArgs] = process.argv.slice(2) as [string | undefined, ...string[]];
if (!COMMANDS.includes(cmd as Command)) fail(`usage: compose.ts ${COMMANDS.join('|')} [args]`);
const command = cmd as Command;
// `pnpm ingest -- verify ...` passes the separator through; drop it.
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

const envFiles = (process.env.AVIATION_ENV_FILES ?? '')
  .split(',')
  .map((f) => f.trim())
  .filter(Boolean)
  .map((f) => resolve(f));
for (const f of envFiles) if (!existsSync(f)) fail(`env file not found: ${f}`);

// Process values first, then files in priority order (first listed wins), as in Compose.
const values: Partial<Record<Name, string>> = {};
for (const f of [...envFiles].reverse()) Object.assign(values, readDotenvAllowlisted(f, NAMES));
for (const n of NAMES) if (process.env[n]) values[n] = process.env[n];

// The extraction image is the same for every environment; build it under dev by default.
const appEnv = values.APP_ENV ?? (command === 'extract-image' ? 'dev' : undefined);
if (appEnv !== 'dev' && appEnv !== 'live') {
  fail('APP_ENV must be dev or live (set it in the env file named by AVIATION_ENV_FILES; see docs/RUNBOOK.md)');
}
const missing = REQUIRED[command].filter((n) => !values[n]);
if (missing.length) fail(`missing for ${command}: ${missing.join(', ')} (see docs/RUNBOOK.md)`);

const tunnel = command === 'app-up' && Boolean(values.TUNNEL_TOKEN);
const tracing = ['true', '1'].includes(values.AVIATION_TRACING_ENABLED ?? '');
const files = ['compose.yaml'];
if (tunnel) files.push('compose.tunnel.yaml');
if (tracing && (command === 'app-up' || command === 'ingest')) files.push('compose.tracing.yaml');

const base = [
  'compose',
  '-p',
  `ai-aviation-${appEnv}`,
  // Without env files, /dev/null keeps Compose from reading an implicit .env.
  ...(envFiles.length ? [...envFiles].reverse() : ['/dev/null']).flatMap((f) => ['--env-file', f]),
  ...files.flatMap((f) => ['-f', f]),
];

const childEnv: NodeJS.ProcessEnv = { ...process.env, APP_ENV: appEnv };
let tail: string[];
switch (command) {
  case 'app-up':
    if (!existsSync(resolve(APP_DIR, 'server/main.ts'))) {
      fail('server/main.ts (the HTTP entry) does not exist yet, so the app container cannot start; pnpm ingest works.');
    }
    tail = ['--profile', 'app', ...(tunnel ? ['--profile', 'tunnel'] : []), 'up', '-d', '--build', '--wait', '--wait-timeout', '180', ...args];
    break;
  case 'app-down':
    tail = ['--profile', 'app', '--profile', 'tools', '--profile', 'tunnel', 'down', ...args];
    break;
  case 'app-ps':
    tail = ['ps', '-a', ...args];
    break;
  case 'migrate':
    tail = ['--profile', 'tools', 'run', '--rm', 'migrate', ...args];
    break;
  case 'ingest': {
    // Reads data/ read-only as the host user that owns it; writes reports to data/reports/<env>.
    const dataDir = resolve(APP_DIR, values.AVIATION_DATA_DIR ?? 'data');
    mkdirSync(resolve(dataDir, 'reports', appEnv), { recursive: true, mode: 0o700 });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && uid > 0 && gid !== undefined) {
      childEnv.AVIATION_UID = String(uid);
      childEnv.AVIATION_GID = String(gid);
    }
    tail = ['--profile', 'tools', 'run', '--rm', 'ingest', ...args];
    break;
  }
  case 'extract-image':
    tail = ['build', 'extract-image', ...args];
    break;
}

const mode = [tunnel ? 'tunnel' : null, files.includes('compose.tracing.yaml') ? 'tracing' : null].filter(Boolean);
console.error(`ai-aviation-${appEnv}: ${command}${mode.length ? ` (${mode.join(', ')})` : ''}`);
const r = spawnSync('docker', [...base, ...tail], { cwd: APP_DIR, stdio: 'inherit', env: childEnv });
process.exit(r.status ?? 1);
