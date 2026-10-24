/**
 * The product is AirCase, tagline "aviation casebook", and its footer and About page say who
 * built it (owner decisions of 2026-10-24, UI_DESIGN §10). Expected strings are written out
 * here, not imported, so an accidental change to the app's copy fails a test.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SITE_DESCRIPTION } from '../../shared/brand';
import { pageTitle, type TitledPage } from '../../shared/page-titles';
import indexHtml from '../../web/index.html?raw';
import { Footer } from '../../web/src/components/Footer';
import { SignInDialog } from '../../web/src/features/auth/SignInDialog';
import tokensCss from '../../web/src/styles/tokens.css?raw';
import { cssBlock, cssVar } from './helpers';
import { renderApp, setupMockApi } from './render-app';

const server = setupMockApi();

const CREDIT_LINE = 'Built by Mariusz Kotas';
const SITE = 'mkotas.cz';
const EMAIL = 'm@mkotas.cz';

/** The website opens in a new tab, without a handle on this page, like the links to NTSB reports. */
function expectSiteLink(link: HTMLElement): void {
  expect(link.getAttribute('href')).toBe('https://mkotas.cz');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
}

/** Every route of the app, including the account page and a page that does not exist. */
const ROUTES = [
  '/',
  '/explore',
  '/explore?q=carburetor+icing',
  '/dashboard',
  '/cases/DFW08TA066',
  '/compare?cases=DFW08TA066',
  '/account',
  '/privacy',
  '/about',
  '/no-such-page',
] as const;

function renderFooter() {
  return render(
    <MemoryRouter>
      <Footer snapshotDate="2026-10-01" printedDate="2026-10-22" />
    </MemoryRouter>,
  );
}

