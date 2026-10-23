/**
 * The explicit cross-site check of the custom POST endpoints (DESIGN §7: CSRF protection
 * on custom POST endpoints): AI briefs, sign-in and the account. Their bodies are JSON
 * and the cookies are SameSite=Lax; this refuses a browser request that another site
 * started before any work.
 */
import type { FastifyRequest } from 'fastify';

/**
 * A browser request that another site started. Browsers that send `Sec-Fetch-Site` are
 * judged by it (only `same-origin` and `none` pass, which also covers the development
 * server's proxy); otherwise an `Origin` other than `APP_URL`'s is refused. Requests
 * with neither header (tools, tests) pass: they cannot carry a visitor's SameSite cookie
 * from another site anyway.
 */
export function crossSite(request: FastifyRequest, appOrigin: string): boolean {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.origin;
  return origin !== undefined && origin !== appOrigin;
}

/** True when the request body is declared JSON (`application/json`, any parameters). */
export function isJsonRequest(request: FastifyRequest): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type);
}
