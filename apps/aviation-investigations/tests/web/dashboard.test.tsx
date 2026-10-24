import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import dashboard from '../../web/mock/dashboard-default.json';
import dashboardAll from '../../web/mock/dashboard-all.json';
import { phaseSentence, yearsSentence, formatPercent } from '../../web/src/features/dashboard/sentences';
import { currentUrl, renderApp, setupMockApi } from './render-app';
import type { DashboardResponse } from '../../shared/contracts/dashboard';

setupMockApi();

beforeEach(() => {
  // jsdom has no canvas; the map only needs a context to draw into.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

const data = dashboard as unknown as DashboardResponse;

describe('Dashboard', () => {
  it('landing sentence uses computed count', async () => {
    renderApp('/dashboard');
    const top = data.phase[0]!;
    const panel = await screen.findByRole('region', { name: 'When in the flight did it happen?' });
    expect(panel.textContent).toContain(
      `during ${top.label.toLowerCase()} in ${top.count} cases (${formatPercent(top.count, data.total)})`,
    );
    expect(panel.textContent).toContain('That counts investigations, not risk per landing.');
    // The template reproduces the mockup's wording with its numbers.
    const mock = [{ facet: 'phase', value: 'landing', label: 'Landing', count: 7849 }] as DashboardResponse['phase'];
    expect(phaseSentence(mock, 24291).replaceAll('**', '')).toContain('during landing in 7,849 cases (32%)');
    expect(
      yearsSentence([
        { year: 2025, completed: 758, other: 418 },
        { year: 2026, completed: 270, other: 600 },
      ]).replaceAll('**', ''),
    ).toContain('2025 has 758 completed of 1,176 events, and 2026 only 270 of 870, so recent years look smaller than they will be.');
  });

  it('bar button navigates to explore with phase=landing', async () => {
    const { router } = renderApp('/dashboard');
    const landing = data.phase.find((b) => b.value === 'landing')!;
    const panel = await screen.findByRole('region', { name: 'When in the flight did it happen?' });
    const bar = within(panel).getByRole('button', {
      name: `Landing, ${landing.count} investigations, ${formatPercent(landing.count, data.total)}. Open in Explore.`,
    });
    fireEvent.click(bar);
    await waitFor(() => expect(currentUrl(router)).toBe('/explore?phase=landing'));
  });

  it('cohort chip reads Include N other records and switches to all records', async () => {
    const { router } = renderApp('/dashboard');
    const other = (dashboardAll as unknown as DashboardResponse).total - data.total;
    const chip = await screen.findByRole('button', { name: `+ Include ${other} other records` });
    fireEvent.click(chip);
    await waitFor(() => expect(currentUrl(router)).toBe('/dashboard?cohort=all'));
    const bar = (await screen.findAllByRole('button', { name: /Open in Explore/ }))[0]!;
    fireEvent.click(bar);
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/explore\?completion=any&/));
  });

  it('coverage panel says not in this data for flight hours', async () => {
    renderApp('/dashboard');
    const panel = await screen.findByRole('region', { name: 'What can this data tell you?' });
    expect(panel.textContent).toContain('How many flights or hours were flown (needed for any risk rate): not in this data');
    expect(panel.textContent).toContain('AI evidence classification: not used in these charts');
    expect(panel.textContent).toContain('Probable cause text available');
    expect(panel.textContent).toContain('Raw METAR weather text');
  });

  it('states multi-aircraft overlap, missing coordinates and the hidden year table', async () => {
    renderApp('/dashboard');
    await screen.findByRole('region', { name: 'Where?' });
    // Both aircraft charts can sum to more than the total (G0 #14, review W-7): phase is each
    // aircraft's defining-event phase, as in Explore, so a two-aircraft event can count twice.
    expect(data.phase.reduce((sum, b) => sum + b.count, 0)).toBeGreaterThan(data.total);
    const multi = data.coverage.multiAircraft;
    const phase = screen.getByRole('region', { name: 'When in the flight did it happen?' });
    expect(within(phase).getByText(`${multi} investigations involved more than one aircraft, so phase counts can add up to more than ${data.total}.`)).toBeTruthy();
    const category = screen.getByRole('region', { name: 'What was flying?' });
    expect(within(category).getByText(`${multi} investigations involved more than one aircraft, so aircraft counts can add up to more than ${data.total}.`)).toBeTruthy();
    // The event-level charts have none.
    for (const name of ['How serious were the outcomes?', 'What was the weather?']) {
      expect(within(screen.getByRole('region', { name })).queryByText(/involved more than one aircraft/)).toBeNull();
    }
    expect(screen.getByText(/Lower 48 shown/).textContent).toMatch(/coordinates/);
    expect(screen.getByRole('table', { hidden: true })).toBeTruthy();
  });

  it('the year legend never interprets raw statuses while the mapping is unverified (G0 #5, review W-6)', async () => {
    renderApp('/dashboard');
    const years = await screen.findByRole('region', { name: 'How complete is the recent record?' });
    const legend = within(years).getByRole('list', { name: 'Legend' });
    expect(legend.textContent).toContain('Other records (not a verified completed status)');
    expect(legend.textContent).not.toMatch(/in progress|status unknown/i);
  });
});
