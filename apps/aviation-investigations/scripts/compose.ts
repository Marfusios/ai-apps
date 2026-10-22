/**
 * Docker Compose wrapper for the deployment in compose.yaml (docs/RUNBOOK.md).
 *
 *   pnpm app:up               build and start the app (tunnel mode: always on live, on dev when TUNNEL_TOKEN is set)
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
 * added in tunnel mode, compose.tracing.yaml when AVIATION_TRACING_ENABLED is true.
 * Values are never printed. Needs Docker Compose 2.24 or later (`!reset`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDotenvAllowlisted } from '../shared/env-files.js';
import { APP_DIR } from './local-env.js';

export const COMMANDS = ['app-up', 'app-down', 'app-ps', 'migrate', 'ingest', 'extract-image'] as const;
export type Command = (typeof COMMANDS)[number];

/** Oldest Docker Compose that supports everything the files use (`!reset` in compose.tunnel.yaml). */
export const MIN_COMPOSE_VERSION = [2, 24, 0] as const;

/** Variables this wrapper reads to choose files and check the setup. */
export const NAMES = [
  'APP_ENV',
  'APP_VERSION',
  'TUNNEL_TOKEN',
  'EDGE_SUBNET',
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
export type Name = (typeof NAMES)[number];
export type Values = Partial<Record<Name, string>>;

const REQUIRED: Record<Command, readonly Name[]> = {
  'app-up': [
    'SHARED_POSTGRES_NETWORK',
    'SHARED_ELASTICSEARCH_NETWORK',
    'DATABASE_URL',
    'ELASTICSEARCH_URL',
    'ELASTICSEARCH_READ_API_KEY',
  ],
  ingest: ['SHARED_POSTGRES_NETWORK', 'SHARED_ELASTICSEARCH_NETWORK', 'DATABASE_INGEST_URL'],
  migrate: ['SHARED_POSTGRES_NETWORK', 'DATABASE_MIGRATOR_URL'],
  'app-down': [],
  'app-ps': [],
  'extract-image': [],
};

/** The database URL each command's container uses, and the group role it must act as. */
const DATABASE_URL_OF: Partial<Record<Command, [Name, string]>> = {
  'app-up': ['DATABASE_URL', 'aviation_app'],
  ingest: ['DATABASE_INGEST_URL', 'aviation_ingest'],
  migrate: ['DATABASE_MIGRATOR_URL', 'aviation_migrator'],
};

export class UsageError extends Error {}

/** True for a version string at least `min` (major.minor.patch, optional leading v and suffix). */
export function versionAtLeast(version: string, min: readonly number[] = MIN_COMPOSE_VERSION): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i]! !== min[i]!) return v[i]! > min[i]!;
  return true;
}

/**
 * EDGE_SUBNET: an IPv4 CIDR in an RFC 1918 private range, /16 to /29. Docker pins the
 * `edge` network to it, and the app trusts proxy headers only from peers inside it.
 */
export function checkEdgeSubnet(cidr: string): void {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  const octets = m ? m.slice(1, 5).map(Number) : [];
  const bits = m ? Number(m[5]) : -1;
  if (!m || octets.some((o) => o > 255) || bits < 16 || bits > 29) {
    throw new UsageError('EDGE_SUBNET must be an IPv4 CIDR from /16 to /29');
  }
  const [a, b] = octets as [number, number, number, number];
  const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!rfc1918) throw new UsageError('EDGE_SUBNET must be in a private (RFC 1918) range');
  const address = octets.reduce((n, o) => n * 256 + o, 0);
  if (address % 2 ** (32 - bits) !== 0) throw new UsageError('EDGE_SUBNET must be a network address (host bits zero)');
}

/** The URL must name database aviation_<env> and switch to `group` (`options=-c role=<group>`). */
export function checkDatabaseUrl(name: string, url: string, appEnv: string, group: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UsageError(`${name} is not a valid URL`);
  }
  if (u.pathname !== `/aviation_${appEnv}`) throw new UsageError(`${name} must use database aviation_${appEnv} for APP_ENV=${appEnv}`);
  if (!new RegExp(`(^|\\s)-c\\s*role=${group}(\\s|$)`).test(u.searchParams.get('options') ?? '')) {
    throw new UsageError(`${name} must end in ?options=-c%20role%3D${group} (scripts/provision.ts)`);
  }
}

export interface Plan {
  appEnv: 'dev' | 'live';
  tunnel: boolean;
  files: string[];
  tail: string[];
}

/**
 * Validate the configuration for `command` and choose the Compose files and arguments.
 * `processEnv` and `fileEnvs` (one record per env file, highest priority first) hold the
 * allowlisted names only. Throws UsageError naming the problem, never a value.
 */
