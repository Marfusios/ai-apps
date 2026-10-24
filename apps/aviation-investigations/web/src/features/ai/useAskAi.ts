import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import type { BriefFilters } from '../../../../shared/contracts/briefs';
import { VisitorChangedError, visitorGeneration } from '../auth/visitor';
import { rememberQuestion } from '../brief/memory';
import { forgetUnsettled, rememberUnsettled, unsettledId, unsettledKey } from './unsettled';
import { newIdempotencyKey, useAiRequest } from './useAiRequest';

/**
 * Ask AI from a question box: starts a brief and opens `/briefs/:id` (UI_DESIGN §4.3).
 * The request's idempotency key is kept for the tab (web/src/features/ai/unsettled.ts)
 * right before the request leaves (write-ahead), so a reload or Back while it is on its way
 * loses nothing (closing the tab does: the key is in the tab's session storage). Asking the
 * same question with the same filters again while its outcome is unknown, from this or any
 * other control in the tab, reuses that key, so a request the server already admitted is
 * replayed instead of paid for twice; if that replay answers 409 `conflict` (the earlier
 * attempt did not complete), it is sent once more under a new key. The key is kept until a
 * 2xx or that 409 settles it: a refusal before sending (a failed or cancelled check, a
 * paused or used-up status) or a known refusal of the replay says nothing about the earlier
 * send. A first send refused with a known outcome (a 4xx, or a 503 `unavailable` or
 * `ai_paused`, which release the admission) spent nothing: its key is taken back, so the
 * next ask uses a new one.
 *
 * An ask belongs to the visitor it started under: if that visitor signs out or deletes the
 * account (here or in another tab) before it ends, nothing more of it is sent (the check
 * runs right before each send, after every wait, the brief client's first load included),
 * nothing of it is kept (no question in memory, no retry key) and the page does not open
 * its brief.
 */
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
      // The visitor this ask is for, read before anything asynchronous.
      const visitor = visitorGeneration();
      const gone = (): boolean => visitorGeneration() !== visitor;
      // Requests with an unknown outcome are remembered for the tab, whichever control sent them.
      const id = await unsettledId({ kind: 'create', question: q, filters });
      if (gone()) return;
      const earlier = unsettledKey(id);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      // The key on its way is an earlier send's, whose outcome is unknown: a known refusal of it settles nothing.
      let replayingEarlier = earlier !== null;
      const result = await run(
        async (turnstileToken) => {
          // The brief client and its contracts load with the first AI request, not with the home
          // page. However long that takes, createBrief checks the visitor again right before it
          // sends: a visitor gone meanwhile sends nothing.
          const { createBrief } = await import('../brief/api');
          if (gone()) throw new VisitorChangedError('the visitor changed before this was sent');
          // Write-ahead: kept for the tab before it leaves (createBrief sends in this same turn).
          rememberUnsettled(id, idempotencyKey);
          return createBrief({ question: q, ...(filters ? { filters } : {}), turnstileToken, idempotencyKey }, visitor);
        },
        earlier
          ? {
              visitor,
              replaying: true,
              // A replay answered 409: the earlier attempt never completed, so ask under a new key.
              onConflict: () => {
                forgetUnsettled(id, idempotencyKey);
                idempotencyKey = newIdempotencyKey();
                replayingEarlier = false;
              },
            }
          : { visitor },
      );
      // The visitor changed meanwhile: nothing of this ask is kept (forgetting the visitor
      // cleared the tab's keys), and its brief is not opened.
      if (gone() || (!result.ok && result.discarded)) return;
      if (!result.ok) {
        // An unknown outcome keeps the key. A known refusal of an earlier send's replay, or
        // nothing sent, settles nothing about that send: its key stays for the next ask. A
        // known refusal of this key's first send admitted nothing: the key is taken back.
        if (result.outcomeUnknown) rememberUnsettled(id, idempotencyKey);
        else if (!replayingEarlier) forgetUnsettled(id, idempotencyKey);
        return;
      }
      rememberQuestion(result.value.briefId, q, filters);
      navigate(`/briefs/${result.value.briefId}`);
      forgetUnsettled(id, idempotencyKey);
    },
    [navigate, run, setNotice],
  );

  return { ...request, ask };
}
