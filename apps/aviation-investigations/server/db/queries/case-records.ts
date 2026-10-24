/**
 * Canonical case records of one dataset generation, read for the search projections.
 *
 * `streamCaseRecords` reads a generation in batches of cases (keyset order by case
 * number) inside one repeatable-read, read-only transaction, so every batch comes
 * from the same snapshot. Each batch is one query per corpus table; the rows are put
 * together by the pure `assembleCaseRecords`. By default only US events are read
 * (amendment A2): both search indices are US-only.
 *
 * The internal `ev_id` is never selected.
 */
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CompletionClass } from '../../../shared/completion.js';
import type { Db, DbOrTx } from '../client.js';
import * as schema from '../schema/index.js';
import { caseAircraft, caseEngines, caseFindings, caseSections, caseSequence, cases } from '../schema/index.js';

export type SectionKind = (typeof schema.SECTION_KINDS)[number];
export type SectionScope = (typeof schema.SECTION_SCOPES)[number];

export interface CaseRecordEngine {
  engNo: number;
  engType: string | null;
}

export interface CaseRecordAircraft {
  aircraftKey: number;
  /** Suffixed (A, B) in multi-aircraft events. */
  aircraftNtsbNo: string | null;
  make: string | null;
  model: string | null;
  category: string | null;
  farPart: string | null;
  purpose: string | null;
  damage: string | null;
  homebuilt: boolean | null;
  definingOccurrenceNo: number | null;
  definingPhaseGroup: string | null;
  definingEventConflict: boolean;
  sequencePhaseGroups: string[];
  /** Ordered by engine number. */
  engines: CaseRecordEngine[];
}

export interface CaseRecordSection {
  sectionId: string;
  sectionKey: string;
  kind: SectionKind;
  scope: SectionScope;
  aircraftKey: number | null;
  text: string;
  sha256: string;
  revisionId: string;
  citationTextVersion: string;
}

export interface CaseRecordFinding {
  aircraftKey: number;
  findingNo: number;
  code: string | null;
  description: string | null;
  inProbableCause: boolean | null;
}

export interface CaseRecordSequence {
  aircraftKey: number;
  occurrenceNo: number;
  phaseNo: number | null;
  phaseGroup: string;
  eventCode: string | null;
  description: string | null;
  isDefining: boolean | null;
}

/** One event of one generation with everything the search projections need. */
export interface CaseRecord {
  generationId: number;
  ntsbNo: string;
  /** `ev_country` as published (e.g. USA). */
  country: string | null;
  isUs: boolean;
  latitude: number | null;
  longitude: number | null;
  evDate: string | null;
  evYear: number | null;
  city: string | null;
  state: string | null;
  lightCond: string | null;
  wxCondBasic: string | null;
  highestInjury: string | null;
  rawStatus: string | null;
  completionClass: CompletionClass;
  hasProbableCause: boolean;
  completedWithCause: boolean;
  answerEligible: boolean;
  definingPhaseGroups: string[];
  sequencePhaseGroups: string[];
  /** Ordered by aircraft key. */
  aircraft: CaseRecordAircraft[];
  /** Ordered by kind (factual, analysis, probable cause), event scope first, aircraft key, section key. */
  sections: CaseRecordSection[];
  /** Ordered by aircraft key and finding number. */
  findings: CaseRecordFinding[];
  /** Ordered by aircraft key and occurrence number. */
  sequence: CaseRecordSequence[];
}

// ---------------------------------------------------------------------------
// Selected columns

const CASE_COLUMNS = {
  ntsbNo: cases.ntsbNo,
  country: cases.country,
  isUs: cases.isUs,
  latitude: cases.latitude,
  longitude: cases.longitude,
  evDate: cases.evDate,
  evYear: cases.evYear,
  city: cases.city,
  state: cases.state,
  lightCond: cases.lightCond,
  wxCondBasic: cases.wxCondBasic,
  highestInjury: cases.highestInjury,
  rawStatus: cases.rawStatus,
  completionClass: cases.completionClass,
  hasProbableCause: cases.hasProbableCause,
  completedWithCause: cases.completedWithCause,
  answerEligible: cases.answerEligible,
  definingPhaseGroups: cases.definingPhaseGroups,
  sequencePhaseGroups: cases.sequencePhaseGroups,
};

