/**
 * The sitemaps (README, "Search engines and link previews"): `/sitemap.xml` is an index of
 * `/sitemaps/pages.xml` (the indexable pages without data of their own) and
 * `/sitemaps/cases-{n}.xml` (n from 1, at most `MAX_SITEMAP_URLS` URLs each): the canonical
 * case page of every case in the active dataset's default cohort (US investigations completed
 * with probable-cause text, Explore's default view), sorted by NTSB number, each with the
 * snapshot date as `<lastmod>`. Other records keep their indexable pages but are not listed.
 *
 * The files are built once per dataset revision and kept in memory (`SitemapStore`); a new
 * active manifest builds them again. While no dataset can be served the index lists the pages
 * only (`SitemapStore.withoutCases`).
 */
import { eq } from 'drizzle-orm';
import { isAnswerEligible, type CompletionClass } from '../../shared/completion.js';
import type { Db } from '../db/client.js';
import { cases } from '../db/schema/index.js';

/** URLs per case sitemap: below the protocol's 50,000, so each file stays small. */
export const MAX_SITEMAP_URLS = 10_000;

/** The indexable pages without data of their own, in the order the pages sitemap lists them. */
export const SITEMAP_PAGES: readonly string[] = ['/', '/explore', '/dashboard', '/about', '/privacy'];

/** What a case's place in the sitemaps depends on. */
export interface SitemapCase {
  ntsbNo: string;
  isUs: boolean;
  completionClass: CompletionClass;
  hasProbableCause: boolean;
}

export interface Sitemaps {
  /** `/sitemap.xml`. */
  index: string;
  /** `/sitemaps/pages.xml`. */
  pages: string;
  /** `/sitemaps/cases-1.xml` onwards. */
  cases: readonly string[];
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const XML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] as string);

function urlset(urls: readonly { loc: string; lastmod?: string }[]): string {
  const entries = urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : ''}</url>`);
  return `${XML_DECLARATION}<urlset xmlns="${SITEMAP_NS}">\n${entries.join('\n')}\n</urlset>\n`;
}

function sitemapIndex(locs: readonly string[]): string {
  const entries = locs.map((loc) => `  <sitemap><loc>${escapeXml(loc)}</loc></sitemap>`);
  return `${XML_DECLARATION}<sitemapindex xmlns="${SITEMAP_NS}">\n${entries.join('\n')}\n</sitemapindex>\n`;
}

/** Code-unit order: NTSB numbers are upper-case letters and digits, so this is their plain order. */
const byNumber = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The sitemaps on `origin` (APP_URL's origin). `dataset` null: no dataset can be served, so the
 * index lists the pages only. `urlLimit` lowers the URLs per case file (tests).
 */
export function buildSitemaps(opts: {
  origin: string;
  dataset: { snapshotDate: string; cases: readonly SitemapCase[] } | null;
  urlLimit?: number;
}): Sitemaps {
  const { origin } = opts;
  const limit = opts.urlLimit ?? MAX_SITEMAP_URLS;
  const pages = urlset(SITEMAP_PAGES.map((path) => ({ loc: `${origin}${path}` })));
  const numbers = (opts.dataset?.cases ?? [])
    .filter((c) => isAnswerEligible(c))
    .map((c) => c.ntsbNo)
    .sort(byNumber);
  const lastmod = opts.dataset?.snapshotDate;
  const files: string[] = [];
  for (let i = 0; i < numbers.length; i += limit) {
    files.push(urlset(numbers.slice(i, i + limit).map((n) => ({ loc: `${origin}/cases/${n}`, ...(lastmod ? { lastmod } : {}) }))));
  }
  const index = sitemapIndex([`${origin}/sitemaps/pages.xml`, ...files.map((_, i) => `${origin}/sitemaps/cases-${i + 1}.xml`)]);
  return { index, pages, cases: files };
}

/** The file `/sitemaps/{name}` names, or null: `pages.xml`, or `cases-{n}.xml` with n from 1 to the last. */
export function sitemapFile(sitemaps: Sitemaps, name: string): string | null {
  if (name === 'pages.xml') return sitemaps.pages;
  const n = /^cases-([1-9]\d{0,5})\.xml$/.exec(name)?.[1];
  return n === undefined ? null : (sitemaps.cases[Number(n) - 1] ?? null);
}

/** Every case of a generation with what decides its place in the sitemaps (filtered by `buildSitemaps`). */
export async function readSitemapCases(db: Db, generationId: number): Promise<SitemapCase[]> {
  return db
    .select({ ntsbNo: cases.ntsbNo, isUs: cases.isUs, completionClass: cases.completionClass, hasProbableCause: cases.hasProbableCause })
    .from(cases)
    .where(eq(cases.generationId, generationId));
}

/** The sitemaps of the active dataset, built once per dataset and kept in memory. */
export class SitemapStore {
  /** For while no dataset can be served: the pages only. */
  readonly withoutCases: Sitemaps;
  private built: { key: string; sitemaps: Promise<Sitemaps> } | null = null;

  constructor(
    private readonly opts: {
      origin: string;
      readCases: (generationId: number) => Promise<SitemapCase[]>;
      urlLimit?: number;
    },
  ) {
    this.withoutCases = buildSitemaps({ origin: opts.origin, dataset: null, ...(opts.urlLimit ? { urlLimit: opts.urlLimit } : {}) });
  }

  /** The sitemaps of `dataset` (the active manifest's): the ones built for its revision, or new ones. */
  of(dataset: { revision: string; generationId: number; snapshotDate: string }): Promise<Sitemaps> {
    const key = `${dataset.revision}|${dataset.snapshotDate}`;
    if (this.built?.key !== key) {
      const sitemaps = this.opts.readCases(dataset.generationId).then((list) =>
        buildSitemaps({
          origin: this.opts.origin,
          dataset: { snapshotDate: dataset.snapshotDate, cases: list },
          ...(this.opts.urlLimit ? { urlLimit: this.opts.urlLimit } : {}),
        }),
      );
      const entry = { key, sitemaps };
      this.built = entry;
      // A build that failed is tried again by the next request.
      sitemaps.catch(() => {
        if (this.built === entry) this.built = null;
      });
    }
    return (this.built as { sitemaps: Promise<Sitemaps> }).sitemaps;
  }
}
