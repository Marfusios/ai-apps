import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DbOrTx } from '../../server/db/client.js';
import { caseSections, cases } from '../../server/db/schema/index.js';
import {
  BATCH_ROWS,
  ExtractDirError,
  LoadValueError,
  caseRows,
  checkRowCounts,
  describeLoadError,
  dictionaryDrafts,
  insertBatched,
  readExtractManifest,
  reconstructSource,
  sectionIdOf,
  sectionRevisionId,
  sourceFormOf,
} from '../../worker/ingest/load.js';
import { normalizeCorpus, readProjectedTables, type CanonicalCase, type RawTables } from '../../worker/ingest/normalize.js';
import { editTable, makeExtractDir, removeDir, writeManifest } from '../support/extract-dir.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const dirs: string[] = [];
async function extractDir(opts: Parameters<typeof makeExtractDir>[0] = {}): Promise<string> {
  const dir = await makeExtractDir(opts);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExtractDirError) return e.problems;
    throw e;
  }
  throw new Error('expected ExtractDirError');
}

describe('readExtractManifest', () => {
  it('accepts a complete fixture extraction', async () => {
    const dir = await extractDir();
    const m = readExtractManifest(dir);
    expect(m.tables.events?.rows).toBe(16);
    expect(Object.keys(m.tables).sort()).toEqual(
      ['aircraft', 'engines', 'events', 'events_sequence', 'findings', 'narratives', 'ntsb_admin'].sort(),
    );
  });

  it('rejects a directory without manifest.json', async () => {
    const dir = await extractDir({ withoutManifest: true });
    expect(problemsOf(() => readExtractManifest(dir))).toEqual(['manifest.json missing (incomplete extraction)']);
  });

  it('rejects a missing directory and an unparsable manifest', async () => {
    expect(problemsOf(() => readExtractManifest('/nonexistent/aviation-extract'))).toEqual(['directory does not exist']);
    const dir = await extractDir();
    writeFileSync(join(dir, 'manifest.json'), '{"archive":');
    expect(problemsOf(() => readExtractManifest(dir))).toEqual(['manifest.json is not valid JSON']);
    writeFileSync(join(dir, 'manifest.json'), '{"archive": {"sha256": "nope", "bytes": 1}}');
    expect(problemsOf(() => readExtractManifest(dir)).some((p) => p.startsWith('manifest.archive.sha256'))).toBe(true);
  });

  it('rejects a manifest that disagrees with the files', async () => {
    const dir = await extractDir();
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    delete m.tables.narratives;
    m.tables.events.bytes += 1;
    m.tables.findings.columns = 3;
    m.tables.bogus = { rows: 0, columns: 1, bytes: 0 };
    m.mdbExportFlags = ['-D', '%m/%d/%y'];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    const problems = problemsOf(() => readExtractManifest(dir));
    expect(problems).toEqual(
      expect.arrayContaining([
        'manifest.mdbExportFlags differ from the current scalar contract',
        'manifest lists unknown table bogus',
        'manifest does not list required table narratives',
        'narratives.csv present but not listed in the manifest',
        expect.stringMatching(/^events\.csv is \d+ bytes, manifest records \d+$/),
        'findings: manifest records 3 columns, allowlist has 13',
      ]),
    );
  });

  it('rejects a listed table whose CSV is missing', async () => {
    const dir = await extractDir();
    rmSync(join(dir, 'engines.csv'));
    expect(problemsOf(() => readExtractManifest(dir))).toEqual(['engines.csv listed in the manifest but missing']);
  });

  it('checkRowCounts compares rows read with the manifest', async () => {
    const dir = await extractDir();
    const manifest = readExtractManifest(dir);
    const tables = await readProjectedTables(dir);
    expect(() => checkRowCounts(tables, manifest)).not.toThrow();
    const fewer = { ...tables, findings: tables.findings.slice(1) } as RawTables;
    expect(() => checkRowCounts(fewer, manifest)).toThrow(/findings: read \d+ rows, manifest records \d+/);
  });
});

