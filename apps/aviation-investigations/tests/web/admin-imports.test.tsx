/**
 * The admin page's "Automatic import" (UI_DESIGN §4.12, Task 26): the automatic NTSB importer's
 * status from `system.imports`, in each of the mock's server-shaped states (web/mock/imports.ts) and
 * in shapes the mock never makes. An open review and an overdue check come first, saying what they
 * mean for the data that serves and how to resolve that kind of review with the documented commands;
 * where the kind is not certain, a neutral notice with no command; neither shows while all is well.
 * A rollback is suggested only for a stop at or after the publication. The facts tell the latest
 * listed run from the last completed check (only an unchanged or published run). Every result,
 * reason, step and mode is said in words: no identifier shows raw outside the secondary code lines
 * and the commands. Times are in the viewer's zone, named; the NTSB file's advertised date is a date
 * with no zone.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminOverviewSchema, IMPORT_REASONS, IMPORT_RESULTS, IMPORT_STEPS, type AdminImportRun, type AdminOverview } from '../../shared/contracts/admin';
import { formatDate } from '../../shared/format';
import { mockAdminOverview } from '../../web/mock/admin';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence';
import type { MockImportState } from '../../web/mock/imports';
import { formatDateTime, formatDay, formatUsd, viewerTimeZone } from '../../web/src/features/admin/format';
import { IMPORT_COPY, IMPORT_RESULT_MEANINGS, RUN_MEANINGS, importOutcome, importView, reasonWords } from '../../web/src/features/admin/imports';
import { MOCK_USER, createHandlers } from '../../web/src/mocks/handlers';
import { ADMIN_COPY } from '../../web/src/pages/Admin';
import { renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const tz = viewerTimeZone();
/** 08:15 in Prague, after the day's 05:30 check: a stop today leaves yesterday's check as the last completed one (under 36 hours). */
const NOW = new Date('2026-11-01T07:15:00.000Z');
/** The mock admin page's environment (the commands name it). */
const ENV = '--config <importer.json> --env dev';

afterEach(() => {
  server.events.removeAllListeners();
});

/** The mock's overview in `state` as of `NOW`, changed by `change`, served (validated with the contract first) to the signed-in mock admin. */
function serve(state: MockImportState, change: (o: AdminOverview) => AdminOverview = (o) => o): AdminOverview {
  window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
  server.use(...createHandlers({ googleEnabled: true, admin: true, evidence: MOCK_EVIDENCE_RELEASE, imports: state }));
  const overview = AdminOverviewSchema.parse(change(mockAdminOverview({ now: NOW, evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER, imports: state })));
  server.use(http.get('*/api/admin/overview', () => HttpResponse.json(overview, { headers: { 'cache-control': 'private, no-store' } })));
  return overview;
}

/** Changes the served overview's importer status. */
const withImports =
  (change: (imports: AdminOverview['system']['imports']) => AdminOverview['system']['imports']) =>
  (o: AdminOverview): AdminOverview => ({ ...o, system: { ...o.system, imports: change(o.system.imports) } });

/** The admin page open; returns the "Automatic import" block. */
async function openImports(): Promise<HTMLElement> {
  renderApp('/admin');
  await screen.findByRole('heading', { level: 1, name: ADMIN_COPY.title }, SLOW);
  const system = await screen.findByRole('region', { name: ADMIN_COPY.system }, SLOW);
  return system.querySelector('[data-imports]') as HTMLElement;
}

const fact = (block: HTMLElement, label: string): HTMLElement | null => block.querySelector(`[data-fact="${label}"] dd`);
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const isBlock = (el: Element): boolean => /^(P|DIV|LI|TD|TH|DT|DD|UL|TABLE|TR|H4|CODE)$/.test(el.tagName) || el.classList.contains('block');
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
const notice = (block: HTMLElement, kind: 'attention' | 'overdue'): HTMLElement | null => block.querySelector(`[data-import-notice="${kind}"]`);
const pointer = (): HTMLElement | null => document.querySelector('[data-import-pointer]');
/** The commands a notice shows, as they copy, each with its note. */
const commandsOf = (el: Element | null): string[] => [...(el?.querySelectorAll('[data-import-commands] > div') ?? [])].map((c) => spaced(c));
const IDENTIFIERS = new Set<string>([...IMPORT_RESULTS, ...IMPORT_REASONS, ...IMPORT_STEPS, 'automatic', 'forced_dev']);
const DRY_RUN = IMPORT_COPY.dryRun;
const REBASELINE = `pnpm importer rebaseline ${ENV} --publication-sha256 <current-publication-sha256> ${DRY_RUN}`;

