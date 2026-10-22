import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { RefinementChange } from '../../../../shared/contracts/briefs';
import { CASES_PARAM } from '../explore/url-state';
import { forgetUnsettled, rememberUnsettled, unsettledId, unsettledKey } from '../ai/unsettled';
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
  const refine = useCallback(
    async (change: RefinementChange): Promise<boolean> => {
      // Refinements with an unknown outcome are remembered for the tab, by brief and change,
      // so a key is never reused for another brief or another change.
      const id = await unsettledId({ kind: 'refine', briefId, change });
      const earlier = unsettledKey(id);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      const result = await run(
        (turnstileToken) => refineBrief(briefId, { ...change, turnstileToken, idempotencyKey }),
        earlier
          ? {
              replaying: true,
              // A replay answered 409: the earlier attempt never completed, so send it under a new key.
              onConflict: () => {
                forgetUnsettled(id);
                idempotencyKey = newIdempotencyKey();
              },
            }
          : {},
      );
      if (!result.ok) {
        // Only an unknown outcome is remembered; a refusal leaves an earlier key alone.
        if (result.outcomeUnknown) rememberUnsettled(id, idempotencyKey);
        return false;
      }
      forgetUnsettled(id);
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
