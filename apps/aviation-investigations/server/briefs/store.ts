/**
 * Brief rows (server/db/schema/briefs.ts) as `aviation_app`: create briefs and steps,
 * read them for their read owner, write the pipeline's stage-by-stage state, request
 * cancellation, and the read-owner handover for Task 20. Every step write is
 * conditional on the step still running; the database refuses changes to a finished
 * step, to a step's billing principal or request, and any direct update of a brief.
 */
import { and, asc, desc, eq, getTableColumns, gt, isNull, sql } from 'drizzle-orm';
import type {
  BriefResult,
  Checklist,
  Criterion,
  CriterionDecision,
  MaintenanceRelation,
  Symptom,
  TimingBasis,
} from '../../shared/contracts/briefs.js';
import type { Db, DbOrTx } from '../db/client.js';
import { briefSteps, briefs, type BriefStepStage, type BriefStepStatus } from '../db/schema/index.js';
import type { StepIntent, StepRequest } from './intent.js';

export type PrincipalKind = 'trial' | 'account';

export interface BriefRow {
  id: string;
  readOwner: string;
  readOwnerKind: PrincipalKind;
  generationId: number;
  passagesIndex: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Evidence a finished step keeps for its case context (no corpus read after the step). */
export interface StoredPassage {
  passageId: string;
  ntsbNo: string;
  sectionKind: 'factual' | 'analysis' | 'probable_cause';
  scope: 'aircraft' | 'event';
  aircraftKey: number | null;
  sectionId: string;
  revisionId: string;
  /** sha256 of the section's citation text (the case page's section `revision`). */
  sectionRevision: string;
  sectionStart: number;
  text: string;
}

/** A presented case's structured claims with the passages each was checked on (answers only). */
export interface StoredDimensions {
  ntsbNo: string;
  evidencePassageIds: string[];
  maintenance?: { relation: MaintenanceRelation; passageIds: string[] };
  symptom?: { value: Symptom; passageIds: string[] };
  /** Each stated chronology fact (one per timing chip, in chip order) with the passages that state it. */
  timing?: { basis: TimingBasis; passageIds: string[] }[];
  /** The relevant maintenance those facts and the criteria are about, in the passages' words (checked with them). */
  relevantMaintenance?: string;
  /** Each criterion decision with the passage set its checker claim cited (not the symptom's or timing's). */
  criteria?: { criterion: Criterion; decision: CriterionDecision['decision']; passageIds: string[] }[];
}

export interface StoredEvidence {
  ruleVersion: string | null;
  passages: StoredPassage[];
  /** The composition's DESIGN §3 dimensions per presented case, for the case context (answers only). */
  dimensions?: StoredDimensions[];
}

export interface StepRow {
  id: string;
  briefId: string;
  n: number;
  billingPrincipal: string;
  billingKind: PrincipalKind;
  reservationId: number;
  request: StepRequest;
  stage: BriefStepStage;
  status: BriefStepStatus;
  checklist: Checklist;
  intent: StepIntent | null;
  result: BriefResult | null;
  evidence: StoredEvidence | null;
  provider: string | null;
  model: string | null;
  meta: Record<string, unknown>;
  costUsd: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/**
 * What a withheld step keeps for developers (`diagnostics`, migration 0016;
 * `pnpm worker brief-diagnose`). It is model output about the public NTSB passages of
 * the step; no route reads it (`STEP_COLUMNS` leaves it out), and it is pruned with its
 * brief.
 */
export interface StepDiagnostics {
  /** Why the summary was withheld. */
  reason: 'citation_check' | 'criteria_check' | 'evidence_check';
  /** The composition the answer model returned, before any mapping (passage aliases as it saw them). */
  composition: unknown;
  /** Alias → canonical passage id of the bundle the model saw. */
  aliases: Record<string, string>;
  /** The summary as the validator split it: a `summary.<i>` reason names entry `i`. */
  summarySentences: string[];
  /** For `evidence_check`: the claims the checker was given, in id order (with aliases). */
  claims?: { id?: string; kind: string; ntsbNo?: string; text: string; passageIds: string[]; absence?: boolean }[];
  /** For `evidence_check` with a parsed check output: the checker's verdicts and quotes as it returned them (aliases). */
  verdicts?: {
    verdicts: { claim: string; verdict: string; passages: string[] }[];
    quotes: { claim: string; passage: string; text: string }[];
  };
}

/**
 * jsonb refuses NUL and unpaired surrogates; model text in the diagnostics has them
 * replaced (U+FFFD), so what the model wrote can never fail the step's final write.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A copy of a JSON value that jsonb accepts: NUL and unpaired surrogates in strings and keys become U+FFFD. */
export function storable(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(UNSTORABLE, '\uFFFD');
  if (Array.isArray(v)) return v.map(storable);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k) as string, storable(x)]));
  return v;
}

