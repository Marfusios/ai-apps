import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { BriefFilters } from '../../../../shared/contracts/briefs';
import type { CreateEvidenceRequest, EvidencePage } from '../../../../shared/contracts/evidence';
import { forgetUnsettled, rememberUnsettled, settleOnArrival, unsettledId, unsettledKey, type AiRequestShape } from '../ai/unsettled';
import { newIdempotencyKey, useAiRequest, type AiPhase } from '../ai/useAiRequest';
import { VisitorChangedError, onVisitorChange, visitorGeneration } from '../auth/visitor';
import { rememberQuestion } from '../brief/memory';
import { ApiError, isNotFound } from '../../api';
import { CASES_PARAM } from '../explore/url-state';
import { expectArrival } from './arrival';
import { EXPIRED_TITLE, evidencePageKey, evidencePath } from './keys';
import { preloadSearchChecklist, useSearchChecklistReady } from './SearchWait';
import { UNDO_USED_NOTICE, rememberCharged } from './undo';

type EvidenceShape = Extract<AiRequestShape, { kind: 'evidence' | 'evidence-edited' }>;

/**
 * An AI search on its way (`POST /api/evidence` sent, no answer yet): what its checklist reads
 * (UI_DESIGN §4.10). Each send has its own: a send again under a new key (after a 409) is another.
 */
export interface PendingSearch {
  /** The request's idempotency key: its progress is read under it. */
  key: string;
  /** A question search, or an edit (which reads no question). */
  kind: 'question' | 'edited';
  /** When it left, in milliseconds since the epoch (the checklist's timer). */
  startedAt: number;
  /** The visitor generation it was sent under: its progress is read for that visitor only. */
  visitor: number;
}

/** What an edit changes besides its filters. */
export interface EvidenceEdit {
  /** The reader's words, accepted or typed; without them the search keeps the earlier query. */
  terms?: string | undefined;
  /** Take out the terms AirCase added: keyword search reads the question's own words again. */
  keywords?: 'question' | undefined;
  /**
   * Shown as the search's one free undo (its page says `undo: 'available'`,
   * web/src/features/evidence/undo.ts): it is sent while the visitor's own searches are used up,
   * and the created page's `freeUndo` is checked against it.
   */
  free?: boolean | undefined;
}

