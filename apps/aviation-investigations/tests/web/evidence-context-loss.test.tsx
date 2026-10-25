/**
 * The known context-loss counterexamples on the AI evidence view's initial surfaces (the
 * evidence-view gate, condition 2): ERA22FA257 "after completion of this work", ERA09FA355
 * "approximately 29 hours earlier" and WPR18LA021 "2 days later". Each case's retrieval seed is
 * exactly the old unsafe quotation, projected by the server's own `projectCase`
 * (tests/support/context-loss.ts). The card, the drawer, Compare and print must show the whole
 * paragraph with the antecedent the quotation depends on, before anyone opens the full section:
 * a link that could reveal it is not enough. The browser replay is tests/e2e-real/evidence.spec.ts.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { paragraphSpans } from '../../server/evidence/project';
import { EVIDENCE_BOUNDARY, EVIDENCE_HEADING, EVIDENCE_NOTICE } from '../../shared/contracts/evidence';
import { LONG_TEXT_CHARS } from '../../web/src/features/evidence/Excerpt';
import {
  CONTEXT_LOSS_EXAMPLES,
  CONTEXT_LOSS_SEARCH_ID,
  contextLossDetail,
  contextLossPage,
  contextLossPageJson,
  contextLossParagraph,
  savedCase,
  type ContextLossExample,
} from '../support/context-loss';
import { renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const page = contextLossPage();
const NUMBERS = CONTEXT_LOSS_EXAMPLES.map((e) => e.ntsbNo);

/** The replayed search, its stand-in case pages, and every GET path the app read. */
function serveReplay(): string[] {
  const reads: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET') reads.push(new URL(request.url).pathname);
  });
  server.use(
    http.get(`*/api/evidence/${CONTEXT_LOSS_SEARCH_ID}`, () =>
      new HttpResponse(contextLossPageJson(), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } }),
    ),
    ...CONTEXT_LOSS_EXAMPLES.map((example) => http.get(`*/api/cases/${example.ntsbNo}`, () => HttpResponse.json(contextLossDetail(example)))),
  );
  return reads;
}

/** Text without the screen-reader-only words of the marks. */
const visibleText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return clone.textContent ?? '';
};

const hiddenInPrint = (el: Element): boolean => el.closest('[data-print="hide"]') !== null;

/**
 * The excerpt shown for an example in `scope` (a card, the drawer's section, a strip): its text is
 * one whole paragraph of the canonical text, holds the quotation and every antecedent, is not
 * folded, and (unless `prints` is false: the drawer, which prints the page behind it) prints.
 */
function expectWholeParagraph(scope: Element, example: ContextLossExample, { prints = true } = {}): void {
  const paragraph = contextLossParagraph(page, example);
  const shown = [...scope.querySelectorAll('figure[data-excerpt] blockquote')].map((q) => visibleText(q));
  expect(shown, example.ntsbNo).toContain(paragraph);
  expect(paragraph).toContain(example.quote);
  for (const anchor of example.anchors) expect(paragraph, `${example.ntsbNo}: ${anchor}`).toContain(anchor);
  // Exactly one whole paragraph of the section, never a sentence cut from one.
  const { passage } = savedCase(example);
  expect(paragraphSpans(passage.text).map((p) => passage.text.slice(p.start, p.end))).toContain(paragraph);
  // Shown whole at once: short of the fold, nothing collapsed, and not left out of print.
  expect(paragraph.length).toBeLessThan(LONG_TEXT_CHARS);
  const quote = [...scope.querySelectorAll('figure[data-excerpt] blockquote')].find((q) => visibleText(q) === paragraph) as Element;
  expect(quote.querySelector('[data-long-text]')).toBeNull();
  expect(hiddenInPrint(quote)).toBe(!prints);
}

