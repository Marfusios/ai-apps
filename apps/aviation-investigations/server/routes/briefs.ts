/**
 * AI briefs (shared/contracts/briefs.ts), under the route-based default deny of
 * server/app.ts: every route needs a network identity and is rate limited, and the
 * cache-headers rule makes everything under `/api/briefs` `private, no-store`.
 *
 * Paid requests (`POST /api/briefs`, `POST /api/briefs/:id/refine`), in order, before
 * anything is spent:
 * 1. a cross-site `Origin` is refused (the bodies are JSON and the trial cookie is
 *    SameSite=Lax; this is the explicit check for custom POST endpoints, DESIGN §7);
 * 2. the body is validated (strict schemas);
 * 3. AI must be able to run: the startup check, the quota policy, the anonymous gate, a
 *    provider and an evidence index that the dataset reports servable and the retriever
 *    accepts (503 `unavailable` otherwise, never saying why);
 * 4. refinements: the read owner, the three-refinement limit and one step at a time
 *    are checked before any token work;
 * 5. the anonymous gate (server/identity/gate.ts): availability (kill switch, budgets,
 *    the trial's searches, the anonymous share) before it claims the Turnstile token,
 *    then the token, then the trial;
 * 6. admission (server/quota/admit.ts): idempotency, rate limits, budgets, quota and
 *    concurrency, reserving the request's maximum cost. A trial that expired since the
 *    gate (`UnknownPrincipalError`) asks for a new check (403 `challenge_required`).
 *
 * The step then runs in the background (server/briefs/pipeline.ts); the request waits
 * only for the scope stage, so a static reply comes back directly (`scope_reply`) and an
 * in-scope question answers `started`, to be polled with `GET`.
 *
 * Reads (`GET`, the case context and cancel) are for the brief's read owner only: the
 * trial in the request's cookie (Task 20 adds signed-in sessions). Anything else is 404.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BRIEF_TTL_MS,
  BriefIdSchema,
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  CreateBriefRequestSchema,
  MAX_BRIEF_STEPS,
  RefinementRequestSchema,
  StartBriefResponseSchema,
  StepNumberSchema,
  refinementChange,
  type BriefStepResponse,
  type StartBriefResponse,
} from '../../shared/contracts/briefs.js';
import { NtsbNoSchema } from '../../shared/contracts/common.js';
import type { AiRuntime } from '../ai/runtime.js';
import { caseContext } from '../briefs/context.js';
import { createRequestHash, questionRequest, refineRequestHash, refinementRequest, type StepRequest } from '../briefs/intent.js';
import { runBriefStep, type ScopedOutcome } from '../briefs/pipeline.js';
import type { BriefServices } from '../briefs/services.js';
import { insertBrief, insertStep, listSteps, readBrief, readStep, readStepById, requestCancel, type StepRow } from '../briefs/store.js';
import { FAILURE_TYPE_LABEL, FIRST_FLIGHT_LABEL, timingWindowLabel } from '../briefs/clarify.js';
import type { LlmProvider } from '../ai/provider.js';
import { issuesOf, JSON_TYPE, sendError } from '../http/reply.js';
import { retryAfterSeconds, sendGateRefusal } from '../identity/gate.js';
import type { TrialPrincipal } from '../identity/trial.js';
import { admitPaidRequest, releaseQuota, setResultRef, type Admission, type Rejection } from '../quota/admit.js';
import { LEASE_TTL_MS, principalHash, UnknownPrincipalError, type QuotaPolicy } from '../quota/policy.js';
import { settle } from '../quota/settle.js';
import { sql } from 'drizzle-orm';
import type { ApiContext } from './context.js';

const NOT_FOUND = 'No AI search with that link is available. AI searches expire after 24 hours.';
/** A step still `running` this long after it started died with its process; the lease expiry charged it. */
const STALE_AFTER_MS = LEASE_TTL_MS + 30_000;

interface Ready {
  ai: AiRuntime & { policy: QuotaPolicy; llm: LlmProvider; gate: NonNullable<AiRuntime['gate']>; trials: NonNullable<AiRuntime['trials']> };
  svc: BriefServices;
  reservationUsd: number;
  evidence: { generationId: number; passagesIndex: string };
}

/** Everything a paid brief request needs, or null (503). */
async function ready(ctx: ApiContext): Promise<Ready | null> {
  const ai = ctx.ai;
  const svc = ctx.briefs;
  if (!ai?.startup.enabled || ai.startup.reservationUsd === undefined || !ai.policy || !ai.llm || !ai.gate || !ai.trials || !svc) return null;
  const evidence = await ctx.aiEvidence().catch(() => null);
  if (!evidence) return null;
  return { ai: ai as Ready['ai'], svc, reservationUsd: ai.startup.reservationUsd, evidence };
}

