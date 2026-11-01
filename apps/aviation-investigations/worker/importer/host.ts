import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ImportFailure,
  IMPORT_STEPS,
  IMPORT_RESULTS,
  IMPORT_REASONS,
  safeLog,
  safeFailure,
  sourceReminder,
} from './contracts.js';
import { readImporterConfig, type ImporterConfig } from './config.js';
import { inBackupWindow } from './status.js';
import { ManagedSpace, privateDirectory } from './files.js';
import { recoverExtraction } from './extraction.js';
import { workerIdentity } from './application.js';
import { classify } from './failure.js';
import { FactMessageSchema, readHostFacts } from './facts.js';

/**
 * flock on the inherited open file description: the parent retains it after the helper exits.
 * The release command supplies a fresh environment and create=false for read-only dry-run checks.
 */
export async function hostLock(path: string, env?: NodeJS.ProcessEnv, create = true): Promise<FileHandle> {
  const fd = await open(path, (create ? constants.O_CREAT : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new ImportFailure('configuration');
    const code = await new Promise<number | null>((done, reject) => {
      const p = spawn('flock', ['--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd.fd],
        ...(env ? { env } : {}),
      });
      p.once('error', reject);
      p.once('close', done);
    });
    if (code !== 0) throw new ImportFailure('busy', false);
    return fd;
  } catch (e) {
    await fd.close();
    throw e;
  }
}
/** No pass-through stream: SDK/SQL/MDB/HTML diagnostics never become journal messages. */
export function journalLine(line: string): string | null {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (
      Object.keys(v).sort().join(',') !== 'reason,result,step' ||
      !IMPORT_STEPS.includes(v.step as never) ||
      !IMPORT_RESULTS.includes(v.result as never) ||
      (v.reason !== null && !IMPORT_REASONS.includes(v.reason as never))
    )
      return null;
    return safeLog(v.step as never, v.result as never, v.reason as never);
  } catch {
    return null;
  }
}
/** The production IPC handler, shared with the real child-process regression harness. */
export function serveChildFacts(
  child: ChildProcess,
  config: ImporterConfig,
  ownEnvironment: string | undefined,
): void {
  let factsPending = false;
  child.on('message', (raw: unknown) => {
    const parsed = FactMessageSchema.safeParse(raw);
    if (!parsed.success || factsPending || parsed.data.request.environment === ownEnvironment)
      return;
    const message = parsed.data;
    factsPending = true;
    void readHostFacts(config, message.request)
      .then(
        (value) => {
          if (child.connected)
            child.send({ type: 'import-facts-reply', id: message.id, ok: true, value }, () => {});
        },
        () => {
          if (child.connected)
            child.send({ type: 'import-facts-reply', id: message.id, ok: false }, () => {});
        },
      )
      .finally(() => {
        factsPending = false;
      });
  });
}

