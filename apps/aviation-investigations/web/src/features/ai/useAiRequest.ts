import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatusResponse } from '../../../../shared/contracts/ai';
import { ApiError, aiStatusQuery } from '../../api';
import { askAvailability } from './status';
import { AiCheckError, useAiCheck, type AiCheckFailure } from './TurnstileGate';

/** What the AI controls say after a request did not start (UI_DESIGN §5 messages). */
export type AiNotice =
  | { kind: 'paused'; status: Extract<AiStatusResponse, { state: 'paused' }> | null }
  | { kind: 'trial_used' }
  | { kind: 'free_paused'; loginRequired: boolean }
  | { kind: 'rate'; seconds: number }
  | { kind: 'failure'; spent: boolean }
  | { kind: 'check'; reason: Exclude<AiCheckFailure, 'cancelled'> }
  | { kind: 'empty' }
  | { kind: 'message'; text: string };

export type AiPhase = 'idle' | 'checking' | 'sending';

/** A fresh idempotency key for one logical AI request (kept across its retries). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const CHALLENGE = new Set(['challenge_required', 'challenge_failed']);

function noticeFor(err: unknown, status: AiStatusResponse | undefined): AiNotice {
  if (!(err instanceof ApiError) || !err.body) return { kind: 'failure', spent: false };
  const { error, message, retryAfter } = err.body;
  switch (error) {
    case 'ai_paused':
      return { kind: 'paused', status: status?.state === 'paused' ? status : null };
    case 'quota_exhausted':
      return { kind: 'paused', status: status?.state === 'paused' ? status : null };
    case 'trial_used':
      return { kind: 'trial_used' };
    case 'free_searches_paused':
      return { kind: 'free_paused', loginRequired: false };
    case 'sign_in_required':
      return { kind: 'free_paused', loginRequired: true };
    case 'rate_limited':
      return { kind: 'rate', seconds: retryAfter ?? 30 };
    case 'challenge_required':
    case 'challenge_failed':
      return { kind: 'check', reason: 'failed' };
    case 'in_flight':
    case 'conflict':
    case 'refinement_limit':
    case 'bad_request':
      return { kind: 'message', text: message };
    default:
      return { kind: 'failure', spent: false };
  }
}

/**
 * Runs one paid AI request (Ask AI, Refine, a reading, Re-run): checks the AI status,
 * gets a fresh Turnstile token for anonymous visitors (the first-check panel once per
 * trial identity, otherwise invisibly with "Checking…"), sends, and on a refused token
 * takes one more, visible check. The widget is reset after every request, refusals
 * included, and the AI status is re-read so the counters stay true.
 */
export function useAiRequest() {
  const check = useAiCheck();
  const queryClient = useQueryClient();
  const status = useQuery(aiStatusQuery());
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [notice, setNotice] = useState<AiNotice | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = useCallback(
    async <T>(send: (turnstileToken: string | null) => Promise<T>): Promise<T | null> => {
      if (running.current) return null;
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
      if (availability.kind === 'paused') return finish(null, { kind: 'paused', status: availability.status });
      if (availability.kind === 'sign_in') {
        return finish(null, availability.reason === 'trial_used' ? { kind: 'trial_used' } : { kind: 'free_paused', loginRequired: availability.reason === 'login_required' });
      }
      if (availability.kind === 'loading') return finish(null, { kind: 'failure', spent: false });

      let needToken = availability.anonymous;
      let visible = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let token: string | null = null;
        if (needToken) {
          setPhase('checking');
          try {
            token = await check.token({ first: availability.firstCheck && attempt === 0, visible });
          } catch (err) {
            check.reset();
            const reason = err instanceof AiCheckError ? err.reason : 'unavailable';
            return finish(null, reason === 'cancelled' ? null : { kind: 'check', reason });
          }
        }
        setPhase('sending');
        try {
          return finish(await send(token));
        } catch (err) {
          if (attempt === 0 && err instanceof ApiError && err.body && CHALLENGE.has(err.body.error)) {
            // A refused or missing token: one more check, shown in the panel.
            needToken = true;
            visible = true;
            continue;
          }
          return finish(null, noticeFor(err, current));
        } finally {
          // Tokens are single use: a new widget for every request, refusals included.
          check.reset();
          void queryClient.invalidateQueries({ queryKey: ['ai-status'] });
        }
      }
      return finish(null, { kind: 'check', reason: 'failed' });
    },
    [check, queryClient, status.data],
  );

  return { run, phase, notice, setNotice, status: status.data };
}
