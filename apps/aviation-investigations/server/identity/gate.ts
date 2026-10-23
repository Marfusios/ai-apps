/**
 * The anonymous AI gate: the admission pre-step of every anonymous AI request
 * (DESIGN §7–§8, UI_DESIGN §5). An AI route (Task 16) calls it before
 * `admitPaidRequest` for a visitor who is not signed in:
 *
 * ```ts
 * const gate = ctx.ai?.gate;
 * if (!gate) return sendError(reply, 503, 'unavailable');
 * const pass = await gate.check(request, reply, body.turnstileToken);
 * if (!pass.ok) return sendGateRefusal(reply, pass);
 * const admission = await admitPaidRequest(ctx.db, { policy, principal: pass.principal, networkId: pass.networkId, ... });
 * ```
 *
 * In order, nothing of which reserves money or touches quota:
 *
 * 1. The login-required emergency mode (`setAnonymousAi(db, false)`) refuses at once
 *    (`login_required`, 403 `sign_in_required`).
 * 2. Availability (`availability`, wired in server/ai/runtime.ts from `aiStatus`), for
 *    the trial in the request's cookie or a new visitor, before any token work: the
 *    kill switch and the budgets (`ai_paused`, 503), this trial's searches
 *    (`trial_used`, 429) and today's anonymous share (`free_searches_paused`, 429). A
 *    request that would be refused anyway never claims a token or creates a trial.
 *    Admission still makes the binding decision.
 * 3. A Turnstile token is required (`challenge_required`) and must be well formed.
 * 4. The token is claimed under its keyed HMAC: a token seen before is refused without
 *    calling Cloudflare (`challenge_failed`), and of two concurrent requests with one
 *    token only one goes on. (With Cloudflare's test keys, development only, the widget
 *    always returns the same dummy token; that one token is not claimed, or every AI
 *    request after the first would fail. The reuse path is tested with the `3x` test
 *    secret, which reports a spent token.)
 * 5. Cloudflare verifies it (hostname, action, age; server/identity/turnstile.ts).
 *    Rejected, expired or reused: `challenge_failed` (403). Siteverify unreachable,
 *    timing out or failing: `unavailable` (503, fail closed).
 * 6. The trial comes from the request's signed cookie; when there is no live one, a
 *    trial is created (capped per network and per day: `trial_limit`, 429) and its
 *    cookie is set on the reply. A failed check never creates a trial or sets a cookie.
 *
 * Every gate outcome is per visitor, so the reply is marked `no-store`. The pass
 * carries the trial principal and the validated network identity for admission.
 * Signed-in principals (Task 20) do not go through this gate; `challenge` (steps 3 to 5
 * alone) checks a signed-in request the step-up policy flags, and an anonymous retry.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { sendError } from '../http/reply.js';
import { readAiSwitch } from '../quota/switch.js';
import { deriveIdentityKey, keyedHash } from './keys.js';
import type { TrialIdentities, TrialPrincipal } from './trial.js';
import { TURNSTILE_DUMMY_TOKEN, claimTurnstileToken, isWellFormedToken, type TurnstileVerifier } from './turnstile.js';

export interface GatePass {
  ok: true;
  principal: TrialPrincipal;
  /** The request's validated network identity (server/http/network-identity.ts), for admission. */
  networkId: string;
  /** True when this request created the trial; its cookie is on the reply. */
  trialStarted: boolean;
}

export type GateRefusalReason =
  | 'login_required'
  | 'ai_paused'
  | 'trial_used'
  | 'free_searches_paused'
  | 'challenge_required'
  | 'challenge_failed'
  | 'trial_limit'
  | 'unavailable';

export interface GateRefusal {
  ok: false;
  reason: GateRefusalReason;
  status: 403 | 429 | 503;
  /** For `trial_limit`: when a new trial can be created again; for the availability refusals, when known. */
  retryAt?: Date;
  /** Content-free cause for logs and tests (never sent): a Turnstile verdict or `reused`. */
  detail?: string;
}

export type GateResult = GatePass | GateRefusal;

/**
 * Whether AI could serve this visitor at all (the trial of its cookie, or null for a new
 * visitor): null when it could, otherwise the refusal. Reads only.
 */
export type GateAvailability = (principal: TrialPrincipal | null, now: Date) => Promise<GateRefusal | null>;

export interface AnonymousGateOptions {
  db: Db;
  trials: TrialIdentities;
  turnstile: TurnstileVerifier;
  /** IDENTITY_HMAC_SECRET, for the key that hashes claimed tokens. */
  identitySecret: string;
  /** Public Turnstile site key, served by `GET /api/config`. */
  siteKey: string;
  /** The availability check before any token work (step 2). */
  availability?: GateAvailability;
  now?: () => Date;
}

const refusal = (reason: GateRefusalReason, status: GateRefusal['status'], detail?: string, retryAt?: Date): GateRefusal => ({
  ok: false,
  reason,
  status,
  ...(detail ? { detail } : {}),
  ...(retryAt ? { retryAt } : {}),
});

export class AnonymousGate {
  readonly siteKey: string;
  /** True with Cloudflare's test keys (development only). */
  readonly testKeys: boolean;
  private readonly db: Db;
  private readonly trials: TrialIdentities;
  private readonly turnstile: TurnstileVerifier;
  private readonly tokenKey: Buffer;
  private readonly availability: GateAvailability | null;
  private readonly now: () => Date;

