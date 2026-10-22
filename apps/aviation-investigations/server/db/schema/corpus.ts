/**
 * Canonical corpus schema (amendment A6: dataset generations).
 *
 * Every load writes one new generation in one transaction. All corpus rows carry
 * `generation_id`, primary keys include it, and foreign keys are composite so a
 * child row can only reference a parent of the same generation. Rows are never
 * updated in place: a reload writes a new generation and old generations are
 * only ever deleted whole (pruning). `ev_id` stays internal and is never part of
 * an API-facing projection.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Generation lifecycle. `loading`: open for corpus writes, only inside the load
 * transaction. `loaded`: sealed at the end of that transaction, not yet verified.
 * `verified` / `failed`: the latest verification of a never-published generation.
 * `published`: the active manifest points at it. `retired`: published earlier and
 * replaced. Only `loading` accepts corpus writes (database triggers); every change
 * after insertion goes through the migrator-owned functions in migration 0003.
 */
export const GENERATION_STATUSES = ['loading', 'loaded', 'verified', 'failed', 'published', 'retired'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];
/** Latest verification outcome, kept apart from publication status. */
export const VERIFICATION_STATUSES = ['ok', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const COMPLETION_CLASSES = ['completed', 'in_progress', 'status_unknown', 'other_status'] as const;
export const SECTION_KINDS = ['factual', 'analysis', 'probable_cause'] as const;
export const SECTION_SCOPES = ['event', 'aircraft'] as const;
export const SOURCE_MATCHES = ['exact', 'whitespace'] as const;
/**
 * How a narrative row's exported text is kept. `canonical`: identical to the section
 * text. `canonical_crlf`: the section text with every LF written as CRLF. `stored`:
 * anything else (HTML, whitespace variants, mixed line ends), kept in `source_text`.
 * Either way the exact exported bytes are reconstructible and match `source_sha256`.
 */
export const SOURCE_FORMS = ['canonical', 'canonical_crlf', 'stored'] as const;
export type SourceForm = (typeof SOURCE_FORMS)[number];
export const QUARANTINE_ACTIONS = ['row_excluded', 'value_nulled', 'value_kept'] as const;
export const DICTIONARY_SOURCES = ['eadmspub_datadictionary', 'ct_seqevt'] as const;

const SHA256_HEX = "'^[0-9a-f]{64}$'";
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

const generationId = () => bigint('generation_id', { mode: 'number' }).notNull();
const ntsbNo = () => text('ntsb_no').notNull();
const aircraftKey = () => integer('aircraft_key').notNull();
/** Source `lchg_date` as recorded (local time, no zone invented). */
const lastChangedAt = () => timestamp('last_changed_at', { mode: 'string' });

// ---------------------------------------------------------------------------
// Runs and generations

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    status: text('status', { enum: RUN_STATUSES }).notNull(),
    archiveSha256: text('archive_sha256'),
    mappingVersion: text('mapping_version').notNull(),
    textNormalizationVersion: text('text_normalization_version').notNull(),
    fieldNormalizationVersion: text('field_normalization_version').notNull(),
    /** Aggregate counts only. */
    counts: jsonb('counts'),
    /** Failure message (keys and counts, never narrative text). */
    error: text('error'),
  },
  (t) => [
    check('ingestion_runs_status_check', sql`${t.status} in (${inList(RUN_STATUSES)})`),
    check('ingestion_runs_finished_check', sql`(${t.status} = 'running') = (${t.finishedAt} is null)`),
  ],
);