describe('section identifiers', () => {
  it('revision id is sha256 over ntsb_no, key, text hash and citation version', () => {
    const r = sectionRevisionId('SEA08LA057', 'probable_cause/event-1', 'a'.repeat(64), 'v1');
    expect(r).toBe(sha256(JSON.stringify(['SEA08LA057', 'probable_cause/event-1', 'a'.repeat(64), 'v1'])));
    expect(sectionRevisionId('SEA08LA057', 'probable_cause/event-1', 'a'.repeat(64), 'v1')).toBe(r);
    expect(sectionRevisionId('SEA08LA057', 'probable_cause/event-1', 'b'.repeat(64), 'v1')).not.toBe(r);
    expect(sectionRevisionId('SEA08LA057', 'probable_cause/event-1', 'a'.repeat(64), 'v2')).not.toBe(r);
    expect(sectionRevisionId('SEA08LA057', 'probable_cause/event-2', 'a'.repeat(64), 'v1')).not.toBe(r);
    // Unambiguous encoding: shifting characters between parts changes the id.
    expect(sectionRevisionId('A:', 'b', 'c', 'v1')).not.toBe(sectionRevisionId('A', ':b', 'c', 'v1'));
  });

  it('section id is ntsb_no and section key', () => {
    expect(sectionIdOf('DFW08TA066', 'factual/aircraft-1')).toBe('DFW08TA066:factual/aircraft-1');
  });

  it('source forms reconstruct the exported text exactly', () => {
    const text = 'Line one.\nLine two.';
    const cases: [string, string][] = [
      [text, 'canonical'],
      ['Line one.\r\nLine two.', 'canonical_crlf'],
      ['Line one.\r\r\nLine two.', 'stored'],
      ['Line one.\rLine two.', 'stored'],
      ['<p>Line one.</p><p>Line two.</p>', 'stored'],
      ['Line one.\nLine two.  ', 'stored'],
    ];
    for (const [source, expected] of cases) {
      const { form, stored } = sourceFormOf(text, source);
      expect(form).toBe(expected);
      expect(stored === null).toBe(form !== 'stored');
      expect(reconstructSource(text, form, stored)).toBe(source);
    }
    expect(sourceFormOf('no line ends', 'no line ends').form).toBe('canonical');
  });
});

describe('caseRows on the NTSB fixtures', () => {
  let byNo: Map<string, CanonicalCase>;
  beforeAll(async () => {
    const dir = await makeExtractDir();
    try {
      const result = normalizeCorpus(await readProjectedTables(dir));
      byNo = new Map(result.cases.map((c) => [c.ntsbNo, c]));
    } finally {
      removeDir(dir);
    }
  });
  const rowsOf = (no: string) => {
    const c = byNo.get(no);
    if (!c) throw new Error(`fixture ${no} missing`);
    return caseRows(7, c);
  };

  it('maps a single-aircraft seed case with aircraft-scoped sections', () => {
    const r = rowsOf('DFW08TA066');
    expect(r.case).toMatchObject({ generationId: 7, ntsbNo: 'DFW08TA066', isUs: true, country: 'USA' });
    expect(r.aircraft).toHaveLength(1);
    expect(r.sections.length).toBeGreaterThan(0);
    for (const s of r.sections) {
      expect(s.scope).toBe('aircraft');
      expect(s.aircraftKey).toBe(1);
      expect(s.sourceAircraftKeys).toEqual([1]);
      expect(s.sectionId).toBe(`DFW08TA066:${s.sectionKey}`);
      expect(s.sha256).toBe(sha256(s.text));
      expect(s.revisionId).toBe(sectionRevisionId('DFW08TA066', s.sectionKey, s.sha256, 'v1'));
    }
    expect(r.findings.every((f) => f.generationId === 7 && f.ntsbNo === 'DFW08TA066')).toBe(true);
  });

  it('keeps multi-aircraft sections event-scoped with provenance', () => {
    const r = rowsOf('DCA25MA108');
    expect(r.aircraft.map((a) => a.aircraftKey)).toEqual([1, 2]);
    expect(r.sections.every((s) => s.scope === 'event' && s.aircraftKey === null)).toBe(true);
    const merged = r.sections.filter((s) => s.sourceAircraftKeys.length === 2);
    expect(merged.length).toBeGreaterThan(0);
    for (const s of merged) {
      expect(r.sources.filter((x) => x.sectionId === s.sectionId).map((x) => x.sourceAircraftKey)).toEqual([1, 2]);
    }
  });

  it('stores source text only when it is not reconstructible, and every source matches its hash', () => {
    let stored = 0;
    let derived = 0;
    for (const no of byNo.keys()) {
      const r = rowsOf(no);
      const textOf = new Map(r.sections.map((s) => [s.sectionId, s.text]));
      for (const x of r.sources) {
        const text = textOf.get(x.sectionId) as string;
        const source = reconstructSource(text, x.sourceForm, x.sourceText ?? null);
        expect(sha256(source)).toBe(x.sourceSha256);
        if (x.sourceForm === 'stored') stored += 1;
        else derived += 1;
        if (x.transformedFromHtml || x.match === 'whitespace') expect(x.sourceForm).toBe('stored');
      }
    }
    expect(stored).toBeGreaterThan(0);
    expect(derived).toBeGreaterThan(stored);
    const html = rowsOf('CEN24FA064').sources.filter((x) => x.transformedFromHtml);
    expect(html.length).toBeGreaterThan(0);
    expect(html.every((x) => x.sourceText !== null && x.sourceText !== undefined && x.sourceText.includes('<'))).toBe(true);
  });

  it('keeps ev_id on the case row only', () => {
    const c = byNo.get('SEA08LA057') as CanonicalCase;
    const r = caseRows(1, c);
    expect(r.case.evId).toBe(c.evId);
    const children = JSON.stringify([r.aircraft, r.engines, r.findings, r.sequence, r.sections, r.sources]);
    expect(children.includes(c.evId)).toBe(false);
  });
});

