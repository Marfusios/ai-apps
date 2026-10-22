/**
 * Provision one environment on shared PostgreSQL and Elasticsearch servers and write
 * its connection files outside the repository (docs/RUNBOOK.md#provisioning).
 *
 *   pnpm provision:shared --env dev|live --out <dir>
 *     [--pg-admin-env <file>] [--pg-host-url <url>] [--pg-docker-host <host:port>] [--pg-network <name>]
 *     [--es-admin-env <file>] [--es-host-url <url>] [--es-docker-url <url>] [--es-ca-file <file>] [--es-network <name>]
 *     [--rotate] [--dry-run]
 *
 * Admin credentials come only from the explicit files, by allowlisted name:
 * PG_ADMIN_URL in --pg-admin-env; ELASTIC_PASSWORD and ELASTICSEARCH_ADMIN_URL in
 * --es-admin-env. They are never printed or written. Idempotent: existing passwords
 * (read back from the output files) and working API keys are kept unless --rotate.
 * Output files are mode 0600 in 0700 directories:
 *
 *   <out>/postgres/aviation-<env>.env            host URLs of the three logins
 *   <out>/postgres/aviation-<env>.docker.env     the same on the shared Docker network
 *   <out>/elasticsearch/aviation-<env>.env       URL, API keys, CA file, index prefix
 *   <out>/elasticsearch/aviation-<env>.docker.env
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readDotenvAllowlisted } from '../shared/env-files.js';
import {
  ROLE_KINDS,
  URL_VARS,
  assertEnvName,
  defaultIndexPrefix,
  loginRole,
  passwordFor,
  pgBaseUrl,
  provisionElasticsearch,
  provisionPostgres,
  roleUrl,
  type Log,
  type RoleKind,
} from './provision.js';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ProvisionArgs {
  env: string;
  out: string;
  pgAdminEnv?: string;
  pgHostUrl?: string;
  pgDockerHost?: string;
  pgNetwork?: string;
  esAdminEnv?: string;
  esHostUrl?: string;
  esDockerUrl?: string;
  esCaFile?: string;
  esNetwork?: string;
  rotate: boolean;
  dryRun: boolean;
}

export const USAGE =
  'usage: provision-shared --env dev|live --out <dir> [--pg-admin-env <file>] [--pg-host-url <url>] ' +
  '[--pg-docker-host <host:port>] [--pg-network <name>] [--es-admin-env <file>] [--es-host-url <url>] ' +
  '[--es-docker-url <url>] [--es-ca-file <file>] [--es-network <name>] [--rotate] [--dry-run]';

const HOST_PORT = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function httpUrl(value: string, flag: string): string {
  const u = new URL(value);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${flag} must be an http(s) URL`);
  if (u.username || u.password) throw new Error(`${flag} must not contain credentials`);
  return value.replace(/\/+$/, '');
}

/** Parse and validate the command line; throws with a message naming the problem (never a value). */
export function parseProvisionArgs(argv: string[]): ProvisionArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: 'string' },
      out: { type: 'string' },
      'pg-admin-env': { type: 'string' },
      'pg-host-url': { type: 'string' },
      'pg-docker-host': { type: 'string' },
      'pg-network': { type: 'string' },
      'es-admin-env': { type: 'string' },
      'es-host-url': { type: 'string' },
      'es-docker-url': { type: 'string' },
      'es-ca-file': { type: 'string' },
      'es-network': { type: 'string' },
      rotate: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.env) throw new Error('--env is required');
  assertEnvName(values.env);
  if (!values.out) throw new Error('--out is required');
  if (!values['pg-admin-env'] && !values['es-admin-env']) throw new Error('give --pg-admin-env, --es-admin-env or both');
  const pg = Boolean(values['pg-admin-env']);
  const es = Boolean(values['es-admin-env']);
  for (const flag of ['pg-host-url', 'pg-docker-host', 'pg-network'] as const) {
    if (values[flag] && !pg) throw new Error(`--${flag} needs --pg-admin-env`);
  }
  for (const flag of ['es-host-url', 'es-docker-url', 'es-ca-file', 'es-network'] as const) {
    if (values[flag] && !es) throw new Error(`--${flag} needs --es-admin-env`);
  }
  if (values['pg-host-url']) {
    const u = new URL(values['pg-host-url']);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('--pg-host-url must be a postgres:// URL');
    if (u.username || u.password) throw new Error('--pg-host-url must not contain credentials');
  }
  if (values['pg-docker-host'] && !HOST_PORT.test(values['pg-docker-host'])) throw new Error('--pg-docker-host must be host[:port]');
  for (const flag of ['pg-network', 'es-network'] as const) {
    if (values[flag] && !NETWORK.test(values[flag])) throw new Error(`--${flag} is not a Docker network name`);
  }
  return {
    env: values.env,
    out: resolve(values.out),
    pgAdminEnv: values['pg-admin-env'] && resolve(values['pg-admin-env']),
    pgHostUrl: values['pg-host-url'],
    pgDockerHost: values['pg-docker-host'],
    pgNetwork: values['pg-network'],
    esAdminEnv: values['es-admin-env'] && resolve(values['es-admin-env']),
    esHostUrl: values['es-host-url'] && httpUrl(values['es-host-url'], '--es-host-url'),
    esDockerUrl: values['es-docker-url'] && httpUrl(values['es-docker-url'], '--es-docker-url'),
    esCaFile: values['es-ca-file'] && resolve(values['es-ca-file']),
    esNetwork: values['es-network'],
    rotate: values.rotate ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

/** Read the allowlisted admin variables from `file`; every name is required. Values are never echoed. */
export function readAdminEnv<N extends string>(file: string, names: readonly N[]): Record<N, string> {
  if (!existsSync(file)) throw new Error(`admin env file not found: ${file}`);
  const values = readDotenvAllowlisted(file, names);
  const missing = names.filter((n) => !values[n]);
  if (missing.length) throw new Error(`${file} lacks ${missing.join(', ')}`);
  return values as Record<N, string>;
}

/** The Git work tree containing the app (falls back to the app directory itself). */
export function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: APP_DIR, encoding: 'utf8' });
  return realpathSync(r.status === 0 && r.stdout.trim() ? r.stdout.trim() : APP_DIR);
}

