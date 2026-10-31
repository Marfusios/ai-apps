import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, boolean, bigint, jsonb, smallint, integer, numeric, unique, check, primaryKey } from 'drizzle-orm/pg-core';
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** No private search/account data; the import role never receives those tables. */
export const importControl = pgTable('import_control', {
  id: smallint('id').primaryKey(), fence: uuid('fence'), ownerPid: integer('owner_pid'), restoreRequired: boolean('restore_required').notNull().default(false),
  accepted: jsonb('accepted'), lastRemoteFetchAt: ts('last_remote_fetch_at'), updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [check('import_control_singleton', sql`${t.id} = 1`)]);
export const importArtifacts = pgTable('import_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(), environment: text('environment').notNull(),
  archiveSha256: text('archive_sha256').notNull(), contentSha256: text('content_sha256').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(), firstReservationAt: ts('first_reservation_at'),
  attempts: integer('attempts').notNull().default(0), needsReview: boolean('needs_review').notNull().default(false),
  reason: text('reason'), generationId: bigint('generation_id', { mode: 'number' }),
  baseline: jsonb('baseline'), certificate: jsonb('certificate'), publication: jsonb('publication'),
  approved: jsonb('approved'), canary: jsonb('canary'), rollback: jsonb('rollback'), supersededAt: ts('superseded_at'),
}, t => [unique('import_artifact_identity').on(t.environment, t.archiveSha256),
  check('import_artifact_environment', sql`${t.environment} in ('dev','live')`),
  check('import_artifact_digests', sql`${t.archiveSha256} ~ '^[0-9a-f]{64}$' and ${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check('import_artifact_attempts', sql`${t.attempts} >= 0`)]);
export const importRuns = pgTable('import_runs', {
  id: uuid('id').primaryKey().defaultRandom(), artifactId: uuid('artifact_id').references(() => importArtifacts.id),
  checkedAt: ts('checked_at').notNull().defaultNow(), finishedAt: ts('finished_at'), heartbeatAt: ts('heartbeat_at').notNull().defaultNow(),
  mode: text('mode').notNull(), source: jsonb('source'), step: text('step').notNull().default('check'),
  result: text('result').notNull().default('running'), reason: text('reason'),
  sourceCheckSucceeded: boolean('source_check_succeeded').notNull().default(false), canaryPassed: boolean('canary_passed').notNull().default(false),
  /** Historical report snapshot only; never used for budget admission or ledger compaction. */
  reportedCostUsd: numeric('reported_cost_usd', {precision:12,scale:6}).notNull().default('0'),
  observedSha256: text('observed_sha256'),
});
export const importIndexRefs = pgTable('import_index_refs', {
  indexName: text('index_name').notNull(), artifactId: uuid('artifact_id').notNull().references(() => importArtifacts.id),
  buildId: text('build_id').notNull(), generationId: bigint('generation_id', { mode: 'number' }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(), releasedAt: ts('released_at'),
}, t => [primaryKey({ columns: [t.indexName,t.artifactId] })]);
