/**
 * AI briefs (Task 16; DESIGN §2, §7; UI_DESIGN §5): temporary, per-visitor processing
 * records that expire within 24 hours and are deleted by retention.
 *
 * - `briefs`: one row per brief, pinned to the dataset generation and passages index it
 *   started on (amendment A6). `read_owner` is the HMAC of the principal that may read
 *   it (`server/quota/policy.ts` `principalHash`); it changes only once, from a trial to
 *   an account, through the compare-and-set function `move_brief_read_owner()`
 *   (Task 20's sign-in handover). The app role cannot update briefs directly.
 * - `brief_steps`: the question (`n` = 1) and up to three refinements. Each step keeps
 *   the billing principal it was admitted under (never changed), the reservation it
 *   settles, its immutable request, and the stage-by-stage state the pipeline writes.
 *   A finished step is immutable (guard trigger).
 *
 * Grants, guard triggers, the handover function and retention (`prune_controls()`)
 * are in migration 0014. Question and refinement text live only in `request`; the
 * generated result in `result` and the evidence it was checked against in `evidence`.
 * `meta` is content-free (prompt versions, validation codes, timings).
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, numeric, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Principal kinds that can own or be billed for a brief. */
export const BRIEF_PRINCIPAL_KINDS = ['trial', 'account'] as const;

export const BRIEF_STEP_STAGES = ['scope', 'retrieve', 'compose', 'validate', 'done', 'failed'] as const;
export type BriefStepStage = (typeof BRIEF_STEP_STAGES)[number];

/**
 * `running` while a stage runs. Final: `answered`, `no_match` (the answer model's
 * explicit abstention), `withheld`, `scope_reply`, `no_results` (stage `done`);
 * `failed`, `cancelled` (stage `failed`). Migration 0015 added `no_match`.
 */
export const BRIEF_STEP_STATUSES = ['running', 'answered', 'no_match', 'withheld', 'scope_reply', 'no_results', 'failed', 'cancelled'] as const;
export type BriefStepStatus = (typeof BRIEF_STEP_STATUSES)[number];

const HEX64 = "'^[0-9a-f]{64}$'";
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const briefs = pgTable(
  'briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** HMAC of the principal that may read the brief. */
    readOwner: text('read_owner').notNull(),
    readOwnerKind: text('read_owner_kind', { enum: BRIEF_PRINCIPAL_KINDS }).notNull(),
    /** Set once, by `move_brief_read_owner()`. */
    ownerMovedAt: tsz('owner_moved_at'),
    /** The dataset generation and passages index every step reads (A6). */
    generationId: bigint('generation_id', { mode: 'number' }).notNull(),
    passagesIndex: text('passages_index').notNull(),
    createdAt: tsz('created_at').notNull(),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [
    check('briefs_owner_check', sql`${t.readOwner} ~ ${sql.raw(HEX64)} and ${t.readOwnerKind} in (${inList(BRIEF_PRINCIPAL_KINDS)})`),
    check('briefs_moved_check', sql`${t.ownerMovedAt} is null or ${t.readOwnerKind} = 'account'`),
    check('briefs_expiry_check', sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`),
    check('briefs_index_check', sql`${t.passagesIndex} ~ '^[a-z0-9][a-z0-9._-]{0,254}$'`),
    index('briefs_expires_idx').on(t.expiresAt),
  ],
);

export const briefSteps = pgTable(
  'brief_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    briefId: uuid('brief_id')
      .notNull()
      .references(() => briefs.id, { onDelete: 'cascade' }),
    /** 1 for the question, 2–4 for refinements. */
    n: smallint('n').notNull(),
    /** HMAC of the principal the step was admitted under; never changes. */
    billingPrincipal: text('billing_principal').notNull(),
    billingKind: text('billing_kind', { enum: BRIEF_PRINCIPAL_KINDS }).notNull(),
    /** The interactive reservation the step settles (no foreign key: control retention is separate). */
    reservationId: bigint('reservation_id', { mode: 'number' }).notNull(),
    /** What the reader asked for (server/briefs/intent.ts `StepRequest`). */
    request: jsonb('request').notNull(),
    stage: text('stage', { enum: BRIEF_STEP_STAGES }).notNull().default('scope'),
    status: text('status', { enum: BRIEF_STEP_STATUSES }).notNull().default('running'),
    /** Checklist results (shared/contracts/briefs.ts `Checklist`). */
    checklist: jsonb('checklist').notNull().default(sql`'{}'::jsonb`),
    /** The effective intent after the scope stage (`StepIntent`). */
    intent: jsonb('intent'),
    /** The final `BriefResult`. */
    result: jsonb('result'),
    /** The evidence the result was validated against, for the case context. */
    evidence: jsonb('evidence'),
    provider: text('provider'),
    /** The answer model (the scope and check models are in `meta`). */
    model: text('model'),
    meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
    /** What the step's reservation was charged. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    cancelRequestedAt: tsz('cancel_requested_at'),
    createdAt: tsz('created_at').notNull(),
    updatedAt: tsz('updated_at').notNull(),
    finishedAt: tsz('finished_at'),
  },
  (t) => [
    unique('brief_steps_n_key').on(t.briefId, t.n),
    check('brief_steps_n_check', sql`${t.n} between 1 and 4`),
    check('brief_steps_billing_check', sql`${t.billingPrincipal} ~ ${sql.raw(HEX64)} and ${t.billingKind} in (${inList(BRIEF_PRINCIPAL_KINDS)})`),
    check('brief_steps_stage_check', sql`${t.stage} in (${inList(BRIEF_STEP_STAGES)})`),
    check('brief_steps_status_check', sql`${t.status} in (${inList(BRIEF_STEP_STATUSES)})`),
    check(
      'brief_steps_state_check',
      sql`(${t.status} = 'running') = (${t.stage} in ('scope', 'retrieve', 'compose', 'validate'))
        and (${t.stage} <> 'done' or ${t.status} in ('answered', 'no_match', 'withheld', 'scope_reply', 'no_results'))
        and (${t.stage} <> 'failed' or ${t.status} in ('failed', 'cancelled'))
        and (${t.status} = 'running') = (${t.finishedAt} is null)
        and (${t.status} = 'running' or ${t.result} is not null)`,
    ),
    check(
      'brief_steps_json_check',
      sql`jsonb_typeof(${t.request}) = 'object' and jsonb_typeof(${t.checklist}) = 'object' and jsonb_typeof(${t.meta}) = 'object'`,
    ),
    check('brief_steps_cost_check', sql`${t.costUsd} is null or ${t.costUsd} >= 0`),
    check(
      'brief_steps_labels_check',
      sql`coalesce(length(${t.provider}), 0) <= 100 and coalesce(length(${t.model}), 0) <= 100`,
    ),
  ],
);
