import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_LIMITS, extractMember, verifyArchive } from './archive.js';
import { TABLE_NAMES, TABLE_SPECS, projectFile, type TableName } from './tables.js';

export const EXTRACT_IMAGE = 'aviation-extract:mdbtools-1.0.0';
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

/** mdb-export options: unambiguous ISO-8601 dates, RFC 4180 quoting (quotes doubled). */
export const MDB_EXPORT_FLAGS = [
  '-D', '%Y-%m-%d',
  '-T', '%Y-%m-%dT%H:%M:%S',
  '-q', '"',
  '-X', '"',
] as const;

/** Sandbox for every container run. The root is read-only and nothing is writable. */
export const SANDBOX_FLAGS = [
  '--rm',
  '--network', 'none',
  '--read-only',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--user', '65534:65534',
  '--memory', '1g',
  '--cpus', '2',
  '--pids-limit', '64',
] as const;

const SAFE_TABLE = /^[a-z_]+$/;

interface ContainerResult {
  stderr: string;
}

/** Run one sandboxed container with an argument array (no shell); stdout goes to `sink` if given. */
function runContainer(
  mounts: readonly string[],
  command: readonly string[],
  sink: NodeJS.WritableStream | null,
  timeoutMs: number,
): Promise<ContainerResult> {
  const name = `aviation-extract-${randomBytes(6).toString('hex')}`;
  const args = ['run', '--name', name, ...SANDBOX_FLAGS, ...mounts, EXTRACT_IMAGE, ...command];
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4096) stderr += d.toString('utf8');
    });
    const done = sink ? pipeline(child.stdout, sink) : (child.stdout.resume(), Promise.resolve());
    done.catch(() => undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => undefined);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done.then(
        () => {
          if (timedOut) reject(new Error(`container timed out after ${timeoutMs} ms`));
          else if (code !== 0) reject(new Error(`container exited with ${code}: ${stderr.trim()}`));
          else resolvePromise({ stderr });
        },
        reject,
      );
    });
  });
}

function mdbMount(mdbPath: string): string[] {
  return ['-v', `${resolve(mdbPath)}:/in/avall.mdb:ro`];
}

export async function mdbtoolsVersion(mdbPath: string): Promise<string> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  await runContainer(mdbMount(mdbPath), ['mdb-export', '--version'], sink, 60_000);
  const text = Buffer.concat(chunks).toString('utf8');
  const m = /(\d+\.\d+\.\d+\S*)/.exec(text);
  if (!m?.[1]) throw new Error('cannot determine mdbtools version');
  return m[1];
}

/**
 * Export every allowlisted table as raw CSV into `outDir/<table>.csv`. The container
 * has no network, a read-only root, no writable mounts and no capabilities: the
 * host process streams its stdout into the file, so the output directory is never
 * exposed to the container. Table names come only from the constant allowlist.
 */
export async function runMdbExport(mdbPath: string, outDir: string): Promise<Record<TableName, string>> {
  const result = {} as Record<TableName, string>;
  for (const table of TABLE_NAMES) {
    if (!SAFE_TABLE.test(table)) throw new Error('invalid table name');
    const file = join(outDir, `${table}.csv`);
    const sink = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    await runContainer(
      mdbMount(mdbPath),
      ['mdb-export', ...MDB_EXPORT_FLAGS, '/in/avall.mdb', table],
      sink,
      EXPORT_TIMEOUT_MS,
    );
    result[table] = file;
  }
  return result;
}

export interface ExtractManifest {
  archive: { sha256: string; bytes: number };
  image: string;
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
 * raw export, and write manifest.json. Returns the manifest.
 */
export async function extractArchive(opts: ExtractOptions): Promise<ExtractManifest> {
  const startedAt = new Date().toISOString();
  const out = resolve(opts.out);
  const raw = join(out, 'raw');
  const archive = await verifyArchive(opts.archive, opts.sha256);
  await mkdir(raw, { recursive: true, mode: 0o755 });
  await chmod(raw, 0o755);
  try {
    const mdb = await extractMember(opts.archive, 'avall.mdb', raw, DEFAULT_LIMITS);
    const version = await mdbtoolsVersion(mdb);
    const rawCsv = await runMdbExport(mdb, raw);
    const tables: ExtractManifest['tables'] = {};
    for (const table of TABLE_NAMES) {
      const target = join(out, `${table}.csv`);
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
      mdbtools: version,
      mdbExportFlags: MDB_EXPORT_FLAGS,
      tables,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } catch (err) {
    await rm(raw, { recursive: true, force: true });
    throw err;
  }
}

