import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { RefinementChange } from '../../../../shared/contracts/briefs';
import { CASES_PARAM } from '../explore/url-state';
import { forgetUnsettled, rememberUnsettled, unsettledId, unsettledKey } from '../ai/unsettled';
import { newIdempotencyKey, useAiRequest } from '../ai/useAiRequest';
import { VisitorChangedError, visitorGeneration } from '../auth/visitor';
import { refineBrief } from './api';

/**
 * A paid step on a brief (UI_DESIGN §4.3 "What costs an AI search on a brief"): free-text
 * refinement, an edited interpretation, changed filters or a picked reading. On success
 * the brief shows its newest step, keeping the compare selection. The idempotency key is
 * kept for the tab right before the request leaves (write-ahead, web/src/features/ai/
 * unsettled.ts), so a reload while it is on its way loses nothing. A retry of the same
 * change on the same brief while its outcome is unknown reuses that key (the server replays
 * it) until a 2xx settles it; a 409 `conflict` to that replay sends it once more under a new
 * key; a known refusal of a first send takes the key back. A refinement whose visitor signs
 * out or deletes the account before it ends sends nothing more (refineBrief checks the
 * visitor right before it sends), keeps nothing (no retry key) and moves nowhere.
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
      // The visitor this refinement is for, read before anything asynchronous.
      const visitor = visitorGeneration();
      const gone = (): boolean => visitorGeneration() !== visitor;
      // Refinements with an unknown outcome are remembered for the tab, by brief and change,
      // so a key is never reused for another brief or another change.
      const id = await unsettledId({ kind: 'refine', briefId, change });
      if (gone()) return false;
      const earlier = unsettledKey(id);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      // The key on its way is an earlier send's, whose outcome is unknown: a known refusal of it settles nothing.
      let replayingEarlier = earlier !== null;
      const result = await run(
        async (turnstileToken) => {
          if (gone()) throw new VisitorChangedError('the visitor changed before this was sent');
          // Write-ahead: kept for the tab before it leaves (refineBrief sends in this same turn).
          rememberUnsettled(id, idempotencyKey);
          return refineBrief(briefId, { ...change, turnstileToken, idempotencyKey }, visitor);
        },
        earlier
          ? {
              visitor,
              replaying: true,
              // A replay answered 409: the earlier attempt never completed, so send it under a new key.
              onConflict: () => {
                forgetUnsettled(id, idempotencyKey);
                idempotencyKey = newIdempotencyKey();
                replayingEarlier = false;
              },
            }
          : { visitor },
      );
      // The visitor changed meanwhile: nothing of this refinement is kept.
      if (gone() || (!result.ok && result.discarded)) return false;
      if (!result.ok) {
        // An unknown outcome keeps the key; a refusal of a replay, or nothing sent, leaves an
        // earlier key alone; a known refusal of a first send admitted nothing: its key goes.
        if (result.outcomeUnknown) rememberUnsettled(id, idempotencyKey);
        else if (!replayingEarlier) forgetUnsettled(id, idempotencyKey);
        return false;
      }
      await queryClient.invalidateQueries({ queryKey: ['brief', briefId] });
      // The visitor changed while the brief was read again: the page goes nowhere for them
      // (and forgetting them cleared the tab's keys).
      if (gone()) return false;
      const next = new URLSearchParams();
      if (cases) next.set(CASES_PARAM, cases);
      navigate(`/briefs/${briefId}${next.size > 0 ? `?${next.toString()}` : ''}`);
      // Settled once the page shows the new step: until then a reload still replays it.
      forgetUnsettled(id, idempotencyKey);
      return true;
    },
    [briefId, cases, navigate, queryClient, run],
  );

  return { ...request, refine };
}
