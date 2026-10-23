/**
 * The state of the privacy notice (web/src/pages/Privacy.tsx; DESIGN §7: "Publish a
 * privacy/contact notice before collecting real users"). While it is a draft, the page
 * says so and live keeps Google sign-in off (server/auth/better-auth.ts
 * `authConfigProblem`), so no name or email is collected behind a draft. The owner
 * publishes the final text by replacing the page's content and setting `final` (RUNBOOK,
 * "Google sign-in", step 0).
 */
export const PRIVACY_NOTICE: { readonly final: boolean } = { final: false };
