/**
 * Passages and cached embeddings (Task 9; amendments A3, A6, A10).
 *
 * `passages` records how one verified generation's sections were chunked: one row per
 * passage, keyed by (generation, passage id). It is a projection of the sealed corpus
 * and is sealed the same way, by migration triggers rather than foreign keys:
 * - rows are inserted only for a generation that is verified (or published) with an
 *   `ok` verification, and only for an existing section revision of an
 *   answer-eligible US case whose kind, scope and aircraft they repeat;
 *   aircraft-scoped rows only in single-aircraft events;
 * - rows are never updated, and deleted only together with their generation (a
 *   trigger on `dataset_generations` removes them when pruning deletes it).
 * The passage text is not stored: it is `case_sections.text` sliced by the UTF-16
 * offsets `start`/`end`.
 *
 * `embedding_cache` maps the sha256 of an exact embedding input, model, dimensions
 * and input-template version (A10) to its float32 vector (little-endian bytes).
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { SECTION_KINDS, SECTION_SCOPES } from './corpus.js';

const SHA256_HEX = "'^[0-9a-f]{64}$'";
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const passages = pgTable(
  'passages',
  {
    generationId: bigint('generation_id', { mode: 'number' }).notNull(),
    /** sha256 over (revision id, start, end, chunker version). */
    passageId: text('passage_id').notNull(),
    chunkerVersion: text('chunker_version').notNull(),
    ntsbNo: text('ntsb_no').notNull(),
    sectionId: text('section_id').notNull(),
    revisionId: text('revision_id').notNull(),
    sectionSha: text('section_sha').notNull(),
    sectionKind: text('section_kind', { enum: SECTION_KINDS }).notNull(),
    scope: text('scope', { enum: SECTION_SCOPES }).notNull(),
    /** The aircraft of an aircraft-scoped passage; null when event-scoped. */
    aircraftKey: integer('aircraft_key'),
    /** False for event-scoped passages: they never satisfy an aircraft filter as one aircraft's passage. */
    aircraftSpecific: boolean('aircraft_specific').notNull(),
    /** UTF-16 code-unit offsets into the section text. */
    start: integer('start').notNull(),
    end: integer('end').notNull(),
    part: integer('part').notNull(),
    parts: integer('parts').notNull(),
    /** Continues an oversized unit split under A16. */
    continuation: boolean('continuation').notNull(),
    /** Exact cl100k_base tokens of the passage text. */
    tokenCount: integer('token_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'passages_pk', columns: [t.generationId, t.passageId] }),
    index('passages_section_idx').on(t.sectionId, t.generationId),
    check('passages_ids_check', sql`${t.passageId} ~ ${sql.raw(SHA256_HEX)} and ${t.revisionId} ~ ${sql.raw(SHA256_HEX)} and ${t.sectionSha} ~ ${sql.raw(SHA256_HEX)}`),
    check('passages_section_check', sql`starts_with(${t.sectionId}, ${t.ntsbNo} || ':') and ${t.chunkerVersion} ~ '^\\S+$'`),
    check('passages_kind_check', sql`${t.sectionKind} in (${inList(SECTION_KINDS)})`),
    check(
      'passages_scope_check',
      sql`(${t.scope} = 'aircraft' and ${t.aircraftKey} is not null and ${t.aircraftSpecific})
        or (${t.scope} = 'event' and ${t.aircraftKey} is null and not ${t.aircraftSpecific})`,
    ),
    check(
      'passages_span_check',
      sql`${t.start} >= 0 and ${t.end} > ${t.start} and ${t.part} between 1 and ${t.parts}
        and (not ${t.continuation} or ${t.part} > 1) and ${t.tokenCount} between 1 and 8192`,
    ),
  ],
);

export const embeddingCache = pgTable(
  'embedding_cache',
  {
    /** sha256 of (input template version, model, dims, exact input). */
    cacheKey: text('cache_key').primaryKey(),
    model: text('model').notNull(),
    dims: integer('dims').notNull(),
    templateVersion: text('template_version').notNull(),
    /** float32 little-endian, `dims` values. */
    vector: bytea('vector').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('embedding_cache_key_check', sql`${t.cacheKey} ~ ${sql.raw(SHA256_HEX)}`),
    check('embedding_cache_vector_check', sql`${t.dims} between 1 and 4096 and octet_length(${t.vector}) = ${t.dims} * 4`),
    check('embedding_cache_labels_check', sql`${t.model} ~ '^\\S{1,100}$' and ${t.templateVersion} ~ '^\\S{1,100}$'`),
  ],
);
