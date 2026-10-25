import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { BriefFilters } from '../../../../shared/contracts/briefs';
import type { CreateEvidenceRequest } from '../../../../shared/contracts/evidence';
import { forgetUnsettled, rememberUnsettled, settleOnArrival, unsettledId, unsettledKey, type AiRequestShape } from '../ai/unsettled';
import { newIdempotencyKey, useAiRequest } from '../ai/useAiRequest';
import { VisitorChangedError, visitorGeneration } from '../auth/visitor';
import { rememberQuestion } from '../brief/memory';
import { ApiError, isNotFound } from '../../api';
import { CASES_PARAM } from '../explore/url-state';
import { expectArrival } from './arrival';
import { EXPIRED_TITLE, evidencePageKey, evidencePath } from './keys';
import { rememberEdit } from './undo';

type EvidenceShape = Extract<AiRequestShape, { kind: 'evidence' | 'evidence-edited' }>;

/** What an edit changes besides its filters. */
export interface EvidenceEdit {
  /** The reader's words, accepted or typed; without them the search keeps the earlier query. */
  terms?: string | undefined;
  /** Take out the terms AirCase added: keyword search reads the question's own words again. */
  keywords?: 'question' | undefined;
  /**
   * Shown as the search's one free undo (web/src/features/evidence/undo.ts): it is sent while the
   * visitor's own searches are used up, and the created page's `freeUndo` is checked against it.
   */
  free?: boolean | undefined;
}

/**
 * AI evidence searches (UI_DESIGN §4.9): `ask` sends a question (Ask AI on Home, Explore and
 * the expired page), `edit` a search the reader owns with exactly the filters they chose and,
 * only when they accepted or typed them, words, or the question's own keywords when they took out
 * the terms AirCase added (Search again, Apply). Each is one AI search with the usual Turnstile
 * check, status and sign-in handling (useAiRequest), except a search's one free undo, which uses
 * none and is sent while the visitor's own searches are used up (contract `evidence.v3`). Nothing
 * blocks a search (gate answer 2): the answer is always results, which open the search's page with
 * page 1 already in the cache (the POST answers with it).
 *
 * The idempotency key is kept for the tab right before the request leaves (write-ahead,
 * web/src/features/ai/unsettled.ts), so a reload or Back while it is on its way loses nothing,
 * and the same request again replays it until the search's page has taken over; a 409 `conflict`
 * to that replay sends it once more under a new key; a
 * known refusal of a first send takes the key back. A request whose visitor signs out or
 * deletes the account before it ends sends nothing more, keeps nothing (no question, no key)
 * and opens nothing (useAskAi does the same for briefs).
 */
