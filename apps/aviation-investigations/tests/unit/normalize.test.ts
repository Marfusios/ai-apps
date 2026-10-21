import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLE_SPECS, type TableName } from '../../worker/ingest/tables.js';
import {
  NormalizationError,
  normalizeCorpus,
  readProjectedTables,
  type CanonicalCase,
  type NormalizeResult,
  type RawTables,
} from '../../worker/ingest/normalize.js';

const APP = resolve(import.meta.dirname, '../..');
const FIXTURES = join(APP, 'fixtures/ntsb');
const MALFORMED = join(APP, 'fixtures/ntsb-malformed');

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

type Row = Record<string, string>;

/** A row with every allowlisted column blank, then the given values. */
function row(table: TableName, values: Row): Row {
  const r: Row = {};
  for (const c of TABLE_SPECS[table].columns) r[c] = '';
  return { ...r, ...values };
}

/** A minimal one-event corpus; callers override or extend tables. */
function corpus(overrides: Partial<Record<TableName, Row[]>> = {}): RawTables {
  const base = {
    events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', ev_country: 'USA', ev_date: '2008-03-01T00:00:00' })],
    aircraft: [row('aircraft', { ev_id: 'E1', aircraft_key: '1', ntsb_no: 'SYN08LA001', acft_make: 'Synthetic' })],
    narratives: [row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_cause: 'Synthetic cause.' })],
    findings: [],
    events_sequence: [],
    ntsb_admin: [row('ntsb_admin', { ev_id: 'E1', rec_stat: 'B' })],
  };
  return { ...base, ...overrides } as unknown as RawTables;
}

function only(result: NormalizeResult): CanonicalCase {
  expect(result.cases).toHaveLength(1);
  return result.cases[0]!;
}

