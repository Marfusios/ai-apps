/**
 * The three known context-loss counterexamples, as the AI evidence view would show them on its
 * initial surfaces (the evidence-view gate, condition 2: the required context must be on
 * the card, the drawer, Compare and print, not only behind "Show the full section").
 *
 * The texts are the public NTSB passages the server's projection test replays
 * (tests/unit/evidence.test.ts, from evals/checker/evidence-16d.json and evidence.json), with
 * their case numbers, section ids, revision ids, aircraft and probable-cause statements. Each
 * case goes through the server's own projection (`projectCase`) with its retrieval seed
 * narrowed to exactly the old unsafe quotation, as that test does; the page is one
 * `evidence.v3` page of the three (the question alone, in match order, its words marked, nothing
 * applied automatically, so no undo), validated with the contract and serialized as the routes
 * serialize it (`evidenceJson`).
 *
 * The fixture corpus does not have these cases, so their case pages (`contextLossDetail`, for
 * the drawer and Compare) are stand-ins: the case number, the aircraft and the two texts are the
 * record's; every other field is unknown or empty, never another case's.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaseRecord } from '../../server/db/queries/case-records.js';
import type { CaseRowBase } from '../../server/db/queries/case-views.js';
import { projectCase } from '../../server/evidence/project.js';
import { evidenceJson } from '../../server/evidence/routing.js';
import { SEARCH_FALLBACK_LINK } from '../../server/projection/cases.js';
import type { PassageHit } from '../../server/search/hybrid.js';
import { CaseDetailSchema, type CaseDetail } from '../../shared/contracts/cases.js';
import { EVIDENCE_CONTRACT_VERSION, EvidencePageSchema, type EvidencePage } from '../../shared/contracts/evidence.js';
import { SECTION_LABEL, type SectionKind } from '../../shared/contracts/search.js';

export interface ContextLossExample {
  ntsbNo: string;
  /** The saved evidence file under evals/checker. */
  file: 'evidence-16d.json' | 'evidence.json';
  /** The old excerpt that misleads on its own. */
  quote: string;
  /** What it depends on, which the shown paragraph must hold too. */
  anchors: readonly string[];
}

/** The examples and anchors of tests/unit/evidence.test.ts ("replays context-loss evidence"). */
export const CONTEXT_LOSS_EXAMPLES: readonly ContextLossExample[] = [
  {
    ntsbNo: 'ERA22FA257',
    file: 'evidence-16d.json',
    quote: 'after completion of this work',
    anchors: ['preflight inspection', 'maintenance runs to balance the tail rotor'],
  },
  {
    ntsbNo: 'ERA09FA355',
    file: 'evidence-16d.json',
    quote: 'approximately 29 hours earlier',
    anchors: ['The engine had been inspected three times', 'last 100-Hour inspection'],
  },
  {
    ntsbNo: 'WPR18LA021',
    file: 'evidence.json',
    quote: 'The accident flight was conducted 2 days later',
    anchors: ['The second flight was initiated about 70 minutes later', 'about 10 minutes'],
  },
];

/** The question the replayed search was asked (its words are the marks; nothing else depends on it). */
export const CONTEXT_LOSS_QUESTION = 'Loss of power or control on the first flight after maintenance';
/** The replayed search's id (any valid one: the page is served for it). */
export const CONTEXT_LOSS_SEARCH_ID = '00000000-0000-4000-8000-00000000c1a5';

interface SavedPassage {
  ntsbNo: string;
  role: string;
  sectionKind: SectionKind;
  scope: 'event' | 'aircraft';
  aircraftKey: number | null;
  sectionId: string;
  revisionId: string;
  text: string;
}

interface SavedCase {
  ntsbNo: string;
  aircraft: { aircraftKey: number; make: string | null; model: string | null }[];
  passages: SavedPassage[];
}

const CHECKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../evals/checker');
const files = new Map<string, unknown>();
function saved(file: ContextLossExample['file']): unknown {
  let data = files.get(file);
  if (data === undefined) {
    data = JSON.parse(readFileSync(join(CHECKER_DIR, file), 'utf8'));
    files.set(file, data);
  }
  return data;
}

