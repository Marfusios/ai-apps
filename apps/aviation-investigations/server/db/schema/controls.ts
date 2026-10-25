/**
 * Cost and abuse controls (DESIGN §7–§9): the shared spend ledger, reservations with
 * leases and fencing tokens, usage buckets, idempotency records, trial identities,
 * redeemed Turnstile tokens, the anti-abuse identity record and the AI kill switch.
 *
 * Principals and networks are stored only as HMACs (`server/quota/policy.ts`). Money is
 * USD `numeric(12,6)`. Budgets are counted by `accounting_day`, the UTC day a
 * reservation was made, so a request admitted before midnight stays in that day's
 * and month's totals however late it settles. Grants, row-level security, guard
 * triggers and the pruning function are in migration 0008; migration 0009 limits
 * aviation_ingest to indexing and evaluation rows and adds `spend_totals()`; migration
 * 0013 adds the trial cookie hash, Turnstile redemptions and the anonymous switch.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** `interactive`: AI briefs. `indexing` and `evaluation` share the ingestion allowance (A7). */
export const SPEND_CATEGORIES = ['interactive', 'indexing', 'evaluation'] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** `trial`: anonymous trial identity. `account`: signed-in user. `system`: indexing/evaluation jobs. */
export const PRINCIPAL_KINDS = ['trial', 'account', 'system'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * `open`: money held, lease running. `settled`: charged from the reported usage.
 * `expired_charged`: the lease ran out first; charged the full reservation, never refunded.
 */
export const RESERVATION_STATUSES = ['open', 'settled', 'expired_charged'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const BUCKET_SCOPES = ['principal', 'network', 'global'] as const;
export type BucketScope = (typeof BUCKET_SCOPES)[number];
export const BUCKET_PERIODS = ['minute', 'hour', 'day', 'month'] as const;
export type BucketPeriod = (typeof BUCKET_PERIODS)[number];

const HEX64 = "'^[0-9a-f]{64}$'";
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const usd = (name: string) => numeric(name, { precision: 12, scale: 6 });

/**
 * When a signed-in AI request needs a Turnstile check (DESIGN §8, server/identity/step-up.ts):
 * `suspicious`, only on the documented signals; `always`, every signed-in request (an
 * operator's emergency setting).
 */
export const ACCOUNT_CHECK_MODES = ['suspicious', 'always'] as const;
export type AccountCheckMode = (typeof ACCOUNT_CHECK_MODES)[number];

/**
 * The AI kill switch: exactly one row (id 1), seeded enabled. A missing row means paused.
 * `anonymous_enabled` off is the login-required emergency mode (DESIGN §7): anonymous
 * trials are refused while signed-in AI continues (migration 0013). `account_check` is
 * when signed-in requests take a Turnstile check (migration 0018).
 */
export const aiSwitch = pgTable(
  'ai_switch',
  {
    id: smallint('id').primaryKey(),
    enabled: boolean('enabled').notNull(),
    anonymousEnabled: boolean('anonymous_enabled').notNull().default(true),
    accountCheck: text('account_check', { enum: ACCOUNT_CHECK_MODES }).notNull().default('suspicious'),
    /** Operator note; never shown to users. */
    note: text('note'),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('ai_switch_single_row_check', sql`${t.id} = 1`),
    check('ai_switch_note_check', sql`${t.note} is null or length(${t.note}) <= 200`),
    check('ai_switch_account_check_check', sql`${t.accountCheck} in (${inList(ACCOUNT_CHECK_MODES)})`),
  ],
);

/** Stage of the reservations and ledger lines that charge spend a restore lost (server/quota/hold.ts). */
export const RESTORE_RECONCILE_STAGE = 'restore_reconcile';

/**
 * Paid operations held after a restore (RUNBOOK, "Backups"): exactly one row (id 1). A
 * restored ledger lacks what was spent after the backup was taken, although the providers
 * still bill it, so after a restore no paid call may start until an operator has charged
 * that spend (`pnpm worker restore-reconcile`). Paid operations are held when `held_at` is
 * set (the restore sets it in its own transaction, docker/postgres/after-restore.sql; so do
 * migration 0020 on a database restored from an older backup and `pnpm worker
 * restore-check`), or when the row is missing. A `database_oid` other than the current
 * database's holds them too, an extra signal nothing relies on (OIDs can repeat). Admission,
 * `GET /api/ai/status` and `reserveSpend` read it; only the schema owner (aviation_migrator)
 * changes it (migration 0020).
 */
export const paidOperationsHold = pgTable(
  'paid_operations_hold',
  {
    id: smallint('id').primaryKey(),
    /** `pg_database.oid` of the database whose ledger is complete. */
    databaseOid: bigint('database_oid', { mode: 'number' }).notNull(),
    /** Set by the restore check; cleared by a reconciliation. */
    heldAt: tsz('held_at'),
    reconciledAt: tsz('reconciled_at'),
    /** Operator note of the last hold or reconciliation; never shown to users. */
    note: text('note'),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('paid_operations_hold_single_row_check', sql`${t.id} = 1`),
    check('paid_operations_hold_note_check', sql`${t.note} is null or length(${t.note}) <= 200`),
  ],
);

/**
 * Anonymous trial identities (DESIGN §7), created only after a successful Turnstile
 * challenge (server/identity/). The browser holds a signed cookie with a random value;
 * only `cookie_hash`, a keyed HMAC of that value, is stored, so the table cannot be
 * turned back into cookies. `id` is an internal key (the quota principal), never sent
 * to the browser. Also the AI requests used and a 30-day expiry.
 */
export const trialIdentities = pgTable(
  'trial_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cookieHash: text('cookie_hash').notNull().unique('trial_identities_cookie_hash_key'),
    createdAt: tsz('created_at').notNull(),
    requestsUsed: integer('requests_used').notNull().default(0),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [
    check('trial_identities_used_check', sql`${t.requestsUsed} >= 0`),
    check('trial_identities_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check('trial_identities_cookie_hash_check', sql`${t.cookieHash} ~ ${sql.raw(HEX64)}`),
    index('trial_identities_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Turnstile tokens already presented (DESIGN §8: tokens are single-use). A keyed HMAC
 * of each token is claimed before it is verified, so a replayed token is refused
 * without calling Cloudflare, also with the test keys, which accept any token. Kept a
 * little longer than a token lives (5 minutes); retention deletes them.
 */
export const turnstileRedemptions = pgTable(
  'turnstile_redemptions',
  {
    tokenHash: text('token_hash').primaryKey(),
    redeemedAt: tsz('redeemed_at').notNull(),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [
    check(
      'turnstile_redemptions_values_check',
      sql`${t.tokenHash} ~ ${sql.raw(HEX64)} and ${t.expiresAt} > ${t.redeemedAt}`,
    ),
    index('turnstile_redemptions_expires_idx').on(t.expiresAt),
  ],
);

/**
 * The minimal anti-abuse record: HMAC(issuer, sub) of a Google identity, kept through
 * the quota window plus 7 days. It is not tied to the user row, so it survives account
 * deletion; account usage buckets use the same HMAC, so re-registration finds them.
 */
export const abuseRecords = pgTable(
  'abuse_records',
  {
    identityHash: text('identity_hash').primaryKey(),
    firstSeenAt: tsz('first_seen_at').notNull(),
    lastSeenAt: tsz('last_seen_at').notNull(),
    retainUntil: tsz('retain_until').notNull(),
  },
  (t) => [
    check('abuse_records_hash_check', sql`${t.identityHash} ~ ${sql.raw(HEX64)}`),
    check('abuse_records_seen_check', sql`${t.lastSeenAt} >= ${t.firstSeenAt} and ${t.retainUntil} > ${t.lastSeenAt}`),
    index('abuse_records_retain_idx').on(t.retainUntil),
  ],
);

/**
 * Fixed-window counters per principal, network identity (per class) and globally.
 * `bucket_key` is the canonical lock key (`server/quota/buckets.ts`); every writer
 * locks its buckets in ascending key order. Kept until the window ends plus 7 days.
 */
export const usageBuckets = pgTable(
  'usage_buckets',
  {
    bucketKey: text('bucket_key').primaryKey(),
    scope: text('scope', { enum: BUCKET_SCOPES }).notNull(),
    subject: text('subject').notNull(),
    period: text('period', { enum: BUCKET_PERIODS }).notNull(),
    periodStart: tsz('period_start').notNull(),
    /** AI attempts that passed the rate limits (abuse counters). */
    attempts: integer('attempts').notNull().default(0),
    /** Paid requests that took a unit of quota (released again for off-topic replies). */
    requests: integer('requests').notNull().default(0),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [
    check('usage_buckets_scope_check', sql`${t.scope} in (${inList(BUCKET_SCOPES)})`),
    check('usage_buckets_period_check', sql`${t.period} in (${inList(BUCKET_PERIODS)})`),
    check('usage_buckets_counts_check', sql`${t.attempts} >= 0 and ${t.requests} >= 0`),
    check('usage_buckets_subject_check', sql`length(${t.subject}) between 1 and 200`),
    check('usage_buckets_key_check', sql`length(${t.bucketKey}) <= 300 and ${t.expiresAt} > ${t.periodStart}`),
    index('usage_buckets_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Money held before a paid call. Interactive reservations come from admission and
 * also hold a concurrency lease; indexing and evaluation reservations come from
 * `reserveSpend`. Only the settlement columns ever change (guard trigger).
 */
export const reservations = pgTable(
  'reservations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    category: text('category', { enum: SPEND_CATEGORIES }).notNull(),
    principalKind: text('principal_kind', { enum: PRINCIPAL_KINDS }).notNull(),
    principalHash: text('principal_hash'),
    usd: usd('usd').notNull(),
    status: text('status', { enum: RESERVATION_STATUSES }).notNull(),
    /** Ownership token; settlement and quota release require it. Never sent to clients. */
    fencingToken: uuid('fencing_token').notNull().unique().defaultRandom(),
    leaseExpiresAt: tsz('lease_expires_at').notNull(),
    accountingDay: date('accounting_day', { mode: 'string' }).notNull(),
    /** True while the request holds a unit of the principal's quota (trial or account). */
    quotaCounted: boolean('quota_counted').notNull().default(false),
    provider: text('provider'),
    model: text('model'),
    stage: text('stage'),
    requestId: text('request_id'),
    createdAt: tsz('created_at').notNull(),
    settledAt: tsz('settled_at'),
    /** Sum of this reservation's ledger lines. */
    chargedUsd: usd('charged_usd'),
    uncertain: boolean('uncertain'),
  },
  (t) => [
    check('reservations_category_check', sql`${t.category} in (${inList(SPEND_CATEGORIES)})`),
    check('reservations_principal_kind_check', sql`${t.principalKind} in (${inList(PRINCIPAL_KINDS)})`),
    // Interactive money belongs to a trial or an account, except the interactive spend a
    // restore lost, which `pnpm worker restore-reconcile` charges as `system` (migration 0020).
    check(
      'reservations_principal_check',
      sql`(${t.principalKind} = 'system') = (${t.principalHash} is null)
        and ((${t.category} = 'interactive') = (${t.principalKind} <> 'system')
          or (${t.category} = 'interactive' and ${t.principalKind} = 'system' and ${t.stage} = ${sql.raw(`'${RESTORE_RECONCILE_STAGE}'`)}))
        and (${t.principalHash} is null or ${t.principalHash} ~ ${sql.raw(HEX64)})`,
    ),
    check('reservations_usd_check', sql`${t.usd} > 0`),
    check('reservations_status_check', sql`${t.status} in (${inList(RESERVATION_STATUSES)})`),
    check(
      'reservations_settlement_check',
      sql`(${t.status} = 'open') = (${t.settledAt} is null)
        and (${t.status} = 'open') = (${t.chargedUsd} is null)
        and (${t.status} = 'open') = (${t.uncertain} is null)
        and (${t.chargedUsd} is null or ${t.chargedUsd} >= 0)
        and (${t.status} <> 'expired_charged' or (${t.chargedUsd} >= ${t.usd} and ${t.uncertain}))`,
    ),
    // An uncertain settlement is charged at least the full reservation, never less.
    check(
      'reservations_uncertain_check',
      sql`${t.status} <> 'settled' or not ${t.uncertain} or ${t.chargedUsd} >= ${t.usd}`,
    ),
    check('reservations_quota_check', sql`not ${t.quotaCounted} or ${t.category} = 'interactive'`),
    check('reservations_lease_check', sql`${t.leaseExpiresAt} > ${t.createdAt}`),
    check(
      'reservations_labels_check',
      sql`coalesce(length(${t.provider}), 0) <= 100 and coalesce(length(${t.model}), 0) <= 100
        and coalesce(length(${t.stage}), 0) <= 40 and coalesce(length(${t.requestId}), 0) <= 200`,
    ),
    index('reservations_open_idx').on(t.leaseExpiresAt).where(sql`${t.status} = 'open'`),
    index('reservations_day_idx').on(t.accountingDay, t.category),
    index('reservations_principal_idx').on(t.principalHash, t.accountingDay),
  ],
);

/**
 * Interactive concurrency slots, one per interactive reservation. A slot is in flight
 * while it is unreleased and unexpired; expiry frees it but never the money.
 */
export const leases = pgTable(
  'leases',
  {
    reservationId: bigint('reservation_id', { mode: 'number' })
      .primaryKey()
      .references(() => reservations.id),
    principalHash: text('principal_hash').notNull(),
    anonymous: boolean('anonymous').notNull(),
    acquiredAt: tsz('acquired_at').notNull(),
    expiresAt: tsz('expires_at').notNull(),
    releasedAt: tsz('released_at'),
  },
  (t) => [
    check('leases_hash_check', sql`${t.principalHash} ~ ${sql.raw(HEX64)}`),
    check('leases_expiry_check', sql`${t.expiresAt} > ${t.acquiredAt}`),
    index('leases_in_flight_idx').on(t.expiresAt).where(sql`${t.releasedAt} is null`),
  ],
);

/**
 * Idempotency, scoped to the principal: one row per (principal, client key), holding
 * the canonical request hash it was first used with and the admitted reservation.
 * Kept for 24 hours; `result_ref` points at the stored result (a brief step).
 */
export const idempotency = pgTable(
  'idempotency',
  {
    principalHash: text('principal_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    reservationId: bigint('reservation_id', { mode: 'number' })
      .notNull()
      .references(() => reservations.id),
    resultRef: text('result_ref'),
    createdAt: tsz('created_at').notNull(),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_pk', columns: [t.principalHash, t.idempotencyKey] }),
    check(
      'idempotency_values_check',
      sql`${t.principalHash} ~ ${sql.raw(HEX64)} and ${t.requestHash} ~ ${sql.raw(HEX64)}
        and ${t.idempotencyKey} ~ '^[A-Za-z0-9_-]{8,128}$'
        and coalesce(length(${t.resultRef}), 0) <= 200 and ${t.expiresAt} > ${t.createdAt}`,
    ),
    index('idempotency_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Append-only record of charged spend (guard trigger: no updates; deletes only by
 * retention after 90 days). Each settlement writes one or more lines; a lease expiry
 * writes one line at the full reservation, marked uncertain. Content-free.
 */
export const costLedger = pgTable(
  'cost_ledger',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    reservationId: bigint('reservation_id', { mode: 'number' })
      .notNull()
      .references(() => reservations.id),
    category: text('category', { enum: SPEND_CATEGORIES }).notNull(),
    principalKind: text('principal_kind', { enum: PRINCIPAL_KINDS }).notNull(),
    principalHash: text('principal_hash'),
    provider: text('provider'),
    model: text('model'),
    stage: text('stage').notNull(),
    usd: usd('usd').notNull(),
    /** Token counts by kind (`input`, `output`, `cacheWrite`, `cacheRead`); no content. */
    tokens: jsonb('tokens'),
    uncertain: boolean('uncertain').notNull(),
    requestId: text('request_id'),
    accountingDay: date('accounting_day', { mode: 'string' }).notNull(),
    createdAt: tsz('created_at').notNull(),
  },
  (t) => [
    check('cost_ledger_category_check', sql`${t.category} in (${inList(SPEND_CATEGORIES)})`),
    check('cost_ledger_principal_kind_check', sql`${t.principalKind} in (${inList(PRINCIPAL_KINDS)})`),
    check(
      'cost_ledger_principal_check',
      sql`(${t.principalKind} = 'system') = (${t.principalHash} is null)
        and (${t.principalHash} is null or ${t.principalHash} ~ ${sql.raw(HEX64)})`,
    ),
    check('cost_ledger_usd_check', sql`${t.usd} >= 0`),
    check('cost_ledger_tokens_check', sql`${t.tokens} is null or jsonb_typeof(${t.tokens}) = 'object'`),
    check(
      'cost_ledger_labels_check',
      sql`${t.stage} ~ '^[a-z][a-z0-9_]{0,39}$'
        and coalesce(length(${t.provider}), 0) <= 100 and coalesce(length(${t.model}), 0) <= 100
        and coalesce(length(${t.requestId}), 0) <= 200`,
    ),
    index('cost_ledger_day_idx').on(t.accountingDay, t.category),
    index('cost_ledger_reservation_idx').on(t.reservationId),
    index('cost_ledger_created_idx').on(t.createdAt),
  ],
);

/** Control tables, children first (for test resets and pruning order); AI briefs (schema/briefs.ts) included. */
export const CONTROL_TABLES = [
  'brief_steps',
  'evidence_searches',
  'briefs',
  'idempotency',
  'leases',
  'cost_ledger',
  'reservations',
  'usage_buckets',
  'trial_identities',
  'turnstile_redemptions',
  'abuse_records',
] as const;
