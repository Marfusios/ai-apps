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
 * (the earlier attempt did not complete), it is sent once more under a new key. A known
 * refusal (a 4xx, or a 503 `unavailable` or `ai_paused`, which release the admission)
 * spent nothing, and the next ask uses a new key.
 */
export function useAskAi() {
  const request = useAiRequest();
  const navigate = useNavigate();
  const { run, setNotice } = request;
  const unsettled = useRef<{ question: string; filters: string; key: string } | null>(null);

  const ask = useCallback(
    async (question: string, filters?: BriefFilters): Promise<void> => {
      const q = question.trim();
      if (!q) {
        setNotice({ kind: 'empty' });
        return;
      }
      const filtersKey = JSON.stringify(filters ?? null);
      const earlier = unsettled.current;
      const replaying = earlier !== null && earlier.question === q && earlier.filters === filtersKey;
      let idempotencyKey = replaying ? earlier.key : newIdempotencyKey();
      const result = await run(
        async (turnstileToken) => {
          // The brief client and its contracts load with the first AI request, not with the home page.
          const { createBrief } = await import('../brief/api');
          return createBrief({ question: q, ...(filters ? { filters } : {}), turnstileToken, idempotencyKey });
        },
        // A replay answered 409: the earlier attempt never completed, so ask under a new key.
        replaying ? { onConflict: () => (idempotencyKey = newIdempotencyKey()) } : {},
      );
      if (!result.ok) {
        if (result.busy) return;
        unsettled.current = result.outcomeUnknown ? { question: q, filters: filtersKey, key: idempotencyKey } : null;
        return;
      }
      unsettled.current = null;
      rememberQuestion(result.value.briefId, q, filters);
      navigate(`/briefs/${result.value.briefId}`);
    },
    [navigate, run, setNotice],
  );

  return { ...request, ask };
}
