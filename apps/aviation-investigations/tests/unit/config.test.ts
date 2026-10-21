import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aviation-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe('readDotenvAllowlisted', () => {
  it('reads only allowlisted names', () => {
    const p = file('a.env', 'A=1\nB=2\n');
    expect(readDotenvAllowlisted(p, ['A'])).toEqual({ A: '1' });
  });

  it('does not execute shell syntax', () => {
    const marker = join(dir, 'x');
    const p = file('a.env', `A=$(touch ${marker})\n`);
    const out = readDotenvAllowlisted(p, ['A']);
    expect(out.A).toBe(`$(touch ${marker})`);
    expect(existsSync(marker)).toBe(false);
  });

  it('handles quotes, comments, export and empty values', () => {
    const p = file(
      'a.env',
      ['# c', 'export A="x y"', "B='z'", 'C=v # trailing', 'D=', 'E="a#b"'].join('\n'),
    );
    expect(readDotenvAllowlisted(p, ['A', 'B', 'C', 'D', 'E'])).toEqual({
      A: 'x y',
      B: 'z',
      C: 'v',
      E: 'a#b',
    });
  });

  it('throws for a missing file', () => {
    expect(() => readDotenvAllowlisted(join(dir, 'nope'), ['A'])).toThrow();
  });
});

describe('loadConfig', () => {
  it('process env wins over file', () => {
    const p = file('a.env', 'DATABASE_URL=postgres://file\n');
    const c = loadConfig({ env: { DATABASE_URL: 'postgres://env' }, files: [p] });
    expect(c.databaseUrl).toBe('postgres://env');
  });

  it('empty process value does not block file value', () => {
    const p = file('a.env', 'DATABASE_URL=postgres://file\n');
    const c = loadConfig({ env: { DATABASE_URL: '' }, files: [p] });
    expect(c.databaseUrl).toBe('postgres://file');
  });

  it('earlier files take priority', () => {
    const a = file('a.env', 'PORT=4000\n');
    const b = file('b.env', 'PORT=5000\nAPP_URL=http://b\n');
    const c = loadConfig({ env: {}, files: [a, b] });
    expect(c.port).toBe(4000);
    expect(c.appUrl).toBe('http://b');
  });

  it('reads files from AVIATION_ENV_FILES', () => {
    const a = file('a.env', 'DATABASE_URL=postgres://listed\n');
    const c = loadConfig({ env: { AVIATION_ENV_FILES: a } });
    expect(c.databaseUrl).toBe('postgres://listed');
  });

  it('rejects fake provider outside test', () => {
    expect(() =>
      loadConfig({ env: { NODE_ENV: 'production', AI_LLM_PROVIDER: 'fake' }, files: [] }),
    ).toThrow();
    const c = loadConfig({ env: { NODE_ENV: 'test', AI_LLM_PROVIDER: 'fake' }, files: [] });
    expect(c.ai.llmProvider).toBe('fake');
  });

  it('budget defaults', () => {
    const c = loadConfig({ env: {}, files: [] });
    expect(c.ai.budgets).toEqual({
      monthlyUsd: 100,
      interactiveMonthlyUsd: 80,
      interactiveDailyUsd: 3,
      ingestionMonthlyUsd: 20,
      anonymousShare: 0.25,
    });
    expect(c.ai.limits).toEqual({
      anonymousTrialRequests: 3,
      newAccountDailyRequests: 5,
      newAccountDays: 3,
      userDailyRequests: 20,
      userMonthlyRequests: 150,
      globalConcurrency: 2,
    });
    expect(c.ai.llmProvider).toBe('anthropic');
    expect(c.elasticsearch.url).toBe('http://localhost:59200');
  });

  it('does not leak values in validation errors', () => {
    try {
      loadConfig({ env: { PORT: 'secret-not-a-port-xyz' }, files: [] });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('secret-not-a-port-xyz');
    }
  });
});
