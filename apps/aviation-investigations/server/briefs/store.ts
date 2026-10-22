/**
 * Brief rows (server/db/schema/briefs.ts) as `aviation_app`: create briefs and steps,
 * read them for their read owner, write the pipeline's stage-by-stage state, request
 * cancellation, and the read-owner handover for Task 20. Every step write is
 * conditional on the step still running; the database refuses changes to a finished
 * step, to a step's billing principal or request, and any direct update of a brief.
 */
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { BriefResult, Checklist, MaintenanceRelation, Symptom } from '../../shared/contracts/briefs.js';
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

export interface StoredEvidence {
  ruleVersion: string | null;
  passages: StoredPassage[];
  /** The composition's other DESIGN §3 dimensions per case, for the case context (answers only). */
  dimensions?: { ntsbNo: string; maintenance?: MaintenanceRelation; symptom?: Symptom }[];
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

const toStep = (r: typeof briefSteps.$inferSelect): StepRow => ({
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
    .returning();
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
  const [row] = await db.select().from(briefSteps).where(eq(briefSteps.id, stepId));
  return row ? toStep(row) : null;
}

/** Step `n` of a brief, or its latest step when `n` is undefined. */
export async function readStep(db: DbOrTx, briefId: string, n?: number): Promise<StepRow | null> {
  const q = db.select().from(briefSteps);
  const [row] =
    n === undefined
      ? await q.where(eq(briefSteps.briefId, briefId)).orderBy(desc(briefSteps.n)).limit(1)
      : await q.where(and(eq(briefSteps.briefId, briefId), eq(briefSteps.n, n)));
  return row ? toStep(row) : null;
}

/** Number, status and stage of every step of a brief, in order. */
export async function listSteps(db: DbOrTx, briefId: string): Promise<{ n: number; status: BriefStepStatus; stage: BriefStepStage }[]> {
  return db
    .select({ n: briefSteps.n, status: briefSteps.status, stage: briefSteps.stage })
    .from(briefSteps)
    .where(eq(briefSteps.briefId, briefId))
    .orderBy(asc(briefSteps.n));
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
      updatedAt: f.now,
      finishedAt: f.now,
    })
    .where(and(eq(briefSteps.id, stepId), eq(briefSteps.status, 'running')))
    .returning({ id: briefSteps.id });
  return rows.length === 1;
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
