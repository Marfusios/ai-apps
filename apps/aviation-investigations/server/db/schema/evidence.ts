/** Private, immutable once finished, 24-hour evidence searches. Never backed up. */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const evidenceSearches = pgTable('evidence_searches', {
  id: uuid('id').primaryKey().defaultRandom(),
  readOwner: text('read_owner').notNull(),
  readOwnerKind: text('read_owner_kind').notNull(),
  ownerMovedAt: ts('owner_moved_at'),
  billingPrincipal: text('billing_principal').notNull(),
  billingKind: text('billing_kind').notNull(),
  reservationId: bigint('reservation_id', { mode: 'number' }).notNull(),
  generationId: bigint('generation_id', { mode: 'number' }).notNull(),
  casesIndex: text('cases_index').notNull(),
  passagesIndex: text('passages_index').notNull(),
  status: text('status').notNull().default('running'),
  data: jsonb('data').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => [
  check('evidence_owner_check', sql`${t.readOwner} ~ '^[0-9a-f]{64}$' and ${t.billingPrincipal} ~ '^[0-9a-f]{64}$' and ${t.readOwnerKind} in ('trial','account') and ${t.billingKind} in ('trial','account')`),
  check('evidence_expiry_check', sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`),
  check('evidence_status_check', sql`${t.status} in ('running','results','scope_reply','failed')`),
  check('evidence_data_check', sql`jsonb_typeof(${t.data}) = 'object'`),
  check('evidence_indices_check', sql`${t.casesIndex} ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and ${t.passagesIndex} ~ '^[a-z0-9][a-z0-9._-]{0,254}$'`),
  index('evidence_expires_idx').on(t.expiresAt),
  index('evidence_owner_idx').on(t.readOwner, t.readOwnerKind),
]);