/** No identifier shows outside the code lines and the commands: no word with an underscore, and no outcome, step or mode that is an identifier or not in sentence case. */
function noRawIdentifiers(block: HTMLElement): void {
  const copy = block.cloneNode(true) as HTMLElement;
  for (const code of copy.querySelectorAll('[data-code], [data-import-commands]')) code.remove();
  expect(text(copy)).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  for (const el of block.querySelectorAll('[data-outcome], [data-step], [data-mode]')) {
    const value = text(el);
    expect(IDENTIFIERS.has(value), value).toBe(false);
    expect(value).toMatch(/^([A-Z]|—)/);
  }
}

/** The runs table's rows, as their cells read. */
function tableRows(block: HTMLElement): string[][] {
  const table = within(block).getByRole('table', { name: IMPORT_COPY.runsCaption });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => spaced(cell)));
}

describe('the automatic import, state by state', { timeout: 20_000 }, () => {
  it('healthy: no notice; the schedule, the next check, today’s run with no new file (the last completed check), the import days ago, and the runs', async () => {
    const o = serve('healthy');
    const imports = o.system.imports;
    const block = await openImports();
    expect(block.querySelector('[data-import-notice]')).toBeNull();
    expect(pointer()).toBeNull();
    expect(text(fact(block, 'Schedule'))).toBe('Daily at 05:30, Europe/Prague');
    expect(spaced(fact(block, 'Next snapshot check'))).toBe(zoned(imports.schedule?.nextCheckAt as string));
    const latest = imports.recentRuns[0] as AdminImportRun;
    expect(spaced(fact(block, 'Latest listed run'))).toBe(`${zoned(latest.checkedAt)} No new file (NTSB still lists the 16 Oct 2026 file) unchanged · metadata_unchanged`);
    expect(text(fact(block, 'Last completed check'))).toBe(IMPORT_COPY.sameAsLatest);
    const success = imports.lastSuccessfulImport as AdminImportRun;
    expect(spaced(fact(block, 'Last successful import'))).toBe(`${zoned(success.finishedAt as string)} NTSB file of 16 Oct 2026 · generation 7 · cost ${formatUsd(success.costUsd)}`);
    // The runs: as a table (where there is room) and as blocks (a phone, or beside Costs), newest first.
    expect(block.textContent).toContain(IMPORT_COPY.runsIntro(tz));
    const table = within(block).getByRole('table', { name: IMPORT_COPY.runsCaption });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Checked', 'Result', 'Reached', 'File cost']);
    const rows = tableRows(block);
    expect(rows).toHaveLength(imports.recentRuns.length);
    // A check that found nothing new did no work on the file: no file cost.
    expect(rows[0]).toEqual([`${formatDateTime(latest.checkedAt, tz)} Automatic`, 'No new file (NTSB still lists the 16 Oct 2026 file)', 'Complete', `—${IMPORT_COPY.noWork}`]);
    expect(rows[2]?.slice(1)).toEqual(['File re-downloaded: identical', 'Complete', `—${IMPORT_COPY.noWork}`]);
    // A run refused before it started reached no step and had no file: dashes, which screen readers hear as words.
    expect(rows[3]?.slice(1)).toEqual(['Postponed: another import or a backup was running', `—${IMPORT_COPY.notStarted}`, `—${IMPORT_COPY.noFile}`]);
    expect(rows[5]?.slice(1)).toEqual(['Imported generation 7', 'Complete', formatUsd(success.costUsd)]);
    const list = within(block).getByRole('list', { name: IMPORT_COPY.runsCaption });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(imports.recentRuns.length);
    expect(spaced(items[0] ?? null)).toBe(`${formatDateTime(latest.checkedAt, tz)} · Automatic No new file (NTSB still lists the 16 Oct 2026 file) Reached: Complete · file cost —${IMPORT_COPY.noWork}`);
    noRawIdentifiers(block);
  });

  it('published today: the latest listed run imported generation 8, the last successful import with its file, generation and cost', async () => {
    const o = serve('published');
    const run = o.system.imports.lastCheck as AdminImportRun;
    const block = await openImports();
    expect(block.querySelector('[data-import-notice]')).toBeNull();
    expect(spaced(fact(block, 'Latest listed run'))).toBe(`${zoned(run.checkedAt)} Imported generation 8 published`);
    expect(text(fact(block, 'Last completed check'))).toBe(IMPORT_COPY.sameAsLatest);
    const file = formatDate(run.source?.advertisedAtLocal.slice(0, 10) ?? null);
    expect(spaced(fact(block, 'Last successful import'))).toBe(`${zoned(run.finishedAt as string)} NTSB file of ${file} · generation 8 · cost ${formatUsd(run.costUsd)}`);
    expect(text(screen.getByRole('region', { name: ADMIN_COPY.system }).querySelector('[data-fact="Generation"] dd'))).toBe('8');
    noRawIdentifiers(block);
  });

  it('needs review: the notice first, with the stopped run’s date and reason, what serves, and how to resolve a comparison review with its commands and options', async () => {
    const o = serve('needs_review');
    const stopped = o.system.imports.recentRuns[0] as AdminImportRun;
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(block.firstElementChild).toBe(attention);
    expect(attention.getAttribute('role')).toBe('note');
    expect(within(attention).getByRole('heading', { level: 4, name: IMPORT_COPY.attentionTitle })).toBeTruthy();
    expect(spaced(attention)).toBe(
      `${IMPORT_COPY.attentionTitle} On ${formatDay(stopped.checkedAt, tz)}, a run stopped for review: the new file differs from the current data in a way the automatic checks do not accept. ` +
        'Nothing new is imported until it is resolved; the site keeps serving generation 7, the dataset above. ' +
        `needs_review · cohort_bounds ${IMPORT_COPY.how.comparison} ${commandsOf(attention).join(' ')}`,
    );
    expect(commandsOf(attention)).toEqual([`pnpm importer approve ${ENV} --artifact <archive-sha256> --approval <approval.json>`, `pnpm importer run ${ENV}`, REBASELINE]);
    expect(notice(block, 'overdue')).toBeNull();
    // At the head of the page, one line says so and takes the reader to the notice.
    expect(spaced(pointer())).toBe(IMPORT_COPY.pointerAttention);
    fireEvent.click(within(pointer() as HTMLElement).getByRole('link', { name: IMPORT_COPY.pointerAttention }));
    expect(document.activeElement).toBe(attention);
    // The facts: the latest listed run is the stop; the last completed check is the quiet one before it.
    expect(spaced(fact(block, 'Latest listed run'))).toBe(
      `${zoned(stopped.checkedAt)} Stopped for review: the new file differs from the current data in a way the automatic checks do not accept ${IMPORT_RESULT_MEANINGS.needs_review} needs_review · cohort_bounds`,
    );
    const previous = o.system.imports.lastCheck as AdminImportRun;
    expect(spaced(fact(block, 'Last completed check'))).toBe(`${zoned(previous.checkedAt)} No new file (NTSB still lists the 16 Oct 2026 file)`);
    // The stopped file's total so far.
    expect(tableRows(block)[0]?.slice(2)).toEqual(['Extraction', '$0.00']);
    noRawIdentifiers(block);
  });

  it('blocked: the stop three checks ago, each daily run since blocked by it, and the overdue notice says the runs wait for the review', async () => {
    const o = serve('blocked');
    const stopped = o.system.imports.recentRuns[3] as AdminImportRun;
    const block = await openImports();
    expect(spaced(notice(block, 'attention'))).toContain(`On ${formatDay(stopped.checkedAt, tz)}, a run stopped for review: the new file differs`);
    expect(spaced(notice(block, 'overdue'))).toBe(`${IMPORT_COPY.overdueTitle} ${IMPORT_COPY.overdueReview}`);
    expect(spaced(pointer())).toBe(`${IMPORT_COPY.pointerAttention} ${IMPORT_COPY.pointerOverdue}`);
    expect(spaced(fact(block, 'Latest listed run'))).toContain(`Blocked: an earlier run is waiting for review ${RUN_MEANINGS.blocked} deferred · cohort_bounds`);
    const rows = tableRows(block);
    expect(rows.slice(0, 3).map((r) => r.slice(1))).toEqual(Array.from({ length: 3 }, () => ['Blocked: an earlier run is waiting for review', 'Source check', '$0.00']));
    expect(rows[3]?.[1]).toBe('Stopped for review: the new file differs from the current data in a way the automatic checks do not accept');
    noRawIdentifiers(block);
  });

  it('after the switch: the new data may already be live, the probe blames the live site, and the importer clears it only by a rollback, then rebaseline', async () => {
    const o = serve('after_switch');
    const stopped = o.system.imports.recentRuns[0] as AdminImportRun;
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toBe(
      `${IMPORT_COPY.attentionTitle} On ${formatDay(stopped.checkedAt, tz)}, a run stopped after the switch to the new data: the live site did not pass its checks. ` +
        'The new data may already be live: the site serves generation 8, the dataset above. ' +
        `needs_review · probe ${IMPORT_COPY.how.after_switch} ${commandsOf(attention).join(' ')}`,
    );
    expect(commandsOf(attention)).toEqual([`pnpm importer rollback ${ENV} --artifact <archive-sha256> --publication-sha256 <publication-sha256>`, REBASELINE]);
    expect(spaced(attention)).not.toContain('Nothing new is imported');
    expect(spaced(fact(block, 'Latest listed run'))).toContain(RUN_MEANINGS.stoppedAfterSwitch);
    expect(tableRows(block)[0]?.slice(1, 3)).toEqual(['Stopped for review: the live site did not pass its checks', 'Site checks']);
    noRawIdentifiers(block);
  });

  it('rolled back: the review stays open until the data that serves is adopted with rebaseline; no second rollback', async () => {
    const o = serve('rolled_back');
    const rolled = o.system.imports.recentRuns[1] as AdminImportRun;
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toBe(
      `${IMPORT_COPY.attentionTitle} ${IMPORT_COPY.rolledBack(formatDay(rolled.checkedAt, tz))} rolled_back · probe ${IMPORT_COPY.how.rolled_back} ${REBASELINE}`,
    );
    expect(commandsOf(attention)).toEqual([REBASELINE]);
    expect(tableRows(block)[0]?.[1]).toBe('Blocked: an earlier run is waiting for review');
    expect(tableRows(block)[1]?.[1]).toBe('Rolled back: the previous dataset serves again');
    noRawIdentifiers(block);
  });

  it('a failed re-check of the serving data: nothing changed, fix the cause and re-certify; never blocked, waiting or a rollback', async () => {
    const o = serve('recertification');
    const failed = o.system.imports.recentRuns[0] as AdminImportRun;
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toBe(
      `${IMPORT_COPY.attentionTitle} On ${formatDay(failed.checkedAt, tz)}, the re-check of the serving data failed: the live site did not pass its checks. ` +
        `Nothing changed on the site: it keeps serving generation 7, the dataset above. deferred · probe ${IMPORT_COPY.how.recertification} pnpm importer recertify ${ENV}`,
    );
    expect(commandsOf(attention)).toEqual([`pnpm importer recertify ${ENV}`]);
    expect(spaced(notice(block, 'overdue'))).toBe(`${IMPORT_COPY.overdueTitle} ${IMPORT_COPY.overdueRecertification}`);
    const all = spaced(block);
    for (const wrong of ['rollback', 'Blocked', 'waiting', 'wait for the open review', 'may already be live']) expect(all, wrong).not.toContain(wrong);
    expect(spaced(fact(block, 'Latest listed run'))).toContain(`Re-check of the serving data failed: the live site did not pass its checks ${RUN_MEANINGS.recertification}`);
    // The re-check did no work on a file.
    expect(tableRows(block)[0]?.slice(1)).toEqual(['Re-check of the serving data failed: the live site did not pass its checks', 'Site checks', `—${IMPORT_COPY.noWork}`]);
    noRawIdentifiers(block);
  });

  it('a restore hold: the RUNBOOK and IMPORTER.md’s own words, and no importer command', async () => {
    serve('restore_hold');
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toContain('a run stopped for review: a database restore is waiting for review. Nothing new is imported until it is resolved; the site keeps serving generation 7, the dataset above.');
    expect(spaced(attention).endsWith(IMPORT_COPY.how.restore)).toBe(true);
    expect(attention.querySelector('[data-import-commands]')).toBeNull();
    expect(spaced(notice(block, 'overdue'))).toBe(`${IMPORT_COPY.overdueTitle} ${IMPORT_COPY.overdueReview}`);
    noRawIdentifiers(block);
  });

  it('the retired source: automatic imports have ended; turn the daily check off, stop the service, set the intent false and deploy, then acknowledge', async () => {
    serve('retired');
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toContain('a run stopped for review: the NTSB download the importer uses has been retired. Automatic imports have ended; the site keeps serving generation 7, the dataset above.');
    expect(spaced(attention)).toContain(IMPORT_COPY.how.retired);
    expect(commandsOf(attention)).toEqual([
      'systemctl --user disable --now aircase-importer.timer',
      'systemctl --user stop aircase-importer.service',
      `pnpm importer acknowledge-preartifact ${ENV} --run <run-uuid> --evidence-sha256 <evidence-sha256> ${DRY_RUN}`,
    ]);
    noRawIdentifiers(block);
  });

  it('an unreadable status: both notices hedge, and nothing claims a check or a review', async () => {
    serve('unreadable');
    const block = await openImports();
    expect(spaced(notice(block, 'attention'))).toBe(`${IMPORT_COPY.attentionTitle} ${IMPORT_COPY.unreadable} ${IMPORT_COPY.how.unreadable}`);
    expect(spaced(notice(block, 'overdue'))).toBe(`${IMPORT_COPY.overdueTitle} ${IMPORT_COPY.overdueUnreadable} ${IMPORT_COPY.overdueHow} ${IMPORT_COPY.overdueCommand}`);
    expect(spaced(block)).not.toContain(IMPORT_COPY.overdueNever);
    expect(fact(block, 'Latest listed run')).toBeNull();
    expect(text(fact(block, 'Last completed check'))).toBe(IMPORT_COPY.noneYet);
    expect(text(fact(block, 'Last successful import'))).toBe(IMPORT_COPY.noneYet);
    expect(block.textContent).toContain(IMPORT_COPY.noRuns);
    noRawIdentifiers(block);
  });

  it('overdue: no completed check for over 36 hours, when the last one was, and where to look; the latest listed run failed', async () => {
    const o = serve('overdue');
    const imports = o.system.imports;
    const block = await openImports();
    const overdue = notice(block, 'overdue') as HTMLElement;
    expect(spaced(overdue)).toBe(
      `${IMPORT_COPY.overdueTitle} ${IMPORT_COPY.overdueText} ${IMPORT_COPY.overdueLast} ${zoned(imports.lastCheck?.checkedAt as string)}. ${IMPORT_COPY.overdueHow} ${IMPORT_COPY.overdueCommand}`,
    );
    // The command is a line of its own that wraps only between its words.
    const command = overdue.querySelector('[data-import-commands] code') as HTMLElement;
    expect([...command.querySelectorAll('span')].map((s) => [s.textContent, s.className])).toEqual(
      ['journalctl', '--user', '-u', 'aircase-importer.service'].map((word) => [word, 'whitespace-nowrap']),
    );
    expect(notice(block, 'attention')).toBeNull();
    fireEvent.click(within(pointer() as HTMLElement).getByRole('link', { name: IMPORT_COPY.pointerOverdue }));
    expect(document.activeElement).toBe(overdue);
    expect(spaced(fact(block, 'Latest listed run'))).toContain(`Failed: it stopped unexpectedly ${IMPORT_RESULT_MEANINGS.failed}`);
    expect(tableRows(block)[1]?.slice(1, 3)).toEqual(['Postponed: NTSB or the app could not be reached', 'Source check']);
    noRawIdentifiers(block);
  });

  it('disabled: the schedule is off, with no next check, no runs and no notice', async () => {
    serve('disabled');
    const block = await openImports();
    expect(block.querySelector('[data-import-notice]')).toBeNull();
    expect(pointer()).toBeNull();
    expect(text(fact(block, 'Schedule'))).toBe(IMPORT_COPY.off);
    expect(fact(block, 'Next snapshot check')).toBeNull();
    expect(fact(block, 'Latest listed run')).toBeNull();
    expect(text(fact(block, 'Last completed check'))).toBe(IMPORT_COPY.noneYet);
    expect(text(fact(block, 'Last successful import'))).toBe(IMPORT_COPY.noneYet);
    expect(block.textContent).toContain(IMPORT_COPY.noRuns);
    expect(block.querySelector('[data-import-runs-table]')).toBeNull();
    noRawIdentifiers(block);
  });
});

