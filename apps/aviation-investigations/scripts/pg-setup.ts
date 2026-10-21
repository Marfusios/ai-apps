import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { APP_DIR, ensureSecrets, writeLocal } from './local-env.js';

const DATABASES = ['aviation', 'aviation_test'] as const;

/** Creates databases and least-privilege roles; writes DATABASE_* URLs to .env.local. */
export async function setupPostgres(): Promise<void> {
  const s = ensureSecrets([
    'POSTGRES_PASSWORD',
    'AVIATION_MIGRATOR_PASSWORD',
    'AVIATION_INGEST_PASSWORD',
    'AVIATION_APP_PASSWORD',
  ]);
  const port = Number(process.env.POSTGRES_PORT || 55432);
  const sql = readFileSync(resolve(APP_DIR, 'scripts/pg-setup.sql'), 'utf8');
  const [, clusterSql, dbSql] = /-- @cluster([\s\S]*?)-- @database([\s\S]*)$/.exec(sql)!;
  const connect = (database: string) =>
    new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: s.POSTGRES_PASSWORD, database });
  const lit = (v: string) => pg.escapeLiteral(v);

  const admin = connect('postgres');
  await admin.connect();
  try {
    await admin.query(
      clusterSql!
        .replace('{{MIGRATOR_PASSWORD}}', lit(s.AVIATION_MIGRATOR_PASSWORD!))
        .replace('{{INGEST_PASSWORD}}', lit(s.AVIATION_INGEST_PASSWORD!))
        .replace('{{APP_PASSWORD}}', lit(s.AVIATION_APP_PASSWORD!)),
    );
    for (const db of DATABASES) {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
      if (!exists.rowCount) await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(db)}`);
    }
  } finally {
    await admin.end();
  }
  for (const db of DATABASES) {
    const c = connect(db);
    await c.connect();
    try {
      await c.query(dbSql!.replaceAll('{{DB}}', pg.escapeIdentifier(db)));
    } finally {
      await c.end();
    }
  }
  const url = (user: string, pw: string, db: string) =>
    `postgres://${user}:${encodeURIComponent(pw)}@localhost:${port}/${db}`;
  writeLocal({
    DATABASE_URL: url('aviation_app', s.AVIATION_APP_PASSWORD!, 'aviation'),
    DATABASE_MIGRATOR_URL: url('aviation_migrator', s.AVIATION_MIGRATOR_PASSWORD!, 'aviation'),
    DATABASE_INGEST_URL: url('aviation_ingest', s.AVIATION_INGEST_PASSWORD!, 'aviation'),
    POSTGRES_PORT: String(port),
  });
}
