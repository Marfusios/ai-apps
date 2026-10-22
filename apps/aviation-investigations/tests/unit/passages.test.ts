import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CaseRecord } from '../../server/db/queries/case-records.js';
import { CHUNKER_VERSION } from '../../worker/index/chunk.js';
import { embeddingCacheKey } from '../../worker/index/embedding-cache.js';
import {
  EMBEDDING_INPUT_TEMPLATE_VERSION,
  buildCasePassages,
  passageEmbeddingInput,
  passageHeader,
  passageId,
} from '../../worker/index/passages.js';
import {
  IncompleteEventAircraftError,
  PASSAGES_EMBEDDING_DIMS,
  PASSAGES_INDEX_VERSION,
  PASSAGES_MAPPING,
  PASSAGES_SETTINGS,
  PASSAGES_V1_MAPPING,
  buildPassageDocument,
  eventAircraftCount,
  hasCompleteEventAircraft,
  passagesAlias,
  passagesIndexFingerprint,
  passagesIndexName,
  type EventAircraftSets,
} from '../../worker/index/passages-index.js';
import { fixtureCaseRecords } from '../support/case-records.js';

let records: Map<string, CaseRecord>;

beforeAll(async () => {
  records = await fixtureCaseRecords();
});

function record(ntsbNo: string): CaseRecord {
  const r = records.get(ntsbNo);
  if (!r) throw new Error(`${ntsbNo} not in fixtures`);
  return r;
}

const copy = (r: CaseRecord): CaseRecord => structuredClone(r);