describe('when the kind is not certain: a neutral notice, the latest listed run, no command', { timeout: 20_000 }, () => {
  /** The neutral notice's text, for the latest listed run `latest`. */
  const neutral = (latest: AdminImportRun, outcome: string): string =>
    `${IMPORT_COPY.attentionTitle} ${IMPORT_COPY.neutral} ${IMPORT_COPY.neutralLatest(formatDay(latest.checkedAt, tz), outcome)}`;

  it('a review resolved days ago does not explain a later open review (a restore latch)', async () => {
    const o = serve(
      'healthy',
      withImports((imports) => {
        const runs = [...imports.recentRuns];
        runs[8] = { ...(runs[8] as AdminImportRun), result: 'needs_review', reason: 'integrity', step: 'load' };
        return { ...imports, attentionRequired: true, recentRuns: runs };
      }),
    );
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    const latest = o.system.imports.recentRuns[0] as AdminImportRun;
    expect(spaced(attention)).toBe(`${neutral(latest, 'No new file (NTSB still lists the 16 Oct 2026 file)')} unchanged · metadata_unchanged ${IMPORT_COPY.how.neutral}`);
    expect(attention.querySelector('[data-import-commands]')).toBeNull();
  });

  it('a stop that has left the list: the runs it blocked read as postponed, and no kind is guessed from them (a post-switch stop must not read as safe)', async () => {
    const o = serve('after_switch', withImports((imports) => {
      // Twenty days later: only the blocked runs are listed, at the source check.
      const stopped = imports.recentRuns[0] as AdminImportRun;
      const blocked = Array.from({ length: 20 }, (_, i): AdminImportRun => ({ ...stopped, checkedAt: new Date(Date.parse(stopped.checkedAt) + (20 - i) * 86_400_000).toISOString(), finishedAt: null, result: 'deferred', step: 'check', source: null }));
      return { ...imports, overdue: true, recentRuns: blocked };
    }));
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    const latest = o.system.imports.recentRuns[0] as AdminImportRun;
    expect(spaced(attention)).toBe(`${neutral(latest, 'Postponed: the new search indexes did not pass their checks')} deferred · probe ${IMPORT_COPY.how.neutral}`);
    expect(attention.querySelector('[data-import-commands]')).toBeNull();
    for (const claim of ['Nothing new is imported', 'keeps serving', 'may already be live']) expect(spaced(attention)).not.toContain(claim);
    // The overdue notice gives the plain facts, not a cause.
    expect(spaced(notice(block, 'overdue'))).toContain(IMPORT_COPY.overdueText);
  });

  it('a stop on the cost records (after a restore, or a file’s 89 days): not one remedy, so neutral', async () => {
    serve('needs_review', withImports((imports) => ({ ...imports, recentRuns: [{ ...(imports.recentRuns[0] as AdminImportRun), reason: 'accounting', step: 'plan' }, ...imports.recentRuns.slice(1)] })));
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toContain(`${IMPORT_COPY.neutral} The latest listed run`);
    expect(spaced(attention)).toContain('Stopped for review: its cost records need reconciling');
    expect(attention.querySelector('[data-import-commands]')).toBeNull();
  });

  it('a candidate waiting for a failed dev check (a temporary reason, on a new file) is no re-check and no stop: neutral', async () => {
    serve('healthy', withImports((imports) => {
      const latest = imports.recentRuns[0] as AdminImportRun;
      const waiting: AdminImportRun = { ...latest, checkedAt: new Date(Date.parse(latest.checkedAt) + 60_000).toISOString(), result: 'deferred', reason: 'dev_failed', step: 'check', archiveSha256: 'b'.repeat(64) };
      return { ...imports, attentionRequired: true, recentRuns: [waiting, ...imports.recentRuns.slice(0, 19)] };
    }));
    const block = await openImports();
    expect(spaced(notice(block, 'attention'))).toContain(`${IMPORT_COPY.neutral} The latest listed run`);
    expect(spaced(notice(block, 'attention'))).toContain('Postponed: the dev check failed');
  });
});