/** Real path of `p`, resolving symlinks through its nearest existing ancestor. */
function realPathOf(p: string): string {
  let existing = resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(existing.slice(dirname(existing).length + 1));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/** Refuse output paths inside the repository (credentials must never be committed). */
export function assertOutsideRepo(out: string, root: string = repoRoot()): void {
  const target = realPathOf(out);
  const base = realpathSync(root);
  const rel = relative(base, target);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('--out must be outside the repository');
  }
}

/** Parse a generated env file (or nothing) into its allowlisted values. */
function readExisting<N extends string>(file: string, names: readonly N[]): Partial<Record<N, string>> {
  return existsSync(file) ? (readDotenvAllowlisted(file, names) as Partial<Record<N, string>>) : {};
}

function writeEnvFile(file: string, header: string, values: Record<string, string | undefined>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const lines = [`# ${header}`, ...Object.entries(values).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)];
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export interface ProvisionResult {
  files: string[];
}

/** Provision the environment and write its connection files (see the file header). */
export async function runProvision(args: ProvisionArgs, log: Log = (m) => console.log(m)): Promise<ProvisionResult> {
  assertOutsideRepo(args.out);
  if (args.dryRun) log('dry run: nothing is created, changed or written');
  const files: string[] = [];
  const header = `Generated by scripts/provision-shared.ts for environment ${args.env}; keep private.`;

  if (args.pgAdminEnv) {
    const { PG_ADMIN_URL } = readAdminEnv(args.pgAdminEnv, ['PG_ADMIN_URL']);
    const hostFile = join(args.out, 'postgres', `aviation-${args.env}.env`);
    const dockerFile = join(args.out, 'postgres', `aviation-${args.env}.docker.env`);
    const urlNames = ROLE_KINDS.map((k) => URL_VARS[k]);
    const previous = readExisting(hostFile, urlNames);
    const keep: Partial<Record<RoleKind, string>> = {};
    for (const k of ROLE_KINDS) {
      const pw = passwordFor(previous[URL_VARS[k]], loginRole(args.env, k));
      if (pw) keep[k] = pw;
    }
    const passwords = await provisionPostgres({
      env: args.env,
      adminUrl: PG_ADMIN_URL,
      passwords: keep,
      rotate: args.rotate,
      dryRun: args.dryRun,
      log,
    });
    const hostBase = args.pgHostUrl ?? pgBaseUrl(PG_ADMIN_URL);
    const urls = (base: string) =>
      Object.fromEntries(ROLE_KINDS.map((k) => [URL_VARS[k], roleUrl(base, args.env, k, passwords[k])]));
    if (args.dryRun) {
      log(`would write ${hostFile}${args.pgDockerHost ? ` and ${dockerFile}` : ''}`);
    } else {
      writeEnvFile(hostFile, `${header} Host-side PostgreSQL logins.`, { APP_ENV: args.env, ...urls(hostBase) });
      files.push(hostFile);
      if (args.pgDockerHost) {
        const dockerBase = new URL(hostBase);
        dockerBase.host = args.pgDockerHost;
        writeEnvFile(dockerFile, `${header} PostgreSQL logins on the shared Docker network.`, {
          APP_ENV: args.env,
          ...urls(dockerBase.toString()),
          SHARED_POSTGRES_NETWORK: args.pgNetwork,
        });
        files.push(dockerFile);
      }
    }
  }

  if (args.esAdminEnv) {
    const admin = readAdminEnv(args.esAdminEnv, ['ELASTIC_PASSWORD', 'ELASTICSEARCH_ADMIN_URL'] as const);
    const adminUrl = httpUrl(admin.ELASTICSEARCH_ADMIN_URL, 'ELASTICSEARCH_ADMIN_URL');
    const hostFile = join(args.out, 'elasticsearch', `aviation-${args.env}.env`);
    const dockerFile = join(args.out, 'elasticsearch', `aviation-${args.env}.docker.env`);
    const previous = readExisting(hostFile, ['ELASTICSEARCH_READ_API_KEY', 'ELASTICSEARCH_WRITE_API_KEY'] as const);
    const prefix = defaultIndexPrefix(args.env);
    const keys = await provisionElasticsearch({
      env: args.env,
      indexPrefix: prefix,
      admin: { url: adminUrl, password: admin.ELASTIC_PASSWORD, caFile: args.esCaFile },
      keys: { read: previous.ELASTICSEARCH_READ_API_KEY, write: previous.ELASTICSEARCH_WRITE_API_KEY },
      rotate: args.rotate,
      dryRun: args.dryRun,
      log,
    });
    const common = {
      ELASTICSEARCH_READ_API_KEY: keys.read,
      ELASTICSEARCH_WRITE_API_KEY: keys.write,
      ELASTICSEARCH_CA_FILE: args.esCaFile,
      ELASTICSEARCH_INDEX_PREFIX: prefix,
    };
    if (args.dryRun) {
      log(`would write ${hostFile}${args.esDockerUrl ? ` and ${dockerFile}` : ''}`);
    } else {
      writeEnvFile(hostFile, `${header} Host-side Elasticsearch access.`, {
        APP_ENV: args.env,
        ELASTICSEARCH_URL: args.esHostUrl ?? adminUrl,
        ...common,
      });
      files.push(hostFile);
      if (args.esDockerUrl) {
        writeEnvFile(dockerFile, `${header} Elasticsearch access on the shared Docker network.`, {
          APP_ENV: args.env,
          ELASTICSEARCH_URL: args.esDockerUrl,
          ...common,
          SHARED_ELASTICSEARCH_NETWORK: args.esNetwork,
        });
        files.push(dockerFile);
      }
    }
  }
  for (const f of files) log(`wrote ${f}`);
  return { files };
}

async function main(): Promise<number> {
  let args: ProvisionArgs;
  try {
    args = parseProvisionArgs(process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  await runProvision(args);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      // Messages from pg/Elasticsearch name objects, not credentials.
      console.error(`provisioning failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
