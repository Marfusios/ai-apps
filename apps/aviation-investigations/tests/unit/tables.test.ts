import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TABLE_SPECS, TABLE_NAMES, MAX_COLUMNS, MAX_RECORD_BYTES, projectCsv } from '../../worker/ingest/tables.js';

async function project(table: Parameters<typeof projectCsv>[0], input: string | Buffer[]) {
  const chunks: string[] = [];
  const stats = await pipeline(
    Readable.from(typeof input === 'string' ? [input] : input, { objectMode: false }),
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

describe('required columns', () => {
  const required: Record<string, string[]> = {
    events: ['ev_id', 'ntsb_no', 'ev_date', 'lchg_date'],
    aircraft: ['ev_id', 'aircraft_key', 'ntsb_no', 'lchg_date'],
    engines: ['ev_id', 'aircraft_key', 'eng_no', 'lchg_date'],
    narratives: ['ev_id', 'aircraft_key', 'lchg_date'],
    findings: ['ev_id', 'aircraft_key', 'finding_no', 'lchg_date'],
    events_sequence: ['ev_id', 'aircraft_key', 'occurrence_no', 'lchg_date'],
    ntsb_admin: ['ev_id', 'rec_stat', 'approval_date', 'lchg_date'],
  };
  for (const [table, cols] of Object.entries(required)) {
    it(`${table} keeps identity, ordering and revision columns`, () => {
      for (const c of cols) expect(TABLE_SPECS[table as keyof typeof TABLE_SPECS].columns).toContain(c);
    });
  }
});

describe('projectCsv hardening', () => {
  const header = `${TABLE_SPECS.ct_seqevt.columns.join(',')}\n`;

  it('rejects an oversized quoted field instead of truncating', async () => {
    const huge = 'x'.repeat(MAX_RECORD_BYTES + 1024);
    await expect(project('ct_seqevt', `${header}1,"${huge}"\n`)).rejects.toThrow();
  });

  it('rejects an unterminated quoted field that grows past the limit', async () => {
    const chunks = [Buffer.from(`${header}1,"`)];
    for (let i = 0; i < 5; i++) chunks.push(Buffer.alloc(1024 * 1024, 0x61));
    await expect(project('ct_seqevt', chunks)).rejects.toThrow();
  });

  it('rejects a header with too many columns', async () => {
    const cols = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(',');
    await expect(project('ct_seqevt', `${cols}\n`)).rejects.toThrow(/too many columns/);
  });

  it('rejects an empty stream (no header)', async () => {
    await expect(project('ct_seqevt', '')).rejects.toThrow(/no header/);
  });

  it('accepts a header-only table', async () => {
    await expect(project('ct_seqevt', header)).resolves.toBe(header);
  });

  it('accepts a multibyte character split across chunks', async () => {
    const bytes = Buffer.from(`${header}1,€uro\n`);
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
    const out = await project('ct_seqevt', [bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(out).toBe(`${header}1,€uro\n`);
  });

  it('rejects malformed UTF-8', async () => {
    const bad = Buffer.concat([Buffer.from(`${header}1,a`), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]);
    await expect(project('ct_seqevt', [bad])).rejects.toThrow(/UTF-8/);
  });

  it('rejects truncated UTF-8 at end of input', async () => {
    const bad = Buffer.concat([Buffer.from(`${header}1,a`), Buffer.from([0xe2, 0x82])]);
    await expect(project('ct_seqevt', [bad])).rejects.toThrow(/UTF-8/);
  });
});

describe('projectCsv', () => {
  it('drops columns that are not allowlisted, preserving embedded quotes and newlines', async () => {
    const cols = [...TABLE_SPECS.engines.columns];
    const header = [...cols, 'lchg_userid', 'eng_mfgr'];
    const quoted = '"say ""hi""\nthere"';
    const raw =
      `${header.join(',')}\n` +
      `"E1",1,1,"RECIP","CARB","2020-01-01T00:00:00","dobn","Lycoming"\n` +
      `"E2",2,1,${quoted},"","2020-01-02T00:00:00",secret,"x"\n`;
    const out = await project('engines', raw);
    expect(out).toBe(`${cols.join(',')}\nE1,1,1,RECIP,CARB,2020-01-01T00:00:00\nE2,2,1,${quoted},,2020-01-02T00:00:00\n`);
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
