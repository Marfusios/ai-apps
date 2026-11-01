/**
 * The admin page's "Automatic import" (UI_DESIGN §4.12, Task 26): the automatic NTSB importer's
 * status from `system.imports`, in each of the mock's five states (web/mock/imports.ts) and in
 * shapes the mock never makes. A stop for review and an overdue check come first, with what to do;
 * neither shows while all is well. Every result, reason, step and mode is said in words: no
 * identifier shows raw outside the secondary code lines. Times are in the viewer's zone, named; the
 * NTSB file's advertised date is a date with no zone.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminOverviewSchema, IMPORT_REASONS, IMPORT_RESULTS, IMPORT_STEPS, type AdminImportRun, type AdminOverview } from '../../shared/contracts/admin';
import { mockAdminOverview } from '../../web/mock/admin';
import { formatDate } from '../../shared/format';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence';
import type { MockImportState } from '../../web/mock/imports';
import { formatDateTime, formatUsd, viewerTimeZone } from '../../web/src/features/admin/format';
import {
  IMPORT_COPY,
  IMPORT_MODE_WORDS,
  IMPORT_REASON_WORDS,
  IMPORT_RESULT_MEANINGS,
  IMPORT_STEP_WORDS,
  importCode,
  importOutcome,
} from '../../web/src/features/admin/imports';
import { MOCK_USER, createHandlers } from '../../web/src/mocks/handlers';
import { ADMIN_COPY } from '../../web/src/pages/Admin';
import { renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const tz = viewerTimeZone();

afterEach(() => {
  server.events.removeAllListeners();
});

/** Signed in as the mock's admin, its importer in `state`. */
function signedIn(state: MockImportState): void {
  window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
  server.use(...createHandlers({ googleEnabled: true, admin: true, evidence: MOCK_EVIDENCE_RELEASE, imports: state }));
}

/** The mock's overview in `state`, changed by `change` and served instead, validated with the contract first. */
function serve(state: MockImportState, change: (o: AdminOverview) => AdminOverview = (o) => o): AdminOverview {
  signedIn(state);
  const overview = AdminOverviewSchema.parse(change(mockAdminOverview({ now: new Date(), evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER, imports: state })));
  server.use(http.get('*/api/admin/overview', () => HttpResponse.json(overview, { headers: { 'cache-control': 'private, no-store' } })));
  return overview;
}

/** The admin page open; returns the "Automatic import" block. */
async function openImports(): Promise<HTMLElement> {
  renderApp('/admin');
  await screen.findByRole('heading', { level: 1, name: ADMIN_COPY.title }, SLOW);
  const system = await screen.findByRole('region', { name: ADMIN_COPY.system }, SLOW);
  return system.querySelector('[data-imports]') as HTMLElement;
}

const fact = (block: HTMLElement, label: string): HTMLElement | null => block.querySelector(`[data-fact="${label}"] dd`);
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const isBlock = (el: Element): boolean => /^(P|DIV|LI|TD|TH|DT|DD|UL|TABLE|TR)$/.test(el.tagName) || el.classList.contains('block');
/** The text as a reader sees it: a space between blocks (paragraphs, cells, lines), none inside a line. */
function spaced(root: Element | null): string {
  if (!root) return '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let out = '';
  let previous: Element | null | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = node.parentElement;
    while (block && block !== root && !isBlock(block)) block = block.parentElement;
    if (previous !== undefined && block !== previous) out += ' ';
    out += node.textContent ?? '';
    previous = block;
  }
  return out.replace(/\s+/g, ' ').trim();
}
/** An instant as the block says it: in the viewer's zone, the zone named. */
const zoned = (iso: string): string => `${formatDateTime(iso, tz)} (${tz})`;

/** The block's words outside its secondary code lines. */
function wordsOf(block: HTMLElement): string {
  const copy = block.cloneNode(true) as HTMLElement;
  for (const code of copy.querySelectorAll('[data-code]')) code.remove();
  return text(copy);
}

/** No identifier of a result, reason, step or mode shows outside the code lines. */
function noRawIdentifiers(block: HTMLElement): void {
  const words = wordsOf(block);
  expect(words).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  for (const cell of block.querySelectorAll('[data-import-runs-table] td, [data-import-runs-list] p')) {
    const value = text(cell);
    for (const id of [...IMPORT_RESULTS, ...IMPORT_REASONS, ...IMPORT_STEPS, 'automatic', 'forced_dev']) expect(value).not.toBe(id);
  }
}

