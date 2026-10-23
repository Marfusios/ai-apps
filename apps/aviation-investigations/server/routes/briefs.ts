/**
 * AI briefs (shared/contracts/briefs.ts), under the route-based default deny of
 * server/app.ts: every route needs a network identity and is rate limited, and the
 * cache-headers rule makes everything under `/api/briefs` `private, no-store`.
 *
 * **Who is asking.** The visitor is the signed-in account (its session cookie,
 * server/auth/better-auth.ts) and/or the trial proven by this browser's trial cookie
 * (server/identity/trial.ts). A paid request is billed to the account when the visitor is
 * signed in (no Turnstile check), otherwise to the trial through the anonymous gate. Each
 * step keeps the billing principal it was admitted under.
 *
 * Paid requests (`POST /api/briefs`, `POST /api/briefs/:id/refine`), in order, before
 * anything is spent:
 * 1. a cross-site `Origin` is refused (the bodies are JSON and the cookies are
 *    SameSite=Lax; this is the explicit check for custom POST endpoints, DESIGN §7);
 * 2. the body is validated (strict schemas);
 * 3. AI must be able to run: the startup check, the quota policy, a provider and an
 *    evidence index that the dataset reports servable and the retriever accepts (503
 *    `unavailable` otherwise, never saying why);
 * 4. a retry of a request this browser made before, under the account's or the trial's
 *    idempotency record with this key and body, answers with its step and never runs
 *    again (`sendReplay`): its brief when this visitor reads it (a signed-in visitor
 *    takes over a brief its trial still owns, server/auth/handover.ts), 403 `moved` when
 *    it moved from this trial to an account ("sign in to view"), else 404;
 * 5. refinements: the read owner (the account, or this browser's trial), the
 *    three-refinement limit and one step at a time are checked before any token work;
 * 6. anonymous visitors only, the anonymous gate (server/identity/gate.ts):
 *    availability (kill switch, budgets, the trial's searches, the anonymous share)
 *    before it claims the Turnstile token, then the token, then the trial;
 * 7. admission (server/quota/admit.ts): idempotency, rate limits, budgets, quota and
 *    concurrency, reserving the request's maximum cost. A trial that expired since the
 *    gate (`UnknownPrincipalError`) asks for a new check (403 `challenge_required`).
 *
 * A signed-in visitor's refinement of a brief this browser's trial still owns moves the
 * brief to the account (the handover's compare-and-set) in the transaction that creates
 * the step, after admission; the step is billed to the account.
 *
 * The step then runs in the background (server/briefs/pipeline.ts); the request waits
 * only for the scope stage, so a static reply comes back directly (`scope_reply`) and an
 * in-scope question answers `started`, to be polled with `GET`.
 *
 * Server shutdown (`BriefServices.shutdown`, aborted by server/app.ts `preClose`): a paid
 * request is tracked work (closing waits for it, bounded) and is refused with 503
 * `unavailable` at each point where shutdown has begun: before the gate claims the
 * Turnstile token, before admission, and after admission before the step exists (the
 * admission is given back and settled at zero). A step created while shutdown began
 * runs under the shutdown signal, so it stops before its first provider call, gives the
 * search back and settles at zero (the request answers `started` with stage `failed`).
 *
 * Reads (`GET`, the case context and cancel) are for the brief's read owner only: the
 * signed-in account or the trial in the request's cookie. Reads never move a brief.
 * Anything else is 404, the trial a brief moved away from included.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BRIEF_TTL_MS,
  BriefIdSchema,
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  ChecklistSchema,
  CreateBriefRequestSchema,
  FAILURE_TYPE_LABELS,
  MAX_BRIEF_STEPS,
  RefinementRequestSchema,
  StartBriefResponseSchema,
  StepNumberSchema,
  refinementChange,
  type BriefStepResponse,
  type Checklist,
  type StartBriefResponse,
} from '../../shared/contracts/briefs.js';
import { NtsbNoSchema } from '../../shared/contracts/common.js';
import type { AiRuntime } from '../ai/runtime.js';
import type { AccountPrincipal } from '../auth/better-auth.js';
import { movedFrom, takeOver } from '../auth/handover.js';
import { caseContext } from '../briefs/context.js';
import { createRequestHash, questionRequest, refineRequestHash, refinementRequest, retrievalText, type StepRequest } from '../briefs/intent.js';
import { runBriefStep, type ScopedOutcome } from '../briefs/pipeline.js';
import type { BriefServices } from '../briefs/services.js';
import {
  insertBrief,
  insertStep,
  isLiveStep,
  listSteps,
  readBrief,
  readStep,
  readStepById,
  readStepWithCount,
  requestCancel,
  type BriefRow,
  type StepRow,
} from '../briefs/store.js';
import type { EvidenceDataset } from '../briefs/evidence.js';
import { MAX_QUERY_INPUT_TOKENS, QueryTooLongError, queryEmbeddingInput } from '../ai/embeddings.js';
import { countTokens } from '../ai/tokens.js';
import { FIRST_FLIGHT_LABEL, interpretationChips, isFailureType, timingWindowLabel } from '../briefs/clarify.js';
import type { LlmProvider } from '../ai/provider.js';
import { crossSite } from '../http/origin.js';
import { issuesOf, JSON_TYPE, sendError } from '../http/reply.js';
import { retryAfterSeconds, sendGateRefusal } from '../identity/gate.js';
import type { TrialPrincipal } from '../identity/trial.js';
import { admitPaidRequest, releaseQuota, setResultRef, type Admission, type Rejection } from '../quota/admit.js';
import { principalHash, UnknownPrincipalError, type Principal, type QuotaPolicy } from '../quota/policy.js';
import { settle } from '../quota/settle.js';
import { sql } from 'drizzle-orm';
import type { ApiContext } from './context.js';

const NOT_FOUND = 'No AI search with that link is available. AI searches expire after 24 hours.';
const TOO_LONG = 'The question is too long to search. Shorten it and try again.';

interface Runtime {
  ai: AiRuntime & { policy: QuotaPolicy; llm: LlmProvider; trials: NonNullable<AiRuntime['trials']> };
  svc: BriefServices;
  reservationUsd: number;
}

interface Ready extends Runtime {
  evidence: EvidenceDataset;
}

/**
 * The AI runtime and brief services a paid brief request needs, or null (503; also once
 * shutdown began). The anonymous gate is needed by anonymous visitors only.
 */