export function useEvidenceSearch() {
  const request = useAiRequest();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { run, setNotice } = request;
  const cases = params.get(CASES_PARAM);

  const send = useCallback(
    async (shape: EvidenceShape, body: (idempotencyKey: string, turnstileToken: string | null) => CreateEvidenceRequest, keepCompare: boolean, free = false): Promise<boolean> => {
      // The visitor this search is for, read before anything asynchronous.
      const visitor = visitorGeneration();
      const gone = (): boolean => visitorGeneration() !== visitor;
      const id = await unsettledId(shape);
      if (gone()) return false;
      const earlier = unsettledKey(id);
      let idempotencyKey = earlier ?? newIdempotencyKey();
      // The key on its way is an earlier send's, whose outcome is unknown: a known refusal of it settles nothing.
      let replayingEarlier = earlier !== null;
      // The search being edited turned out to be gone: its page says so, not a notice.
      let parentGone = false;
      // The server could not finish it (503 `unavailable`): no search was used, and the box says so.
      let unfinished = false;
      const result = await run(
        async (turnstileToken) => {
          // The evidence client and its contracts load with the first AI request, not with the home page.
          const { createEvidence } = await import('./api');
          if (gone()) throw new VisitorChangedError('the visitor changed before this was sent');
          // Write-ahead: kept for the tab before it leaves (createEvidence sends in this same turn).
          rememberUnsettled(id, idempotencyKey);
          return createEvidence(body(idempotencyKey, turnstileToken), visitor).catch((err: unknown) => {
            // The search being edited is gone (expired, or not this visitor's): its page reads it
            // again, finds it gone and says so, instead of a generic failure under it.
            if (shape.kind === 'evidence-edited' && isNotFound(err)) {
              parentGone = true;
              void queryClient.invalidateQueries({ queryKey: ['evidence', shape.from] });
            }
            unfinished = err instanceof ApiError && err.status === 503 && err.body?.error === 'unavailable';
            throw err;
          });
        },
        earlier
          ? {
              visitor,
              quotaExempt: free,
              replaying: true,
              // A replay answered 409: the earlier attempt never completed, so send it under a new key.
              onConflict: () => {
                forgetUnsettled(id, idempotencyKey);
                idempotencyKey = newIdempotencyKey();
                replayingEarlier = false;
              },
            }
          : { visitor, quotaExempt: free },
      );
      if (gone() || (!result.ok && result.discarded)) return false;
      if (!result.ok && parentGone) {
        // A 404 settles the key: nothing was made. Its page is read again and turns to the gone
        // state; until it does (or if a read still answers), the box says so in the same words.
        forgetUnsettled(id, idempotencyKey);
        setNotice({ kind: 'message', text: EXPIRED_TITLE });
        return false;
      }
      if (!result.ok) {
        if (result.outcomeUnknown) rememberUnsettled(id, idempotencyKey);
        else if (!replayingEarlier) forgetUnsettled(id, idempotencyKey);
        if (unfinished && !result.busy) setNotice({ kind: 'unfinished' });
        return false;
      }
      const search = result.value.search;
      queryClient.setQueryData(evidencePageKey(search.id, 1), search);
      rememberQuestion(search.id, search.question);
      // What the edit made, and whether the server took it as the free undo it was shown as.
      if (shape.kind === 'evidence-edited') rememberEdit(shape.from, search, free);
      // Settled once the search's page is on screen; until then a reload or a second ask replays the key.
      settleOnArrival(search.id, 'page', id, idempotencyKey);
      const next = new URLSearchParams();
      if (keepCompare && cases) next.set(CASES_PARAM, cases);
      // Its page announces the results and takes focus if it was lost on the way.
      expectArrival(search.id);
      navigate(`${evidencePath(search.id)}${next.size > 0 ? `?${next.toString()}` : ''}`);
      return true;
    },
    [cases, navigate, queryClient, run],
  );

  const ask = useCallback(
    async (question: string): Promise<boolean> => {
      const q = question.trim();
      if (!q) {
        setNotice({ kind: 'empty' });
        return false;
      }
      return send({ kind: 'evidence', question: q }, (idempotencyKey, turnstileToken) => ({ kind: 'question', question: q, idempotencyKey, turnstileToken }), false);
    },
    [send, setNotice],
  );

  /**
   * An `edited` search of `from` (which the reader owns): exactly `filters`, and `terms` only when
   * the reader accepted or typed them, or `keywords: 'question'` when they took out the terms
   * AirCase added (never both: words of their own replace the question anyway); without either,
   * it keeps `from`'s query (its question and keywords, or its words).
   */
  const edit = useCallback(
    async (from: string, filters: BriefFilters, change: EvidenceEdit = {}): Promise<boolean> => {
      const words = change.terms?.trim() || undefined;
      const keywords = words === undefined ? change.keywords : undefined;
      return send(
        { kind: 'evidence-edited', from, filters, terms: words, keywords },
        (idempotencyKey, turnstileToken) => ({
          kind: 'edited',
          from,
          filters,
          ...(words !== undefined ? { terms: words } : {}),
          ...(keywords !== undefined ? { keywords } : {}),
          idempotencyKey,
          turnstileToken,
        }),
        true,
        change.free === true,
      );
    },
    [send],
  );

  return { ...request, ask, edit };
}