describe('the automatic import, state by state', { timeout: 20_000 }, () => {
  it('healthy: no notice; the schedule, the next check, today’s check with no new file, the import days ago, and the runs', async () => {
    const o = serve('healthy');
    const imports = o.system.imports;
    const block = await openImports();
    expect(block.querySelector('[data-import-notice]')).toBeNull();
    expect(document.querySelector('[data-import-pointer]')).toBeNull();
    expect(text(fact(block, 'Schedule'))).toBe('Daily at 05:30, Europe/Prague');
    expect(text(fact(block, 'Next snapshot check'))).toBe(zoned(imports.schedule?.nextCheckAt as string));
    const last = imports.lastCheck as AdminImportRun;
    expect(spaced(fact(block, 'Last check'))).toBe(`${zoned(last.checkedAt)} No new file (NTSB still lists the 16 Oct 2026 file) unchanged · metadata_unchanged`);
    const success = imports.lastSuccessfulImport as AdminImportRun;
    expect(spaced(fact(block, 'Last successful import'))).toBe(`${zoned(success.finishedAt as string)} NTSB file of 16 Oct 2026 · generation 7 · cost ${formatUsd(success.costUsd)}`);
    // The recent runs: as a table (a tablet or a desktop) and as blocks (a phone), newest first.
    expect(block.textContent).toContain(IMPORT_COPY.runsIntro(tz));
    const table = within(block).getByRole('table', { name: IMPORT_COPY.runsCaption });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(imports.recentRuns.length);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Checked', 'Mode', 'Result', 'Reached', 'Cost']);
    expect(rows.map((r) => text(r.querySelector('th')))).toEqual(imports.recentRuns.map((r) => formatDateTime(r.checkedAt, tz)));
    expect(spaced(rows[0] ?? null)).toBe(`${formatDateTime(last.checkedAt, tz)} Automatic No new file (NTSB still lists the 16 Oct 2026 file) Complete $0.00`);
    const results = rows.map((r) => text(r.querySelectorAll('td')[1] ?? null));
    expect(results).toContain('File re-downloaded: identical');
    expect(results).toContain('Postponed: another import or a backup was running');
    expect(results).toContain('Imported generation 7');
    const list = within(block).getByRole('list', { name: IMPORT_COPY.runsCaption });
    expect(within(list).getAllByRole('listitem')).toHaveLength(imports.recentRuns.length);
    expect(spaced(within(list).getAllByRole('listitem')[0] ?? null)).toBe(`${formatDateTime(last.checkedAt, tz)} · Automatic No new file (NTSB still lists the 16 Oct 2026 file) Reached: Complete · cost $0.00`);
    noRawIdentifiers(block);
  });

  it('published today: the check imported generation 8, the last successful import with its file, generation and cost', async () => {
    const o = serve('published');
    const imports = o.system.imports;
    const block = await openImports();
    expect(block.querySelector('[data-import-notice]')).toBeNull();
    const run = imports.lastCheck as AdminImportRun;
    expect(spaced(fact(block, 'Last check'))).toBe(`${zoned(run.checkedAt)} Imported generation 8 published`);
    const file = formatDate(run.source?.advertisedAtLocal.slice(0, 10) ?? null);
    expect(spaced(fact(block, 'Last successful import'))).toBe(`${zoned(run.finishedAt as string)} NTSB file of ${file} · generation 8 · cost ${formatUsd(run.costUsd)}`);
    // The dataset above is the one the import published.
    const system = screen.getByRole('region', { name: ADMIN_COPY.system });
    expect(text(system.querySelector('[data-fact="Generation"] dd'))).toBe('8');
    noRawIdentifiers(block);
  });

  it('needs review: the notice comes first, naming the reason, what still serves and how to resolve it; the last check says it stopped', async () => {
    serve('needs_review');
    const block = await openImports();
    const notice = within(block).getByRole('note', { name: IMPORT_COPY.attentionTitle });
    expect(block.firstElementChild).toBe(notice);
    // At the head of the page, one line says so and takes the reader to the notice.
    const pointer = document.querySelector('[data-import-pointer]') as HTMLElement;
    expect(spaced(pointer)).toBe(IMPORT_COPY.pointerAttention);
    expect(pointer.compareDocumentPosition(screen.getByRole('region', { name: ADMIN_COPY.users })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(pointer).getByRole('link', { name: IMPORT_COPY.pointerAttention }));
    expect(document.activeElement).toBe(notice);
    expect(spaced(notice)).toBe(
      `${IMPORT_COPY.attentionTitle} The last run stopped for review: the new file differs from the current data by more than the automatic limits allow. ` +
        'Nothing new is imported until an operator resolves it; the site keeps serving generation 7, the dataset above. ' +
        'needs_review · cohort_bounds ' +
        `${IMPORT_COPY.attentionHow} ${IMPORT_COPY.attentionCommands}.`,
    );
    expect(block.querySelector('[data-import-notice="overdue"]')).toBeNull();
    const last = spaced(fact(block, 'Last check'));
    expect(last).toContain('Stopped for review: the new file differs from the current data by more than the automatic limits allow');
    expect(last).toContain(IMPORT_RESULT_MEANINGS.needs_review);
    const table = within(block).getByRole('table', { name: IMPORT_COPY.runsCaption });
    expect(spaced(within(table).getAllByRole('row')[1] ?? null)).toContain('Verification');
    noRawIdentifiers(block);
  });

  it('overdue: the notice says the daily check has not succeeded for over 36 hours, when it last did, and where to look', async () => {
    const o = serve('overdue');
    const imports = o.system.imports;
    const block = await openImports();
    const notice = within(block).getByRole('note', { name: IMPORT_COPY.overdueTitle });
    fireEvent.click(within(document.querySelector('[data-import-pointer]') as HTMLElement).getByRole('link', { name: IMPORT_COPY.pointerOverdue }));
    expect(document.activeElement).toBe(notice);
    expect(spaced(notice)).toBe(
      `${IMPORT_COPY.overdueTitle} ${IMPORT_COPY.overdueText} ${IMPORT_COPY.overdueLast} ${zoned(imports.lastCheck?.checkedAt as string)}. ${IMPORT_COPY.overdueHow} ${IMPORT_COPY.overdueCommand}`,
    );
    expect(block.querySelector('[data-import-notice="attention"]')).toBeNull();
    const table = within(block).getByRole('table', { name: IMPORT_COPY.runsCaption });
    const results = within(table)
      .getAllByRole('row')
      .slice(1, 3)
      .map((r) => text(r.querySelectorAll('td')[1] ?? null));
    expect(results).toEqual(['Failed: it was interrupted', 'Postponed: NTSB or the app could not be reached']);
    noRawIdentifiers(block);
  });

  it('disabled: the schedule is off, with no next check, no checks and no runs; no notice', async () => {
    serve('disabled');
    const block = await openImports();
    expect(block.querySelector('[data-import-notice]')).toBeNull();
    expect(document.querySelector('[data-import-pointer]')).toBeNull();
    expect(text(fact(block, 'Schedule'))).toBe(IMPORT_COPY.off);
    expect(fact(block, 'Next snapshot check')).toBeNull();
    expect(text(fact(block, 'Last check'))).toBe(IMPORT_COPY.noneYet);
    expect(text(fact(block, 'Last successful import'))).toBe(IMPORT_COPY.noneYet);
    expect(block.textContent).toContain(IMPORT_COPY.noRuns);
    expect(block.querySelector('[data-import-runs-table]')).toBeNull();
    noRawIdentifiers(block);
  });
});

describe('shapes the mock never makes', { timeout: 20_000 }, () => {
  it('attention with no stopped run listed (an uncertain state, or a status that could not be read) says so, and never claims a reason', async () => {
    serve('healthy', (o) => ({ ...o, system: { ...o.system, imports: { ...o.system.imports, attentionRequired: true } } }));
    const block = await openImports();
    const notice = within(block).getByRole('note', { name: IMPORT_COPY.attentionTitle });
    expect(spaced(notice)).toContain(IMPORT_COPY.attentionUnknown);
    expect(notice.querySelector('[data-code]')).toBeNull();
  });

  it('both notices at once, attention first; enabled without a schedule is off; a running import and a forced dev run', async () => {
    serve('needs_review', (o) => {
      const runs = o.system.imports.recentRuns;
      const first = runs[0] as AdminImportRun;
      const running: AdminImportRun = { ...first, checkedAt: new Date(Date.parse(first.checkedAt) + 3_600_000).toISOString(), finishedAt: null, result: 'running', reason: null, step: 'index_passages', mode: 'forced_dev', costUsd: 0.0412 };
      return { ...o, system: { ...o.system, imports: { ...o.system.imports, overdue: true, schedule: null, recentRuns: [running, ...runs].slice(0, 20) } } };
    });
    const block = await openImports();
    expect([...block.querySelectorAll('[data-import-notice]')].map((n) => n.getAttribute('data-import-notice'))).toEqual(['attention', 'overdue']);
    expect(spaced(document.querySelector('[data-import-pointer]'))).toBe(`${IMPORT_COPY.pointerAttention} ${IMPORT_COPY.pointerOverdue}`);
    expect(text(fact(block, 'Schedule'))).toBe(IMPORT_COPY.off);
    const row = within(within(block).getByRole('table', { name: IMPORT_COPY.runsCaption })).getAllByRole('row')[1] as HTMLElement;
    expect(spaced(row).endsWith('Forced (dev) Running (passage index) Passage index $0.0412')).toBe(true);
    noRawIdentifiers(block);
  });

  it.each([
    ['the first 20', IMPORT_REASONS.slice(0, 20)],
    ['the other', IMPORT_REASONS.slice(20)],
  ])('every reason in words, %s reasons, in the runs and never raw', async (_part, reasons) => {
    const o = serve('healthy', (overview) => {
      const base = overview.system.imports.recentRuns[0] as AdminImportRun;
      const runs = reasons.map((reason, i): AdminImportRun => ({ ...base, checkedAt: new Date(Date.parse(base.checkedAt) - i * 86_400_000).toISOString(), result: 'needs_review', reason }));
      return { ...overview, system: { ...overview.system, imports: { ...overview.system.imports, recentRuns: runs } } };
    });
    const block = await openImports();
    const table = within(block).getByRole('table', { name: IMPORT_COPY.runsCaption });
    const results = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => text(r.querySelectorAll('td')[1] ?? null));
    expect(results).toEqual(o.system.imports.recentRuns.map((r) => `Stopped for review: ${IMPORT_REASON_WORDS[r.reason as keyof typeof IMPORT_REASON_WORDS]}`));
    noRawIdentifiers(block);
  });
});