function runtime(ctx: ApiContext): Runtime | null {
  const ai = ctx.ai;
  const svc = ctx.briefs;
  if (!ai?.startup.enabled || ai.startup.reservationUsd === undefined || !ai.policy || !ai.llm || !ai.trials || !svc) return null;
  if (stopping(svc)) return null;
  return { ai: ai as Runtime['ai'], svc, reservationUsd: ai.startup.reservationUsd };
}

/** The server began closing: no paid work may start. */
const stopping = (svc: BriefServices): boolean => svc.shutdown.aborted;

/** A paid request's handler as tracked work, so closing waits for it (server/briefs/services.ts). */
function tracked<T>(ctx: ApiContext, work: () => Promise<T>): Promise<T> {
  return ctx.briefs ? ctx.briefs.track(work) : work();
}

/** A new brief: the runtime and the evidence index of the active manifest, or null (503). */
async function ready(ctx: ApiContext): Promise<Ready | null> {
  const r = runtime(ctx);
  if (!r) return null;
  const evidence = await ctx.aiEvidence().catch(() => null);
  return evidence ? { ...r, evidence } : null;
}

/** A refinement: the runtime and the evidence index the brief is pinned to, if the retriever still accepts it. */
async function readyFor(r: Runtime, brief: { generationId: number; passagesIndex: string }): Promise<Ready | null> {
  const evidence = { generationId: brief.generationId, passagesIndex: brief.passagesIndex };
  return (await r.svc.retriever.available(evidence).catch(() => false)) ? { ...r, evidence } : null;
}