/**
 * AI evidence searches (UI_DESIGN §4.9): `ask` sends a question (Ask AI on Home, Explore and
 * the expired page), `edit` a search the reader owns with exactly the filters they chose and,
 * only when they accepted or typed them, words, or the question's own keywords when they took out
 * the terms AirCase added (Search again, Apply). Each is one AI search with the usual Turnstile
 * check, status and sign-in handling (useAiRequest), except a search's one free undo, which uses
 * none and is sent while the visitor's own searches are used up (contract `evidence.v3`): its
 * search's undo hint is read again right before it is sent, and nothing is sent when it says the
 * undo is used; after a free attempt that failed it is read again too. Nothing
 * blocks a search (gate answer 2): the answer is always results, which open the search's page with
 * page 1 already in the cache (the POST answers with it).
 *
 * While a search's POST runs, `pending` names it (its key, its kind, when it left and for which
 * visitor), its checklist reads its progress under that key (web/src/features/evidence/SearchWait.tsx,
 * UI_DESIGN §4.10) and, once the checklist has loaded, `phase` is `searching` (the control says
 * "Searching…"); a request refused before it leaves, or a Turnstile check, shows none. The
 * checklist goes when the POST settles, when the send ends however it ends, and as soon as the
 * visitor changes (sign-out, deletion, another account): nothing more is read for the previous
 * visitor's search.
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
  // Reading a search's undo hint again before a request shown as free is sent ("Checking…").
  const [verifying, setVerifying] = useState(false);
  // A page on screen whose undo hint is known to be out of date (a free attempt of it failed, or the
  // read right before one found it used): its undo is not offered until a newer read of it is there.
  // The cache has that read (or a mark) already, but its readers learn of it a moment later.
  const [staleHint, setStaleHint] = useState<EvidencePage | null>(null);
  // The search on its way, while its POST runs (the checklist shows it).
  const [pending, setPending] = useState<PendingSearch | null>(null);
  const checklistReady = useSearchChecklistReady();
  // The visitor changed: the previous visitor's search shows no checklist, which reads nothing more.
  useEffect(() => onVisitorChange(() => setPending(null)), []);

  const send = useCallback(
    async (shape: EvidenceShape, body: (idempotencyKey: string, turnstileToken: string | null) => CreateEvidenceRequest, keepCompare: boolean, free = false): Promise<boolean> => {
      // The evidence client (with its contracts) and the checklist start loading now, with the first
      // AI request rather than the home page, and before the Turnstile check, so that both are there
      // when the request leaves. The client is awaited, and the visitor checked again, before anything
      // is sent; a request refused before then leaves the load to finish unused.
      const client = import('./api');
      client.catch(() => undefined);
      preloadSearchChecklist();
      // The visitor this search is for, read before anything asynchronous.
      const visitor = visitorGeneration();
      const gone = (): boolean => visitorGeneration() !== visitor;
      // The checklists this send shows (a send again under a new key shows another): each goes when
      // its POST settles, and any still shown when the send ends, however it ends.
      const shown: PendingSearch[] = [];
      const hide = (one: PendingSearch): void => setPending((current) => (current === one ? null : current));
      try {
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
            const { createEvidence } = await client;
            if (gone()) throw new VisitorChangedError('the visitor changed before this was sent');
            // Write-ahead: kept for the tab before it leaves (createEvidence sends in this same turn).
            rememberUnsettled(id, idempotencyKey);
            // Its checklist shows while it runs, read under this key for this visitor.
            const mine: PendingSearch = { key: idempotencyKey, kind: shape.kind === 'evidence' ? 'question' : 'edited', startedAt: Date.now(), visitor };
            shown.push(mine);
            setPending(mine);
            return createEvidence(body(idempotencyKey, turnstileToken), visitor)
              .catch((err: unknown) => {
                // The search being edited is gone (expired, or not this visitor's): its page reads it
                // again, finds it gone and says so, instead of a generic failure under it.
                if (shape.kind === 'evidence-edited' && isNotFound(err)) {
                  parentGone = true;
                  void queryClient.invalidateQueries({ queryKey: ['evidence', shape.from] });
                }
                unfinished = err instanceof ApiError && err.status === 503 && err.body?.error === 'unavailable';
                throw err;
              })
              .finally(() => hide(mine));
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
          // A free undo that failed may have used the search's one claim (the server keeps it once
          // admission took it): its cached pages stop offering it at once, and they are read again,
          // so it is offered free again only when a read says it is still there.
          if (free && shape.kind === 'evidence-edited' && !result.busy) {
            setStaleHint(queryClient.getQueryData<EvidencePage>(evidencePageKey(shape.from, 1)) ?? null);
            queryClient.setQueriesData<EvidencePage>({ queryKey: ['evidence', shape.from] }, (page) => (page && page.undo === 'available' ? { ...page, undo: 'used' } : page));
            void queryClient.invalidateQueries({ queryKey: ['evidence', shape.from] });
          }
          if (unfinished && !result.busy) setNotice(free ? { kind: 'unfinished', undo: true } : { kind: 'unfinished' });
          return false;
        }
        const search = result.value.search;
        queryClient.setQueryData(evidencePageKey(search.id, 1), search);
        rememberQuestion(search.id, search.question);
        if (shape.kind === 'evidence-edited' && (free || search.freeUndo)) {
          // The server's word: an undo shown as free that it counted says so on its page.
          if (free && !search.freeUndo) rememberCharged(search.id);
          // The edited search's undo hint is read from its claim at every page read: once used, its
          // cached pages say so at once, and every one is read again.
          if (search.freeUndo) queryClient.setQueriesData<EvidencePage>({ queryKey: ['evidence', shape.from] }, (page) => (page ? { ...page, undo: 'used' } : page));
          void queryClient.invalidateQueries({ queryKey: ['evidence', shape.from] });
        }
        // Settled once the search's page is on screen; until then a reload or a second ask replays the key.
        settleOnArrival(search.id, 'page', id, idempotencyKey);
        const next = new URLSearchParams();
        if (keepCompare && cases) next.set(CASES_PARAM, cases);
        // Its page announces the results and takes focus if it was lost on the way.
        expectArrival(search.id);
        navigate(`${evidencePath(search.id)}${next.size > 0 ? `?${next.toString()}` : ''}`);
        return true;
      } finally {
        for (const one of shown) hide(one);
      }
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
      const free = change.free === true;
      if (free) {
        // The hint on screen may be stale (another tab, a failed attempt): read it again first, and
        // send nothing as free when it says the undo is used. A read that fails leaves it to the server.
        const visitor = visitorGeneration();
        const shown = queryClient.getQueryData<EvidencePage>(evidencePageKey(from, 1));
        setVerifying(true);
        let fresh: EvidencePage | undefined;
        try {
          const { evidencePageQuery } = await import('./api');
          fresh = await queryClient.fetchQuery({ ...evidencePageQuery(from, 1), staleTime: 0 });
        } catch {
          fresh = undefined;
        } finally {
          setVerifying(false);
        }
        if (visitorGeneration() !== visitor) return false;
        if (fresh && fresh.undo !== 'available') {
          setStaleHint(shown ?? null);
          setNotice({ kind: 'message', text: UNDO_USED_NOTICE });
          return false;
        }
      }
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
        free,
      );
    },
    [queryClient, send, setNotice],
  );

  // Once its checklist shows, the control that asked says "Searching…" (before that, or without a
  // checklist that could load, "Starting…").
  const phase: AiPhase = verifying ? 'checking' : pending !== null && checklistReady ? 'searching' : request.phase;
  return { ...request, phase, staleHint, pending, ask, edit };
}
