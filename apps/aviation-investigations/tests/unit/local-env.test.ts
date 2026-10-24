/**
 * The ignored .env.local holds every local secret (scripts/local-env.ts). Rewriting it must
 * be atomic: an interrupted write leaves the previous file, never a truncated one (ops review
 * O12, data review D-M7; the shared connection files already work this way).
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeEnvFile } from '../../scripts/local-env.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aviation-local-env-'));
  file = join(dir, '.env.local');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeEnvFile', () => {
  it('sets and replaces variables, keeps the others, and leaves the file readable by its owner only', () => {
    writeFileSync(file, '# local\nA=1\nB=2\n', { mode: 0o644 });
    writeEnvFile(file, { B: '3', C: '4' });
    expect(readFileSync(file, 'utf8')).toBe('# local\nA=1\nB=3\nC=4\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeEnvFile(join(dir, 'new.env'), { X: 'y' });
    expect(readFileSync(join(dir, 'new.env'), 'utf8')).toBe('X=y\n');
    expect(statSync(join(dir, 'new.env')).mode & 0o777).toBe(0o600);
  });

  it('an interrupted write leaves the previous file whole and no temporary file behind', () => {
    writeFileSync(file, 'A=1\nB=2\n', { mode: 0o600 });
    expect(() =>
      writeEnvFile(file, { B: '3' }, {
        afterWrite: () => {
          throw new Error('interrupted');
        },
      }),
    ).toThrow('interrupted');
    expect(readFileSync(file, 'utf8')).toBe('A=1\nB=2\n');
    expect(readdirSync(dir)).toEqual(['.env.local']);
  });

  it('replaces the file by renaming a complete copy, never by writing into it', () => {
    writeFileSync(file, 'A=1\n', { mode: 0o600 });
    const before = statSync(file).ino;
    // A read-only file can be replaced but not written into.
    chmodSync(file, 0o400);
    writeEnvFile(file, { A: '2' });
    expect(readFileSync(file, 'utf8')).toBe('A=2\n');
    expect(statSync(file).ino).not.toBe(before);
  });
});