/**
 * True when the dense channel's query input (the question and the text refinement in
 * effect) is over the query embedder's cap: refused with 400 before any spend, so a
 * paid scope stage never leads to a step that cannot retrieve (`fitQueryText` in the
 * binding stays as the fallback).
 */
function queryTooLong(req: StepRequest): boolean {
  try {
    return countTokens(queryEmbeddingInput(retrievalText(req))) > MAX_QUERY_INPUT_TOKENS;
  } catch (err) {
    if (err instanceof QueryTooLongError) return true;
    throw err;
  }
}

function sendRejection(reply: FastifyReply, r: Rejection, now: Date): FastifyReply {
  const retry = (status: number, code: Parameters<typeof sendError>[2]) => {
    if (!r.retryAt) return sendError(reply, status, code);
    const seconds = retryAfterSeconds(r.retryAt, now);
    reply.header('retry-after', String(seconds));
    return sendError(reply, status, code, { retryAfter: seconds });
  };
  switch (r.reason) {
    case 'trial_exhausted':
      return sendError(reply, 429, 'trial_used');
    case 'daily_cap':
    case 'monthly_cap':
      return retry(429, 'quota_exhausted');
    case 'anonymous_share_exhausted':
      return retry(429, 'free_searches_paused');
    case 'global_paused':
      return retry(503, 'ai_paused');
    case 'rate_limited':
      return retry(429, 'rate_limited');
    case 'concurrency':
      return sendError(reply, 429, 'in_flight');
    case 'idempotency_conflict':
      return sendError(reply, 409, 'conflict');
    case 'login_required':
      return sendError(reply, 403, 'sign_in_required');
    case 'busy':
      return sendError(reply, 503, 'unavailable');
  }
}

const RESULT_REF = /^brief-step:([0-9a-f-]{36})$/;

/** The response for a step: its static reply when it ended with one, otherwise its stage. */
function startResponse(briefId: string, step: Pick<StepRow, 'n' | 'stage' | 'result'>): StartBriefResponse {
  if (step.result?.kind === 'scope_reply') return { kind: 'scope_reply', briefId, step: step.n, reply: step.result.reply };
  return { kind: 'started', briefId, step: step.n, stage: step.stage };
}

function sendStart(reply: FastifyReply, body: StartBriefResponse): FastifyReply {
  const valid = StartBriefResponseSchema.parse(body);
  return reply.code(valid.kind === 'started' ? 202 : 200).type(JSON_TYPE).send(JSON.stringify(valid));
}

/** An earlier request with this idempotency key and body that already made a step of a brief. */
async function replayed(ctx: ApiContext, pHash: string, key: string, requestHash: string, now: Date): Promise<string | null> {
  const res = await ctx.db.execute(sql`
    SELECT result_ref FROM idempotency
    WHERE principal_hash = ${pHash} AND idempotency_key = ${key} AND request_hash = ${requestHash} AND expires_at > ${now}`);
  const ref = (res.rows[0] as { result_ref: string | null } | undefined)?.result_ref ?? null;
  return ref ? (RESULT_REF.exec(ref)?.[1] ?? null) : null;
}

/** One identity of the visitor: its principal and HMAC. */
interface Party<P extends Principal> {
  principal: P;
  hash: string;
}

/** Who is asking: the signed-in account and/or the trial proven by this browser's cookie. */
interface Visitor {
  account: Party<AccountPrincipal> | null;
  trial: Party<TrialPrincipal> | null;
}

const NOBODY: Visitor = { account: null, trial: null };

async function visitor(ctx: ApiContext, request: FastifyRequest, now?: Date): Promise<Visitor> {
  const ai = ctx.ai;
  if (!ai?.policy || !ai.trials) return NOBODY;
  const signedIn = ctx.auth ? await ctx.auth.signedIn(request.headers.cookie) : null;
  const trial = await ai.trials.fromRequest(request, now ?? ai.now());
  return {
    account: signedIn ? { principal: signedIn.principal, hash: signedIn.hash } : null,
    trial: trial ? { principal: trial, hash: principalHash(ai.policy, trial) } : null,
  };
}

