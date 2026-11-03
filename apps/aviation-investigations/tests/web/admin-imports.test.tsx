import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AdminOverviewSchema, type AdminOverview } from '../../shared/contracts/admin';
import { mockAdminOverview } from '../../web/mock/admin';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence';
import { MOCK_IMPORT_STATES, type MockImportState } from '../../web/mock/imports';
import {
  formatDateTime,
  formatDay,
  viewerTimeZone,
} from '../../web/src/features/admin/format';
import {
  alertDetails,
  sourceDay,
  UNKNOWN_IMPORT_STATUS,
} from '../../web/src/features/admin/imports';
import { MOCK_USER, createHandlers } from '../../web/src/mocks/handlers';
import { ADMIN_COPY } from '../../web/src/pages/Admin';
import { renderApp, setupMockApi } from './render-app';
const server = setupMockApi();
const NOW = new Date('2026-11-01T07:15:00Z');
function serve(
  state: MockImportState,
  change: (o: AdminOverview) => AdminOverview = (o) => o,
): AdminOverview {
  window.sessionStorage.setItem(
    'casebook-mock-account',
    JSON.stringify({ signedIn: true, registered: true }),
  );
  server.use(
    ...createHandlers({
      googleEnabled: true,
      admin: true,
      evidence: MOCK_EVIDENCE_RELEASE,
      imports: state,
    }),
  );
  const o = AdminOverviewSchema.parse(
    change(
      mockAdminOverview({
        now: NOW,
        evidence: MOCK_EVIDENCE_RELEASE,
        ratings: { useful: 0, notUseful: 0 },
        admin: MOCK_USER,
        imports: state,
      }),
    ),
  );
  server.use(
    http.get('*/api/admin/overview', () =>
      HttpResponse.json(o, { headers: { 'cache-control': 'private, no-store' } }),
    ),
  );
  return o;
}
async function open() {
  renderApp('/admin');
  await screen.findByRole(
    'heading',
    { level: 1, name: ADMIN_COPY.title },
    { timeout: 5000 },
  );
  const system = await screen.findByRole(
    'region',
    { name: ADMIN_COPY.system },
    { timeout: 5000 },
  );
  return system.querySelector('[data-imports]') as HTMLElement;
}
const fact = (block: HTMLElement, label: string) =>
  block.querySelector(`[data-fact="${label}"] dd`)?.textContent ?? '';
