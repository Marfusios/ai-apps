/**
 * Google sign-in and accounts (Task 20; DESIGN §7, UI_DESIGN §4.8, §5). Every route under
 * `/api/account` and `/api/auth` is per visitor and `private, no-store`.
 *
 * | Endpoint | Request | Response |
 * | --- | --- | --- |
 * | `POST /api/auth/sign-in/social` | `SignInRequest` | `SignInResponse`: the Google authorization URL to open; 503 `sign_out_pending` while a sign-out this browser has pending cannot be finished |
 * | `GET /api/auth/callback/google` | Google's redirect (`code`, `state`) | 302 to the page sign-in started from |
 * | `POST /api/auth/sign-out` | `{}` | `SignOutResponse` `{ success: true }`, the session cookie expired and the session ended; 503 `sign_out_pending` when the database could not end it (the cookie expired all the same, the sign-out kept for a retry) |
 * | `GET /api/account` | — | `AccountResponse` |
 * | `POST /api/account/delete/start` | `{}` | `DeleteStartResponse`: confirmed for 5 minutes, or sign in with Google again first |
 * | `POST /api/account/delete` | `DeleteAccountRequest` | `DeleteAccountResponse`, the session cookie expired; 403 `reauth_required` without a confirmation |
 *
 * Deleting needs a recent Google sign-in (server/auth/deletion.ts): within 5 minutes of
 * signing in, `start` confirms at once; otherwise the page signs in with Google again,
 * returning to `DELETE_REAUTH_PATH`, and comes back confirmed when it was the same account.
 *
 * The `/api/auth` routes are Better Auth's (server/auth/better-auth.ts); only these three
 * are served, and only while Google sign-in is configured (`GET /api/config`
 * `googleEnabled`). Without it every one of them is 404 and the account reads signed out.
 */
import { z } from 'zod';

/**
 * Visible ASCII except `"`, `#` and the backslash: what the page's return paths are made
 * of (it percent-encodes everything else), each character one byte in the state cookie's
 * JSON, where `"` or a backslash would take two and other characters up to six.
 */
const RETURN_PATH_CHARS = /^[\x21\x24-\x5b\x5d-\x7e]+$/;
/** A `.` or `..` path segment, plainly or percent-encoded, or an encoded slash or backslash. */
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|$)|%2f|%5c/i;

/**
 * The longest return path, in bytes (its characters are one byte each). A sign-in carries
 * three of them (to come back to, for a new account, on failure) in its encrypted state
 * cookie, which must stay within a browser's 4096 bytes (server/auth/better-auth.ts),
 * whatever a client sends; the page drops a longer query.
 */
export const RETURN_PATH_MAX = 384;

/**
 * A page of this site to come back to: a root-relative path with an optional query, never
 * `//host`, an empty or dot segment (`/.//host` would resolve to `//host`) or an encoded
 * slash, in visible ASCII without `"`, `#` or a backslash (`RETURN_PATH_CHARS`), at most
 * `RETURN_PATH_MAX` bytes. Better Auth checks the same against the trusted origin; the
 * server checks this first.
 */
export const ReturnPathSchema = z
  .string()
  .min(1)
  .max(RETURN_PATH_MAX)
  .refine(
    (p) => {
      const path = p.split('?', 1)[0]!;
      return p.startsWith('/') && RETURN_PATH_CHARS.test(p) && !path.includes('//') && !DOT_SEGMENT.test(path);
    },
    { message: 'expected a path on this site' },
  );

/** Query parameter on the return path after a first sign-in: the welcome is shown once. */
export const WELCOME_PARAM = 'welcome';
/** Query parameter on the return path when sign-in did not complete (`signin=failed`). */
export const SIGN_IN_ERROR_PARAM = 'signin';
/** Query parameter of the account page after a deletion's Google sign-in (`delete=confirm`). */
export const DELETE_PARAM = 'delete';
/**
 * Where a deletion's Google sign-in returns: a sign-in started for this path from a
 * signed-in browser carries the deletion intent (server/auth/better-auth.ts).
 */
export const DELETE_REAUTH_PATH = `/account?${DELETE_PARAM}=confirm`;

/**
 * `POST /api/auth/sign-in/social`. Exactly these fields: no ID-token sign-in, no extra
 * scopes or authorization parameters, no client data in the OAuth state. The page opens
 * the returned URL itself (`disableRedirect`).
 */
export const SignInRequestSchema = z.strictObject({
  provider: z.literal('google'),
  /** Where to come back to after signing in. */
  callbackURL: ReturnPathSchema,
  /** The same page with `welcome=1`: where a new account comes back to. */
  newUserCallbackURL: ReturnPathSchema,
  /** The same page with `signin=failed`. */
  errorCallbackURL: ReturnPathSchema,
  disableRedirect: z.literal(true),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/** Better Auth's answer: the provider URL to open. Extra fields are ignored. */
export const SignInResponseSchema = z.looseObject({ url: z.string().max(4096), redirect: z.boolean() });

/** A sign-out's success: the session is gone (any other answer leaves that unconfirmed). Extra fields are ignored. */
export const SignOutResponseSchema = z.looseObject({ success: z.literal(true) });
export type SignOutResponse = z.infer<typeof SignOutResponseSchema>;

export const AccountUserSchema = z.strictObject({
  name: z.string().max(200),
  email: z.string().min(3).max(320),
});

/**
 * `GET /api/account`: who is signed in on this browser (what the account page shows), and
 * until when this session may delete the account without another Google sign-in (a live
 * deletion confirmation), if it may.
 */
export const AccountResponseSchema = z.discriminatedUnion('signedIn', [
  z.strictObject({ signedIn: z.literal(false) }),
  z.strictObject({ signedIn: z.literal(true), user: AccountUserSchema, deletionConfirmedUntil: z.iso.datetime().optional() }),
]);
export type AccountResponse = z.infer<typeof AccountResponseSchema>;

/** `POST /api/account/delete/start`: an empty body. */
export const DeleteStartRequestSchema = z.strictObject({});

/**
 * Confirmed (`confirm`, until when) because this session signed in with Google in the last
 * 5 minutes; otherwise `reauthenticate`: sign in with Google again first, returning to
 * `DELETE_REAUTH_PATH`.
 */
export const DeleteStartResponseSchema = z.discriminatedUnion('next', [
  z.strictObject({ next: z.literal('confirm'), until: z.iso.datetime() }),
  z.strictObject({ next: z.literal('reauthenticate') }),
]);
export type DeleteStartResponse = z.infer<typeof DeleteStartResponseSchema>;

/** `POST /api/account/delete`: the explicit confirmation is part of the body. */
export const DeleteAccountRequestSchema = z.strictObject({ confirm: z.literal(true) });

export const DeleteAccountResponseSchema = z.strictObject({ deleted: z.literal(true) });
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
