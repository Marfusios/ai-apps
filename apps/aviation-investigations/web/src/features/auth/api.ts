/**
 * Google sign-in and the account from the page (shared/contracts/account.ts). The page
 * never handles a token: sign-in asks the server for Google's authorization URL and opens
 * it; Google sends the browser back to the server, which sets an HttpOnly session cookie
 * and returns it to the page it started from (with `welcome=1` for a new account, or
 * `signin=failed`).
 *
 * Deleting the account needs a recent Google sign-in: `startDeletion` says whether this
 * session may delete now; otherwise `confirmWithGoogle` signs in with Google again,
 * coming back to `DELETE_REAUTH_PATH` (or `/account?delete=failed`). Signing out and
 * deleting forget everything private the page held (`forgetVisitor`); signing out does so
 * whatever the server answers (`signOut`).
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  AccountResponseSchema,
  DELETE_PARAM,
  DELETE_REAUTH_PATH,
  DeleteAccountResponseSchema,
  DeleteStartResponseSchema,
  RETURN_PATH_MAX,
  ReturnPathSchema,
  SIGN_IN_ERROR_PARAM,
  SignInResponseSchema,
  SignOutResponseSchema,
  WELCOME_PARAM,
  type DeleteStartResponse,
  type SignInRequest,
} from '../../../../shared/contracts/account';
import { getJson, postJson, retry } from '../../api';
import { forgetVisitor, privateRead, visitorLeaving } from './visitor';

/** Google's authorization endpoint: the only other origin sign-in may open. */
export const GOOGLE_ORIGIN = 'https://accounts.google.com';

/** Who is signed in on this browser. Per visitor and never cached by the server. */
export const accountQuery = () =>
  queryOptions({
    queryKey: ['account'],
    queryFn: ({ signal }) => privateRead(() => getJson('/api/account', AccountResponseSchema, signal)),
    staleTime: 60_000,
    retry,
  });

/** Parameters sign-in adds to the page it returns to; they never go round again. */
const RETURN_PARAMS = [WELCOME_PARAM, SIGN_IN_ERROR_PARAM, 'error', 'error_description'];

/** Room left for the parameter sign-in adds to a return path (`&signin=failed` is the longest). */
const RETURN_SUFFIX = `&${SIGN_IN_ERROR_PARAM}=failed`.length;

/**
 * The page to come back to: this path and query, without sign-in's own parameters. A path
 * and query too long for the sign-in's state cookie (`RETURN_PATH_MAX`), or not a return
 * path the server accepts, come back without the query; a path that is neither by itself,
 * to the home page.
 */
export function returnPath(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const name of RETURN_PARAMS) params.delete(name);
  const query = params.toString();
  const room = RETURN_PATH_MAX - RETURN_SUFFIX;
  const fits = (p: string): boolean => p.length <= room && ReturnPathSchema.safeParse(p).success;
  const full = `${pathname}${query ? `?${query}` : ''}`;
  if (fits(full)) return full;
  return fits(pathname) ? pathname : '/';
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

/** The sign-in request that confirms a deletion: back to the account page, `delete=confirm` or `delete=failed`. */
export function reauthRequest(): SignInRequest {
  return {
    provider: 'google',
    callbackURL: DELETE_REAUTH_PATH,
    newUserCallbackURL: withParam(DELETE_REAUTH_PATH, WELCOME_PARAM, '1'),
    errorCallbackURL: `/account?${DELETE_PARAM}=failed`,
    disableRedirect: true,
  };
}

/** How the page leaves for Google (component tests replace `go`). */
export const signInNavigation = { go: (url: string): void => window.location.assign(url) };

/**
 * Start Google sign-in and leave for Google. Throws when the server refuses or answers
 * with anything but Google's (or, in the mock, this site's) address.
 */
export async function startGoogleSignIn(
  path: string,
  navigate: (url: string) => void = signInNavigation.go,
  request: SignInRequest = signInRequest(path),
): Promise<void> {
  const answer = await postJson('/api/auth/sign-in/social', request, SignInResponseSchema);
  if (!answer) throw new Error('Sign-in did not start');
  const url = new URL(answer.url, window.location.origin);
  if (url.origin !== GOOGLE_ORIGIN && url.origin !== window.location.origin) throw new Error('Sign-in answered with an unexpected address');
  navigate(url.toString());
}

/**
 * The server did not confirm a sign-out: it answered with an error (503 `sign_out_pending`
 * when it could not end the session; it then expired this browser's session cookie and
 * ends the session at the browser's next account read, sign-out or sign-in, admitting no
 * new sign-in before), or no answer came, or the answer broke off. The page has forgotten
 * everything private all the same and told the other tabs, and reads the account again:
 * where the session is still there, it shows, to be signed out again.
 */
export class SignOutUnconfirmedError extends Error {
  override readonly name = 'SignOutUnconfirmedError';
}

/**
 * Sign out, and forget everything private the page held whatever the server answers (gate
 * t22 finding 1, r2 finding 1). As soon as it starts, nothing started for the visitor is
 * kept or sent (`visitorLeaving`: a late private answer is dropped, an AI request sends
 * nothing more). Once the server has answered, or no answer can come, this tab and every
 * other one forget the visitor (`forgetVisitor`); what they read again is then read as
 * whoever the server says is signed in. Only the server's success, read in full, confirms
 * the sign-out. Anything else (an error status, no answer, an answer cut short) reads the
 * account again here too and throws `SignOutUnconfirmedError`.
 */
export async function signOut(queryClient: QueryClient): Promise<void> {
  visitorLeaving();
  let confirmed = false;
  try {
    confirmed = (await postJson('/api/auth/sign-out', {}, SignOutResponseSchema))?.success === true;
  } catch {
    // An error status, no answer, or an answer cut short: not confirmed.
  }
  await forgetVisitor(queryClient, { reread: !confirmed });
  if (!confirmed) throw new SignOutUnconfirmedError('The server has not confirmed the sign-out');
}

/** Whether this session may delete the account now, or must sign in with Google again first. */
export async function startDeletion(): Promise<DeleteStartResponse> {
  const answer = await postJson('/api/account/delete/start', {}, DeleteStartResponseSchema);
  if (!answer) throw new Error('Deletion did not start');
  return answer;
}

/** Sign in with Google again to confirm a deletion (leaves the page). */
export function confirmWithGoogle(navigate?: (url: string) => void): Promise<void> {
  return startGoogleSignIn(DELETE_REAUTH_PATH, navigate, reauthRequest());
}

export async function deleteAccount(queryClient: QueryClient): Promise<void> {
  await postJson('/api/account/delete', { confirm: true }, DeleteAccountResponseSchema);
  await forgetVisitor(queryClient);
}