describe('automatic import alerts and facts', { timeout: 20000 }, () => {
  it.each(MOCK_IMPORT_STATES)(
    '%s shows server severity and no review controls',
    async (state) => {
      const o = serve(state);
      const block = await open();
      const a = o.system.imports.alert;
      const alert = document.querySelector('[data-import-alert]');
      expect(Boolean(alert)).toBe(Boolean(a));
      if (a) {
        expect(alert!.getAttribute('data-import-alert')).toBe(a.level);
        expect(
          alert!.classList.contains(
            a.level === 'fix' ? 'border-l-magenta' : 'border-l-ink',
          ),
        ).toBe(true);
        expect(
          alert!.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).not.toBe(0);
        expect(
          within(alert as HTMLElement).getByRole('button', { name: 'Copy details' }),
        ).not.toBeNull();
        expect(alert!.querySelector('code')?.textContent).toBe(
          alertDetails(o.system.imports, viewerTimeZone(), true),
        );
      }
      const copy = document.querySelector('main')!.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[data-import-details]').forEach((x) => x.remove());
      expect(copy.textContent).not.toMatch(
        /\b[a-z]+_[a-z_]+\b|pnpm importer|rebaseline|approve|acknowledge-preartifact/,
      );
      expect(
        within(block).getByRole('list', { name: 'Recent import runs' }),
      ).not.toBeNull();
    },
  );
  it('shows new, updated and removed counts and import cost, without generation IDs in the outcome', async () => {
    serve('published', (o) => {
      o.system.imports.recentRuns[0]!.generationId = 987654321;
      return o;
    });
    const block = await open();
    expect(within(block).getByRole('list').textContent).not.toContain('987654321');
    expect(block.textContent).toContain('152 new cases, 501 updated, 2 removed');
    expect(within(block).getByRole('list').textContent).toContain('$0.19');
    expect(fact(block, 'Data on the site')).toContain('31 Oct 2026');
    expect(fact(block, 'Next check')).toContain('Every day at 05:30, Europe/Prague');
  });
  it('copies technical diagnostics and exposes clipboard failure accessibly', async () => {
    const o = serve('schema');
    await open();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await screen.findByText('Details copied.');
    expect(writeText).toHaveBeenCalledWith(
      alertDetails(o.system.imports, viewerTimeZone()),
    );
    writeText.mockRejectedValueOnce(new Error('unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    const failed = await screen.findByText(
      'Copy did not work. Select the details and copy them.',
    );
    expect(failed.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelector('[data-import-details]')?.textContent).toBe(
      alertDetails(o.system.imports, viewerTimeZone()),
    );
    fireEvent.click(screen.getByRole('button', { name: ADMIN_COPY.refresh }));
    await waitFor(() =>
      expect(
        screen.queryByText('Copy did not work. Select the details and copy them.'),
      ).toBeNull(),
    );
  });
  it('overdue names the actual last start, while source dates never shift timezone', async () => {
    const o = serve('overdue');
    await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      `No import check has run since ${formatDateTime(o.system.imports.lastStartedAt!, viewerTimeZone())}`,
    );
    expect(sourceDay('2026-11-01T00:00:00')).toBe('1 Nov 2026');
  });
  it('explains dev’s failed file holding live back', async () => {
    serve('dev_failed', (o) => ({ ...o, system: { ...o.system, appEnv: 'live' } }));
    await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'The new file failed in the test copy of the site (dev). Live was not touched.',
    );
  });
  it('keeps a post-success import done and shows the incident separately', async () => {
    serve('post_success_storage');
    const block = await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'The import finished',
    );
    expect(within(block).getByRole('list').textContent).toContain('Imported the');
    expect(fact(block, 'Data on the site')).toContain('Imported');
  });
});

