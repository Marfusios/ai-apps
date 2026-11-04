/** Read-only coded maker/model context; no narratives, accounts, or provider call. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { evaluationSettings } from '../config.js';
async function main() {
  const { values } = parseArgs({ options: { 'env-files': { type: 'string' } } });
  if (!values['env-files']) throw new Error('Development connection required');
  const settings = evaluationSettings(values['env-files']);
  const corpus = JSON.parse(readFileSync('data/work/task24/corpus.json', 'utf8'));
  const client = new pg.Client({ connectionString: settings.config.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  await client.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const m = (await client.query('select generation_id, cases_index, passages_index from dataset_manifests where active')).rows;
    if (JSON.stringify(m[0]) !== JSON.stringify(corpus.manifest) || m.length !== 1) throw new Error('Generation changed');
    const rows = (await client.query(`select a.ntsb_no, a.aircraft_key, a.make, a.model from case_aircraft a
      join cases c on c.generation_id=a.generation_id and c.ntsb_no=a.ntsb_no
      where a.generation_id=$1 and c.answer_eligible and c.is_us order by a.ntsb_no,a.aircraft_key`, [corpus.source.generationId])).rows;
    await client.query('commit');
    writeFileSync('data/work/task24/part5/aircraft.json', JSON.stringify({ source: corpus.source, rows }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ paidCalls: 0, aircraft: rows.length }));
  } finally { await client.end(); }
}
main().catch(() => { console.error('Read-only aircraft snapshot failed; details suppressed.'); process.exitCode = 1; });
