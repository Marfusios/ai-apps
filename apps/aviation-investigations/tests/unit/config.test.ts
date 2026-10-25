import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configuredNames, loadConfig } from '../../shared/config.js';
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

  it('names a missing file instead of a bare ENOENT', () => {
    const missing = join(dir, 'nope.env');
    expect(() => readDotenvAllowlisted(missing, ['A'])).toThrow(missing);
    expect(() => readDotenvAllowlisted(missing, ['A'])).not.toThrow(/ENOENT/);
    expect(() => loadConfig({ env: {}, files: [missing] })).toThrow(/nope\.env/);
  });

  it('refuses an unterminated quote, naming the variable and not the value', () => {
    const p = file('q.env', 'A="never closed\nB=fine\n');
    expect(() => readDotenvAllowlisted(p, ['A', 'B'])).toThrow(/A has an unterminated quote/);
    try {
      readDotenvAllowlisted(p, ['A', 'B']);
    } catch (err) {
      expect(String(err)).not.toContain('never closed');
    }
    expect(readDotenvAllowlisted(file('r.env', "A='closed'\nB=\"x\n"), ['A'])).toEqual({ A: 'closed' });
  });
});

describe('loadConfig', () => {
  it('validates APP_URL and ELASTICSEARCH_URL as http(s) URLs', () => {
    expect(() => loadConfig({ env: { APP_URL: 'not a url' }, files: [] })).toThrow(/APP_URL: expected an http\(s\) URL/);
    expect(() => loadConfig({ env: { ELASTICSEARCH_URL: 'localhost:9200' }, files: [] })).toThrow(/ELASTICSEARCH_URL/);
    expect(() => loadConfig({ env: { APP_URL: 'ftp://casebook.example' }, files: [] })).toThrow(/APP_URL/);
    expect(loadConfig({ env: { APP_URL: 'https://casebook.example', ELASTICSEARCH_URL: 'https://es.internal:9200' }, files: [] }).appUrl).toBe(
      'https://casebook.example',
    );
  });

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
      anonymousTrialRequests: 10,
      newAccountDailyRequests: 20,
      newAccountDays: 3,
      userDailyRequests: 50,
      userMonthlyRequests: 600,
      globalConcurrency: 2,
    });
    expect(c.ai.llmProvider).toBe('anthropic');
    expect(c.elasticsearch.url).toBe('http://localhost:59200');
  });

  it('deployment environment and verification report directory', () => {
    const d = loadConfig({ env: {}, files: [] });
    expect(d.appEnv).toBe('dev');
    expect(d.verifyDir).toBeUndefined();
    const c = loadConfig({ env: { APP_ENV: 'live', AVIATION_VERIFY_DIR: '/app/data/reports' }, files: [] });
    expect(c.appEnv).toBe('live');
    expect(c.verifyDir).toBe('/app/data/reports');
    expect(() => loadConfig({ env: { APP_ENV: 'prod' }, files: [] })).toThrow(/APP_ENV/);
  });

  it('trusted proxy networks', () => {
    expect(loadConfig({ env: {}, files: [] }).trustedProxyCidrs).toEqual([]);
    // Documentation ranges (RFC 5737, RFC 3849).
    const c = loadConfig({ env: { TRUSTED_PROXY_CIDRS: ' 192.0.2.0/28 , 2001:db8::/64' }, files: [] });
    expect(c.trustedProxyCidrs).toEqual(['192.0.2.0/28', '2001:db8::/64']);
    for (const bad of ['192.0.2.0', '192.0.2.0/33', 'not-a-net/8', '::/129', '192.0.2.0/8/1']) {
      expect(() => loadConfig({ env: { TRUSTED_PROXY_CIDRS: bad }, files: [] }), bad).toThrow(/TRUSTED_PROXY_CIDRS/);
    }
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

describe('configuredNames', () => {
  it('names the settings a file or a nonempty process value sets, never those left to the defaults', () => {
    const names = ['AI_MONTHLY_BUDGET_USD', 'AI_INTERACTIVE_MONTHLY_BUDGET_USD', 'AI_INGESTION_MONTHLY_BUDGET_USD'];
    const settings = file('app.env', 'AI_MONTHLY_BUDGET_USD=200\nAI_INGESTION_MONTHLY_BUDGET_USD=\n');
    expect(configuredNames(names, { env: {}, files: [] })).toEqual(new Set());
    expect(configuredNames(names, { env: {}, files: [settings] })).toEqual(new Set(['AI_MONTHLY_BUDGET_USD']));
    const env = { AI_INTERACTIVE_MONTHLY_BUDGET_USD: '150', AI_INGESTION_MONTHLY_BUDGET_USD: '' };
    expect(configuredNames(names, { env, files: [settings] })).toEqual(new Set(['AI_MONTHLY_BUDGET_USD', 'AI_INTERACTIVE_MONTHLY_BUDGET_USD']));
    // Without explicit files, AVIATION_ENV_FILES names them, as for loadConfig.
    expect(configuredNames(names, { env: { AVIATION_ENV_FILES: settings } })).toEqual(new Set(['AI_MONTHLY_BUDGET_USD']));
  });
});