/** The visitor's identity that reads `brief` (the account first), or null. */
function readerOf(who: Visitor, brief: BriefRow): Party<Principal> | null {
  if (who.account && brief.readOwner === who.account.hash) return who.account;
  if (who.trial && brief.readOwner === who.trial.hash) return who.trial;
  return null;
}

/** The step of an earlier request with this key and body by any of the visitor's identities (the account first). */
async function earlierStep(ctx: ApiContext, who: Visitor, key: string, requestHash: string, now: Date): Promise<string | null> {
  for (const party of [who.account, who.trial]) {
    if (!party) continue;
    const stepId = await replayed(ctx, party.hash, key, requestHash, now);
    if (stepId) return stepId;
  }
  return null;
}

/**
 * The reply to a retry of an accepted request: its step, never a new run. A brief this
 * visitor reads replays; a signed-in visitor first takes over a brief this browser's
 * trial still owns; a brief that moved from this trial to an account answers 403
 * `moved` (sign in to view it); anything else is 404.
 */
async function sendReplay(ctx: ApiContext, reply: FastifyReply, stepId: string | null, who: Visitor, now: Date): Promise<FastifyReply> {
  const step = stepId ? await readStepById(ctx.db, stepId) : null;
  if (!step) return sendError(reply, 409, 'conflict', { message: 'This request was accepted earlier but did not start. Ask again.' });
  const brief = await readBrief(ctx.db, step.briefId, now);
  if (!brief) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
  if (who.account && brief.readOwner === who.account.hash) return sendStart(reply, startResponse(brief.id, step));
  if (who.trial && brief.readOwner === who.trial.hash) {
    if (!who.account || (await takeOver(ctx.db, brief.id, who.trial.hash, who.account.hash, now))) return sendStart(reply, startResponse(brief.id, step));
  }
  if (who.trial && (await movedFrom(ctx.db, brief.id, who.trial.hash, now))) return sendError(reply, 403, 'moved');
  return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
}

/** Give back an admission that made no step (nothing was spent). */
async function abandon(ctx: ApiContext, r: Ready, admission: Admission): Promise<void> {
  await releaseQuota(ctx.db, admission, admission.fencingToken, { policy: r.ai.policy, now: r.ai.now() }).catch(() => undefined);
  await settle(ctx.db, admission, 0, admission.fencingToken, r.ai.now()).catch(() => undefined);
}

/**
 * Start the step in the background and wait for its scope stage. The step runs under
 * the reader's cancel and the server's shutdown signal: one started after shutdown
 * began stops before its first provider call.
 */
async function start(ctx: ApiContext, r: Ready, briefId: string, step: StepRow, admission: Admission, requestId: string): Promise<StartBriefResponse> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, r.svc.shutdown]);
  let onScoped!: (o: ScopedOutcome) => void;
  const scoped = new Promise<ScopedOutcome>((resolve) => (onScoped = resolve));
  const done = runBriefStep(
    {
      db: ctx.db,
      llm: r.ai.llm,
      retriever: r.svc.retriever,
      catalog: r.svc.catalog,
      policy: r.ai.policy,
      now: r.ai.now,
      log: ctx.log,
      timeouts: r.svc.timeouts,
      ...(r.ai.traceSalt ? { traceSalt: r.ai.traceSalt } : {}),
    },
    step.id,
    admission,
    { signal, onScoped, requestId },
  );
  r.svc.runs.set(step.id, { controller, done });
  void done.finally(() => {
    r.svc.runs.delete(step.id);
    onScoped({ kind: 'ended', stage: 'failed' });
  });
  const o = await scoped;
  if (o.kind === 'reply') return { kind: 'scope_reply', briefId, step: step.n, reply: o.reply };
  return { kind: 'started', briefId, step: step.n, stage: o.kind === 'continue' ? 'retrieve' : o.stage };
}