/** The saved case of an example: its aircraft, the retrieved passage that holds the quote and its probable cause. */
export function savedCase(example: ContextLossExample): { record: SavedCase; passage: SavedPassage; cause: SavedPassage } {
  let found: SavedCase | null = null;
  const visit = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (v.ntsbNo === example.ntsbNo && Array.isArray(v.passages)) found = v as unknown as SavedCase;
      else Object.values(v).forEach(visit);
    }
  };
  visit(saved(example.file));
  const record = found as SavedCase | null;
  if (!record) throw new Error(`${example.ntsbNo} is not in evals/checker/${example.file}`);
  const passage = record.passages.find((p) => p.text.includes(example.quote));
  const cause = record.passages.find((p) => p.sectionKind === 'probable_cause');
  if (!passage || !cause) throw new Error(`${example.ntsbNo}: passage or probable cause missing`);
  return { record, passage, cause };
}

const unknown = { code: null, label: 'Unknown' } as const;
const sectionKey = (sectionId: string): string => sectionId.slice(sectionId.indexOf(':') + 1);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function caseRecord(example: ContextLossExample): { record: CaseRecord; row: CaseRowBase; seed: PassageHit } {
  const { record: saved, passage, cause } = savedCase(example);
  const aircraft = saved.aircraft[0];
  if (saved.aircraft.length !== 1 || !aircraft || passage.scope !== 'aircraft' || passage.aircraftKey !== aircraft.aircraftKey) {
    throw new Error(`${example.ntsbNo}: expected one aircraft and its own passage`);
  }
  const section = (p: SavedPassage) => ({
    sectionId: p.sectionId,
    sectionKey: sectionKey(p.sectionId),
    kind: p.sectionKind,
    scope: p.scope,
    aircraftKey: p.aircraftKey,
    // The saved passage stands for its section, as in the server's replay test.
    text: p.text,
    sha256: sha256(p.text),
    revisionId: p.revisionId,
    citationTextVersion: 'v1',
  });
  const record: CaseRecord = {
    generationId: 1,
    ntsbNo: example.ntsbNo,
    country: 'USA',
    isUs: true,
    latitude: null,
    longitude: null,
    evDate: null,
    evYear: null,
    city: null,
    state: null,
    lightCond: null,
    wxCondBasic: null,
    highestInjury: null,
    rawStatus: null,
    completionClass: 'completed',
    hasProbableCause: true,
    completedWithCause: true,
    answerEligible: true,
    definingPhaseGroups: [],
    sequencePhaseGroups: [],
    findings: [],
    sequence: [],
    aircraft: [
      {
        aircraftKey: aircraft.aircraftKey,
        aircraftNtsbNo: null,
        make: aircraft.make,
        model: aircraft.model,
        category: null,
        farPart: null,
        purpose: null,
        damage: null,
        homebuilt: null,
        definingOccurrenceNo: null,
        definingPhaseGroup: null,
        definingEventConflict: false,
        sequencePhaseGroups: [],
        engines: [],
      },
    ],
    sections: [section(passage), section(cause)],
  };
  const row: CaseRowBase = {
    ntsbNo: example.ntsbNo,
    eventType: { code: 'ACC', label: 'Accident' },
    date: null,
    city: null,
    state: unknown,
    country: 'USA',
    aircraft: [
      {
        aircraftKey: aircraft.aircraftKey,
        aircraftNtsbNo: null,
        registration: null,
        make: aircraft.make,
        model: aircraft.model,
        category: unknown,
        farPart: unknown,
        purpose: unknown,
        damage: unknown,
        definingEvent: null,
      },
    ],
    definingPhases: [],
    conditions: unknown,
    light: unknown,
    highestInjury: unknown,
    completion: { class: 'completed', rawStatus: null, hasProbableCause: true, mappingVersion: 'v1-empirical', mappingVerified: false },
  };
  // The retrieval seed is exactly the old unsafe quotation: the projection must restore its paragraph.
  const start = passage.text.indexOf(example.quote);
  const seed: PassageHit = {
    id: sha256(`${passage.sectionId}:${start}`),
    ntsbNo: example.ntsbNo,
    sectionId: passage.sectionId,
    revisionId: passage.revisionId,
    sectionKind: passage.sectionKind as PassageHit['sectionKind'],
    scope: passage.scope,
    aircraftSpecific: true,
    aircraftKey: passage.aircraftKey,
    start,
    end: start + example.quote.length,
    part: 1,
    parts: 1,
    continuation: false,
  };
  return { record, row, seed };
}