const AIRCRAFT_COLUMNS = {
  ntsbNo: caseAircraft.ntsbNo,
  aircraftKey: caseAircraft.aircraftKey,
  aircraftNtsbNo: caseAircraft.aircraftNtsbNo,
  make: caseAircraft.make,
  model: caseAircraft.model,
  category: caseAircraft.category,
  farPart: caseAircraft.farPart,
  purpose: caseAircraft.purpose,
  damage: caseAircraft.damage,
  homebuilt: caseAircraft.homebuilt,
  definingOccurrenceNo: caseAircraft.definingOccurrenceNo,
  definingPhaseGroup: caseAircraft.definingPhaseGroup,
  definingEventConflict: caseAircraft.definingEventConflict,
  sequencePhaseGroups: caseAircraft.sequencePhaseGroups,
};

const ENGINE_COLUMNS = {
  ntsbNo: caseEngines.ntsbNo,
  aircraftKey: caseEngines.aircraftKey,
  engNo: caseEngines.engNo,
  engType: caseEngines.engType,
};

const SECTION_COLUMNS = {
  ntsbNo: caseSections.ntsbNo,
  sectionId: caseSections.sectionId,
  sectionKey: caseSections.sectionKey,
  kind: caseSections.kind,
  scope: caseSections.scope,
  aircraftKey: caseSections.aircraftKey,
  text: caseSections.text,
  sha256: caseSections.sha256,
  revisionId: caseSections.revisionId,
  citationTextVersion: caseSections.citationTextVersion,
};

const FINDING_COLUMNS = {
  ntsbNo: caseFindings.ntsbNo,
  aircraftKey: caseFindings.aircraftKey,
  findingNo: caseFindings.findingNo,
  code: caseFindings.code,
  description: caseFindings.description,
  inProbableCause: caseFindings.inProbableCause,
};

const SEQUENCE_COLUMNS = {
  ntsbNo: caseSequence.ntsbNo,
  aircraftKey: caseSequence.aircraftKey,
  occurrenceNo: caseSequence.occurrenceNo,
  phaseNo: caseSequence.phaseNo,
  phaseGroup: caseSequence.phaseGroup,
  eventCode: caseSequence.eventCode,
  description: caseSequence.description,
  isDefining: caseSequence.isDefining,
};

type Keyed = { ntsbNo: string };
export type CaseRow = Omit<CaseRecord, 'generationId' | 'aircraft' | 'sections' | 'findings' | 'sequence'>;
export type AircraftRow = Keyed & Omit<CaseRecordAircraft, 'engines'>;
export type EngineRow = Keyed & { aircraftKey: number } & CaseRecordEngine;
export type SectionRow = Keyed & CaseRecordSection;
export type FindingRow = Keyed & CaseRecordFinding;
export type SequenceRow = Keyed & CaseRecordSequence;

/** Corpus rows of a set of cases, as selected from one generation. */
export interface CaseRecordRows {
  cases: readonly CaseRow[];
  aircraft: readonly AircraftRow[];
  engines: readonly EngineRow[];
  sections: readonly SectionRow[];
  findings: readonly FindingRow[];
  sequence: readonly SequenceRow[];
}

// ---------------------------------------------------------------------------
// Assembly (pure)

const KIND_ORDER: Readonly<Record<SectionKind, number>> = { factual: 0, analysis: 1, probable_cause: 2 };

/** Numeric-aware key order, so `factual/event-10` sorts after `factual/event-9`. */
const compareKeys = new Intl.Collator('en', { numeric: true }).compare;

function groupBy<T extends Keyed>(rows: readonly T[], known: ReadonlySet<string>, table: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    if (!known.has(r.ntsbNo)) throw new Error(`${table} row for ${r.ntsbNo} has no case in the batch`);
    const list = out.get(r.ntsbNo);
    if (list) list.push(r);
    else out.set(r.ntsbNo, [r]);
  }
  return out;
}

/** Exactly the given fields of a row, so a wider row (e.g. a loader insert row) adds nothing. */
function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = row[k];
  return out;
}

function fieldsOf<T>(columns: object): Exclude<keyof T, 'ntsbNo'>[] {
  return Object.keys(columns).filter((k) => k !== 'ntsbNo') as Exclude<keyof T, 'ntsbNo'>[];
}