/**
 * Admit a principal (server/quota/admit.ts: the kill switch, rate limits, the monthly
 * budget and the paced daily allowance of at most $3 counting every open reservation, the
 * trial or account quota, the anonymous share and concurrency), reserving the request's
 * maximum cost. Maps the trial expiring since the gate to "take a new check". `requestId`
 * is a fresh content-free id copied to the ledger lines.
 */
async function admit(ctx: ApiContext, r: Ready, principal: Principal, networkId: string, key: string, requestHash: string, requestId: string) {
  try {
    return await admitPaidRequest(ctx.db, {
      policy: r.ai.policy,
      principal,
      networkId,
      idempotencyKey: key,
      requestHash,
      reservationUsd: r.reservationUsd,
      requestId,
      now: r.ai.now(),
    });
  } catch (err) {
    if (err instanceof UnknownPrincipalError) return 'new_check' as const;
    throw err;
  }
}

/** The billing principal of a paid request, or the refusal already sent. */
type Billing = { ok: true; principal: Principal; networkId: string; who: Visitor } | { ok: false; reply: FastifyReply };

/**
 * Who pays for a paid request: the signed-in account, else the trial the anonymous gate
 * passes (it may create the trial and set its cookie). `who` gains a trial the gate
 * created.
 */
async function billing(r: Ready, request: FastifyRequest, reply: FastifyReply, who: Visitor, token: unknown): Promise<Billing> {
  if (who.account) {
    const networkId = request.networkIdentity;
    // The access hook resolves it for every API route; a route without one is a wiring bug.
    if (!networkId) throw new Error('a paid request needs the request network identity');
    return { ok: true, principal: who.account.principal, networkId, who };
  }
  const gate = r.ai.gate;
  if (!gate) return { ok: false, reply: sendError(reply, 503, 'unavailable') };
  const pass = await gate.check(request, reply, token);
  if (!pass.ok) return { ok: false, reply: sendGateRefusal(reply, pass, r.ai.now()) };
  const trial = who.trial ?? { principal: pass.principal, hash: principalHash(r.ai.policy, pass.principal) };
  return { ok: true, principal: pass.principal, networkId: pass.networkId, who: { ...who, trial } };
}

/** The brief when the visitor reads it (its account or its browser's trial) and it has not expired. */
async function ownedBrief(ctx: ApiContext, request: FastifyRequest, id: string) {
  if (!ctx.ai) return null;
  const who = await visitor(ctx, request);
  if (!who.account && !who.trial) return null;
  const brief = await readBrief(ctx.db, id, ctx.ai.now());
  const reader = brief ? readerOf(who, brief) : null;
  return brief && reader ? { brief, who, reader } : null;
}

function originOf(step: StepRow): BriefStepResponse['origin'] {
  const req: StepRequest = step.request;
  switch (req.origin) {
    case 'question':
      return { kind: 'question' };
    case 'text':
      return { kind: 'text', text: req.refinement ?? req.question };
    case 'filters':
      return { kind: 'filters', filters: req.filters ?? {} };
    case 'interpretation': {
      const c = req.change;
      if (c?.kind !== 'interpretation') return { kind: 'interpretation', label: 'Reading changed' };
      const label =
        c.field === 'timing_window' && typeof c.value === 'object'
          ? timingWindowLabel(c.value)
          : c.field === 'first_flight_only'
            ? c.value === true
              ? FIRST_FLIGHT_LABEL
              : 'Any flight after maintenance'
            : typeof c.value === 'string' && isFailureType(c.value)
              ? FAILURE_TYPE_LABELS[c.value]
              : 'Reading changed';
      return { kind: 'interpretation', label };
    }
  }
}

