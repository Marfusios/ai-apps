/**
 * Google sign-in and accounts (Task 20; DESIGN §7, UI_DESIGN §4.8, §5). Every route under
 * `/api/account` and `/api/auth` is per visitor and `private, no-store`.
 *
 * | Endpoint | Request | Response |
 * | --- | --- | --- |
 * | `POST /api/auth/sign-in/social` | `SignInRequest` | `SignInResponse`: the Google authorization URL to open |
 * | `GET /api/auth/callback/google` | Google's redirect (`code`, `state`) | 302 to the page sign-in started from |
 * | `POST /api/auth/sign-out` | `{}` | `{ success: true }`, the session cookie expired |
 * | `GET /api/account` | — | `AccountResponse` |
 * | `POST /api/account/delete` | `DeleteAccountRequest` | `DeleteAccountResponse`, the session cookie expired |
 *
 * The `/api/auth` routes are Better Auth's (server/auth/better-auth.ts); only these three
 * are served, and only while Google sign-in is configured (`GET /api/config`
 * `googleEnabled`). Without it every one of them is 404 and the account reads signed out.
 */
import { z } from 'zod';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A page of this site to come back to: a root-relative path with an optional query, never
 * `//host`, a backslash or a control character, at most 512 characters. Better Auth checks
 * the same against the trusted origin; the server checks this first.
 */
export const ReturnPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') && !p.includes('#') && !CONTROL.test(p), {
    message: 'expected a path on this site',
  });

/** Query parameter on the return path after a first sign-in: the welcome is shown once. */
export const WELCOME_PARAM = 'welcome';
/** Query parameter on the return path when sign-in did not complete (`signin=failed`). */
export const SIGN_IN_ERROR_PARAM = 'signin';

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

export const AccountUserSchema = z.strictObject({
  name: z.string().max(200),
  email: z.string().min(3).max(320),
});

/** `GET /api/account`: who is signed in on this browser (what the account page shows). */
export const AccountResponseSchema = z.discriminatedUnion('signedIn', [
  z.strictObject({ signedIn: z.literal(false) }),
  z.strictObject({ signedIn: z.literal(true), user: AccountUserSchema }),
]);
export type AccountResponse = z.infer<typeof AccountResponseSchema>;

/** `POST /api/account/delete`: the explicit confirmation is part of the body. */
export const DeleteAccountRequestSchema = z.strictObject({ confirm: z.literal(true) });

export const DeleteAccountResponseSchema = z.strictObject({ deleted: z.literal(true) });
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
