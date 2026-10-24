/**
 * Search-index builds and alias switch attempts (Task 7, gate G3).
 *
 * `index_builds`: one row per index build, written before the index is created, so
 * the index name (which carries the random build id) is reserved for that build. It
 * records when the build started and, once, when the index was deleted.
 *
 * `index_switch_attempts`: append-only, one row per `_aliases` request (or attempt to
 * send one). An attempt starts `pending` and is resolved once: `committed` (the
 * response succeeded, or a later read-back showed the index as an alias target),
 * `rejected` (Elasticsearch refused it) or `unknown` (transport failure or timeout:
 * it may still be applied). `unknown` becomes `committed` only through a read-back;
 * time never resolves it. An operator may declare an `unknown` attempt abandoned
 * (with a reason), which only unblocks further switches of the alias.
 *
 * Cleanup eligibility is never taken from one attempt: an index with any committed,
 * pending or unknown attempt is never deleted by automation (committed is sticky).
 * The database trigger in migration 0010 enforces the allowed transitions.
 *
 * `generation_id` is informational (no foreign key), so pruning a generation never
 * depends on build history.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const SWITCH_OUTCOMES = ['pending', 'committed', 'rejected', 'unknown'] as const;
export type SwitchOutcome = (typeof SWITCH_OUTCOMES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const NAME = "'^[a-z0-9][a-z0-9._-]{0,254}$'";

export const indexBuilds = pgTable(
  'index_builds',
  {
    buildId: text('build_id').primaryKey(),
    indexName: text('index_name').notNull(),
    alias: text('alias').notNull(),
    generationId: bigint('generation_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    /**
     * Set, and committed, before Elasticsearch is asked to delete the index (migration 0021):
     * from then on no brief, publication or alias switch takes it, whatever became of the request.
     */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('index_builds_index_unique').on(t.indexName),
    check('index_builds_build_id_check', sql`${t.buildId} ~ '^[a-z0-9]{4,32}$'`),
    check('index_builds_names_check', sql`${t.indexName} ~ ${sql.raw(NAME)} and ${t.alias} ~ ${sql.raw(NAME)}`),
  ],
);

export const indexSwitchAttempts = pgTable(
  'index_switch_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    alias: text('alias').notNull(),
    indexName: text('index_name').notNull(),
    /** The build that owns the index; null for a manual switch (e.g. a rollback). */
    buildId: text('build_id'),
    outcome: text('outcome', { enum: SWITCH_OUTCOMES }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    /** An operator's assertion that an `unknown` attempt will never apply; unblocks switching only. */
    declaredAbandonedAt: timestamp('declared_abandoned_at', { withTimezone: true, mode: 'date' }),
    declaredReason: text('declared_reason'),
  },
  (t) => [
    index('index_switch_attempts_alias_idx').on(t.alias, t.outcome),
    index('index_switch_attempts_index_idx').on(t.indexName),
    check('index_switch_attempts_outcome_check', sql`${t.outcome} in (${inList(SWITCH_OUTCOMES)})`),
    check('index_switch_attempts_resolved_check', sql`(${t.outcome} = 'pending') = (${t.resolvedAt} is null)`),
    check(
      'index_switch_attempts_declared_check',
      sql`(${t.declaredAbandonedAt} is null) = (${t.declaredReason} is null)
        and (${t.declaredReason} is null or (${t.declaredReason} ~ '\\S' and length(${t.declaredReason}) <= 500))
        and (${t.declaredAbandonedAt} is null or ${t.outcome} in ('unknown', 'committed'))`,
    ),
    check('index_switch_attempts_names_check', sql`${t.indexName} ~ ${sql.raw(NAME)} and ${t.alias} ~ ${sql.raw(NAME)}`),
  ],
);
