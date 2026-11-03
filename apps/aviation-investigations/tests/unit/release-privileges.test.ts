import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createDb, closeDb } from '../../server/db/client.js';
import { privilegeSnapshot } from '../../server/db/privileges.js';
import { EXPECTED_PRIVILEGES } from '../../server/db/privileges-expected.js';
import { checkReleasePrivileges } from '../../scripts/release-privileges.js';

vi.mock('../../server/db/client.js', () => ({ createDb: vi.fn(), closeDb: vi.fn() }));
vi.mock('../../server/db/privileges.js', async (original) => ({
  ...await original<typeof import('../../server/db/privileges.js')>(), privilegeSnapshot: vi.fn(),
}));
let dir: string;
const hostUrl = 'postgres://offline:PRIVATE_SENTINEL@localhost/aviation_live?options=-c%20role%3Daviation_migrator';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'release-privileges-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([false, true])('checks the existing DB read-only and prints only found/expected; mismatch=%s', async (mismatch) => {
  const path = join(dir, 'host.env');
  await writeFile(path, `DATABASE_MIGRATOR_URL=${hostUrl}\nUNRELATED=PRIVATE_OTHER_SENTINEL\n`, { mode: 0o600 });
  const order: string[] = [];
  const execute = vi.fn(async (query) => { order.push(new PgDialect().sqlToQuery(query).sql); return { rows: [] }; });
  const tx = { execute };
  const db = { transaction: vi.fn(async (fn) => fn(tx)) };
  vi.mocked(createDb).mockReturnValue(db as never);
  vi.mocked(privilegeSnapshot).mockImplementation(async () => { order.push('snapshot'); return mismatch ? ['unexpected catalog line'] : [...EXPECTED_PRIVILEGES]; });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  expect(await checkReleasePrivileges(['--environment', 'live'], { AVIATION_ENV_FILES: path, DATABASE_MIGRATOR_URL: 'leaked-process-value' })).toBe(mismatch ? 1 : 0);
  expect(order).toEqual(['set transaction read only', 'snapshot']);
  expect(createDb).toHaveBeenCalledWith(hostUrl, expect.objectContaining({ max: 1 }));
  expect(closeDb).toHaveBeenCalledWith(db);
  const text = output.mock.calls.map(([v]) => String(v)).join('');
  expect(text).not.toMatch(/PRIVATE_|postgres:|leaked-process-value/);
  expect(JSON.parse(text)).toEqual({ found: mismatch ? ['unexpected catalog line'] : [], expected: mismatch ? EXPECTED_PRIVILEGES : [] });
});
it('wrong environment refuses without opening a connection', async () => {
  const path = join(dir, 'host.env'); await writeFile(path, `DATABASE_MIGRATOR_URL=${hostUrl}`, { mode: 0o600 });
  await expect(checkReleasePrivileges(['--environment', 'dev'], { AVIATION_ENV_FILES: path })).rejects.toThrow();
  expect(createDb).not.toHaveBeenCalled();
});
it('closes the connection even if the snapshot fails', async () => {
  const path = join(dir, 'host.env'); await writeFile(path, `DATABASE_MIGRATOR_URL=${hostUrl}`, { mode: 0o600 });
  const db = { transaction: vi.fn(async () => { throw new Error('PRIVATE_FAILURE'); }) };
  vi.mocked(createDb).mockReturnValue(db as never);
  await expect(checkReleasePrivileges(['--environment', 'live'], { AVIATION_ENV_FILES: path })).rejects.toThrow();
  expect(closeDb).toHaveBeenCalledWith(db);
});
