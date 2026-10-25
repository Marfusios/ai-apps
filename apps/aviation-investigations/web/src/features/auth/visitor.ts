/**
 * Whose data the page holds (Task 20 review). Signing out or deleting the account changes
 * the visitor: everything private the page kept for the previous one goes at once, in
 * this tab and in every other open tab of the site, and nothing still on its way can bring
 * it back.
 *
 * - **A generation** counts visitor changes (`visitorGeneration`).
 * - **Private queries** are the namespaces in `PRIVATE_QUERY_ROOTS`: the account, the AI
 *   counts, every brief step, every case's AI context (`brief-case`, which never goes
 *   stale by itself), every page of an evidence search (`evidence`, likewise) and the
 *   cases it opens at its own generation (`evidence-case`). `forgetVisitor` cancels what is in flight, shows the account as
 *   signed out at once, and resets every other private query to no data: what a screen
 *   still shows is read again as the new visitor (a brief or its context is then not
 *   found), and nothing cached is shown on the way back to it.
 * - **Late answers.** Every private read runs through `privateRead`, which drops an answer
 *   that arrives after the visitor changed: a poll or a context read sent before the
 *   change cannot fill the cache again. Signing out moves the generation on as soon as it
 *   starts (`visitorLeaving`), before the server has answered, and forgets once it has. AI requests (web/src/features/ai/useAiRequest.ts)
 *   carry the generation they started under: after a change they send nothing more (their
 *   POST checks it right before the network call, after every wait), and their answer,
 *   success or failure, is discarded without restoring a question, a retry key or a
 *   navigation. A Turnstile check still open for them is cancelled (`onVisitorChange`).
 * - **Memory and this tab's storage:** the questions this page asked (for "Ask again"), the
 *   retry keys of AI requests whose answer never came and what this tab knows of evidence
 *   searches' free undos (web/src/features/evidence/undo.ts) are forgotten too.
 * - **Other tabs.** Each change gets a random name, recorded in local storage
 *   (`VISITOR_STORAGE_KEY`: nothing about the visitor) and announced on a
 *   `BroadcastChannel` (`VISITOR_CHANNEL`). Every other tab of the site that listens
 *   (`listenForVisitorChanges`, from the app shell) forgets the same way, once per change:
 *   on the channel's message, or on the storage event the record raises (browsers without
 *   the channel); when it starts listening, if a change came after its page loaded; and
 *   when the page comes back from the back/forward cache, where it heard nothing (without
 *   local storage it cannot tell, so it forgets as if the visitor had changed). Such a tab
 *   then reads the account again: the change was made elsewhere, and the server says who
 *   is signed in now. It remembers the names it has seen, and once it has forgotten for
 *   the latest recorded change, an earlier one arriving late (a message queued while its
 *   page was away) changes nothing.
 *
 * Public namespaces (`PUBLIC_QUERY_ROOTS`) are the same for everyone and stay. A test keeps
 * every query key of the app in one of the two lists.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { AccountResponse } from '../../../../shared/contracts/account';
import { forgetAllUnsettled } from '../ai/unsettled';
import { forgetQuestions } from '../brief/memory';
import { forgetUndos } from '../evidence/undo';

/** Query namespaces that hold one visitor's data. */
export const PRIVATE_QUERY_ROOTS = ['account', 'ai-status', 'brief', 'brief-case', 'evidence', 'evidence-case'] as const;
/** Query namespaces that are the same for every visitor. */
export const PUBLIC_QUERY_ROOTS = ['config', 'search', 'case', 'dashboard'] as const;

/** The channel every tab of the site hears visitor changes on. */
export const VISITOR_CHANNEL = 'casebook-visitor';
/** Local storage: the random name of this browser's latest visitor change. */
export const VISITOR_STORAGE_KEY = 'casebook-visitor-change';
const CHANGED = 'visitor-changed';

let generation = 0;
const listeners = new Set<() => void>();

