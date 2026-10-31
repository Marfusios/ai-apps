/**
 * The pages search engines and link previews read (server/routes/pages.ts, server/seo/), against
 * the fixture corpus (tests/integration/api-fixture.ts): each page's status and head, the
 * redirects, the rate limit a case page shares with the API, pages that are refused or fail,
 * X-Robots-Tag, robots.txt and the sitemaps. Pages that need no database are also tested
 * offline (tests/unit/pages-http.test.ts).
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import { parseHtml, parseXml, type MarkupDocument } from '../support/markup.js';
import { LOCAL, app, appDb, dataset, es, get, makeApp, useApiFixture, type Got } from './api-fixture.js';

useApiFixture('pages');

describe('pages for search engines and link previews', () => {
  const ORIGIN = 'http://localhost:3000';
  const BRIEF_ID = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
  const VALENTINE_TITLE =
    'Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas (2008) · NTSB DFW08TA066 · AirCase';

  const page = (url: string, opts: { app?: FastifyInstance; from?: string; headers?: Record<string, string> } = {}) =>
    get(url, { ...opts, headers: { accept: 'text/html', ...opts.headers } });

  function headOf(r: Got) {
    const doc = parseHtml(r.body);
    const meta = (attr: 'name' | 'property', key: string) => doc.head.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;
    return {
      title: doc.title,
      titles: doc.querySelectorAll('title').length,
      descriptions: doc.querySelectorAll('meta[name="description"]').length,
      description: meta('name', 'description'),
      robots: meta('name', 'robots'),
      canonical: doc.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogUrl: meta('property', 'og:url'),
      ogImage: meta('property', 'og:image'),
      ld: [...doc.querySelectorAll('script[type="application/ld+json"]')].map((el) => JSON.parse(el.textContent ?? '') as unknown),
    };
  }

  const locs = (doc: MarkupDocument): string[] => [...doc.getElementsByTagName('loc')].map((l) => l.textContent ?? '');

  it('a served case page is 200 with its own head in the page HTML', async () => {
    const r = await page('/cases/DFW08TA066');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(String(r.headers['content-security-policy'])).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(r.body).toContain('<div id="root">');
    const head = headOf(r);
    expect(head).toMatchObject({
      title: VALENTINE_TITLE,
      titles: 1,
      descriptions: 1,
      description:
        "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries. Probable cause: The contract mechanic's failure to properly secure the castellated nut that attached the…",
      robots: 'index, follow',
      canonical: `${ORIGIN}/cases/DFW08TA066`,
      ogUrl: `${ORIGIN}/cases/DFW08TA066`,
      ogImage: `${ORIGIN}/social/card.png`,
    });
    expect(head.ld).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'AirCase', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Explore', item: `${ORIGIN}/explore` },
          { '@type': 'ListItem', position: 3, name: 'DFW08TA066', item: `${ORIGIN}/cases/DFW08TA066` },
        ],
      },
    ]);
  });

  it('a number no case has is 404 with the page HTML, noindex and no canonical', async () => {
    for (const n of ['ZZZ99ZZ999', 'not-a-number', '%3Cscript%3E']) {
      const r = await page(`/cases/${n}`);
      expect(r.status, n).toBe(404);
      expect(r.body, n).toContain('<div id="root">');
      expect(headOf(r), n).toMatchObject({ robots: 'noindex', canonical: null, ogUrl: null, ld: [], description: 'No investigation has that number.' });
    }
    const hostile = await page('/cases/%3Cscript%3E');
    expect(headOf(hostile).title).toBe('NTSB <SCRIPT> · AirCase');
    expect(hostile.body).not.toContain('<SCRIPT>');
    // A record outside the default cohort keeps its indexable page.
    const other = await page('/cases/CEN23LA137');
    expect(other.status).toBe(200);
    expect(headOf(other)).toMatchObject({
      robots: 'index, follow',
      description: expect.stringMatching(/, no injuries\. Other investigation status \(NTSB status P\)\.$/),
    });
  });

  it('statuses, robots and canonicals of the other pages', async () => {
    const table: ReadonlyArray<readonly [string, number, string, string | null, string]> = [
      ['/', 200, 'index, follow', '/', 'AirCase · Plane crash & accident investigations'],
      ['/explore', 200, 'index, follow', '/explore', 'Explore · AirCase'],
      ['/explore?q=carburetor+icing', 200, 'noindex, follow', '/explore', '“carburetor icing” · Explore · AirCase'],
      ['/dashboard?cohort=all', 200, 'index, follow', '/dashboard', 'The record, in questions · AirCase'],
      ['/about', 200, 'index, follow', '/about', 'About · AirCase'],
      ['/privacy', 200, 'index, follow', '/privacy', 'Privacy · AirCase'],
      ['/compare?cases=DFW08TA066,SEA08LA057', 200, 'noindex, nofollow', '/compare', 'Comparing 2 cases · AirCase'],
      ['/account', 200, 'noindex, nofollow', '/account', 'Account · AirCase'],
      [`/briefs/${BRIEF_ID}?step=2`, 200, 'noindex, nofollow', `/briefs/${BRIEF_ID}`, 'AI brief · AirCase'],
      // An AI evidence search's page (Task 23): private, so the head says nothing of it.
      [`/ai/${BRIEF_ID}?pages=2&case=DFW08TA066`, 200, 'noindex, nofollow', `/ai/${BRIEF_ID}`, 'AI search · AirCase'],
      ['/no-such-page', 404, 'noindex', null, 'Page not found · AirCase'],
    ];
    for (const [url, status, robots, canonical, title] of table) {
      const r = await page(url);
      expect(r.status, url).toBe(status);
      expect(r.body, url).toContain('<div id="root">');
      expect(headOf(r), url).toMatchObject({ robots, canonical: canonical === null ? null : `${ORIGIN}${canonical}`, title, titles: 1, descriptions: 1 });
    }
    // The home page is a WebSite in JSON-LD; Explore has none.
    expect(headOf(await page('/')).ld).toEqual([
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'AirCase', alternateName: 'aviation casebook', url: `${ORIGIN}/` },
    ]);
    expect(headOf(await page('/explore')).ld).toEqual([]);
  });

  it('a served number not in canonical form is 301 to the canonical case path, the query dropped', async () => {
    for (const url of ['/cases/dfw08ta066', '/cases/Dfw08TA066?brief=x&step=1', '/cases/%20DFW08TA066', '/cases/DFW08TA066/', '/cases/dfw08ta066/?q=1']) {
      const r = await page(url);
      expect(r.status, url).toBe(301);
      expect(r.headers.location, url).toBe('/cases/DFW08TA066');
    }
    // An unknown number is not redirected.
    expect((await page('/cases/zzz99zz999')).status).toBe(404);
  });

  it('a page path with a trailing slash or in the wrong letter case is 301 to its own, the query dropped', async () => {
    for (const [url, to] of [
      ['/explore/', '/explore'],
      ['/explore/?q=carburetor', '/explore'],
      ['/about/', '/about'],
      ['/compare/?cases=DFW08TA066', '/compare'],
      [`/briefs/${BRIEF_ID}/`, `/briefs/${BRIEF_ID}`],
      [`/ai/${BRIEF_ID}/`, `/ai/${BRIEF_ID}`],
    ] as const) {
      const r = await page(url);
      expect(r.status, url).toBe(301);
      expect(r.headers.location, url).toBe(to);
    }
    // A page path in the wrong letter case, and the template file, go to their pages.
    for (const [url, to] of [
      ['/About', '/about'],
      ['/EXPLORE?q=carb', '/explore'],
      ['/Cases/DFW08TA066', '/cases/DFW08TA066'],
      ['/index.html?x=1', '/'],
    ] as const) {
      const r = await page(url);
      expect(r.status, url).toBe(301);
      expect(r.headers.location, url).toBe(to);
    }
    // The target is the path alone: never another host, whatever the request says.
    const absolute = await app.inject({ method: 'GET', url: '/about/', remoteAddress: LOCAL, headers: { host: 'evil.example', accept: 'text/html' } });
    expect(absolute.headers.location).toBe('/about');
    expect((await page('/')).status).toBe(200);
  });

  it('the page goes to requests that take HTML or anything, or say nothing; others get the plain 404', async () => {
    const accepts = ['text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', '*/*', undefined];
    for (const [url, status] of [
      ['/explore', 200],
      ['/cases/DFW08TA066', 200],
      ['/cases/ZZZ99ZZ999', 404],
      ['/no-such-page', 404],
    ] as const) {
      for (const accept of accepts) {
        const r = await get(url, { headers: accept === undefined ? {} : { accept } });
        expect(r.status, `${url} ${accept}`).toBe(status);
        expect(r.body, `${url} ${accept}`).toContain('<div id="root">');
      }
      const json = await get(url, { headers: { accept: 'application/json' } });
      expect(json.status, url).toBe(404);
      expect(json.body, url).toBe('Not found');
      expect(json.headers['content-type'], url).toBe('text/plain; charset=utf-8');
    }
    // A path with a file extension that no route serves is the plain 404, whatever it accepts.
    expect((await page('/missing.png')).body).toBe('Not found');
    // HEAD gets the same status and type (Node's HTTP server sends no body for HEAD).
    for (const [url, status] of [
      ['/cases/DFW08TA066', 200],
      ['/cases/ZZZ99ZZ999', 404],
      ['/explore', 200],
      ['/no-such-page', 404],
    ] as const) {
      const r = await app.inject({ method: 'HEAD', url, remoteAddress: LOCAL });
      expect(r.statusCode, url).toBe(status);
      expect(r.headers['content-type'], url).toBe('text/html; charset=utf-8');
    }
  });

  it('case pages, the sitemaps and the API each have a limit of their own; case pages and the sitemaps need a network identity; other pages do not', async () => {
    const limited = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 }, pageRateLimit: { limit: 2, windowMs: 60_000 }, sitemapRateLimit: { limit: 2, windowMs: 60_000 } });
    expect((await page('/cases/DFW08TA066', { app: limited })).status).toBe(200);
    expect((await page('/cases/ZZZ99ZZ999', { app: limited })).status).toBe(404);
    // The sitemaps' allowance is apart from the case pages': both of its requests go through.
    expect((await get('/sitemap.xml', { app: limited })).status).toBe(200);
    expect((await get('/sitemaps/pages.xml', { app: limited })).status).toBe(200);
    expect((await get('/sitemaps/pages.xml', { app: limited })).status).toBe(429);
    // The case pages' allowance is used up: a refused page request gets the page with 429, noindex, and Retry-After.
    const refused = await page('/cases/DFW08TA066', { app: limited });
    expect(refused.status).toBe(429);
    expect(refused.body).toContain('<div id="root">');
    expect(headOf(refused)).toMatchObject({ title: 'NTSB DFW08TA066 · AirCase', robots: 'noindex', canonical: null, ld: [] });
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await page('/cases/ZZZ99ZZ999', { app: limited })).status).toBe(429);
    // Crawling did not use the API's allowance, which still refuses past its own limit.
    expect((await get('/api/cases/DFW08TA066', { app: limited })).status).toBe(200);
    expect((await get('/api/cases/DFW08TA066', { app: limited })).status).toBe(200);
    const api = await get('/api/cases/DFW08TA066', { app: limited });
    expect(api.status).toBe(429);
    const body = ErrorResponseSchema.parse(api.json);
    expect(body.error).toBe('rate_limited');
    expect(api.headers['retry-after']).toBe(String(body.retryAfter));
    // The other pages, robots.txt and the files are not limited.
    for (const url of ['/', '/explore?q=carb', '/about', '/no-such-page', '/robots.txt', '/assets/app-0123abcd.js']) {
      expect((await page(url, { app: limited })).status, url).toBeLessThan(429);
    }
    // Tunnel mode: the case page needs the client address, like the API; the other pages do not.
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['203.0.113.0/28'] } });
    const anonymous = await page('/cases/DFW08TA066', { app: tunnel, from: '203.0.113.2' });
    expect(anonymous.status).toBe(400);
    expect(ErrorResponseSchema.parse(anonymous.json).error).toBe('bad_request');
    expect((await page('/cases/DFW08TA066', { app: tunnel, from: '203.0.113.2', headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(200);
    expect((await page('/explore', { app: tunnel, from: '203.0.113.2' })).status).toBe(200);
  });

  it('X-Robots-Tag: outside live every response is noindex, nofollow; on live the API is noindex', async () => {
    for (const url of ['/', '/cases/DFW08TA066', '/cases/dfw08ta066', '/no-such-page', '/api/config', '/api/nope', '/assets/app-0123abcd.js', '/missing.js', '/robots.txt', '/sitemap.xml', '/%E0%A4%A']) {
      expect((await page(url)).headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
    const live = makeApp({ config: { appUrl: 'https://aircase.example', trustedProxyCidrs: [], appEnv: 'live' } });
    for (const url of ['/api/config', '/api/nope', '/api/cases/DFW08TA066', '/%61pi/nope', '/api/%ZZ']) {
      expect((await page(url, { app: live })).headers['x-robots-tag'], url).toBe('noindex');
    }
    for (const url of ['/', '/cases/DFW08TA066', '/explore?q=carb', '/no-such-page', '/assets/app-0123abcd.js', '/robots.txt', '/sitemap.xml']) {
      expect((await page(url, { app: live })).headers['x-robots-tag'], url).toBeUndefined();
    }
  });

  it('robots.txt keeps crawlers out outside live, and on live points them to the sitemap', async () => {
    const dev = await get('/robots.txt');
    expect(dev.status).toBe(200);
    expect(dev.body).toBe('User-agent: *\nDisallow: /\n');
    expect(dev.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(dev.headers['cache-control']).toBe('public, max-age=3600');
    const live = makeApp({ config: { appUrl: 'https://aircase.example', trustedProxyCidrs: [], appEnv: 'live' } });
    expect((await get('/robots.txt', { app: live })).body).toBe('User-agent: *\nAllow: /\n\nSitemap: https://aircase.example/sitemap.xml\n');
  });

  it('the sitemaps list the pages and the canonical page of every case in the default cohort, with the snapshot date', async () => {
    const config = ConfigResponseSchema.parse((await get('/api/config')).json);
    const g = dataset.generationId;
    const cohort = ((await appDb.execute(sql`select ntsb_no from cases where generation_id = ${g} and is_us and answer_eligible`)).rows as { ntsb_no: string }[])
      .map((r) => r.ntsb_no)
      .sort();
    const [{ total } = { total: 0 }] = (await appDb.execute(sql`select count(*)::int as total from cases where generation_id = ${g}`)).rows as { total: number }[];
    // The fixtures hold other records too (other statuses, other countries): they are not listed.
    expect(cohort.length).toBeGreaterThan(5);
    expect(total).toBeGreaterThan(cohort.length);

    const index = await get('/sitemap.xml');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(index.headers['cache-control']).toBe('public, max-age=3600');
    expect(locs(parseXml(index.body))).toEqual([`${ORIGIN}/sitemaps/pages.xml`, `${ORIGIN}/sitemaps/cases-1.xml`]);
    expect(locs(parseXml((await get('/sitemaps/pages.xml')).body))).toEqual(['/', '/explore', '/dashboard', '/about', '/privacy'].map((p) => `${ORIGIN}${p}`));
    const cases = await get('/sitemaps/cases-1.xml');
    expect(cases.headers['content-type']).toBe('application/xml; charset=utf-8');
    const doc = parseXml(cases.body);
    expect(locs(doc)).toEqual(cohort.map((n) => `${ORIGIN}/cases/${n}`));
    expect(new Set([...doc.getElementsByTagName('lastmod')].map((l) => l.textContent))).toEqual(new Set([config.snapshotDate]));
    // Every listed address is the canonical, served page.
    for (const n of cohort) expect((await page(`/cases/${n}`)).status, n).toBe(200);
    for (const url of ['/sitemaps/cases-2.xml', '/sitemaps/cases-0.xml', '/sitemaps/other.xml']) expect((await get(url)).status, url).toBe(404);

    // Files of at most `sitemapUrlLimit` URLs (10,000 by default).
    const small = makeApp({ sitemapUrlLimit: 5 });
    const files = Math.ceil(cohort.length / 5);
    expect(locs(parseXml((await get('/sitemap.xml', { app: small })).body))).toHaveLength(1 + files);
    const chunks: string[] = [];
    for (let n = 1; n <= files; n++) chunks.push(...locs(parseXml((await get(`/sitemaps/cases-${n}.xml`, { app: small })).body)));
    expect(chunks).toEqual(cohort.map((n) => `${ORIGIN}/cases/${n}`));
    expect((await get(`/sitemaps/cases-${files + 1}.xml`, { app: small })).status).toBe(404);
  });

  it('while no dataset can be served, the index lists the pages only, case sitemaps are 404 and a case page is the page with 503', async () => {
    const mapping = await es.indices.getMapping({ index: dataset.casesIndex });
    const current = mapping[dataset.casesIndex]?.mappings._meta ?? {};
    try {
      // A fingerprint this server does not serve: the dataset is unavailable (server/dataset.ts).
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: { ...current, fingerprint: 'not-a-servable-fingerprint' } });
      const broken = makeApp();
      const index = await get('/sitemap.xml', { app: broken });
      expect(index.status).toBe(200);
      expect(locs(parseXml(index.body))).toEqual([`${ORIGIN}/sitemaps/pages.xml`]);
      expect((await get('/sitemaps/pages.xml', { app: broken })).status).toBe(200);
      expect((await get('/sitemaps/cases-1.xml', { app: broken })).status).toBe(404);
      // A case page is the page with 503, noindex; the API keeps its ErrorResponse.
      const unavailable = await page('/cases/DFW08TA066', { app: broken });
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toContain('<div id="root">');
      expect(headOf(unavailable)).toMatchObject({ title: 'NTSB DFW08TA066 · AirCase', robots: 'noindex', canonical: null, ld: [] });
      expect(unavailable.headers['cache-control']).toBe('no-store');
      const api = await get('/api/cases/DFW08TA066', { app: broken });
      expect(api.status).toBe(503);
      expect(ErrorResponseSchema.parse(api.json).error).toBe('unavailable');
      // Pages without data are still served.
      expect((await page('/explore', { app: broken })).status).toBe(200);
    } finally {
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: current });
    }
    expect((await get('/sitemaps/cases-1.xml', { app: makeApp() })).status).toBe(200);
  });
});
