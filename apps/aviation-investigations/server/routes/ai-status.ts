/**
 * `GET /api/ai/status` (UI_DESIGN §5): whether Ask AI can work for this visitor, read
 * before anyone clicks. The visitor is the live trial proven by the trial cookie, or a
 * fresh anonymous visitor (no cookie, or one that is malformed, tampered with or
 * expired; such a cookie is ignored). Signed-in principals arrive with Task 20.
 *
 * The answer comes from `aiStatus` (server/quota/status.ts), which reads only and
 * never returns amounts. On top of it this route reports `paused` with reason
 * `dependency` (and no retry time) when AI cannot run at all: the startup check failed,
 * the quota policy is missing its secrets, quota storage cannot be read, or, for an
 * anonymous visitor who would otherwise be offered AI, Turnstile is not configured.
 * The response is per visitor: `no-store`, and it never sets a cookie.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AiStatusResponseSchema, type AiRemaining, type AiStatusResponse } from '../../shared/contracts/ai.js';
import { JSON_TYPE } from '../http/reply.js';
import type { TrialPrincipal } from '../identity/trial.js';
import { aiStatus, type AiStatus } from '../quota/status.js';
import type { ApiContext } from './context.js';

const dependency = (remaining: AiRemaining = null): AiStatusResponse => ({ state: 'paused', reason: 'dependency', remaining });

/** The public form of `aiStatus`: ISO retry time and the trial's `started` flag. */
export function toStatusResponse(s: AiStatus, trialStarted: boolean): AiStatusResponse {
  const remaining: AiRemaining = s.remaining.kind === 'trial' ? { ...s.remaining, started: trialStarted } : s.remaining;
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
  if (!ai || reservationUsd === undefined || !ai.policy || !ai.trials) return dependency();
  let s: AiStatus;
  let principal: TrialPrincipal | null;
  try {
    const now = ai.now();
    principal = await ai.trials.fromRequest(request, now);
    s = await aiStatus(ctx.db, principal, { policy: ai.policy, reservationUsd, now });
  } catch (err) {
    request.log.warn({ err: { name: (err as Error).name } }, 'AI status unavailable');
    return dependency();
  }
  const body = toStatusResponse(s, principal !== null);
  // Every anonymous AI request needs a Turnstile check.
  if (body.state === 'available' && s.remaining.kind === 'trial' && !ai.gate) return dependency(body.remaining);
  return body;
}

export function aiStatusRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/ai/status', async (request, reply) => {
    const body = AiStatusResponseSchema.parse(await statusFor(ctx, request));
    return reply.code(200).header('cache-control', 'no-store').type(JSON_TYPE).send(JSON.stringify(body));
  });
}