export const datasetGenerations = pgTable(
  'dataset_generations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ingestionRunId: bigint('ingestion_run_id', { mode: 'number' })
      .notNull()
      .references(() => ingestionRuns.id),
    archiveSha256: text('archive_sha256').notNull(),
    extractManifest: jsonb('extract_manifest').notNull(),
    mappingVersion: text('mapping_version').notNull(),
    /** False while the completion mapping is unverified: the answer cohort is provisional (A5). */
    mappingVerified: boolean('mapping_verified').notNull(),
    citationTextVersion: text('citation_text_version').notNull(),
    fieldNormalizationVersion: text('field_normalization_version').notNull(),
    status: text('status', { enum: GENERATION_STATUSES }).notNull(),
    /** Start of the load transaction. */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** When the load sealed it (just before commit); retention grace counts from here. */
    sealedAt: timestamp('sealed_at', { withTimezone: true, mode: 'date' }),
    /** Latest verification: outcome, time, verifier version and sha256 of its report file. */
    verificationStatus: text('verification_status', { enum: VERIFICATION_STATUSES }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    verifierVersion: text('verifier_version'),
    verificationReportSha256: text('verification_report_sha256'),
    /** Normalization stats and loaded row counts; aggregate counts only. */
    stats: jsonb('stats').notNull(),
  },
  (t) => [
    unique('dataset_generations_run_unique').on(t.ingestionRunId),
    check('dataset_generations_status_check', sql`${t.status} in (${inList(GENERATION_STATUSES)})`),
    check('dataset_generations_archive_check', sql`${t.archiveSha256} ~ ${sql.raw(SHA256_HEX)}`),
    check('dataset_generations_sealed_check', sql`(${t.status} = 'loading') = (${t.sealedAt} is null)`),
    check(
      'dataset_generations_verification_check',
      sql`(${t.verificationStatus} is null) = (${t.verifiedAt} is null)
        and (${t.verificationStatus} is null) = (${t.verifierVersion} is null)
        and (${t.verificationStatus} is null) = (${t.verificationReportSha256} is null)
        and (${t.verificationStatus} is null or ${t.verificationStatus} in (${inList(VERIFICATION_STATUSES)}))
        and (${t.verificationReportSha256} is null or ${t.verificationReportSha256} ~ ${sql.raw(SHA256_HEX)})
        and (${t.status} <> 'verified' or ${t.verificationStatus} = 'ok')
        and (${t.status} <> 'failed' or ${t.verificationStatus} = 'failed')
        and (${t.status} not in ('loading', 'loaded') or ${t.verificationStatus} is null)`,
    ),
  ],
);

/**
 * Search indices built for a generation. At most one row is active; the API pins
 * every request to it. Flipped only by `publishManifest`, after the generation's
 * indices exist. `passages_index` is null for a keyword-only manifest: search, case
 * pages and the dashboard work, and AI routes stay off until a manifest names one.
 */