/** Every column a step read returns: all but `diagnostics`, which only `readStepDiagnostics` reads. */
const { diagnostics: _diagnostics, ...STEP_COLUMNS } = getTableColumns(briefSteps);

const toStep = (r: Omit<typeof briefSteps.$inferSelect, 'diagnostics'>): StepRow => ({
  ...r,
  billingKind: r.billingKind as PrincipalKind,
  request: r.request as StepRequest,
  checklist: r.checklist as Checklist,
  intent: (r.intent as StepIntent | null) ?? null,
  result: (r.result as BriefResult | null) ?? null,
  evidence: (r.evidence as StoredEvidence | null) ?? null,
  meta: r.meta as Record<string, unknown>,
});

export interface NewBrief {
  readOwner: string;
  readOwnerKind: PrincipalKind;
  generationId: number;
  passagesIndex: string;
  now: Date;
  ttlMs: number;
}

export interface NewStep {
  briefId: string;
  n: number;
  billingPrincipal: string;
  billingKind: PrincipalKind;
  reservationId: number;
  request: StepRequest;
  now: Date;
}

export async function insertBrief(db: DbOrTx, b: NewBrief): Promise<BriefRow> {
  const [row] = await db
    .insert(briefs)
    .values({
      readOwner: b.readOwner,
      readOwnerKind: b.readOwnerKind,
      generationId: b.generationId,
      passagesIndex: b.passagesIndex,
      createdAt: b.now,
      expiresAt: new Date(b.now.getTime() + b.ttlMs),
    })
    .returning();
  if (!row) throw new Error('brief insert returned nothing');
  return { ...row, readOwnerKind: row.readOwnerKind as PrincipalKind };
}

/** Insert a step; null when step `n` of the brief already exists (a concurrent refinement won). */
export async function insertStep(db: DbOrTx, s: NewStep): Promise<StepRow | null> {
  const rows = await db
    .insert(briefSteps)
    .values({
      briefId: s.briefId,
      n: s.n,
      billingPrincipal: s.billingPrincipal,
      billingKind: s.billingKind,
      reservationId: s.reservationId,
      request: s.request,
      createdAt: s.now,
      updatedAt: s.now,
    })
    .onConflictDoNothing({ target: [briefSteps.briefId, briefSteps.n] })
    // Never `diagnostics`: a step read never returns it.
    .returning(STEP_COLUMNS);
  return rows[0] ? toStep(rows[0]) : null;
}

/** A live brief (not expired at `now`), or null. */
export async function readBrief(db: DbOrTx, id: string, now: Date): Promise<BriefRow | null> {
  const [row] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.id, id), gt(briefs.expiresAt, now)));
  return row ? { ...row, readOwnerKind: row.readOwnerKind as PrincipalKind } : null;
}

export async function readStepById(db: DbOrTx, stepId: string): Promise<StepRow | null> {
  const [row] = await db.select(STEP_COLUMNS).from(briefSteps).where(eq(briefSteps.id, stepId));
  return row ? toStep(row) : null;
}

