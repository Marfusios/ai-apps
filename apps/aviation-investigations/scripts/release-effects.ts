import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readImporterConfig } from '../worker/importer/config.js';
import { hostLock } from '../worker/importer/host.js';
import { atomicPrivateReplace, privateLogDirectory, readPrivateFile, ReleaseError, validateLogDirectory, validatePrivateParent } from './release-config.js';
import { importerChildEnvironment, type Command, type CommandResult, type ReleaseEffects } from './release-runner.js';

const OUTPUT_LIMIT = 16 * 1024 * 1024;
async function openLog(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const s = await file.stat();
  if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1) {
    await file.close();
    throw new ReleaseError(1, 'step log must be a private regular file');
  }
  return file;
}

/** No shell and no inherited environment. Raw child diagnostics have only a private file destination. */
export async function runReleaseChild(spec: Command, signal?: AbortSignal, forceSignal?: AbortSignal): Promise<CommandResult> {
  const log = spec.log ? await openLog(spec.log) : undefined;
  try {
    if (signal?.aborted || forceSignal?.aborted) throw new ReleaseError(1, 'release interrupted');
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd, env: spec.env, detached: true,
        stdio: ['ignore', 'pipe', 'pipe', ...spec.locks.map((lock) => lock.fd)],
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, failure = false, closed = false, writes = Promise.resolve();
      const pending = { stdout: '', stderr: '' };
      let hard: ReturnType<typeof setTimeout> | undefined;
      const kill = (name: NodeJS.Signals) => {
        if (child.pid) try { process.kill(-child.pid, name); } catch { /* already ended */ }
      };
      const stop = () => {
        if (failure) return;
        failure = true;
        if (closed) return;
        kill('SIGTERM');
        hard = setTimeout(() => kill('SIGKILL'), 5000);
      };
      const force = () => {
        failure = true;
        if (!closed) kill('SIGKILL');
      };
      const timeout = setTimeout(stop, spec.timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      forceSignal?.addEventListener('abort', force, { once: true });
      const receive = (chunk: Buffer, stream: Buffer[], name: 'stdout' | 'stderr') => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) { stop(); return; }
        stream.push(chunk);
        if (log) writes = writes.then(() => log.writeFile(chunk)).catch(() => { stop(); });
        if (spec.importerLine) {
          pending[name] += chunk.toString('utf8');
          let newline: number;
          while ((newline = pending[name].indexOf('\n')) >= 0) {
            spec.importerLine(pending[name].slice(0, newline));
            pending[name] = pending[name].slice(newline + 1);
          }
        }
      };
      child.stdout!.on('data', (chunk: Buffer) => receive(chunk, stdout, 'stdout'));
      child.stderr!.on('data', (chunk: Buffer) => receive(chunk, stderr, 'stderr'));
      child.once('error', () => { failure = true; });
      child.once('close', (code) => {
        closed = true;
        if (failure) kill('SIGKILL');
        clearTimeout(timeout);
        signal?.removeEventListener('abort', stop);
        forceSignal?.removeEventListener('abort', force);
        if (hard) clearTimeout(hard);
        void writes.then(async () => {
          for (const line of Object.values(pending)) if (line) spec.importerLine?.(line);
          if (log) await log.sync();
          resolve({ code: failure ? 1 : code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
        }).catch(() => reject(new ReleaseError(1, 'private step log failed')));
      });
    });
  } finally { await log?.close(); }
}

export function releaseEffects(signal?: AbortSignal, forceSignal?: AbortSignal): ReleaseEffects {
  const PATH = process.env.PATH, HOME = process.env.HOME;
  if (!PATH || !HOME) throw new ReleaseError(2, 'PATH and HOME must be set');
  return {
    ownCheckout: fileURLToPath(new URL('../../..', import.meta.url)),
    environment: { PATH, HOME }, importerEnvironment: importerChildEnvironment({ PATH, HOME }, process.env), signal,
    now: () => new Date(), realpath,
    readPrivate: readPrivateFile, readImporter: readImporterConfig,
    lock: (path, env) => hostLock(path, env, false),
    validateParent: validatePrivateParent, validateLogs: validateLogDirectory,
    prepareLogs: privateLogDirectory,
    async log(path, bytes) {
      const file = await openLog(path);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    },
    replace: atomicPrivateReplace,
    run: (spec) => runReleaseChild(spec, signal, forceSignal),
    async httpStatus(url, timeoutMs) {
      const response = await fetch(url, {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'AirCase-release/1.0' },
      });
      await response.body?.cancel();
      return response.status;
    },
    sleep: (ms) => delay(ms, undefined, { signal }),
    print: (line) => process.stdout.write(`${line}\n`),
  };
}