export function planCompose(command: Command, args: string[], processEnv: Values, fileEnvs: Values[]): Plan {
  const values: Values = {};
  for (const f of [...fileEnvs].reverse()) Object.assign(values, f);
  for (const [k, v] of Object.entries(processEnv) as [Name, string][]) if (v) values[k] = v;

  const fileAppEnvs = new Set(fileEnvs.map((f) => f.APP_ENV).filter(Boolean));
  if (fileAppEnvs.size > 1) throw new UsageError('the env files disagree on APP_ENV');
  if (processEnv.APP_ENV && fileAppEnvs.size === 1 && !fileAppEnvs.has(processEnv.APP_ENV)) {
    throw new UsageError('APP_ENV in the shell differs from APP_ENV in the env files');
  }
  // The extraction image is the same for every environment; build it under dev by default.
  const appEnv = values.APP_ENV ?? (command === 'extract-image' ? 'dev' : undefined);
  if (appEnv !== 'dev' && appEnv !== 'live') {
    throw new UsageError('APP_ENV must be dev or live (set it in the env file named by AVIATION_ENV_FILES; see docs/RUNBOOK.md)');
  }
  const missing = REQUIRED[command].filter((n) => !values[n]);
  if (missing.length) throw new UsageError(`missing for ${command}: ${missing.join(', ')} (see docs/RUNBOOK.md)`);

  const usesImage = command === 'app-up' || command === 'ingest' || command === 'migrate';
  if (appEnv === 'live' && usesImage) {
    const version = values.APP_VERSION;
    if (!version || version === 'dev') throw new UsageError('live needs an explicit APP_VERSION other than dev (a release tag)');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) throw new UsageError('APP_VERSION is not a valid image tag');
  }
  const dbUrl = DATABASE_URL_OF[command];
  if (dbUrl) checkDatabaseUrl(dbUrl[0], values[dbUrl[0]]!, appEnv, dbUrl[1]);
  // The shared cluster's `ai-*` template covers ai-aviation-<env>-* indices; the API keys are limited to them.
  const prefix = values.ELASTICSEARCH_INDEX_PREFIX;
  if (prefix && (command === 'app-up' || command === 'ingest') && prefix !== `ai-aviation-${appEnv}`) {
    throw new UsageError(`ELASTICSEARCH_INDEX_PREFIX must be ai-aviation-${appEnv} for APP_ENV=${appEnv}`);
  }

  // live never publishes a port: it runs only behind the tunnel.
  const tunnel = command === 'app-up' && (appEnv === 'live' || Boolean(values.TUNNEL_TOKEN));
  if (tunnel) {
    if (!values.TUNNEL_TOKEN) throw new UsageError('live runs only in tunnel mode: set TUNNEL_TOKEN');
    if (!values.EDGE_SUBNET) throw new UsageError('tunnel mode needs EDGE_SUBNET (a private /28, distinct per environment)');
    checkEdgeSubnet(values.EDGE_SUBNET);
  }
  const tracing = ['true', '1'].includes(values.AVIATION_TRACING_ENABLED ?? '');
  const files = ['compose.yaml'];
  if (tunnel) files.push('compose.tunnel.yaml');
  if (tracing && (command === 'app-up' || command === 'ingest')) files.push('compose.tracing.yaml');

  let tail: string[];
  switch (command) {
    case 'app-up':
      tail = ['--profile', 'app', ...(tunnel ? ['--profile', 'tunnel'] : []), 'up', '-d', '--build', '--wait', '--wait-timeout', '180', ...args];
      break;
    case 'app-down':
      tail = ['--profile', 'app', '--profile', 'tools', '--profile', 'tunnel', 'down', ...args];
      break;
    case 'app-ps':
      tail = ['ps', '-a', ...args];
      break;
    case 'migrate':
      tail = ['--profile', 'tools', 'run', '--rm', 'aviation-migrate', ...args];
      break;
    case 'ingest':
      tail = ['--profile', 'tools', 'run', '--rm', 'aviation-ingest', ...args];
      break;
    case 'extract-image':
      tail = ['build', 'extract-image', ...args];
      break;
  }
  return { appEnv, tunnel, files, tail };
}

function main(): number {
  const [cmd, ...rawArgs] = process.argv.slice(2) as [string | undefined, ...string[]];
  if (!COMMANDS.includes(cmd as Command)) throw new UsageError(`usage: compose.ts ${COMMANDS.join('|')} [args]`);
  const command = cmd as Command;
  // `pnpm ingest -- verify ...` passes the separator through; drop it.
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  const version = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  if (version.status !== 0 || !versionAtLeast(version.stdout)) {
    throw new UsageError(`Docker Compose ${MIN_COMPOSE_VERSION.join('.')} or later is required (found ${version.stdout.trim() || 'none'})`);
  }

  const envFiles = (process.env.AVIATION_ENV_FILES ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => resolve(f));
  for (const f of envFiles) if (!existsSync(f)) throw new UsageError(`env file not found: ${f}`);
  const fileEnvs = envFiles.map((f) => readDotenvAllowlisted(f, NAMES) as Values);
  const processEnv: Values = {};
  for (const n of NAMES) if (process.env[n]) processEnv[n] = process.env[n];
  const plan = planCompose(command, args, processEnv, fileEnvs);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, APP_ENV: plan.appEnv };
  if (command === 'ingest') {
    // Reads data/ read-only as the host user that owns it; writes reports to data/reports/<env>.
    const dataDir = resolve(APP_DIR, processEnv.AVIATION_DATA_DIR ?? fileEnvs.find((f) => f.AVIATION_DATA_DIR)?.AVIATION_DATA_DIR ?? 'data');
    mkdirSync(resolve(dataDir, 'reports', plan.appEnv), { recursive: true, mode: 0o700 });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && uid > 0 && gid !== undefined) {
      childEnv.AVIATION_UID = String(uid);
      childEnv.AVIATION_GID = String(gid);
    }
  }
  const base = [
    'compose',
    '-p',
    `ai-aviation-${plan.appEnv}`,
    // Without env files, /dev/null keeps Compose from reading an implicit .env.
    ...(envFiles.length ? [...envFiles].reverse() : ['/dev/null']).flatMap((f) => ['--env-file', f]),
    ...plan.files.flatMap((f) => ['-f', f]),
  ];
  const mode = [plan.tunnel ? 'tunnel' : null, plan.files.includes('compose.tracing.yaml') ? 'tracing' : null].filter(Boolean);
  console.error(`ai-aviation-${plan.appEnv}: ${command}${mode.length ? ` (${mode.join(', ')})` : ''}`);
  const r = spawnSync('docker', [...base, ...plan.tail], { cwd: APP_DIR, stdio: 'inherit', env: childEnv });
  return r.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
