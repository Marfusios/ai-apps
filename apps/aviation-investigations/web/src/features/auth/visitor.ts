/**
 * Whose data the page holds (Task 20 review). Signing out or deleting the account changes
 * the visitor: everything private the page kept for the previous one goes at once, before
 * anything else renders, and nothing that was still on its way can bring it back.
 *
 * - **Private queries** are the namespaces in `PRIVATE_QUERY_ROOTS`: the account, the AI
 *   counts, every brief step and every case's AI context (`brief-case`, which never goes
 *   stale by itself). `forgetVisitor` cancels what is in flight, shows the account as
 *   signed out at once, and resets every other private query to no data: what a screen
 *   still shows is read again as the new visitor (a brief or its context is then not
 *   found), and nothing cached is shown on the way back to it.
 * - **Late answers.** Every private read runs through `privateRead`, which drops an answer
 *   that arrives after the visitor changed: a poll or a context read sent before the
 *   change cannot fill the cache again.
 * - **Memory and this tab's storage:** the questions this page asked (for "Ask again") and
 *   the retry keys of AI requests whose answer never came are forgotten too.
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

let generation = 0;

/** A private read's answer arrived after the visitor changed: it is dropped. */
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
 * page holds, and show the account signed out at once.
 */
export async function forgetVisitor(queryClient: QueryClient): Promise<void> {
  generation += 1;
  forgetQuestions();
  forgetAllUnsettled();
  await Promise.all(PRIVATE_QUERY_ROOTS.map((root) => queryClient.cancelQueries({ queryKey: [root] })));
  queryClient.setQueryData<AccountResponse>(['account'], { signedIn: false });
  // Reset (not remove): screens keep their queries and read them again as the new visitor.
  for (const root of PRIVATE_QUERY_ROOTS) if (root !== 'account') void queryClient.resetQueries({ queryKey: [root] });
}
