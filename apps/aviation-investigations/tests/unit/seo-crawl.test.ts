/**
 * What crawlers read besides the pages: robots.txt per environment (server/seo/robots.ts) and
 * the sitemaps (server/seo/sitemaps.ts): well-formed XML, the default cohort only, sorted,
 * chunked (a lowered limit stands in for the 10,000 URLs of a file), built once per dataset.
 */
import { describe, expect, it, vi } from 'vitest';
import { robotsTxt } from '../../server/seo/robots.js';
import { MAX_SITEMAP_URLS, SitemapStore, buildSitemaps, sitemapFile, type SitemapCase } from '../../server/seo/sitemaps.js';
import { parseXml, type MarkupDocument } from '../support/markup.js';

const ORIGIN = 'https://aircase.app';

describe('robots.txt', () => {
  it('on live: everything allowed, and where the sitemap is', () => {
    expect(robotsTxt({ live: true, origin: ORIGIN })).toBe('User-agent: *\nAllow: /\n\nSitemap: https://aircase.app/sitemap.xml\n');
  });

  it('anywhere else: nothing may be crawled', () => {
    expect(robotsTxt({ live: false, origin: 'https://dev.example' })).toBe('User-agent: *\nDisallow: /\n');
  });

  it('never disallows the API, which search engines call to render the pages', () => {
    expect(robotsTxt({ live: true, origin: ORIGIN })).not.toContain('/api');
  });
});

/** Parses XML strictly (jsdom throws on a document that is not well-formed). */
function xml(text: string): MarkupDocument {
  expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  return parseXml(text);
}

const locs = (doc: MarkupDocument): string[] => [...doc.getElementsByTagName('loc')].map((l) => l.textContent ?? '');

function record(ntsbNo: string, over: Partial<SitemapCase> = {}): SitemapCase {
  return { ntsbNo, isUs: true, completionClass: 'completed', hasProbableCause: true, ...over };
}

const DATASET = {
  snapshotDate: '2026-10-01',
  cases: [
    record('WPR24FA190'),
    record('CEN09CA566'),
    // Not in the default cohort: another country, no probable-cause text, another status.
    record('ENG08WA029', { isUs: false }),
    record('CEN22LA442', { completionClass: 'other_status', hasProbableCause: false }),
    record('CEN23LA137', { completionClass: 'other_status' }),
    record('ANC15LA005'),
    record('ERA25LA016', { hasProbableCause: false }),
  ],
};

