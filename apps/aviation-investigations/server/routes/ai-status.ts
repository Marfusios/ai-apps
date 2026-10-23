/**
 * `GET /api/ai/status` (UI_DESIGN §5): whether Ask AI can work for this visitor, read
 * before anyone clicks. The visitor is the signed-in account (its session cookie,
 * server/auth/better-auth.ts), else the live trial proven by the trial cookie, else a
 * fresh anonymous visitor (no cookie, or one that is malformed, tampered with or
 * expired; such a cookie is ignored). A signed-in visitor sees the account's own counts.
 *
 * The answer comes from `aiStatus` (server/quota/status.ts), which reads only and
 * never returns amounts. On top of it this route reports `paused` with reason
 * `dependency` (and no retry time) when AI cannot run at all: the startup check failed,
 * no language-model provider is available, the quota policy is missing its secrets,
 * quota storage or the session cannot be read, there is no evidence index to search (the active
 * manifest names no passages index, the dataset reports it not servable, or evidence
 * retrieval is not bound or refuses it),
 * or, for an anonymous visitor who would otherwise be offered AI, Turnstile is not
 * configured.
 * A signed-in visitor's counts carry `check: true` while its next AI request needs a
 * Turnstile check (the step-up policy, server/identity/step-up.ts), so the page takes the
 * check at click time.
 * The response is per visitor: `no-store`, and it never sets a cookie.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AiStatusResponseSchema, type AiRemaining, type AiStatusResponse } from '../../shared/contracts/ai.js';
import { JSON_TYPE } from '../http/reply.js';
import { accountCheckSignals } from '../identity/step-up.js';
import type { Principal } from '../quota/policy.js';
import { aiStatus, type AiStatus } from '../quota/status.js';
import type { ApiContext } from './context.js';

const dependency = (remaining: AiRemaining = null): AiStatusResponse => ({ state: 'paused', reason: 'dependency', remaining });

/** The public form of `aiStatus`: ISO retry time, the trial's `started` flag, and an account's `check`. */
export function toStatusResponse(s: AiStatus, trialStarted: boolean, check = false): AiStatusResponse {
  const remaining: AiRemaining =
    s.remaining.kind === 'trial' ? { ...s.remaining, started: trialStarted } : { ...s.remaining, ...(check ? { check: true as const } : {}) };
  if (s.state === 'available') return { state: 'available', remaining };
  // The schema checks that the reason belongs to the state.
  return AiStatusResponseSchema.parse({
    state: s.state,
    reason: s.reason,
    ...(s.retryAt ? { retryAt: s.retryAt.toISOString() } : {}),
    remaining,
  });
}

async function statusFor(ctx: ApiContext, request: FastifyRequest): Promise<AiStatusResponse> {
  const ai = ctx.ai;
  const reservationUsd = ai?.startup.enabled ? ai.startup.reservationUsd : undefined;
  if (!ai || reservationUsd === undefined || !ai.policy || !ai.trials || !ai.llm) return dependency();
  let s: AiStatus;
  let principal: Principal | null;
  let check = false;
  try {
    const now = ai.now();
    const signedIn = ctx.auth ? await ctx.auth.signedIn(request.headers.cookie) : null;
    principal = signedIn ? signedIn.principal : await ai.trials.fromRequest(request, now);
    s = await aiStatus(ctx.db, principal, { policy: ai.policy, reservationUsd, now });
    if (signedIn && s.state === 'available') {
      check = (await accountCheckSignals(ctx.db, ai.policy, signedIn.principal, request.networkIdentity ?? null, now)).length > 0;
    }
  } catch (err) {
    request.log.warn({ err: { name: (err as Error).name } }, 'AI status unavailable');
    return dependency();
  }
  const body = toStatusResponse(s, principal !== null, check);
  // Nothing to search: AI cannot answer anyone.
  const evidence = await ctx.aiEvidence().catch((err: unknown) => {
    request.log.warn({ err: { name: (err as Error).name } }, 'AI evidence check failed');
    return null;
  });
  if (!evidence) return dependency(body.remaining);
  // Every anonymous AI request needs a Turnstile check, and so does a flagged signed-in one.
  if (body.state === 'available' && (s.remaining.kind === 'trial' || check) && !ai.gate) return dependency(body.remaining);
  return body;
}

export function aiStatusRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/ai/status', async (request, reply) => {
    const body = AiStatusResponseSchema.parse(await statusFor(ctx, request));
    return reply.code(200).header('cache-control', 'no-store').type(JSON_TYPE).send(JSON.stringify(body));
  });
}
