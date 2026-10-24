import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, setupMockApi } from './render-app';

// Components that fail on demand: a page (About) and a part of the app frame (the footer).
const fail = vi.hoisted(() => ({ page: false, frame: false }));

vi.mock('../../web/src/pages/About', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/pages/About')>();
  return {
    ...actual,
    About: () => {
      if (fail.page) throw new Error('a page failed');
      return <actual.About />;
    },
  };
});

vi.mock('../../web/src/components/Footer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/components/Footer')>();
  return {
    ...actual,
    Footer: (props: Parameters<typeof actual.Footer>[0]) => {
      if (fail.frame) throw new Error('the frame failed');
      return <actual.Footer {...props} />;
    },
  };
});

setupMockApi();

afterEach(() => {
  fail.page = false;
  fail.frame = false;
});

/** React and the router report a caught error on the console; these tests expect it. */
function quietErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('Unexpected errors never show a developer page (review W-1)', () => {
  it('a case link whose hash has a malformed percent-escape still shows the case', async () => {
    const errors = quietErrors();
    for (const path of ['/cases/DFW08TA066#%', '/cases/DFW08TA066#analysis%E']) {
      const view = renderApp(path);
      expect(await screen.findByRole('heading', { level: 1, name: /Hughes OH-6 helicopter/ })).toBeTruthy();
      // The hash is read once the case is on screen; nothing replaces the page afterwards.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
      expect(screen.getByRole('banner')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: /Hughes OH-6 helicopter/ })).toBeTruthy();
      view.unmount();
    }
    expect(errors.mock.calls.flat().map(String).join('\n')).not.toMatch(/URI malformed|URIError/);
  });

  it('a hash that names a section still scrolls to it', async () => {
    // jsdom has no scrollIntoView: a stand-in records where the page scrolls.
    const proto = Element.prototype as { scrollIntoView?: (this: Element) => void };
    const scrolled: string[] = [];
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      renderApp('/cases/DFW08TA066#probable-cause');
      await screen.findByRole('heading', { level: 1, name: /Hughes OH-6 helicopter/ });
      await waitFor(() => expect(scrolled).toContain('probable-cause'));
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it('a page that fails shows the error inside the app frame, with Try again and Home', async () => {
    const errors = quietErrors();
    fail.page = true;
    const view = renderApp('/about');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { level: 1, name: 'Something went wrong.' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    // The header and footer stay: the reader can still move around the site.
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
    // Nothing of the error itself is shown.
    expect(document.body.textContent).not.toContain('a page failed');
    // Moving on to another page leaves the error behind.
    fail.page = false;
    await act(() => view.router.navigate('/privacy'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    errors.mockRestore();
  });

  it('when the frame itself fails, the error page keeps a way home', async () => {
    const errors = quietErrors();
    fail.frame = true;
    renderApp('/explore');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { level: 1, name: 'Something went wrong.' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'AirCase' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
    expect(document.body.textContent).not.toContain('the frame failed');
    errors.mockRestore();
  });
});

describe('both error pages carry the owner credit and the product name (owner decisions of 2026-10-24)', () => {
  /** The credit line in the footer, as paragraph text and link. */
  function expectCredit(footer: HTMLElement): void {
    const line = within(footer).getByText('Built by Mariusz Kotas').closest('p');
    expect(line?.textContent).toBe('Built by Mariusz Kotas · mkotas.cz');
    expect(within(footer).getByRole('link', { name: 'mkotas.cz' }).getAttribute('href')).toBe('https://mkotas.cz');
  }

  it('a page that fails keeps the app footer, with the credit', async () => {
    const errors = quietErrors();
    fail.page = true;
    renderApp('/about');
    await screen.findByRole('alert');
    expect(document.title).toBe('Something went wrong · AirCase');
    expectCredit(screen.getByRole('contentinfo'));
    errors.mockRestore();
  });

  it('when the frame itself fails, the plain error page has the credit too', async () => {
    const errors = quietErrors();
    fail.frame = true;
    renderApp('/explore');
    await screen.findByRole('alert');
    expect(document.title).toBe('Something went wrong · AirCase');
    // The page's own footer: the app's footer is what failed, and this one needs nothing from the frame.
    expectCredit(screen.getByRole('contentinfo'));
    // The header's lockup: the home link (the mark and the wordmark) and what AirCase shows.
    const banner = screen.getByRole('banner');
    expect(banner.textContent).toBe('AirCasePlane crash & accident investigations');
    const home = within(banner).getByRole('link', { name: 'AirCase' });
    expect(home.getAttribute('href')).toBe('/');
    expect(home.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(home.contains(within(banner).getByText('Plane crash & accident investigations'))).toBe(false);
    errors.mockRestore();
  });
});
