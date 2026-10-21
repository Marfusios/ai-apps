/**
 * Generation verification (amendment A6). `verifyCorpus` checks generic invariants of
 * one sealed generation, re-derives every section's citation text from its exported
 * sources with the normalization code itself, compares counts with the normalization
 * stats and the extraction manifest, optionally checks a snapshot profile, and records
 * the outcome through `record_verification`. It holds the lifecycle lock and reads in
 * one REPEATABLE READ snapshot, so publication and pruning cannot interleave. Its
 * report file holds aggregate counts only: no case numbers, keys or text.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { Db, Schema } from '../../server/db/client.js';
import { LifecycleError, VERIFIER_VERSION, lifecycleError, withLifecycleLock } from '../../server/db/generations.js';
import {
  caseSections,
  datasetGenerations,
  type GenerationStatus,
  type SourceForm,
  type VerificationStatus,
} from '../../server/db/schema/index.js';
import { PHASE_GROUPS } from '../../shared/codes.js';
import { COMPLETION_MAPPING_V1, completionClassOf, type CompletionMapping } from '../../shared/completion.js';
import { toCitationText } from './citation-text.js';
import type { ExtractManifest } from './extract.js';
import type { GenerationStats } from './load.js';
import { analyzeCorpus, reconstructSource, sectionRevisionId } from './load.js';
import { whitespaceKey } from './normalize.js';

export { VERIFIER_VERSION } from '../../server/db/generations.js';

const APP_DIR = resolve(fileURLToPath(import.meta.url), '../../..');
export const DEFAULT_VERIFY_DIR = join(APP_DIR, 'data', 'work');
export const PROFILES_DIR = resolve(fileURLToPath(import.meta.url), '../verify-profiles');

export interface VerifyCheck {
  name: string;
  /** Number of violating rows (or mismatching measures). */
  failures: number;
  ok: boolean;
}

export interface ProfileResult {
  name: string;
  ok: boolean;
  mismatches: { measure: string; expected: number; actual: number | null }[];
}

export interface VerifyReport {
  generationId: number;
  /** Every check (and the profile, if any) passed. */
  ok: boolean;
  /** Generation status before and after verification. */
  statusBefore: GenerationStatus;
  status: GenerationStatus;
  /**
   * The generation changed while it was being verified; nothing was recorded and
   * `status` is the status read at the start. Run verification again.
   */
  conflict: boolean;
  /** Latest recorded verification outcome (unchanged on conflict). */
  verificationStatus: VerificationStatus | null;
  verifierVersion: string;
  /** sha256 of the report file, as recorded on the generation. */
  reportSha256: string;
  checkedAt: string;
  /** Planner statistics were refreshed before checking. */
  analyzed: boolean;
  versions: { mapping: string; mappingVerified: boolean; citationText: string; fieldNormalization: string };
  checks: VerifyCheck[];
  /** Aggregate counts measured from the stored generation. */
  counts: Record<string, number>;
  profile: ProfileResult | null;
  reportPath: string;
}

/** Snapshot-specific expectations, checked only for the archive they describe. */
export interface VerifyProfile {
  name: string;
  archiveSha256: string;
  description?: string;
  expected: Record<string, number>;
}

const profileSchema = z.object({
  name: z.string().min(1),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  description: z.string().optional(),
  expected: z.record(z.string(), z.number().int().nonnegative()),
});