describe('shapes the mock never makes', { timeout: 20_000 }, () => {
  it('a failed re-check of the serving data at the source check, with a review-class reason: still a re-check, not a blocked review', async () => {
    serve('recertification', withImports((imports) => ({ ...imports, overdue: false, recentRuns: imports.recentRuns.map((r, i) => (i < 2 ? { ...r, step: 'check' } : r)) })));
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toContain('the re-check of the serving data failed: the new search indexes did not pass their checks. Nothing changed on the site');
    expect(commandsOf(attention)).toEqual([`pnpm importer recertify ${ENV}`]);
  });

  it('with no dataset loaded, the notice names no generation', async () => {
    serve('needs_review', (o) => ({ ...o, system: { ...o.system, dataset: null } }));
    const block = await openImports();
    expect(spaced(notice(block, 'attention'))).toContain('accept. Nothing new is imported until it is resolved. needs_review');
  });

  it('the live page names its own environment in the commands', async () => {
    serve('needs_review', (o) => ({ ...o, system: { ...o.system, appEnv: 'live' } }));
    const block = await openImports();
    expect(commandsOf(notice(block, 'attention'))[1]).toBe('pnpm importer run --config <importer.json> --env live');
  });

  it.each([
    ['a stop before any file (a setup failure)', { result: 'needs_review', reason: 'configuration', step: 'check', archiveSha256: null }, 'preartifact', [`pnpm importer acknowledge-preartifact ${ENV} --run <run-uuid> --evidence-sha256 <evidence-sha256> ${DRY_RUN}`, REBASELINE]],
    ['a review of a downloaded file that no exception can accept', { result: 'needs_review', reason: 'integrity', step: 'load' }, 'candidate', [REBASELINE]],
    ['a switch that may not have finished', { result: 'needs_review', reason: 'alias_unknown', step: 'publish' }, 'after_switch', [`pnpm importer rollback ${ENV} --artifact <archive-sha256> --publication-sha256 <publication-sha256>`, REBASELINE]],
  ] as const)('%s: its own way to resolve it', async (_name, change, kind, commands) => {
    serve(
      'needs_review',
      withImports((imports) => ({ ...imports, recentRuns: [{ ...(imports.recentRuns[0] as AdminImportRun), ...change }, ...imports.recentRuns.slice(1)] })),
    );
    const block = await openImports();
    const attention = notice(block, 'attention') as HTMLElement;
    expect(spaced(attention)).toContain(IMPORT_COPY.how[kind]);
    expect(commandsOf(attention)).toEqual(commands);
  });

  it('both notices at once, attention first; enabled without a schedule is off; a running forced dev run', async () => {
    serve(
      'needs_review',
      withImports((imports) => {
        const first = imports.recentRuns[0] as AdminImportRun;
        const running: AdminImportRun = { ...first, checkedAt: new Date(Date.parse(first.checkedAt) + 3_600_000).toISOString(), finishedAt: null, result: 'running', reason: null, step: 'index_passages', mode: 'forced_dev', costUsd: 0.0412 };
        return { ...imports, overdue: true, schedule: null, recentRuns: [running, ...imports.recentRuns].slice(0, 20) };
      }),
    );
    const block = await openImports();
    expect([...block.querySelectorAll('[data-import-notice]')].map((n) => n.getAttribute('data-import-notice'))).toEqual(['attention', 'overdue']);
    expect(text(fact(block, 'Schedule'))).toBe(IMPORT_COPY.off);
    expect(tableRows(block)[0]?.slice(1)).toEqual(['Running (passage index)', 'Passage index', '$0.0412']);
    expect(tableRows(block)[0]?.[0]).toMatch(/Forced \(dev\)$/);
    noRawIdentifiers(block);
  });

  it('a long time zone breaks at its slashes instead of widening the page', async () => {
    serve('healthy');
    const block = await openImports();
    expect(block.querySelectorAll('[data-zoned] wbr').length).toBeGreaterThan(0);
  });
});

