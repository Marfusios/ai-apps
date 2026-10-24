/**
 * Every route's tab title, built once: the web client's pages render it in `<title>`, and the
 * server puts the same text in the head of the page it sends (server/seo/head.ts), so a page
 * has one title before and after the script runs. The client's own states (a page that failed,
 * an expired brief) keep their titles in the client.
 */
import type { CaseDetail } from './contracts/cases.js';
import { PRODUCT_LONG_NAME, documentTitle } from './brand.js';

export type TitledPage =
  | { kind: 'home' | 'dashboard' | 'account' | 'about' | 'privacy' | 'brief' | 'evidence' | 'not_found' }
  /** `q`: the search request's query, as the page reads it from the URL (shared/page-params.ts). */
  | { kind: 'explore'; q: string }
  /** `count`: the compared cases (`readCompare`). */
  | { kind: 'compare'; count: number }
  /** `detail`: null while the case loads, or when no case has that number. */
  | { kind: 'case'; ntsbNo: string; detail: Pick<CaseDetail, 'headline' | 'date'> | null };

/** "Comparing 1 case", "Comparing 4 cases": Compare's heading and its title. */
export function compareHeading(count: number): string {
  return `Comparing ${count} ${count === 1 ? 'case' : 'cases'}`;
}

/**
 * A case's own part: its headline and the event year, "Piper PA-28-235, total loss of engine
 * power on final near Montevideo, Minnesota (2026)"; the year is left out when no date is recorded.
 */
function caseName(detail: Pick<CaseDetail, 'headline' | 'date'>): string {
  const year = detail.date?.slice(0, 4);
  return year ? `${detail.headline} (${year})` : detail.headline;
}

export function pageTitle(page: TitledPage): string {
  switch (page.kind) {
    case 'home':
      return PRODUCT_LONG_NAME;
    case 'explore': {
      const q = page.q.trim();
      return q ? documentTitle(`“${q}”`, 'Explore') : documentTitle('Explore');
    }
    case 'dashboard':
      return documentTitle('The record, in questions');
    case 'case':
      return page.detail ? documentTitle(caseName(page.detail), `NTSB ${page.ntsbNo}`) : documentTitle(`NTSB ${page.ntsbNo}`);
    case 'compare':
      return documentTitle(compareHeading(page.count));
    case 'account':
      return documentTitle('Account');
    case 'about':
      return documentTitle('About');
    case 'privacy':
      return documentTitle('Privacy');
    case 'brief':
      return documentTitle('AI brief');
    case 'evidence':
      return documentTitle('AI search');
    case 'not_found':
      return documentTitle('Page not found');
  }
}