describe('dictionaryDrafts', () => {
  it('keeps coded dictionary rows, trimmed, with lower-case table and column', () => {
    const tables = {
      eadmspub_datadictionary: [
        { table: 'events ', column: 'Light_Cond', code_iaids: ' DAYL', meaning: 'Day ' },
        { table: 'events', column: 'ev_id', code_iaids: '', meaning: 'Event id' },
      ],
      ct_seqevt: [
        { code: '100', meaning: 'Abrupt maneuver' },
        { code: ' ', meaning: 'blank' },
      ],
    } as unknown as RawTables;
    expect(dictionaryDrafts(tables)).toEqual([
      { source: 'eadmspub_datadictionary', tableName: 'events', columnName: 'light_cond', code: 'DAYL', meaning: 'Day' },
      { source: 'ct_seqevt', tableName: null, columnName: null, code: '100', meaning: 'Abrupt maneuver' },
    ]);
  });
});

describe('insertBatched', () => {
  function fakeTx(): { tx: DbOrTx; batches: number[] } {
    const batches: number[] = [];
    const tx = {
      insert: () => ({
        values: async (rows: unknown[]) => {
          batches.push(rows.length);
          return { rowCount: rows.length };
        },
      }),
    } as unknown as DbOrTx;
    return { tx, batches };
  }
  const caseRow = (i: number) =>
    ({
      generationId: 1,
      ntsbNo: `SYN${i}`,
      evId: `E${i}`,
      isUs: true,
      completionClass: 'completed',
      completionMappingVersion: 'v1',
      hasProbableCause: true,
      completedWithCause: true,
      answerEligible: true,
      definingPhaseGroups: [],
      sequencePhaseGroups: [],
      sourceRevision: 'a'.repeat(64),
    }) as typeof cases.$inferInsert;

  it('splits rows into statements of at most BATCH_ROWS', async () => {
    const { tx, batches } = fakeTx();
    const n = await insertBatched(tx, cases, Array.from({ length: 2 * BATCH_ROWS + 5 }, (_, i) => caseRow(i)));
    expect(n).toBe(2 * BATCH_ROWS + 5);
    expect(batches).toEqual([BATCH_ROWS, BATCH_ROWS, 5]);
    expect(await insertBatched(tx, cases, [])).toBe(0);
  });

  it('bounds statement size by text volume', async () => {
    const { tx, batches } = fakeTx();
    const big = 'x'.repeat(6 * 1024 * 1024);
    const rows = Array.from({ length: 4 }, (_, i) => ({
      generationId: 1,
      sectionId: `SYN:factual/aircraft-${i}`,
      ntsbNo: 'SYN',
      sectionKey: `factual/aircraft-${i}`,
      kind: 'factual' as const,
      scope: 'aircraft' as const,
      aircraftKey: i,
      text: big,
      sha256: 'a'.repeat(64),
      citationTextVersion: 'v1',
      transformedFromHtml: false,
      sourceAircraftKeys: [i],
      revisionId: 'b'.repeat(64),
    }));
    await insertBatched(tx, caseSections, rows);
    expect(batches).toEqual([2, 2]);
  });

  it('rejects NUL characters and out-of-range integers with the key, not the value', async () => {
    const { tx } = fakeTx();
    const nul = { ...caseRow(1), metar: 'secret\u0000text' };
    await expect(insertBatched(tx, cases, [nul])).rejects.toThrow(LoadValueError);
    await expect(insertBatched(tx, cases, [nul])).rejects.toThrow('cases: metar of ntsbNo=SYN1 contains a NUL character');
    await expect(insertBatched(tx, cases, [{ ...caseRow(2), injTotF: 2 ** 31 }])).rejects.toThrow(
      'cases: injTotF of ntsbNo=SYN2 is outside the 32-bit integer range',
    );
    await expect(insertBatched(tx, cases, [nul])).rejects.not.toThrow(/secret/);
  });

  it('refuses an event year outside 1900–2100, the years the API serves (task 22 S-I1, a refusal, not a change to normalized output)', async () => {
    const { tx, batches } = fakeTx();
    for (const evYear of [208, 20226, 1899, 2101]) {
      await expect(insertBatched(tx, cases, [{ ...caseRow(3), evYear }]), String(evYear)).rejects.toThrow(
        'cases: evYear of ntsbNo=SYN3 is outside 1900-2100, the years the API serves (a dropped or extra digit?)',
      );
    }
    expect(batches).toEqual([]);
    // The bounds themselves, and a missing year, load.
    expect(await insertBatched(tx, cases, [{ ...caseRow(4), evYear: 1900 }, { ...caseRow(5), evYear: 2100 }, { ...caseRow(6), evYear: null }])).toBe(3);
  });
});