describe('the footer credit: built by Mariusz Kotas, with a link to his website (UI_DESIGN §3)', () => {
  it('reads "Built by Mariusz Kotas · mkotas.cz" under the existing line, the website is a link, and the e-mail address is not there', () => {
    const { container } = renderFooter();
    const [screenLine, printLine, credit] = container.querySelectorAll('footer p');
    // The existing footer is untouched.
    expect(screenLine?.textContent).toBe('Not an NTSB service · Data: NTSB, snapshot 01 OCT 2026 · Privacy · About');
    expect(printLine?.textContent).toBe('Not an NTSB service · Source: NTSB · printed 22 OCT 2026');
    expect(credit?.textContent).toBe(`${CREDIT_LINE} · ${SITE}`);
    const link = screen.getByRole('link', { name: SITE });
    expectSiteLink(link);
    expect(credit?.contains(link)).toBe(true);
    // The e-mail address is on the About page only (owner, 2026-10-24).
    expect(container.textContent).not.toContain(EMAIL);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('is shown on screen and in print: it is neither a screen-only nor a print-only line', () => {
    const { container } = renderFooter();
    const credit = container.querySelectorAll('footer p')[2];
    expect(credit?.className).not.toMatch(/print:hidden|(^|\s)hidden(\s|$)/);
    // Printed, it lines up with the print line before it (left-aligned) and the website stays readable text.
    expect(credit?.className).toContain('print:text-left');
  });

  it('is reachable by keyboard: a link with an address, in the tab order', () => {
    renderFooter();
    const link = screen.getByRole('link', { name: SITE }) as HTMLAnchorElement;
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("uses the footer's own tokens, muted text and the blue link, and no colour of its own", () => {
    const { container } = renderFooter();
    const credit = container.querySelectorAll('footer p')[2];
    expect(credit?.className).toContain('text-muted');
    expect(screen.getByRole('link', { name: SITE }).className).toBe('link');
    expect(credit?.className).not.toMatch(/#[0-9a-f]{3,6}|rgb|text-\[/i);
  });

  it.each([
    ['day', ':root,\n[data-theme="day"]'],
    ['night', '[data-theme="night"]'],
  ])('is readable in %s mode: the muted text and the blue link have at least 4.5:1 on the page (WCAG AA)', (_theme, selector) => {
    const tokens = cssBlock(tokensCss, selector);
    const paper = hex(cssVar(tokens, 'paper'));
    // By day the page carries the graticule: its lines are a little darker than the paper.
    const grid = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([.\d]+)\)/.exec(cssVar(tokens, 'grid') ?? '');
    const backgrounds: Rgb[] = grid ? [paper, blend([Number(grid[1]), Number(grid[2]), Number(grid[3])], paper, Number(grid[4]))] : [paper];
    for (const background of backgrounds) {
      for (const token of ['muted', 'blue']) {
        expect(contrast(hex(cssVar(tokens, token)), background), `${token} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(ROUTES)('is in the footer of %s', async (path) => {
    renderApp(path);
    const footer = await screen.findByRole('contentinfo');
    const line = within(footer).getByText(CREDIT_LINE).closest('p');
    expect(line?.textContent).toBe(`${CREDIT_LINE} · ${SITE}`);
    expectSiteLink(within(footer).getByRole('link', { name: SITE }));
    expect(footer.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

type Rgb = readonly [number, number, number];

/** `#RRGGBB` as channels. */
function hex(value: string | undefined): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '');
  if (!m) throw new Error(`not a #RRGGBB colour: ${value}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** `top` laid over `under` at `alpha`. */
function blend(top: Rgb, under: Rgb, alpha: number): Rgb {
  const mix = (i: 0 | 1 | 2) => Math.round(top[i] * alpha + under[i] * (1 - alpha));
  return [mix(0), mix(1), mix(2)];
}

/** WCAG 2.x contrast ratio of two opaque colours. */
function contrast(a: Rgb, b: Rgb): number {
  const linear = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c: Rgb) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('the About page (UI_DESIGN §4.8)', () => {
  it('is AirCase, and says who built it: his name, his website and his e-mail address', async () => {
    renderApp('/about');
    expect(await screen.findByRole('heading', { level: 1, name: 'About AirCase' })).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 2, name: 'Built by' })).toBeTruthy();
    const built = within(main).getByText(/AirCase is built by Mariusz Kotas/);
    expect(built.textContent).toBe(`AirCase is built by Mariusz Kotas. Website: ${SITE}. Contact: ${EMAIL}.`);
    expectSiteLink(within(built).getByRole('link', { name: SITE }));
    expect(within(built).getByRole('link', { name: EMAIL }).getAttribute('href')).toBe(`mailto:${EMAIL}`);
    expect(main.textContent).not.toMatch(/Aviation Casebook/);
  });

  it('describes what the product is today, without promising what it is not: keyword search, case pages, Compare and the dashboard', async () => {
    renderApp('/about');
    await screen.findByRole('heading', { level: 1, name: 'About AirCase' });
    const text = screen.getByRole('main').textContent ?? '';
    expect(text).toContain('AirCase is an aviation casebook.');
    expect(text).toContain('Search the record by keyword');
    // Compare puts up to four cases on one page as stacked flight strips (UI_DESIGN §4.6), not in side-by-side columns.
    expect(text).toContain('compare up to four of them on one page');
    expect(text).not.toContain('side by side');
    expect(text).toContain('dashboard');
    expect(text).toContain('AI features are not available yet.');
    // The data source and its attribution stay.
    expect(text).toContain('NTSB aviation investigation database (avall.mdb)');
    expect(text).toContain('It is not an NTSB service');
    expect(text).not.toMatch(/coming soon|will soon|we plan|roadmap/i);
  });
});

describe('page titles name AirCase, never the old name (owner decision 2026-10-24)', () => {
  const VALENTINE = 'Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas';
  // Each route's title, and the input the server titles the same route with (shared/page-titles.ts,
  // server/seo/head.ts): the tab shows one title before and after the script runs.
  const titles: ReadonlyArray<readonly [string, string, TitledPage]> = [
    // The home page names what AirCase shows (owner decision of 2026-10-24, UI_DESIGN §10).
    ['/', 'AirCase · Plane crash & accident investigations', { kind: 'home' }],
    ['/explore', 'Explore · AirCase', { kind: 'explore', q: '' }],
    ['/explore?q=carburetor+icing', '“carburetor icing” · Explore · AirCase', { kind: 'explore', q: 'carburetor icing' }],
    ['/dashboard', 'The record, in questions · AirCase', { kind: 'dashboard' }],
    // The case page: headline, event year and NTSB number (owner request of 2026-10-24, SEO).
    [
      '/cases/DFW08TA066',
      `${VALENTINE} (2008) · NTSB DFW08TA066 · AirCase`,
      { kind: 'case', ntsbNo: 'DFW08TA066', detail: { headline: VALENTINE, date: '2008-02-08' } },
    ],
    ['/cases/ZZZ99ZZ999', 'NTSB ZZZ99ZZ999 · AirCase', { kind: 'case', ntsbNo: 'ZZZ99ZZ999', detail: null }],
    ['/compare?cases=DFW08TA066', 'Comparing 1 case · AirCase', { kind: 'compare', count: 1 }],
    ['/account', 'Account · AirCase', { kind: 'account' }],
    ['/privacy', 'Privacy · AirCase', { kind: 'privacy' }],
    ['/about', 'About · AirCase', { kind: 'about' }],
    ['/no-such-page', 'Page not found · AirCase', { kind: 'not_found' }],
  ];

  it.each(titles)('%s is "%s", the shared title the server sends', async (path, expected, page) => {
    expect(pageTitle(page)).toBe(expected);
    renderApp(path);
    await waitFor(() => expect(document.title).toBe(expected));
  });

  it.each(['/About', '/EXPLORE', '/Cases/DFW08TA066'])('%s is not a page: paths match in their case, like the server’s routes (a 404 there)', async (path) => {
    renderApp(path);
    await waitFor(() => expect(document.title).toBe('Page not found · AirCase'));
    expect(screen.getByRole('heading', { level: 1, name: 'There is no page here.' })).toBeTruthy();
  });

  it('a case number still matches in any case (the server redirects it to upper case)', async () => {
    renderApp('/cases/dfw08ta066');
    await waitFor(() => expect(document.title).toBe(`${VALENTINE} (2008) · NTSB DFW08TA066 · AirCase`));
  });

  it('a case page says its NTSB number while the case loads', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Holds the case until released, then lets the mock API answer it.
    server.use(http.get('*/api/cases/:ntsbNo', async () => void (await held)));
    renderApp('/cases/DFW08TA066');
    await waitFor(() => expect(document.title).toBe('NTSB DFW08TA066 · AirCase'));
    release();
    await waitFor(() => expect(document.title).toBe(`${VALENTINE} (2008) · NTSB DFW08TA066 · AirCase`));
  });
});

/** Text as HTML gives it: the character references index.html uses decoded. */
function htmlText(raw: string | undefined): string | undefined {
  return raw?.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '');
}

describe('the page before the script runs (web/index.html)', () => {
  it("has the home page's title and the site description, and names AirCase for visitors without JavaScript", () => {
    const title = htmlText(/<title>([^<]*)<\/title>/.exec(indexHtml)?.[1]);
    expect(title).toBe('AirCase · Plane crash & accident investigations');
    expect(title).toBe(pageTitle({ kind: 'home' }));
    // The site description, until the server replaces it with the page's own (shared/brand.ts).
    const description = htmlText(/<meta name="description" content="([^"]*)"/.exec(indexHtml)?.[1]);
    expect(description).toBe(
      'Search NTSB investigations of US plane crashes and aviation accidents since 2008: what happened, the probable cause and what investigators found.',
    );
    expect(description).toBe(SITE_DESCRIPTION);
    expect(/<noscript>([^<]*)<\/noscript>/.exec(indexHtml)?.[1]).toBe('AirCase needs JavaScript to search and display investigations.');
  });
});

describe('the app frame names AirCase', () => {
  it('the header wordmark is "AirCase" at every width and links home', async () => {
    renderApp('/about');
    const header = await screen.findByRole('banner');
    const wordmark = within(header).getByRole('link', { name: 'AirCase' });
    expect(wordmark.getAttribute('href')).toBe('/');
    // One wordmark, not a long and a short form for different widths.
    expect(wordmark.textContent).toBe('AirCase');
    expect(within(header).queryByText('Casebook')).toBeNull();
  });

  it('the sign-in dialog is "Sign in to AirCase"', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SignInDialog open onOpenChange={vi.fn()} returnTo="/" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Sign in to AirCase' })).toBeTruthy();
  });
});

describe('no user-visible text of the web client still names the old product', () => {
  // The wordmark is set in capitals by CSS; identifiers such as the `casebook-theme` storage key stay.
  const sources = import.meta.glob(['../../web/src/**/*.{ts,tsx}', '../../shared/**/*.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('scans the client and shared sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it('has no "Aviation Casebook", "AVIATION CASEBOOK" or short "Casebook" wordmark', () => {
    const offenders = Object.entries({ 'web/index.html': indexHtml, ...sources })
      .filter(([, text]) => /Aviation Casebook|AVIATION CASEBOOK|\bCasebook\b|\bCASEBOOK\b/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