const CASE_FIELDS = fieldsOf<CaseRow>(CASE_COLUMNS);
const AIRCRAFT_FIELDS = fieldsOf<AircraftRow>(AIRCRAFT_COLUMNS);
const SECTION_FIELDS = fieldsOf<SectionRow>(SECTION_COLUMNS);
const FINDING_FIELDS = fieldsOf<FindingRow>(FINDING_COLUMNS);
const SEQUENCE_FIELDS = fieldsOf<SequenceRow>(SEQUENCE_COLUMNS);

/**
 * Put selected rows together into case records, in the order of `rows.cases`, with
 * every child list in a fixed order and only the selected columns. Fails on a child
 * without its parent.
 */
export function assembleCaseRecords(generationId: number, rows: CaseRecordRows): CaseRecord[] {
  const known = new Set(rows.cases.map((c) => c.ntsbNo));
  if (known.size !== rows.cases.length) throw new Error('duplicate case number in batch');
  const aircraft = groupBy(rows.aircraft, known, 'case_aircraft');
  const engines = groupBy(rows.engines, known, 'case_engines');
  const sections = groupBy(rows.sections, known, 'case_sections');
  const findings = groupBy(rows.findings, known, 'case_findings');
  const sequence = groupBy(rows.sequence, known, 'case_sequence');

  return rows.cases.map((c) => {
    const ownEngines = engines.get(c.ntsbNo) ?? [];
    const ownAircraft = [...(aircraft.get(c.ntsbNo) ?? [])].sort((a, b) => a.aircraftKey - b.aircraftKey);
    const keys = new Set(ownAircraft.map((a) => a.aircraftKey));
    for (const e of ownEngines) {
      if (!keys.has(e.aircraftKey)) throw new Error(`engine of ${c.ntsbNo} references missing aircraft ${e.aircraftKey}`);
    }
    return {
      generationId,
      ntsbNo: c.ntsbNo,
      ...pick(c, CASE_FIELDS),
      definingPhaseGroups: [...c.definingPhaseGroups],
      sequencePhaseGroups: [...c.sequencePhaseGroups],
      aircraft: ownAircraft.map((a) => ({
        ...pick(a, AIRCRAFT_FIELDS),
        sequencePhaseGroups: [...a.sequencePhaseGroups],
        engines: ownEngines
          .filter((e) => e.aircraftKey === a.aircraftKey)
          .sort((x, y) => x.engNo - y.engNo)
          .map((e) => ({ engNo: e.engNo, engType: e.engType })),
      })),
      sections: [...(sections.get(c.ntsbNo) ?? [])]
        .sort(
          (x, y) =>
            KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
            (x.scope === y.scope ? 0 : x.scope === 'event' ? -1 : 1) ||
            (x.aircraftKey ?? -1) - (y.aircraftKey ?? -1) ||
            compareKeys(x.sectionKey, y.sectionKey),
        )
        .map((x) => pick(x, SECTION_FIELDS)),
      findings: [...(findings.get(c.ntsbNo) ?? [])]
        .sort((x, y) => x.aircraftKey - y.aircraftKey || x.findingNo - y.findingNo)
        .map((x) => pick(x, FINDING_FIELDS)),
      sequence: [...(sequence.get(c.ntsbNo) ?? [])]
        .sort((x, y) => x.aircraftKey - y.aircraftKey || x.occurrenceNo - y.occurrenceNo)
        .map((x) => pick(x, SEQUENCE_FIELDS)),
    };
  });
}

// ---------------------------------------------------------------------------
// Streaming

export interface StreamCaseRecordsOptions {
  /** Cases per batch (default 500). */
  batchSize?: number;
  /** Also read non-US events (default false: US only, amendment A2). */
  includeForeign?: boolean;
}

type Reader = NodePgDatabase<typeof schema>;