/** Step `n` of a brief, or its latest step when `n` is undefined. */
export async function readStep(db: DbOrTx, briefId: string, n?: number): Promise<StepRow | null> {
  const q = db.select(STEP_COLUMNS).from(briefSteps);
  const [row] =
    n === undefined
      ? await q.where(eq(briefSteps.briefId, briefId)).orderBy(desc(briefSteps.n)).limit(1)
      : await q.where(and(eq(briefSteps.briefId, briefId), eq(briefSteps.n, n)));
  return row ? toStep(row) : null;
}

/** Number, status, stage and start of every step of a brief, in order. */
export async function listSteps(
  db: DbOrTx,
  briefId: string,
): Promise<{ n: number; status: BriefStepStatus; stage: BriefStepStage; createdAt: Date }[]> {
  return db
    .select({ n: briefSteps.n, status: briefSteps.status, stage: briefSteps.stage, createdAt: briefSteps.createdAt })
    .from(briefSteps)
    .where(eq(briefSteps.briefId, briefId))
    .orderBy(asc(briefSteps.n));
}

/** Step `n` (or the latest) with the number of steps in its brief, in one query (polling). */
export async function readStepWithCount(db: DbOrTx, briefId: string, n?: number): Promise<{ step: StepRow; steps: number } | null> {
  const count = sql<number>`(select count(*)::int from ${briefSteps} s where s.brief_id = ${briefId}::uuid)`;
  const q = db.select({ row: STEP_COLUMNS, steps: count }).from(briefSteps);
  const [r] =
    n === undefined
      ? await q.where(eq(briefSteps.briefId, briefId)).orderBy(desc(briefSteps.n)).limit(1)
      : await q.where(and(eq(briefSteps.briefId, briefId), eq(briefSteps.n, n)));
  return r ? { step: toStep(r.row), steps: Number(r.steps) } : null;
}

/**
 * A step still `running` this long after it started has lost its process (the deadline
 * is 90 s and settlement follows at once): it reads as failed, it no longer blocks a
 * refinement, and maintenance marks it failed once its reservation is closed.
 */
export const STALE_STEP_MS = 150_000;

export function isLiveStep(step: { status: BriefStepStatus; createdAt: Date }, now: Date): boolean {
  return step.status === 'running' && now.getTime() - step.createdAt.getTime() <= STALE_STEP_MS;
}

/**
 * Mark steps whose process died as failed (`countedAsSearch`: their reservation was
 * charged): still `running` after `STALE_STEP_MS`, with a reservation that is no longer
 * open (lease expiry charged it in full, or it was settled before the step's last write
 * was lost). Run by the periodic control maintenance as aviation_app.
 */
export async function failOrphanedSteps(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const res = await db.execute(sql`
    UPDATE brief_steps s
    SET stage = 'failed', status = 'failed',
      result = '{"kind":"failed","countedAsSearch":true}'::jsonb,
      meta = s.meta || '{"failure":{"stage":"pipeline","category":"orphaned"}}'::jsonb,
      cost_usd = r.charged_usd, updated_at = ${now}, finished_at = ${now}
    FROM reservations r
    WHERE s.status = 'running' AND r.id = s.reservation_id AND r.status <> 'open'
      AND s.created_at < ${new Date(now.getTime() - STALE_STEP_MS)}`);
  return res.rowCount ?? 0;
}

export interface StageUpdate {
  stage: Exclude<BriefStepStage, 'done' | 'failed'>;
  checklist: Checklist;
  intent?: StepIntent;
  now: Date;
}

/**
 * Move a running step to its next stage. Returns `{ running: false }` when the step is
 * no longer running, and whether cancellation was requested meanwhile.
 */
