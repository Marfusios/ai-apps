import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_LIMITS, extractMember, verifyArchive } from './archive.js';
import { TABLE_NAMES, TABLE_SPECS, projectFile, type TableName } from './tables.js';

/** Built by `pnpm extract:image` (Compose service `extract-image`); formerly tagged aviation-extract:mdbtools-1.0.0. */
export const EXTRACT_IMAGE = 'ai-aviation/extract:mdbtools-1.0.0';
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
/** Per-table cap on bytes accepted from the container's stdout. */
export const MAX_TABLE_BYTES = 2 * 1024 * 1024 * 1024;
/** Bound for every `docker create` / `docker rm -f` / `docker ps` / `docker image inspect` call. */
export const DOCKER_CALL_TIMEOUT_MS = 15_000;
/** Reconciling a container by name: at most this many rm + ps rounds, this far apart. */
export const RECONCILE_ROUNDS = 4;
export const RECONCILE_DELAY_MS = 500;

/** mdb-export options: unambiguous ISO-8601 dates, RFC 4180 quoting (quotes doubled). */
export const MDB_EXPORT_FLAGS = [
  '-D', '%Y-%m-%d',
  '-T', '%Y-%m-%dT%H:%M:%S',
  '-q', '"',
  '-X', '"',
] as const;

/** Sandbox for every container (removal is explicit, never `--rm`). The root is read-only and nothing is writable. */
export const SANDBOX_FLAGS = [
  '--log-driver=none',
  '--network', 'none',
  '--read-only',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--memory', '1g',
  // Without it the container could use as much swap again.
  '--memory-swap', '1g',
  '--cpus', '2',
  '--pids-limit', '64',
] as const;

/** MDBTools never inherits the operator's identity, even for a private file bind mount. */
export function sandboxFlags(uid = process.getuid?.(), gid = process.getgid?.()): readonly string[] {
  if (typeof uid !== 'number' || typeof gid !== 'number' || !Number.isSafeInteger(uid)
    || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
    throw new Error('extraction requires an unprivileged host user and group');
  }
  return [...SANDBOX_FLAGS, '--user', '65534:65534'];
}

/**
 * Stderr lines from mdb-export that were investigated and are known to be harmless.
 * Empty on purpose: any other stderr output fails the export (mdbtools can print
 * page-read or memo errors and still exit 0).
 */
export const BENIGN_STDERR: readonly RegExp[] = [];

const SAFE_TABLE = /^[a-z_]+$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export type ExtractEnvironment = 'dev' | 'live';
let environment: ExtractEnvironment = 'dev';
/**
 * Group extraction containers with the deployment environment's Compose project
 * (`ai-aviation-<env>`): they are named `ai-aviation-<env>-extract-<hex>` and carry
 * its project/service labels, so `docker compose -p ai-aviation-<env> ps -a` lists them.
 */
export function setExtractEnvironment(env: ExtractEnvironment): void {
  if (env !== 'dev' && env !== 'live') throw new Error('invalid extract environment');
  environment = env;
}

/** The Compose project of the current environment. */
export function composeProject(): string {
  return `ai-aviation-${environment}`;
}

/**
 * Labels of every extraction container: a one-off `extract` container of the
 * environment's project. `docker compose ps` lists only containers that carry a
 * config hash; here it is the sha256 of the container's sandbox flags, mounts,
 * image and command.
 */
export function containerLabels(run: Pick<ContainerRun, 'image' | 'mounts' | 'command'>): string[] {
  const configHash = createHash('sha256')
    .update(JSON.stringify([sandboxFlags(), run.mounts, run.image, run.command]))
    .digest('hex');
  return [
    `com.docker.compose.project=${composeProject()}`,
    'com.docker.compose.service=extract',
    'com.docker.compose.oneoff=True',
    `com.docker.compose.config-hash=${configHash}`,
    'ai-apps.app=aviation-investigations',
    'ai-apps.component=extract',
    `ai-apps.environment=${environment}`,
  ].flatMap((label) => ['--label', label]);
}

let dockerCommand = 'docker';
/** Test seam: replace the docker executable (e.g. with a scripted fake). */
export function setDockerCommand(cmd: string): void {
  dockerCommand = cmd;
}

interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** False only when the docker executable itself could not be started (no request was sent). */
  spawned: boolean;
}

