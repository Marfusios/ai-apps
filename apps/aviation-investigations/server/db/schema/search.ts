/**
 * Search-index publications: one row per index build, so an alias switch whose outcome
 * is uncertain is never forgotten. Written by workers (aviation_ingest) under the
 * alias's advisory lock; never deleted (an audit trail of builds).
 *
 * - `building`: the index is being created and loaded.
 * - `switching`: the alias request is about to be or has been sent.
 * - `committed`: the alias request was applied (by its response or a reconcile).
 * - `unknown`: the request failed in transport or timed out; Elasticsearch may still
 *   apply it. The alias accepts no automatic switch until `worker index reconcile`.
 * - `abandoned`: the index is certainly not the alias target; `deleted_at` is set once
 *   the index itself is deleted.
 *
 * `generation_id` is informational (no foreign key), so pruning a generation never
 * depends on its build history; it is null for manual switches.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const PUBLICATION_STATUSES = ['building', 'switching', 'committed', 'unknown', 'abandoned'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const indexPublications = pgTable(
  'index_publications',
  {
    indexName: text('index_name').primaryKey(),
    alias: text('alias').notNull(),
    buildId: text('build_id').notNull(),
    generationId: bigint('generation_id', { mode: 'number' }),
    status: text('status', { enum: PUBLICATION_STATUSES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('index_publications_build_unique').on(t.buildId),
    index('index_publications_alias_idx').on(t.alias, t.status),
    check('index_publications_status_check', sql`${t.status} in (${inList(PUBLICATION_STATUSES)})`),
    check('index_publications_deleted_check', sql`${t.deletedAt} is null or ${t.status} = 'abandoned'`),
    check('index_publications_names_check', sql`${t.indexName} ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and ${t.alias} ~ '^[a-z0-9][a-z0-9._-]{0,254}$'`),
  ],
);
