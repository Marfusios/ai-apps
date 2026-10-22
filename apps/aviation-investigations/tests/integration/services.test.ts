import { afterAll, describe, expect, it } from 'vitest';
import { TEST_INDEX_PREFIX, testEs, testEsReader, testPool } from './helpers.js';

const INDEX = `${TEST_INDEX_PREFIX}x`;
const status = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;

afterAll(async () => {
  // Only this file's indices: other suites (and other checkouts sharing the local
  // services) keep their own aviation-test-* indices while they run.
  const es = testEs();
  for (const index of [INDEX, `${TEST_INDEX_PREFIX}read`]) {
    await es.indices.delete({ index }).catch((e: unknown) => {
      if (status(e) !== 404) throw e;
    });
  }
});

describe('Elasticsearch credentials', () => {
  it('reader key cannot write', async () => {
    const err = await testEsReader()
      .index({ index: INDEX, document: { a: 1 } })
      .catch((e: unknown) => e);
    expect(status(err)).toBe(403);
  });

  it('reader key can read but not other privileges', async () => {
    await testEs().indices.create({ index: `${TEST_INDEX_PREFIX}read` });
    await expect(testEsReader().search({ index: `${TEST_INDEX_PREFIX}read` })).resolves.toBeDefined();
  });

  it('writer key can create aviation-test-x and cannot touch other-index', async () => {
    const es = testEs();
    await es.indices.create({ index: INDEX });
    await es.index({ index: INDEX, document: { a: 1 }, refresh: true });
    const err = await es.index({ index: 'other-index', document: { a: 1 } }).catch((e: unknown) => e);
    expect(status(err)).toBe(403);
    await es.indices.delete({ index: INDEX });
  });
});

describe('PostgreSQL roles', () => {
  it('app role cannot create tables', async () => {
    const pool = testPool('app');
    try {
      await expect(pool.query('CREATE TABLE should_fail (id int)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
  });

  it('migrator can create tables that the app can read but not write', async () => {
    const m = testPool('migrator');
    const a = testPool('app');
    try {
      await m.query('DROP TABLE IF EXISTS grant_probe');
      await m.query('CREATE TABLE grant_probe (id int)');
      await m.query('INSERT INTO grant_probe VALUES (1)');
      expect((await a.query('SELECT id FROM grant_probe')).rows).toEqual([{ id: 1 }]);
      await expect(a.query('INSERT INTO grant_probe VALUES (2)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await m.query('DROP TABLE IF EXISTS grant_probe');
      await m.end();
      await a.end();
    }
  });
});