/** The recorded change, or `undefined` when local storage cannot be read (blocked, or no window). */
function recordedChange(): string | null | undefined {
  try {
    return window.localStorage.getItem(VISITOR_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

/** The change names this tab has seen (made, heard or found recorded), the latest `SEEN_NAMES`. */
const seenChanges = new Set<string>();
const SEEN_NAMES = 64;

function see(change: string): void {
  seenChanges.delete(change);
  seenChanges.add(change);
  if (seenChanges.size > SEEN_NAMES) seenChanges.delete(seenChanges.values().next().value as string);
}

// The change recorded when this page loaded came before anything it holds.
const recordedAtLoad = recordedChange();
if (typeof recordedAtLoad === 'string') see(recordedAtLoad);

function newChangeName(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** This tab's channel: it posts the changes made here and hears the other tabs' (never its own posts). */
const channel: BroadcastChannel | null = (() => {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const opened = new BroadcastChannel(VISITOR_CHANNEL);
    // Node (tests) would wait for an open channel before exiting; browsers have no `unref`.
    (opened as BroadcastChannel & { unref?: () => void }).unref?.();
    return opened;
  } catch {
    return null;
  }
})();

/** How many times the visitor changed in this tab: an operation started under an older one is the previous visitor's. */
export function visitorGeneration(): number {
  return generation;
}

/** Run `listener` on every visitor change (this tab's or another tab's); returns the unsubscribe. */
export function onVisitorChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The visitor is leaving (a sign-out has started): from now on nothing started for them is
 * kept or sent. A private answer still on its way is dropped, and an AI request sends
 * nothing more, while the server works on the sign-out; `forgetVisitor` follows once it has
 * answered, so that what is read again is read as whoever the server then says is signed in.
 */
export function visitorLeaving(): void {
  generation += 1;
}

/** The visitor changed: a private read's late answer is dropped, and a send for the previous visitor is not made. */
export class VisitorChangedError extends Error {
  override readonly name = 'VisitorChangedError';
}

/** Run a private read; its answer is dropped (`VisitorChangedError`) when the visitor changed meanwhile. */
export async function privateRead<T>(read: () => Promise<T>): Promise<T> {
  const at = generation;
  const value = await read();
  if (generation !== at) throw new VisitorChangedError('the visitor changed while this was read');
  return value;
}

export interface ForgetOptions {
  /** Tell the other tabs (the default): not when the change came from one of them, or is only possible. */
  announce?: boolean;
  /**
   * Read the account again once it is forgotten: when the change was not made here, this
   * tab does not know who is signed in now (another tab may have signed in again).
   */
  reread?: boolean;
}

/**
 * The visitor changed (signed out, or the account deleted): drop everything private the
 * page holds, show the account signed out at once, and tell the other tabs (unless the
 * change came from one of them).
 */
export async function forgetVisitor(queryClient: QueryClient, opts: ForgetOptions = {}): Promise<void> {
  generation += 1;
  forgetQuestions();
  forgetAllUnsettled();
  forgetUndos();
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener's failure never keeps the others from forgetting.
    }
  }
  if (opts.announce !== false) {
    const change = newChangeName();
    see(change);
    let recorded = false;
    try {
      // Other tabs get a storage event; a tab that listens late, or comes back from the cache, reads it.
      window.localStorage.setItem(VISITOR_STORAGE_KEY, change);
      recorded = true;
    } catch {
      // No local storage: the channel still carries the change.
    }
    channel?.postMessage({ type: CHANGED, change, recorded });
  }
  await Promise.all(PRIVATE_QUERY_ROOTS.map((root) => queryClient.cancelQueries({ queryKey: [root] })));
  queryClient.setQueryData<AccountResponse>(['account'], { signedIn: false });
  // Reset (not remove): screens keep their queries and read them again as the new visitor.
  for (const root of PRIVATE_QUERY_ROOTS) if (root !== 'account') void queryClient.resetQueries({ queryKey: [root] });
  if (opts.reread) void queryClient.invalidateQueries({ queryKey: ['account'] });
}

/** A change made elsewhere, or only possible: forget, without telling the other tabs, and read the account again. */
const forgetFromElsewhere = (queryClient: QueryClient): Promise<void> => forgetVisitor(queryClient, { announce: false, reread: true });

/**
 * Another tab changed the visitor: forget here, once per change (`change` names it; a
 * message without a name, from a page of an earlier version, always counts). `recorded`:
 * the change was written to the record when it was made, so the record now holds it or a
 * later change; if this tab has already forgotten for that one, this change is covered (a
 * message queued while the page was away, delivered after it caught up).
 */
function heard(queryClient: QueryClient, change: string | undefined, recorded: boolean): void {
  const latest = recordedChange();
  if (change !== undefined) {
    if (seenChanges.has(change)) return;
    see(change);
    if (recorded && typeof latest === 'string' && latest !== change && seenChanges.has(latest)) return;
  }
  if (typeof latest === 'string') see(latest);
  void forgetFromElsewhere(queryClient);
}

/** A change recorded since this tab last looked (`restored`: back from the back/forward cache)? */
function recheck(queryClient: QueryClient, restored: boolean): void {
  const recorded = recordedChange();
  if (recorded === undefined) {
    // Without local storage a restored page cannot tell whether the visitor changed while it
    // was away: it forgets as if it had, and reads the account again.
    if (restored) void forgetFromElsewhere(queryClient);
    return;
  }
  if (recorded !== null && !seenChanges.has(recorded)) heard(queryClient, recorded, true);
  else if (restored) void queryClient.invalidateQueries({ queryKey: ['account'] });
}

/**
 * Forget the visitor here whenever another tab of the site changes it: its message on the
 * channel, its record's storage event, a change recorded before this tab listened, or
 * while its page was in the back/forward cache. Returns the unsubscribe.
 */
export function listenForVisitorChanges(queryClient: QueryClient): () => void {
  if (typeof window === 'undefined') return () => {};
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; change?: unknown; recorded?: unknown } | null;
    if (data?.type === CHANGED) heard(queryClient, typeof data.change === 'string' ? data.change : undefined, data.recorded === true);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === VISITOR_STORAGE_KEY && event.newValue !== null) heard(queryClient, event.newValue, true);
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) recheck(queryClient, true);
  };
  channel?.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage);
  window.addEventListener('pageshow', onPageShow);
  recheck(queryClient, false);
  return () => {
    channel?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pageshow', onPageShow);
  };
}