describe('the exact operator copy and recovery facts', () => {
  it.each(['healthy', 'never_run'] as const)(
    '%s says Working with no invented checks',
    async (state) => {
      serve(state);
      const block = await open();
      expect(block.querySelector('p')?.textContent).toContain('Working');
      expect(block.querySelector('p')?.textContent).toContain(
        'Each new NTSB file goes in by itself.',
      );
      if (state === 'never_run') {
        expect(fact(block, 'Last check')).toBe('No check recorded yet');
        expect(block.textContent).toContain('No runs recorded yet.');
      }
    },
  );
  it('Delayed dates the start of the outage and promises a daily retry', async () => {
    const o = serve('delayed');
    const block = await open();
    expect(block.querySelector('p')?.textContent).toContain(
      `Since ${formatDay(o.system.imports.alert!.since!, viewerTimeZone())}, retrying daily.`,
    );
    const alert = document.querySelector('[data-import-alert]')!;
    expect(alert.textContent).toContain('The NTSB download or the site did not answer.');
    expect(alert.textContent).toContain('Imports have failed on 3 different days.');
    expect(alert.textContent).toContain(
      'The system tries again every day. Nothing for you to do.',
    );
    expect(block.querySelector('[data-fact="Waiting"]')).toBeNull();
    expect(within(block as HTMLElement).getByRole('list').textContent).toContain(
      'Failed: The NTSB download',
    );
  });
  it('a schema fix explains the file and waiting reason, but charges only the published row', async () => {
    const o = serve('schema');
    const block = await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'The file’s tables or columns changed. AirCase cannot read it.',
    );
    expect(fact(block, 'Waiting')).toContain('Not imported: AirCase can’t read it');
    expect(o.system.imports.recentRuns[0]).toMatchObject({
      result: 'waiting',
      costUsd: 0.1873,
    });
    const rows = within(block).getByRole('list').querySelectorAll('li');
    for (let i = 0; i < o.system.imports.recentRuns.length; i++) {
      if (o.system.imports.recentRuns[i]!.result !== 'published')
        expect(rows[i]!.textContent).not.toContain('$');
    }
    expect(rows[2]!.querySelector('.text-magenta')).not.toBeNull();
  });
  it('Off shows None for the next check', async () => {
    serve('disabled');
    const block = await open();
    expect(block.querySelector('p')?.textContent).toBe(
      'OffAutomatic import is turned off.',
    );
    expect(fact(block, 'Next check')).toBe('None');
  });
  it('overdue never claims that daily checks are running and invents no failed run', async () => {
    const o = serve('overdue');
    const block = await open();
    expect(block.querySelector('p')?.textContent).toContain(
      `No check since ${formatDateTime(o.system.imports.lastStartedAt!, viewerTimeZone())}.`,
    );
    expect(document.querySelector('main')?.textContent).not.toContain(
      'still checks every day',
    );
    expect(alertDetails(o.system.imports, 'UTC')).not.toMatch(/failed|check/);
  });
  it('monthly budget explains the calendar reset in both the alert and chip', async () => {
    const o = serve('monthly_budget');
    const block = await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'This month’s OpenAI spending limit is used up.',
    );
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'The import continues on the 1st of next month.',
    );
    expect(block.querySelector('p')?.textContent).toContain(
      `Since ${formatDay(o.system.imports.alert!.since!, viewerTimeZone())}. Continues on the 1st of next month.`,
    );
    expect(fact(block, 'Waiting')).toContain(
      'Not imported: this month’s spending limit is used up',
    );
  });
  it('live shrink names the different data on dev and live', async () => {
    serve('dev_shrunk', (o) => ({ ...o, system: { ...o.system, appEnv: 'live' } }));
    const block = await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'Dev has the new file. Live still has the previous file.',
    );
    expect(fact(block, 'Waiting')).toContain('Not imported: it looks damaged');
  });
  it.each(['alias_unknown', 'rollback_failed'] as const)(
    '%s warns about mixed data without claiming restoration',
    async (state) => {
      serve(state);
      await open();
      const text = document.querySelector('[data-import-alert]')!.textContent;
      expect(text).toContain('The site may show mixed data.');
      expect(text).not.toContain('The site checks passed.');
    },
  );
  it('cleanup after good imports preserves successful rows and names the later task', async () => {
    serve('post_success');
    const block = await open();
    const text = document.querySelector('[data-import-alert]')!.textContent;
    expect(text).toContain('The import finished.');
    expect(text).toContain('A later task failed on 3 different days.');
    expect(text).not.toContain('Imports have failed');
    expect(within(block).getByRole('list').textContent).not.toContain('Failed:');
  });
  it('unreadable status labels every fact as unknown and gives only the three recovery sentences', async () => {
    const o = serve('unreadable');
    const block = await open();
    const alert = document.querySelector('[data-import-alert]')!;
    expect([...alert.querySelectorAll('.space-y-1 p')].map((p) => p.textContent)).toEqual(
      [
        'AirCase cannot read the import status.',
        'Reload the page. If this stays, the server or its database needs a fix.',
        'The alert goes away when the status can be read again.',
      ],
    );
    for (const dd of block.querySelectorAll('dd'))
      expect(dd.textContent).toBe(UNKNOWN_IMPORT_STATUS);
    expect(block.querySelectorAll('dd')).toHaveLength(4);
    expect(within(block).getAllByText(UNKNOWN_IMPORT_STATUS)).toHaveLength(5);
    expect(alertDetails(o.system.imports, 'UTC')).toBe('status_unavailable');
    expect(block.textContent).not.toMatch(/No runs|No check|Not recorded/);
    expect(fact(block, 'Last good check')).toBe(UNKNOWN_IMPORT_STATUS);
  });
  it('manual rollback names the restored data and passed site checks', async () => {
    const o = serve('manual_rollback');
    const block = await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      `The site went back to the data from ${sourceDay(o.system.imports.serving!.sourceDate)}.`,
    );
    expect(document.querySelector('[data-import-alert]')?.textContent).not.toContain(
      'The site was returned',
    );
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      'The site checks passed.',
    );
    expect(fact(block, 'Data on the site')).toContain('Restored');
  });
  it('an unverified restore says exactly what is still outstanding', async () => {
    const o = serve('restore_unverified');
    const block = await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(
      `AirCase switched back to the data from ${sourceDay(o.system.imports.serving!.sourceDate)}. Its site check has not passed yet.`,
    );
    expect(document.querySelector('[data-import-alert]')?.textContent).not.toContain(
      'The site checks passed',
    );
    expect(fact(block, 'Waiting')).toContain('Not imported: it failed the site checks');
  });
  it('a temporary dev deferral never says the file failed', async () => {
    serve('dev_temporary', (o) => ({ ...o, system: { ...o.system, appEnv: 'live' } }));
    await open();
    const text = document.querySelector('[data-import-alert]')!.textContent;
    expect(text).toContain('Live was not touched.');
    expect(text).not.toContain('The new file failed');
  });
  it('legacy rows describe the removed review rule', async () => {
    serve('legacy');
    const block = await open();
    expect(fact(block, 'Last check')).toContain(
      'An old review rule stopped it. This rule is gone.',
    );
    expect(fact(block, 'Waiting')).toContain('Not imported yet');
    expect(fact(block, 'Waiting')).not.toContain('needs a fix');
  });
});

