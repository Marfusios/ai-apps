import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from '../../worker/ingest/tables.js';
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

/** Two or more aircraft on event E1. */
function aircraftRows(...keys: string[]): Row[] {
  return keys.map((k) => row('aircraft', { ev_id: 'E1', aircraft_key: k }));
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
      'WPR15FA010', 'WPR26LA114',
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
    expect(c.definingPhaseGroups).toEqual(['maneuvering']);
    expect(c.findings.filter((f) => f.inProbableCause === true)).toHaveLength(2);
    const cause = c.sections.find((s) => s.kind === 'probable_cause');
    expect(cause?.text.startsWith("The contract mechanic's failure")).toBe(true);
    expect([cause?.scope, cause?.aircraftKey, cause?.sourceAircraftKeys]).toEqual(['aircraft', 1, [1]]);
    expect(c.fields.evDate).toBe('2008-02-08');
    expect(c.location).toEqual({ lat: 30.585832, lon: -104.490554 });
    expect([c.rawStatus, c.completionClass, c.hasProbableCause, c.completedWithCause, c.answerEligible]).toEqual([
      'B', 'completed', true, true, true,
    ]);
    expect(a.engines).toEqual([{ engNo: 1, engType: 'TS', carbFuelInjection: null, lastChangedAt: expect.any(String) }]);
  });

  it('all four seed cases are US, completed and answer-eligible', () => {
    for (const no of ['DFW08TA066', 'MIA08LA156', 'DEN08LA103', 'NYC08LA106']) {
      const c = get(no);
      expect([c.isUs, c.country, c.completionClass, c.answerEligible], no).toEqual([true, 'USA', 'completed', true]);
      expect(c.sections.map((s) => [s.kind, s.scope]), no).toEqual([
        ['factual', 'aircraft'], ['analysis', 'aircraft'], ['probable_cause', 'aircraft'],
      ]);
    }
    expect(get('MIA08LA156').sections.at(-1)?.text).toBe('A partial loss of engine power for undetermined reasons.');
  });

  it('keeps the real CRLF in the source and none in citation text', () => {
    const factual = get('DFW08TA066').sections.find((s) => s.kind === 'factual')!;
    expect(factual.sourceText).toContain('\r\n');
    expect(factual.text).toBe(factual.sourceText.replace(/\r\n/g, '\n'));
    for (const c of result.cases) for (const s of c.sections) expect(s.text, `${c.ntsbNo}:${s.key}`).not.toContain('\r');
  });

  it('two-aircraft fixture keeps findings and sequence attributed to their aircraftKey', () => {
    const sea = get('SEA08LA057');
    expect(sea.findings.map((f) => [f.aircraftKey, f.findingNo])).toEqual([[1, 1], [2, 1]]);
    expect(sea.findings[0]!.description).toMatch(/Pilot of other aircraft - C$/);
    expect(sea.findings[1]!.description).toMatch(/-Pilot - C$/);

    const dca = get('DCA25MA108');
    const nos = (k: number): number[] => dca.findings.filter((f) => f.aircraftKey === k).map((f) => f.findingNo);
    expect(nos(1)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(nos(2)).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(dca.sequence.map((s) => [s.aircraftKey, s.phaseNo, s.isDefining])).toEqual([[1, 500, true], [2, 400, true]]);
    expect(dca.aircraft.map((a) => a.engines.length)).toEqual([2, 2]);
  });

  it('SEA08LA057 keeps each aircraft defining phase and lists both for the event', () => {
    const c = get('SEA08LA057');
    expect(c.aircraft.map((a) => [a.aircraftKey, a.aircraftNtsbNo, a.definingPhaseGroup])).toEqual([
      [1, 'SEA08LA057A', 'landing'],
      [2, 'SEA08LA057B', 'initial_climb'],
    ]);
    expect(c.definingPhaseGroups).toEqual(['landing', 'initial_climb']);
    expect(c.sequencePhaseGroups).toEqual(['initial_climb', 'landing']);
    expect(c.aircraft[0]!.definingEvent?.description).toBe('Landing Midair collision');
  });

  it('DCA25MA108 lists approach and en route as defining phases', () => {
    const c = get('DCA25MA108');
    expect(c.aircraft.map((a) => a.definingPhaseGroup)).toEqual(['approach', 'en_route']);
    expect(c.definingPhaseGroups).toEqual(['approach', 'en_route']);
  });

  it('SEA08LA057: every narrative section of a multi-aircraft event is event-scoped', () => {
    const c = get('SEA08LA057');
    expect(c.sections.map((s) => [s.key, s.scope, s.aircraftKey, s.sourceAircraftKeys])).toEqual([
      ['factual/event-1', 'event', null, [1, 2]],
      ['analysis/event-1', 'event', null, [1]],
      ['analysis/event-2', 'event', null, [2]],
      ['probable_cause/event-1', 'event', null, [1, 2]],
    ]);
    const cause = c.sections[3]!;
    // The two cause rows differ only by trailing CRLFs: one section, the lowest aircraft's text.
    expect(cause.text).toBe("The departing pilot's inadequate visual lookout.\n\n");
    expect(cause.sources.map((s) => [s.aircraftKey, s.match])).toEqual([[1, 'exact'], [2, 'whitespace']]);
    expect(cause.sources[1]!.sourceText).toBe("The departing pilot's inadequate visual lookout.");
    expect(cause.sources[1]!.sourceSha256).toBe(sha256("The departing pilot's inadequate visual lookout."));
    expect(c.sections[0]!.sources.map((s) => s.match)).toEqual(['exact', 'exact']);
  });

  it('DCA25MA108 stores the duplicated narratives once as event-scoped sections', () => {
    const c = get('DCA25MA108');
    expect(c.sections.map((s) => [s.key, s.kind, s.scope, s.aircraftKey, s.sourceAircraftKeys])).toEqual([
      ['analysis/event-1', 'analysis', 'event', null, [1, 2]],
      ['probable_cause/event-1', 'probable_cause', 'event', null, [1, 2]],
    ]);
    expect(c.sections[1]!.text.startsWith('The Federal Aviation Administration’s (FAA) placement')).toBe(true);
  });

  it('WPR15FA010: the cause naming the Savannah pilot is never attached to the Cessna', () => {
    const c = get('WPR15FA010');
    expect(c.aircraft.map((a) => [a.aircraftKey, a.make])).toEqual([[1, 'CESSNA'], [2, 'PETTIT']]);
    const causes = c.sections.filter((s) => s.kind === 'probable_cause');
    expect(causes).toHaveLength(1);
    const cause = causes[0]!;
    expect([cause.scope, cause.aircraftKey, cause.sourceAircraftKeys]).toEqual(['event', null, [1, 2]]);
    expect(cause.text.startsWith('The failure of the Savannah pilot to maintain awareness')).toBe(true);
    expect(cause.sources.map((s) => s.match)).toEqual(['exact', 'whitespace']);
    expect(c.sections.every((s) => s.scope === 'event' && s.aircraftKey === null)).toBe(true);
    // Different factual narratives per row become separate event-scoped variants.
    expect(c.sections.filter((s) => s.kind === 'factual').map((s) => s.sourceAircraftKeys)).toEqual([[1], [2]]);
    expect(JSON.stringify(c.aircraft)).not.toContain('Savannah pilot');
    expect(c.definingPhaseGroups).toEqual(['en_route', 'initial_climb']);
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

  it('records which sections were transformed and leaves plain ones unchanged except line ends', () => {
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
    expect(result.stats.htmlTransformedSections).toBe(5);
    expect(result.stats.htmlTagLikeSections).toBe(0);
    for (const c of result.cases) {
      for (const s of c.sections.filter((x) => !x.transformedFromHtml)) {
        expect(s.text, `${c.ntsbNo}:${s.key}`).toBe(s.sourceText.replace(/\r\n?/g, '\n'));
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
    expect([c.hasProbableCause, c.completedWithCause, c.answerEligible]).toEqual([false, false, false]);
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
    expect(blank.definingPhaseGroups).toEqual(['unknown']);
    expect(blank.location).toBeNull();
    expect(blank.aircraft[0]!.category).toBeNull();

    const noCause = get('ENG10WA034');
    expect([noCause.rawStatus, noCause.completionClass, noCause.hasProbableCause, noCause.completedWithCause]).toEqual([
      'B', 'completed', false, false,
    ]);
    expect(noCause.sequence).toEqual([]);
    expect(noCause.definingPhaseGroups).toEqual([]);
    expect(noCause.aircraft[0]!.definingPhaseGroup).toBeNull();
  });

  it('decodes source flags and keeps finding cause labels raw', () => {
    const sea = get('SEA08LA057');
    expect(sea.aircraft.map((a) => [a.homebuilt, a.afmHrsSince])).toEqual([[false, true], [true, true]]);
    expect(get('MIA08LA156').findings.map((f) => [f.findingNo, f.inProbableCause, f.causeFactorRaw])).toEqual([
      [1, true, 'C'],
      [2, false, ' '],
    ]);
    expect(get('CEN24FA064').fields.wxCondBasic).toBe('IMC');
    expect(get('DCA25MA108').fields).toMatchObject({ lightCond: 'NITE', highestInjury: 'FATL', wxCondBasic: 'VMC' });
  });

  it('reports US-scoped stats', () => {
    expect(result.stats).toMatchObject({
      events: 16,
      usEvents: 15,
      multiAircraftEvents: 3,
      answerEligibleUs: 12,
      completedWithoutCauseUs: 1,
      eventsWithSeveralDefiningPhases: 3,
      definingConflicts: 0,
    });
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

  it('joins and checks keys on the same canonical tuple', () => {
    const tables = corpus({
      aircraft: [row('aircraft', { ev_id: 'E1', aircraft_key: '01' })],
      narratives: [row('narratives', { ev_id: ' E1', aircraft_key: '1', narr_cause: 'Joined.' })],
      findings: [row('findings', { ev_id: 'E1', aircraft_key: '001', finding_no: '07', cm_inpc: 'T' })],
    });
    const c = only(normalizeCorpus(tables));
    expect(c.aircraft.map((a) => a.aircraftKey)).toEqual([1]);
    expect(c.sections.map((s) => [s.key, s.text])).toEqual([['probable_cause/aircraft-1', 'Joined.']]);
    expect(c.findings.map((f) => [f.aircraftKey, f.findingNo])).toEqual([[1, 7]]);
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

  it('decodes cm_inpc T/F/blank to boolean | null and keeps cause_factor and descriptions verbatim', () => {
    const findings = ['T', 'F', ''].map((v, i) =>
      row('findings', {
        ev_id: 'E1', aircraft_key: '1', finding_no: String(i + 1), cm_inpc: v,
        cause_factor: ['C', ' ', ''][i]!, finding_description: 'Aircraft-Fuel system - C ',
      }),
    );
    const result = normalizeCorpus(corpus({ findings }));
    const f = only(result).findings;
    expect(f.map((x) => x.inProbableCause)).toEqual([true, false, null]);
    expect(f.map((x) => x.causeFactorRaw)).toEqual(['C', ' ', null]);
    expect(f[0]!.description).toBe('Aircraft-Fuel system - C ');
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

  it('single-aircraft events keep aircraft scope', () => {
    const c = only(normalizeCorpus(corpus()));
    expect(c.sections.map((s) => [s.key, s.scope, s.aircraftKey, s.sourceAircraftKeys])).toEqual([
      ['probable_cause/aircraft-1', 'aircraft', 1, [1]],
    ]);
  });

  it('multi-aircraft narratives are event-scoped, merged by text and split into variants', () => {
    const tables = corpus({
      aircraft: aircraftRows('1', '2', '3'),
      narratives: [
        row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_accp: 'Shared  text.\r\n', narr_cause: 'Same cause.' }),
        row('narratives', { ev_id: 'E1', aircraft_key: '2', narr_accp: 'Shared text.', narr_cause: 'Same cause.' }),
        row('narratives', { ev_id: 'E1', aircraft_key: '3', narr_accp: 'Different.', narr_cause: 'Same cause.' }),
      ],
    });
    const result = normalizeCorpus(tables);
    const c = only(result);
    expect(c.sections.map((s) => [s.key, s.scope, s.aircraftKey, s.sourceAircraftKeys, s.text])).toEqual([
      ['factual/event-1', 'event', null, [1, 2], 'Shared  text.\n'],
      ['factual/event-2', 'event', null, [3], 'Different.'],
      ['probable_cause/event-1', 'event', null, [1, 2, 3], 'Same cause.'],
    ]);
    const merged = c.sections[0]!;
    expect(merged.sources.map((s) => [s.aircraftKey, s.match, s.sourceSha256])).toEqual([
      [1, 'exact', sha256('Shared  text.\r\n')],
      [2, 'whitespace', sha256('Shared text.')],
    ]);
    expect(merged.sourceText).toBe('Shared  text.\r\n');
    expect(c.sections[2]!.sources.map((s) => s.match)).toEqual(['exact', 'exact', 'exact']);
    expect(result.stats.whitespaceMergedRows).toBe(1);
    expect(result.stats.eventScopedSectionsByKind).toEqual({ factual: 2, analysis: 0, probable_cause: 1 });
    expect(c.aircraft.every((a) => !('probableCauseSectionKey' in a) && !('hasProbableCause' in a))).toBe(true);
  });

  it('a cause recorded on one aircraft of a multi-aircraft event is still event-scoped', () => {
    const tables = corpus({
      aircraft: aircraftRows('1', '2'),
      narratives: [
        row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_cause: '' }),
        row('narratives', { ev_id: 'E1', aircraft_key: '2', narr_cause: 'Recorded on aircraft two.' }),
      ],
    });
    const c = only(normalizeCorpus(tables));
    expect(c.sections.map((s) => [s.key, s.scope, s.aircraftKey, s.sourceAircraftKeys])).toEqual([
      ['probable_cause/event-1', 'event', null, [2]],
    ]);
    expect(c.hasProbableCause).toBe(true);
  });

  it('lists the distinct defining phases of all aircraft in aircraft-key order', () => {
    const seq = (key: string, phase: string, defining: string): Row =>
      row('events_sequence', { ev_id: 'E1', aircraft_key: key, occurrence_no: '1', phase_no: phase, defining_ev: defining });
    const tables = corpus({
      aircraft: aircraftRows('1', '2', '3', '4'),
      events_sequence: [seq('1', '250', '1'), seq('2', '550', '1'), seq('3', '252', '1'), seq('4', '601', '0')],
    });
    const c = only(normalizeCorpus(tables));
    expect(c.aircraft.map((a) => a.definingPhaseGroup)).toEqual(['taxi', 'landing', 'taxi', null]);
    expect(c.definingPhaseGroups).toEqual(['taxi', 'landing']);
    expect(c.sequencePhaseGroups).toEqual(['taxi', 'landing', 'emergency_descent']);
    expect('definingPhaseGroup' in c).toBe(false);
  });

  it('leaves an aircraft with conflicting defining flags without a defining event', () => {
    const tables = corpus({
      aircraft: aircraftRows('1', '2'),
      events_sequence: [
        row('events_sequence', { ev_id: 'E1', aircraft_key: '1', occurrence_no: '1', phase_no: '402', defining_ev: '1' }),
        row('events_sequence', { ev_id: 'E1', aircraft_key: '1', occurrence_no: '2', phase_no: '550', defining_ev: '1' }),
        row('events_sequence', { ev_id: 'E1', aircraft_key: '2', occurrence_no: '1', phase_no: '350', defining_ev: '1' }),
      ],
    });
    const result = normalizeCorpus(tables);
    const c = only(result);
    expect(c.sequence).toHaveLength(3);
    expect(c.aircraft.map((a) => [a.definingEvent?.occurrenceNo ?? null, a.definingPhaseGroup, a.definingEventConflict])).toEqual([
      [null, null, true],
      [1, 'initial_climb', false],
    ]);
    expect(c.definingPhaseGroups).toEqual(['initial_climb']);
    expect(result.quarantine).toEqual([
      expect.objectContaining({
        table: 'events_sequence', key: 'ev_id=E1,aircraft_key=1', column: 'defining_ev',
        reason: 'conflicting_defining_events', action: 'value_nulled',
      }),
    ]);
    expect(result.stats.definingConflicts).toBe(1);
  });

  it('limits answer eligibility to US events', () => {
    const foreign = normalizeCorpus(
      corpus({ events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', ev_country: 'GB' })] }),
    );
    const c = only(foreign);
    expect([c.isUs, c.completedWithCause, c.answerEligible]).toEqual([false, true, false]);
    expect(foreign.stats).toMatchObject({ completedWithCause: 1, answerEligibleUs: 0 });

    const noCause = normalizeCorpus(corpus({ narratives: [] }));
    expect(noCause.stats).toMatchObject({ completedWithoutCause: 1, completedWithoutCauseUs: 1, answerEligibleUs: 0 });
  });

  it('counts and notes tag-like text left after HTML conversion', () => {
    const result = normalizeCorpus(
      corpus({
        narratives: [row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_accp: '<p>he said <unintelligible> then</p>' })],
      }),
    );
    expect(only(result).sections[0]!.text).toBe('he said <unintelligible> then');
    expect(result.stats.htmlTagLikeSections).toBe(1);
    expect(result.quarantine).toEqual([
      expect.objectContaining({
        table: 'narratives', key: 'ev_id=E1,aircraft_key=1', column: 'narr_accp',
        reason: 'tag_like_text_after_html', action: 'value_kept',
      }),
    ]);
  });

  it('notes an event without an admin row and keeps it outside the completed set', () => {
    const result = normalizeCorpus(corpus({ ntsb_admin: [] }));
    const c = only(result);
    expect([c.rawStatus, c.completionClass, c.answerEligible]).toEqual([null, 'other_status', false]);
    expect(result.quarantine).toEqual([expect.objectContaining({ table: 'ntsb_admin', reason: 'missing_admin_row', key: 'ev_id=E1' })]);
  });

  it('quarantines an engine row with a blank eng_no', () => {
    const result = normalizeCorpus(
      corpus({
        engines: [
          row('engines', { ev_id: 'E1', aircraft_key: '1', eng_no: '', eng_type: 'REC' }),
          row('engines', { ev_id: 'E1', aircraft_key: '1', eng_no: '2', eng_type: 'REC' }),
        ],
      }),
    );
    expect(only(result).aircraft[0]!.engines.map((e) => e.engNo)).toEqual([2]);
    expect(result.quarantine).toEqual([
      expect.objectContaining({ table: 'engines', column: 'eng_no', reason: 'invalid_key', action: 'row_excluded' }),
    ]);
  });

  it('quarantines key parts and integers beyond the 32-bit range instead of failing the load (D-M2)', () => {
    const result = normalizeCorpus(
      corpus({
        events: [row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001', ev_country: 'USA', ev_date: '2008-03-01T00:00:00', ev_time: '9999999999' })],
        aircraft: [...aircraftRows('1'), row('aircraft', { ev_id: 'E1', aircraft_key: '3000000000', acft_make: 'Synthetic' })],
        engines: [row('engines', { ev_id: 'E1', aircraft_key: '1', eng_no: '2147483648', eng_type: 'REC' })],
      }),
    );
    const c = only(result);
    expect(c.aircraft.map((a) => a.aircraftKey)).toEqual([1]);
    expect(c.aircraft[0]!.engines).toEqual([]);
    expect(c.fields.evTime).toBeNull();
    expect(result.quarantine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'aircraft', column: 'aircraft_key', reason: 'invalid_key', action: 'row_excluded', value: '3000000000' }),
        expect.objectContaining({ table: 'engines', column: 'eng_no', reason: 'invalid_key', action: 'row_excluded', value: '2147483648' }),
        expect.objectContaining({ table: 'events', column: 'ev_time', reason: 'invalid_number', action: 'value_nulled', value: '9999999999' }),
      ]),
    );
    // 2^31 - 1 is the largest key part PostgreSQL's integer holds: kept.
    const max = only(normalizeCorpus(corpus({ aircraft: aircraftRows('2147483647'), narratives: [] })));
    expect(max.aircraft.map((a) => a.aircraftKey)).toEqual([2147483647]);
  });

  it('nulls a value with a NUL byte, with a quarantine note, and loads the rest of the case (D-M2)', () => {
    const result = normalizeCorpus(
      corpus({
        aircraft: [row('aircraft', { ev_id: 'E1', aircraft_key: '1', ntsb_no: 'SYN08LA001', acft_make: 'Pip\u0000er', acft_model: 'PA-28' })],
        narratives: [row('narratives', { ev_id: 'E1', aircraft_key: '1', narr_accp: 'Fine text.', narr_cause: 'Broken \u0000 cause.' })],
      }),
    );
    const c = only(result);
    expect(c.aircraft[0]!.make).toBeNull();
    expect(c.aircraft[0]!.model).toBe('PA-28');
    // The cause is gone; the other narrative of the row stays.
    expect(c.sections.map((s) => s.text)).toEqual(['Fine text.']);
    expect(result.quarantine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'aircraft', column: 'acft_make', reason: 'invalid_text', action: 'value_nulled', value: null }),
        expect.objectContaining({ table: 'narratives', column: 'narr_cause', reason: 'invalid_text', action: 'value_nulled', value: null }),
      ]),
    );
    expect(result.quarantine).toHaveLength(2);
  });

  it('stops on a NUL byte in an event identity, naming every offender (D-M2)', () => {
    const tables = corpus({
      events: [
        row('events', { ev_id: 'E\u00001', ntsb_no: 'SYN08LA001', ev_country: 'USA' }),
        row('events', { ev_id: 'E2', ntsb_no: 'SYN08\u0000LA002', ev_country: 'USA' }),
      ],
    });
    expect(() => normalizeCorpus(tables)).toThrow(NormalizationError);
    const err = (() => {
      try {
        normalizeCorpus(tables);
      } catch (e) {
        return e as NormalizationError;
      }
      return null;
    })();
    expect(err?.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/^events: blank or invalid ev_id/), expect.stringMatching(/^events: ntsb_no of ev_id=E2 contains a NUL character/)]),
    );
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

  const spellings: [TableName, Row, Row, string][] = [
    ['events', row('events', { ev_id: 'E1', ntsb_no: 'SYN08LA001' }), row('events', { ev_id: ' E1 ', ntsb_no: 'SYN08LA009' }), 'ev_id=E1'],
    ['aircraft', row('aircraft', { ev_id: 'E1', aircraft_key: '1' }), row('aircraft', { ev_id: 'E1', aircraft_key: '01' }), 'ev_id=E1,aircraft_key=1'],
    [
      'engines', row('engines', { ev_id: 'E1', aircraft_key: '1', eng_no: '2' }),
      row('engines', { ev_id: 'E1', aircraft_key: '001', eng_no: '02' }), 'ev_id=E1,aircraft_key=1,eng_no=2',
    ],
    [
      'narratives', row('narratives', { ev_id: 'E1', aircraft_key: '1' }),
      row('narratives', { ev_id: 'E1', aircraft_key: '0001' }), 'ev_id=E1,aircraft_key=1',
    ],
    [
      'findings', row('findings', { ev_id: 'E1', aircraft_key: '1', finding_no: '2' }),
      row('findings', { ev_id: 'E1', aircraft_key: '1', finding_no: '02' }), 'ev_id=E1,aircraft_key=1,finding_no=2',
    ],
    [
      'events_sequence', row('events_sequence', { ev_id: 'E1', aircraft_key: '1', occurrence_no: '3' }),
      row('events_sequence', { ev_id: 'E1', aircraft_key: '01', occurrence_no: '003' }),
      'ev_id=E1,aircraft_key=1,occurrence_no=3',
    ],
  ];
  for (const [table, a, b, key] of spellings) {
    it(`detects a ${table} duplicate written with different numeric spellings`, () => {
      const tables = corpus({ [table]: [a, b] });
      expect(() => normalizeCorpus(tables)).toThrow(`${table}: duplicate key ${key} (2 rows; source keys:`);
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

describe('committed fixtures', () => {
  it('contain only TABLE_SPECS columns, in spec order', () => {
    const dirs = [FIXTURES, join(MALFORMED, 'duplicate-key'), join(MALFORMED, 'invalid-values')];
    for (const dir of dirs) {
      for (const file of readdirSync(dir)) {
        const table = file.replace(/\.csv$/, '') as TableName;
        expect(TABLE_NAMES, `${dir}/${file}`).toContain(table);
        const header = readFileSync(join(dir, file), 'utf8').split('\n', 1)[0];
        expect(header, `${dir}/${file}`).toBe(TABLE_SPECS[table].columns.join(','));
      }
    }
  });
});

describe('readProjectedTables', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aviation-normalize-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const REQUIRED = ['events', 'aircraft', 'narratives', 'findings', 'events_sequence', 'ntsb_admin'];
  const copyFixtures = (target: string): void => {
    for (const t of REQUIRED) copyFileSync(join(FIXTURES, `${t}.csv`), join(target, `${t}.csv`));
  };
  const scratch = (name: string): string => {
    const sub = mkdtempSync(join(dir, `${name}-`));
    copyFixtures(sub);
    return sub;
  };

  it('reads the projected fixture tables', async () => {
    const tables = await readProjectedTables(FIXTURES);
    expect(tables.events).toHaveLength(16);
    expect(tables.aircraft).toHaveLength(19);
    expect(tables.engines?.length).toBeGreaterThan(0);
    expect(Object.keys(tables.events[0]!)).toEqual([...TABLE_SPECS.events.columns]);
  });

  it('treats optional tables as absent when their file is missing', async () => {
    const tables = await readProjectedTables(scratch('optional'));
    expect(tables.engines).toBeUndefined();
    expect(tables.eadmspub_datadictionary).toBeUndefined();
  });

  it('accepts a header-only table', async () => {
    const sub = scratch('header-only');
    writeFileSync(join(sub, 'findings.csv'), `${TABLE_SPECS.findings.columns.join(',')}\n`);
    const tables = await readProjectedTables(sub);
    expect(tables.findings).toEqual([]);
  });

  it('fails when a required table file is missing', async () => {
    const sub = scratch('missing');
    rmSync(join(sub, 'findings.csv'));
    await expect(readProjectedTables(sub)).rejects.toThrow(/findings: findings\.csv missing/);
  });

  it('fails on a required table file without a header', async () => {
    const sub = scratch('empty');
    writeFileSync(join(sub, 'ntsb_admin.csv'), '');
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: .*no header row/);
  });

  it('fails on malformed UTF-8', async () => {
    const sub = scratch('encoding');
    const header = Buffer.from(`${TABLE_SPECS.ntsb_admin.columns.join(',')}\nE1,`, 'utf8');
    writeFileSync(join(sub, 'ntsb_admin.csv'), Buffer.concat([header, Buffer.from([0xc3, 0x28]), Buffer.from(',,\n')]));
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: .*invalid UTF-8/);
  });

  it('fails on a record with more fields than the header', async () => {
    const sub = scratch('wide');
    writeFileSync(join(sub, 'ntsb_admin.csv'), `${TABLE_SPECS.ntsb_admin.columns.join(',')}\nE1,B,,,extra\n`);
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: cannot read/);
  });

  it('rejects a column outside the allowlist', async () => {
    const sub = scratch('extra');
    const header = [...TABLE_SPECS.ntsb_admin.columns, 'lchg_userid'].join(',');
    writeFileSync(join(sub, 'ntsb_admin.csv'), `${header}\nE1,B,,,someone\n`);
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: unexpected column "lchg_userid"/);
  });

  it('rejects a header missing an allowlisted column', async () => {
    const sub = scratch('short');
    writeFileSync(join(sub, 'ntsb_admin.csv'), 'ev_id,rec_stat,approval_date\nE1,B,\n');
    await expect(readProjectedTables(sub)).rejects.toThrow(/ntsb_admin: required column "lchg_date" missing/);
  });
});
