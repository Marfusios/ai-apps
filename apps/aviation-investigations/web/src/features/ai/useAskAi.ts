import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { BriefFilters } from '../../../../shared/contracts/briefs';
import { rememberQuestion } from '../brief/memory';
import { newIdempotencyKey, useAiRequest } from './useAiRequest';

/**
 * Ask AI from a question box: starts a brief and opens `/briefs/:id` (UI_DESIGN §4.3).
 * When a request got no answer (its outcome is unknown), asking the same question with
 * the same filters again reuses its idempotency key, so a request the server already
 * admitted is replayed instead of paid for twice; if that replay answers 409 `conflict`
 * (the earlier attempt did not complete), it is sent once more under a new key. The key
 * is kept until a 2xx or that 409 settles it: a refusal before sending (a failed or
 * cancelled check, a paused or used-up status) or a known refusal of the replay says
 * nothing about the earlier send. A first send refused with a known outcome (a 4xx, or a
 * 503 `unavailable` or `ai_paused`, which release the admission) spent nothing and is
 * not remembered, so the next ask uses a new key.
 */
export function useAskAi() {
  const request = useAiRequest();
  const navigate = useNavigate();
  const { run, setNotice } = request;
  // Keys of requests whose outcome is unknown, by what they asked (question and filters).
  const unsettled = useRef(new Map<string, string>());

  const ask = useCallback(
    async (question: string, filters?: BriefFilters): Promise<void> => {
      const q = question.trim();
      if (!q) {
        setNotice({ kind: 'empty' });
        return;
      }
      const what = JSON.stringify([q, filters ?? null]);
      const earlier = unsettled.current.get(what);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      const result = await run(
        async (turnstileToken) => {
          // The brief client and its contracts load with the first AI request, not with the home page.
          const { createBrief } = await import('../brief/api');
          return createBrief({ question: q, ...(filters ? { filters } : {}), turnstileToken, idempotencyKey });
        },
        earlier
          ? {
              replaying: true,
              // A replay answered 409: the earlier attempt never completed, so ask under a new key.
              onConflict: () => {
                unsettled.current.delete(what);
                idempotencyKey = newIdempotencyKey();
              },
            }
          : {},
      );
      if (!result.ok) {
        // Only an unknown outcome is remembered. Nothing sent, or a known refusal, settles
        // nothing about an earlier send: its key stays for the next ask.
        if (result.outcomeUnknown) unsettled.current.set(what, idempotencyKey);
        return;
      }
      unsettled.current.delete(what);
      rememberQuestion(result.value.briefId, q, filters);
      navigate(`/briefs/${result.value.briefId}`);
    },
    [navigate, run, setNotice],
  );

  return { ...request, ask };
}
