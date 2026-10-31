/** Offline exclusion proof: scratch inode and harmless Node processes, never Docker or a dump. */
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { maintenanceInvocation, maintenanceLock, MAINTENANCE_BUSY_EXIT } from './compose.js';

export async function proveMaintenanceLock(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aircase-lock-proof-'));
  const path = join(dir, 'maintenance.lock');
  const fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const lock = maintenanceLock({ AVIATION_MAINTENANCE_LOCK: path, AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS: '1' })!;
    // Same open-description lock as worker/importer/host.ts: the helper exits but the
    // parent's open descriptor keeps the exclusive flock until that parent releases it.
    const importer = () => spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd.fd] });
    if (importer().status !== 0) throw new Error('scratch importer lock failed');
    const blocked = maintenanceInvocation(process.execPath, ['-e', 'process.stdout.write("DUMP_STARTED")'], lock);
    const start = performance.now();
    const refused = spawnSync(blocked.command, blocked.args, { encoding: 'utf8', timeout: 5000 });
    if (refused.status !== MAINTENANCE_BUSY_EXIT || refused.stdout !== '' || performance.now() - start < 850) {
      throw new Error('importer did not exclude the bounded backup command');
    }
    if (spawnSync('flock', ['--unlock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd.fd] }).status !== 0) {
      throw new Error('scratch importer unlock failed');
    }

    const holding = maintenanceInvocation(process.execPath, ['-e',
      'process.stdout.write("LOCK_HELD\\n"); process.stdin.resume(); process.stdin.once("data", () => process.exit(0)); setTimeout(() => process.exit(1), 8000);',
    ], lock);
    const child = spawn(holding.command, holding.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined); // A failed stand-in may already have closed its pipe.
    const ended = new Promise<number | null>((done) => child.once('close', done));
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('scratch backup did not acquire the lock')), 5000);
        const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : done(); };
        child.once('error', () => finish(new Error('scratch backup could not start')));
        child.once('close', () => finish(new Error('scratch backup exited before the probe')));
        child.stdout.once('data', (b: Buffer) => finish(b.toString() === 'LOCK_HELD\n' ? undefined : new Error('unexpected scratch output')));
      });
      if (importer().status !== 1) throw new Error('backup did not exclude the nonqueuing importer');
    } finally {
      child.stdin.end('release\n');
      await ended;
    }
    // A finished backup releases the lock; neither direction left a stuck owner.
    if (importer().status !== 0) throw new Error('scratch lock was not released');
  } finally {
    await fd.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  proveMaintenanceLock().then(
    () => console.log('Maintenance lock proof passed: importer blocks backup; backup blocks importer; lock releases.'),
    () => { console.error('Maintenance lock proof failed.'); process.exitCode = 1; },
  );
}
