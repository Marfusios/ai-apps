/**
 * The head the server builds for each page (server/seo/head.ts): status, robots, canonical,
 * title, description, Open Graph, Twitter and JSON-LD per route, escaping of untrusted NTSB
 * text, and the page template it goes into. Case records come from the mock API's fixture
 * projection (web/mock/cases.json); expected strings are written out.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { pageTitle } from '../../shared/page-titles.js';
import {
  caseDescription,
  injuryPhrase,
  jsonLd,
  pageHead,
  pagePolicy,
  renderPage,
  splitTemplate,
  truncateAtWord,
  type PageRoute,
} from '../../server/seo/head.js';
import cases from '../../web/mock/cases.json' with { type: 'json' };
import { APP_DIR } from '../support/extract-dir.js';
import { HOSTILE_COMPARES, HOSTILE_SEARCHES } from '../support/hostile-queries.js';
import { parseHtml } from '../support/markup.js';

const ORIGIN = 'https://aircase.app';
const SOURCE_TEMPLATE = readFileSync(join(APP_DIR, 'web/index.html'), 'utf8');
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAAAA';

function fixture(ntsbNo: string): CaseDetail {
  const detail = (cases as unknown as Record<string, CaseDetail>)[ntsbNo];
  if (!detail) throw new Error(`no fixture ${ntsbNo}`);
  return structuredClone(detail);
}

/** The whole page for a route, parsed as a browser would. */
function parsed(route: PageRoute, template = SOURCE_TEMPLATE) {
  const html = renderPage(splitTemplate(template), pageHead(route, ORIGIN), NONCE);
  const document = parseHtml(html);
  const meta = (attr: 'name' | 'property', key: string): string | null =>
    document.head.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;
  const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  return {
    html,
    document,
    title: document.title,
    titles: document.querySelectorAll('title').length,
    description: meta('name', 'description'),
    descriptions: document.querySelectorAll('meta[name="description"]').length,
    robots: meta('name', 'robots'),
    canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    meta,
    ld: ldScripts.map((s) => JSON.parse(s.textContent ?? '') as unknown),
  };
}

const VALENTINE = 'Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas';

describe('statuses, robots and canonicals per route', () => {
  const table: ReadonlyArray<readonly [string, PageRoute, number, string, string | null]> = [
    ['/', { kind: 'home' }, 200, 'index, follow', '/'],
    ['/explore', { kind: 'explore', query: new URLSearchParams() }, 200, 'index, follow', '/explore'],
    ['/explore?q=x', { kind: 'explore', query: new URLSearchParams('q=x') }, 200, 'noindex, follow', '/explore'],
    ['/explore?q=', { kind: 'explore', query: new URLSearchParams('q=') }, 200, 'noindex, follow', '/explore'],
    ['/explore?case=X', { kind: 'explore', query: new URLSearchParams('case=DFW08TA066') }, 200, 'noindex, follow', '/explore'],
    ['/dashboard', { kind: 'dashboard' }, 200, 'index, follow', '/dashboard'],
    ['/about', { kind: 'about' }, 200, 'index, follow', '/about'],
    ['/privacy', { kind: 'privacy' }, 200, 'index, follow', '/privacy'],
    ['/compare', { kind: 'compare', query: new URLSearchParams('cases=DFW08TA066') }, 200, 'noindex, nofollow', '/compare'],
    ['/account', { kind: 'account' }, 200, 'noindex, nofollow', '/account'],
    ['/briefs/:id', { kind: 'brief', id: '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f' }, 200, 'noindex, nofollow', '/briefs/0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f'],
    ['/cases/:ntsbNo served', { kind: 'case', detail: fixture('DFW08TA066') }, 200, 'index, follow', '/cases/DFW08TA066'],
    ['/cases/:ntsbNo not served', { kind: 'missing_case', requested: 'ZZZ99ZZ999' }, 404, 'noindex', null],
    ['anything else', { kind: 'not_found' }, 404, 'noindex', null],
  ];

  it.each(table)('%s: %i, %s, canonical %s', (_path, route, status, robots, canonicalPath) => {
    expect(pagePolicy(route)).toEqual({ status, robots, canonicalPath });
    const page = parsed(route);
    expect(page.robots).toBe(robots);
    expect(page.canonical).toBe(canonicalPath === null ? null : `${ORIGIN}${canonicalPath}`);
    // og:url is the canonical URL, and there is none without one.
    expect(page.meta('property', 'og:url')).toBe(page.canonical);
  });

  it('a brief id is put into its canonical URL encoded', () => {
    expect(pagePolicy({ kind: 'brief', id: 'a b/c' }).canonicalPath).toBe('/briefs/a%20b%2Fc');
  });
});