describe('sitemaps', () => {
  it('the index lists the pages and each case file; every file is well-formed XML in the sitemap namespace', () => {
    const maps = buildSitemaps({ origin: ORIGIN, dataset: DATASET });
    const index = xml(maps.index);
    expect(index.documentElement.tagName).toBe('sitemapindex');
    expect(index.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(locs(index)).toEqual(['https://aircase.app/sitemaps/pages.xml', 'https://aircase.app/sitemaps/cases-1.xml']);
    const pages = xml(maps.pages);
    expect(pages.documentElement.tagName).toBe('urlset');
    expect(pages.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(locs(pages)).toEqual([
      'https://aircase.app/',
      'https://aircase.app/explore',
      'https://aircase.app/dashboard',
      'https://aircase.app/about',
      'https://aircase.app/privacy',
    ]);
  });

  it('lists the default cohort only (US, completed, with probable-cause text), sorted by NTSB number, with the snapshot date', () => {
    const maps = buildSitemaps({ origin: ORIGIN, dataset: DATASET });
    const doc = xml(sitemapFile(maps, 'cases-1.xml') ?? '');
    expect(locs(doc)).toEqual([
      'https://aircase.app/cases/ANC15LA005',
      'https://aircase.app/cases/CEN09CA566',
      'https://aircase.app/cases/WPR24FA190',
    ]);
    const lastmods = [...doc.getElementsByTagName('lastmod')].map((l) => l.textContent);
    expect(lastmods).toEqual(['2026-10-01', '2026-10-01', '2026-10-01']);
  });

  it(`chunks at ${MAX_SITEMAP_URLS.toLocaleString('en-US')} URLs a file (here 2)`, () => {
    expect(MAX_SITEMAP_URLS).toBe(10_000);
    const cases = ['E5', 'A1', 'C3', 'B2', 'D4'].map((n) => record(`AAA${n}`));
    const maps = buildSitemaps({ origin: ORIGIN, dataset: { snapshotDate: '2026-10-01', cases }, urlLimit: 2 });
    expect(locs(xml(maps.index))).toEqual([
      'https://aircase.app/sitemaps/pages.xml',
      'https://aircase.app/sitemaps/cases-1.xml',
      'https://aircase.app/sitemaps/cases-2.xml',
      'https://aircase.app/sitemaps/cases-3.xml',
    ]);
    expect(locs(xml(sitemapFile(maps, 'cases-1.xml') ?? ''))).toEqual(['https://aircase.app/cases/AAAA1', 'https://aircase.app/cases/AAAB2']);
    expect(locs(xml(sitemapFile(maps, 'cases-2.xml') ?? ''))).toEqual(['https://aircase.app/cases/AAAC3', 'https://aircase.app/cases/AAAD4']);
    expect(locs(xml(sitemapFile(maps, 'cases-3.xml') ?? ''))).toEqual(['https://aircase.app/cases/AAAE5']);
  });

  it('an unknown file is none: past the last case file, number 0, leading zeros, other names', () => {
    const maps = buildSitemaps({ origin: ORIGIN, dataset: DATASET });
    expect(sitemapFile(maps, 'pages.xml')).toBe(maps.pages);
    for (const name of ['cases-2.xml', 'cases-0.xml', 'cases-01.xml', 'cases-1', 'cases-1.xml.gz', 'other.xml', '']) {
      expect(sitemapFile(maps, name), name).toBeNull();
    }
  });

  it('without a dataset it lists the pages only, and no case file exists', () => {
    const maps = buildSitemaps({ origin: ORIGIN, dataset: null });
    expect(locs(xml(maps.index))).toEqual(['https://aircase.app/sitemaps/pages.xml']);
    expect(sitemapFile(maps, 'cases-1.xml')).toBeNull();
    expect(locs(xml(maps.pages))).toHaveLength(5);
  });

  it('an empty cohort has no case file', () => {
    const maps = buildSitemaps({ origin: ORIGIN, dataset: { snapshotDate: '2026-10-01', cases: [record('X1234', { isUs: false })] } });
    expect(locs(xml(maps.index))).toEqual(['https://aircase.app/sitemaps/pages.xml']);
  });

  it('escapes what XML needs escaped in an address', () => {
    const maps = buildSitemaps({ origin: 'https://a.example', dataset: { snapshotDate: '2026-10-01', cases: [record('ABCDE')] } });
    expect(locs(xml(maps.index))[0]).toBe('https://a.example/sitemaps/pages.xml');
    expect(buildSitemaps({ origin: 'https://x&y.example', dataset: null }).index).toContain('https://x&amp;y.example/sitemaps/pages.xml');
  });
});

describe('the sitemap store', () => {
  const dataset = (revision: string, generationId = 7) => ({ revision, generationId, snapshotDate: '2026-10-01' });

  it('builds once per dataset revision and again when the manifest changes', async () => {
    const readCases = vi.fn(async (generationId: number) => [record(`GEN${generationId}A`)]);
    const store = new SitemapStore({ origin: ORIGIN, readCases });
    const first = await store.of(dataset('g7-cases-v3-aaaa'));
    expect(await store.of(dataset('g7-cases-v3-aaaa'))).toBe(first);
    expect(readCases).toHaveBeenCalledTimes(1);
    const next = await store.of(dataset('g8-cases-v3-bbbb', 8));
    expect(readCases).toHaveBeenCalledTimes(2);
    expect(locs(xml(sitemapFile(next, 'cases-1.xml') ?? ''))).toEqual(['https://aircase.app/cases/GEN8A']);
  });

  it('concurrent requests share one build, and a failed build is tried again', async () => {
    let fail = true;
    const readCases = vi.fn(async () => {
      if (fail) throw new Error('database unavailable');
      return [record('ABCDE')];
    });
    const store = new SitemapStore({ origin: ORIGIN, readCases });
    const results = await Promise.allSettled([store.of(dataset('r1')), store.of(dataset('r1'))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(readCases).toHaveBeenCalledTimes(1);
    fail = false;
    expect(locs(xml((await store.of(dataset('r1'))).index))).toHaveLength(2);
    expect(readCases).toHaveBeenCalledTimes(2);
  });

  it('has the pages-only sitemaps ready for when no dataset can be served', () => {
    const store = new SitemapStore({ origin: ORIGIN, readCases: async () => [] });
    expect(locs(xml(store.withoutCases.index))).toEqual(['https://aircase.app/sitemaps/pages.xml']);
  });
});
