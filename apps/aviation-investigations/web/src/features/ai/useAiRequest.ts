import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatusResponse } from '../../../../shared/contracts/ai';
import { ApiError, aiStatusQuery } from '../../api';
import { askAvailability } from './status';
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
  | { kind: 'rate'; seconds: number }
  | { kind: 'failure'; spent: SpentKnowledge }
  | { kind: 'check'; reason: Exclude<AiCheckFailure, 'cancelled'> }
  | { kind: 'empty' }
  | { kind: 'message'; text: string };

export type AiPhase = 'idle' | 'checking' | 'sending';

/** The outcome of one `run`: the response, or nothing with whether the server may have acted. */
export type RunResult<T> = { ok: true; value: T } | { ok: false; outcomeUnknown: boolean };

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
    case 'rate_limited':
      return { kind: 'rate', seconds: err.retryAfter ?? 30 };
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
 * gets a fresh Turnstile token for anonymous visitors (the first-check panel once per
 * trial identity, otherwise invisibly with "Checking…"; a second control waits its turn),
 * sends, and on a refused token takes one more, visible check. Each request releases its
 * check session at the end, refusals included, and the AI status is re-read so the
 * counters stay true.
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
    async <T>(send: (turnstileToken: string | null) => Promise<T>): Promise<RunResult<T>> => {
      if (running.current) return { ok: false, outcomeUnknown: false };
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
      const current = status.data ?? (await queryClient.fetchQuery(aiStatusQuery()).catch(() => undefined));
      const availability = askAvailability(current, current === undefined);
      const refused = { ok: false, outcomeUnknown: false } as const;
      if (availability.kind === 'paused') return finish(refused, { kind: 'paused', status: availability.status });
      if (availability.kind === 'sign_in') {
        return finish(refused, availability.reason === 'trial_used' ? { kind: 'trial_used' } : { kind: 'free_paused', loginRequired: availability.reason === 'login_required' });
      }
      if (availability.kind === 'loading') return finish(refused, { kind: 'paused', status: null });

      const session = check.session();
      let needToken = availability.anonymous;
      let visible = false;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          let token: string | null = null;
          if (needToken) {
            setPhase('checking');
            try {
              token = await session.token({ first: availability.firstCheck && attempt === 0, visible });
            } catch (err) {
              const reason = err instanceof AiCheckError ? err.reason : 'unavailable';
              return finish(refused, reason === 'cancelled' ? null : { kind: 'check', reason });
            }
          }
          setPhase('sending');
          try {
            return finish({ ok: true, value: await send(token) });
          } catch (err) {
            if (attempt === 0 && err instanceof ApiError && err.body && CHALLENGE.has(err.body.error)) {
              // A refused or missing token: one more check, shown in the panel.
              needToken = true;
              visible = true;
              continue;
            }
            return finish({ ok: false, outcomeUnknown: outcomeUnknown(err) }, noticeFor(err));
          } finally {
            void queryClient.invalidateQueries({ queryKey: ['ai-status'] });
          }
        }
        return finish(refused, { kind: 'check', reason: 'failed' });
      } finally {
        // Single use: this request's widget goes, and the next request gets a new one.
        session.release();
      }
    },
    [check, queryClient, status.data],
  );

  return { run, phase, notice, setNotice, status: status.data };
}