describe('titles: the shared ones the client renders (title parity)', () => {
  const table: ReadonlyArray<readonly [PageRoute, string]> = [
    [{ kind: 'home' }, 'AirCase · aviation casebook'],
    [{ kind: 'explore', query: new URLSearchParams() }, 'Explore · AirCase'],
    [{ kind: 'explore', query: new URLSearchParams('q=carburetor+icing&case=DFW08TA066') }, '“carburetor icing” · Explore · AirCase'],
    // Read leniently, as the client does: a bad facet value is dropped, the query kept.
    [{ kind: 'explore', query: new URLSearchParams('q=carb&phase=bogus') }, '“carb” · Explore · AirCase'],
    [{ kind: 'dashboard' }, 'The record, in questions · AirCase'],
    [{ kind: 'about' }, 'About · AirCase'],
    [{ kind: 'privacy' }, 'Privacy · AirCase'],
    [{ kind: 'compare', query: new URLSearchParams('cases=DFW08TA066,not-a-number,sea08la057') }, 'Comparing 2 cases · AirCase'],
    [{ kind: 'account' }, 'Account · AirCase'],
    [{ kind: 'brief', id: 'x' }, 'AI brief · AirCase'],
    [{ kind: 'case', detail: fixture('DFW08TA066') }, `${VALENTINE} (2008) · NTSB DFW08TA066 · AirCase`],
    [{ kind: 'missing_case', requested: 'zzz99zzz999' }, 'NTSB ZZZ99ZZZ999 · AirCase'],
    [{ kind: 'not_found' }, 'Page not found · AirCase'],
  ];

  it.each(table)('%j', (route, title) => {
    const page = parsed(route);
    expect(page.title).toBe(title);
    expect(page.titles).toBe(1);
  });

  it('equal the shared builder’s for the same inputs', () => {
    const detail = fixture('DFW08TA066');
    expect(parsed({ kind: 'case', detail }).title).toBe(pageTitle({ kind: 'case', ntsbNo: detail.ntsbNo, detail }));
    expect(parsed({ kind: 'missing_case', requested: 'ZZZ99ZZ999' }).title).toBe(pageTitle({ kind: 'case', ntsbNo: 'ZZZ99ZZ999', detail: null }));
    expect(parsed({ kind: 'explore', query: new URLSearchParams('q=icing') }).title).toBe(pageTitle({ kind: 'explore', q: 'icing' }));
    expect(parsed({ kind: 'compare', query: new URLSearchParams('cases=DFW08TA066') }).title).toBe(pageTitle({ kind: 'compare', count: 1 }));
  });
});

