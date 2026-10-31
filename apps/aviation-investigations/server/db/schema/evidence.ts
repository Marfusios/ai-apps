/** Private, immutable once finished, 24-hour evidence searches. Never backed up. */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { reservations } from './controls.js';
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const evidenceSearches = pgTable('evidence_searches', {
  id: uuid('id').primaryKey().defaultRandom(),
  readOwner: text('read_owner').notNull(),
  readOwnerKind: text('read_owner_kind').notNull(),
  ownerMovedAt: ts('owner_moved_at'),
  billingPrincipal: text('billing_principal').notNull(),
  billingKind: text('billing_kind').notNull(),
  reservationId: bigint('reservation_id', { mode: 'number' }).notNull(),
  /** Write-once quota exemption claim, retained with its parent through expiry. */
  freeUndoReservationId: bigint('free_undo_reservation_id', { mode: 'number' }),
  generationId: bigint('generation_id', { mode: 'number' }).notNull(),
  casesIndex: text('cases_index').notNull(),
  passagesIndex: text('passages_index').notNull(),
  traceId: text('trace_id'),
  feedbackRating: text('feedback_rating'),
  feedbackDay: date('feedback_day', { mode: 'string' }),
  status: text('status').notNull().default('running'),
  data: jsonb('data').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => [
  check('evidence_owner_check', sql`${t.readOwner} ~ '^[0-9a-f]{64}$' and ${t.billingPrincipal} ~ '^[0-9a-f]{64}$' and ${t.readOwnerKind} in ('trial','account') and ${t.billingKind} in ('trial','account')`),
  check('evidence_expiry_check', sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`),
  check('evidence_status_check', sql`${t.status} in ('running','results','scope_reply','failed')`),
  check('evidence_data_check', sql`jsonb_typeof(${t.data}) = 'object'`),
  check('evidence_data_bytes_check', sql`octet_length(${t.data}::text) <= 8388608`),
  check('evidence_indices_check', sql`${t.casesIndex} ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and ${t.passagesIndex} ~ '^[a-z0-9][a-z0-9._-]{0,254}$'`),
  index('evidence_expires_idx').on(t.expiresAt),
  index('evidence_owner_idx').on(t.readOwner, t.readOwnerKind),
]);

/** Identity-free daily totals survive expiry/deletion and are included in backups. */
export const evidenceFeedbackDaily = pgTable('evidence_feedback_daily', {
  day: date('day', { mode: 'string' }).notNull(),
  ranking: text('ranking').notNull(),
  rating: text('rating').notNull(),
  count: bigint('count', { mode: 'number' }).notNull(),
}, t => [primaryKey({ columns: [t.day, t.ranking, t.rating] }),
  check('feedback_values', sql`${t.count} >= 0 and ${t.rating} in ('useful','not_useful') and ${t.ranking} ~ '^[a-zA-Z0-9._-]{1,40}$'`)]);

/** Outcome metadata shares the reservation's 90-day lifetime; no search text. */
export const evidenceUsage = pgTable('evidence_usage', {
  reservationId: bigint('reservation_id', { mode: 'number' }).primaryKey().references(() => reservations.id, { onDelete: 'cascade' }),
  freeUndo: boolean('free_undo').notNull(),
  outcome: text('outcome'),
}, t => [check('evidence_usage_outcome', sql`${t.outcome} is null or ${t.outcome} in ('results','failed')`)]);
