import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { RefinementChange } from '../../../../shared/contracts/briefs';
import { CASES_PARAM } from '../explore/url-state';
import { newIdempotencyKey, useAiRequest } from '../ai/useAiRequest';
import { refineBrief } from './api';

/**
 * A paid step on a brief (UI_DESIGN §4.3 "What costs an AI search on a brief"): free-text
 * refinement, an edited interpretation, changed filters or a picked reading. On success
 * the brief shows its newest step, keeping the compare selection. A retry of the same
 * change on the same brief after an unknown outcome reuses its idempotency key (the server
 * replays it) until a 2xx settles it; a 409 `conflict` to that replay sends it once more
 * under a new key.
 */
export function useRefine(briefId: string) {
  const request = useAiRequest();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run } = request;
  const cases = params.get(CASES_PARAM);
  // Keys of refinements whose outcome is unknown, by brief and change: a key is never
  // reused for another brief or another change.
  const unsettled = useRef(new Map<string, string>());

  const refine = useCallback(
    async (change: RefinementChange): Promise<boolean> => {
      const what = JSON.stringify([briefId, change]);
      const earlier = unsettled.current.get(what);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      const result = await run(
        (turnstileToken) => refineBrief(briefId, { ...change, turnstileToken, idempotencyKey }),
        earlier
          ? {
              replaying: true,
              // A replay answered 409: the earlier attempt never completed, so send it under a new key.
              onConflict: () => {
                unsettled.current.delete(what);
                idempotencyKey = newIdempotencyKey();
              },
            }
          : {},
      );
      if (!result.ok) {
        // Only an unknown outcome is remembered; a refusal leaves an earlier key alone.
        if (result.outcomeUnknown) unsettled.current.set(what, idempotencyKey);
        return false;
      }
      unsettled.current.delete(what);
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