describe('descriptions', () => {
  it('static pages have their fixed descriptions, at most 160 characters', () => {
    const table: ReadonlyArray<readonly [PageRoute, string]> = [
      [{ kind: 'home' }, 'Find and compare NTSB aviation investigations by their evidence, findings and probable causes.'],
      [
        { kind: 'explore', query: new URLSearchParams('q=icing') },
        'Search NTSB aviation investigations by keyword, with filters for phase of flight, injury, weather, aircraft, operation, location and year.',
      ],
      [
        { kind: 'dashboard' },
        'Charts of the NTSB aviation investigation record: investigations by year, phase of flight, injury, weather, aircraft and location.',
      ],
      [
        { kind: 'about' },
        'About AirCase, an independent aviation casebook: what you can do with it, where its NTSB data comes from, what it is not and who built it.',
      ],
      [
        { kind: 'privacy' },
        'What AirCase keeps on your device and on its servers. No tracking or advertising cookies; searching, reading cases and comparing need no account.',
      ],
      [
        { kind: 'compare', query: new URLSearchParams() },
        'Compare up to four NTSB aviation investigations on one page, with their facts lined up and what is the same in all of them shown once.',
      ],
      [{ kind: 'account' }, 'Your AirCase account. Search, case pages, compare and the dashboard stay open without an account.'],
      [{ kind: 'brief', id: 'x' }, 'A private brief. It opens only for the person who asked the question.'],
      [{ kind: 'missing_case', requested: 'ZZZ99ZZ999' }, 'No investigation has that number.'],
      [{ kind: 'not_found' }, 'There is no page here.'],
    ];
    for (const [route, description] of table) {
      const page = parsed(route);
      expect(page.description, route.kind).toBe(description);
      expect(page.descriptions, route.kind).toBe(1);
      expect(description.length, route.kind).toBeLessThanOrEqual(160);
      // Open Graph and Twitter repeat the meta description.
      expect(page.meta('property', 'og:description'), route.kind).toBe(description);
      expect(page.meta('name', 'twitter:description'), route.kind).toBe(description);
    }
  });

  it('a case: type, number, date, aircraft and injuries, then the probable cause, cut at a word to 200 characters', () => {
    const text = caseDescription(fixture('DFW08TA066'));
    expect(text).toBe(
      "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries. Probable cause: The contract mechanic's failure to properly secure the castellated nut that attached the…",
    );
    expect(text.length).toBeLessThanOrEqual(200);
    expect(parsed({ kind: 'case', detail: fixture('DFW08TA066') }).description).toBe(text);
  });

  it('a short one is not cut, and several aircraft are joined with "and"', () => {
    expect(caseDescription(fixture('SEA08LA057'))).toBe(
      "NTSB accident investigation SEA08LA057, 1 Jan 2008: N8037W (Piper PA 28-180) and N15EX (Barnard/Stancil Glastar), no injuries. Probable cause: The departing pilot's inadequate visual lookout.",
    );
    expect(caseDescription(fixture('DCA25MA108'))).toMatch(
      /^NTSB accident investigation DCA25MA108, 30 Jan 2025: N709PS \(Bombardier CL-600-2C10\) and UNREG \(Sikorsky UH60\), 67 fatal\. Probable cause: The Federal Aviation Administration’s .+…$/,
    );
  });

  it('a record without probable-cause text gives its raw NTSB status as the case page shows it', () => {
    expect(caseDescription(fixture('CEN23LA137'))).toBe(
      'NTSB accident investigation CEN23LA137, 4 Mar 2023: N131HL (Piper PA-46-600TP), no injuries. Status: P',
    );
    expect(caseDescription(fixture('CEN22LA442'))).toBe('NTSB accident investigation CEN22LA442, 27 Sep 2022: N7207 (Piper PA-18), no injuries. Status: blank');
    expect(caseDescription(fixture('ENG08WA029'))).toBe(
      'NTSB incident investigation ENG08WA029, 6 Jun 2008: OB-1799-P (Boeing 737-2A5), no injuries. Status: B',
    );
  });

  it('leaves out what is not recorded: the event type, the date, a registration', () => {
    const d = fixture('CEN23LA137');
    d.eventType = { code: null, label: 'Not reported' };
    d.date = null;
    d.aircraft[0]!.registration = '  ';
    expect(caseDescription(d)).toBe('NTSB investigation CEN23LA137: Piper PA-46-600TP, no injuries. Status: P');
    d.eventType = { code: 'UNK', label: 'Unknown event type' };
    d.aircraft = [];
    expect(caseDescription(d)).toBe('NTSB investigation CEN23LA137: Unidentified aircraft, no injuries. Status: P');
    d.eventType = { code: 'INC', label: 'Incident' };
    expect(caseDescription(d)).toMatch(/^NTSB incident investigation CEN23LA137: /);
  });

  it('collapses the narrative’s whitespace and drops control characters', () => {
    const d = fixture('SEA08LA057');
    d.sections = d.sections.map((s) => (s.kind === 'probable_cause' ? { ...s, text: 'The pilot’s\n\ninadequate\tlookout.\u0000\u0007  ' } : s));
    expect(caseDescription(d)).toMatch(/Probable cause: The pilot’s inadequate lookout\.$/);
  });
});

describe('injury phrase', () => {
  const of = (fatal: number | null, serious: number | null, minor: number | null, code: string | null = null, label = 'Not reported') =>
    injuryPhrase({ injuries: { fatal, serious, minor, uninjured: null }, highestInjury: { code, label } });

  it('names the most serious injury recorded', () => {
    expect(of(1, 2, 3)).toBe('1 fatal');
    expect(of(3, 0, 0)).toBe('3 fatal');
    expect(of(0, 2, 5)).toBe('serious injuries');
    expect(of(0, 0, 1)).toBe('minor injuries');
    expect(of(0, 0, 0)).toBe('no injuries');
  });

  it('never says "no injuries" when the counts are not recorded', () => {
    expect(of(null, null, null)).toBe('injuries not reported');
    expect(of(0, null, 0, 'FATL', 'Fatal')).toBe('highest injury: fatal');
    expect(of(null, null, 2)).toBe('minor injuries');
  });
});

