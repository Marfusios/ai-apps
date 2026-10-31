/**
 * Docker Compose wrapper for the deployment in compose.yaml (docs/RUNBOOK.md).
 *
 *   pnpm app:up               start the app, building its image (tunnel mode: always on live, on dev when TUNNEL_TOKEN is set)
 *   pnpm app:down             stop and remove this environment's containers
 *   pnpm app:ps               list this environment's containers, one-offs included
 *   pnpm app:migrate          one-shot schema migrations (migrator role)
 *   pnpm app:backup           dump the database into AVIATION_BACKUP_DIR (migrator role)
 *   pnpm app:restore <file>   restore a backup into a freshly provisioned database (migrator role)
 *   pnpm ingest <command>     one-shot worker command (ingestion role), e.g. `pnpm ingest generations`
 *   pnpm extract:image        build the extraction image
 *
 * The env files in AVIATION_ENV_FILES (comma-separated, highest priority first) go
 * to Compose as --env-file, for interpolation only: each container receives just
 * the variables compose.yaml lists for it. Nonempty process values win. APP_ENV
 * (dev or live) selects the project `ai-aviation-<APP_ENV>`. compose.tunnel.yaml is
 * added in tunnel mode, compose.tracing.yaml when AVIATION_TRACING_ENABLED is true.
 * Values are never printed. Needs Docker Compose 2.24 or later (`!reset`).
 *
 * Images: on dev, app:up, app:migrate and ingest rebuild `ai-aviation/app:dev` from the
 * checkout every time, so all three run the same, current code. On live a release tag
 * (APP_VERSION) must also be a git tag; its image is built once, from a clean checkout of
 * the commit that tag names, records that commit (label `org.opencontainers.image.revision`),
 * and is never rebuilt implicitly, so rolling back to an earlier tag starts the image that
 * tag was built as. A tag whose image is gone, or was built from another commit, is refused
 * (`liveImagePlan`). `--rebuild` as the first argument rebuilds the tag on purpose, from
 * its clean tagged commit only.
 * AVIATION_DEV_RELEASE_IMAGE=true instead uses an existing, verified release image on
 * dev, pinned by image ID with no build or pull (docs/RUNBOOK.md, "Dev canary app").
 * AVIATION_MAINTENANCE_LOCK wraps backup/restore in the importer's host flock.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDotenvAllowlisted } from '../shared/env-files.js';
import { APP_DIR } from './local-env.js';
import { assertOutsideRepo } from './provision-shared.js';

export const COMMANDS = ['app-up', 'app-down', 'app-ps', 'migrate', 'backup', 'restore', 'ingest', 'extract-image'] as const;
export type Command = (typeof COMMANDS)[number];

/** Oldest Docker Compose that supports everything the files use (`!reset` in compose.tunnel.yaml). */
export const MIN_COMPOSE_VERSION = [2, 24, 0] as const;