/**
 * The step's checklist as a read returns it (UI_DESIGN §4.4: the question and chips stay
 * on top while the step runs). Once the scope stage has sent the step on to search
 * (`question: 'in_scope'`, stored together with the step's intent), it carries the
 * readings and filters that stage settled on: interpretation chips rendered from the
 * stored intent with the server's templates, and its validated filters, which the
 * finished result repeats. It stays in every later checklist, a cancelled or failed
 * step's included; a step before or without a search (a static reply) has none. The
 * planner's own words (`keywordText`) are never sent. A stored intent that would not
 * render to the contract (a value out of range, or a shape the pipeline never writes) is
 * left out rather than failing the read: the step answers without the field.
 */
export function checklistOf(step: Pick<StepRow, 'checklist' | 'intent'>): Checklist {
  const { checklist, intent } = step;
  if (checklist.question !== 'in_scope' || !intent) return checklist;
  try {
    const withReadings = ChecklistSchema.safeParse({
      ...checklist,
      interpretation: { interpretations: interpretationChips(intent.readings), filters: intent.filters },
    });
    return withReadings.success ? withReadings.data : checklist;
  } catch {
    // The chips could not be built from the stored readings (a row written outside the pipeline).
    return checklist;
  }
}

function stepResponse(briefId: string, step: StepRow, steps: number, expiresAt: Date, now: Date): BriefStepResponse {
  const stale = step.status === 'running' && !isLiveStep(step, now);
  const finished = step.status !== 'running' || stale;
  return {
    briefId,
    step: step.n,
    steps,
    refinementsLeft: Math.max(0, MAX_BRIEF_STEPS - steps),
    question: step.request.question,
    origin: originOf(step),
    stage: stale ? 'failed' : step.stage,
    checklist: checklistOf(step),
    startedAt: step.createdAt.toISOString(),
    finishedAt: finished ? (step.finishedAt ?? now).toISOString() : null,
    expiresAt: expiresAt.toISOString(),
    ...(stale ? { result: { kind: 'failed', countedAsSearch: true } } : step.result ? { result: step.result } : {}),
  };
}

const StepQuerySchema = z.strictObject({ step: z.coerce.number().pipe(StepNumberSchema).optional() });