describe('truncating at a word', () => {
  it('keeps text that fits', () => {
    expect(truncateAtWord('a'.repeat(200), 200)).toBe('a'.repeat(200));
    expect(truncateAtWord('short text', 200)).toBe('short text');
  });

  it('cuts at the last whole word, ends in "…", and stays within the limit', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const cut = truncateAtWord(words, 200);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('…')).toBe(true);
    const kept = cut.slice(0, -1);
    expect(words.startsWith(`${kept} `)).toBe(true);
  });

  it('keeps a word that ends exactly at the limit, and drops punctuation before the ellipsis', () => {
    // 199 characters, then a space: the last word fits whole.
    const fits = `${'x'.repeat(194)} abcd efgh`;
    expect(truncateAtWord(fits, 200)).toBe(`${'x'.repeat(194)} abcd…`);
    expect(truncateAtWord(`${'x'.repeat(190)} clause, and more words`, 200)).toBe(`${'x'.repeat(190)} clause…`);
  });

  it('cuts a single overlong word, and counts characters, not UTF-16 units', () => {
    expect(truncateAtWord('y'.repeat(300), 200)).toBe(`${'y'.repeat(199)}…`);
    const emoji = '🛩'.repeat(300);
    const cut = truncateAtWord(emoji, 200);
    expect(Array.from(cut).length).toBeLessThanOrEqual(200);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});

describe('Open Graph and Twitter', () => {
  it('a case page carries the full set, with the share image and the title without the product name', () => {
    const page = parsed({ kind: 'case', detail: fixture('DFW08TA066') });
    const share = `${VALENTINE} (2008) · NTSB DFW08TA066`;
    expect({
      siteName: page.meta('property', 'og:site_name'),
      type: page.meta('property', 'og:type'),
      title: page.meta('property', 'og:title'),
      url: page.meta('property', 'og:url'),
      locale: page.meta('property', 'og:locale'),
      image: page.meta('property', 'og:image'),
      width: page.meta('property', 'og:image:width'),
      height: page.meta('property', 'og:image:height'),
      alt: page.meta('property', 'og:image:alt'),
      card: page.meta('name', 'twitter:card'),
      twitterTitle: page.meta('name', 'twitter:title'),
      twitterImage: page.meta('name', 'twitter:image'),
      twitterAlt: page.meta('name', 'twitter:image:alt'),
    }).toEqual({
      siteName: 'AirCase',
      type: 'website',
      title: share,
      url: `${ORIGIN}/cases/DFW08TA066`,
      locale: 'en_US',
      image: `${ORIGIN}/social/card.png`,
      width: '1200',
      height: '630',
      alt: 'AirCase: NTSB aviation accident investigations',
      card: 'summary_large_image',
      twitterTitle: share,
      twitterImage: `${ORIGIN}/social/card.png`,
      twitterAlt: 'AirCase: NTSB aviation accident investigations',
    });
  });

  it('the home page keeps its long name; other pages drop " · AirCase"', () => {
    expect(parsed({ kind: 'home' }).meta('property', 'og:title')).toBe('AirCase · aviation casebook');
    expect(parsed({ kind: 'explore', query: new URLSearchParams('q=icing') }).meta('property', 'og:title')).toBe('“icing” · Explore');
    expect(parsed({ kind: 'not_found' }).meta('name', 'twitter:title')).toBe('Page not found');
  });
});

