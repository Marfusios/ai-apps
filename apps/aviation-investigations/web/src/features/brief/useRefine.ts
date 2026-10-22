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
 * change after an unknown outcome reuses its idempotency key (the server replays it); a
 * 409 `conflict` to that replay sends it once more under a new key.
 */
export function useRefine(briefId: string) {
  const request = useAiRequest();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run } = request;
  const cases = params.get(CASES_PARAM);
  const unsettled = useRef<{ change: string; key: string } | null>(null);

  const refine = useCallback(
    async (change: RefinementChange): Promise<boolean> => {
      const changeKey = JSON.stringify(change);
      const earlier = unsettled.current;
      const replaying = earlier !== null && earlier.change === changeKey;
      let idempotencyKey = replaying ? earlier.key : newIdempotencyKey();
      const result = await run(
        (turnstileToken) => refineBrief(briefId, { ...change, turnstileToken, idempotencyKey }),
        // A replay answered 409: the earlier attempt never completed, so send it under a new key.
        replaying ? { onConflict: () => (idempotencyKey = newIdempotencyKey()) } : {},
      );
      if (!result.ok) {
        if (!result.busy) unsettled.current = result.outcomeUnknown ? { change: changeKey, key: idempotencyKey } : null;
        return false;
      }
      unsettled.current = null;
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
