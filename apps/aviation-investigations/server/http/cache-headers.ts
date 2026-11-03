/**
 * `Cache-Control` by route, decided from the route the router matched (the decoded
 * path, `request.routeOptions.url`), like access control in server/app.ts.
 *
 * - AI, auth, account and quota-bearing routes are per visitor and never cacheable:
 *   `private, no-store`. The rule is a route prefix, so a route added later under one of
 *   these prefixes is covered without being listed (`/api/briefs`, `/api/auth/*`,
 *   `/api/account/*`, `/api/ai/*`), errors included, while `/api/aircraft` stays cacheable.
 * - Public data routes set their own `Cache-Control` and revision ETag (server/routes).
 * - Error responses are `no-store` (server/http/reply.ts `sendError`).
 */

/** Matched-route prefixes whose responses must never be stored, matched on path-segment boundaries. */
export const NO_STORE_ROUTE_PREFIXES: readonly string[] = ['/api/admin', '/ai', '/briefs', '/api/evidence', '/api/ai', '/api/briefs', '/api/auth', '/api/account'];

export const PRIVATE_NO_STORE = 'private, no-store';

/** True when the matched route pattern belongs to a per-visitor route. */
export function isNoStoreRoute(route: string | undefined): boolean {
  if (route === undefined) return false;
  const path = route.toLowerCase();
  return NO_STORE_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
