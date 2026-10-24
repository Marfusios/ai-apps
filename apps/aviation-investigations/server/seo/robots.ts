/**
 * `/robots.txt` (README, "Search engines and link previews"). Live lets every crawler in and
 * says where the sitemap is; any other environment keeps them all out (every response there
 * also says `X-Robots-Tag: noindex, nofollow`, server/app.ts). The API is never disallowed:
 * search engines render the pages by calling it. In front of live, Cloudflare prepends its own
 * comment-only "content signals" block to this file.
 */
export function robotsTxt(opts: { live: boolean; origin: string }): string {
  const lines = opts.live ? ['User-agent: *', 'Allow: /', '', `Sitemap: ${opts.origin}/sitemap.xml`] : ['User-agent: *', 'Disallow: /'];
  return `${lines.join('\n')}\n`;
}
