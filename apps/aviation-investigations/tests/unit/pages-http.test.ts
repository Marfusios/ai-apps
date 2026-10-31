/**
 * The page routes over HTTP without a database (server/routes/pages.ts, server/app.ts):
 * redirects of page paths in the wrong letter case and of `/index.html`, case and brief paths
 * too long for the router, and pages that are refused or fail, which go out as the page with
 * that status while the API keeps its ErrorResponse. The database read of a case page is
 * replaced by one that throws.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../server/app.js';
import { unmatchedPage } from '../../server/routes/pages.js';
import type { Db } from '../../server/db/client.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { parseHtml } from '../support/markup.js';

const BRIEF_ID = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
const TEMPLATE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="description" content="x" /><title>AirCase · aviation casebook</title></head><body><div id="root"></div></body></html>';

let webRoot: string;
const apps: FastifyInstance[] = [];

/** A database whose every read throws `err` (the dataset resolver's first read). */
const failingDb = (err: Error): Db => ({ select: () => { throw err; } }) as unknown as Db;

function makeApp(overrides: Partial<AppDeps> = {}): FastifyInstance {
  const app = buildApp({
    config: { appUrl: 'https://aircase.example', trustedProxyCidrs: [] },
    db: failingDb(new TypeError('not a database')),
    es: {} as Client,
    webRoot,
    ...overrides,
  });
  apps.push(app);
  return app;
}

const page = (app: FastifyInstance, url: string, accept = 'text/html', method: 'GET' | 'HEAD' = 'GET'): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, remoteAddress: '203.0.113.7', headers: { accept } });

function headOf(r: LightMyRequestResponse) {
  const doc = parseHtml(r.body);
  return {
    title: doc.title,
    robots: doc.head.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
    description: doc.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
    canonical: doc.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    jsonLd: doc.querySelectorAll('script[type="application/ld+json"]').length,
  };
}

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), 'aircase-pages-'));
  writeFileSync(join(webRoot, 'index.html'), TEMPLATE);
});

afterAll(async () => {
  for (const app of apps) await app.close();
  rmSync(webRoot, { recursive: true, force: true });
});

describe('page paths in the wrong letter case, and /index.html', () => {
  it.each([
    ['/About', '/about'],
    ['/EXPLORE?q=carburetor', '/explore'],
    ['/Explore/', '/explore'],
    ['/DashBoard', '/dashboard'],
    ['/PRIVACY', '/privacy'],
    ['/Compare?cases=DFW08TA066', '/compare'],
    ['/Account', '/account'],
    ['/Cases/DFW08TA066', '/cases/DFW08TA066'],
    ['/CASES/dfw08ta066?x=1', '/cases/dfw08ta066'],
    [`/BRIEFS/${BRIEF_ID}?step=2`, `/briefs/${BRIEF_ID}`],
    [`/AI/${BRIEF_ID}?page=2`, `/ai/${BRIEF_ID}`],
    ['/index.html', '/'],
    ['/index.html?utm_source=x', '/'],
  ])('%s is 301 to %s, the query dropped', async (url, location) => {
    const r = await page(makeApp(), url);
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe(location);
  });

  it('a parameter is put into the redirect encoded: the target is always a path of the site', async () => {
    const app = makeApp();
    const r = await page(app, '/Cases/%3Cscript%3E%20x');
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('/cases/%3Cscript%3E%20x');
    // Encoded slashes make more segments: no page, so no redirect at all.
    expect((await page(app, '/Cases/%2F%2Fevil.example')).statusCode).toBe(404);
    expect((await page(app, '//About')).statusCode).toBe(404);
  });

  it('other paths stay 404 pages, and requests that take no page get the plain 404', async () => {
    const app = makeApp();
    for (const url of ['/Nope', '/about-us', '/About/more', '/cases', '/INDEX.HTML']) {
      const r = await page(app, url);
      expect(r.statusCode, url).toBe(404);
      if (url === '/INDEX.HTML') expect(r.body).toBe('Not found');
      else expect(headOf(r), url).toMatchObject({ title: 'Page not found · AirCase', robots: 'noindex' });
    }
    for (const url of ['/About', '/index.html']) {
      const r = await page(app, url, 'application/json');
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).toBe('Not found');
    }
  });
});

