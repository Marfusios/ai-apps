/**
 * Every route's tab title is built once, in shared code (shared/page-titles.ts), and used by the
 * web client's pages and by the server's page head (server/seo/head.ts). Expected strings are
 * written out, so a change to the copy fails a test.
 */
import { describe, expect, it } from 'vitest';
import { compareHeading, pageTitle, type TitledPage } from '../../shared/page-titles.js';

const MONTEVIDEO = 'Piper PA-28-235, total loss of engine power on final near Montevideo, Minnesota';

describe('page titles (shared by the server and the client)', () => {
  it.each<readonly [TitledPage, string]>([
    [{ kind: 'home' }, 'AirCase · Plane crash & accident investigations'],
    [{ kind: 'explore', q: '' }, 'Explore · AirCase'],
    [{ kind: 'explore', q: 'carburetor icing' }, '“carburetor icing” · Explore · AirCase'],
    [{ kind: 'explore', q: '  carburetor icing  ' }, '“carburetor icing” · Explore · AirCase'],
    [{ kind: 'explore', q: '   ' }, 'Explore · AirCase'],
    [{ kind: 'dashboard' }, 'The record, in questions · AirCase'],
    [{ kind: 'compare', count: 0 }, 'Comparing 0 cases · AirCase'],
    [{ kind: 'compare', count: 1 }, 'Comparing 1 case · AirCase'],
    [{ kind: 'compare', count: 4 }, 'Comparing 4 cases · AirCase'],
    [{ kind: 'account' }, 'Account · AirCase'],
    [{ kind: 'about' }, 'About · AirCase'],
    [{ kind: 'privacy' }, 'Privacy · AirCase'],
    [{ kind: 'brief' }, 'AI brief · AirCase'],
    [{ kind: 'evidence' }, 'AI search · AirCase'],
    [{ kind: 'not_found' }, 'Page not found · AirCase'],
  ])('%j → %s', (page, title) => {
    expect(pageTitle(page)).toBe(title);
  });

  it('a case: its headline, the event year and the NTSB number (owner request of 2026-10-24, SEO)', () => {
    expect(pageTitle({ kind: 'case', ntsbNo: 'CEN26LA211', detail: { headline: MONTEVIDEO, date: '2026-07-17' } })).toBe(
      'Piper PA-28-235, total loss of engine power on final near Montevideo, Minnesota (2026) · NTSB CEN26LA211 · AirCase',
    );
  });

  it('a case while it loads, or that is not served: the NTSB number only', () => {
    expect(pageTitle({ kind: 'case', ntsbNo: 'CEN26LA211', detail: null })).toBe('NTSB CEN26LA211 · AirCase');
  });

  it('a case without an event date leaves the year out rather than inventing one', () => {
    expect(pageTitle({ kind: 'case', ntsbNo: 'CEN26LA211', detail: { headline: MONTEVIDEO, date: null } })).toBe(
      'Piper PA-28-235, total loss of engine power on final near Montevideo, Minnesota · NTSB CEN26LA211 · AirCase',
    );
  });

  it("Compare's heading is the title's own part", () => {
    expect(compareHeading(1)).toBe('Comparing 1 case');
    expect(compareHeading(3)).toBe('Comparing 3 cases');
  });
});