describe('round 2 status rendering', () => {
  it.each(['post_success', 'post_success_storage'] as const)(
    '%s has a daily next step',
    async (state) => {
      serve(state);
      await open();
      const text = document.querySelector('[data-import-alert]')!.textContent;
      expect(text).toContain(
        state === 'post_success'
          ? 'The system tries again every day. Nothing for you to do.'
          : 'The system still tries every day. The server or service needs a fix.',
      );
      expect(text).not.toContain('then release');
    },
  );
  it('a temporary waiting file has no invented fix requirement', async () => {
    serve('cache_miss');
    const block = await open();
    expect(fact(block, 'Waiting')).toContain(
      'Not imported yet: the system tries again every day',
    );
  });
  it('Off with unreadable status shows unknown facts and no alert', async () => {
    serve('disabled_unreadable');
    const block = await open();
    expect(block.textContent).toContain('Off');
    expect(block.textContent?.split(UNKNOWN_IMPORT_STATUS)).toHaveLength(6);
    expect(document.querySelector('[data-import-alert]')).toBeNull();
    expect(block.textContent).not.toMatch(/No runs|No check|Not recorded/);
    expect(fact(block, 'Last check')).toBe(UNKNOWN_IMPORT_STATUS);
    expect(block.querySelector('[data-fact="Last good check"]')).toBeNull();
  });
  it.each(['delayed', 'legacy', 'dev_failed', 'fix'] as const)(
    '%s colors only failed or cancelled rows',
    async (state) => {
      const o = serve(state);
      await open();
      const runs = screen
        .getByRole('list', { name: 'Recent import runs' })
        .querySelectorAll('li');
      o.system.imports.recentRuns.forEach((run, i) =>
        expect(runs[i]!.querySelector('.text-magenta') !== null).toBe(
          ['failed', 'cancelled'].includes(run.result),
        ),
      );
    },
  );
  it('an overdue restore hold remains stated and copied without fictitious runs', async () => {
    const o = serve('restore_hold');
    await open();
    const text = document.querySelector('[data-import-alert]')!.textContent;
    expect(text).toContain('No import check has run since');
    expect(text).toContain(
      'Imports are stopped until the restored spending records are checked.',
    );
    expect(text).toContain(
      'A person must check the cost records. The alert goes away after the next good import.',
    );
    expect(alertDetails(o.system.imports, 'UTC')).toContain('restore_hold');
    expect(o.system.imports.alert?.details).toBeNull();
    expect(o.system.imports.recentRuns.some((r) => r.reason === 'restore_hold')).toBe(
      false,
    );
  });
});