describe('case and brief paths too long for the router', () => {
  const long = 'x'.repeat(65);

  it('a case number too long for the router is a missing case: 404, titled with the number like the client', async () => {
    const app = makeApp();
    for (const url of [`/cases/${long}`, `/cases/${long}/`]) {
      const r = await page(app, url);
      expect(r.statusCode, url).toBe(404);
      expect(headOf(r), url).toEqual({
        title: `NTSB ${long.toUpperCase()} · AirCase`,
        robots: 'noindex',
        description: 'No investigation has that number.',
        canonical: null,
        jsonLd: 0,
      });
    }
  });

  it('a search id too long for the router is the AI search page, like any other id (Task 23)', async () => {
    const app = makeApp();
    const r = await page(app, `/ai/${long}`);
    expect(r.statusCode).toBe(200);
    expect(headOf(r)).toMatchObject({ title: 'AI search · AirCase', robots: 'noindex, nofollow', canonical: `https://aircase.example/ai/${long}` });
    const slash = await page(app, `/ai/${long}/`);
    expect(slash.statusCode).toBe(301);
    expect(slash.headers.location).toBe(`/ai/${long}`);
  });

  it('a brief id too long for the router is the brief page, like any other id', async () => {
    const app = makeApp();
    const r = await page(app, `/briefs/${long}`);
    expect(r.statusCode).toBe(200);
    expect(headOf(r)).toMatchObject({ title: 'AI brief · AirCase', robots: 'noindex, nofollow', canonical: `https://aircase.example/briefs/${long}` });
    const slash = await page(app, `/briefs/${long}/`);
    expect(slash.statusCode).toBe(301);
    expect(slash.headers.location).toBe(`/briefs/${long}`);
  });
});

describe('a page request that is refused or fails gets the page with that status; the API its ErrorResponse', () => {
  function expectFailedPage(r: LightMyRequestResponse, status: number, description: string): void {
    expect(r.statusCode).toBe(status);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers['content-security-policy'])).toMatch(/style-src 'self' 'nonce-/);
    expect(r.body).toContain('<div id="root">');
    expect(headOf(r)).toEqual({ title: 'NTSB DFW08TA066 · AirCase', robots: 'noindex', description, canonical: null, jsonLd: 0 });
  }

  it('500: the case could not be read for an unexpected reason', async () => {
    const app = makeApp();
    expectFailedPage(await page(app, '/cases/DFW08TA066'), 500, 'Something went wrong on our side.');
    const head = await page(app, '/cases/DFW08TA066', 'text/html', 'HEAD');
    expect(head.statusCode).toBe(500);
    const api = await page(app, '/api/cases/DFW08TA066', 'application/json');
    expect(api.statusCode).toBe(500);
    expect(ErrorResponseSchema.parse(api.json())).toEqual({ error: 'internal', message: 'Something went wrong on our side.' });
  });

  it('503: the database is unavailable', async () => {
    const app = makeApp({ db: failingDb(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })) });
    expectFailedPage(await page(app, '/cases/dfw08ta066'), 503, 'The service is temporarily unavailable. Try again shortly.');
    const api = await page(app, '/api/cases/DFW08TA066', '*/*');
    expect(api.statusCode).toBe(503);
    expect(ErrorResponseSchema.parse(api.json()).error).toBe('unavailable');
    // A request that takes no page keeps the plain 404 of a page route, before any read.
    expect((await page(app, '/cases/DFW08TA066', 'application/json')).body).toBe('Not found');
  });

  it('429: refused by the pages’ own limit, with Retry-After; the API keeps its allowance', async () => {
    const app = makeApp({ rateLimit: { limit: 1, windowMs: 60_000 }, pageRateLimit: { limit: 1, windowMs: 60_000 } });
    expect((await page(app, '/cases/DFW08TA066')).statusCode).toBe(500);
    const refused = await page(app, '/cases/DFW08TA066');
    expectFailedPage(refused, 429, 'Too many requests. Wait a moment and try again.');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // The API's own bucket was not used by the case pages: its first request reaches the handler.
    expect((await page(app, '/api/cases/DFW08TA066', 'application/json')).statusCode).not.toBe(429);
    const api = await page(app, '/api/cases/DFW08TA066', 'application/json');
    expect(api.statusCode).toBe(429);
    expect(ErrorResponseSchema.parse(api.json()).retryAfter).toBe(Number(api.headers['retry-after']));
    // Pages without a database read are not limited.
    expect((await page(app, '/explore')).statusCode).toBe(200);
  });
});

describe('unmatchedPage reads a path in linear time (re-review of fix round 1)', () => {
  it('classifies a long run of slashes followed by another character in milliseconds', () => {
    const path = `/x${'/'.repeat(50_000)}y`;
    const start = performance.now();
    expect(unmatchedPage(path)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('still ignores trailing slashes', () => {
    expect(unmatchedPage('/About///')).toEqual({ redirect: '/about' });
    expect(unmatchedPage('///')).toBeNull();
  });
});

it('serves the canonical AI search page privately without a database read or private head text', async () => {
  const app = makeApp();
  const r = await page(app, `/ai/${BRIEF_ID}?question=SECRET&page=2`);
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(headOf(r)).toMatchObject({ title: 'AI search · AirCase', robots: 'noindex, nofollow', canonical: `https://aircase.example/ai/${BRIEF_ID}`, jsonLd: 0 });
  expect(r.body).not.toContain('SECRET');
  expect((await page(app, `/ai/${BRIEF_ID}`, 'text/html', 'HEAD')).headers['cache-control']).toBe('private, no-store');
  expect((await page(app, `/evidence/${BRIEF_ID}`)).statusCode).toBe(404);
});
