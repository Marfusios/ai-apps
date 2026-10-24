/**
 * Reading a request target (`request.url`): the path as the router sees it, and the query
 * string. One behaviour for every caller (server/app.ts decides between a JSON and a page 404
 * and which responses are API responses; server/routes/pages.ts finds trailing slashes and
 * known page paths). The router strips an absolute-form `http://host` or `https://host` (any
 * letter case) before matching, and so does `routerPath`; other schemes are not stripped and
 * match nothing.
 */

/**
 * The path the router sees: the request target without an absolute-form scheme and
 * authority, the query or a fragment, with a leading slash, percent-decoded (left as sent
 * when an escape is malformed).
 */
export function routerPath(target: string): string {
  let path = target.replace(/^https?:\/\/[^/?#]*/i, '');
  path = path.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/')) path = `/${path}`;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The query string of a request target, without its `?` or a fragment; empty when there is none. */
export function targetQuery(target: string): string {
  const beforeFragment = target.split('#', 1)[0] ?? '';
  const at = beforeFragment.indexOf('?');
  return at < 0 ? '' : beforeFragment.slice(at + 1);
}
