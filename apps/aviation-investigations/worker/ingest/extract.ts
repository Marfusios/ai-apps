import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_LIMITS, extractMember, verifyArchive } from './archive.js';
import { TABLE_NAMES, TABLE_SPECS, projectFile, type TableName } from './tables.js';

export const EXTRACT_IMAGE = 'aviation-extract:mdbtools-1.0.0';
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
/** Per-table cap on bytes accepted from the container's stdout. */
export const MAX_TABLE_BYTES = 2 * 1024 * 1024 * 1024;
/** Bound for every `docker rm -f` / `docker image inspect` call. */
export const DOCKER_CALL_TIMEOUT_MS = 15_000;

/** mdb-export options: unambiguous ISO-8601 dates, RFC 4180 quoting (quotes doubled). */
export const MDB_EXPORT_FLAGS = [
  '-D', '%Y-%m-%d',
  '-T', '%Y-%m-%dT%H:%M:%S',
  '-q', '"',
  '-X', '"',
] as const;

/** Sandbox for every container (removal is explicit, never `--rm`). The root is read-only and nothing is writable. */
export const SANDBOX_FLAGS = [
  '--network', 'none',
  '--read-only',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--user', '65534:65534',
  '--memory', '1g',
  '--cpus', '2',
  '--pids-limit', '64',
] as const;

/**
 * Stderr lines from mdb-export that were investigated and are known to be harmless.
 * Empty on purpose: any other stderr output fails the export (mdbtools can print
 * page-read or memo errors and still exit 0).
 */
export const BENIGN_STDERR: readonly RegExp[] = [];

const SAFE_TABLE = /^[a-z_]+$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

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
      resolvePromise({ code: null, stdout, stderr: stderr || e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
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

interface Live {
  name: string;
  id: string | null;
  child: ChildProcess | null;
  creating: Promise<DockerResult> | null;
  cleanup: Promise<void> | null;
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

/**
 * One memoised cancellation and removal path per container. Kills the client, waits
 * for an in-flight `docker create` to finish, then removes the returned ID. If the
 * creation outcome is uncertain it fails (the identity stays tracked); it never
 * reports success without a confirmed removal.
 */
function ensureCleanup(entry: Live): Promise<void> {
  entry.cleanup ??= (async () => {
    entry.child?.kill('SIGKILL');
    const created = await entry.creating;
    if (!entry.id && created && created.code !== 0 && !created.timedOut) return; // creation definitively failed
    if (!entry.id) {
      await dockerCall(['rm', '-f', entry.name]).catch(() => undefined); // best effort by name
      throw new Error(`creation of container ${entry.name} is uncertain; check "docker ps -a"`);
    }
    await forceRemove(entry.id);
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
  image: string;
  mounts: readonly string[];
  command: readonly string[];
  sink: NodeJS.WritableStream | null;
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
        cb(null, chunk);
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
 * output-cap breach, stream failure and signals all go through the same cleanup.
 */
export async function runContainer(run: ContainerRun): Promise<{ stderr: string }> {
  if (terminating) throw new Error('cancelled by signal');
  const name = `aviation-extract-${randomBytes(6).toString('hex')}`;
  const entry: Live = { name, id: null, child: null, creating: null, cleanup: null };
  live.set(name, entry);
  let failure: Error | null = null;
  const abort = (e: Error): void => {
    if (failure) return;
    failure = e;
    void ensureCleanup(entry).catch(() => undefined);
  };
  const timer = setTimeout(() => abort(new Error(`container timed out after ${run.timeoutMs} ms`)), run.timeoutMs);
  let code: number | null = null;
  let stderr = '';
  let started = false;
  try {
    entry.creating = dockerCall(
      ['create', '--name', name, ...SANDBOX_FLAGS, ...run.mounts, run.image, ...run.command],
      DOCKER_CALL_TIMEOUT_MS,
    );
    const created = await entry.creating;
    const id = created.stdout.trim();
    if (created.code === 0 && CONTAINER_ID.test(id)) entry.id = id;
    if (entry.id && !failure && !terminating) {
      started = true;
      ({ code, stderr } = await startAttached(entry, run, abort));
    } else if (!entry.id) {
      abort(new Error(`docker create failed (${created.timedOut ? 'timed out' : `exit ${String(created.code)}`})`));
    }
  } catch (e) {
    abort(e instanceof Error ? e : new Error(String(e)));
  }
  clearTimeout(timer);
  if (!started) (run.sink as Writable | null)?.destroy?.();
  let cleanupError = '';
  try {
    await ensureCleanup(entry);
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

/** Resolve the local image once; every container then runs against this immutable ID. */
export async function resolveImageId(image = EXTRACT_IMAGE): Promise<string> {
  const r = await dockerCall(['image', 'inspect', '--format', '{{.Id}}', image]);
  const id = r.stdout.trim();
  if (r.code !== 0 || !IMAGE_ID.test(id)) {
    throw new Error(`cannot resolve image ${image}; run "pnpm extract:image" first`);
  }
  return id;
}

export async function mdbtoolsVersion(mdbPath: string, imageId?: string): Promise<string> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  await runContainer({
    image: imageId ?? (await resolveImageId()),
    mounts: mdbMount(mdbPath),
    command: ['mdb-export', '--version'],
    sink,
    timeoutMs: 60_000,
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
): Promise<Record<TableName, string>> {
  const image = imageId ?? (await resolveImageId());
  const result = {} as Record<TableName, string>;
  for (const table of TABLE_NAMES) {
    if (!SAFE_TABLE.test(table)) throw new Error('invalid table name');
    const file = join(outDir, `${table}.csv`);
    const { stderr } = await runContainer({
      image,
      mounts: mdbMount(mdbPath),
      command: ['mdb-export', ...MDB_EXPORT_FLAGS, '/in/avall.mdb', table],
      sink: createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      timeoutMs: EXPORT_TIMEOUT_MS,
      maxBytes: MAX_TABLE_BYTES,
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
  archive: string;
  sha256: string;
  out: string;
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
  const cleanup = (): void => {
    if (stagingCreated) rmSync(staging, { recursive: true, force: true });
    if (!published) rmSync(dest, { recursive: true, force: true });
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    beginShutdown();
    void removeAllContainers().then((failures) => {
      cleanup();
      for (const f of failures) console.error(f);
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
    const mdb = await extractMember(opts.archive, 'avall.mdb', raw, DEFAULT_LIMITS);
    const version = await mdbtoolsVersion(mdb, imageId);
    const rawCsv = await runMdbExport(mdb, raw, imageId);
    const tables: ExtractManifest['tables'] = {};
    for (const table of TABLE_NAMES) {
      const target = join(staging, `${table}.csv`);
      const rows = await projectFile(table, rawCsv[table], target);
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
    published = true;
    return manifest;
  } catch (err) {
    const failures = await removeAllContainers();
    cleanup();
    if (failures.length) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; ${failures.join('; ')}`);
    }
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
