import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TABLE_SPECS, TABLE_NAMES, projectCsv } from '../../worker/ingest/tables.js';

async function project(table: Parameters<typeof projectCsv>[0], input: string) {
  const chunks: string[] = [];
  const stats = await pipeline(
    Readable.from([input]),
    ...projectCsv(table),
    async function (source: AsyncIterable<string | Buffer>) {
      for await (const c of source) chunks.push(String(c));
    },
  );
  void stats;
  return chunks.join('');
}

describe('TABLE_SPECS', () => {
  it('aircraft has no owner_ or oper_ columns', () => {
    for (const c of TABLE_SPECS.aircraft.columns) expect(c).not.toMatch(/^(owner_|oper_)/);
  });
  it('never selects lchg_userid', () => {
    for (const t of TABLE_NAMES) expect(TABLE_SPECS[t].columns).not.toContain('lchg_userid');
  });
  it('events omit editor and notification fields', () => {
    expect(TABLE_SPECS.events.columns).not.toContain('ntsb_notf_from');
    expect(TABLE_SPECS.events.columns).toContain('dec_latitude');
  });
});

describe('projectCsv', () => {
  it('drops columns that are not allowlisted, preserving embedded quotes and newlines', async () => {
    const cols = [...TABLE_SPECS.engines.columns];
    const header = [...cols, 'lchg_userid', 'eng_mfgr'];
    const quoted = '"say ""hi""\nthere"';
    const raw =
      `${header.join(',')}\n` +
      `"E1",1,1,"RECIP","CARB","dobn","Lycoming"\n` +
      `"E2",2,1,${quoted},"",secret,"x"\n`;
    const out = await project('engines', raw);
    expect(out).toBe(`${cols.join(',')}\nE1,1,1,RECIP,CARB\nE2,2,1,${quoted},\n`);
  });

  it('removes owner and operator columns from aircraft rows', async () => {
    const header = [...TABLE_SPECS.aircraft.columns, 'owner_street', 'oper_name', 'owner_zip'];
    const row = header.map((c) => (c.startsWith('o') && /^(owner_|oper_)/.test(c) ? 'SECRET' : 'v'));
    const out = await project('aircraft', `${header.join(',')}\n${row.join(',')}\n`);
    expect(out).not.toContain('SECRET');
    expect(out.split('\n')[0]).toBe(TABLE_SPECS.aircraft.columns.join(','));
  });

  it('matches headers case-insensitively and outputs spec names', async () => {
    const out = await project('ct_seqevt', 'Code,Meaning,Extra\n1,"A,B",z\n');
    expect(out).toBe('code,meaning\n1,"A,B"\n');
  });

  it('fails when an allowlisted column is missing from the source', async () => {
    await expect(project('engines', 'ev_id,aircraft_key,eng_no,eng_type\n')).rejects.toThrow(/carb_fuel_injection/);
  });
});
