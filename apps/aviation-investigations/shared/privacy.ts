/**
 * The state of the privacy notice (web/src/pages/Privacy.tsx; DESIGN §7: "Publish a
 * privacy/contact notice before collecting real users"). The owner approved the final text
 * on 24 October 2026, so it is published: live may turn Google sign-in on
 * (server/auth/better-auth.ts `authConfigProblem`). Were the notice ever a draft again, setting
 * `final` back to false makes the page say so and keeps live sign-in off, so no name or email is
 * collected behind a draft (RUNBOOK, "Google sign-in", step 0).
 */
export const PRIVACY_NOTICE: { readonly final: boolean } = { final: true };