describe('context-loss counterexamples on the initial surfaces (whole paragraphs with their antecedents)', { timeout: 20_000 }, () => {
  it('the replayed page is the server projection: one excerpt per case, the paragraph around the narrowed seed', () => {
    for (const example of CONTEXT_LOSS_EXAMPLES) {
      const item = page.cases.find((c) => c.case.ntsbNo === example.ntsbNo);
      const excerpt = item?.excerpts[0];
      expect(item?.excerpts).toHaveLength(1);
      // The seed was only the quotation; the excerpt is the paragraph that holds it.
      expect(excerpt?.seed.end! - excerpt?.seed.start!).toBe(example.quote.length);
      expect(excerpt?.paragraph.start).toBeLessThanOrEqual(excerpt?.seed.start ?? -1);
      expect(excerpt?.paragraph.end).toBeGreaterThanOrEqual(excerpt?.seed.end ?? Infinity);
      expect(excerpt?.text.length).toBeGreaterThan(example.quote.length);
    }
  });

  it('the cards: each shows the whole paragraph with its antecedent, without opening the full section', async () => {
    const reads = serveReplay();
    renderApp(`/ai/${CONTEXT_LOSS_SEARCH_ID}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    expect(screen.getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
    // The page has no capability note (note: null), yet the research-only boundary shows (gate answer 2).
    expect(document.querySelector('[data-evidence-note]')).toBeNull();
    expect(document.querySelector('[data-evidence-boundary]')?.textContent).toBe(EVIDENCE_BOUNDARY);
    for (const example of CONTEXT_LOSS_EXAMPLES) {
      const card = document.querySelector(`article[data-card="${example.ntsbNo}"]`) as HTMLElement;
      expect(card, example.ntsbNo).toBeTruthy();
      expectWholeParagraph(card, example);
      expect(hiddenInPrint(card)).toBe(false);
      // The full section stays one click away, unread: the card alone carries the context.
      expect(within(card).getByRole('button', { name: /^Show the full .+ section$/ }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(reads.filter((path) => path.includes('/cases/'))).toEqual([]);
  });

  it('the drawer: the evidence section under the heading and notice shows the same whole paragraph', async () => {
    serveReplay();
    for (const example of CONTEXT_LOSS_EXAMPLES) {
      const view = renderApp(`/ai/${CONTEXT_LOSS_SEARCH_ID}?case=${example.ntsbNo}`);
      const dialog = await screen.findByRole('dialog', {}, SLOW);
      const section = await within(dialog).findByRole('region', { name: EVIDENCE_HEADING }, SLOW);
      expect(within(section).getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
      expect(section.querySelector('[data-evidence-boundary]')?.textContent).toBe(EVIDENCE_BOUNDARY);
      // On screen; printing with the drawer open prints the sheet behind it, whose card shows it too.
      expectWholeParagraph(section, example, { prints: false });
      expectWholeParagraph(document.querySelector(`article[data-card="${example.ntsbNo}"]`) as HTMLElement, example);
      view.unmount();
    }
  });

  it('Compare: each strip’s evidence row shows the whole paragraph with its antecedent', async () => {
    const reads = serveReplay();
    renderApp(`/compare?cases=${NUMBERS.join(',')}&evidence=${CONTEXT_LOSS_SEARCH_ID}&pages=1`);
    const top = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-compare-evidence]');
      if (!found) throw new Error('not yet');
      return found;
    }, SLOW);
    expect(within(top).getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
    expect(top.querySelector('[data-evidence-boundary]')?.textContent).toBe(EVIDENCE_BOUNDARY);
    for (const [i, example] of CONTEXT_LOSS_EXAMPLES.entries()) {
      const row = await waitFor(() => {
        const found = screen.queryByRole('article', { name: `${example.ntsbNo}, strip ${i + 1}` })?.querySelector<HTMLElement>('[data-strip-evidence]');
        if (!found) throw new Error('not yet');
        return found;
      }, SLOW);
      expectWholeParagraph(row, example);
      // The strip shows the case's best excerpt; nothing is left on the search's page.
      expect(row.textContent).not.toMatch(/more excerpts? on the search’s page/);
    }
    expect(reads.filter((path) => path.startsWith(`/api/evidence/${CONTEXT_LOSS_SEARCH_ID}/`))).toEqual([]);
  });

  it('print: the notice and the whole paragraphs print; only the controls are left out', async () => {
    serveReplay();
    renderApp(`/ai/${CONTEXT_LOSS_SEARCH_ID}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    expect(hiddenInPrint(screen.getByRole('note'))).toBe(false);
    expect(hiddenInPrint(document.querySelector('[data-evidence-boundary]') as HTMLElement)).toBe(false);
    for (const example of CONTEXT_LOSS_EXAMPLES) {
      const card = document.querySelector(`article[data-card="${example.ntsbNo}"]`) as HTMLElement;
      expectWholeParagraph(card, example);
      for (const button of within(card).getAllByRole('button', { name: /^Show the full .+ section$/ })) expect(hiddenInPrint(button)).toBe(true);
    }
  });
});
