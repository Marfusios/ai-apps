/**
 * The product is AirCase, tagline "aviation casebook", and its footer and About page say who
 * built it (owner decisions of 2026-10-24, UI_DESIGN §10). Expected strings are written out
 * here, not imported, so an accidental change to the app's copy fails a test.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import indexHtml from '../../web/index.html?raw';
import { Footer } from '../../web/src/components/Footer';
import { SignInDialog } from '../../web/src/features/auth/SignInDialog';
import tokensCss from '../../web/src/styles/tokens.css?raw';
import { cssBlock, cssVar } from './helpers';
import { renderApp, setupMockApi } from './render-app';

setupMockApi();

const CREDIT_LINE = 'Built by Mariusz Kotas';
const EMAIL = 'm@mkotas.cz';

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

describe('the footer credit: built by Mariusz Kotas, with a mailto link (UI_DESIGN §3)', () => {
  it('reads "Built by Mariusz Kotas · m@mkotas.cz" under the existing line, and the address is a mailto link', () => {
    const { container } = renderFooter();
    const [screenLine, printLine, credit] = container.querySelectorAll('footer p');
    // The existing footer is untouched.
    expect(screenLine?.textContent).toBe('Not an NTSB service · Data: NTSB, snapshot 01 OCT 2026 · Privacy · About');
    expect(printLine?.textContent).toBe('Not an NTSB service · Source: NTSB · printed 22 OCT 2026');
    expect(credit?.textContent).toBe(`${CREDIT_LINE} · ${EMAIL}`);
    const link = screen.getByRole('link', { name: EMAIL });
    expect(link.getAttribute('href')).toBe(`mailto:${EMAIL}`);
    expect(credit?.contains(link)).toBe(true);
  });

  it('is shown on screen and in print: it is neither a screen-only nor a print-only line', () => {
    const { container } = renderFooter();
    const credit = container.querySelectorAll('footer p')[2];
    expect(credit?.className).not.toMatch(/print:hidden|(^|\s)hidden(\s|$)/);
    // Printed, it lines up with the print line before it (left-aligned) and the address stays readable text.
    expect(credit?.className).toContain('print:text-left');
  });

  it('is reachable by keyboard: a link with an address, in the tab order', () => {
    renderFooter();
    const link = screen.getByRole('link', { name: EMAIL }) as HTMLAnchorElement;
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("uses the footer's own tokens, muted text and the blue link, and no colour of its own", () => {
    const { container } = renderFooter();
    const credit = container.querySelectorAll('footer p')[2];
    expect(credit?.className).toContain('text-muted');
    expect(screen.getByRole('link', { name: EMAIL }).className).toBe('link');
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
    expect(line?.textContent).toBe(`${CREDIT_LINE} · ${EMAIL}`);
    const link = within(footer).getByRole('link', { name: EMAIL });
    expect(link.getAttribute('href')).toBe(`mailto:${EMAIL}`);
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
  it('is AirCase, and says who built it with a contact link', async () => {
    renderApp('/about');
    expect(await screen.findByRole('heading', { level: 1, name: 'About AirCase' })).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 2, name: 'Built by' })).toBeTruthy();
    const built = within(main).getByText(/AirCase is built by Mariusz Kotas/);
    const link = within(built).getByRole('link', { name: EMAIL });
    expect(link.getAttribute('href')).toBe(`mailto:${EMAIL}`);
    expect(main.textContent).not.toMatch(/Aviation Casebook/);
  });

  it('describes what the product is today, without promising what it is not: keyword search, case pages, Compare and the dashboard', async () => {
    renderApp('/about');
    await screen.findByRole('heading', { level: 1, name: 'About AirCase' });
    const text = screen.getByRole('main').textContent ?? '';
    expect(text).toContain('AirCase is an aviation casebook.');
    expect(text).toContain('Search the record by keyword');
    expect(text).toContain('compare up to four');
    expect(text).toContain('dashboard');
    expect(text).toContain('AI features are not available yet.');
    // The data source and its attribution stay.
    expect(text).toContain('NTSB aviation investigation database (avall.mdb)');
    expect(text).toContain('It is not an NTSB service');
    expect(text).not.toMatch(/coming soon|will soon|we plan|roadmap/i);
  });
});

describe('page titles name AirCase, never the old name (owner decision 2026-10-24)', () => {
  const titles: ReadonlyArray<readonly [string, string | RegExp]> = [
    ['/', 'AirCase · aviation casebook'],
    ['/explore', 'Explore · AirCase'],
    ['/explore?q=carburetor+icing', '“carburetor icing” · Explore · AirCase'],
    ['/dashboard', 'The record, in questions · AirCase'],
    ['/cases/DFW08TA066', /^DFW08TA066: .+ · AirCase$/],
    ['/compare?cases=DFW08TA066', 'Comparing 1 case · AirCase'],
    ['/account', 'Account · AirCase'],
    ['/privacy', 'Privacy · AirCase'],
    ['/about', 'About · AirCase'],
    ['/no-such-page', 'Page not found · AirCase'],
  ];

  it.each(titles)('%s', async (path, expected) => {
    renderApp(path);
    await waitFor(() => {
      if (typeof expected === 'string') expect(document.title).toBe(expected);
      else expect(document.title).toMatch(expected);
    });
  });
});

describe('the page before the script runs (web/index.html)', () => {
  it('has the long form as its title and names AirCase for visitors without JavaScript', () => {
    expect(/<title>([^<]*)<\/title>/.exec(indexHtml)?.[1]).toBe('AirCase · aviation casebook');
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
