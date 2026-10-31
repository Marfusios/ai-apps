import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatusResponse } from '../../../../shared/contracts/ai';
import { ApiError, aiStatusQuery } from '../../api';
import { VisitorChangedError, forgetVisitor, visitorGeneration } from '../auth/visitor';
import { askAvailability, undoAvailability } from './status';
import { AiCheckError, useAiCheck, type AiCheckFailure } from './TurnstileGate';

/**
 * Whether a failed request used a search: `no` when the server refused it before any
 * work, `unknown` when no answer came back (a network error or a server error), so a
 * retry must replay the same request rather than claim it was free.
 */
export type SpentKnowledge = 'no' | 'unknown';

/** What the AI controls say after a request did not start (UI_DESIGN §5 messages). */
export type AiNotice =
  | { kind: 'paused'; status: Extract<AiStatusResponse, { state: 'paused' }> | null }
  | { kind: 'trial_used' }
  | { kind: 'free_paused'; loginRequired: boolean }
  /** The request's brief moved to the account that signed in from it: sign in to view it. */
  | { kind: 'moved' }
  /** `at`: when the refusal arrived (ms since the epoch), so a long wait can name its end time. */
  | { kind: 'rate'; seconds: number; at?: number }
  | { kind: 'failure'; spent: SpentKnowledge }
  /** `unknownBefore`: an earlier send of this request has an unknown outcome (it may have counted). */
  | { kind: 'check'; reason: Exclude<AiCheckFailure, 'cancelled'>; unknownBefore?: boolean }
  | { kind: 'empty' }
  | { kind: 'message'; text: string }
  /**
   * An AI evidence search the server could not finish (503 `unavailable`): it used none of the
   * visitor's searches. `undo`: it was sent as the search's free undo, whose one-use claim the
   * server may have taken before it failed.
   */
  | { kind: 'unfinished'; undo?: true };

/**
 * Where an AI request stands: `checking` (the Turnstile check), `sending` (on its way) and, for an
 * AI evidence search, `searching` once its checklist shows (web/src/features/evidence/useEvidenceSearch.ts).
 */
export type AiPhase = 'idle' | 'checking' | 'sending' | 'searching';

/**
 * The outcome of one `run`: the response, or nothing with whether the server may have
 * acted. `discarded`: the visitor changed (signed out, the account deleted, here or in
 * another tab) while it ran, so nothing of it may be kept or shown.
 */
export type RunResult<T> = { ok: true; value: T } | { ok: false; outcomeUnknown: boolean; busy?: true; discarded?: true };

export interface RunOptions {
  /**
   * The request replays an idempotency key whose earlier send has an unknown outcome. Until
   * this request settles it, no notice may claim that nothing was used.
   */
  replaying?: boolean;
  /**
   * A 409 `conflict` to the replay means the earlier attempt did not complete (the server
   * keeps the key with no result), so the request is sent once more: this swaps in a new
   * key first, which settles the old one.
   */
  onConflict?: () => void;
  /**
   * The visitor generation (web/src/features/auth/visitor.ts) the user's action started
   * under, read before any of its asynchronous work; default: when `run` is called.
   */
  visitor?: number;
  /**
   * The request uses none of the visitor's own searches (an evidence search's one free undo,
   * web/src/features/evidence/undo.ts): it is sent while they are used up, with the usual check
   * (`undoAvailability`). The server decides, and refuses what is not.
   */
  quotaExempt?: boolean;
}

/** A fresh idempotency key for one logical AI request (kept across its retries). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const CHALLENGE = new Set(['challenge_required', 'challenge_failed']);

/** True when no answer says what happened: the request may have been admitted. */
export function outcomeUnknown(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.status < 500) return false;
  return !(err.body && (err.body.error === 'ai_paused' || err.body.error === 'unavailable'));
}

export function noticeFor(err: unknown): AiNotice {
  if (!(err instanceof ApiError)) return { kind: 'failure', spent: 'unknown' };
  const code = err.body?.error;
  switch (code) {
    case 'ai_paused':
    case 'quota_exhausted':
    case 'unavailable':
      // The live AI status says which pause it is; the box reads it.
      return { kind: 'paused', status: null };
    case 'trial_used':
      return { kind: 'trial_used' };
    case 'free_searches_paused':
      return { kind: 'free_paused', loginRequired: false };
    case 'sign_in_required':
      return { kind: 'free_paused', loginRequired: true };
    case 'moved':
      return { kind: 'moved' };
    case 'signed_out':
      return { kind: 'message', text: err.body?.message ?? '' };
    case 'rate_limited':
      return { kind: 'rate', seconds: err.retryAfter ?? 30, at: Date.now() };
    case 'challenge_required':
    case 'challenge_failed':
      return { kind: 'check', reason: 'failed' };
    case 'in_flight':
    case 'conflict':
    case 'refinement_limit':
    case 'bad_request':
      return { kind: 'message', text: err.body?.message ?? '' };
    default:
      return { kind: 'failure', spent: outcomeUnknown(err) ? 'unknown' : 'no' };
  }
}