/** Run a short docker CLI call with a hard timeout; never rejects on a nonzero exit. */
function dockerCall(args: readonly string[], timeoutMs = DOCKER_CALL_TIMEOUT_MS): Promise<DockerResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(dockerCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 8192) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      // A spawn failure leaves the child without a pid: the CLI never ran.
      resolvePromise({ code: null, stdout, stderr: stderr || e.message, timedOut, spawned: child.pid !== undefined });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut, spawned: true });
    });
  });
}

/** Remove a container by its known ID and confirm it is gone. */
export async function forceRemove(id: string): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await dockerCall(['rm', '-f', id]);
    if (r.code === 0) return;
    // The ID was returned by `docker create`, so "no such container" means it is already gone.
    if (!r.timedOut && /no such container/i.test(r.stderr)) return;
    last = r.timedOut ? 'timed out' : `exit ${String(r.code)}`;
    await sleep(300);
  }
  throw new Error(`could not confirm removal of container ${id.slice(0, 12)} (${last})`);
}

/**
 * Remove a container known only by its unique name and confirm it is absent. Used
 * when `docker create` gave no confirmed ID: the daemon may still have created it
 * (for example when the CLI lost its connection or was killed after submitting).
 * Each round runs `docker rm -f <name>` and then lists `docker ps -a` by exact name;
 * absence must be seen in two consecutive rounds, so a creation that lands late is
 * removed by the next round. Bounded by RECONCILE_ROUNDS and the per-call timeout.
 */
export async function reconcileByName(name: string): Promise<void> {
  let absentRounds = 0;
  let last = 'not checked';
  for (let round = 0; round < RECONCILE_ROUNDS; round++) {
    if (round > 0) await sleep(RECONCILE_DELAY_MS);
    await dockerCall(['rm', '-f', name]);
    // Anchored filter (optional leading slash, as stored by older daemons) plus an exact comparison here.
    const ps = await dockerCall(['ps', '-a', '--filter', `name=^/?${name}$`, '--format', '{{.Names}}']);
    if (ps.code !== 0 || ps.timedOut) {
      absentRounds = 0;
      last = ps.timedOut ? 'docker ps timed out' : `docker ps exit ${String(ps.code)}`;
      continue;
    }
    const listed = ps.stdout.split(/[\n,]/).some((n) => n.trim().replace(/^\//, '') === name);
    if (listed) {
      absentRounds = 0;
      last = 'still listed';
      continue;
    }
    if (++absentRounds >= 2) return;
  }
  throw new Error(`could not confirm that container ${name} is absent (${last}); check "docker ps -a --filter name=${name}"`);
}

interface Live {
  name: string;
  id: string | null;
  child: ChildProcess | null;
  creating: Promise<DockerResult> | null;
  cleanup: Promise<void> | null;
  /** Set once cleanup has begun; the container must then never be started. */
  cancelled: boolean;
}
/** Containers whose removal has not been confirmed, keyed by name. */
const live = new Map<string, Live>();

let terminating = false;
/** True once a termination signal started shutdown; no new containers are started. */
export function isTerminating(): boolean {
  return terminating;
}
export function beginShutdown(): void {
  terminating = true;
}
/** Test seam. */
export function resetShutdown(): void {
  terminating = false;
}

const CONTAINER_ID = /^[0-9a-f]{64}$/;

/** The container ID confirmed by a finished `docker create`, or null. */
function createdId(created: DockerResult | null): string | null {
  const id = created?.stdout.trim() ?? '';
  return created?.code === 0 && CONTAINER_ID.test(id) ? id : null;
}

/**
 * One memoised cancellation and removal path per container. Kills the client, waits
 * for an in-flight `docker create` to finish, then removes the returned ID. Without
 * a confirmed ID the creation is uncertain (a nonzero exit does not prove the daemon
 * created nothing), so the container is reconciled by its unique name. Only a docker
 * CLI that never started proves that nothing was submitted. A cleanup that cannot be
 * confirmed fails and the entry stays tracked; success is never reported without it.
 */
function ensureCleanup(entry: Live): Promise<void> {
  entry.cancelled = true;
  entry.cleanup ??= (async () => {
    entry.child?.kill('SIGKILL');
    const created = await entry.creating;
    entry.id ??= createdId(created);
    if (entry.id) return forceRemove(entry.id);
    if (!created?.spawned) return; // `docker create` was never issued or its CLI never ran
    await reconcileByName(entry.name);
  })();
  // A failed cleanup may be retried by a later call.
  entry.cleanup.catch(() => {
    entry.cleanup = null;
  });
  return entry.cleanup;
}

/** Cancel and remove every tracked container, awaiting confirmation; returns failures. */
export async function removeAllContainers(): Promise<string[]> {
  const failures: string[] = [];
  await Promise.all(
    [...live.values()].map(async (entry) => {
      try {
        await ensureCleanup(entry);
        live.delete(entry.name);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }),
  );
  return failures;
}

export interface ContainerRun {
  beforeWrite?: (bytes: number) => Promise<void>;
  container?: (name: string, present: boolean) => Promise<void>;
  image: string;
  mounts: readonly string[];
  command: readonly string[];
  /** Receives stdout. runContainer owns it from the call on: it is destroyed on every failure path. */
  sink: Writable | null;
  timeoutMs: number;
  maxBytes?: number;
}

function startAttached(
  entry: Live,
  run: ContainerRun,
  abort: (e: Error) => void,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dockerCommand, ['start', '-a', entry.id as string], { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.child = child;
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString('utf8');
    });
    let total = 0;
    const maxBytes = run.maxBytes ?? Number.POSITIVE_INFINITY;
    const cap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        total += chunk.length;
        if (total > maxBytes) return cb(new Error(`container output exceeds ${maxBytes} bytes`));
        if (run.beforeWrite) void run.beforeWrite(chunk.length).then(() => cb(null, chunk), cb);
        else cb(null, chunk);
      },
    });
    const done = run.sink ? pipeline(child.stdout, cap, run.sink) : (child.stdout.resume(), Promise.resolve());
    done.catch((e: unknown) => abort(e instanceof Error ? e : new Error(String(e))));
    child.on('error', reject);
    child.on('close', (code) => void done.catch(() => undefined).then(() => resolvePromise({ code, stderr })));
  });
}

