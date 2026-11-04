/** Free, read-only metadata snapshot for Task 24 construction. No narratives or keys in output. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readDotenvAllowlisted } from '../../shared/env-files.js';
import { DB_CONNECT_TIMEOUT_MS } from '../../server/db/client.js';
import { CORPUS_QUERIES } from '../retrieval/coded/build-coded.js';
import { readGenerationSource } from '../retrieval/generation.js';
import { US_STATE, AIRCRAFT_CATEGORY, EVENT_CODE } from '../../shared/vocab.js';
import { DEFAULT_CODE_LABELS, PHASE_LABEL } from '../../shared/codes.js';

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, out: { type: 'string' } } });
  const env = readDotenvAllowlisted(resolve(values['env-file'] ?? '.env.local'), ['DATABASE_URL', 'APP_ENV']);
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
  if ((process.env.APP_ENV || env.APP_ENV || 'dev') !== 'dev' || !databaseUrl || new URL(databaseUrl).pathname !== '/aviation_dev') {
    throw new Error('construction requires the development read connection');
  }
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    statement_timeout: 30_000, application_name: 'aircase-task24-construction' });
  await client.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const identity = await client.query('select current_database() as name');
    if (identity.rows[0]?.name !== 'aviation_dev') throw new Error('wrong database');
    const manifest = (await client.query('select generation_id, cases_index, passages_index from dataset_manifests where active')).rows;
    if (manifest.length !== 1) throw new Error('one active development manifest required');
    const generationId = Number(manifest[0].generation_id);
    const source = await readGenerationSource(client, generationId);
    const cases = (await client.query(`select ntsb_no, ev_year, state, city, highest_injury, wx_cond_basic, light_cond, source_revision
      from cases where generation_id=$1 and answer_eligible and is_us order by ntsb_no`, [generationId])).rows;
    const aircraft = (await client.query(CORPUS_QUERIES.aircraft, [generationId])).rows;
    const findings = (await client.query(CORPUS_QUERIES.findings, [generationId])).rows;
    const sequence = (await client.query(CORPUS_QUERIES.sequence, [generationId])).rows;
    const findingDictionary = (await client.query(`select code, meaning from code_dictionary
      where generation_id=$1 and table_name='findings' and column_name='findings_code' order by code`, [generationId])).rows;
    await client.query('commit');
    const out = resolve(values.out ?? 'data/work/task24/corpus.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ source, manifest: manifest[0], cases, aircraft, findings, sequence, findingDictionary,
      vocabulary: { states: US_STATE, category: AIRCRAFT_CATEGORY, phase: PHASE_LABEL, event: EVENT_CODE, ...DEFAULT_CODE_LABELS } }) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ generation: generationId, cases: cases.length, aircraft: aircraft.length, findings: findings.length, sequence: sequence.length }));
  } finally { await client.end(); }
}
main().catch((error: unknown) => {
  const code = (error as { code?: string }).code;
  console.error(JSON.stringify({ error: 'metadata_snapshot_failed', code: code && /^[A-Z0-9_]{1,30}$/.test(code) ? code : 'local_preflight' }));
  process.exitCode = 1;
});