/**
 * Runs one paid AI request (Ask AI, Refine, a reading, Re-run): checks the AI status,
 * gets a fresh Turnstile token for anonymous visitors, and for a signed-in visitor the
 * server asks to check (the first-check panel once per trial identity, otherwise
 * invisibly with "Checking…"; a second control waits its turn), sends, and on a refused or
 * missing token takes one more, visible check ("Quick check before this AI search"). Each
 * request releases its check session at the end, refusals included, and the AI status is
 * re-read so the counters stay true. A request refused because the session ended
 * (`signed_out`) forgets the previous visitor's data, as signing out does. A request whose
 * visitor changed while it ran (signed out or deleted, here or in another tab) sends
 * nothing more and is discarded: its answer, success or failure, is neither applied nor
 * shown (`discarded`). `send` may wait before it sends (the brief client loads with the
 * first request): its POST carries the visitor generation and is refused right before the
 * network call when that visitor is gone (`VisitorChangedError`, web/src/api.ts `postJson`).
 */
export function useAiRequest() {
  const check = useAiCheck();
  const queryClient = useQueryClient();
  const status = useQuery(aiStatusQuery());
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [notice, setNotice] = useState<AiNotice | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  // Set in the effect body as well as cleared in its cleanup, so StrictMode's
  // mount-unmount-mount in development leaves it true.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(send: (turnstileToken: string | null) => Promise<T>, options: RunOptions = {}): Promise<RunResult<T>> => {
      // This control already has a request in flight: nothing is sent.
      if (running.current) return { ok: false, outcomeUnknown: false, busy: true };
      running.current = true;
      setNotice(null);
      const finish = <R>(value: R, next: AiNotice | null = null): R => {
        running.current = false;
        if (mounted.current) {
          setPhase('idle');
          setNotice(next);
        }
        return value;
      };
      // The visitor this request is for: after a change it is the previous visitor's.
      const at = options.visitor ?? visitorGeneration();
      const changed = (): boolean => visitorGeneration() !== at;
      const discarded = { ok: false, outcomeUnknown: false, discarded: true } as const;
      if (changed()) return finish(discarded);
      const current = status.data ?? (await queryClient.fetchQuery(aiStatusQuery()).catch(() => undefined));
      if (changed()) return finish(discarded);
      const availability = options.quotaExempt ? undoAvailability(current, current === undefined) : askAvailability(current, current === undefined);
      const refused = { ok: false, outcomeUnknown: false } as const;
      if (availability.kind === 'paused') return finish(refused, { kind: 'paused', status: availability.status });
      if (availability.kind === 'sign_in') {
        return finish(refused, availability.reason === 'trial_used' ? { kind: 'trial_used' } : { kind: 'free_paused', loginRequired: availability.reason === 'login_required' });
      }
      if (availability.kind === 'loading') return finish(refused, { kind: 'paused', status: null });

      const session = check.session();
      let needToken = availability.check;
      let visible = false;
      let challengeRetried = false;
      let conflictRetried = false;
      // While the replayed key is unsettled, the earlier send may have counted.
      let uncertainBefore = options.replaying === true;
      const keepUnknown = (n: AiNotice | null): AiNotice | null => {
        if (!n || !uncertainBefore) return n;
        if (n.kind === 'check') return { ...n, unknownBefore: true };
        if (n.kind === 'failure') return { ...n, spent: 'unknown' };
        return n;
      };
      try {
        // At most three sends: the first, one after a refused token, one after a conflict.
        for (let attempt = 0; attempt < 3; attempt++) {
          let token: string | null = null;
          if (needToken) {
            setPhase('checking');
            try {
              token = await session.token({ first: availability.firstCheck && attempt === 0, visible });
            } catch (err) {
              if (changed()) return finish(discarded);
              const reason = err instanceof AiCheckError ? err.reason : 'unavailable';
              // Cancelled: back to where the reader was (an unknown outcome stays said).
              if (reason === 'cancelled') return finish(refused, uncertainBefore ? { kind: 'failure', spent: 'unknown' } : null);
              return finish(refused, keepUnknown({ kind: 'check', reason }));
            }
          }
          // Never send for a visitor who is gone.
          if (changed()) return finish(discarded);
          setPhase('sending');
          try {
            const value = await send(token);
            // An answer for the previous visitor: nothing of it is applied.
            return finish(changed() ? discarded : { ok: true as const, value });
          } catch (err) {
            // Gone meanwhile, or refused before sending because the visitor changed during a wait in `send`.
            if (changed() || err instanceof VisitorChangedError) return finish(discarded);
            const code = err instanceof ApiError ? err.body?.error : undefined;
            if (!challengeRetried && code !== undefined && CHALLENGE.has(code)) {
              // A refused or missing token: one more check, shown in the panel.
              challengeRetried = true;
              needToken = true;
              visible = true;
              continue;
            }
            if (!conflictRetried && code === 'conflict' && options.onConflict) {
              // The replayed attempt never completed: send it once more under a new key,
              // with a new token (tokens are single use).
              conflictRetried = true;
              options.onConflict();
              uncertainBefore = false;
              visible = false;
              continue;
            }
            if (code === 'signed_out') void forgetVisitor(queryClient);
            return finish({ ok: false, outcomeUnknown: outcomeUnknown(err) }, keepUnknown(noticeFor(err)));
          } finally {
            void queryClient.invalidateQueries({ queryKey: ['ai-status'] });
          }
        }
        return finish(refused, keepUnknown({ kind: 'check', reason: 'failed' }));
      } finally {
        // Single use: this request's widget goes, and the next request gets a new one.
        session.release();
      }
    },
    [check, queryClient, status.data],
  );

  return { run, phase, notice, setNotice, status: status.data };
}
