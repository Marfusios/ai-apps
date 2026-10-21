/**
 * Generation verification (amendment A6). `verifyCorpus` checks generic invariants of
 * one loaded generation, compares its counts with the normalization stats and the
 * extraction manifest, optionally checks a snapshot verification profile, and then
 * marks the generation `verified` (or `failed`). Its report file holds aggregate
 * counts only: no case numbers, keys or text.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../server/db/client.js';
import { caseSections, datasetGenerations, type GenerationStatus } from '../../server/db/schema/index.js';
import { COMPLETION_MAPPING_V1, completionClassOf, type CompletionMapping } from '../../shared/completion.js';
import type { ExtractManifest } from './extract.js';
import type { GenerationStats } from './load.js';
import { analyzeCorpus, sectionRevisionId } from './load.js';

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
  ok: boolean;
  /** Generation status before and after verification. */
  statusBefore: GenerationStatus;
  status: GenerationStatus;
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
  /** Directory for `verify-gen-<id>.json` (default `data/work`). */
  outDir?: string;
  /** A profile to check (its archive hash must match), `null` for none; default: the committed profile for the archive. */
  profile?: VerifyProfile | null;
}

type Row = Record<string, unknown>;

async function rows(db: Db, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return result.rows as Row[];
}

async function scalar(db: Db, query: SQL): Promise<number> {
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
      'source_text_reconstructs_to_sha256',
      sql`select count(*) from case_section_sources x
          join case_sections s on s.generation_id = x.generation_id and s.section_id = x.section_id
          where x.generation_id = ${g} and encode(sha256(convert_to(case x.source_form
            when 'stored' then x.source_text
            when 'canonical_crlf' then replace(s.text, E'\\n', E'\\r\\n')
            else s.text end, 'UTF8')), 'hex') is distinct from x.source_sha256`,
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
async function measure(db: Db, g: number): Promise<Record<string, number>> {
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
  db: Db,
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

function nextStatus(current: GenerationStatus, ok: boolean): GenerationStatus {
  if (current === 'published' || current === 'retired') return current; // never demote a live or previous generation
  return ok ? 'verified' : 'failed';
}

/**
 * Verify generation `generationId` and record the outcome: `loading`/`verified`/`failed`
 * become `verified` when every check passes and `failed` otherwise; a `published` or
 * `retired` generation keeps its status (its `verified_at` is refreshed on success).
 * Writes `<outDir>/verify-gen-<id>.json` (aggregate counts only).
 */
export async function verifyCorpus(db: Db, generationId: number, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const [gen] = await db.select().from(datasetGenerations).where(eq(datasetGenerations.id, generationId));
  if (!gen) throw new Error(`generation ${generationId} does not exist`);
  const stats = gen.stats as GenerationStats;
  const manifest = gen.extractManifest as ExtractManifest;
  const profile = opts.profile === undefined ? findProfile(gen.archiveSha256) : opts.profile;
  if (profile && profile.archiveSha256 !== gen.archiveSha256) {
    throw new Error(`profile ${profile.name} describes a different archive than generation ${generationId}`);
  }
  const analyzed = await analyzeCorpus(db).then(
    () => true,
    () => false,
  );

  const checks: VerifyCheck[] = [];
  for (const [name, query] of invariantQueries(generationId, gen.citationTextVersion, gen.mappingVersion, gen.ingestionRunId)) {
    const failures = await scalar(db, query);
    checks.push({ name, failures, ok: failures === 0 });
  }

  // Revision ids are recomputed with the loader's own function (no text needed).
  const revisions = await db
    .select({
      ntsbNo: caseSections.ntsbNo,
      sectionKey: caseSections.sectionKey,
      sha256: caseSections.sha256,
      version: caseSections.citationTextVersion,
      revisionId: caseSections.revisionId,
    })
    .from(caseSections)
    .where(eq(caseSections.generationId, generationId));
  const badRevisions = revisions.filter((r) => sectionRevisionId(r.ntsbNo, r.sectionKey, r.sha256, r.version) !== r.revisionId).length;
  checks.push({ name: 'section_revision_id', failures: badRevisions, ok: badRevisions === 0 });

  checks.push({ name: 'completion_class_matches_mapping', ...(await completionMismatches(db, generationId, gen.mappingVersion, stats)) });

  const counts = await measure(db, generationId);
  const mismatches = reconcile(counts, stats, manifest);
  checks.push({ name: 'counts_match_normalization_and_source', failures: mismatches.length, ok: mismatches.length === 0 });

  const profileResult = profile ? checkProfile(profile, counts) : null;

  const ok = checks.every((c) => c.ok) && (profileResult?.ok ?? true);
  const status = nextStatus(gen.status, ok);
  const now = new Date();
  await db
    .update(datasetGenerations)
    .set(ok ? { status, verifiedAt: now } : { status })
    .where(and(eq(datasetGenerations.id, generationId), eq(datasetGenerations.status, gen.status)));

  const outDir = opts.outDir ?? DEFAULT_VERIFY_DIR;
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `verify-gen-${generationId}.json`);
  const report: VerifyReport = {
    generationId,
    ok,
    statusBefore: gen.status,
    status,
    checkedAt: now.toISOString(),
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
  const { reportPath: _omit, ...file } = report;
  writeFileSync(reportPath, `${JSON.stringify({ ...file, countMismatches: mismatches }, null, 2)}\n`);
  return report;
}