  constructor(opts: AnonymousGateOptions) {
    this.db = opts.db;
    this.trials = opts.trials;
    this.turnstile = opts.turnstile;
    this.tokenKey = deriveIdentityKey(opts.identitySecret, 'turnstile-token');
    this.siteKey = opts.siteKey;
    this.testKeys = opts.turnstile.testKey;
    this.availability = opts.availability ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Check one anonymous AI request with its Turnstile token (the request body's
   * `turnstileToken`, unvalidated). Throws only when the database fails (fail closed).
   */
  async check(request: FastifyRequest, reply: FastifyReply, token: unknown): Promise<GateResult> {
    const networkId = request.networkIdentity;
    // The access hook resolves it for every API route; a route without one is a wiring bug.
    if (!networkId) throw new Error('the anonymous gate needs the request network identity');
    reply.header('cache-control', 'no-store');
    const result = await this.decide(request, reply, networkId, token);
    if (!result.ok) request.log.info({ gate: result.reason, detail: result.detail }, 'anonymous AI request refused');
    return result;
  }

  /**
   * The Turnstile part of the gate alone (steps 3 to 5): a fresh single-use token, well
   * formed, claimed, and verified by Cloudflare. For AI requests that need a check without
   * the rest of the gate: an anonymous retry, which replays and spends nothing
   * (UI_DESIGN §5: retries take a fresh token as well), and a signed-in request the
   * step-up policy flags (server/identity/step-up.ts). Null when the check passes.
   */
  async challenge(request: FastifyRequest, reply: FastifyReply, token: unknown): Promise<GateRefusal | null> {
    reply.header('cache-control', 'no-store');
    const refused = await this.verifyToken(request, token, this.now());
    if (refused) request.log.info({ gate: refused.reason, detail: refused.detail }, 'AI request check refused');
    return refused;
  }

  private async decide(request: FastifyRequest, reply: FastifyReply, networkId: string, token: unknown): Promise<GateResult> {
    const now = this.now();
    if (!(await readAiSwitch(this.db)).anonymousEnabled) return refusal('login_required', 403);
    const existing = await this.trials.fromRequest(request, now);
    if (this.availability) {
      const refused = await this.availability(existing, now);
      if (refused) return refused;
    }

    const refused = await this.verifyToken(request, token, now);
    if (refused) return refused;

    if (existing) return { ok: true, principal: existing, networkId, trialStarted: false };
    const started = await this.trials.start(reply, networkId, now);
    if (started.ok) return { ok: true, principal: started.principal, networkId, trialStarted: true };
    if (started.reason === 'trial_limit') return refusal('trial_limit', 429, 'trial_limit', started.retryAt);
    return refusal('unavailable', 503, 'busy');
  }

  /** Steps 3 to 5: the token is there and well formed, claimed once, and Cloudflare accepts it. */
  private async verifyToken(request: FastifyRequest, token: unknown, now: Date): Promise<GateRefusal | null> {
    if (token === undefined || token === null || token === '') return refusal('challenge_required', 403);
    if (!isWellFormedToken(token)) return refusal('challenge_failed', 403, 'malformed');
    const dummy = this.testKeys && token === TURNSTILE_DUMMY_TOKEN;
    if (!dummy && !(await claimTurnstileToken(this.db, keyedHash(this.tokenKey, token), now))) {
      return refusal('challenge_failed', 403, 'reused');
    }
    const verdict = await this.turnstile.verify(token);
    if (!verdict.ok) {
      if (verdict.kind === 'unavailable') {
        request.log.warn({ turnstile: verdict.reason }, 'Turnstile verification unavailable');
        return refusal('unavailable', 503, verdict.reason);
      }
      return refusal('challenge_failed', 403, verdict.reason);
    }
    return null;
  }
}

/** Seconds until `at`, between 1 and a day (the `retryAfter` bound). */
export function retryAfterSeconds(at: Date, now: Date): number {
  return Math.min(86_400, Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000)));
}

/** Send a refusal as an `ErrorResponse` (403, 429 with `Retry-After`, or 503), `no-store`. */
export function sendGateRefusal(reply: FastifyReply, r: GateRefusal, now: Date = new Date()): FastifyReply {
  switch (r.reason) {
    case 'login_required':
      return sendError(reply, 403, 'sign_in_required');
    case 'ai_paused': {
      if (!r.retryAt) return sendError(reply, 503, 'ai_paused');
      const seconds = retryAfterSeconds(r.retryAt, now);
      reply.header('retry-after', String(seconds));
      return sendError(reply, 503, 'ai_paused', { retryAfter: seconds });
    }
    case 'trial_used':
      return sendError(reply, 429, 'trial_used');
    case 'free_searches_paused': {
      const seconds = retryAfterSeconds(r.retryAt ?? now, now);
      reply.header('retry-after', String(seconds));
      return sendError(reply, 429, 'free_searches_paused', { retryAfter: seconds });
    }
    case 'challenge_required':
      return sendError(reply, 403, 'challenge_required');
    case 'challenge_failed':
      return sendError(reply, 403, 'challenge_failed');
    case 'trial_limit': {
      const seconds = retryAfterSeconds(r.retryAt ?? now, now);
      reply.header('retry-after', String(seconds));
      return sendError(reply, 429, 'rate_limited', { retryAfter: seconds });
    }
    case 'unavailable':
      return sendError(reply, 503, 'unavailable');
  }
}