describe('normalizeCorpus on the NTSB fixtures', () => {
  let result: NormalizeResult;
  const byNo = new Map<string, CanonicalCase>();
  const get = (no: string): CanonicalCase => {
    const c = byNo.get(no);
    if (!c) throw new Error(`fixture ${no} missing`);
    return c;
  };

  beforeAll(async () => {
    result = normalizeCorpus(await readProjectedTables(FIXTURES));
    for (const c of result.cases) byNo.set(c.ntsbNo, c);
  });

  it('loads every fixture event without quarantine notes', () => {
    expect([...byNo.keys()].sort()).toEqual([
      'CEN19FA024', 'CEN20LA361', 'CEN22LA442', 'CEN23LA137', 'CEN24FA064', 'DCA25MA108', 'DEN08LA103',
      'DFW08TA066', 'ENG08WA029', 'ENG10WA034', 'ERA24LA303', 'MIA08LA156', 'NYC08LA106', 'SEA08LA057',
      'WPR26LA114',
    ]);
    expect(result.quarantine).toEqual([]);
  });

  it('flags the answer cohort as provisional under the unverified mapping', () => {
    expect(result.completionMapping.version).toBe('v1-empirical');
    expect(result.cohortProvisional).toBe(true);
    for (const c of result.cases) expect(c.completionMappingVersion).toBe('v1-empirical');
  });

  it('DFW08TA066 normalizes', () => {
    const c = get('DFW08TA066');
    expect(c.evId).toBe('20080213X00185');
    expect(c.aircraft).toHaveLength(1);
    const a = c.aircraft[0]!;
    // The MDB records the model as OH-6 (the report title says OH-6A); category HELI is helicopter.
    expect([a.make, a.model, a.category]).toEqual(['Hughes', 'OH-6', 'HELI']);
    expect(a.definingPhaseGroup).toBe('maneuvering');
    expect(c.definingPhaseGroup).toBe('maneuvering');
    expect(c.findings.filter((f) => f.inProbableCause === true)).toHaveLength(2);
    const cause = c.sections.find((s) => s.kind === 'probable_cause');
    expect(cause?.text.startsWith("The contract mechanic's failure")).toBe(true);
    expect(cause?.scope).toBe('aircraft');
    expect(cause?.aircraftKey).toBe(1);
    expect(c.fields.evDate).toBe('2008-02-08');
    expect(c.location).toEqual({ lat: 30.585832, lon: -104.490554 });
    expect([c.rawStatus, c.completionClass, c.hasProbableCause, c.answerEligible]).toEqual(['B', 'completed', true, true]);
  });

  it('all four seed cases are US, completed and answer-eligible', () => {
    for (const no of ['DFW08TA066', 'MIA08LA156', 'DEN08LA103', 'NYC08LA106']) {
      const c = get(no);
      expect([c.isUs, c.country, c.completionClass, c.answerEligible], no).toEqual([true, 'USA', 'completed', true]);
      expect(c.sections.map((s) => s.kind), no).toEqual(['factual', 'analysis', 'probable_cause']);
    }
    expect(get('MIA08LA156').sections.at(-1)?.text).toBe('A partial loss of engine power for undetermined reasons.');
  });

  it('two-aircraft fixture keeps findings attributed to their aircraftKey', () => {
    const sea = get('SEA08LA057');
    expect(sea.findings.map((f) => [f.aircraftKey, f.findingNo])).toEqual([[1, 1], [2, 1]]);
    expect(sea.findings[0]!.description).toMatch(/Pilot of other aircraft - C$/);
    expect(sea.findings[1]!.description).toMatch(/-Pilot - C$/);

    const dca = get('DCA25MA108');
    const nos = (k: number): number[] => dca.findings.filter((f) => f.aircraftKey === k).map((f) => f.findingNo);
    expect(nos(1)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(nos(2)).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(dca.sequence.map((s) => [s.aircraftKey, s.phaseNo, s.isDefining])).toEqual([[1, 500, true], [2, 400, true]]);
  });

  it('SEA08LA057 keeps a defining phase per aircraft; the event uses the lowest aircraft key', () => {
    const c = get('SEA08LA057');
    expect(c.aircraft.map((a) => [a.aircraftKey, a.aircraftNtsbNo, a.definingPhaseGroup])).toEqual([
      [1, 'SEA08LA057A', 'landing'],
      [2, 'SEA08LA057B', 'initial_climb'],
    ]);
    expect(c.definingPhaseGroup).toBe('landing');
    expect(c.phaseGroups).toEqual(['initial_climb', 'landing']);
    expect(c.aircraft[0]!.definingEvent?.description).toBe('Landing Midair collision');
  });

  it('SEA08LA057: identical factual text is event-scoped; differing causes stay with each aircraft', () => {
    const c = get('SEA08LA057');
    expect(c.sections.map((s) => [s.key, s.scope, s.aircraftKey])).toEqual([
      ['factual/event', 'event', null],
      ['analysis/aircraft-1', 'aircraft', 1],
      ['analysis/aircraft-2', 'aircraft', 2],
      ['probable_cause/aircraft-1', 'aircraft', 1],
      ['probable_cause/aircraft-2', 'aircraft', 2],
    ]);
    expect(c.sections[0]!.aircraftKeys).toEqual([1, 2]);
    // The two cause rows differ only by trailing newlines; they are not byte-identical, so each aircraft keeps its own.
    expect(c.sections[3]!.text).toBe("The departing pilot's inadequate visual lookout.\n\n");
    expect(c.sections[4]!.text).toBe("The departing pilot's inadequate visual lookout.");
    expect(c.aircraft.map((a) => a.probableCauseSectionKey)).toEqual(['probable_cause/aircraft-1', 'probable_cause/aircraft-2']);
  });

  it('DCA25MA108 stores the duplicated narratives once as event-scoped sections', () => {
    const c = get('DCA25MA108');
    expect(c.sections.map((s) => [s.key, s.kind, s.scope, s.aircraftKey, s.aircraftKeys])).toEqual([
      ['analysis/event', 'analysis', 'event', null, [1, 2]],
      ['probable_cause/event', 'probable_cause', 'event', null, [1, 2]],
    ]);
    expect(c.aircraft.map((a) => [a.aircraftNtsbNo, a.hasProbableCause, a.probableCauseSectionKey])).toEqual([
      ['DCA25MA108A', true, 'probable_cause/event'],
      ['DCA25MA108B', true, 'probable_cause/event'],
    ]);
    expect(c.aircraft.map((a) => a.definingPhaseGroup)).toEqual(['approach', 'en_route']);
    expect(c.definingPhaseGroup).toBe('approach');
    expect(c.sections[1]!.text.startsWith('The Federal Aviation Administration’s (FAA) placement')).toBe(true);
  });

  it('converts HTML cause narratives to canonical citation text and keeps the source', () => {
    const era = get('ERA24LA303').sections.find((s) => s.kind === 'probable_cause')!;
    expect(era.text).toBe('The in-flight separation of one of the wooden propeller blades for unknown reasons.');
    expect(era.transformedFromHtml).toBe(true);
    expect(era.sourceText.startsWith('<p style="margin-top:0pt;')).toBe(true);
    expect(era.sha256).toBe(sha256(era.text));
    expect(era.sourceSha256).toBe(sha256(era.sourceText));
    expect(era.citationTextVersion).toBe('v1');

    const cen = get('CEN24FA064').sections.find((s) => s.kind === 'probable_cause')!;
    expect(cen.text).toBe(
      'The pilot’s loss of control due to spatial disorientation while operating in instrument meteorological ' +
        'conditions. Contributing to the accident were the controller’s failure to issue an appropriate intercept ' +
        'angle for the final approach course, failure to advise the pilot that vectors would take the airplane ' +
        'through the final approach course, and the pilot’s entry of an incorrect heading into the autopilot.',
    );
    const wpr = get('WPR26LA114').sections.find((s) => s.kind === 'probable_cause')!;
    expect(wpr.text.startsWith('The pilot’s decision to operate the airplane with a known mechanical defect')).toBe(true);
    expect(wpr.text.endsWith('nosing over.')).toBe(true);
  });

  it('records which sections were transformed and leaves plain ones byte-identical', () => {
    const transformed = result.cases.flatMap((c) =>
      c.sections.filter((s) => s.transformedFromHtml).map((s) => `${c.ntsbNo}:${s.key}`),
    );
    expect(transformed.sort()).toEqual([
      'CEN19FA024:factual/aircraft-1',
      'CEN20LA361:analysis/aircraft-1',
      'CEN24FA064:probable_cause/aircraft-1',
      'ERA24LA303:probable_cause/aircraft-1',
      'WPR26LA114:probable_cause/aircraft-1',
    ]);
    for (const c of result.cases) {
      for (const s of c.sections.filter((x) => !x.transformedFromHtml)) {
        expect(s.text, `${c.ntsbNo}:${s.key}`).toBe(s.sourceText.replace(/\r\n/g, '\n'));
        expect(s.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('decodes stray markup inside otherwise plain narratives without losing paragraphs', () => {
    const factual = get('CEN19FA024').sections.find((s) => s.kind === 'factual')!;
    expect(factual.sourceText).toContain('<span style="color: black;">&nbsp;</span>');
    expect(factual.text).not.toContain('<span');
    expect(factual.text).toContain('horizon.    WRECKAGE AND IMPACT INFORMATION\n\nThe helicopter');
    const analysis = get('CEN20LA361').sections.find((s) => s.kind === 'analysis')!;
    expect(analysis.text).toContain('departure airport for a precautionary landing');
    expect(analysis.text).not.toContain('&nbsp;');
  });

  it('non-US ENG08WA029: markup-only cause is not a probable cause', () => {
    const c = get('ENG08WA029');
    expect([c.country, c.isUs, c.rawStatus, c.completionClass]).toEqual(['PE', false, 'B', 'completed']);
    expect(c.hasProbableCause).toBe(false);
    expect(c.answerEligible).toBe(false);
    expect(c.sections.map((s) => s.kind)).toEqual(['factual']);
    expect(c.location).toBeNull();
    expect(c.fields.highestInjury).toBeNull();
  });

  it('classifies P, blank and B-without-cause records', () => {
    const p = get('CEN23LA137');
    expect([p.rawStatus, p.completionClass, p.hasProbableCause, p.answerEligible]).toEqual(['P', 'other_status', false, false]);

    const blank = get('CEN22LA442');
    expect([blank.rawStatus, blank.completionClass, blank.answerEligible]).toEqual([null, 'other_status', false]);
    expect(blank.sections).toEqual([]);
    expect(blank.definingPhaseGroup).toBe('unknown');
    expect(blank.location).toBeNull();
    expect(blank.aircraft[0]!.category).toBeNull();

    const noCause = get('ENG10WA034');
    expect([noCause.rawStatus, noCause.completionClass, noCause.hasProbableCause, noCause.answerEligible]).toEqual([
      'B', 'completed', false, false,
    ]);
    expect(noCause.sequence).toEqual([]);
    expect(noCause.definingPhaseGroup).toBeNull();
    expect(noCause.aircraft[0]!.probableCauseSectionKey).toBeNull();
  });

  it('decodes source flags and code fields', () => {
    const sea = get('SEA08LA057');
    expect(sea.aircraft.map((a) => [a.homebuilt, a.afmHrsSince])).toEqual([[false, true], [true, true]]);
    expect(get('MIA08LA156').findings.map((f) => [f.findingNo, f.inProbableCause, f.causeFactor])).toEqual([
      [1, true, 'C'],
      [2, false, null],
    ]);
    expect(get('CEN24FA064').fields.wxCondBasic).toBe('IMC');
    expect(get('DCA25MA108').fields).toMatchObject({ lightCond: 'NITE', highestInjury: 'FATL', wxCondBasic: 'VMC' });
  });

  it('has a stable source revision per case', () => {
    const revisions = result.cases.map((c) => c.sourceRevision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (const r of revisions) expect(r).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeCorpus rules', () => {
  it('CRLF converted, NBSP preserved', () => {
    const source = 'The pilot reported\r\nfuel exhaustion. \r\n';
    const c = only(
      normalizeCorpus(corpus({ narratives: [row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_accp: source })] })),
    );
    const s = c.sections[0]!;
    expect(s.text).toBe('The pilot reported\nfuel exhaustion. \n');
    expect(s.sourceText).toBe(source);
    expect(s.transformedFromHtml).toBe(false);
    expect(s.sha256).toBe(sha256(s.text));
    expect(s.sourceSha256).toBe(sha256(source));
  });

  it('owner fields absent from CanonicalCase', () => {
    const secret = 'SECRET-OWNER-VALUE';
    const aircraft = [
      {
        ...row('aircraft', { ev_id: 'E1', aircraft_key: '1', ntsb_no: 'SYN08LA001' }),
        owner_acft: secret, owner_street: secret, owner_city: secret, oper_name: secret, oper_street: secret,
        lchg_userid: secret,
      },
    ];
    const events = [{ ...row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001' }), lchg_userid: secret, ntsb_notf_from: secret }];
    const json = JSON.stringify(normalizeCorpus(corpus({ aircraft, events })));
    expect(json).not.toContain(secret);
    expect(json).not.toMatch(/owner|oper_?name|lchg_?userid|notf/i);
  });

  it('resolves aircraft through ev_id + aircraft_key, never by the number suffix', () => {
    const tables = corpus({
      aircraft: [
        row('aircraft', { ev_id: 'E1', aircraft_key: '1', ntsb_no: 'SYN08LA001B' }),
        row('aircraft', { ev_id: 'E1', aircraft_key: '2', ntsb_no: 'SYN08LA001A' }),
      ],
      findings: [
        row('findings', { ev_id: 'E1', aircraft_key: '2', finding_no: '1', cm_inpc: 'T' }),
        row('findings', { ev_id: 'E1', aircraft_key: '3', finding_no: '1', cm_inpc: 'T' }),
      ],
    });
    const result = normalizeCorpus(tables);
    const c = only(result);
    expect(c.aircraft.map((a) => [a.aircraftKey, a.aircraftNtsbNo])).toEqual([[1, 'SYN08LA001B'], [2, 'SYN08LA001A']]);
    expect(c.findings.map((f) => f.aircraftKey)).toEqual([2]);
    expect(result.quarantine).toEqual([
      expect.objectContaining({ table: 'findings', reason: 'orphan_row', action: 'row_excluded', key: 'ev_id=E1,aircraft_key=3,finding_no=1' }),
    ]);
  });

  it('maps blank numbers and dates to null and keeps real zeros', () => {
    const c = only(
      normalizeCorpus(
        corpus({
          events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', ev_country: 'USA', wx_temp: '0', wind_vel_kts: '' })],
          aircraft: [row('aircraft', { ev_id: 'E1', aircraft_key: '1', afm_hrs: '', afm_hrs_last_insp: '0', num_eng: '' })],
        }),
      ),
    );
    expect(c.fields.wxTemp).toBe(0);
    expect(c.fields.windVelKts).toBeNull();
    expect(c.fields.evDate).toBeNull();
    expect(c.aircraft[0]).toMatchObject({ afmHrs: null, afmHrsLastInsp: 0, numEngines: null, dateLastInsp: null });
  });

  it('decodes cm_inpc T/F/blank to boolean | null', () => {
    const findings = ['T', 'F', ''].map((v, i) =>
      row('findings', { ev_id: 'E1', aircraft_key: '1', finding_no: String(i + 1), cm_inpc: v }),
    );
    const result = normalizeCorpus(corpus({ findings }));
    expect(only(result).findings.map((f) => f.inProbableCause)).toEqual([true, false, null]);
    expect(result.quarantine).toEqual([]);
  });

  it('nulls unknown flag values with a quarantine note', () => {
    const result = normalizeCorpus(
      corpus({
        aircraft: [row('aircraft', { ev_id: 'E1', aircraft_key: '1', afm_hrs_since: 'U' })],
        findings: [row('findings', { ev_id: 'E1', aircraft_key: '1', finding_no: '1', cm_inpc: 'X' })],
        events_sequence: [
          row('events_sequence', { ev_id: 'E1', aircraft_key: '1', occurrence_no: '1', phase_no: '450', defining_ev: 'Y' }),
        ],
      }),
    );
    const c = only(result);
    expect(c.aircraft[0]!.afmHrsSince).toBeNull();
    expect(c.findings[0]!.inProbableCause).toBeNull();
    expect(c.sequence[0]!.isDefining).toBeNull();
    expect(c.aircraft[0]!.definingPhaseGroup).toBeNull();
    expect(result.quarantine.map((q) => [q.table, q.column, q.reason, q.action, q.value])).toEqual([
      ['aircraft', 'afm_hrs_since', 'unknown_flag', 'value_nulled', 'U'],
      ['findings', 'cm_inpc', 'unknown_flag', 'value_nulled', 'X'],
      ['events_sequence', 'defining_ev', 'unknown_flag', 'value_nulled', 'Y'],
    ]);
  });

  it('nulls out-of-range coordinates with a note but keeps the case', () => {
    const result = normalizeCorpus(
      corpus({
        events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', dec_latitude: '223740', dec_longitude: '-80.5' })],
      }),
    );
    expect(only(result).location).toBeNull();
    expect(result.quarantine).toEqual([
      expect.objectContaining({ table: 'events', column: 'dec_latitude', reason: 'coordinate_out_of_range', action: 'value_nulled', value: '223740' }),
    ]);
  });

  it('accepts boundary coordinates and treats missing ones as null without a note', () => {
    const ok = normalizeCorpus(
      corpus({ events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', dec_latitude: '-90', dec_longitude: '180' })] }),
    );
    expect(only(ok).location).toEqual({ lat: -90, lon: 180 });
    const missing = normalizeCorpus(corpus({ events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001' })] }));
    expect(only(missing).location).toBeNull();
    expect(missing.quarantine).toEqual([]);
  });

  it('notes an incomplete coordinate pair', () => {
    const result = normalizeCorpus(
      corpus({ events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', dec_latitude: '', dec_longitude: '102.871948' })] }),
    );
    expect(only(result).location).toBeNull();
    expect(result.quarantine).toEqual([
      expect.objectContaining({ table: 'events', column: 'dec_latitude', reason: 'coordinate_incomplete', action: 'value_nulled' }),
    ]);
  });

  it('notes a non-numeric number instead of coercing it', () => {
    const result = normalizeCorpus(corpus({ aircraft: [row('aircraft', { ev_id: 'E1', aircraft_key: '1', afm_hrs: '12 hrs' })] }));
    expect(only(result).aircraft[0]!.afmHrs).toBeNull();
    expect(result.quarantine).toEqual([
      expect.objectContaining({ table: 'aircraft', column: 'afm_hrs', reason: 'invalid_number', value: '12 hrs' }),
    ]);
  });

  it('event scope needs the identical text on every aircraft of the event', () => {
    const tables = corpus({
      aircraft: ['1', '2', '3'].map((k) => row('aircraft', { ev_id: 'E1', aircraft_key: k })),
      narratives: [
        row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_accp: 'Shared.', narr_cause: 'Same cause.' }),
        row('narratives', { ev_id: 'E1', aircraft_key: '2', narr_accp: 'Shared.', narr_cause: 'Same cause.' }),
        row('narratives', { ev_id: 'E1', aircraft_key: '3', narr_accp: 'Different.', narr_cause: 'Same cause.' }),
      ],
    });
    const c = only(normalizeCorpus(tables));
    expect(c.sections.map((s) => s.key)).toEqual([
      'factual/aircraft-1', 'factual/aircraft-2', 'factual/aircraft-3', 'probable_cause/event',
    ]);
    expect(c.aircraft.every((a) => a.probableCauseSectionKey === 'probable_cause/event')).toBe(true);
  });

  it('keeps a cause on the aircraft that has it when another aircraft has none', () => {
    const tables = corpus({
      aircraft: ['1', '2'].map((k) => row('aircraft', { ev_id: 'E1', aircraft_key: k })),
      narratives: [
        row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_cause: '' }),
        row('narratives', { ev_id: 'E1', aircraft_key: '2', narr_cause: 'Only aircraft two.' }),
      ],
    });
    const c = only(normalizeCorpus(tables));
    expect(c.sections.map((s) => s.key)).toEqual(['probable_cause/aircraft-2']);
    expect(c.aircraft.map((a) => a.hasProbableCause)).toEqual([false, true]);
    expect(c.hasProbableCause).toBe(true);
  });

  it('takes the event defining phase from the lowest aircraft key that has one', () => {
    const tables = corpus({
      aircraft: ['1', '2'].map((k) => row('aircraft', { ev_id: 'E1', aircraft_key: k })),
      events_sequence: [
        row('events_sequence', { ev_id: 'E1', aircraft_key: '1', occurrence_no: '1', phase_no: '250', defining_ev: '0' }),
        row('events_sequence', { ev_id: 'E1', aircraft_key: '2', occurrence_no: '1', phase_no: '601', defining_ev: '1' }),
      ],
    });
    const c = only(normalizeCorpus(tables));
    expect(c.aircraft.map((a) => a.definingPhaseGroup)).toEqual([null, 'emergency_descent']);
    expect(c.definingPhaseGroup).toBe('emergency_descent');
    expect(c.phaseGroups).toEqual(['taxi', 'emergency_descent']);
  });

  it('notes an event without an admin row and keeps it outside the completed set', () => {
    const result = normalizeCorpus(corpus({ ntsb_admin: [] }));
    const c = only(result);
    expect([c.rawStatus, c.completionClass, c.answerEligible]).toEqual([null, 'other_status', false]);
    expect(result.quarantine).toEqual([expect.objectContaining({ table: 'ntsb_admin', reason: 'missing_admin_row', key: 'ev_id=E1' })]);
  });

  it('changes the source revision only when the source changes', () => {
    const a = only(normalizeCorpus(corpus())).sourceRevision;
    expect(only(normalizeCorpus(corpus())).sourceRevision).toBe(a);
    const changed = corpus({ narratives: [row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_cause: 'Synthetic cause!' })] });
    expect(only(normalizeCorpus(changed)).sourceRevision).not.toBe(a);
  });
});

describe('duplicate keys and required columns (A1)', () => {
  const dupCases: [TableName, Row][] = [
    ['events', row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA002' })],
    ['aircraft', row('aircraft', { ev_id: 'E1', aircraft_key: '1' })],
    ['engines', row('engines', { ev_id: 'E1', aircraft_key: '1', eng_no: '1' })],
    ['narratives', row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_cause: 'x' })],
    ['findings', row('findings', { ev_id: 'E1', aircraft_key: '1', finding_no: '1' })],
    ['events_sequence', row('events_sequence', { ev_id: 'E1', aircraft_key: '1', occurrence_no: '1' })],
    ['ntsb_admin', row('ntsb_admin', { ev_id: 'E1', rec_stat: 'P' })],
  ];
  for (const [table, dup] of dupCases) {
    it(`fails clearly on a duplicate ${table} key`, () => {
      const base = corpus() as unknown as Record<string, Row[]>;
      const existing = base[table] ?? [];
      const first = existing[0] ?? dup;
      const tables = { ...base, [table]: [first, dup] } as unknown as RawTables;
      expect(() => normalizeCorpus(tables)).toThrow(NormalizationError);
      expect(() => normalizeCorpus(tables)).toThrow(new RegExp(`${table}: duplicate key`));
    });
  }

  it('fails on a duplicate public case number', () => {
    const events = [
      row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001' }),
      row('events', { ev_id: 'E2', ntsb_no: 'SYN08LA001' }),
    ];
    expect(() => normalizeCorpus(corpus({ events }))).toThrow(/events: duplicate ntsb_no SYN08LA001/);
  });

  it('fails on a blank public case number', () => {
    expect(() => normalizeCorpus(corpus({ events: [row('events', { ev_id: 'E1', ntsb_no: ' ' })] }))).toThrow(
      /events: blank ntsb_no/,
    );
  });

  it('fails when a required column is missing', () => {
    const findings = [row('findings', { ev_id: 'E1', aircraft_key: '1', finding_no: '1' })];
    delete findings[0]!.cm_inpc;
    expect(() => normalizeCorpus(corpus({ findings }))).toThrow(/findings: required column "cm_inpc" missing/);
  });

  it('fails when a required table is missing', () => {
    const tables = { ...corpus() } as unknown as Record<string, unknown>;
    delete tables.ntsb_admin;
    expect(() => normalizeCorpus(tables as unknown as RawTables)).toThrow(/ntsb_admin: required table missing/);
  });
});

describe('malformed fixtures', () => {
  it('detects the duplicate key fixture', async () => {
    const tables = await readProjectedTables(join(MALFORMED, 'duplicate-key'));
    expect(() => normalizeCorpus(tables)).toThrow(/findings: duplicate key ev_id=SYN00DUP01,aircraft_key=1,finding_no=2 \(2 rows\)/);
  });

  it('quarantines the invalid values fixture without dropping cases', async () => {
    const result = normalizeCorpus(await readProjectedTables(join(MALFORMED, 'invalid-values')));
    expect(result.cases.map((c) => c.ntsbNo)).toEqual(['SYN00BAD01', 'SYN00BAD02']);
    expect(result.cases[0]!.location).toBeNull();
    expect(result.quarantine.map((q) => [q.table, q.key, q.column, q.reason])).toEqual([
      ['events', 'ev_id=SYN00BAD01', 'dec_latitude', 'coordinate_out_of_range'],
      ['aircraft', 'ev_id=SYN00BAD01,aircraft_key=1', 'afm_hrs_since', 'unknown_flag'],
      ['findings', 'ev_id=SYN00BAD01,aircraft_key=1,finding_no=1', 'cm_inpc', 'unknown_flag'],
      ['events_sequence', 'ev_id=SYN00BAD01,aircraft_key=1,occurrence_no=1', 'defining_ev', 'unknown_flag'],
      ['events', 'ev_id=SYN00BAD02', 'ev_date', 'invalid_date'],
      ['findings', 'ev_id=SYN00BAD02,aircraft_key=2,finding_no=1', null, 'orphan_row'],
    ]);
  });
});

describe('readProjectedTables', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aviation-normalize-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const copyFixtures = (target: string): void => {
    for (const t of ['events', 'aircraft', 'narratives', 'findings', 'events_sequence', 'ntsb_admin']) {
      copyFileSync(join(FIXTURES, `${t}.csv`), join(target, `${t}.csv`));
    }
  };

  it('reads the projected fixture tables', async () => {
    const tables = await readProjectedTables(FIXTURES);
    expect(tables.events).toHaveLength(15);
    expect(tables.aircraft).toHaveLength(17);
    expect(Object.keys(tables.events[0]!)).toEqual([...TABLE_SPECS.events.columns]);
  });

  it('treats optional tables as absent when their file is missing', async () => {
    const sub = mkdtempSync(join(dir, 'optional-'));
    copyFixtures(sub);
    const tables = await readProjectedTables(sub);
    expect(tables.engines).toBeUndefined();
    expect(tables.eadmspub_datadictionary).toBeUndefined();
  });

  it('fails when a required table file is missing', async () => {
    const sub = mkdtempSync(join(dir, 'missing-'));
    copyFixtures(sub);
    rmSync(join(sub, 'findings.csv'));
    await expect(readProjectedTables(sub)).rejects.toThrow(/findings: findings\.csv missing/);
  });

  it('rejects a column outside the allowlist', async () => {
    const sub = mkdtempSync(join(dir, 'extra-'));
    copyFixtures(sub);
    const header = [...TABLE_SPECS.ntsb_admin.columns, 'lchg_userid'].join(',');
    writeFileSync(join(sub, 'ntsb_admin.csv'), `${header}\nE1,B,,,someone\n`);
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: unexpected column "lchg_userid"/);
  });

  it('rejects a header missing an allowlisted column', async () => {
    const sub = mkdtempSync(join(dir, 'short-'));
    copyFixtures(sub);
    writeFileSync(join(sub, 'ntsb_admin.csv'), 'ev_id,rec_stat,approval_date\nE1,B,\n');
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: required column "lchg_date" missing/);
  });
});
