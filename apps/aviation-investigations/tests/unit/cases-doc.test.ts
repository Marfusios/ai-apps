import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { estypes } from '@elastic/elasticsearch';
import { beforeAll, describe, expect, it } from 'vitest';
import { assembleCaseRecords, type CaseRecord } from '../../server/db/queries/case-records.js';
import { OCCURRENCE_PHASE_TEXT, occurrenceEventLabel } from '../../shared/occurrences.js';
import { AVIATION_ANALYSIS, INDEX_ANALYZER, SEARCH_ANALYZER, SECTION_POSITION_GAP } from '../../worker/index/analysis.js';
import {
  CASES_INDEX_VERSION,
  CASES_MAPPING,
  CASES_SETTINGS,
  EARLIER_SERVABLE_CASES_VERSIONS,
  SERVABLE_CASES_VERSIONS,
  buildCaseDocument,
  casesAlias,
  casesIndexFingerprint,
  casesIndexName,
  isServableCasesIndex,
  newBuildId,
  type CaseDoc,
} from '../../worker/index/cases-index.js';
import {
  AVIATION_STOP_WORDS,
  AVIATION_SYNONYMS,
  ENGLISH_STOP_WORDS,
  NEGATION_WORDS,
  STEM_OVERRIDES,
} from '../../worker/index/synonyms.js';
import { fixtureCaseRecords } from '../support/case-records.js';
import { FIXTURES_DIR, readCsv } from '../support/extract-dir.js';

/**
 * The index definition this version was built with. Changing the mapping, the
 * analysis or the synonym list changes it: bump CASES_INDEX_VERSION and update both.
 */
const PINNED = { version: 'cases-v3', fingerprint: '2a6f1f58b54e6da00bb252ec921b44e22cd2c3f7f9a5d95e6d526913328545e9' };

let records: Map<string, CaseRecord>;

beforeAll(async () => {
  records = await fixtureCaseRecords();
});

function record(ntsbNo: string): CaseRecord {
  const r = records.get(ntsbNo);
  if (!r) throw new Error(`${ntsbNo} not in fixtures`);
  return r;
}

const doc = (ntsbNo: string): CaseDoc => buildCaseDocument(record(ntsbNo));
const usRecords = (): CaseRecord[] => [...records.values()].filter((r) => r.isUs);

/** Every key path of a document must be a mapped property (nested objects included). */
function unmappedKeys(value: Record<string, unknown>, properties: Record<string, estypes.MappingProperty>, path = ''): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    const prop = properties[key];
    const at = `${path}${key}`;
    if (!prop) {
      out.push(at);
      continue;
    }
    if (prop.type === 'nested') {
      const inner = (prop as estypes.MappingNestedProperty).properties ?? {};
      for (const item of v as Record<string, unknown>[]) out.push(...unmappedKeys(item, inner, `${at}.`));
    }
  }
  return out;
}

