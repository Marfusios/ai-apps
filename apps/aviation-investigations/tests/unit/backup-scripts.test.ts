/**
 * The backup and restore scripts (docker/postgres) never put a credential in a process's
 * arguments, which every local user can read (Task 22 fix round 2: gate finding 2,
 * re-review N3). They run here with fake PostgreSQL tools that record their arguments,
 * their environment and the libpq service file they were given.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const APP_DIR = resolve(import.meta.dirname, '../..');
const SECRET = 'S3cretDummyPassw0rd';
const URL = `postgresql://aviation_test_migrator:${SECRET}@db.invalid:6543/aviation_test?options=-c%20role%3Daviation_migrator&application_name=aviation-backup`;

/** Records the call; `pg_dump` writes its --file, `psql` answers the emptiness query or reads the restore stream. */
const RECORD = `#!/bin/bash
{
  printf 'tool=%s\\n' "$(basename "$0")"
  printf 'argv=%s\\n' "$*"
  printf 'env_url=%s\\n' "\${DATABASE_MIGRATOR_URL:-}"
  printf 'service=%s mode=%s file=%s\\n' "\${PGSERVICE:-}" "$(stat -c %a "\${PGSERVICEFILE:-/nonexistent}" 2>/dev/null)" "\${PGSERVICEFILE:-}"
  if [ -f "\${PGSERVICEFILE:-/nonexistent}" ]; then sed 's/^/conf: /' "$PGSERVICEFILE"; fi
} >> "$FAKE_LOG"
`;
const TOOLS: Record<string, string> = {
  pg_dump: `${RECORD}out=""
while [ $# -gt 0 ]; do case "$1" in --file) out=$2; shift;; esac; shift; done
if [ -n "$out" ]; then echo dump > "$out"; fi
exit \${FAKE_EXIT:-0}
`,
  psql: `${RECORD}case " $* " in
  *" -c "*) echo 0 ;;
  *) cat > "$FAKE_STDIN" ;;
esac
exit \${FAKE_EXIT:-0}
`,
  pg_restore: `${RECORD}case " $* " in
  *" --list "*) printf '1; 2615 16 SCHEMA - drizzle aviation_migrator\\n2; 1259 17 TABLE public t aviation_migrator\\n' ;;
  *) echo 'CREATE TABLE t ();' ;;
esac
exit \${FAKE_EXIT:-0}
`,
};

let dir: string;
let backups: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aviation-backup-scripts-'));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of Object.entries(TOOLS)) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  backups = join(dir, 'backups');
  mkdirSync(backups);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(script: 'backup.sh' | 'restore.sh', args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [resolve(APP_DIR, 'docker/postgres', script), ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      DATABASE_MIGRATOR_URL: URL,
      APP_ENV: 'test',
      AVIATION_BACKUP_MOUNT: backups,
      FAKE_LOG: join(dir, 'calls.log'),
      FAKE_STDIN: join(dir, 'stdin.sql'),
      ...env,
    },
  });
  const log = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log };
}

/** The service files the tools were given (to check they are gone afterwards). */
const serviceFiles = (log: string) => [...log.matchAll(/ file=(\S+)/g)].map((m) => m[1]!).filter(Boolean);

function expectNoSecretInArgs(log: string): void {
  const argv = log.split('\n').filter((l) => l.startsWith('argv='));
  expect(argv.length).toBeGreaterThan(0);
  for (const line of argv) {
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('postgres');
  }
  // Nor in the tools' environment: the URL is unset once the service file exists.
  for (const line of log.split('\n').filter((l) => l.startsWith('env_url='))) expect(line).toBe('env_url=');
}

function expectServiceFile(log: string): void {
  expect(log).toMatch(/^service=aviation mode=600 file=\S+pg_service\.conf$/m);
  for (const conf of ['[aviation]', 'host=db.invalid', 'port=6543', 'dbname=aviation_test', 'user=aviation_test_migrator', `password=${SECRET}`, 'options=-c role=aviation_migrator', 'application_name=aviation-backup']) {
    expect(log).toContain(`conf: ${conf}\n`);
  }
}

describe('backup.sh', () => {
  it('dumps through a private service file: no credential in any argument, the file gone afterwards', () => {
    const r = run('backup.sh', []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^backup written: aviation_test-\d{4}-\d{2}-\d{2}T\d{6}Z\.dump$/m);
    expectNoSecretInArgs(r.log);
    expectServiceFile(r.log);
    for (const f of serviceFiles(r.log)) expect(existsSync(f), f).toBe(false);
    expect(readdirSync(backups).filter((f) => f.endsWith('.dump'))).toHaveLength(1);
  });

  it('a failed dump removes the service file and the partial dump', () => {
    const r = run('backup.sh', [], { FAKE_EXIT: '1' });
    expect(r.status).not.toBe(0);
    expectNoSecretInArgs(r.log);
    for (const f of serviceFiles(r.log)) expect(existsSync(f), f).toBe(false);
    expect(readdirSync(backups)).toEqual([]);
  });

  it('refuses a URL it cannot turn into a service file, without echoing it', () => {
    const r = run('backup.sh', [], { DATABASE_MIGRATOR_URL: `mysql://u:${SECRET}@h/db` });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toContain(SECRET);
    expect(r.log).toBe('');
  });
});

describe('restore.sh', () => {
  it('restores through a private service file: no credential in any argument, the file gone afterwards', () => {
    writeFileSync(join(backups, 'aviation_test-2026-10-24T031500Z.dump'), 'dump');
    const r = run('restore.sh', ['aviation_test-2026-10-24T031500Z.dump']);
    expect(r.status, r.stderr).toBe(0);
    expectNoSecretInArgs(r.log);
    expectServiceFile(r.log);
    for (const f of serviceFiles(r.log)) expect(existsSync(f), f).toBe(false);
    // One transaction: the dump, then the restore record and the hold, then COMMIT.
    const stream = readFileSync(join(dir, 'stdin.sql'), 'utf8');
    expect(stream.indexOf('BEGIN;')).toBe(0);
    expect(stream).toMatch(/CREATE TABLE t \(\);\nSET LOCAL aviation\.restored_from = 'aviation_test-2026-10-24T031500Z\.dump';\n[\s\S]*INSERT INTO drizzle\.restores[\s\S]*\nCOMMIT;\n$/);
  });

  it('a failed restore removes the service file and never sends COMMIT', () => {
    writeFileSync(join(backups, 'aviation_test-2026-10-24T031500Z.dump'), 'dump');
    // pg_restore fails producing the SQL: the stream ends without COMMIT.
    const failing = `${RECORD}case " $* " in *" --list "*) echo '1; 1259 17 TABLE public t aviation_migrator' ;; *) echo 'CREATE TABLE t ();'; exit 1 ;; esac\n`;
    writeFileSync(join(dir, 'bin', 'pg_restore'), failing);
    const r = run('restore.sh', ['aviation_test-2026-10-24T031500Z.dump']);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(dir, 'stdin.sql'), 'utf8')).not.toContain('COMMIT');
    for (const f of serviceFiles(r.log)) expect(existsSync(f), f).toBe(false);
  });
});