describe('how a run is said, word for word (the owner-review copy, UI_DESIGN §10)', () => {
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
  const calm = importView(mockAdminOverview({ now: NOW, evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER, imports: 'healthy' }).system.imports);
  const blocked = importView(mockAdminOverview({ now: NOW, evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER, imports: 'blocked' }).system.imports);

  it('the brief’s outcomes, the advertised date as NTSB gives it (no zone)', () => {
    expect(importOutcome(run, calm)).toBe('No new file (NTSB still lists the 1 Oct 2026 file)');
    expect(importOutcome({ ...run, source: null }, calm)).toBe('No new file');
    expect(importOutcome({ ...run, reason: 'same_archive' }, calm)).toBe('File re-downloaded: identical');
    expect(importOutcome({ ...run, reason: 'same_content' }, calm)).toBe('File re-downloaded: the same content, repackaged');
    expect(importOutcome({ ...run, reason: null }, calm)).toBe('No change');
    expect(importOutcome({ ...run, result: 'published', reason: null, generationId: 8 }, calm)).toBe('Imported generation 8');
    expect(importOutcome({ ...run, result: 'published', reason: null }, calm)).toBe('Imported a new snapshot');
    expect(importOutcome({ ...run, result: 'deferred', reason: 'busy', step: 'check', archiveSha256: null }, calm)).toBe('Postponed: another import or a backup was running');
    expect(importOutcome({ ...run, result: 'deferred', reason: 'backup_window', step: 'check', archiveSha256: null }, calm)).toBe('Postponed: it was the nightly backup window');
    expect(importOutcome(blocked.runs[0] as AdminImportRun, blocked)).toBe('Blocked: an earlier run is waiting for review');
    expect(importOutcome({ ...run, result: 'deferred', reason: 'probe', step: 'canary', archiveSha256: calm.serving }, calm)).toBe('Re-check of the serving data failed: the live site did not pass its checks');
    expect(importOutcome({ ...run, result: 'skipped_dev_failed', reason: 'dev_failed', step: 'check' }, calm)).toBe('Live skipped: the dev check failed');
    expect(importOutcome({ ...run, result: 'needs_review', reason: 'interrupted', step: 'extract' }, calm)).toBe('Stopped for review: it stopped unexpectedly too many times');
    expect(importOutcome({ ...run, result: 'needs_review', reason: 'probe', step: 'validate' }, calm)).toBe('Stopped for review: the new search indexes did not pass their checks');
    expect(importOutcome({ ...run, result: 'needs_review', reason: 'probe', step: 'canary' }, calm)).toBe('Stopped for review: the live site did not pass its checks');
    expect(importOutcome({ ...run, result: 'failed', reason: 'interrupted' }, calm)).toBe('Failed: it stopped unexpectedly');
    expect(importOutcome({ ...run, result: 'cancelled', reason: 'lock_lost' }, calm)).toBe('Cancelled: it lost the lock that lets one run work at a time');
    expect(importOutcome({ ...run, result: 'rolled_back', reason: null }, calm)).toBe('Rolled back: the previous dataset serves again');
    expect(importOutcome({ ...run, result: 'running', reason: null, step: 'index_cases' }, calm)).toBe('Running (case index)');
  });

  it('every reason, word for word', () => {
    const words = Object.fromEntries(IMPORT_REASONS.map((reason) => [reason, reasonWords({ reason, result: 'needs_review', step: 'extract' })]));
    expect(words).toEqual({
      metadata_unchanged: 'NTSB still lists the same file',
      same_archive: 'the downloaded file is identical to the current one',
      same_content: 'the downloaded file has the same content as the current one',
      source_listing_changed: 'NTSB’s download listing is not in the expected form',
      source_reissued: 'NTSB changed the file without giving it a newer date',
      source_changed_during_download: 'the file changed while it was downloading',
      source_unavailable: 'NTSB or the app could not be reached',
      source_retired: 'the NTSB download the importer uses has been retired',
      baseline_required: 'the importer has no reviewed starting point for this file (NTSB’s files are more than 62 days apart, or none was recorded)',
      baseline_changed: 'the dataset the site serves changed outside the importer',
      schema: 'the file’s tables or columns are not as expected',
      integrity: 'a data integrity check failed',
      verification: 'the new data did not pass verification',
      cohort_bounds: 'the new file differs from the current data in a way the automatic checks do not accept',
      mapping: 'the way cases are classified changed',
      probe: 'the new search indexes did not pass their checks',
      import_cap: 'this file’s $0.50 cost limit was reached',
      monthly_budget: 'this month’s budget does not cover it',
      cache_miss: 'it needs text embeddings that are not cached',
      restore_hold: 'a database restore is waiting for review',
      accounting: 'its cost records need reconciling',
      storage: 'the importer hit a storage limit or its free-space reserve',
      alias_unknown: 'the switch of the search indexes is in an unknown state',
      busy: 'another import or a backup was running',
      backup_window: 'it was the nightly backup window',
      lock_lost: 'it lost the lock that lets one run work at a time',
      timeout: 'it ran past its 3-hour limit',
      interrupted: 'it stopped unexpectedly too many times',
      dev_failed: 'the dev check failed',
      configuration: 'the importer’s configuration needs attention',
      cleanup: 'its temporary files or containers could not be cleaned up',
    });
  });

  it('every result’s meaning, word for word', () => {
    expect(IMPORT_RESULT_MEANINGS).toEqual({
      running: 'A run is in progress.',
      unchanged: 'The check found nothing new to import; the site keeps its data.',
      published: 'A new NTSB snapshot was imported and now serves.',
      needs_review: 'The run stopped and waits for an operator’s review; nothing new is imported until then.',
      deferred: 'The run was postponed; the next daily check tries again.',
      failed: 'The run failed; the next daily check tries again, within its retry limit.',
      skipped_dev_failed: 'Live was skipped because the dev check failed; live keeps its data.',
      cancelled: 'The run was cancelled before it finished.',
      rolled_back: 'An operator rolled the import back; the previous dataset serves again.',
    });
  });
});
