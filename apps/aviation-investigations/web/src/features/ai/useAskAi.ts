import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import type { BriefFilters } from '../../../../shared/contracts/briefs';
import { rememberQuestion } from '../brief/memory';
import { newIdempotencyKey, useAiRequest } from './useAiRequest';

/** Ask AI from a question box: starts a brief and opens `/briefs/:id` (UI_DESIGN §4.3). */
export function useAskAi() {
  const request = useAiRequest();
  const navigate = useNavigate();
  const { run, setNotice } = request;

  const ask = useCallback(
    async (question: string, filters?: BriefFilters): Promise<void> => {
      const q = question.trim();
      if (!q) {
        setNotice({ kind: 'empty' });
        return;
      }
      const idempotencyKey = newIdempotencyKey();
      const started = await run(async (turnstileToken) => {
        // The brief client and its contracts load with the first AI request, not with the home page.
        const { createBrief } = await import('../brief/api');
        return createBrief({ question: q, ...(filters ? { filters } : {}), turnstileToken, idempotencyKey });
      });
      if (!started) return;
      rememberQuestion(started.briefId, q);
      navigate(`/briefs/${started.briefId}`);
    },
    [navigate, run, setNotice],
  );

  return { ...request, ask };
}
