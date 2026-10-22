import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, setupMockApi } from './render-app';

setupMockApi();

describe('Case page', () => {
  it('shows every section in story order with IN PROBABLE CAUSE tags and the labelled search fallback', async () => {
    renderApp('/cases/DFW08TA066');
    const headline = await screen.findByRole('heading', { level: 1, name: /Hughes OH-6 helicopter, total loss of engine power/ });
    expect(headline).toBeTruthy();
    const order = ['The flight', 'The aircraft', 'Factual narrative', 'Analysis', 'What investigators established'];
    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads.filter((h) => order.includes(h ?? ''))).toEqual(order);
    expect(screen.getAllByText('In probable cause')).toHaveLength(2);
    expect(screen.queryByText(/cause:|contributing/i, { selector: '.border' })).toBeNull();
    expect(screen.getByText(/Direct report link unavailable/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Search NTSB aviation investigations/ }).getAttribute('href')).toBe('https://my.ntsb.gov/aviation');
    expect(screen.getByRole('button', { name: 'Print for class' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Compare' })).toBeTruthy();
  });

  it('labels event-wide sections and per-aircraft findings in multi-aircraft events', async () => {
    renderApp('/cases/SEA08LA057');
    await screen.findByRole('heading', { level: 1, name: /Piper PA 28-180 and Barnard\/Stancil Glastar, midair collision/ });
    expect(screen.getAllByText('Event-wide').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/Text 1 of 2\. Published for the event, not one aircraft; filed with aircraft A\./)).toBeTruthy();
    expect(screen.getByText(/Findings recorded for aircraft A/)).toBeTruthy();
    expect(screen.getByText(/Findings recorded for aircraft B/)).toBeTruthy();
    expect(screen.getByText(/This event involved 2 aircraft/)).toBeTruthy();
  });

  it('marks records outside the completed set and says when no probable cause is on record', async () => {
    renderApp('/cases/CEN23LA137');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('OTHER STATUS')).toBeTruthy();
    expect(screen.getByText('NTSB status:').textContent).toContain('P');
    expect(screen.getByText('No probable cause on record.')).toBeTruthy();
  });

  it('a completed record without probable-cause text: muted line by the badge, empty-field line in the story', async () => {
    renderApp('/cases/ENG10WA034');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('COMPLETED')).toBeTruthy();
    expect(screen.getByText('Probable-cause text unavailable')).toBeTruthy();
    expect(screen.getByText('No probable cause on record.')).toBeTruthy();
  });

  it('shows a not-found page for unknown numbers', async () => {
    renderApp('/cases/XXX99XX999');
    expect(await screen.findByText('No investigation has that number.')).toBeTruthy();
  });
});

describe('Compare page', () => {
  it('two cases read "Same in both"', async () => {
    renderApp('/compare?cases=MIA08LA156,DFW08TA066');
    expect(await screen.findByText(/^Same in both:/)).toBeTruthy();
  });

  it('shows flight strips with NTSB columns, the same-in-all line and sorting', async () => {
    renderApp('/compare?cases=MIA08LA156,DFW08TA066,NYC08LA106,DEN08LA103');
    expect(await screen.findByRole('heading', { name: 'Comparing 4 cases' })).toBeTruthy();
    expect(await screen.findByText(/Same in all four:/)).toBeTruthy();
    const strips = screen.getAllByRole('article');
    expect(strips.map((s) => s.getAttribute('aria-label'))).toEqual([
      'MIA08LA156, strip 1',
      'DFW08TA066, strip 2',
      'NYC08LA106, strip 3',
      'DEN08LA103, strip 4',
    ]);
    expect(within(strips[0] as HTMLElement).getByText('Probable cause')).toBeTruthy();
    expect(screen.getByText('VMC')).toBeTruthy();
    expect(screen.queryByText(/Since maint|Established/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Print for class' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'date' } });
    expect(screen.getAllByRole('article').map((s) => s.getAttribute('aria-label'))).toEqual([
      'DFW08TA066, strip 2',
      'NYC08LA106, strip 3',
      'DEN08LA103, strip 4',
      'MIA08LA156, strip 1',
    ]);
    expect(screen.getByText(/Sorted by date, oldest first/)).toBeTruthy();
  });
});