/** Variables this wrapper reads to choose files and check the setup. */
export const NAMES = [
  'APP_ENV',
  'APP_VERSION',
  'AVIATION_DEV_RELEASE_IMAGE',
  'TUNNEL_TOKEN',
  'EDGE_SUBNET',
  'AVIATION_TRACING_ENABLED',
  'AVIATION_DATA_DIR',
  'AVIATION_BACKUP_DIR',
  'AVIATION_MAINTENANCE_LOCK',
  'AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS',
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

/** What the wrapper knows about a live release tag's image and the checkout (`liveImagePlan`). */
export interface LiveImageFacts {
  /** `ai-aviation/app:<tag>` on this host, with the commit it records (null: none recorded); null: no such image. */
  image: { revision: string | null; id?: string } | null;
  /** The commit the git tag named APP_VERSION points to, or null when there is no such tag. */
  tagCommit: string | null;
  /** The checkout's HEAD commit (null when unknown) and whether tracked files have changes. */
  head: string | null;
  dirty: boolean;
}

const short = (commit: string | null): string | null => (commit ? commit.slice(0, 12) : null);

/**
 * Whether a live command may start the tag's image as it is (`use`) or must build it
 * (`build`), or a UsageError. A tag is built only from a clean checkout of the commit its
 * git tag names: the first build, or `--rebuild`. An existing image must record that same
 * commit. A missing image is never built from another commit (a rollback to a removed
 * image would otherwise start the current code under the old name).
 */
/**
 * Whether the checkout of `dir` differs from its HEAD within `dir`, the image's build context:
 * changed, staged or untracked files that git does not ignore. An untracked source file would
 * enter an image recorded as the tagged commit (re-check N9). Unknown (not a checkout, git
 * failing) counts as dirty.
 */
export function checkoutDirty(dir: string): boolean {
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all', '--', '.'], { encoding: 'utf8' });
  return r.status !== 0 || r.stdout.trim() !== '';
}

export function liveImagePlan(tag: string, rebuild: boolean, f: LiveImageFacts): 'use' | 'build' {
  if (!f.tagCommit) {
    throw new UsageError(`live needs its release tagged in git: git tag ${tag} <commit> (docs/RUNBOOK.md, "Deploying an environment")`);
  }
  const atTag = f.head === f.tagCommit && !f.dirty;
  if (rebuild) {
    if (!atTag) throw new UsageError(`--rebuild builds the checkout: check out the clean commit tagged ${tag} first`);
    return 'build';
  }
  if (f.image) {
    if (f.image.revision !== f.tagCommit) {
      throw new UsageError(
        `ai-aviation/app:${tag} was built from ${short(f.image.revision) ?? 'an unrecorded commit'}, not from the commit tagged ${tag}; ` +
          `rebuild it with --rebuild from a clean checkout of that commit`,
      );
    }
    return 'use';
  }
  if (!atTag) {
    throw new UsageError(
      `ai-aviation/app:${tag} is not on this host, and live never builds another commit under its tag: ` +
        `check out the clean commit tagged ${tag} to build it, or load the image`,
    );
  }
  return 'build';
}

/** Commands that run the application image (`ai-aviation/app:<APP_VERSION>`). */
const IMAGE_COMMANDS: readonly Command[] = ['app-up', 'migrate', 'ingest'];
/** Wrapper option, first argument only: rebuild the image even where it would not be. */
export const REBUILD = '--rebuild';

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
  backup: ['SHARED_POSTGRES_NETWORK', 'DATABASE_MIGRATOR_URL', 'AVIATION_BACKUP_DIR'],
  restore: ['SHARED_POSTGRES_NETWORK', 'DATABASE_MIGRATOR_URL', 'AVIATION_BACKUP_DIR'],
  'app-down': [],
  'app-ps': [],
  'extract-image': [],
};

/** The database URL each command's container uses, and the group role it must act as. */
const DATABASE_URL_OF: Partial<Record<Command, [Name, string]>> = {
  'app-up': ['DATABASE_URL', 'aviation_app'],
  ingest: ['DATABASE_INGEST_URL', 'aviation_ingest'],
  migrate: ['DATABASE_MIGRATOR_URL', 'aviation_migrator'],
  backup: ['DATABASE_MIGRATOR_URL', 'aviation_migrator'],
  restore: ['DATABASE_MIGRATOR_URL', 'aviation_migrator'],
};

/** A backup file in AVIATION_BACKUP_DIR, by name only (docker/postgres/restore.sh). */
const BACKUP_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dump$/;

export class UsageError extends Error {}

export const MAINTENANCE_BUSY_EXIT = 75;
export const MAINTENANCE_BUSY_MESSAGE = 'AirCase maintenance lock timed out; backup/restore was not started.';
export const MAINTENANCE_WAIT_SECONDS = 1500;
export interface MaintenanceLock {
  path: string;
  waitSeconds: number;
}

/** Never creates a second lock file. The importer and all maintenance use the same inode. */
export function maintenanceLock(values: Values, uid = process.getuid?.()): MaintenanceLock | undefined {
  const path = values.AVIATION_MAINTENANCE_LOCK;
  if (!path) return undefined;
  const invalidPath = 'AVIATION_MAINTENANCE_LOCK must be an absolute, existing regular file owned by this user, mode 0600, not a symlink';
  if (!isAbsolute(path) || path.includes('\0') || uid === undefined) throw new UsageError(invalidPath);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) throw new Error();
  } catch {
    throw new UsageError(invalidPath);
  }
  const raw = values.AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS || String(MAINTENANCE_WAIT_SECONDS);
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 86400) {
    throw new UsageError('AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS must be an integer from 0 to 86400');
  }
  return { path, waitSeconds: Number(raw) };
}

/** Argument arrays only: neither credentials nor shell evaluation enter the command line. */
export function maintenanceInvocation(command: string, args: string[], lock?: MaintenanceLock): { command: string; args: string[] } {
  return lock
    ? { command: 'flock', args: ['-w', String(lock.waitSeconds), '-E', String(MAINTENANCE_BUSY_EXIT), '--', lock.path, command, ...args] }
    : { command, args };
}

/** A canary reuses an existing release; even a clean tagged checkout must never build it. */
export function devReleaseImage(facts?: LiveImageFacts): string {
  if (!facts?.tagCommit) throw new UsageError('dev release mode needs APP_VERSION to name an existing git tag');
  if (!facts.image) throw new UsageError('dev release mode needs an existing local release image; no image will be built or pulled');
  if (facts.image.revision !== facts.tagCommit) throw new UsageError('dev release image revision does not match the APP_VERSION git tag');
  if (!facts.image.id || !/^sha256:[0-9a-f]{64}$/.test(facts.image.id)) throw new UsageError('dev release image has no valid immutable image ID');
  return facts.image.id;
}

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
  maintenanceLock?: MaintenanceLock;
  pinnedImageId?: string;
}

