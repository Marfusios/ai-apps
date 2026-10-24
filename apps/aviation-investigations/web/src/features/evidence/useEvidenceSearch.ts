import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { BriefFilters, ScopeReply } from '../../../../shared/contracts/briefs';
import type { CreateEvidenceRequest } from '../../../../shared/contracts/evidence';
import { forgetUnsettled, rememberUnsettled, settleOnArrival, unsettledId, unsettledKey, type AiRequestShape } from '../ai/unsettled';
import { newIdempotencyKey, useAiRequest } from '../ai/useAiRequest';
import { VisitorChangedError, visitorGeneration } from '../auth/visitor';
import { rememberQuestion } from '../brief/memory';
import { CASES_PARAM } from '../explore/url-state';
import { evidencePageKey, evidencePath } from './keys';

/** A static scope reply (never a clarification round, contract `evidence.v1`), with the question it answers. */
export interface ShownScopeReply {
  question: string;
  reply: Exclude<ScopeReply, { kind: 'needs_clarification' }>;
}

type EvidenceShape = Extract<AiRequestShape, { kind: 'evidence' | 'evidence-edited' }>;

/**
 * AI evidence searches (UI_DESIGN §4.9): `ask` sends a question (Ask AI on Home, Explore and
 * the expired page), `edit` the changed words and filters of a search the reader owns (Search
 * again). Both are one AI search with the usual Turnstile check, status and sign-in handling
 * (useAiRequest). Results open the search's page, with page 1 already in the cache (the POST
 * answers with it); a static scope reply (out of scope, operational, counting, comparison) has
 * no page and shows where the question was asked (`reply`); it uses no search.
 *
 * The idempotency key is kept for the tab right before the request leaves (write-ahead,
 * web/src/features/ai/unsettled.ts), so a reload or Back while it is on its way loses nothing,
 * and the same request again replays it until the search's page has taken over (a scope reply
 * settles it at once); a 409 `conflict` to that replay sends it once more under a new key; a
 * known refusal of a first send takes the key back. A request whose visitor signs out or
 * deletes the account before it ends sends nothing more, keeps nothing (no question, no key)
 * and opens nothing (useAskAi does the same for briefs).
 */
export function useEvidenceSearch() {
  const request = useAiRequest();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [reply, setReply] = useState<ShownScopeReply | null>(null);
  const { run, setNotice } = request;
  const cases = params.get(CASES_PARAM);

  const send = useCallback(
    async (shape: EvidenceShape, body: (idempotencyKey: string, turnstileToken: string | null) => CreateEvidenceRequest, question: string, keepCompare: boolean): Promise<boolean> => {
      // The visitor this search is for, read before anything asynchronous.
      const visitor = visitorGeneration();
      const gone = (): boolean => visitorGeneration() !== visitor;
      const id = await unsettledId(shape);
      if (gone()) return false;
      const earlier = unsettledKey(id);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      // The key on its way is an earlier send's, whose outcome is unknown: a known refusal of it settles nothing.
      let replayingEarlier = earlier !== null;
      const result = await run(
        async (turnstileToken) => {
          // The evidence client and its contracts load with the first AI request, not with the home page.
          const { createEvidence } = await import('./api');
          if (gone()) throw new VisitorChangedError('the visitor changed before this was sent');
          // Write-ahead: kept for the tab before it leaves (createEvidence sends in this same turn).
          rememberUnsettled(id, idempotencyKey);
          return createEvidence(body(idempotencyKey, turnstileToken), visitor);
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
      if (gone() || (!result.ok && result.discarded)) return false;
      if (!result.ok) {
        if (result.outcomeUnknown) rememberUnsettled(id, idempotencyKey);
        else if (!replayingEarlier) forgetUnsettled(id, idempotencyKey);
        return false;
      }
      const answer = result.value;
      if (answer.kind === 'scope_reply') {
        // Nothing was searched, and there is no page to arrive at: settled now.
        forgetUnsettled(id, idempotencyKey);
        setReply({ question, reply: answer.reply });
        return true;
      }
      const search = answer.search;
      queryClient.setQueryData(evidencePageKey(search.id, 1), search);
      rememberQuestion(search.id, search.question);
      // Settled once the search's page is on screen; until then a reload or a second ask replays the key.
      settleOnArrival(search.id, 'page', id, idempotencyKey);
      const next = new URLSearchParams();
      if (keepCompare && cases) next.set(CASES_PARAM, cases);
      navigate(`${evidencePath(search.id)}${next.size > 0 ? `?${next.toString()}` : ''}`);
      return true;
    },
    [cases, navigate, queryClient, run],
  );

  const ask = useCallback(
    async (question: string): Promise<boolean> => {
      const q = question.trim();
      setReply(null);
      if (!q) {
        setNotice({ kind: 'empty' });
        return false;
      }
      return send({ kind: 'evidence', question: q }, (idempotencyKey, turnstileToken) => ({ kind: 'question', question: q, idempotencyKey, turnstileToken }), q, false);
    },
    [send, setNotice],
  );

  /** Search again with changed words and filters (an `edited` search of `from`, which the reader owns). */
  const edit = useCallback(
    async (from: string, question: string, filters: BriefFilters, terms: string): Promise<boolean> => {
      setReply(null);
      const words = terms.trim();
      return send(
        { kind: 'evidence-edited', from, filters, terms: words },
        (idempotencyKey, turnstileToken) => ({ kind: 'edited', from, filters, terms: words, idempotencyKey, turnstileToken }),
        question,
        true,
      );
    },
    [send],
  );

  return { ...request, ask, edit, reply };
}