describe('how a run is said', () => {
  const run: AdminImportRun = {
    checkedAt: '2026-11-01T04:30:04.000Z',
    finishedAt: '2026-11-01T04:31:04.000Z',
    mode: 'automatic',
    source: { advertisedAtLocal: '2026-10-01T06:12:37', bytes: 104_857_311 },
    archiveSha256: 'a'.repeat(64),
    generationId: null,
    step: 'complete',
    result: 'unchanged',
    reason: 'metadata_unchanged',
    costUsd: 0,
  };

  it('the brief’s outcomes, the advertised date as NTSB gives it (no zone)', () => {
    expect(importOutcome(run)).toBe('No new file (NTSB still lists the 1 Oct 2026 file)');
    expect(importOutcome({ ...run, source: null })).toBe('No new file');
    expect(importOutcome({ ...run, reason: 'same_archive' })).toBe('File re-downloaded: identical');
    expect(importOutcome({ ...run, reason: 'same_content' })).toBe('File re-downloaded: the same content, repackaged');
    expect(importOutcome({ ...run, reason: null })).toBe('No change');
    expect(importOutcome({ ...run, result: 'published', reason: null, generationId: 8 })).toBe('Imported generation 8');
    expect(importOutcome({ ...run, result: 'published', reason: null })).toBe('Imported a new snapshot');
    expect(importOutcome({ ...run, result: 'deferred', reason: 'busy', step: 'check' })).toBe('Postponed: another import or a backup was running');
    expect(importOutcome({ ...run, result: 'deferred', reason: 'backup_window', step: 'check' })).toBe('Postponed: it was the nightly backup window');
    expect(importOutcome({ ...run, result: 'skipped_dev_failed', reason: 'dev_failed', step: 'check' })).toBe('Live skipped: the dev check failed');
    expect(importOutcome({ ...run, result: 'needs_review', reason: 'cohort_bounds', step: 'verify' })).toBe('Stopped for review: the new file differs from the current data by more than the automatic limits allow');
    expect(importOutcome({ ...run, result: 'failed', reason: 'interrupted' })).toBe('Failed: it was interrupted');
    expect(importOutcome({ ...run, result: 'cancelled', reason: 'lock_lost' })).toBe('Cancelled: it lost its lock');
    expect(importOutcome({ ...run, result: 'rolled_back', reason: null })).toBe('Rolled back: the previous dataset serves again');
    expect(importOutcome({ ...run, result: 'running', reason: null, step: 'index_cases' })).toBe('Running (case index)');
    expect(importCode({ ...run, result: 'needs_review', reason: 'cohort_bounds' })).toBe('needs_review · cohort_bounds');
    expect(importCode({ ...run, result: 'published', reason: null })).toBe('published');
  });

  it('every reason, result, step and mode has its words: plain, sentence case, never an identifier', () => {
    for (const reason of IMPORT_REASONS) {
      const words = IMPORT_REASON_WORDS[reason];
      // A clause after a lead: lowercase, but for NTSB's name.
      expect(words, reason).toMatch(/^([a-z]|NTSB)/);
      expect(words, reason).not.toMatch(/_|\.$/);
      for (const result of ['needs_review', 'deferred', 'failed', 'cancelled'] as const) expect(importOutcome({ ...run, result, reason })).toMatch(/^(Stopped for review|Postponed|Failed|Cancelled): ([a-z]|NTSB)/);
    }
    expect(new Set(Object.values(IMPORT_REASON_WORDS)).size).toBe(IMPORT_REASONS.length);
    for (const result of IMPORT_RESULTS) expect(IMPORT_RESULT_MEANINGS[result], result).toMatch(/^[A-Z][^_]*\.$/);
    for (const step of IMPORT_STEPS) expect(IMPORT_STEP_WORDS[step], step).toMatch(/^[A-Z][a-z ]+$/);
    expect(Object.values(IMPORT_MODE_WORDS)).toEqual(['Automatic', 'Forced (dev)']);
  });
});