export function readProfile(file: string): VerifyProfile {
  const parsed = profileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`invalid verification profile: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return parsed.data;
}

/** The committed profile for this archive hash, if any. */
export function findProfile(archiveSha256: string, dir: string = PROFILES_DIR): VerifyProfile | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const profile = readProfile(join(dir, name));
    if (profile.archiveSha256 === archiveSha256) return profile;
  }
  return null;
}

export interface VerifyOptions {
  /** Directory for `verify-gen-<id>-<sha256>.json` (default `data/work`). */
  outDir?: string;
  /** A profile to check (its archive hash must match), `null` for none; default: the committed profile for the archive. */
  profile?: VerifyProfile | null;
  /** Test seam: runs after the checks and the report file are written, before the outcome is recorded. */
  beforeRecord?: () => Promise<void> | void;
}

type Row = Record<string, unknown>;
type Queryable = NodePgDatabase<Schema>;

async function rows(db: Queryable, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return result.rows as Row[];
}

async function scalar(db: Queryable, query: SQL): Promise<number> {
  const [row] = await rows(db, query);
  const value = row ? Object.values(row)[0] : null;
  return Number(value ?? 0);
}

/**
 * Generic invariants as violation counts, each scoped to generation `g`. Foreign keys
 * and check constraints already enforce most of them; they are re-asserted here so a
 * verified generation never depends on the schema alone.
 */
function invariantQueries(g: number, citationTextVersion: string, mappingVersion: string, runId: number): [string, SQL][] {
  const phaseOrder = `{${PHASE_GROUPS.join(',')}}`;
  /** Distinct phase groups of the matching sequence rows, in flight order (`orderPhaseGroups`). */
  const sequencePhases = (filter: SQL) =>
    sql`coalesce((select array_agg(d.p order by array_position(${phaseOrder}::text[], d.p))
          from (select distinct q.phase_group as p from case_sequence q where ${filter}) d), '{}'::text[])`;
  return [
    ['ntsb_no_nonblank', sql`select count(*) from cases where generation_id = ${g} and (ntsb_no = '' or ntsb_no ~ '^\\s|\\s$')`],
    ['ntsb_no_unique', sql`select count(*) - count(distinct ntsb_no) from cases where generation_id = ${g}`],
    ['ev_id_unique', sql`select count(*) - count(distinct ev_id) from cases where generation_id = ${g}`],
    [
      'aircraft_have_case',
      sql`select count(*) from case_aircraft x where x.generation_id = ${g}
          and not exists (select 1 from cases p where p.generation_id = x.generation_id and p.ntsb_no = x.ntsb_no)`,
    ],
    ...(['case_engines', 'case_findings', 'case_sequence'] as const).map(
      (t): [string, SQL] => [
        `${t.replace('case_', '')}_have_aircraft`,
        sql`select count(*) from ${sql.identifier(t)} x where x.generation_id = ${g}
            and not exists (select 1 from case_aircraft p where p.generation_id = x.generation_id
              and p.ntsb_no = x.ntsb_no and p.aircraft_key = x.aircraft_key)`,
      ],
    ),
    [
      'sections_have_case',
      sql`select count(*) from case_sections x where x.generation_id = ${g}
          and not exists (select 1 from cases p where p.generation_id = x.generation_id and p.ntsb_no = x.ntsb_no)`,
    ],
    [
      'sections_have_aircraft',
      sql`select count(*) from case_sections x where x.generation_id = ${g} and x.aircraft_key is not null
          and not exists (select 1 from case_aircraft p where p.generation_id = x.generation_id
            and p.ntsb_no = x.ntsb_no and p.aircraft_key = x.aircraft_key)`,
    ],
    [
      'sources_have_section',
      sql`select count(*) from case_section_sources x where x.generation_id = ${g}
          and not exists (select 1 from case_sections p where p.generation_id = x.generation_id
            and p.section_id = x.section_id and p.ntsb_no = x.ntsb_no)`,
    ],
    [
      'sources_have_aircraft',
      sql`select count(*) from case_section_sources x where x.generation_id = ${g}
          and not exists (select 1 from case_aircraft p where p.generation_id = x.generation_id
            and p.ntsb_no = x.ntsb_no and p.aircraft_key = x.source_aircraft_key)`,
    ],
    [
      'section_sha256_matches_text',
      sql`select count(*) from case_sections where generation_id = ${g}
          and encode(sha256(convert_to(text, 'UTF8')), 'hex') <> sha256`,
    ],
    [
      'section_citation_text_version',
      sql`select count(*) from case_sections where generation_id = ${g} and citation_text_version <> ${citationTextVersion}`,
    ],
    [
      'section_id_format',
      sql`select count(*) from case_sections where generation_id = ${g} and section_id <> ntsb_no || ':' || section_key`,
    ],
    [
      'event_scope_only_multi_aircraft',
      sql`select count(*) from case_sections s where s.generation_id = ${g} and s.scope = 'event'
          and (select count(*) from case_aircraft a where a.generation_id = s.generation_id and a.ntsb_no = s.ntsb_no) < 2`,
    ],
    [
      'aircraft_scope_only_single_aircraft',
      sql`select count(*) from case_sections s where s.generation_id = ${g} and s.scope = 'aircraft'
          and (select count(*) from case_aircraft a where a.generation_id = s.generation_id and a.ntsb_no = s.ntsb_no) <> 1`,
    ],
    [
      'section_scope_shape',
      sql`select count(*) from case_sections where generation_id = ${g} and not (
            (scope = 'aircraft' and aircraft_key is not null and source_aircraft_keys = array[aircraft_key])
            or (scope = 'event' and aircraft_key is null))`,
    ],
    [
      'section_sources_listed',
      sql`select count(*) from case_sections s where s.generation_id = ${g} and s.source_aircraft_keys is distinct from
          (select array_agg(x.source_aircraft_key order by x.source_aircraft_key) from case_section_sources x
            where x.generation_id = s.generation_id and x.section_id = s.section_id)`,
    ],
    [
      'section_text_from_lowest_source',
      sql`select count(*) from case_sections s
          join case_section_sources x on x.generation_id = s.generation_id and x.section_id = s.section_id
            and x.source_aircraft_key = s.source_aircraft_keys[1]
          where s.generation_id = ${g} and (x.match <> 'exact' or x.transformed_from_html <> s.transformed_from_html)`,
    ],
    [
      'section_key_matches_scope',
      sql`select count(*) from case_sections where generation_id = ${g} and not coalesce(
            (scope = 'aircraft' and section_key = kind || '/aircraft-' || aircraft_key)
            or (scope = 'event' and section_key ~ ('^' || kind || '/event-[1-9][0-9]*$')), false)`,
    ],
    [
      'event_defining_phases',
      sql`select count(*) from cases c where c.generation_id = ${g} and c.defining_phase_groups is distinct from
          coalesce((select array_agg(d.grp order by d.first_key) from (
            select a.defining_phase_group as grp, min(a.aircraft_key) as first_key from case_aircraft a
            where a.generation_id = c.generation_id and a.ntsb_no = c.ntsb_no and a.defining_phase_group is not null
            group by 1) d), '{}'::text[])`,
    ],
    [
      'event_sequence_phases',
      sql`select count(*) from cases c where c.generation_id = ${g} and c.sequence_phase_groups is distinct from
          ${sequencePhases(sql`q.generation_id = c.generation_id and q.ntsb_no = c.ntsb_no`)}`,
    ],
    [
      'aircraft_sequence_phases',
      sql`select count(*) from case_aircraft a where a.generation_id = ${g} and a.sequence_phase_groups is distinct from
          ${sequencePhases(sql`q.generation_id = a.generation_id and q.ntsb_no = a.ntsb_no and q.aircraft_key = a.aircraft_key`)}`,
    ],
    [
      'generation_run_succeeded',
      sql`select count(*) from dataset_generations g where g.id = ${g} and not exists (
            select 1 from ingestion_runs r where r.id = g.ingestion_run_id and r.status = 'succeeded')`,
    ],
    [
      'answer_eligible_rule',
      sql`select count(*) from cases where generation_id = ${g}
          and answer_eligible <> (is_us and completion_class = 'completed' and has_probable_cause)`,
    ],
    [
      'completed_with_cause_rule',
      sql`select count(*) from cases where generation_id = ${g}
          and completed_with_cause <> (completion_class = 'completed' and has_probable_cause)`,
    ],
    [
      'probable_cause_text_present',
      sql`select count(*) from cases c where c.generation_id = ${g} and c.has_probable_cause <> exists (
            select 1 from case_sections s where s.generation_id = c.generation_id and s.ntsb_no = c.ntsb_no
              and s.kind = 'probable_cause' and s.text ~ '\\S')`,
    ],
    ['is_us_rule', sql`select count(*) from cases where generation_id = ${g} and is_us <> coalesce(country = 'USA', false)`],
    [
      'completion_mapping_version',
      sql`select count(*) from cases where generation_id = ${g} and completion_mapping_version <> ${mappingVersion}`,
    ],
    [
      'defining_event_consistent',
      sql`select count(*) from case_aircraft a
          left join lateral (select count(*) filter (where q.is_defining) as n from case_sequence q
            where q.generation_id = a.generation_id and q.ntsb_no = a.ntsb_no and q.aircraft_key = a.aircraft_key) d on true
          left join case_sequence q on q.generation_id = a.generation_id and q.ntsb_no = a.ntsb_no
            and q.aircraft_key = a.aircraft_key and q.occurrence_no = a.defining_occurrence_no
          where a.generation_id = ${g} and not coalesce(
            a.defining_event_conflict = (d.n > 1)
            and (a.defining_occurrence_no is not null) = (d.n = 1)
            and (a.defining_occurrence_no is null or (q.is_defining and q.phase_group = a.defining_phase_group)), false)`,
    ],
    [
      'quarantine_run_matches_generation',
      sql`select count(*) from quarantine where generation_id = ${g} and run_id <> ${runId}`,
    ],
  ];
}

/** Aggregate measures; the names match `NormalizeStats` where both exist. */
async function measure(db: Queryable, g: number): Promise<Record<string, number>> {
  const [c] = await rows(
    db,
    sql`select
          count(*)::int as events,
          count(distinct ntsb_no)::int as "uniqueNtsbNo",
          count(*) filter (where is_us)::int as "usEvents",
          count(*) filter (where answer_eligible)::int as "answerEligibleUs",
          count(*) filter (where completed_with_cause)::int as "completedWithCause",
          count(*) filter (where completion_class = 'completed' and not has_probable_cause)::int as "completedWithoutCause",
          count(*) filter (where completion_class = 'completed' and not has_probable_cause and is_us)::int as "completedWithoutCauseUs",
          count(*) filter (where cardinality(defining_phase_groups) > 1)::int as "eventsWithSeveralDefiningPhases",
          count(*) filter (where latitude is null and is_us)::int as "usEventsWithoutLocation"
        from cases where generation_id = ${g}`,
  );
  const [a] = await rows(
    db,
    sql`select count(*)::int as aircraft,
          count(*) filter (where defining_event_conflict)::int as "definingConflicts",
          (select count(*)::int from (select 1 from case_aircraft where generation_id = ${g}
             group by ntsb_no having count(*) > 1) m) as "multiAircraftEvents"
        from case_aircraft where generation_id = ${g}`,
  );
  const [s] = await rows(
    db,
    sql`select count(*)::int as sections,
          count(*) filter (where scope = 'event')::int as "eventScopedSections",
          count(*) filter (where scope = 'event' and kind = 'factual')::int as "eventScopedSectionsByKind.factual",
          count(*) filter (where scope = 'event' and kind = 'analysis')::int as "eventScopedSectionsByKind.analysis",
          count(*) filter (where scope = 'event' and kind = 'probable_cause')::int as "eventScopedSectionsByKind.probable_cause",
          count(*) filter (where exists (select 1 from case_section_sources x where x.generation_id = s.generation_id
            and x.section_id = s.section_id and x.transformed_from_html))::int as "htmlTransformedSections"
        from case_sections s where generation_id = ${g}`,
  );
  const [x] = await rows(
    db,
    sql`select count(*)::int as "sectionSources",
          count(*) filter (where match = 'whitespace')::int as "whitespaceMergedRows",
          count(*) filter (where source_form = 'stored')::int as "sourceForms.stored",
          count(*) filter (where source_form = 'canonical')::int as "sourceForms.canonical",
          count(*) filter (where source_form = 'canonical_crlf')::int as "sourceForms.canonical_crlf",
          count(distinct (ntsb_no, source_aircraft_key))::int as "narrativeRowsWithText"
        from case_section_sources where generation_id = ${g}`,
  );
  const tableCounts = await rows(
    db,
    sql`select 'rows.cases' as k, count(*)::int as n from cases where generation_id = ${g}
        union all select 'rows.case_aircraft', count(*)::int from case_aircraft where generation_id = ${g}
        union all select 'rows.case_engines', count(*)::int from case_engines where generation_id = ${g}
        union all select 'rows.case_findings', count(*)::int from case_findings where generation_id = ${g}
        union all select 'rows.case_sequence', count(*)::int from case_sequence where generation_id = ${g}
        union all select 'rows.case_sections', count(*)::int from case_sections where generation_id = ${g}
        union all select 'rows.case_section_sources', count(*)::int from case_section_sources where generation_id = ${g}
        union all select 'rows.code_dictionary', count(*)::int from code_dictionary where generation_id = ${g}
        union all select 'rows.quarantine', count(*)::int from quarantine where generation_id = ${g}`,
  );
  const quarantineRows = await rows(
    db,
    sql`select reason, table_name, action, count(*)::int as n from quarantine where generation_id = ${g}
        group by reason, table_name, action`,
  );
  const statusRows = await rows(
    db,
    sql`select coalesce(raw_status, '(blank)') as status, count(*)::int as n from cases
        where generation_id = ${g} and is_us group by 1`,
  );

  const out: Record<string, number> = {};
  for (const r of [c, a, s, x]) for (const [k, v] of Object.entries(r ?? {})) out[k] = Number(v);
  for (const r of tableCounts) out[String(r.k)] = Number(r.n);
  for (const r of quarantineRows) {
    const reasonKey = `quarantineByReason.${String(r.reason)}`;
    out[reasonKey] = (out[reasonKey] ?? 0) + Number(r.n);
    if (r.action === 'row_excluded') {
      const key = `excludedRows.${String(r.table_name)}`;
      out[key] = (out[key] ?? 0) + Number(r.n);
    }
  }
  for (const r of statusRows) out[`usRawStatus.${String(r.status)}`] = Number(r.n);
  return out;
}

/** Stored-vs-normalization and stored-vs-source reconciliation, as named mismatches. */
function reconcile(counts: Record<string, number>, stats: GenerationStats, manifest: ExtractManifest): string[] {
  const mismatches: string[] = [];
  const expect = (name: string, actual: number | undefined, expected: number): void => {
    if ((actual ?? 0) !== expected) mismatches.push(name);
  };
  const n = stats.normalize;
  for (const key of [
    'events',
    'usEvents',
    'multiAircraftEvents',
    'aircraft',
    'sections',
    'eventScopedSections',
    'whitespaceMergedRows',
    'htmlTransformedSections',
    'completedWithCause',
    'completedWithoutCause',
    'answerEligibleUs',
    'completedWithoutCauseUs',
    'eventsWithSeveralDefiningPhases',
    'definingConflicts',
  ] as const) {
    expect(`stats.${key}`, counts[key], n[key]);
  }
  for (const [kind, value] of Object.entries(n.eventScopedSectionsByKind)) {
    expect(`stats.eventScopedSectionsByKind.${kind}`, counts[`eventScopedSectionsByKind.${kind}`], value);
  }
  const reasons = new Set([
    ...Object.keys(n.quarantineByReason),
    ...Object.keys(counts).filter((k) => k.startsWith('quarantineByReason.')).map((k) => k.slice('quarantineByReason.'.length)),
  ]);
  for (const reason of reasons) {
    const expected = (n.quarantineByReason as Record<string, number | undefined>)[reason] ?? 0;
    expect(`stats.quarantineByReason.${reason}`, counts[`quarantineByReason.${reason}`], expected);
  }
  for (const [table, value] of Object.entries(stats.rows)) expect(`rows.${table}`, counts[`rows.${table}`], value);
  for (const [form, value] of Object.entries(stats.sourceForms)) expect(`sourceForms.${form}`, counts[`sourceForms.${form}`], value);

  // Every source row is either stored or recorded as excluded (orphan or malformed key).
  const source = (t: string): number => manifest.tables[t]?.rows ?? 0;
  const excluded = (t: string): number => counts[`excludedRows.${t}`] ?? 0;
  expect('source.events', counts['rows.cases'], source('events'));
  expect('source.aircraft', counts['rows.case_aircraft'], source('aircraft') - excluded('aircraft'));
  expect('source.engines', counts['rows.case_engines'], source('engines') - excluded('engines'));
  expect('source.findings', counts['rows.case_findings'], source('findings') - excluded('findings'));
  expect('source.events_sequence', counts['rows.case_sequence'], source('events_sequence') - excluded('events_sequence'));
  expect(
    'source.ntsb_admin',
    (counts['rows.cases'] ?? 0) - (counts['quarantineByReason.missing_admin_row'] ?? 0),
    source('ntsb_admin') - excluded('ntsb_admin'),
  );
  // Narrative rows with any text: at most the narrative rows kept.
  if ((counts.narrativeRowsWithText ?? 0) > source('narratives') - excluded('narratives')) mismatches.push('source.narratives');
  return mismatches;
}

/** Mappings defined in code, by version; a stored mapping must equal its definition. */
const KNOWN_MAPPINGS: Readonly<Record<string, CompletionMapping>> = { [COMPLETION_MAPPING_V1.version]: COMPLETION_MAPPING_V1 };

function sameMapping(a: CompletionMapping, b: CompletionMapping): boolean {
  const canon = (m: CompletionMapping) =>
    JSON.stringify([m.version, m.verified, [...m.completedStatuses].sort(), [...m.inProgressStatuses].sort()]);
  return canon(a) === canon(b);
}

/**
 * Recompute every case's completion class from its raw status with the mapping the
 * generation recorded. The recorded mapping must carry the generation's version and,
 * for a version defined in code, equal that definition.
 */
async function completionMismatches(
  db: Queryable,
  g: number,
  mappingVersion: string,
  stats: GenerationStats,
): Promise<Omit<VerifyCheck, 'name'>> {
  const mapping = stats.completionMapping;
  let failures = 0;
  if (!mapping || mapping.version !== mappingVersion) failures += 1;
  const known = KNOWN_MAPPINGS[mappingVersion];
  if (mapping && known && !sameMapping(mapping, known)) failures += 1;
  if (mapping) {
    const groups = await rows(
      db,
      sql`select raw_status, completion_class, count(*)::int as n from cases where generation_id = ${g} group by 1, 2`,
    );
    for (const r of groups) {
      if (completionClassOf(r.raw_status as string | null, mapping) !== r.completion_class) failures += Number(r.n);
    }
  }
  return { failures, ok: failures === 0 };
}

function checkProfile(profile: VerifyProfile, counts: Record<string, number>): ProfileResult {
  const mismatches: ProfileResult['mismatches'] = [];
  for (const [measureName, expected] of Object.entries(profile.expected)) {
    const actual = Object.hasOwn(counts, measureName) ? (counts[measureName] as number) : null;
    if (actual !== expected) mismatches.push({ measure: measureName, expected, actual });
  }
  return { name: profile.name, ok: mismatches.length === 0, mismatches };
}

export interface SourceRowForCheck {
  sourceForm: SourceForm;
  sourceText: string | null;
  sourceSha256: string;
  match: 'exact' | 'whitespace';
  transformedFromHtml: boolean;
}

export interface SourceProblems {
  /** The exported text cannot be rebuilt, or does not hash to `source_sha256`. */
  hash: boolean;
  /** Its canonical citation text does not stand in the claimed relation to the section text. */
  derivation: boolean;
  /** `transformed_from_html` differs from what the citation normalizer reports. */
  htmlFlag: boolean;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Check one narrative source against its section with the normalization code itself:
 * rebuild the exported text, hash it, apply `toCitationText` (CITATION_TEXT_VERSION)
 * and require `exact` sources to produce the section text and `whitespace` sources a
 * text that differs from it only in whitespace.
 */
export function sourceProblems(sectionText: string, src: SourceRowForCheck): SourceProblems {
  let source: string;
  try {
    source = reconstructSource(sectionText, src.sourceForm, src.sourceText);
  } catch {
    return { hash: true, derivation: true, htmlFlag: true };
  }
  const hash = sha256Hex(source) !== src.sourceSha256;
  const citation = toCitationText(source);
  const derivation =
    src.match === 'exact'
      ? citation.text !== sectionText
      : citation.text === sectionText || whitespaceKey(citation.text) !== whitespaceKey(sectionText);
  return { hash, derivation, htmlFlag: citation.transformedFromHtml !== src.transformedFromHtml };
}

/** Rows per page when streaming sources (bounded memory). */
const SOURCE_PAGE = 2000;

/** Stream every source of generation `g` (keyset pages) and count the problems. */
async function checkSources(q: Queryable, g: number): Promise<Record<keyof SourceProblems, number>> {
  const totals = { hash: 0, derivation: 0, htmlFlag: 0 };
  let after: { sectionId: string; key: number } | null = null;
  for (;;) {
    const page: Row[] = await rows(
      q,
      sql`select x.section_id, x.source_aircraft_key, x.source_form, x.source_text, x.source_sha256, x.match,
            x.transformed_from_html, s.text
          from case_section_sources x
          join case_sections s on s.generation_id = x.generation_id and s.section_id = x.section_id
          where x.generation_id = ${g}
            ${after ? sql`and (x.section_id, x.source_aircraft_key) > (${after.sectionId}, ${after.key})` : sql``}
          order by x.section_id, x.source_aircraft_key
          limit ${SOURCE_PAGE}`,
    );
    for (const r of page) {
      const p = sourceProblems(String(r.text), {
        sourceForm: r.source_form as SourceForm,
        sourceText: (r.source_text as string | null) ?? null,
        sourceSha256: String(r.source_sha256),
        match: r.match as 'exact' | 'whitespace',
        transformedFromHtml: r.transformed_from_html === true,
      });
      if (p.hash) totals.hash += 1;
      if (p.derivation) totals.derivation += 1;
      if (p.htmlFlag) totals.htmlFlag += 1;
    }
    if (page.length < SOURCE_PAGE) return totals;
    const last = page[page.length - 1] as Row;
    after = { sectionId: String(last.section_id), key: Number(last.source_aircraft_key) };
  }
}

/** Report file of a verification: `verify-gen-<id>-<sha256 of its content>.json`. */
export function verificationReportPath(outDir: string, generationId: number, reportSha256: string): string {
  return join(outDir, `verify-gen-${generationId}-${reportSha256}.json`);
}

/** File operations of the report writer; replaceable in tests to inject short writes and failures. */
export interface ReportFileOps {
  /** Write up to `length` bytes of `buffer` from `offset`; returns the bytes written. */
  write(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
}

const NODE_FILE_OPS: ReportFileOps = {
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  rename: (from, to) => renameSync(from, to),
};

/**
 * Write a report under its content-addressed name `verify-gen-<id>-<sha256>.json`,
 * where the hash is of the UTF-8 bytes written. The bytes go to a private temporary
 * file in the same directory, in a loop until every byte is written (a short write
 * is continued, no progress is an error), are flushed, read back and compared with
 * the hash, and only then renamed into place (atomic on one file system). Any
 * failure removes the temporary file and publishes nothing. An existing file of the
 * target name already holds exactly these bytes.
 */
export function writeReportAtomically(
  outDir: string,
  generationId: number,
  content: string,
  ops: ReportFileOps = NODE_FILE_OPS,
): { path: string; sha256: string } {
  const bytes = Buffer.from(content, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(outDir, { recursive: true });
  const target = verificationReportPath(outDir, generationId, sha256);
  const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  let published = false;
  try {
    const fd = openSync(temp, 'wx', 0o644);
    let failure: unknown = null;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = ops.write(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
          throw new Error(`report write made no progress at byte ${offset} of ${bytes.length}`);
        }
        offset += written;
      }
      ops.fsync(fd);
    } catch (err) {
      failure = err;
    }
    try {
      ops.close(fd);
    } catch (err) {
      failure ??= err;
    }
    if (failure !== null) throw failure;
    const onDisk = createHash('sha256').update(readFileSync(temp)).digest('hex');
    if (onDisk !== sha256) throw new Error('report file on disk does not match its content hash');
    ops.rename(temp, target);
    published = true;
    return { path: target, sha256 };
  } finally {
    if (!published) rmSync(temp, { force: true });
  }
}

function isConflict(err: unknown): boolean {
  return err instanceof LifecycleError && err.code === '40001';
}

/**
 * Verify generation `generationId` and record the outcome with `record_verification`:
 * a never-published generation becomes `verified` or `failed`; a `published` or
 * `retired` one keeps its status. Either way the latest outcome, time, verifier
 * version and report hash are stored, and publication requires that outcome to be ok
 * with the current `VERIFIER_VERSION`. Runs under the lifecycle lock in one
 * REPEATABLE READ transaction; if the generation changed meanwhile, nothing is
 * recorded and the report says `conflict`. Writes `<outDir>/verify-gen-<id>-<sha256>.json`
 * (aggregate counts only); its sha256 is the recorded report hash.
 */
export async function verifyCorpus(db: Db, generationId: number, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const analyzed = await analyzeCorpus(db).then(
    () => true,
    () => false,
  );
  return withLifecycleLock(db, async (q, client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const report = await verifyInSnapshot(q, generationId, opts, analyzed);
      if (report.conflict) await client.query('ROLLBACK');
      else await client.query('COMMIT');
      return report;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

async function verifyInSnapshot(q: Queryable, generationId: number, opts: VerifyOptions, analyzed: boolean): Promise<VerifyReport> {
  const [gen] = await q.select().from(datasetGenerations).where(eq(datasetGenerations.id, generationId));
  if (!gen) throw new Error(`generation ${generationId} does not exist`);
  if (gen.status === 'loading') throw new Error(`generation ${generationId} is still loading`);
  const stats = gen.stats as GenerationStats;
  const manifest = gen.extractManifest as ExtractManifest;
  const profile = opts.profile === undefined ? findProfile(gen.archiveSha256) : opts.profile;
  if (profile && profile.archiveSha256 !== gen.archiveSha256) {
    throw new Error(`profile ${profile.name} describes a different archive than generation ${generationId}`);
  }

  const checks: VerifyCheck[] = [];
  const push = (name: string, failures: number): void => {
    checks.push({ name, failures, ok: failures === 0 });
  };
  for (const [name, query] of invariantQueries(generationId, gen.citationTextVersion, gen.mappingVersion, gen.ingestionRunId)) {
    push(name, await scalar(q, query));
  }

  // Citation text must follow from the exported sources (same code as normalization).
  const sourceTotals = await checkSources(q, generationId);
  push('source_text_reconstructs_to_sha256', sourceTotals.hash);
  push('source_derives_section_text', sourceTotals.derivation);
  push('source_html_flag', sourceTotals.htmlFlag);

  // Revision ids are recomputed with the loader's own function (no text needed).
  const revisions = await q
    .select({
      ntsbNo: caseSections.ntsbNo,
      sectionKey: caseSections.sectionKey,
      sha256: caseSections.sha256,
      version: caseSections.citationTextVersion,
      revisionId: caseSections.revisionId,
    })
    .from(caseSections)
    .where(eq(caseSections.generationId, generationId));
  push(
    'section_revision_id',
    revisions.filter((r) => sectionRevisionId(r.ntsbNo, r.sectionKey, r.sha256, r.version) !== r.revisionId).length,
  );

  push('completion_class_matches_mapping', (await completionMismatches(q, generationId, gen.mappingVersion, stats)).failures);

  const counts = await measure(q, generationId);
  const mismatches = reconcile(counts, stats, manifest);
  push('counts_match_normalization_and_source', mismatches.length);

  const profileResult = profile ? checkProfile(profile, counts) : null;
  const ok = checks.every((c) => c.ok) && (profileResult?.ok ?? true);
  const checkedAt = new Date();

  const outDir = opts.outDir ?? DEFAULT_VERIFY_DIR;
  const file = `${JSON.stringify(
    {
      generationId,
      verifierVersion: VERIFIER_VERSION,
      ok,
      verifiedStatus: gen.status,
      checkedAt: checkedAt.toISOString(),
      analyzed,
      versions: {
        mapping: gen.mappingVersion,
        mappingVerified: gen.mappingVerified,
        citationText: gen.citationTextVersion,
        fieldNormalization: gen.fieldNormalizationVersion,
      },
      checks,
      counts,
      countMismatches: mismatches,
      profile: profileResult,
    },
    null,
    2,
  )}\n`;
  // Content-addressed and written atomically before the hash is recorded: an attempt
  // that fails later leaves at most an unreferenced report, never a damaged one.
  const { path: reportPath, sha256: reportSha256 } = writeReportAtomically(outDir, generationId, file);

  await opts.beforeRecord?.();
  let status: GenerationStatus = gen.status;
  let verificationStatus: VerificationStatus | null = gen.verificationStatus;
  let conflict = false;
  try {
    const [row] = await rows(
      q,
      sql`select record_verification(${generationId}, ${gen.status}, ${ok}, ${VERIFIER_VERSION}, ${reportSha256}) as status`,
    ).catch((err: unknown) => {
      throw lifecycleError(err);
    });
    status = row?.status as GenerationStatus;
    verificationStatus = ok ? 'ok' : 'failed';
  } catch (err) {
    if (!isConflict(err)) throw err;
    conflict = true;
  }

  return {
    generationId,
    ok,
    statusBefore: gen.status,
    status,
    conflict,
    verificationStatus,
    verifierVersion: VERIFIER_VERSION,
    reportSha256,
    checkedAt: checkedAt.toISOString(),
    analyzed,
    versions: {
      mapping: gen.mappingVersion,
      mappingVerified: gen.mappingVerified,
      citationText: gen.citationTextVersion,
      fieldNormalization: gen.fieldNormalizationVersion,
    },
    checks,
    counts,
    profile: profileResult,
    reportPath,
  };
}