describe('buildCasePassages', () => {
  it('scopes a single-aircraft case to its aircraft: own filters, own header', () => {
    const r = record('NYC08LA106');
    const { passages } = buildCasePassages(r);
    expect(passages.length).toBeGreaterThan(0);
    for (const p of passages) {
      expect(p).toMatchObject({ scope: 'aircraft', aircraftSpecific: true, aircraftKey: 1, ntsbNo: 'NYC08LA106' });
      expect(p.aircraft).toEqual([
        expect.objectContaining({ aircraft_key: 1, make: 'Raytheon', model: 'A36', defining_phase_group: 'en_route' }),
      ]);
      expect(p.header).toMatch(/^(Factual narrative|Analysis|Probable cause) · Raytheon A36 · En route$/);
      expect(p.input).toBe(`${p.header}\n${p.text}`);
      expect(p.filters).toMatchObject({ country: 'USA', answer_eligible: true, ev_year: 2008, defining_phase_groups: ['en_route'] });
    }
  });

  it('flags event-scoped passages of a multi-aircraft event as not aircraft-specific, with an event header', () => {
    for (const ntsbNo of ['DCA25MA108', 'SEA08LA057', 'WPR15FA010']) {
      const r = record(ntsbNo);
      const { passages } = buildCasePassages(r);
      expect(passages.length).toBeGreaterThan(0);
      for (const p of passages) {
        expect(p).toMatchObject({ scope: 'event', aircraftSpecific: false, aircraftKey: null });
        expect(p.aircraft.map((a) => a.aircraft_key)).toEqual(r.aircraft.map((a) => a.aircraftKey));
        expect(p.header).toContain(' · Event (2 aircraft)');
        // Never the single-aircraft header of either aircraft.
        for (const a of r.aircraft) expect(p.header).not.toContain(`${a.make} ${a.model}`);
      }
    }
    const dca = buildCasePassages(record('DCA25MA108')).passages.find((p) => p.kind === 'probable_cause');
    expect(dca?.header).toBe('Probable cause · Event (2 aircraft) · En route / Approach');
    expect(dca?.aircraft.map((a) => a.make)).toEqual(['BOMBARDIER INC', 'SIKORSKY']);
  });

  it('refuses non-US and not answer-eligible cases (A2)', () => {
    expect(() => buildCasePassages(record('ENG08WA029'))).toThrow(/not a US event/);
    expect(() => buildCasePassages(record('CEN23LA137'))).toThrow(/not answer-eligible/);
    expect(() => buildCasePassages(record('ENG10WA034'))).toThrow(/not answer-eligible/);
  });

  it('refuses a section scope that contradicts the aircraft count (A3)', () => {
    const multi = copy(record('SEA08LA057'));
    const s = multi.sections[0];
    if (!s) throw new Error('no section');
    Object.assign(s, { scope: 'aircraft', aircraftKey: 1 });
    expect(() => buildCasePassages(multi)).toThrow(/needs a single-aircraft event/);

    const single = copy(record('NYC08LA106'));
    Object.assign(single.sections[0] as object, { scope: 'event', aircraftKey: null });
    expect(() => buildCasePassages(single)).toThrow(/needs a multi-aircraft event/);
  });

  it('identifies passages by revision, offsets and chunker version', () => {
    const { passages } = buildCasePassages(record('CEN24FA064'));
    const ids = passages.map((p) => p.passageId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of passages) {
      expect(p.passageId).toBe(passageId(p.revisionId, p.start, p.end, CHUNKER_VERSION));
      expect(p.passageId).not.toBe(passageId(p.revisionId, p.start, p.end, 'chunk-v0'));
      expect(p.passageId).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(buildCasePassages(record('CEN24FA064')).passages).toEqual(passages);
  });
});

describe('passage header and embedding input', () => {
  it('leaves out empty parts and vague phases', () => {
    expect(passageHeader('analysis', { scope: 'aircraft', aircraft: [{ make: '  CESSNA ', model: '172\nS', definingPhaseGroup: 'unknown' }] })).toBe(
      'Analysis · CESSNA 172 S',
    );
    expect(passageHeader('factual', { scope: 'aircraft', aircraft: [{ make: null, model: null, definingPhaseGroup: 'landing' }] })).toBe(
      'Factual narrative · Landing',
    );
    expect(() => passageHeader('factual', { scope: 'aircraft', aircraft: [] })).toThrow();
  });

  it('keys the cache on the exact input, model, dims and template version: a header change invalidates it (A10)', () => {
    const p = { kind: 'probable_cause' as const, text: 'The pilot’s failure to maintain control.' };
    const a = passageEmbeddingInput(p, { scope: 'aircraft', aircraft: [{ make: 'CESSNA', model: '172S', definingPhaseGroup: 'landing' }] });
    const b = passageEmbeddingInput(p, { scope: 'aircraft', aircraft: [{ make: 'CESSNA', model: '172S', definingPhaseGroup: 'takeoff' }] });
    const key = (input: string, over: Partial<{ model: string; dims: number; templateVersion: string }> = {}) =>
      embeddingCacheKey({ input, model: 'text-embedding-3-small', dims: 1536, templateVersion: EMBEDDING_INPUT_TEMPLATE_VERSION, ...over });
    expect(a).toBe('Probable cause · CESSNA 172S · Landing\nThe pilot’s failure to maintain control.');
    expect(key(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(key(a)).toBe(key(a));
    expect(key(b)).not.toBe(key(a));
    expect(key(a, { model: 'text-embedding-3-large' })).not.toBe(key(a));
    expect(key(a, { dims: 1024 })).not.toBe(key(a));
    expect(key(a, { templateVersion: 'input-v0' })).not.toBe(key(a));
  });
});

/**
 * The passages index definition (mapping, analysis, chunker, input template, model)
 * this version was built with. Changing any of them changes it: bump
 * PASSAGES_INDEX_VERSION (and CHUNKER_VERSION or the template version when those
 * changed) and update the pin.
 */
const PINNED = { version: 'passages-v2', fingerprint: 'ed335f462734e6b8e4888ed51f6ba2f9926747b100e97d9735eeb0c1f6043dd2' };
/** The fingerprint the shared dev `passages-v1` index records (built at d2b9db8). */
const V1_FINGERPRINT = '57d731b28445deb4369951a92c767414376b6d78cc312c1cdea4a8b822375b5b';
/**
 * sha256 over every fixture passage's id and `input-v1` cache key, recorded with the
 * code that built `passages-v1` (c1167a8). Equal now: `passages-v2` changes no
 * embedding input, so its build is served from the cache the v1 build filled.
 */
const V1_INPUTS = { passages: 56, sha256: '3b192bd367d6d1ecdc7343aa22ce386a8dff1b19e63ce95af9fd5910975fb458' };

/** Every multi-aircraft fixture event's aircraft keys, as `loadEventAircraftSets` reads them from PostgreSQL. */
function setsOf(...ntsbNos: string[]): EventAircraftSets {
  return new Map(ntsbNos.map((n) => [n, record(n).aircraft.map((a) => a.aircraftKey)]));
}

describe('passages index definition', () => {
  it('matches the pinned definition', () => {
    expect(PASSAGES_INDEX_VERSION).toBe(PINNED.version);
    expect(passagesIndexFingerprint('text-embedding-3-small'), 'definition changed: bump the versions and the pin').toBe(PINNED.fingerprint);
    // The v1 definition is kept exactly: it re-derives the fingerprint the shared dev v1 index records.
    expect(passagesIndexFingerprint('text-embedding-3-small', 'passages-v1')).toBe(V1_FINGERPRINT);
  });

  it('keeps every embedding input of passages-v1: same chunker, template and cache keys', () => {
    expect(CHUNKER_VERSION).toBe('chunk-v2');
    expect(EMBEDDING_INPUT_TEMPLATE_VERSION).toBe('input-v1');
    const eligible = [...records.values()].filter((r) => r.answerEligible).sort((a, b) => a.ntsbNo.localeCompare(b.ntsbNo));
    const passages = eligible.flatMap((r) => buildCasePassages(r).passages);
    const h = createHash('sha256');
    for (const p of passages) {
      h.update(`${p.passageId}\n${embeddingCacheKey({ input: p.input, model: 'text-embedding-3-small', dims: 1536, templateVersion: 'input-v1' })}\n`);
    }
    expect({ passages: passages.length, sha256: h.digest('hex') }).toEqual(V1_INPUTS);
  });

  it('differs from passages-v1 only in the event aircraft fields', () => {
    const v1 = PASSAGES_V1_MAPPING.properties ?? {};
    const v2 = PASSAGES_MAPPING.properties ?? {};
    const changed = Object.keys({ ...v1, ...v2 }).filter((k) => JSON.stringify(v1[k]) !== JSON.stringify(v2[k]));
    expect(changed.sort()).toEqual(['event_aircraft', 'event_aircraft_complete', 'event_aircraft_count']);
    expect(v1.event_aircraft).toMatchObject({ type: 'object' });
    expect(v2.event_aircraft).toEqual({ ...v1.event_aircraft, type: 'nested' });
    expect(v2.event_aircraft_count).toEqual({ type: 'integer' });
    expect(v2.event_aircraft_complete).toEqual({ type: 'boolean' });
  });

  it('maps strictly, with the cases analyzer, a 1,536-dim int8 HNSW cosine vector and nested aircraft', () => {
    expect(PASSAGES_MAPPING.dynamic).toBe('strict');
    expect(PASSAGES_MAPPING.properties?.embedding).toEqual({
      type: 'dense_vector',
      dims: PASSAGES_EMBEDDING_DIMS,
      similarity: 'cosine',
      index: true,
      index_options: { type: 'int8_hnsw' },
    });
    expect(PASSAGES_MAPPING.properties?.text).toMatchObject({ analyzer: 'aviation_english', search_analyzer: 'aviation_english_search' });
    expect(PASSAGES_MAPPING.properties?.aircraft).toMatchObject({ type: 'nested', dynamic: 'strict' });
    // Event-scoped passages list their aircraft in a nested field of their own, never in `aircraft`.
    expect(PASSAGES_MAPPING.properties?.event_aircraft).toMatchObject({ type: 'nested', dynamic: 'strict' });
    const analysis = PASSAGES_SETTINGS.analysis as { analyzer: Record<string, { char_filter?: string[] }> };
    expect(analysis.analyzer.aviation_english?.char_filter).toEqual(['aviation_glued_heading']);
    expect(PASSAGES_SETTINGS['mapping.exclude_source_vectors']).toBe(true);
    expect(passagesIndexFingerprint('text-embedding-3-small')).not.toBe(passagesIndexFingerprint('fake-embedding-v1'));
  });

  it('names indices per generation and build, like the cases index', () => {
    const at = new Date('2026-10-22T01:02:03.004Z');
    expect(passagesIndexName('aviation', 1, at, '0a1b2c3d')).toBe('aviation-passages-v2-g1-20261022010203004-0a1b2c3d');
    expect(passagesAlias('aviation')).toBe('aviation-passages');
    expect(() => passagesIndexName('aviation', 0, at, '0a1b2c3d')).toThrow();
    expect(() => passagesIndexName('Aviation', 1, at, '0a1b2c3d')).toThrow();
    expect(() => passagesIndexName('aviation', 1, at, 'x')).toThrow();
  });

  it('builds documents with the copied filters and only the raw passage text', () => {
    const p = buildCasePassages(record('DCA25MA108')).passages[0];
    if (!p) throw new Error('no passage');
    const doc = buildPassageDocument(p, new Float32Array(PASSAGES_EMBEDDING_DIMS).fill(0.5), setsOf('DCA25MA108'));
    expect(doc).toMatchObject({
      passage_id: p.passageId,
      ntsb_no: 'DCA25MA108',
      scope: 'event',
      aircraft_specific: false,
      aircraft_key: null,
      country: 'USA',
      answer_eligible: true,
      text: p.text,
    });
    expect(doc.text).not.toContain('Event (2 aircraft)');
    // Event-scoped: nothing in the nested `aircraft` field, so a nested aircraft filter never matches it;
    // the event's complete set in `event_aircraft`, with its count and the completeness flag.
    expect(doc.aircraft).toEqual([]);
    expect(doc.event_aircraft.map((a) => [a.aircraft_key, a.make, a.category])).toEqual([
      [1, 'BOMBARDIER INC', 'AIR'],
      [2, 'SIKORSKY', 'HELI'],
    ]);
    expect(doc).toMatchObject({ event_aircraft_count: 2, event_aircraft_complete: true });
    const single = buildCasePassages(record('NYC08LA106')).passages[0] as NonNullable<typeof p>;
    const own = buildPassageDocument(single, new Float32Array(PASSAGES_EMBEDDING_DIMS).fill(0.5), setsOf('DCA25MA108'));
    expect(own.aircraft.map((a) => a.make)).toEqual(['Raytheon']);
    expect(own).toMatchObject({ event_aircraft: [], event_aircraft_count: null, event_aircraft_complete: false });
    expect(doc.embedding).toHaveLength(PASSAGES_EMBEDDING_DIMS);
    expect(Object.keys(doc).sort()).toEqual(Object.keys(PASSAGES_MAPPING.properties ?? {}).sort());
    expect(() => buildPassageDocument(p, new Float32Array(3), setsOf('DCA25MA108'))).toThrow(/dimensions/);
  });
});

describe('event aircraft completeness', () => {
  const vector = new Float32Array(PASSAGES_EMBEDDING_DIMS).fill(0.5);
  const cause = (ntsbNo: string) => buildCasePassages(record(ntsbNo)).passages.find((p) => p.kind === 'probable_cause') as ReturnType<typeof buildCasePassages>['passages'][number];

  it('accepts exactly the event’s aircraft keys from PostgreSQL', () => {
    for (const n of ['DCA25MA108', 'SEA08LA057', 'WPR15FA010']) {
      const p = cause(n);
      expect(hasCompleteEventAircraft(p, setsOf(n))).toBe(true);
      expect(eventAircraftCount(p, setsOf(n))).toBe(2);
    }
  });

  it('refuses an event-scoped passage whose set is incomplete, different or unknown to PostgreSQL', () => {
    const p = cause('DCA25MA108');
    const refused: EventAircraftSets[] = [
      new Map([['DCA25MA108', [1, 2, 3]]]), // PostgreSQL has a third aircraft the passage lacks
      new Map([['DCA25MA108', [1, 3]]]), // another set of the same size
      new Map([['DCA25MA108', [1]]]), // a single aircraft cannot have event-scoped passages
      new Map(), // not a multi-aircraft event in PostgreSQL
    ];
    for (const sets of refused) {
      expect(hasCompleteEventAircraft(p, sets)).toBe(false);
      expect(() => eventAircraftCount(p, sets)).toThrow(IncompleteEventAircraftError);
      expect(() => buildPassageDocument(p, vector, sets)).toThrow(/DCA25MA108.*complete aircraft set/);
    }
    // A duplicated aircraft is not the event's set either.
    const dup = { ...p, aircraft: [p.aircraft[0], p.aircraft[0]] as typeof p.aircraft };
    expect(hasCompleteEventAircraft(dup, setsOf('DCA25MA108'))).toBe(false);
  });

  it('gives every passage of an event, each cause variant included, the same aircraft set: an event qualifies whole', () => {
    for (const n of ['DCA25MA108', 'SEA08LA057', 'WPR15FA010']) {
      const passages = buildCasePassages(record(n)).passages;
      expect(passages.length).toBeGreaterThan(1);
      const docs = passages.map((p) => buildPassageDocument(p, vector, setsOf(n)));
      const shapes = new Set(docs.map((d) => JSON.stringify([d.event_aircraft, d.event_aircraft_count, d.event_aircraft_complete])));
      expect(shapes.size, n).toBe(1);
    }
  });

  it('never checks an aircraft-scoped passage against event sets', () => {
    const own = buildCasePassages(record('NYC08LA106')).passages[0] as ReturnType<typeof buildCasePassages>['passages'][number];
    expect(eventAircraftCount(own, new Map())).toBeNull();
  });
});