/**
 * A browser request that another site started. Browsers that send `Sec-Fetch-Site` are
 * judged by it (only `same-origin` and `none` pass, which also covers the development
 * server's proxy); otherwise an `Origin` other than `APP_URL`'s is refused. Requests
 * with neither header (tools, tests) pass: they cannot carry a visitor's SameSite cookie
 * from another site anyway.
 */
function crossSite(request: FastifyRequest, appOrigin: string): boolean {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.origin;
  return origin !== undefined && origin !== appOrigin;
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

/** The reply to a replayed request: the step it made, if the requester still owns its brief. */
async function sendReplay(ctx: ApiContext, reply: FastifyReply, stepId: string | null, owner: string, now: Date): Promise<FastifyReply> {
  const step = stepId ? await readStepById(ctx.db, stepId) : null;
  if (!step) return sendError(reply, 409, 'conflict', { message: 'This request was accepted earlier but did not start. Ask again.' });
  const brief = await readBrief(ctx.db, step.briefId, now);
  if (!brief || brief.readOwner !== owner) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
  return sendStart(reply, startResponse(brief.id, step));
}

/** Give back an admission that made no step (nothing was spent). */
async function abandon(ctx: ApiContext, r: Ready, admission: Admission): Promise<void> {
  await releaseQuota(ctx.db, admission, admission.fencingToken, { policy: r.ai.policy, now: r.ai.now() }).catch(() => undefined);
  await settle(ctx.db, admission, 0, admission.fencingToken, r.ai.now()).catch(() => undefined);
}

/** Start the step in the background and wait for its scope stage. */
async function start(ctx: ApiContext, r: Ready, briefId: string, step: StepRow, admission: Admission): Promise<StartBriefResponse> {
  const controller = new AbortController();
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
    { signal: controller.signal, onScoped },
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

/** Admit a gated principal; maps the trial expiring since the gate to "take a new check". */
async function admit(ctx: ApiContext, r: Ready, principal: TrialPrincipal, networkId: string, key: string, requestHash: string) {
  try {
    return await admitPaidRequest(ctx.db, {
      policy: r.ai.policy,
      principal,
      networkId,
      idempotencyKey: key,
      requestHash,
      reservationUsd: r.reservationUsd,
      requestId: 'brief',
      now: r.ai.now(),
    });
  } catch (err) {
    if (err instanceof UnknownPrincipalError) return 'new_check' as const;
    throw err;
  }
}

/** The requester's principal and its HMAC (the trial in the cookie), or null. */
async function requester(ctx: ApiContext, request: FastifyRequest): Promise<{ principal: TrialPrincipal; hash: string } | null> {
  const ai = ctx.ai;
  if (!ai?.trials || !ai.policy) return null;
  const principal = await ai.trials.fromRequest(request, ai.now());
  return principal ? { principal, hash: principalHash(ai.policy, principal) } : null;
}

/** The brief, when the requester is its read owner and it has not expired. */
async function ownedBrief(ctx: ApiContext, request: FastifyRequest, id: string) {
  const who = await requester(ctx, request);
  if (!who || !ctx.ai) return null;
  const brief = await readBrief(ctx.db, id, ctx.ai.now());
  return brief && brief.readOwner === who.hash ? { brief, who } : null;
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
            : typeof c.value === 'string' && c.value in FAILURE_TYPE_LABEL
              ? FAILURE_TYPE_LABEL[c.value as keyof typeof FAILURE_TYPE_LABEL]
              : 'Reading changed';
      return { kind: 'interpretation', label };
    }
  }
}

function stepResponse(briefId: string, step: StepRow, steps: number, expiresAt: Date, now: Date): BriefStepResponse {
  const stale = step.status === 'running' && now.getTime() - step.createdAt.getTime() > STALE_AFTER_MS;
  const finished = step.status !== 'running' || stale;
  return {
    briefId,
    step: step.n,
    steps,
    refinementsLeft: Math.max(0, MAX_BRIEF_STEPS - steps),
    question: step.request.question,
    origin: originOf(step),
    stage: stale ? 'failed' : step.stage,
    checklist: step.checklist,
    startedAt: step.createdAt.toISOString(),
    finishedAt: finished ? (step.finishedAt ?? now).toISOString() : null,
    expiresAt: expiresAt.toISOString(),
    ...(stale ? { result: { kind: 'failed', countedAsSearch: true } } : step.result ? { result: step.result } : {}),
  };
}

const StepQuerySchema = z.strictObject({ step: z.coerce.number().pipe(StepNumberSchema).optional() });