async function readBatch(
  tx: Reader,
  generationId: number,
  after: string | null,
  limit: number,
  includeForeign: boolean,
): Promise<CaseRecord[]> {
  const where: SQL[] = [eq(cases.generationId, generationId)];
  if (!includeForeign) where.push(eq(cases.isUs, true));
  if (after !== null) where.push(gt(cases.ntsbNo, after));
  const caseRows: CaseRow[] = await tx
    .select(CASE_COLUMNS)
    .from(cases)
    .where(and(...where))
    .orderBy(asc(cases.ntsbNo))
    .limit(limit);
  if (caseRows.length === 0) return [];
  const nos = caseRows.map((c) => c.ntsbNo);
  // One connection runs one query at a time: read the child tables in turn.
  const aircraft = await tx.select(AIRCRAFT_COLUMNS).from(caseAircraft)
    .where(and(eq(caseAircraft.generationId, generationId), inArray(caseAircraft.ntsbNo, nos)));
  const engines = await tx.select(ENGINE_COLUMNS).from(caseEngines)
    .where(and(eq(caseEngines.generationId, generationId), inArray(caseEngines.ntsbNo, nos)));
  const sections = await tx.select(SECTION_COLUMNS).from(caseSections)
    .where(and(eq(caseSections.generationId, generationId), inArray(caseSections.ntsbNo, nos)));
  const findings = await tx.select(FINDING_COLUMNS).from(caseFindings)
    .where(and(eq(caseFindings.generationId, generationId), inArray(caseFindings.ntsbNo, nos)));
  const sequence = await tx.select(SEQUENCE_COLUMNS).from(caseSequence)
    .where(and(eq(caseSequence.generationId, generationId), inArray(caseSequence.ntsbNo, nos)));
  return assembleCaseRecords(generationId, { cases: caseRows, aircraft, engines, sections, findings, sequence });
}

/**
 * Every case of one generation (US only unless `includeForeign`), in case-number
 * order, read in batches from one repeatable-read snapshot. The connection is held
 * until the iteration ends; breaking out of a `for await` loop releases it.
 */
export async function* streamCaseRecords(
  db: Db,
  generationId: number,
  opts: StreamCaseRecordsOptions = {},
): AsyncGenerator<CaseRecord, void, undefined> {
  const batchSize = opts.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  const client = await db.$client.connect();
  let finished = false;
  let failure: Error | undefined;
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const tx = drizzle({ client, schema });
    let after: string | null = null;
    for (;;) {
      const batch = await readBatch(tx, generationId, after, batchSize, opts.includeForeign ?? false);
      for (const record of batch) yield record;
      if (batch.length < batchSize) break;
      after = (batch[batch.length - 1] as CaseRecord).ntsbNo;
    }
    await client.query('commit');
    finished = true;
  } finally {
    if (!finished) {
      await client.query('rollback').catch((e: unknown) => {
        failure = e instanceof Error ? e : new Error(String(e));
      });
    }
    client.release(failure);
  }
}

// ---------------------------------------------------------------------------
// Counts

/** Aggregate counts of the cases `streamCaseRecords` reads (US only unless `includeForeign`). */
export interface CaseRecordCounts {
  cases: number;
  aircraft: number;
  answerEligible: number;
  /** Events with more than one aircraft: aircraft facet buckets can sum to more than the total. */
  multiAircraftEvents: number;
  /** Events whose aircraft have different defining phase groups. */
  eventsWithSeveralDefiningPhases: number;
  /** Events where no aircraft has a single defining sequence event. */
  eventsWithoutDefiningPhase: number;
}

export async function countCaseRecords(
  db: Pick<DbOrTx, 'execute'>,
  generationId: number,
  opts: Pick<StreamCaseRecordsOptions, 'includeForeign'> = {},
): Promise<CaseRecordCounts> {
  const us = opts.includeForeign ? sql`true` : sql`c.is_us`;
  const result = await db.execute(sql`
    select count(*)::int as cases,
           coalesce(sum(a.n), 0)::int as aircraft,
           (count(*) filter (where c.answer_eligible))::int as answer_eligible,
           (count(*) filter (where a.n > 1))::int as multi_aircraft,
           (count(*) filter (where cardinality(c.defining_phase_groups) > 1))::int as several_defining,
           (count(*) filter (where cardinality(c.defining_phase_groups) = 0))::int as without_defining
      from cases c
      left join (select ntsb_no, count(*) as n from case_aircraft where generation_id = ${generationId} group by ntsb_no) a
        on a.ntsb_no = c.ntsb_no
     where c.generation_id = ${generationId} and ${us}`);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    cases: n('cases'),
    aircraft: n('aircraft'),
    answerEligible: n('answer_eligible'),
    multiAircraftEvents: n('multi_aircraft'),
    eventsWithSeveralDefiningPhases: n('several_defining'),
    eventsWithoutDefiningPhase: n('without_defining'),
  };
}