/**
 * Run one sandboxed container (argument array, no shell): `docker create` returns the
 * container ID, `docker start -a` streams its output, and `docker rm -f <id>` always
 * removes it afterwards, awaited, on success and on every failure path. Timeout,
 * output-cap breach, stream or sink failure (also while `docker create` is still
 * pending) and signals all go through the same cleanup. A create that ends without
 * a confirmed ID is reconciled by the container's unique name (reconcileByName).
 */
export async function runContainer(run: ContainerRun): Promise<{ stderr: string }> {
  const { sink } = run;
  if (terminating) {
    sink?.destroy();
    throw new Error('cancelled by signal');
  }
  let flags: readonly string[];
  try { flags = sandboxFlags(); } catch (error) { sink?.destroy(); throw error; }
  const name = `${composeProject()}-extract-${randomBytes(6).toString('hex')}`;
  const entry: Live = { name, id: null, child: null, creating: null, cleanup: null, cancelled: false };
  live.set(name, entry);
  try { await run.container?.(name, true); } catch (err) { live.delete(name); sink?.destroy(); throw err; }
  let failure: Error | null = null;
  const abort = (e: Error): void => {
    if (failure) return;
    failure = e;
    void ensureCleanup(entry).catch(() => undefined);
  };
  // Attached before the first await: the sink can fail (open error, ENOSPC) while
  // `docker create` is still pending, and that must take the shared cleanup path
  // instead of becoming an unhandled 'error' event. It stays attached for late errors.
  sink?.on('error', (e: Error) => abort(e));
  entry.creating = dockerCall(
    ['create', '--name', name, ...containerLabels(run), ...flags, ...run.mounts, run.image, ...run.command],
    DOCKER_CALL_TIMEOUT_MS,
  );
  const timer = setTimeout(() => abort(new Error(`container timed out after ${run.timeoutMs} ms`)), run.timeoutMs);
  let code: number | null = null;
  let stderr = '';
  let started = false;
  try {
    const created = await entry.creating;
    entry.id ??= createdId(created);
    if (entry.id && !failure && !terminating && !entry.cancelled) {
      started = true;
      ({ code, stderr } = await startAttached(entry, run, abort));
    } else if (!entry.id) {
      abort(new Error(`docker create failed (${created.timedOut ? 'timed out' : `exit ${String(created.code)}`})`));
    }
  } catch (e) {
    abort(e instanceof Error ? e : new Error(String(e)));
  }
  clearTimeout(timer);
  if (!started || failure) sink?.destroy();
  let cleanupError = '';
  try {
    await ensureCleanup(entry);
    await run.container?.(name, false);
    live.delete(name);
  } catch (e) {
    cleanupError = `; cleanup failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!failure && terminating) failure = new Error('cancelled by signal');
  if (failure) throw new Error(`${(failure as Error).message}${cleanupError}`);
  if (code !== 0) {
    const diag = summarizeStderr(stderr);
    throw new Error(`container exited with ${String(code)}${diag ? ` (diagnostics: ${diag})` : ''}${cleanupError}`);
  }
  if (cleanupError) throw new Error(`container finished${cleanupError}`);
  return { stderr };
}

function mdbMount(mdbPath: string): string[] {
  return ['-v', `${resolve(mdbPath)}:/in/avall.mdb:ro`];
}

/** The file bind bypasses host directory traversal; the host workspace remains owner-only. */
export async function prepareMdbMount(mdbPath: string): Promise<void> {
  sandboxFlags(); // Refuse a privileged operator before changing permissions.
  const parent = await lstat(dirname(mdbPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
    || (parent.mode & 0o777) !== 0o700) {
    throw new Error('MDB mount requires an owner-only workspace');
  }
  const handle = await open(mdbPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid?.() || file.nlink !== 1) {
      throw new Error('MDB mount requires an owned regular file');
    }
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
}

/** Resolve the local image once; every container then runs against this immutable ID. */
export async function resolveImageId(image = EXTRACT_IMAGE): Promise<string> {
  const r = await dockerCall(['image', 'inspect', '--format', '{{.Id}}', image]);
  const id = r.stdout.trim();
  if (r.code !== 0 || !IMAGE_ID.test(id)) {
    throw new Error(`cannot resolve image ${image}; run "pnpm extract:image" first`);
  }
  return id;
}

export async function mdbtoolsVersion(mdbPath: string, imageId?: string, guard?: ExtractGuard): Promise<string> {
  const image = imageId ?? (await resolveImageId());
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  await runContainer({
    image,
    mounts: mdbMount(mdbPath),
    command: ['mdb-export', '--version'],
    sink,
    timeoutMs: 60_000,
    maxBytes: 65536,
    container: guard?.container,
  });
  const m = /(\d+\.\d+\.\d+\S*)/.exec(Buffer.concat(chunks).toString('utf8'));
  if (!m?.[1]) throw new Error('cannot determine mdbtools version');
  return m[1];
}

/** Reduce stderr to counts per category; raw content (which may echo data) is never reported. */
export function summarizeStderr(stderr: string): string | null {
  const counts: Record<string, number> = {};
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t || BENIGN_STDERR.some((re) => re.test(t))) continue;
    const category = /memo|ole|lvl/i.test(t)
      ? 'memo-read'
      : /page|offset|read|seek/i.test(t)
        ? 'page-read'
        : 'other';
    counts[category] = (counts[category] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, n]) => `${k}=${n}`);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Export every allowlisted table as raw CSV into `outDir/<table>.csv`. The container
 * has no network, a read-only root, no writable mounts and no capabilities: the
 * host process streams its stdout into the file. Table names come only from the
 * constant allowlist. Unexpected stderr output fails the export.
 */
export async function runMdbExport(
  mdbPath: string,
  outDir: string,
  imageId?: string,
  guard?: ExtractGuard,
): Promise<Record<TableName, string>> {
  const image = imageId ?? (await resolveImageId());
  const result = {} as Record<TableName, string>;
  for (const table of TABLE_NAMES) {
    if (!SAFE_TABLE.test(table)) throw new Error('invalid table name');
    const file = join(outDir, `${table}.csv`);
    // Open (exclusive create) before any container exists, so an open failure needs no cleanup.
    const handle = await open(file, 'wx', 0o600);
    const { stderr } = await runContainer({
      image,
      mounts: mdbMount(mdbPath),
      command: ['mdb-export', ...MDB_EXPORT_FLAGS, '/in/avall.mdb', table],
      sink: handle.createWriteStream(),
      timeoutMs: EXPORT_TIMEOUT_MS,
      maxBytes: MAX_TABLE_BYTES,
      beforeWrite: guard ? n => guard.beforeWrite('raw', n) : undefined,
      container: guard?.container,
    });
    const problems = summarizeStderr(stderr);
    if (problems) throw new Error(`mdb-export reported diagnostics for table ${table} (${problems})`);
    result[table] = file;
  }
  return result;
}

export interface ExtractManifest {
  archive: { sha256: string; bytes: number };
  image: string;
  imageId: string;
  mdbtools: string;
  mdbExportFlags: readonly string[];
  tables: Record<string, { rows: number; columns: number; bytes: number }>;
  startedAt: string;
  finishedAt: string;
}

export interface ExtractOptions {
  guard?: ExtractGuard;
  archive: string;
  sha256: string;
  out: string;
}
export interface ExtractGuard {
  beforeWrite(kind: 'expanded' | 'raw' | 'projected', bytes: number): Promise<void>;
  container(name: string, present: boolean): Promise<void>;
}

/**
 * Remove what an interrupted or failed extraction leaves: its staging directory, and the
 * reserved destination unless that already holds the finished extraction. The rename that
 * publishes it can complete before the run records it (a signal handled in between), so the
 * destination's `manifest.json`, written last and absent from the empty reservation, decides.
 */
export function cleanupExtraction(paths: { dest: string; staging: string }, state: { stagingCreated: boolean; published: boolean }): void {
  if (state.stagingCreated) rmSync(paths.staging, { recursive: true, force: true });
  if (!state.published && !existsSync(join(paths.dest, 'manifest.json'))) rmSync(paths.dest, { recursive: true, force: true });
}

/**
 * Verify, unpack, export in the sandbox, project to allowlisted columns, delete the
 * raw export and write manifest.json.
 *
 * All work happens in a private staging directory (`<out>.staging-<random>`, mode
 * 0700) that this invocation creates and exclusively owns; only that directory is
 * ever removed. The destination is reserved with an exclusive mkdir (an existing
 * path is refused) and replaced by one atomic rename of the finished staging
 * directory. Consumers must treat a directory without a valid `manifest.json` as
 * incomplete and reject it.
 */
export async function extractArchive(opts: ExtractOptions): Promise<ExtractManifest> {
  const startedAt = new Date().toISOString();
  const dest = resolve(opts.out);
  const staging = `${dest}.staging-${randomBytes(6).toString('hex')}`;
  await mkdir(dirname(dest), { recursive: true });
  try {
    await mkdir(dest, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('output path already exists; choose a new directory');
    }
    throw e;
  }
  let published = false;
  let stagingCreated = false;
  // The destination is only an empty reservation until the atomic rename. It is
  // safe to release even when a container still needs its mounted staging files.
  const cleanup = (containersGone = true): void => cleanupExtraction(
    { dest, staging }, { stagingCreated: stagingCreated && containersGone, published },
  );
  const onSignal = (sig: NodeJS.Signals): void => {
    beginShutdown();
    void removeAllContainers().then((failures) => {
      cleanup(failures.length === 0);
      for (const f of failures) console.error(opts.guard ? 'import cleanup unresolved' : f);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await mkdir(staging, { mode: 0o700 });
    stagingCreated = true;
    const raw = join(staging, 'raw');
    await mkdir(raw, { mode: 0o700 });
    const archive = await verifyArchive(opts.archive, opts.sha256);
    const imageId = await resolveImageId();
    const mdb = await extractMember(opts.archive, 'avall.mdb', raw, { ...DEFAULT_LIMITS,
      beforeWrite: opts.guard ? n => opts.guard!.beforeWrite('expanded', n) : undefined });
    await prepareMdbMount(mdb);
    const version = await mdbtoolsVersion(mdb, imageId, opts.guard);
    const rawCsv = await runMdbExport(mdb, raw, imageId, opts.guard);
    const tables: ExtractManifest['tables'] = {};
    for (const table of TABLE_NAMES) {
      const target = join(staging, `${table}.csv`);
      const rows = await projectFile(table, rawCsv[table], target,
        opts.guard ? n => opts.guard!.beforeWrite('projected', n) : undefined);
      tables[table] = {
        rows,
        columns: TABLE_SPECS[table].columns.length,
        bytes: (await stat(target)).size,
      };
    }
    // Raw exports include owner/contact columns; never leave them on disk.
    await rm(raw, { recursive: true, force: true });
    const manifest: ExtractManifest = {
      archive,
      image: EXTRACT_IMAGE,
      imageId,
      mdbtools: version,
      mdbExportFlags: MDB_EXPORT_FLAGS,
      tables,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(staging, dest); // replaces the empty reservation atomically
    stagingCreated = false;
    published = true;
    return manifest;
  } catch (err) {
    const failures = await removeAllContainers();
    cleanup(failures.length === 0);
    if (failures.length) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; ${failures.join('; ')}`);
    }
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