describe('JSON-LD', () => {
  it('the home page is a WebSite', () => {
    expect(parsed({ kind: 'home' }).ld).toEqual([
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'AirCase', alternateName: 'aviation casebook', url: `${ORIGIN}/` },
    ]);
  });

  it('a case page is a breadcrumb: AirCase, Explore, the case', () => {
    expect(parsed({ kind: 'case', detail: fixture('DFW08TA066') }).ld).toEqual([
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

  it('no other page has any', () => {
    for (const route of [
      { kind: 'explore', query: new URLSearchParams() },
      { kind: 'dashboard' },
      { kind: 'missing_case', requested: 'ZZZ99ZZ999' },
      { kind: 'not_found' },
    ] as PageRoute[]) {
      expect(parsed(route).ld, route.kind).toEqual([]);
    }
  });

  it('is serialized so that no text can close the script element', () => {
    const value = { a: '</script><script>alert(1)</script>', b: 'line\u2028separator\u2029paragraph', c: 'Tom & Jerry <b>', d: '<!--' };
    const out = jsonLd(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe('untrusted NTSB text is escaped for its context', () => {
  const HOSTILE_HEADLINE = 'Cessna 172 </title><script>alert("t")</script> & \'quoted\' "double" $& $\' $` near <b>X</b>';
  const HOSTILE_CAUSE = '</script><script>alert(1)</script> "quotes" \'single\' & ampersand <img src=x onerror=alert(2)> $\' end';

  function hostileCase(): CaseDetail {
    const d = fixture('SEA08LA057');
    d.headline = HOSTILE_HEADLINE;
    d.aircraft[0]!.registration = 'N1"><img src=x>';
    d.aircraft[0]!.make = '<script>';
    d.sections = d.sections.map((s) => (s.kind === 'probable_cause' ? { ...s, text: HOSTILE_CAUSE } : s));
    return d;
  }

  it('the title, description and share tags hold the text exactly, and add no element', () => {
    const page = parsed({ kind: 'case', detail: hostileCase() });
    expect(page.title).toBe(`${HOSTILE_HEADLINE} (2008) · NTSB SEA08LA057 · AirCase`);
    expect(page.meta('property', 'og:title')).toBe(`${HOSTILE_HEADLINE} (2008) · NTSB SEA08LA057`);
    expect(page.description).toContain(`Probable cause: ${HOSTILE_CAUSE}`.slice(0, 40));
    expect(page.description).toContain('N1"><img src=x> (<script> PA 28-180)');
    // Only the template's own scripts and the JSON-LD block: nothing the text tried to open.
    expect(page.document.querySelectorAll('img, b')).toHaveLength(0);
    const scripts = [...page.document.querySelectorAll('script')].map((s) => s.getAttribute('type') ?? 'classic');
    expect(scripts.sort()).toEqual(['application/ld+json', 'classic', 'module']);
    expect(page.html).not.toContain('<script>alert');
    expect(page.html).not.toContain('<img');
  });

  it('a 404 for a hostile number echoes it only as text', () => {
    const page = parsed({ kind: 'missing_case', requested: '<script>alert(1)</script>' });
    expect(page.title).toBe('NTSB <SCRIPT>ALERT(1)</SCRIPT> · AirCase');
    expect(page.document.querySelectorAll('script')).toHaveLength(2);
  });
});

describe('the page template', () => {
  it("replaces the template's title and description, keeps its theme script, and adds the style nonce", () => {
    const page = parsed({ kind: 'about' });
    expect(page.titles).toBe(1);
    expect(page.descriptions).toBe(1);
    expect(page.html).not.toContain('<title>AirCase · aviation casebook</title>');
    const theme = /<script>\(function\(\)\{[\s\S]*?<\/script>/.exec(SOURCE_TEMPLATE)?.[0];
    expect(theme).toBeDefined();
    expect(page.html).toContain(theme);
    expect(page.html).toContain(`<meta property="csp-nonce" nonce="${NONCE}"></head>`);
    // The head sits where the template's title was: after the charset and viewport.
    const head = page.document.head.innerHTML;
    expect(head.indexOf('charset')).toBeLessThan(head.indexOf('<title>'));
  });

  it('takes a template without a title or description, and copies "$" patterns literally', () => {
    const parts = splitTemplate('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    const html = renderPage(parts, '<title>$& $\' $` $$</title>', NONCE);
    expect(html).toBe(
      `<!doctype html><html><head><meta charset="utf-8"><title>$& $' $\` $$</title><meta property="csp-nonce" nonce="${NONCE}"></head><body></body></html>`,
    );
  });
});

// Explore and Compare are not rate limited, and their titles read the query string.
describe('a hostile query string of 16 KB costs little', () => {
  /**
   * Milliseconds for one head: the fastest of a number of builds after a warm-up, which is the
   * work itself whatever else the machine is doing (the whole suite runs in parallel).
   */
  function perHead(route: PageRoute, runs = 15): number {
    pageHead(route, ORIGIN);
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      pageHead(route, ORIGIN);
      fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
  }

  it.each(HOSTILE_SEARCHES)('Explore, %s: the head is built in a few milliseconds', (_name, qs) => {
    expect(qs.length).toBeGreaterThan(15_000);
    expect(perHead({ kind: 'explore', query: new URLSearchParams(qs) })).toBeLessThan(5);
  });

  it.each(HOSTILE_COMPARES)('Compare, %s: the head is built in a few milliseconds', (_name, qs) => {
    expect(qs.length).toBeGreaterThan(15_000);
    expect(perHead({ kind: 'compare', query: new URLSearchParams(qs) })).toBeLessThan(5);
  });
});
