import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { COMPARE_FULL_MESSAGE } from '../../web/src/features/explore/CompareTray';
import { currentUrl, renderApp, setupMockApi } from './render-app';

setupMockApi();

/** The results' count line, in the page's main region: the header's descriptor ends in "investigations" too. */
const countLine = async (): Promise<string> => {
  const strong = await within(await screen.findByRole('main')).findByText(/completed investigations?|investigations?$/, { selector: 'p' });
  return strong.textContent ?? '';
};

describe('Home', () => {
  it('example chips only fill the box; Enter runs Search', async () => {
    const { router } = renderApp('/');
    const box = screen.getByRole('textbox', { name: 'Search NTSB investigations' });
    fireEvent.click(screen.getByRole('button', { name: /Carb icing on climb-out/ }));
    expect(box).toHaveProperty('value', 'Carb icing on climb-out');
    expect(currentUrl(router)).toBe('/');
    fireEvent.change(box, { target: { value: 'carburetor icing' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(currentUrl(router)).toBe('/'); // Ctrl/Cmd+Enter asks the AI; it never runs Search.
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(currentUrl(router)).toBe('/explore?q=carburetor+icing'));
    // The coverage line is computed from /api/config.
    renderApp('/');
    expect(await screen.findByText(/completed US NTSB investigations · 2008 → 2026 · snapshot 16 OCT 2026/)).toBeTruthy();
  });

  it('the footer gives the snapshot\'s real age once it is older than expected (review W-8)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // The mock snapshot is 16 Oct 2026; a month and a bit later the age is not shown yet.
      vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
      const fresh = renderApp('/');
      const footer = await screen.findByRole('contentinfo');
      await waitFor(() => expect(footer.textContent).toContain('snapshot 16 OCT 2026'));
      expect(footer.textContent).not.toContain('old)');
      fresh.unmount();
      vi.setSystemTime(new Date('2027-12-20T12:00:00Z'));
      renderApp('/');
      const later = await screen.findByRole('contentinfo');
      await waitFor(() => expect(later.textContent).toContain('Data: NTSB, snapshot 16 OCT 2026 (14 months old)'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('Ask AI shows the live AI counter, like the header', async () => {
    renderApp('/');
    // The status loads after the first paint; the name joins "Ask AI" and its counter.
    const ask = await screen.findByRole('button', { name: /^Ask AI\s*·\s*10 free$/ });
    expect(ask.getAttribute('aria-disabled')).toBe('false');
    expect(within(screen.getByRole('banner')).getAllByText('10 of 10').length).toBeGreaterThan(0);
  });
});

describe('Privacy', () => {
  it('names Cloudflare Turnstile, which only an AI request loads, and the retry key kept while a search is on its way (review W-14, W-2)', async () => {
    renderApp('/privacy');
    await screen.findByRole('heading', { level: 1, name: 'Privacy' });
    const text = document.querySelector('main')?.textContent ?? '';
    expect(text).toContain('Cloudflare Turnstile');
    expect(text).toContain('challenges.cloudflare.com');
    expect(text).toContain('only when an AI request needs a check');
    expect(text).toContain('Cloudflare may set its own cookies');
    expect(text).toContain('While an AI search is on its way, and if it gets no reply');
    expect(text).not.toContain('If an AI search gets no reply');
  });

  it('is the final notice the owner approved: who is responsible, every cookie, retention, the authority, no draft line', async () => {
    renderApp('/privacy');
    await screen.findByRole('heading', { level: 1, name: 'Privacy' });
    const main = screen.getByRole('main');
    const text = main.textContent ?? '';
    expect(text).toContain('Mariusz Kotas, a private individual in the Czech Republic, runs AirCase');
    for (const cookie of ['__Host-aviation_trial', '__Host-aviation_session', '__Host-aviation_oauth_state', '__Secure-aviation_signout']) {
      expect(text).toContain(cookie);
    }
    expect(text).toContain('Backups: daily, kept 14 days on the same computer.');
    expect(text).toContain('Last updated: 24 October 2026');
    expect(text).not.toContain('Draft notice');
    expect(within(main).getByRole('link', { name: 'uoou.gov.cz' }).getAttribute('href')).toBe('https://uoou.gov.cz');
    const mail = within(main).getAllByRole('link', { name: 'm@mkotas.cz' });
    expect(mail.map((a) => a.getAttribute('href'))).toEqual(['mailto:m@mkotas.cz', 'mailto:m@mkotas.cz']);
  });
});

describe('Explore', () => {
  it('shows the count line, rows with highlighted probable causes, and facets with counts', async () => {
    renderApp('/explore?q=carburetor+icing');
    expect(await countLine()).toMatch(/^7 completed investigations$/);
    const rows = within(screen.getByRole('list', { name: 'Results' })).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows[0]?.querySelector('mark.hit')?.textContent?.toLowerCase()).toContain('carburetor');
    expect(screen.getAllByRole('button', { name: 'Initial climb, 3 investigations' }).length).toBeGreaterThan(0);
  });

  it('facet click updates the URL and the counts; other facets stay disjunctive', async () => {
    const { router } = renderApp('/explore?q=carburetor+icing');
    await countLine();
    const [climb] = screen.getAllByRole('button', { name: 'Initial climb, 3 investigations' });
    fireEvent.click(climb as HTMLElement);
    await waitFor(() => expect(currentUrl(router)).toBe('/explore?q=carburetor+icing&phase=initial_climb'));
    await waitFor(async () => expect(await countLine()).toBe('3 completed investigations'));
    // The phase facet keeps its alternatives; the selected value is pressed.
    expect(screen.getAllByRole('button', { name: 'Approach, 2 investigations' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Initial climb, 3 investigations, selected' })[0]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('no results suggests removing one filter at a time, with real counts', async () => {
    const { router } = renderApp('/explore?q=carburetor+icing&phase=landing&injury=FATL');
    expect(await screen.findByText('No completed investigations match all of this.')).toBeTruthy();
    const suggestion = screen.getByRole('button', { name: /without Phase: Landing · 3 cases/ });
    fireEvent.click(suggestion);
    await waitFor(() => expect(currentUrl(router)).toBe('/explore?q=carburetor+icing&injury=FATL'));
  });

  it('a completed record without probable-cause text says so by its badge and where the cause would be', async () => {
    renderApp('/explore?completion=completed_without_cause');
    const row = (await screen.findAllByRole('link', { name: 'ENG10WA034' }))[0]?.closest('li') as HTMLElement;
    expect(within(row).getByText('COMPLETED')).toBeTruthy();
    expect(within(row).getByText('Probable-cause text unavailable')).toBeTruthy();
    expect(within(row).getByText('No probable cause on record')).toBeTruthy();
  });

  it('keeps the More filters fold open, without a toggle, while one of its filters is active', async () => {
    const { router } = renderApp('/explore?category=AIR');
    await countLine();
    const facets = screen.getByRole('complementary', { name: 'Filters' });
    expect(within(facets).queryByRole('button', { name: /Fewer filters|More filters/ })).toBeNull();
    expect(within(facets).getByRole('button', { name: /^Airplane, \d+ investigations, selected$/ })).toBeTruthy();
    fireEvent.click(within(facets).getByRole('button', { name: /^clear\s*Aircraft$/ }));
    await waitFor(() => expect(currentUrl(router)).toBe('/explore'));
    expect(within(facets).getByRole('button', { name: /More filters|Fewer filters/ })).toBeTruthy();
  });

  it('states the multi-aircraft overlap for every aircraft facet: under Phase, and once above the aircraft ones in More filters (G0 #14, review W-7)', async () => {
    renderApp('/explore');
    await countLine();
    const facets = screen.getByRole('complementary', { name: 'Filters' });
    const phase = within(facets).getByRole('region', { name: 'Phase' });
    expect(within(phase).getByText(/^\d+ investigations? here involved more than one aircraft, so phase counts can add up to more than \d[\d,]*\.$/)).toBeTruthy();
    fireEvent.click(within(facets).getByRole('button', { name: /^More filters/ }));
    const notes = within(facets).getAllByText(/involved more than one aircraft/);
    expect(notes).toHaveLength(2);
    const more = notes[1] as HTMLElement;
    expect(more.textContent).toMatch(/so aircraft, engine, operation and purpose counts can add up to more than \d[\d,]*\.$/);
    // Once, above the aircraft facets: Aircraft, Engine, Operation and Purpose follow it.
    const aircraft = within(facets).getByRole('region', { name: 'Aircraft' });
    expect(more.compareDocumentPosition(aircraft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of ['Aircraft', 'Engine', 'Operation', 'Purpose']) {
      expect(within(within(facets).getByRole('region', { name })).queryByText(/involved more than one aircraft/)).toBeNull();
    }
  });

  it('printing with the drawer open prints the page, not the drawer over it (review W-15)', async () => {
    renderApp('/explore?q=carburetor+icing&case=ERA25LA016');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-print')).toBe('hide');
  });

  it(`a fifth compare tick shows "${COMPARE_FULL_MESSAGE}"`, async () => {
    const { router } = renderApp('/explore?q=carburetor+icing');
    await countLine();
    const boxes = screen.getAllByRole('checkbox', { name: /^Compare\s*[A-Z0-9]+$/ });
    for (const box of boxes.slice(0, 4)) {
      fireEvent.click(box);
      await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    }
    expect(currentUrl(router)).toBe(
      '/explore?q=carburetor+icing&cases=ERA25LA016%2CWPR24FA190%2CWPR24LA154%2CCEN19FA009',
    );
    fireEvent.click(boxes[4] as HTMLElement);
    expect(await screen.findByText(COMPARE_FULL_MESSAGE)).toBeTruthy();
    expect((boxes[4] as HTMLInputElement).checked).toBe(false);
    const tray = screen.getByRole('complementary', { name: 'Compare tray' });
    expect(within(tray).getByRole('link', { name: 'Compare →' }).getAttribute('href')).toBe(
      '/compare?cases=ERA25LA016,WPR24FA190,WPR24LA154,CEN19FA009',
    );
  });

  it('the drawer opens from a row, focuses the headline, steps with ‹ › and returns focus on Esc', async () => {
    const { router } = renderApp('/explore?q=carburetor+icing');
    await countLine();
    const trigger = screen.getAllByRole('link', { name: 'ERA25LA016' })[0] as HTMLElement;
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const headline = await within(dialog).findByRole('heading', { level: 2, name: /Piper PA-28-151, fuel-related event/ });
    await waitFor(() => expect(document.activeElement).toBe(headline));
    expect(currentUrl(router)).toContain('case=ERA25LA016');
    expect(within(dialog).getByText('1 of 7')).toBeTruthy();
    // Story order, NTSB only.
    expect(within(dialog).getByText('The flight')).toBeTruthy();
    expect(within(dialog).getAllByText('In probable cause').length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/AI classified|Why it’s in your results/i)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next case' }));
    await waitFor(() => expect(currentUrl(router)).toContain('case=WPR24FA190'));
    expect(await within(dialog).findByText('2 of 7')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(currentUrl(router)).not.toContain('case=');
    expect(document.activeElement?.getAttribute('data-case-trigger')).toBe('WPR24FA190');
  });
});