export async function boundedChild(
  args: string[],
  deadline: number,
  locks: readonly FileHandle[],
  config: ImporterConfig,
): Promise<number> {
  return new Promise<number>((done) => {
    const names = [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'TZ',
      'TMPDIR',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'XDG_RUNTIME_DIR',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
    ];
    const environment = Object.fromEntries(
      names.filter((n) => Boolean(process.env[n])).map((n) => [n, process.env[n]!]),
    ) as NodeJS.ProcessEnv;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), ...args],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', locks[0]!.fd, locks[1]!.fd, 'ipc'],
        env: {
          ...environment,
          AVIATION_TRACING_ENABLED: 'false',
          OTEL_SDK_DISABLED: 'true',
          NODE_OPTIONS: '--max-old-space-size=4096',
          AIRCASE_IMPORT_DEADLINE: String(deadline),
        },
      },
    );
    let pending = '',
      total = 0,
      timedOut = false;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* already gone */
        }
    };
    const stop = () => {
      timedOut = true;
      kill('SIGTERM');
    };
    const soft = setTimeout(stop, Math.max(1, deadline - Date.now() - 120_000));
    const hard = setTimeout(() => kill('SIGKILL'), Math.max(1, deadline - Date.now() - 90_000));
    const onSignal = () => stop();
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    child.stdout!.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        stop();
        return;
      }
      pending += chunk.toString('utf8');
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.length <= 2048) {
          const safe = journalLine(line);
          if (safe) process.stdout.write(`${safe}\n`);
        }
      }
      if (pending.length > 8192) {
        pending = '';
        stop();
      }
    });
    child.stderr!.on('data', () => {});
    const ownEnvironment = args[args.indexOf('--env') + 1];
    serveChildFacts(child, config, ownEnvironment);
    const finish = (code: number | null) => {
      clearTimeout(soft);
      clearTimeout(hard);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      done(timedOut ? 124 : (code ?? 1));
    };
    child.once('error', () => finish(1));
    child.once('close', finish);
  });
}
async function main(args: string[], deadline: number): Promise<number> {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      env: { type: 'string' },
      'cache-only': { type: 'boolean' },
      'no-change': { type: 'boolean' },
      'forced-dev': { type: 'boolean' },
      'seed-archive': { type: 'string' },
      sha256: { type: 'string' },
      'seed-advertised-at': { type: 'string' },
      approval: { type: 'string' },
      artifact: { type: 'string' },
      'publication-sha256': { type: 'string' },
      run: { type: 'string' },
      'evidence-sha256': { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  if (
    !values.config ||
    positionals.length !== 1 ||
    ![
      'run',
      'cycle',
      'approve',
      'rollback',
      'recertify',
      'rebaseline',
      'acknowledge-preartifact',
    ].includes(positionals[0]!)
  ) {
    throw new ImportFailure('configuration');
  }
  const config = await readImporterConfig(values.config),
    command = positionals[0];
  const reminder = sourceReminder(new Date());
  if (reminder) process.stdout.write(`${reminder}\n`);
  if (inBackupWindow(new Date())) throw new ImportFailure('backup_window', false);
  if (command === 'cycle' && (!config.schedule.enabled || !config.installation))
    throw new ImportFailure('configuration');
  const locks: FileHandle[] = [];
  const space = new ManagedSpace(config.root);
  try {
    locks.push(await hostLock(config.hostLock));
    locks.push(await hostLock(config.maintenanceLock));
    await workerIdentity(config.code, resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
    await privateDirectory(config.root);
    await space.check();
    if (command !== 'acknowledge-preartifact') await recoverExtraction(space);
    try {
      if (command !== 'cycle') return await boundedChild(args, deadline, locks, config);
      const common = [
        'run',
        '--config',
        values.config,
        ...(values['cache-only'] ? ['--cache-only'] : []),
      ];
      const dev = await boundedChild([...common, '--env', 'dev'], deadline, locks, config);
      if (dev !== 0) {
        process.stdout.write(`${safeLog('check', 'skipped_dev_failed', 'dev_failed')}\n`);
        if (config.live && deadline - Date.now() > 180_000)
          await boundedChild(
            ['record-skip', '--config', values.config, '--env', 'live'],
            deadline,
            locks,
            config,
          );
        return dev;
      }
      return config.live
        ? await boundedChild([...common, '--env', 'live'], deadline, locks, config)
        : 0;
    } finally {
      if (command !== 'acknowledge-preartifact') await recoverExtraction(space);
    }
  } finally {
    for (const lock of locks.reverse()) await lock.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Includes lock acquisition, recovery, both environments and final daemon cleanup.
  const deadline = Date.now() + 3 * 3_600_000;
  const final = setTimeout(() => {
    process.stderr.write(`${safeLog('cleanup', 'cancelled', 'timeout')}\n`);
    process.exit(124);
  }, 3 * 3_600_000);
  main(process.argv.slice(2), deadline)
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        const failure = classify(error);
        process.stderr.write(`${safeLog('check', failure.result, failure.reason)}\n`);
        process.exitCode = 1;
      },
    )
    .finally(() => clearTimeout(final));
}