export function briefRoutes(app: FastifyInstance, ctx: ApiContext, opts: { appUrl: string }): void {
  const appOrigin = new URL(opts.appUrl).origin;

  app.post('/api/briefs', async (request, reply) => {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const parsed = CreateBriefRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const body = parsed.data;
    const r = await ready(ctx);
    if (!r) return sendError(reply, 503, 'unavailable');

    const pass = await r.ai.gate.check(request, reply, body.turnstileToken);
    if (!pass.ok) return sendGateRefusal(reply, pass, r.ai.now());
    const owner = principalHash(r.ai.policy, pass.principal);
    const requestHash = createRequestHash(body.question, body.filters);
    const admission = await admit(ctx, r, pass.principal, pass.networkId, body.idempotencyKey, requestHash);
    if (admission === 'new_check') return sendError(reply, 403, 'challenge_required');
    if (!admission.ok) return sendRejection(reply, admission, r.ai.now());
    if (admission.replay) return sendReplay(ctx, reply, RESULT_REF.exec(admission.resultRef ?? '')?.[1] ?? null, owner, r.ai.now());

    let created: { briefId: string; step: StepRow };
    try {
      created = await ctx.db.transaction(async (tx) => {
        const now = r.ai.now();
        const brief = await insertBrief(tx, {
          readOwner: owner,
          readOwnerKind: 'trial',
          generationId: r.evidence.generationId,
          passagesIndex: r.evidence.passagesIndex,
          now,
          ttlMs: BRIEF_TTL_MS,
        });
        const step = await insertStep(tx, {
          briefId: brief.id,
          n: 1,
          billingPrincipal: owner,
          billingKind: 'trial',
          reservationId: admission.reservationId,
          request: questionRequest(body.question, body.filters),
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
    return sendStart(reply, await start(ctx, r, created.briefId, created.step, admission));
  });

  app.post<{ Params: { id: string } }>('/api/briefs/:id/refine', async (request, reply) => {
    if (crossSite(request, appOrigin)) return sendError(reply, 403, 'forbidden');
    const id = BriefIdSchema.safeParse(request.params.id);
    if (!id.success) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const parsed = RefinementRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const body = parsed.data;
    const change = refinementChange(body);
    const r = await ready(ctx);
    if (!r) return sendError(reply, 503, 'unavailable');

    // The read owner, before any token work; then a retry of an accepted refinement replays it.
    const owned = await ownedBrief(ctx, request, id.data);
    if (!owned) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const requestHash = refineRequestHash(id.data, change);
    const earlier = await replayed(ctx, owned.who.hash, body.idempotencyKey, requestHash, r.ai.now());
    if (earlier) return sendReplay(ctx, reply, earlier, owned.who.hash, r.ai.now());
    const steps = await listSteps(ctx.db, id.data);
    if (steps.length >= MAX_BRIEF_STEPS) return sendError(reply, 409, 'refinement_limit');
    if (steps.some((s) => s.status === 'running')) return sendError(reply, 429, 'in_flight');

    const pass = await r.ai.gate.check(request, reply, body.turnstileToken);
    if (!pass.ok) return sendGateRefusal(reply, pass, r.ai.now());
    const billing = principalHash(r.ai.policy, pass.principal);
    if (billing !== owned.brief.readOwner) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const admission = await admit(ctx, r, pass.principal, pass.networkId, body.idempotencyKey, requestHash);
    if (admission === 'new_check') return sendError(reply, 403, 'challenge_required');
    if (!admission.ok) return sendRejection(reply, admission, r.ai.now());
    if (admission.replay) return sendReplay(ctx, reply, RESULT_REF.exec(admission.resultRef ?? '')?.[1] ?? null, billing, r.ai.now());

    let step: StepRow | null;
    try {
      step = await ctx.db.transaction(async (tx) => {
        const previous = await readStep(tx, id.data);
        if (!previous || previous.status === 'running' || previous.n >= MAX_BRIEF_STEPS) return null;
        const inserted = await insertStep(tx, {
          briefId: id.data,
          n: previous.n + 1,
          billingPrincipal: billing,
          billingKind: 'trial',
          reservationId: admission.reservationId,
          request: refinementRequest({ request: previous.request, intent: previous.intent }, change),
          now: r.ai.now(),
        });
        if (inserted) await setResultRef(tx, admission, `brief-step:${inserted.id}`);
        return inserted;
      });
    } catch (err) {
      await abandon(ctx, r, admission);
      throw err;
    }
    if (!step) {
      // Another refinement got there first: nothing was spent.
      await abandon(ctx, r, admission);
      return sendError(reply, 409, 'conflict');
    }
    return sendStart(reply, await start(ctx, r, id.data, step, admission));
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/briefs/:id', async (request, reply) => {
    const id = BriefIdSchema.safeParse(request.params.id);
    if (!id.success || !ctx.ai) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const query = StepQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(query.error.issues) });
    const owned = await ownedBrief(ctx, request, id.data);
    if (!owned) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const step = await readStep(ctx.db, id.data, query.data.step);
    if (!step) return sendError(reply, 404, 'not_found', { message: NOT_FOUND });
    const steps = (await listSteps(ctx.db, id.data)).length;
    const body = BriefStepResponseSchema.parse(stepResponse(id.data, step, steps, owned.brief.expiresAt, ctx.ai.now()));
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