describe('describeLoadError', () => {
  const pgError = (code: string, detail: string) =>
    Object.assign(new Error('violation'), { code, table: 'case_sections', constraint: 'c', detail });

  it('keeps key details of unique and foreign-key violations', () => {
    expect(describeLoadError(pgError('23505', 'Key (generation_id, ntsb_no)=(3, X) already exists.'))).toBe(
      'violation [23505 on case_sections (c)] Key (generation_id, ntsb_no)=(3, X) already exists.',
    );
  });

  it('never includes a check violation row (it can hold narrative text)', () => {
    const wrapped = new Error('Failed query: insert ...', { cause: pgError('23514', 'Failing row contains (narrative text)') });
    const text = describeLoadError(wrapped);
    expect(text).toBe('violation [23514 on case_sections (c)]');
    expect(text).not.toContain('narrative');
  });

  it('never repeats a failed query or its parameters', () => {
    expect(describeLoadError(new Error('Failed query: insert into case_sections ...\nparams: narrative text'))).toBe(
      'database query failed',
    );
  });

  it('truncates long messages', () => {
    expect(describeLoadError(new Error('x'.repeat(5000)))).toHaveLength(2000);
  });
});

describe('fixture extraction helper', () => {
  it('rewrites edited tables and keeps the manifest consistent', async () => {
    const dir = await extractDir({
      edit: (d) => editTable(d, 'findings', (rows) => rows.slice(1)),
    });
    const before = readExtractManifest(dir).tables.findings?.rows ?? 0;
    editTable(dir, 'findings', (rows) => rows.slice(1));
    expect(() => readExtractManifest(dir)).toThrow(ExtractDirError);
    const after = await writeManifest(dir);
    expect(after.tables.findings?.rows).toBe(before - 1);
  });
});
