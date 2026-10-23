/**
 * Google sign-in and the account from the page (shared/contracts/account.ts). The page
 * never handles a token: sign-in asks the server for Google's authorization URL and opens
 * it; Google sends the browser back to the server, which sets an HttpOnly session cookie
 * and returns it to the page it started from (with `welcome=1` for a new account, or
 * `signin=failed`).
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  AccountResponseSchema,
  DeleteAccountResponseSchema,
  SIGN_IN_ERROR_PARAM,
  SignInResponseSchema,
  WELCOME_PARAM,
  type SignInRequest,
} from '../../../../shared/contracts/account';
import { getJson, postJson, retry } from '../../api';

/** Google's authorization endpoint: the only other origin sign-in may open. */
export const GOOGLE_ORIGIN = 'https://accounts.google.com';

/** Who is signed in on this browser. Per visitor and never cached by the server. */
export const accountQuery = () =>
  queryOptions({
    queryKey: ['account'],
    queryFn: ({ signal }) => getJson('/api/account', AccountResponseSchema, signal),
    staleTime: 60_000,
    retry,
  });

/** Parameters sign-in adds to the page it returns to; they never go round again. */
const RETURN_PARAMS = [WELCOME_PARAM, SIGN_IN_ERROR_PARAM, 'error', 'error_description'];

/** The page to come back to: this path and query, without sign-in's own parameters. */
export function returnPath(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const name of RETURN_PARAMS) params.delete(name);
  const query = params.toString();
  return `${pathname.startsWith('/') && !pathname.startsWith('//') ? pathname : '/'}${query ? `?${query}` : ''}`;
}

function withParam(path: string, name: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${name}=${value}`;
}

/** The sign-in request for coming back to `path`. */
export function signInRequest(path: string): SignInRequest {
  return {
    provider: 'google',
    callbackURL: path,
    newUserCallbackURL: withParam(path, WELCOME_PARAM, '1'),
    errorCallbackURL: withParam(path, SIGN_IN_ERROR_PARAM, 'failed'),
    disableRedirect: true,
  };
}

/** How the page leaves for Google (component tests replace `go`). */
export const signInNavigation = { go: (url: string): void => window.location.assign(url) };

/**
 * Start Google sign-in and leave for Google. Throws when the server refuses or answers
 * with anything but Google's (or, in the mock, this site's) address.
 */
export async function startGoogleSignIn(path: string, navigate: (url: string) => void = signInNavigation.go): Promise<void> {
  const answer = await postJson('/api/auth/sign-in/social', signInRequest(path), SignInResponseSchema);
  if (!answer) throw new Error('Sign-in did not start');
  const url = new URL(answer.url, window.location.origin);
  if (url.origin !== GOOGLE_ORIGIN && url.origin !== window.location.origin) throw new Error('Sign-in answered with an unexpected address');
  navigate(url.toString());
}

/** Forget what this page knew about the visitor: the account, the AI counts and any brief. */
export async function refreshVisitor(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({ queryKey: ['brief'] });
  await Promise.all([queryClient.invalidateQueries({ queryKey: ['account'] }), queryClient.invalidateQueries({ queryKey: ['ai-status'] })]);
}

export async function signOut(queryClient: QueryClient): Promise<void> {
  await postJson('/api/auth/sign-out', {}, null);
  await refreshVisitor(queryClient);
}

export async function deleteAccount(queryClient: QueryClient): Promise<void> {
  await postJson('/api/account/delete', { confirm: true }, DeleteAccountResponseSchema);
  await refreshVisitor(queryClient);
}