/**
 * Validate the configuration for `command` and choose the Compose files and arguments.
 * `processEnv` and `fileEnvs` (one record per env file, highest priority first) hold the
 * allowlisted names only. Throws UsageError naming the problem, never a value.
 */
export function planCompose(command: Command, rawArgs: string[], processEnv: Values, fileEnvs: Values[], live?: LiveImageFacts): Plan {
  const rebuild = rawArgs[0] === REBUILD;
  if (rebuild && !IMAGE_COMMANDS.includes(command)) throw new UsageError(`${REBUILD} applies to app:up, app:migrate and ingest only`);
  const args = rebuild ? rawArgs.slice(1) : rawArgs;
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
  if (command === 'backup' && args.length > 0) throw new UsageError('app:backup takes no arguments');
  if (command === 'restore' && (args.length !== 1 || !BACKUP_FILE.test(args[0]!))) {
    throw new UsageError('app:restore takes one backup file: the name of a .dump file in AVIATION_BACKUP_DIR');
  }

  const usesImage = IMAGE_COMMANDS.includes(command);
  const devReleaseSetting = values.AVIATION_DEV_RELEASE_IMAGE;
  if (devReleaseSetting && !['true', 'false'].includes(devReleaseSetting)) throw new UsageError('AVIATION_DEV_RELEASE_IMAGE must be true or false');
  const devRelease = devReleaseSetting === 'true';
  if (devRelease && appEnv !== 'dev') throw new UsageError('AVIATION_DEV_RELEASE_IMAGE applies only to APP_ENV=dev');
  if (devRelease && rebuild) throw new UsageError('dev release mode refuses --rebuild');
  if (devRelease && command === 'app-up' && args.length > 0) throw new UsageError('app:up in dev release mode takes no extra arguments');
  if ((appEnv === 'live' || devRelease) && usesImage) {
    const version = values.APP_VERSION;
    if (!version || version === 'dev') throw new UsageError('release mode needs an explicit APP_VERSION other than dev (a release tag)');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(version)) throw new UsageError('APP_VERSION is not a valid image tag (maximum 80 characters)');
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
  if (devRelease && command === 'app-up' && (tunnel || tracing)) throw new UsageError('dev release canary must use loopback with tunnel and tracing off');
  const files = ['compose.yaml'];
  if (tunnel) files.push('compose.tunnel.yaml');
  if (tracing && (command === 'app-up' || command === 'ingest')) files.push('compose.tracing.yaml');
  const pinnedImageId = devRelease && usesImage ? devReleaseImage(live) : undefined;
  if (pinnedImageId) files.push('compose.dev-release.yaml');

  // dev: always the checkout's code. live: a tag is built once, from its tagged commit (liveImagePlan).
  const livePlan = appEnv === 'live' && usesImage && live ? liveImagePlan(values.APP_VERSION!, rebuild, live) : null;
  const build = !pinnedImageId && (appEnv === 'dev' || rebuild || livePlan === 'build') ? ['--build'] : [];
  // `up` would build a missing image itself; a live image that is used as it is never is.
  const upBuild = pinnedImageId || livePlan === 'use' ? ['--no-build'] : build;
  let tail: string[];
  switch (command) {
    case 'app-up':
      tail = ['--profile', 'app', ...(tunnel ? ['--profile', 'tunnel'] : []), 'up', '-d', ...upBuild, '--wait', '--wait-timeout', '180', ...args];
      break;
    case 'app-down':
      tail = ['--profile', 'app', '--profile', 'tools', '--profile', 'tunnel', 'down', ...args];
      break;
    case 'app-ps':
      tail = ['ps', '-a', ...args];
      break;
    case 'migrate':
      tail = ['--profile', 'tools', 'run', ...build, '--rm', 'aviation-migrate', ...args];
      break;
    case 'backup':
      tail = ['--profile', 'tools', 'run', '--rm', 'aviation-backup'];
      break;
    case 'restore':
      tail = ['--profile', 'tools', 'run', '--rm', 'aviation-restore', ...args];
      break;
    case 'ingest':
      tail = ['--profile', 'tools', 'run', ...build, '--rm', 'aviation-ingest', ...args];
      break;
    case 'extract-image':
      tail = ['build', 'extract-image', ...args];
      break;
  }
  const lock = command === 'backup' || command === 'restore' ? maintenanceLock(values) : undefined;
  return { appEnv, tunnel, files, tail, ...(lock ? { maintenanceLock: lock } : {}), ...(pinnedImageId ? { pinnedImageId } : {}) };
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
  const git = (...a: string[]): string | null => {
    const r = spawnSync('git', ['-C', APP_DIR, ...a], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const head = git('rev-parse', 'HEAD');
  const appEnvOf = processEnv.APP_ENV ?? fileEnvs.find((f) => f.APP_ENV)?.APP_ENV;
  const appVersion = processEnv.APP_VERSION ?? fileEnvs.find((f) => f.APP_VERSION)?.APP_VERSION;
  const devRelease = (processEnv.AVIATION_DEV_RELEASE_IMAGE ?? fileEnvs.find((f) => f.AVIATION_DEV_RELEASE_IMAGE)?.AVIATION_DEV_RELEASE_IMAGE) === 'true';
  let live: LiveImageFacts | undefined;
  if ((appEnvOf === 'live' || (appEnvOf === 'dev' && devRelease)) && IMAGE_COMMANDS.includes(command) && appVersion && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(appVersion)) {
    const inspected = spawnSync('docker', ['image', 'inspect', `ai-aviation/app:${appVersion}`, '--format', '{{.Id}} {{ index .Config.Labels "org.opencontainers.image.revision" }}'], { encoding: 'utf8' });
    const [id, revision = ''] = inspected.stdout.trim().split(/\s+/);
    live = {
      image: inspected.status === 0 ? { id, revision: /^[0-9a-f]{40}$/.test(revision) ? revision : null } : null,
      tagCommit: git('rev-parse', '-q', '--verify', `refs/tags/${appVersion}^{commit}`),
      head,
      dirty: checkoutDirty(APP_DIR),
    };
  }
  const plan = planCompose(command, args, processEnv, fileEnvs, live);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, APP_ENV: plan.appEnv };
  // The override has no build section and refers to this inspected ID, not a mutable tag.
  if (plan.pinnedImageId) childEnv.AVIATION_DEV_RELEASE_IMAGE_ID = plan.pinnedImageId;
  // Recorded in the image it builds (compose.yaml, x-app-image): the commit the image was built from.
  if (head) childEnv.AVIATION_GIT_REVISION = head;
  // Compose lets a variable exported empty override the env files; the checks above used the
  // files' value then, so pass Compose that same value.
  for (const n of NAMES) if (childEnv[n] === '') delete childEnv[n];
  if (command === 'backup' || command === 'restore') {
    // Dumps hold the ledger and quota records: a private directory outside the repository,
    // written and read as the host user that owns it.
    const named = processEnv.AVIATION_BACKUP_DIR ?? fileEnvs.find((f) => f.AVIATION_BACKUP_DIR)?.AVIATION_BACKUP_DIR;
    const dir = resolve(named!);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError('AVIATION_BACKUP_DIR is not an existing directory');
    try {
      assertOutsideRepo(dir);
    } catch {
      throw new UsageError('AVIATION_BACKUP_DIR must be outside the repository');
    }
    if (command === 'restore' && !existsSync(resolve(dir, basename(args[0]!)))) {
      throw new UsageError(`no backup named ${args[0]} in AVIATION_BACKUP_DIR`);
    }
    childEnv.AVIATION_BACKUP_DIR = dir;
  }
  if (command === 'ingest' || command === 'backup' || command === 'restore') {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && uid > 0 && gid !== undefined) {
      childEnv.AVIATION_UID = String(uid);
      childEnv.AVIATION_GID = String(gid);
    }
  }
  if (command === 'ingest') {
    // Reads data/ read-only as the host user that owns it; writes reports to data/reports/<env>.
    const dataDir = resolve(APP_DIR, processEnv.AVIATION_DATA_DIR ?? fileEnvs.find((f) => f.AVIATION_DATA_DIR)?.AVIATION_DATA_DIR ?? 'data');
    mkdirSync(resolve(dataDir, 'reports', plan.appEnv), { recursive: true, mode: 0o700 });
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
  // A busy lock emits exactly the fixed refusal; no action banner before acquiring it.
  if (!plan.maintenanceLock) console.error(`ai-aviation-${plan.appEnv}: ${command}${mode.length ? ` (${mode.join(', ')})` : ''}`);
  const invocation = maintenanceInvocation('docker', [...base, ...plan.tail], plan.maintenanceLock);
  const r = spawnSync(invocation.command, invocation.args, { cwd: APP_DIR, stdio: 'inherit', env: childEnv });
  if (plan.maintenanceLock && r.status === MAINTENANCE_BUSY_EXIT) console.error(MAINTENANCE_BUSY_MESSAGE);
  if (r.error) throw new UsageError('could not start the Compose invocation; check Docker and flock availability');
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