export async function writeStage(db: Db, stepId: string, u: StageUpdate): Promise<{ running: boolean; cancelRequested: boolean }> {
  const rows = await db
    .update(briefSteps)
    .set({ stage: u.stage, checklist: u.checklist, ...(u.intent ? { intent: u.intent } : {}), updatedAt: u.now })
    .where(and(eq(briefSteps.id, stepId), eq(briefSteps.status, 'running')))
    .returning({ cancelRequestedAt: briefSteps.cancelRequestedAt });
  const row = rows[0];
  return { running: row !== undefined, cancelRequested: row?.cancelRequestedAt != null };
}

export interface StepFinish {
  stage: 'done' | 'failed';
  status: Exclude<BriefStepStatus, 'running'>;
  checklist: Checklist;
  result: BriefResult;
  intent?: StepIntent | null;
  evidence?: StoredEvidence | null;
  provider: string | null;
  model: string | null;
  meta: Record<string, unknown>;
  /** USD charged, as a `numeric(12,6)` literal; null when settlement did not finish. */
  costUsd: string | null;
  /** A withheld step's rejected composition (server-side only). */
  diagnostics?: StepDiagnostics | null;
  now: Date;
}

/** Write a step's final state; false when it had already finished. */
export async function finishStep(db: Db, stepId: string, f: StepFinish): Promise<boolean> {
  const rows = await db
    .update(briefSteps)
    .set({
      stage: f.stage,
      status: f.status,
      checklist: f.checklist,
      result: f.result,
      ...(f.intent !== undefined ? { intent: f.intent } : {}),
      ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
      provider: f.provider,
      model: f.model,
      meta: f.meta,
      costUsd: f.costUsd,
      ...(f.diagnostics ? { diagnostics: storable(f.diagnostics) } : {}),
      updatedAt: f.now,
      finishedAt: f.now,
    })
    .where(and(eq(briefSteps.id, stepId), eq(briefSteps.status, 'running')))
    .returning({ id: briefSteps.id });
  return rows.length === 1;
}

/**
 * A step with its diagnostics and its brief's expiry, for the operator command
 * `pnpm worker brief-diagnose` only (never a route). Null when the brief has no such step
 * (or the maintenance pass has pruned it). An expired brief's rows remain until that pass.
 */
export async function readStepDiagnostics(
  db: DbOrTx,
  briefId: string,
  n?: number,
): Promise<{ step: StepRow; diagnostics: StepDiagnostics | null; expiresAt: Date } | null> {
  const q = db
    .select({ row: STEP_COLUMNS, diagnostics: briefSteps.diagnostics, expiresAt: briefs.expiresAt })
    .from(briefSteps)
    .innerJoin(briefs, eq(briefs.id, briefSteps.briefId));
  const [r] =
    n === undefined
      ? await q.where(eq(briefSteps.briefId, briefId)).orderBy(desc(briefSteps.n)).limit(1)
      : await q.where(and(eq(briefSteps.briefId, briefId), eq(briefSteps.n, n)));
  return r ? { step: toStep(r.row), diagnostics: (r.diagnostics as StepDiagnostics | null) ?? null, expiresAt: r.expiresAt } : null;
}

/** Mark a running step for cancellation; false when it is not running. */
export async function requestCancel(db: Db, stepId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(briefSteps)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(eq(briefSteps.id, stepId), eq(briefSteps.status, 'running'), isNull(briefSteps.cancelRequestedAt)))
    .returning({ id: briefSteps.id });
  return rows.length === 1;
}

/**
 * The sign-in handover (UI_DESIGN §5; Task 20): move the read owner of a live brief from
 * the trial that owns it (`fromHash`) to an account (`toHash`), atomically and once.
 * False when the brief is not owned by `fromHash`, has expired, or already moved
 * (a second or concurrent callback is a no-op).
 */
export async function moveBriefReadOwner(db: DbOrTx, briefId: string, fromHash: string, toHash: string): Promise<boolean> {
  const res = await db.execute(sql`SELECT move_brief_read_owner(${briefId}::uuid, ${fromHash}, ${toHash}) AS moved`);
  return (res.rows[0] as { moved?: boolean } | undefined)?.moved === true;
}