/** The search's page of the three cases, as `GET /api/evidence/:id?page=1` would answer for it. */
export function contextLossPage(now = new Date('2026-10-25T08:00:00Z')): EvidencePage {
  const cases = CONTEXT_LOSS_EXAMPLES.map((example, i) => {
    const { record, row, seed } = caseRecord(example);
    return projectCase(record, row, SEARCH_FALLBACK_LINK, { ntsbNo: example.ntsbNo, seeds: [seed], channels: ['keyword'] }, i + 1, {}, CONTEXT_LOSS_QUESTION);
  });
  return EvidencePageSchema.parse({
    version: EVIDENCE_CONTRACT_VERSION,
    id: CONTEXT_LOSS_SEARCH_ID,
    question: CONTEXT_LOSS_QUESTION,
    query: { source: 'question', keywords: { kind: 'question' } },
    appliedFilters: {},
    automaticFilters: null,
    order: 'match',
    marks: 'search_words',
    freeUndo: false,
    undo: 'none',
    suggestion: null,
    hint: null,
    note: null,
    generation: 'context-loss-replay',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    total: cases.length,
    page: 1,
    pages: 1,
    cases,
  });
}

/** The page as the route sends it (server/evidence/routing.ts `evidenceJson`). */
export function contextLossPageJson(now?: Date): string {
  return evidenceJson(contextLossPage(now));
}

/** The paragraph of an example the projection chose for its quotation (the text the surfaces must show whole). */
export function contextLossParagraph(page: EvidencePage, example: ContextLossExample): string {
  const item = page.cases.find((c) => c.case.ntsbNo === example.ntsbNo);
  const excerpt = item?.excerpts.find((e) => e.text.includes(example.quote));
  if (!excerpt) throw new Error(`${example.ntsbNo}: no excerpt holds the quotation`);
  return excerpt.text;
}

/** A stand-in case page for `GET /api/cases/:ntsbNo` (module comment): the record's number, aircraft and texts only. */
export function contextLossDetail(example: ContextLossExample, snapshotDate = '2026-10-16'): CaseDetail {
  const { record: saved, passage, cause } = savedCase(example);
  const aircraft = saved.aircraft[0]!;
  const section = (p: SavedPassage) => ({
    key: sectionKey(p.sectionId),
    kind: p.sectionKind,
    label: SECTION_LABEL[p.sectionKind],
    scope: p.scope,
    aircraftKey: p.aircraftKey,
    sourceAircraftKeys: [aircraft.aircraftKey],
    text: p.text,
    revision: sha256(p.text),
    citationTextVersion: 'v1',
    transformedFromHtml: false,
    lastChangedAt: null,
  });
  return CaseDetailSchema.parse({
    ntsbNo: example.ntsbNo,
    eventType: { code: 'ACC', label: 'Accident' },
    date: null,
    time: { hhmm: null, zone: unknown },
    city: null,
    state: unknown,
    country: 'USA',
    location: null,
    headline: `${[aircraft.make, aircraft.model].filter(Boolean).join(' ')} accident`,
    completion: { class: 'completed', rawStatus: null, hasProbableCause: true, mappingVersion: 'v1-empirical', mappingVerified: false },
    highestInjury: unknown,
    injuries: { fatal: null, serious: null, minor: null, uninjured: null },
    weather: {
      basic: unknown,
      light: unknown,
      ceiling: { cover: unknown, heightFt: null },
      lowestNonCeiling: { cover: unknown, heightFt: null },
      visibilitySm: null,
      wind: { directionDeg: null, directionIndicator: null, speedKts: null, speedIndicator: null, gustKts: null, gustIndicator: null },
      temperatureC: null,
      dewPointC: null,
      altimeterInHg: null,
      densityAltitudeFt: null,
      precipitation: unknown,
      metar: null,
    },
    aircraft: [
      {
        aircraftKey: aircraft.aircraftKey,
        aircraftNtsbNo: null,
        registration: null,
        make: aircraft.make,
        model: aircraft.model,
        category: unknown,
        farPart: unknown,
        purpose: unknown,
        damage: unknown,
        definingEvent: null,
        series: null,
        homebuilt: null,
        year: null,
        engines: [],
        definingEventConflict: false,
      },
    ],
    sequence: [],
    sections: [section(passage), section(cause)],
    findings: [],
    cautions: [],
    report: SEARCH_FALLBACK_LINK,
    provenance: {
      source: 'NTSB aviation investigation database (avall.mdb)',
      snapshotDate,
      datasetRevision: 'context-loss-replay',
      caseRevision: sha256(`${example.ntsbNo}:${passage.revisionId}:${cause.revisionId}`),
      approvalDate: null,
      lastChangedAt: null,
      citationTextVersion: 'v1',
      fieldNormalizationVersion: 'v1',
    },
  });
}