describe('buildCaseDocument', () => {
  it('doc for DFW08TA066 has nested aircraft category helicopter and defining_phase_group maneuvering', () => {
    const d = doc('DFW08TA066');
    expect(d.aircraft).toHaveLength(1);
    expect(d.aircraft[0]).toEqual({
      aircraft_key: 1,
      aircraft_ntsb_no: 'DFW08TA066',
      make: 'Hughes',
      model: 'OH-6',
      category: 'HELI',
      far_part: '091',
      purpose: 'PUBF',
      damage: 'SUBS',
      eng_types: ['TS'],
      homebuilt: false,
      defining_phase_group: 'maneuvering',
    });
    expect(d).toMatchObject({
      ntsb_no: 'DFW08TA066',
      ev_date: '2008-02-08',
      ev_year: 2008,
      country: 'USA',
      state: 'TX',
      city: 'Valentine',
      location: { lat: 30.585832, lon: -104.490554 },
      completion_class: 'completed',
      raw_status: 'B',
      answer_eligible: true,
      completed_with_cause: true,
      highest_injury: 'MINR',
      light: 'DAYL',
      wx_cond: 'VMC',
      defining_phase_groups: ['maneuvering'],
      sequence_phase_groups: ['maneuvering', 'emergency_descent'],
      defining_events: ['Loss of engine power (total)'],
      aircraft_count: 1,
    });
    expect(d.probable_cause).toHaveLength(1);
    expect(d.probable_cause[0]).toMatch(/^The contract mechanic's failure/);
    expect(d.analysis).toHaveLength(1);
    expect(d.factual).toHaveLength(1);
    expect(d.findings_text).toEqual([
      'Aircraft-Aircraft propeller/rotor-Rotorcraft flight control-(general)-Incorrect use/operation - C',
      'Aircraft-Aircraft handling/service-Maintenance/inspections-(general)-Incorrect service/maintenance - C',
    ]);
  });

  it('keeps each aircraft of a multi-aircraft event apart', () => {
    const sea = doc('SEA08LA057');
    expect(sea.aircraft_count).toBe(2);
    expect(sea.aircraft.map((a) => [a.aircraft_ntsb_no, a.make, a.homebuilt, a.defining_phase_group])).toEqual([
      ['SEA08LA057A', 'PIPER', false, 'landing'],
      ['SEA08LA057B', 'Barnard/Stancil', true, 'initial_climb'],
    ]);
    // Event-level phase groups in flight order, one per distinct defining phase.
    expect(sea.defining_phase_groups).toEqual(['initial_climb', 'landing']);
    expect(sea.defining_events).toEqual(['Midair collision']);

    const dca = doc('DCA25MA108');
    expect(dca.aircraft.map((a) => [a.make, a.category, a.eng_types, a.defining_phase_group])).toEqual([
      ['BOMBARDIER INC', 'AIR', ['TF'], 'approach'],
      ['SIKORSKY', 'HELI', ['TS'], 'en_route'],
    ]);
    expect(dca.defining_phase_groups).toEqual(['en_route', 'approach']);
  });

  it('refuses a foreign event', () => {
    const foreign = record('ENG08WA029');
    expect(foreign.isUs).toBe(false);
    expect(() => buildCaseDocument(foreign)).toThrow(/not a US event/);
    // Country is checked as well as the flag.
    expect(() => buildCaseDocument({ ...record('DFW08TA066'), country: 'PE' })).toThrow(/not a US event/);
  });

  it('indexes blanks as null and leaves location out without coordinates', () => {
    const d = doc('CEN22LA442');
    expect(d).not.toHaveProperty('location');
    expect(d).toMatchObject({
      raw_status: null,
      completion_class: 'other_status',
      answer_eligible: false,
      light: null,
      wx_cond: null,
      defining_phase_groups: ['unknown'],
      probable_cause: [],
    });
    expect(d.aircraft[0]).toMatchObject({ category: null, damage: null, eng_types: [] });

    const noSequence = doc('ENG10WA034');
    expect(noSequence).toMatchObject({ defining_phase_groups: [], sequence_phase_groups: [], defining_events: [] });
    expect(noSequence.aircraft[0]?.defining_phase_group).toBeNull();
  });

  it('keeps one value per section of each kind, trimmed', () => {
    const r = record('CEN24FA064');
    const d = buildCaseDocument(r);
    const kind = (k: string) => r.sections.filter((s) => s.kind === k).map((s) => s.text.trim());
    expect(d.probable_cause).toEqual(kind('probable_cause'));
    expect(d.analysis).toEqual(kind('analysis'));
    expect(d.factual).toEqual(kind('factual'));
    // HTML narratives are indexed as their canonical citation text.
    expect(d.probable_cause.join(' ')).not.toMatch(/<[a-z]/i);
    // Identical cause texts of two aircraft are one event-scoped section.
    expect(doc('SEA08LA057').probable_cause).toEqual(["The departing pilot's inadequate visual lookout."]);

    // Two sections of one kind stay two values (never one concatenated string).
    const dfw = record('DFW08TA066');
    const cause = dfw.sections.find((x) => x.kind === 'probable_cause');
    if (!cause) throw new Error('DFW08TA066 has no cause');
    const two = buildCaseDocument({
      ...dfw,
      sections: [...dfw.sections, { ...cause, sectionId: 'x', sectionKey: 'probable_cause/event-2', text: '  Second cause.\n' }],
    });
    expect(two.probable_cause).toEqual([cause.text.trim(), 'Second cause.']);
  });

  it('never contains the internal ev_id', () => {
    const evIds = readCsv(join(FIXTURES_DIR, 'events.csv')).map((e) => e.ev_id ?? '');
    for (const r of usRecords()) {
      const json = JSON.stringify(buildCaseDocument(r));
      expect(json).not.toMatch(/"ev_id"/);
      for (const id of evIds) expect(json).not.toContain(id);
    }
  });

  it('produces only mapped fields, and every mapped field', () => {
    const properties = CASES_MAPPING.properties ?? {};
    const seen = new Set<string>();
    for (const r of usRecords()) {
      const d = buildCaseDocument(r) as unknown as Record<string, unknown>;
      expect(unmappedKeys(d, properties)).toEqual([]);
      for (const k of Object.keys(d)) seen.add(k);
    }
    expect([...seen].sort()).toEqual(Object.keys(properties).sort());
  });
});

describe('cases index definition', () => {
  it('is strict, nested for aircraft and analyzed per A12', () => {
    expect(CASES_MAPPING.dynamic).toBe('strict');
    const p = CASES_MAPPING.properties ?? {};
    const aircraft = p.aircraft as estypes.MappingNestedProperty;
    expect(aircraft.type).toBe('nested');
    expect(aircraft.include_in_parent).toBeUndefined();
    expect(aircraft.include_in_root).toBeUndefined();
    expect(Object.keys(aircraft.properties ?? {}).sort()).toEqual([
      'aircraft_key', 'aircraft_ntsb_no', 'category', 'damage', 'defining_phase_group', 'eng_types', 'far_part',
      'homebuilt', 'make', 'model', 'purpose',
    ]);
    for (const field of ['probable_cause', 'analysis', 'factual', 'findings_text']) {
      expect(p[field]).toEqual({
        type: 'text',
        analyzer: INDEX_ANALYZER,
        search_analyzer: SEARCH_ANALYZER,
        search_quote_analyzer: INDEX_ANALYZER,
        index_options: 'offsets',
        position_increment_gap: SECTION_POSITION_GAP,
      });
    }
    expect(SECTION_POSITION_GAP).toBe(100);
    expect(p.location).toEqual({ type: 'geo_point' });
    expect(p.ev_date).toMatchObject({ type: 'date' });
    expect(p).not.toHaveProperty('ev_id');
    expect(CASES_SETTINGS).toMatchObject({ number_of_shards: 1, number_of_replicas: 0 });

    const analyzers = AVIATION_ANALYSIS.analyzer as Record<string, { filter: string[] }>;
    expect(analyzers[INDEX_ANALYZER]?.filter).toEqual([
      'lowercase', 'aviation_possessive', 'aviation_stop', 'aviation_stem_overrides', 'aviation_stemmer',
    ]);
    // Synonyms before stop words and stemming at search time.
    expect(analyzers[SEARCH_ANALYZER]?.filter).toEqual([
      'lowercase', 'aviation_possessive', 'aviation_synonyms', 'aviation_stop', 'aviation_stem_overrides', 'aviation_stemmer',
    ]);
    // Conservative KStem, not Porter (G3 ruling).
    expect((AVIATION_ANALYSIS.filter as Record<string, unknown>).aviation_stemmer).toEqual({ type: 'stemmer', language: 'light_english' });
  });

  it('is pinned to its version', () => {
    expect(CASES_INDEX_VERSION).toBe(PINNED.version);
    expect(casesIndexFingerprint(), 'index definition changed: bump CASES_INDEX_VERSION and the pin').toBe(PINNED.fingerprint);
  });

  it('still serves cases-v2, which differs from cases-v3 only by the glued-heading char filter', () => {
    // Rebuild the v2 definition from the current one: same mapping, analysis without
    // the char filter. Its fingerprint must be the one v2 indices were built with.
    const settings = structuredClone(CASES_SETTINGS);
    const analysis = settings.analysis as { char_filter: Record<string, unknown>; analyzer: Record<string, { char_filter?: string[] }> };
    delete analysis.char_filter.aviation_glued_heading;
    for (const analyzer of Object.values(analysis.analyzer)) {
      expect(analyzer.char_filter).toEqual(['aviation_glued_heading']);
      delete analyzer.char_filter;
    }
    const v2 = createHash('sha256').update(JSON.stringify({ version: 'cases-v2', settings, mapping: CASES_MAPPING })).digest('hex');
    expect(EARLIER_SERVABLE_CASES_VERSIONS).toEqual({ 'cases-v2': v2 });
    expect(SERVABLE_CASES_VERSIONS).toEqual(['cases-v3', 'cases-v2']);

    expect(isServableCasesIndex('cases-v3', casesIndexFingerprint())).toBe(true);
    expect(isServableCasesIndex('cases-v2', v2)).toBe(true);
    expect(isServableCasesIndex('cases-v3', v2)).toBe(false);
    expect(isServableCasesIndex('cases-v2', casesIndexFingerprint())).toBe(false);
    expect(isServableCasesIndex('cases-v1', v2)).toBe(false);
    expect(isServableCasesIndex('toString', v2)).toBe(false);
    expect(isServableCasesIndex(null, null)).toBe(false);
  });

  it('names indices per generation and version', () => {
    const at = new Date('2026-10-22T08:09:10.123Z');
    expect(casesIndexName('aviation', 42, at, '0a1b2c3d')).toBe('aviation-cases-v3-g42-20261022080910123-0a1b2c3d');
    expect(casesAlias('aviation')).toBe('aviation-cases');
    expect(() => casesIndexName('Aviation', 1, at, '0a1b2c3d')).toThrow(/prefix/);
    expect(() => casesIndexName('aviation-*', 1, at, '0a1b2c3d')).toThrow(/prefix/);
    expect(() => casesIndexName('aviation', 0, at, '0a1b2c3d')).toThrow(/generation/);
    expect(() => casesIndexName('aviation', 1, at, 'Bad-Id')).toThrow(/build id/);
    // Build ids are random: two builds at the same instant get different indices.
    expect(newBuildId()).toMatch(/^[0-9a-f]{8}$/);
    expect(newBuildId()).not.toBe(newBuildId());
  });
});

describe('synonyms and stop words', () => {
  it('never relate stall and spin', () => {
    for (const rule of AVIATION_SYNONYMS) expect(rule).not.toMatch(/\b(stall|spin)\b/);
  });

  it('never start or end a term with a stop word', () => {
    for (const rule of AVIATION_SYNONYMS) {
      for (const term of rule.split(/=>|,/).map((t) => t.trim())) {
        const words = term.split(' ');
        expect(AVIATION_STOP_WORDS, `${rule}: ${term}`).not.toContain(words[0]);
        expect(AVIATION_STOP_WORDS, `${rule}: ${term}`).not.toContain(words[words.length - 1]);
      }
    }
  });

  it('cover plurals and keep stem overrides one word each', () => {
    const terms = new Set(AVIATION_SYNONYMS.flatMap((r) => r.split(/=>|,/).map((t) => t.trim())));
    for (const t of ['carbs', 'carburetors', 'carburettors', 'cfis', 'flight instructors']) expect(terms).toContain(t);
    for (const rule of STEM_OVERRIDES) expect(rule).toMatch(/^[a-z]+ => [a-z]+$/);
  });

  it('are lower case, unstemmed Solr rules', () => {
    for (const rule of AVIATION_SYNONYMS) {
      expect(rule).toBe(rule.toLowerCase());
      const sides = rule.split('=>');
      expect(sides.length).toBeLessThanOrEqual(2);
      for (const side of sides) for (const term of side.split(',')) expect(term.trim()).toMatch(/^[a-z]+( [a-z]+)*$/);
    }
  });

  it('keep negations', () => {
    expect(ENGLISH_STOP_WORDS).toHaveLength(33);
    for (const w of NEGATION_WORDS) expect(AVIATION_STOP_WORDS).not.toContain(w);
    expect(AVIATION_STOP_WORDS).toEqual(ENGLISH_STOP_WORDS.filter((w) => w !== 'no' && w !== 'not'));
  });
});

describe('occurrenceEventLabel', () => {
  it('drops the phase text of the phase code', () => {
    expect(occurrenceEventLabel(450, 'Maneuvering Loss of engine power (total)')).toEqual({ label: 'Loss of engine power (total)', parsed: true });
    expect(occurrenceEventLabel(452, 'Maneuvering-low-alt flying Low altitude operation/event')).toEqual({
      label: 'Low altitude operation/event',
      parsed: true,
    });
    expect(occurrenceEventLabel(600, 'Emergency descent Collision with terr/obj (non-CFIT) ')?.label).toBe('Collision with terr/obj (non-CFIT)');
    expect(occurrenceEventLabel(990, 'Unknown Aircraft structural failure')?.label).toBe('Aircraft structural failure');
  });

  it('keeps an unexpected description whole', () => {
    expect(occurrenceEventLabel(450, 'Landing Hard landing')).toEqual({ label: 'Landing Hard landing', parsed: false });
    expect(occurrenceEventLabel(123, 'Something new')).toEqual({ label: 'Something new', parsed: false });
    expect(occurrenceEventLabel(null, 'Maneuvering')).toEqual({ label: 'Maneuvering', parsed: false });
    expect(occurrenceEventLabel(450, '  ')).toBeNull();
    expect(occurrenceEventLabel(450, null)).toBeNull();
  });

  it('labels every fixture defining event', () => {
    expect(Object.keys(OCCURRENCE_PHASE_TEXT)).toHaveLength(48);
    for (const r of records.values()) {
      for (const s of r.sequence) expect(occurrenceEventLabel(s.phaseNo, s.description)?.parsed).toBe(true);
    }
  });
});

describe('assembleCaseRecords', () => {
  const base = {
    ntsbNo: 'SYN08LA001', country: 'USA', isUs: true, latitude: null, longitude: null, evDate: '2008-01-01', evYear: 2008,
    city: null, state: null, lightCond: null, wxCondBasic: null, highestInjury: null, rawStatus: 'B',
    completionClass: 'completed' as const, hasProbableCause: false, completedWithCause: false, answerEligible: false,
    definingPhaseGroups: [], sequencePhaseGroups: [],
  };
  const aircraft = (key: number) => ({
    ntsbNo: 'SYN08LA001', aircraftKey: key, aircraftNtsbNo: null, make: null, model: null, category: null, farPart: null,
    purpose: null, damage: null, homebuilt: null, definingOccurrenceNo: null, definingPhaseGroup: null,
    definingEventConflict: false, sequencePhaseGroups: [],
  });
  const empty = { aircraft: [], engines: [], sections: [], findings: [], sequence: [] };

  it('orders children and engines by key', () => {
    const [r] = assembleCaseRecords(3, {
      ...empty,
      cases: [base],
      aircraft: [aircraft(2), aircraft(1)],
      engines: [
        { ntsbNo: 'SYN08LA001', aircraftKey: 1, engNo: 2, engType: 'REC' },
        { ntsbNo: 'SYN08LA001', aircraftKey: 1, engNo: 1, engType: 'TP' },
      ],
    });
    expect(r?.generationId).toBe(3);
    expect(r?.aircraft.map((a) => a.aircraftKey)).toEqual([1, 2]);
    expect(r?.aircraft[0]?.engines).toEqual([{ engNo: 1, engType: 'TP' }, { engNo: 2, engType: 'REC' }]);
    expect(r?.aircraft[1]?.engines).toEqual([]);
  });

  it('rejects orphans and duplicates', () => {
    expect(() => assembleCaseRecords(1, { ...empty, cases: [base], aircraft: [{ ...aircraft(1), ntsbNo: 'OTHER' }] })).toThrow(/no case/);
    expect(() =>
      assembleCaseRecords(1, { ...empty, cases: [base], engines: [{ ntsbNo: 'SYN08LA001', aircraftKey: 9, engNo: 1, engType: null }] }),
    ).toThrow(/missing aircraft/);
    expect(() => assembleCaseRecords(1, { ...empty, cases: [base, base] })).toThrow(/duplicate/);
  });
});
