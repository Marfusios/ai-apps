import { beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted stand-in for pg.Client: records statements and fails where told to.
const state = vi.hoisted(() => ({
  log: [] as string[],
  currentUser: 'aviation_migrator',
  journalSchema: true,
  failOn: [] as { match: RegExp; error: Error }[],
}));

vi.mock('pg', () => {
  class Client {
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    async query(text: string): Promise<{ rows: unknown[] }> {
      state.log.push(text.trim().split('\n')[0]!.slice(0, 60));
      const failure = state.failOn.find((f) => f.match.test(text));
      if (failure) throw failure.error;
      if (text.includes('current_user')) return { rows: [{ current_user: state.currentUser, journal: state.journalSchema }] };
      return { rows: [] };
    }
  }
  return { default: { Client } };
});

const { runMigrations } = await import('../../server/db/migrate.js');

beforeEach(() => {
  state.log = [];
  state.currentUser = 'aviation_migrator';
  state.journalSchema = true;
  state.failOn = [];
});

describe('runMigrations', () => {
  it('reports the failing migration, not a failed ROLLBACK', async () => {
    state.failOn = [
      { match: /CREATE TABLE "cases"/, error: new Error('original migration failure') },
      { match: /^ROLLBACK$/, error: new Error('Connection terminated') },
    ];
    await expect(runMigrations('postgres://x')).rejects.toThrow('original migration failure');
    expect(state.log).toContain('BEGIN');
    expect(state.log).toContain('ROLLBACK');
    expect(state.log).not.toContain('COMMIT');
  });

  it('refuses a session that is not aviation_migrator', async () => {
    state.currentUser = 'aviation_dev_migrator';
    await expect(runMigrations('postgres://x')).rejects.toThrow(/must run as aviation_migrator/);
    expect(state.log.some((l) => l.startsWith('BEGIN'))).toBe(false);
  });

  it('refuses a database without the provisioned drizzle schema', async () => {
    state.journalSchema = false;
    await expect(runMigrations('postgres://x')).rejects.toThrow(/schema drizzle is missing/);
  });

  it('applies pending migrations in one transaction and records each', async () => {
    await runMigrations('postgres://x');
    const inserts = state.log.filter((l) => l.startsWith('INSERT INTO drizzle.__drizzle_migrations'));
    expect(inserts.length).toBeGreaterThan(10);
    expect(state.log.indexOf('BEGIN')).toBeLessThan(state.log.indexOf('COMMIT'));
  });
});
