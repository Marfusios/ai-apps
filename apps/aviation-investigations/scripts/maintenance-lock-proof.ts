/** Offline exclusion proof: scratch inode and harmless Node processes, never Docker or a dump. */
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { maintenanceInvocation, maintenanceLock, MAINTENANCE_BUSY_EXIT } from './compose.js';

/** Only these explicit static diagnostics reach the CLI; filesystem errors can contain paths. */
class ProofFailure extends Error {}

export function proofFailureMessage(error: unknown): string {
  return `Maintenance lock proof failed: ${error instanceof ProofFailure ? error.message : 'scratch file setup or cleanup failed'}.`;
}

export async function proveMaintenanceLock(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aircase-lock-proof-'));
  const path = join(dir, 'maintenance.lock');
  let fd: FileHandle | undefined;
  try {
    await chmod(dir, 0o700);
    fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await fd.chmod(0o600); // The caller's umask must not remove required owner permissions.
    const descriptor = fd.fd;
    const lock = maintenanceLock({ AVIATION_MAINTENANCE_LOCK: path, AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '1' })!;
    // Same open-description lock as worker/importer/host.ts: the helper exits but the
    // parent's open descriptor keeps the exclusive flock until that parent releases it.
    const importer = () => spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
    if (importer().status !== 0) throw new ProofFailure('scratch importer lock failed');
    const blocked = maintenanceInvocation(process.execPath, ['-e', 'process.stdout.write("DUMP_STARTED")'], lock);
    const start = performance.now();
    const refused = spawnSync(blocked.command, blocked.args, { encoding: 'utf8', timeout: 5000 });
    if (refused.status !== MAINTENANCE_BUSY_EXIT || refused.stdout !== '' || performance.now() - start < 850) {
      throw new ProofFailure('importer did not exclude the bounded backup command');
    }
    if (spawnSync('flock', ['--unlock', '3'], { stdio: ['ignore', 'ignore', 'ignore', descriptor] }).status !== 0) {
      throw new ProofFailure('scratch importer unlock failed');
    }

    const holding = maintenanceInvocation(process.execPath, ['-e',
      'process.stdout.write("LOCK_HELD\\n"); process.stdin.resume(); process.stdin.once("data", () => process.exit(0)); setTimeout(() => process.exit(1), 8000);',
    ], lock);
    const child = spawn(holding.command, holding.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined); // A failed stand-in may already have closed its pipe.
    const ended = new Promise<number | null>((done) => child.once('close', done));
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new ProofFailure('scratch backup did not acquire the lock')), 5000);
        const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else done(); };
        child.once('error', () => finish(new ProofFailure('scratch backup could not start')));
        child.once('close', () => finish(new ProofFailure('scratch backup exited before the probe')));
        child.stdout.once('data', (b: Buffer) => finish(b.toString() === 'LOCK_HELD\n' ? undefined : new ProofFailure('unexpected scratch output')));
      });
      if (importer().status !== 1) throw new ProofFailure('backup did not exclude the nonqueuing importer');
    } finally {
      child.stdin.end('release\n');
      await ended;
    }
    // A finished backup releases the lock; neither direction left a stuck owner.
    if (importer().status !== 0) throw new ProofFailure('scratch lock was not released');
  } finally {
    try { await fd?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  proveMaintenanceLock().then(
    () => console.log('Maintenance lock proof passed: importer blocks backup; backup blocks importer; lock releases.'),
    (error: unknown) => { console.error(proofFailureMessage(error)); process.exitCode = 1; },
  );
}