export const datasetManifests = pgTable(
  'dataset_manifests',
  {
    generationId: bigint('generation_id', { mode: 'number' })
      .primaryKey()
      .references(() => datasetGenerations.id),
    casesIndex: text('cases_index').notNull(),
    passagesIndex: text('passages_index'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    active: boolean('active').notNull().default(false),
  },
  (t) => [
    uniqueIndex('dataset_manifests_single_active').on(t.active).where(sql`active`),
    check('dataset_manifests_active_published_check', sql`not ${t.active} or ${t.publishedAt} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// Corpus

export const cases = pgTable(
  'cases',
  {
    generationId: generationId().references(() => datasetGenerations.id),
    /** Public case key (event-level `ntsb_no`). */
    ntsbNo: ntsbNo(),
    /** Internal event id; never exposed by the API. */
    evId: text('ev_id').notNull(),
    /** `ev_country` as published (e.g. USA). */
    country: text('country'),
    isUs: boolean('is_us').notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    evType: text('ev_type'),
    evDate: date('ev_date', { mode: 'string' }),
    evDow: text('ev_dow'),
    /** HHMM as recorded, in the `ev_tmzn` zone. */
    evTime: integer('ev_time'),
    evTmzn: text('ev_tmzn'),
    city: text('city'),
    state: text('state'),
    evYear: integer('ev_year'),
    evMonth: integer('ev_month'),
    lightCond: text('light_cond'),
    skyCondNonceil: text('sky_cond_nonceil'),
    skyNonceilHt: doublePrecision('sky_nonceil_ht'),
    skyCeilHt: doublePrecision('sky_ceil_ht'),
    skyCondCeil: text('sky_cond_ceil'),
    visSm: doublePrecision('vis_sm'),
    wxTemp: doublePrecision('wx_temp'),
    wxDewPt: doublePrecision('wx_dew_pt'),
    windDirDeg: doublePrecision('wind_dir_deg'),
    windDirInd: text('wind_dir_ind'),
    windVelKts: doublePrecision('wind_vel_kts'),
    windVelInd: text('wind_vel_ind'),
    gustInd: text('gust_ind'),
    gustKts: doublePrecision('gust_kts'),
    altimeter: doublePrecision('altimeter'),
    wxDensAlt: doublePrecision('wx_dens_alt'),
    wxIntPrecip: text('wx_int_precip'),
    wxCondBasic: text('wx_cond_basic'),
    metar: text('metar'),
    highestInjury: text('highest_injury'),
    injFGrnd: integer('inj_f_grnd'),
    injMGrnd: integer('inj_m_grnd'),
    injSGrnd: integer('inj_s_grnd'),
    injTotF: integer('inj_tot_f'),
    injTotM: integer('inj_tot_m'),
    injTotN: integer('inj_tot_n'),
    injTotS: integer('inj_tot_s'),
    injTotT: integer('inj_tot_t'),
    lastChangedAt: lastChangedAt(),
    /** `NTSB_Admin.rec_stat` trimmed; null when blank or the admin row is missing. */
    rawStatus: text('raw_status'),
    approvalDate: date('approval_date', { mode: 'string' }),
    adminLastChangedAt: timestamp('admin_last_changed_at', { mode: 'string' }),
    completionClass: text('completion_class', { enum: COMPLETION_CLASSES }).notNull(),
    completionMappingVersion: text('completion_mapping_version').notNull(),
    hasProbableCause: boolean('has_probable_cause').notNull(),
    completedWithCause: boolean('completed_with_cause').notNull(),
    /** US, completed status and probable-cause text; provisional while the mapping is unverified. */
    answerEligible: boolean('answer_eligible').notNull(),
    definingPhaseGroups: text('defining_phase_groups').array().notNull(),
    sequencePhaseGroups: text('sequence_phase_groups').array().notNull(),
    /** sha256 over the case's projected source rows. */
    sourceRevision: text('source_revision').notNull(),
  },
  (t) => [
    primaryKey({ name: 'cases_pk', columns: [t.generationId, t.ntsbNo] }),
    // Secondary keys lead with their selective column, never generation_id: with
    // statistics that do not know a new generation yet, an index led by generation_id
    // looks as cheap as the primary key and a key lookup would scan the generation.
    unique('cases_ev_id_unique').on(t.evId, t.generationId),
    check('cases_ntsb_no_check', sql`${t.ntsbNo} <> '' and ${t.ntsbNo} !~ '^\\s|\\s$'`),
    check('cases_ev_id_check', sql`${t.evId} <> '' and ${t.evId} !~ '^\\s|\\s$'`),
    check('cases_is_us_check', sql`${t.isUs} = coalesce(${t.country} = 'USA', false)`),
    check(
      'cases_location_check',
      sql`(${t.latitude} is null) = (${t.longitude} is null)
        and (${t.latitude} is null or ${t.latitude} between -90 and 90)
        and (${t.longitude} is null or ${t.longitude} between -180 and 180)`,
    ),
    check('cases_completion_class_check', sql`${t.completionClass} in (${inList(COMPLETION_CLASSES)})`),
    check(
      'cases_completed_with_cause_check',
      sql`${t.completedWithCause} = (${t.completionClass} = 'completed' and ${t.hasProbableCause})`,
    ),
    check('cases_answer_eligible_check', sql`${t.answerEligible} = (${t.isUs} and ${t.completedWithCause})`),
    check('cases_source_revision_check', sql`${t.sourceRevision} ~ ${sql.raw(SHA256_HEX)}`),
  ],
);

export const caseAircraft = pgTable(
  'case_aircraft',
  {
    generationId: generationId(),
    ntsbNo: ntsbNo(),
    aircraftKey: aircraftKey(),
    /** Suffixed (A, B) in multi-aircraft events; never used for joins. */
    aircraftNtsbNo: text('aircraft_ntsb_no'),
    regisNo: text('regis_no'),
    make: text('make'),
    model: text('model'),
    series: text('series'),
    category: text('category'),
    farPart: text('far_part'),
    purpose: text('purpose'),
    damage: text('damage'),
    homebuilt: boolean('homebuilt'),
    numEngines: integer('num_engines'),
    dateLastInsp: date('date_last_insp', { mode: 'string' }),
    afmHrs: doublePrecision('afm_hrs'),
    afmHrsLastInsp: doublePrecision('afm_hrs_last_insp'),
    /** `afm_hrs_since` Y/N as recorded; meaning not interpreted. */
    afmHrsSince: boolean('afm_hrs_since'),
    acftYear: integer('acft_year'),
    lastChangedAt: lastChangedAt(),
    /** Occurrence of this aircraft's single defining sequence row; null when none or conflicting. */
    definingOccurrenceNo: integer('defining_occurrence_no'),
    definingPhaseGroup: text('defining_phase_group'),
    definingEventConflict: boolean('defining_event_conflict').notNull(),
    sequencePhaseGroups: text('sequence_phase_groups').array().notNull(),
  },
  (t) => [
    primaryKey({ name: 'case_aircraft_pk', columns: [t.generationId, t.ntsbNo, t.aircraftKey] }),
    foreignKey({
      name: 'case_aircraft_case_fk',
      columns: [t.generationId, t.ntsbNo],
      foreignColumns: [cases.generationId, cases.ntsbNo],
    }),
    check('case_aircraft_key_check', sql`${t.aircraftKey} >= 0`),
    check(
      'case_aircraft_defining_check',
      sql`(${t.definingOccurrenceNo} is null) = (${t.definingPhaseGroup} is null) and not (${t.definingEventConflict} and ${t.definingOccurrenceNo} is not null)`,
    ),
  ],
);

export const caseEngines = pgTable(
  'case_engines',
  {
    generationId: generationId(),
    ntsbNo: ntsbNo(),
    aircraftKey: aircraftKey(),
    engNo: integer('eng_no').notNull(),
    engType: text('eng_type'),
    carbFuelInjection: text('carb_fuel_injection'),
    lastChangedAt: lastChangedAt(),
  },
  (t) => [
    primaryKey({ name: 'case_engines_pk', columns: [t.generationId, t.ntsbNo, t.aircraftKey, t.engNo] }),
    foreignKey({
      name: 'case_engines_aircraft_fk',
      columns: [t.generationId, t.ntsbNo, t.aircraftKey],
      foreignColumns: [caseAircraft.generationId, caseAircraft.ntsbNo, caseAircraft.aircraftKey],
    }),
  ],
);

export const caseFindings = pgTable(
  'case_findings',
  {
    generationId: generationId(),
    ntsbNo: ntsbNo(),
    aircraftKey: aircraftKey(),
    findingNo: integer('finding_no').notNull(),
    code: text('code'),
    /** `finding_description` verbatim; its trailing "- C"/"- F" is never a cause label. */
    description: text('description'),
    /** `cm_inpc`: T/F/blank. Cause and contributing findings are not distinguished. */
    inProbableCause: boolean('in_probable_cause'),
    /** Deprecated `cause_factor` exactly as exported; provenance only, never a label. */
    causeFactor: text('cause_factor'),
    categoryNo: text('category_no'),
    subcategoryNo: text('subcategory_no'),
    sectionNo: text('section_no'),
    subsectionNo: text('subsection_no'),
    modifierNo: text('modifier_no'),
    lastChangedAt: lastChangedAt(),
  },
  (t) => [
    primaryKey({ name: 'case_findings_pk', columns: [t.generationId, t.ntsbNo, t.aircraftKey, t.findingNo] }),
    foreignKey({
      name: 'case_findings_aircraft_fk',
      columns: [t.generationId, t.ntsbNo, t.aircraftKey],
      foreignColumns: [caseAircraft.generationId, caseAircraft.ntsbNo, caseAircraft.aircraftKey],
    }),
  ],
);

export const caseSequence = pgTable(
  'case_sequence',
  {
    generationId: generationId(),
    ntsbNo: ntsbNo(),
    aircraftKey: aircraftKey(),
    occurrenceNo: integer('occurrence_no').notNull(),
    phaseNo: integer('phase_no'),
    phaseGroup: text('phase_group').notNull(),
    /** `eventsoe_no`. */
    eventCode: text('event_code'),
    occurrenceCode: text('occurrence_code'),
    description: text('description'),
    /** `defining_ev`: 1/0/blank. */
    isDefining: boolean('is_defining'),
    lastChangedAt: lastChangedAt(),
  },
  (t) => [
    primaryKey({ name: 'case_sequence_pk', columns: [t.generationId, t.ntsbNo, t.aircraftKey, t.occurrenceNo] }),
    foreignKey({
      name: 'case_sequence_aircraft_fk',
      columns: [t.generationId, t.ntsbNo, t.aircraftKey],
      foreignColumns: [caseAircraft.generationId, caseAircraft.ntsbNo, caseAircraft.aircraftKey],
    }),
  ],
);

/**
 * Narrative sections, immutable revisions. `section_id` is `<ntsb_no>:<section_key>`;
 * `revision_id` is sha256 over (ntsb_no, section_key, sha256, citation_text_version),
 * so identical text in a later generation keeps its revision and citations resolve.
 * In a multi-aircraft event every section is event-scoped (`aircraft_key` null);
 * `source_aircraft_keys` is provenance, not attribution.
 */
export const caseSections = pgTable(
  'case_sections',
  {
    generationId: generationId(),
    sectionId: text('section_id').notNull(),
    ntsbNo: ntsbNo(),
    sectionKey: text('section_key').notNull(),
    kind: text('kind', { enum: SECTION_KINDS }).notNull(),
    scope: text('scope', { enum: SECTION_SCOPES }).notNull(),
    aircraftKey: integer('aircraft_key'),
    /** Canonical citation text (`citation_text_version`). */
    text: text('text').notNull(),
    /** sha256 hex of `text` (UTF-8). */
    sha256: text('sha256').notNull(),
    citationTextVersion: text('citation_text_version').notNull(),
    transformedFromHtml: boolean('transformed_from_html').notNull(),
    sourceAircraftKeys: integer('source_aircraft_keys').array().notNull(),
    revisionId: text('revision_id').notNull(),
    lastChangedAt: lastChangedAt(),
  },
  (t) => [
    primaryKey({ name: 'case_sections_pk', columns: [t.generationId, t.sectionId] }),
    // Target of the sources' composite foreign key (section and case together).
    unique('case_sections_case_unique').on(t.generationId, t.sectionId, t.ntsbNo),
    unique('case_sections_revision_unique').on(t.revisionId, t.generationId),
    index('case_sections_case_idx').on(t.ntsbNo, t.aircraftKey, t.generationId),
    foreignKey({
      name: 'case_sections_case_fk',
      columns: [t.generationId, t.ntsbNo],
      foreignColumns: [cases.generationId, cases.ntsbNo],
    }),
    foreignKey({
      name: 'case_sections_aircraft_fk',
      columns: [t.generationId, t.ntsbNo, t.aircraftKey],
      foreignColumns: [caseAircraft.generationId, caseAircraft.ntsbNo, caseAircraft.aircraftKey],
    }),
    check('case_sections_id_check', sql`${t.sectionId} = ${t.ntsbNo} || ':' || ${t.sectionKey}`),
    check(
      'case_sections_key_check',
      sql`${t.sectionKey} ~ '^(factual|analysis|probable_cause)/(aircraft|event)-[0-9]+$' and split_part(${t.sectionKey}, '/', 1) = ${t.kind}`,
    ),
    check('case_sections_kind_check', sql`${t.kind} in (${inList(SECTION_KINDS)})`),
    check(
      'case_sections_key_scope_check',
      sql`(${t.scope} = 'aircraft' and ${t.sectionKey} = ${t.kind} || '/aircraft-' || ${t.aircraftKey})
        or (${t.scope} = 'event' and ${t.sectionKey} ~ ('^' || ${t.kind} || '/event-[1-9][0-9]*$'))`,
    ),
    check(
      'case_sections_scope_check',
      sql`(${t.scope} = 'aircraft' and ${t.aircraftKey} is not null and ${t.sourceAircraftKeys} = array[${t.aircraftKey}]) or (${t.scope} = 'event' and ${t.aircraftKey} is null and cardinality(${t.sourceAircraftKeys}) >= 1)`,
    ),
    check('case_sections_text_check', sql`${t.text} ~ '\\S'`),
    check('case_sections_sha_check', sql`${t.sha256} ~ ${sql.raw(SHA256_HEX)} and ${t.revisionId} ~ ${sql.raw(SHA256_HEX)}`),
  ],
);

/** Every narrative row behind a section (provenance only, never attribution). */
export const caseSectionSources = pgTable(
  'case_section_sources',
  {
    generationId: generationId(),
    sectionId: text('section_id').notNull(),
    ntsbNo: ntsbNo(),
    sourceAircraftKey: integer('source_aircraft_key').notNull(),
    /** sha256 hex of the narrative field exactly as exported. */
    sourceSha256: text('source_sha256').notNull(),
    match: text('match', { enum: SOURCE_MATCHES }).notNull(),
    transformedFromHtml: boolean('transformed_from_html').notNull(),
    sourceForm: text('source_form', { enum: SOURCE_FORMS }).notNull(),
    /** The exported text when it is not reconstructible from the section text; else null. */
    sourceText: text('source_text'),
    lastChangedAt: lastChangedAt(),
  },
  (t) => [
    primaryKey({ name: 'case_section_sources_pk', columns: [t.generationId, t.sectionId, t.sourceAircraftKey] }),
    index('case_section_sources_aircraft_idx').on(t.ntsbNo, t.sourceAircraftKey, t.generationId),
    // Composite with ntsb_no: a source belongs to a section of its own case.
    foreignKey({
      name: 'case_section_sources_section_fk',
      columns: [t.generationId, t.sectionId, t.ntsbNo],
      foreignColumns: [caseSections.generationId, caseSections.sectionId, caseSections.ntsbNo],
    }),
    foreignKey({
      name: 'case_section_sources_aircraft_fk',
      columns: [t.generationId, t.ntsbNo, t.sourceAircraftKey],
      foreignColumns: [caseAircraft.generationId, caseAircraft.ntsbNo, caseAircraft.aircraftKey],
    }),
    check('case_section_sources_match_check', sql`${t.match} in (${inList(SOURCE_MATCHES)})`),
    check(
      'case_section_sources_form_check',
      sql`${t.sourceForm} in (${inList(SOURCE_FORMS)}) and (${t.sourceForm} = 'stored') = (${t.sourceText} is not null)`,
    ),
    check('case_section_sources_sha_check', sql`${t.sourceSha256} ~ ${sql.raw(SHA256_HEX)}`),
  ],
);

/** Code meanings from the embedded dictionary tables, as published (coded rows only). */
export const codeDictionary = pgTable(
  'code_dictionary',
  {
    generationId: generationId().references(() => datasetGenerations.id),
    entryNo: integer('entry_no').notNull(),
    source: text('source', { enum: DICTIONARY_SOURCES }).notNull(),
    /** Lower-cased table/column the code belongs to; null for `ct_seqevt`. */
    tableName: text('table_name'),
    columnName: text('column_name'),
    code: text('code').notNull(),
    meaning: text('meaning'),
  },
  (t) => [
    primaryKey({ name: 'code_dictionary_pk', columns: [t.generationId, t.entryNo] }),
    index('code_dictionary_lookup_idx').on(t.tableName, t.columnName, t.code, t.generationId),
    check('code_dictionary_source_check', sql`${t.source} in (${inList(DICTIONARY_SOURCES)})`),
  ],
);

/** Value-level problems normalization nulled, excluded or kept (never narrative text). */
export const quarantine = pgTable(
  'quarantine',
  {
    generationId: generationId().references(() => datasetGenerations.id),
    entryNo: integer('entry_no').notNull(),
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => ingestionRuns.id),
    tableName: text('table_name').notNull(),
    /** Canonical source key (contains the internal `ev_id`). */
    key: text('key').notNull(),
    columnName: text('column_name'),
    reason: text('reason').notNull(),
    action: text('action', { enum: QUARANTINE_ACTIONS }).notNull(),
    value: text('value'),
    detail: text('detail').notNull(),
  },
  (t) => [
    primaryKey({ name: 'quarantine_pk', columns: [t.generationId, t.entryNo] }),
    check('quarantine_action_check', sql`${t.action} in (${inList(QUARANTINE_ACTIONS)})`),
  ],
);

/**
 * Generations that pruning must keep (e.g. referenced by live briefs). A pin with a
 * null `pinned_until` holds until removed; an expired pin no longer protects.
 */
export const generationPins = pgTable(
  'generation_pins',
  {
    generationId: bigint('generation_id', { mode: 'number' })
      .notNull()
      .references(() => datasetGenerations.id),
    reason: text('reason').notNull(),
    pinnedUntil: timestamp('pinned_until', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'generation_pins_pk', columns: [t.generationId, t.reason] }),
    check('generation_pins_reason_check', sql`${t.reason} ~ '\\S' and length(${t.reason}) <= 200`),
  ],
);

/** Corpus tables in parent-to-child order (load order; prune deletes in reverse). */
export const GENERATION_TABLES = [
  cases,
  caseAircraft,
  caseEngines,
  caseFindings,
  caseSequence,
  caseSections,
  caseSectionSources,
  codeDictionary,
  quarantine,
] as const;

export const REPORT_LINK_SOURCES = ['seed', 'aviation_search_export'] as const;
export type ReportLinkSource = (typeof REPORT_LINK_SOURCES)[number];

/**
 * External NTSB report-ID mapping. Not a sealed corpus table: it changes on its own
 * cycle (Aviation Search exports), so it has no generation. `ntsb_no` is validated
 * against the latest verified generation at import time. `report_id` is the numeric
 * CAROL id (not `ev_id`).
 */
export const reportLinks = pgTable(
  'report_links',
  {
    ntsbNo: text('ntsb_no').notNull(),
    aircraftNtsbNo: text('aircraft_ntsb_no'),
    reportId: text('report_id').notNull(),
    source: text('source', { enum: REPORT_LINK_SOURCES }).notNull(),
    /** Human-readable provenance, e.g. "manual verification 2026-10-16". Rows of one label are replaced together. */
    sourceLabel: text('source_label').notNull(),
    /** Column mapping used for an export (null for the seed). */
    mapping: jsonb('mapping'),
    sourceFileSha256: text('source_file_sha256').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('report_links_uq').on(t.ntsbNo, t.aircraftNtsbNo, t.reportId).nullsNotDistinct(),
    index('report_links_ntsb_no_idx').on(t.ntsbNo),
    check('report_links_report_id_check', sql`${t.reportId} ~ '^[0-9]{1,9}$'`),
    check('report_links_sha_check', sql`${t.sourceFileSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