export function briefRoutes(app: FastifyInstance, ctx: ApiContext, opts: { appUrl: string }): void {
  const appOrigin = new URL(opts.appUrl).origin;

  /** `POST /api/briefs` (tracked work: see the module comment). */
  async function createBrief(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const parsed = CreateBriefRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const body = parsed.data;
    const stepRequest = questionRequest(body.question, body.filters);
    if (queryTooLong(stepRequest)) return sendError(reply, 400, 'bad_request', { message: TOO_LONG });
    const r = await ready(ctx);
    // Shutdown checks: before the gate claims the token, before admission, before the step exists.
    if (!r || stopping(r.svc)) return sendError(reply, 503, 'unavailable');

    const requestHash = createRequestHash(body.question, body.filters);
    // A retry of a request this browser made before: its step, never a second run (one clock reading).
    const asked = r.ai.now();
    let who = await visitor(ctx, request, asked);
    const earlier = await earlierStep(ctx, who, body.idempotencyKey, requestHash, asked);
    if (earlier) return sendReplay(ctx, reply, earlier, who, asked);

    const payer = await billing(r, request, reply, who, body.turnstileToken);
    if (!payer.ok) return payer.reply;
    who = payer.who;
    if (stopping(r.svc)) return sendError(reply, 503, 'unavailable');
    const { principal } = payer;
    const owner = principalHash(r.ai.policy, principal);
    const requestId = `brief:${randomUUID()}`;
    const admission = await admit(ctx, r, principal, payer.networkId, body.idempotencyKey, requestHash, requestId);
    if (admission === 'new_check') return sendError(reply, 403, 'challenge_required');
    if (!admission.ok) return sendRejection(reply, admission, r.ai.now());
    if (admission.replay) return sendReplay(ctx, reply, RESULT_REF.exec(admission.resultRef ?? '')?.[1] ?? null, who, r.ai.now());
    if (stopping(r.svc)) {
      await abandon(ctx, r, admission);
      return sendError(reply, 503, 'unavailable');
    }

    let created: { briefId: string; step: StepRow };
    try {
      created = await ctx.db.transaction(async (tx) => {
        const now = r.ai.now();
        // The asker reads the brief and pays for its first step: the account, or the trial.
        const brief = await insertBrief(tx, {
          readOwner: owner,
          readOwnerKind: principal.kind,
          generationId: r.evidence.generationId,
          passagesIndex: r.evidence.passagesIndex,
          now,
          ttlMs: BRIEF_TTL_MS,
        });
        const step = await insertStep(tx, {
          briefId: brief.id,
          n: 1,
          billingPrincipal: owner,
          billingKind: principal.kind,
          reservationId: admission.reservationId,
          request: stepRequest,
          now,
        });
        if (!step) throw new Error('the first step of a new brief already exists');
        await setResultRef(tx, admission, `brief-step:${step.id}`);
        return { briefId: brief.id, step };
      });
    } catch (err) {
      await abandon(ctx, r, admission);
      throw err;
    }
    return sendStart(reply, await start(ctx, r, created.briefId, created.step, admission, requestId));
  }
  app.post('/api/briefs', async (request, reply) => tracked(ctx, () => createBrief(request, reply)));

  /** `POST /api/briefs/:id/refine` (tracked work: see the module comment). */
  async function refineBrief(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const id = BriefIdSchema.safeParse(request.params.id);
    if (!id.success) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const parsed = RefinementRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const body = parsed.data;
    const change = refinementChange(body);
    const rt = runtime(ctx);
    if (!rt) return sendError(reply, 503, 'unavailable');

    let who = await visitor(ctx, request);
    if (!who.account && !who.trial) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    // A retry of a refinement this browser made before: its step, never a second run.
    const requestHash = refineRequestHash(id.data, change);
    const earlier = await earlierStep(ctx, who, body.idempotencyKey, requestHash, rt.ai.now());
    if (earlier) return sendReplay(ctx, reply, earlier, who, rt.ai.now());
    // The read owner (the account, or this browser's trial), before any token work.
    const brief = await readBrief(ctx.db, id.data, rt.ai.now());
    if (!brief || !readerOf(who, brief)) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const steps = await listSteps(ctx.db, id.data);
    if (steps.length >= MAX_BRIEF_STEPS) return sendError(reply, 409, 'refinement_limit');
    // A step that lost its process (stale) no longer blocks the brief.
    if (steps.some((s) => isLiveStep(s, rt.ai.now()))) return sendError(reply, 429, 'in_flight');
    const latest = await readStep(ctx.db, id.data);
    if (latest && queryTooLong(refinementRequest({ request: latest.request, intent: latest.intent }, change))) {
      return sendError(reply, 400, 'bad_request', { message: TOO_LONG });
    }
    // The brief stays on the evidence index it started on.
    const r = await readyFor(rt, brief);
    // Shutdown checks: before the gate claims the token, before admission, before the step exists.
    if (!r || stopping(r.svc)) return sendError(reply, 503, 'unavailable');

    const payer = await billing(r, request, reply, who, body.turnstileToken);
    if (!payer.ok) return payer.reply;
    who = payer.who;
    if (stopping(r.svc)) return sendError(reply, 503, 'unavailable');
    const { principal } = payer;
    const billed = principalHash(r.ai.policy, principal);
    // An anonymous visitor refines only the brief its trial reads.
    if (principal.kind === 'trial' && billed !== brief.readOwner) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const requestId = `brief:${randomUUID()}`;
    const admission = await admit(ctx, r, principal, payer.networkId, body.idempotencyKey, requestHash, requestId);
    if (admission === 'new_check') return sendError(reply, 403, 'challenge_required');
    if (!admission.ok) return sendRejection(reply, admission, r.ai.now());
    if (admission.replay) return sendReplay(ctx, reply, RESULT_REF.exec(admission.resultRef ?? '')?.[1] ?? null, who, r.ai.now());
    if (stopping(r.svc)) {
      await abandon(ctx, r, admission);
      return sendError(reply, 503, 'unavailable');
    }

    let step: StepRow | null | 'not_owner';
    try {
      step = await ctx.db.transaction(async (tx) => {
        const now = r.ai.now();
        const previous = await readStep(tx, id.data);
        if (!previous || isLiveStep(previous, now) || previous.n >= MAX_BRIEF_STEPS) return null;
        // Signed in on a brief this browser's trial still owns: it moves to the account first
        // (the handover's compare-and-set); the refinement is the account's.
        if (principal.kind === 'account' && brief.readOwner !== billed) {
          const trial = who.trial;
          if (!trial || brief.readOwner !== trial.hash || !(await takeOver(tx, id.data, trial.hash, billed, now))) return 'not_owner' as const;
        }
        const inserted = await insertStep(tx, {
          briefId: id.data,
          n: previous.n + 1,
          billingPrincipal: billed,
          billingKind: principal.kind,
          reservationId: admission.reservationId,
          request: refinementRequest({ request: previous.request, intent: previous.intent }, change),
          now,
        });
        if (inserted) await setResultRef(tx, admission, `brief-step:${inserted.id}`);
        return inserted;
      });
    } catch (err) {
      await abandon(ctx, r, admission);
      throw err;
    }
    if (step === 'not_owner') {
      // The brief moved to another account meanwhile: nothing was spent.
      await abandon(ctx, r, admission);
      return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    }
    if (!step) {
      // Another refinement got there first: nothing was spent.
      await abandon(ctx, r, admission);
      return sendError(reply, 409, 'conflict');
    }
    return sendStart(reply, await start(ctx, r, id.data, step, admission, requestId));
  }
  app.post<{ Params: { id: string } }>('/api/briefs/:id/refine', async (request, reply) => tracked(ctx, () => refineBrief(request, reply)));

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/briefs/:id', async (request, reply) => {
    const id = BriefIdSchema.safeParse(request.params.id);
    if (!id.success || !ctx.ai) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const query = StepQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(query.error.issues) });
    const owned = await ownedBrief(ctx, request, id.data);
    if (!owned) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const found = await readStepWithCount(ctx.db, id.data, query.data.step);
    if (!found) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const body = BriefStepResponseSchema.parse(stepResponse(id.data, found.step, found.steps, owned.brief.expiresAt, ctx.ai.now()));
    return reply.code(200).type(JSON_TYPE).send(JSON.stringify(body));
  });

  app.post<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/briefs/:id/cancel', async (request, reply) => {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const id = BriefIdSchema.safeParse(request.params.id);
    if (!id.success || !ctx.ai) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const query = StepQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(query.error.issues) });
    const owned = await ownedBrief(ctx, request, id.data);
    if (!owned) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const step = await readStep(ctx.db, id.data, query.data.step);
    if (!step) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    if (step.status === 'running') {
      await requestCancel(ctx.db, step.id, ctx.ai.now());
      ctx.briefs?.runs.get(step.id)?.controller.abort();
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string; n: string; ntsbNo: string } }>('/api/briefs/:id/steps/:n/cases/:ntsbNo', async (request, reply) => {
    const id = BriefIdSchema.safeParse(request.params.id);
    const n = z.coerce.number().pipe(StepNumberSchema).safeParse(request.params.n);
    const ntsbNo = NtsbNoSchema.safeParse(String(request.params.ntsbNo ?? '').toUpperCase());
    if (!id.success || !n.success || !ntsbNo.success) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const owned = await ownedBrief(ctx, request, id.data);
    if (!owned) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const step = await readStep(ctx.db, id.data, n.data);
    const context = step ? caseContext(step, ntsbNo.data) : null;
    if (!context) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const body = CaseContextResponseSchema.parse(context);
    return reply.code(200).type(JSON_TYPE).send(JSON.stringify(body));
  });
}
