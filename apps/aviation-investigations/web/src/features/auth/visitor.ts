/**
 * Whose data the page holds (Task 20 review). Signing out or deleting the account changes
 * the visitor: everything private the page kept for the previous one goes at once, in
 * this tab and in every other open tab of the site, and nothing still on its way can bring
 * it back.
 *
 * - **A generation** counts visitor changes (`visitorGeneration`).
 * - **Private queries** are the namespaces in `PRIVATE_QUERY_ROOTS`: the account, the AI
 *   counts, every brief step and every case's AI context (`brief-case`, which never goes
 *   stale by itself). `forgetVisitor` cancels what is in flight, shows the account as
 *   signed out at once, and resets every other private query to no data: what a screen
 *   still shows is read again as the new visitor (a brief or its context is then not
 *   found), and nothing cached is shown on the way back to it.
 * - **Late answers.** Every private read runs through `privateRead`, which drops an answer
 *   that arrives after the visitor changed: a poll or a context read sent before the
 *   change cannot fill the cache again. AI requests (web/src/features/ai/useAiRequest.ts)
 *   carry the generation they started under: after a change they send nothing more (their
 *   POST checks it right before the network call, after every wait), and their answer,
 *   success or failure, is discarded without restoring a question, a retry key or a
 *   navigation. A Turnstile check still open for them is cancelled (`onVisitorChange`).
 * - **Memory and this tab's storage:** the questions this page asked (for "Ask again") and
 *   the retry keys of AI requests whose answer never came are forgotten too.
 * - **Other tabs.** The change is announced on a `BroadcastChannel`
 *   (`VISITOR_CHANNEL`, a message without data); every other tab of the site that listens
 *   (`listenForVisitorChanges`, from the app shell) forgets the same way.
 *
 * Public namespaces (`PUBLIC_QUERY_ROOTS`) are the same for everyone and stay. A test keeps
 * every query key of the app in one of the two lists.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { AccountResponse } from '../../../../shared/contracts/account';
import { forgetAllUnsettled } from '../ai/unsettled';
import { forgetQuestions } from '../brief/memory';

/** Query namespaces that hold one visitor's data. */
export const PRIVATE_QUERY_ROOTS = ['account', 'ai-status', 'brief', 'brief-case'] as const;
/** Query namespaces that are the same for every visitor. */
export const PUBLIC_QUERY_ROOTS = ['config', 'search', 'case', 'dashboard'] as const;

/** The channel every tab of the site hears visitor changes on. */
export const VISITOR_CHANNEL = 'casebook-visitor';
const CHANGED = 'visitor-changed';

let generation = 0;
const listeners = new Set<() => void>();

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

/**
 * The visitor changed (signed out, or the account deleted): drop everything private the
 * page holds, show the account signed out at once, and tell the other tabs (unless the
 * change came from one of them).
 */
export async function forgetVisitor(queryClient: QueryClient, opts: { announce?: boolean } = {}): Promise<void> {
  generation += 1;
  forgetQuestions();
  forgetAllUnsettled();
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener's failure never keeps the others from forgetting.
    }
  }
  if (opts.announce !== false) channel?.postMessage({ type: CHANGED });
  await Promise.all(PRIVATE_QUERY_ROOTS.map((root) => queryClient.cancelQueries({ queryKey: [root] })));
  queryClient.setQueryData<AccountResponse>(['account'], { signedIn: false });
  // Reset (not remove): screens keep their queries and read them again as the new visitor.
  for (const root of PRIVATE_QUERY_ROOTS) if (root !== 'account') void queryClient.resetQueries({ queryKey: [root] });
}

/** Forget the visitor here whenever another tab of the site announces a change; returns the unsubscribe. */
export function listenForVisitorChanges(queryClient: QueryClient): () => void {
  if (!channel) return () => {};
  const onMessage = (event: MessageEvent): void => {
    if ((event.data as { type?: unknown } | null)?.type === CHANGED) void forgetVisitor(queryClient, { announce: false });
  };
  channel.addEventListener('message', onMessage);
  return () => channel.removeEventListener('message', onMessage);
}
