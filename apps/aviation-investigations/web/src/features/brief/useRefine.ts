import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { RefinementChange } from '../../../../shared/contracts/briefs';
import { refineBrief } from './api';
import { CASES_PARAM } from '../explore/url-state';
import { newIdempotencyKey, useAiRequest } from '../ai/useAiRequest';

/**
 * A paid step on a brief (UI_DESIGN §4.3 "What costs an AI search on a brief"): free-text
 * refinement, an edited interpretation, changed filters or a picked reading. On success
 * the brief shows its newest step, keeping the compare selection.
 */
export function useRefine(briefId: string) {
  const request = useAiRequest();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run } = request;
  const cases = params.get(CASES_PARAM);

  const refine = useCallback(
    async (change: RefinementChange): Promise<boolean> => {
      const idempotencyKey = newIdempotencyKey();
      const started = await run((turnstileToken) => refineBrief(briefId, { ...change, turnstileToken, idempotencyKey }));
      if (!started) return false;
      await queryClient.invalidateQueries({ queryKey: ['brief', briefId] });
      const next = new URLSearchParams();
      if (cases) next.set(CASES_PARAM, cases);
      navigate(`/briefs/${briefId}${next.size > 0 ? `?${next.toString()}` : ''}`);
      return true;
    },
    [briefId, cases, navigate, queryClient, run],
  );

  return { ...request, refine };
}
