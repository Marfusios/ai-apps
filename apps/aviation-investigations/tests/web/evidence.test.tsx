/**
 * The AI evidence view (UI_DESIGN §4.9; contract `evidence.v2`, the advisory-only design) over
 * the mock API (web/mock/evidence.ts): Ask AI, the results page and every state it can be in,
 * the suggestion shown unapplied and applied only by choice, editing the search, the hints, the
 * drawer, Compare and print, accessibility, and the rule that a result surface shows NTSB text,
 * coded data, fixed copy and the reader's own words only, the suggested words only as labelled
 * counts and marks (gate G6 stays closed for generated text). Shapes the fixture corpus lacks
 * (several probable-cause statements, astral characters, a paragraph too long for a card, a
 * resolved report link, a suggestion carrying markup) come from synthetic pages, each validated
 * with the contract first.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaseDetail } from '../../shared/contracts/cases';
import { REPORT_URL_PREFIX } from '../../shared/contracts/cases';
import type { BriefFilters } from '../../shared/contracts/briefs';
import {
  CreateEvidenceResponseSchema,
  EVIDENCE_HEADING,
  EVIDENCE_NOTE_TEXT,
  EVIDENCE_NOTICE,
  EvidencePageSchema,
  type EvidenceCase,
  type EvidencePage,
} from '../../shared/contracts/evidence';
import { AI_STATUS_SAMPLES, MOCK_AI_LIMITS } from '../../web/mock/ai-status';
import casesJson from '../../web/mock/cases.json';
import { MOCK_EVIDENCE_QUESTIONS } from '../../web/mock/evidence';
import { firstCheckText, trialUsedSignIn, welcomeText } from '../../web/src/features/ai/limits';
import { FIRST_CHECK_TITLE, LATER_CHECK_TITLE, type TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { resetUnsettledForTests } from '../../web/src/features/ai/unsettled';
import { rememberQuestion } from '../../web/src/features/brief/memory';
import { formatDate } from '../../web/src/lib/format';
import { aircraftName, aircraftSummary, letterOf, phaseEventShort, placeShort, rowMonoParts } from '../../web/src/features/case/display';
import { evidencePageQuery } from '../../web/src/features/evidence/api';
import {
  APPLY_BOTH,
  APPLY_FILTERS,
  COMPARISON_HINT,
  DRAFT_PENDING_NOTE,
  EDITED_LABEL,
  EMPTY_TITLE,
  EMPTY_WORDS,
  EXPIRED_TEXT,
  EXPIRED_TITLE,
  FULL_SECTION_FAILED,
  arrivalLine,
  LEGEND,
  NO_EXCERPT,
  OWN_WORDS,
  QUESTION_AS_ASKED,
  STATISTICS_HINT,
  SUGGESTION_LABEL,
  SUGGESTION_NOTE,
  YOUR_SEARCH_LABEL,
  allShownLine,
  countLine,
  excerptLabel,
  expiryLine,
  fullSectionLabel,
  numberedKinds,
  probableCauseLabel,
  relevanceContext,
  relevanceParts,
  showMoreLabel,
  showingLine,
  suggestionInWords,
  termInWords,
} from '../../web/src/features/evidence/display';
import { LONG_TEXT_CHARS } from '../../web/src/features/evidence/Excerpt';
import { evidencePageKey } from '../../web/src/features/evidence/keys';
import { markRanges } from '../../web/src/features/evidence/MatchedText';
import { createHandlers, type HandlerOptions } from '../../web/src/mocks/handlers';
import { EVIDENCE_GONE_PLURAL, NOT_IN_SEARCH } from '../../web/src/pages/Compare';
import { AI_NUDGE, AI_NUDGE_FILTERS } from '../../web/src/pages/Explore';
import { currentUrl, renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const CASES = casesJson as unknown as Record<string, CaseDetail>;
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  delete window.turnstile;
  resetUnsettledForTests();
  server.events.removeAllListeners();
});

function freshApi(options: HandlerOptions = {}): void {
  server.use(...createHandlers(options));
}

/** Cloudflare's widget stood in for: the test token after `delay` ms, or after `release()` with `hold`. */
function installTurnstile(delay = 20, { hold = false }: { hold?: boolean } = {}) {
  const state = { renders: [] as string[], removed: 0, release: (): void => {} };
  const held: (() => void)[] = [];
  const live = new Set<string>();
  let n = 0;
  const api: TurnstileApi = {
    render(host, params) {
      n += 1;
      const id = `w${n}`;
      live.add(id);
      state.renders.push(params.appearance);
      host.appendChild(document.createElement('div'));
      const answer = (): void => {
        if (live.has(id)) params.callback(TOKEN);
      };
      if (hold) held.push(answer);
      else setTimeout(answer, delay);
      return id;
    },
    remove(id) {
      live.delete(id);
      state.removed += 1;
    },
  };
  state.release = () => act(() => held.splice(0).forEach((answer) => answer()));
  window.turnstile = api;
  return state;
}

/** Every POST body to `path`, as the server got it. */
function recordPosts(path: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === path) void request.clone().json().then((b: Record<string, unknown>) => bodies.push(b));
  });
  return bodies;
}

/** Every GET path the app read. */
function recordReads(): string[] {
  const reads: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      reads.push(`${url.pathname}${url.search}`);
    }
  });
  return reads;
}

/** A search made through the mock API, as an anonymous request with a token would make it (page 1 of it). */
async function makeSearch(question: string): Promise<EvidencePage> {
  const response = await fetch(new URL('/api/evidence', window.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ kind: 'question', question, idempotencyKey: crypto.randomUUID(), turnstileToken: TOKEN }),
  });
  const answer = CreateEvidenceResponseSchema.parse(await response.json());
  if (answer.kind !== 'results') throw new Error(`expected results for "${question}"`);
  return answer.search;
}

/** An edited search of `from` made through the mock API: exactly `filters`, and `terms` when given (page 1 of it). */
async function makeEdit(from: EvidencePage, filters: BriefFilters, terms?: string): Promise<EvidencePage> {
  const response = await fetch(new URL('/api/evidence', window.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ kind: 'edited', from: from.id, filters, ...(terms !== undefined ? { terms } : {}), idempotencyKey: crypto.randomUUID(), turnstileToken: TOKEN }),
  });
  const answer = CreateEvidenceResponseSchema.parse(await response.json());
  if (answer.kind !== 'results') throw new Error('expected results');
  return answer.search;
}

/** A search made through the mock API, then opened. */
async function openSearch(question: string, query = '') {
  const search = await makeSearch(question);
  const app = renderApp(`/ai/${search.id}${query}`);
  await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
  return { ...app, search };
}

/** A question's search with its suggested filters applied (an edited search), then opened. */
async function openApplied(question: string) {
  const asked = await makeSearch(question);
  const search = await makeEdit(asked, asked.suggestion?.filters ?? {});
  const app = renderApp(`/ai/${search.id}`);
  await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
  return { ...app, asked, search };
}

/** Waits until `find` finds something, and returns it. */
async function present<T>(find: () => T | null | undefined): Promise<T> {
  return waitFor(() => {
    const found = find();
    if (found === null || found === undefined) throw new Error('not there yet');
    return found;
  }, SLOW);
}

/** The card of a case on the sheet. */
const cardOf = (ntsbNo: string): HTMLElement => {
  const card = document.querySelector<HTMLElement>(`article[data-card="${ntsbNo}"]`);
  if (!card) throw new Error(`no card for ${ntsbNo}`);
  return card;
};

/** Text with each mark's words only (screen-reader suffixes left out). */
const visibleText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return clone.textContent ?? '';
};

/** Page `n` of a search, as the mock API serves it. */
async function queryPage(id: string, n: number): Promise<EvidencePage> {
  const response = await fetch(new URL(`/api/evidence/${id}?page=${n}`, window.location.origin));
  return EvidencePageSchema.parse(await response.json());
}

/** A page served for a search id instead of the mock's own (a synthetic shape), validated with the contract first. */
function servePage(page: EvidencePage, detail?: CaseDetail): EvidencePage {
  const valid = EvidencePageSchema.parse(page);
  server.use(
    http.get(`*/api/evidence/${page.id}`, () => HttpResponse.json(valid, { headers: { 'cache-control': 'private, no-store' } })),
    ...(detail ? [http.get(`*/api/evidence/${page.id}/cases/:ntsbNo`, () => HttpResponse.json(detail))] : []),
  );
  return valid;
}

describe('Ask AI opens an AI search (UI_DESIGN §4.9)', { timeout: 20_000 }, () => {
  it('the first check once per trial identity, with the limits the API reports; then the results; the widget is reset after each request', async () => {
    freshApi();
    const turnstile = installTurnstile(20, { hold: true });
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_EVIDENCE_QUESTIONS.carb } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*10 free$/ }));
    const panel = await screen.findByRole('dialog', { name: FIRST_CHECK_TITLE });
    expect(panel.textContent).toContain('Up to ten free AI searches a day, subject to daily availability. Search, cases and comparisons never need this.');
    expect(firstCheckText(MOCK_AI_LIMITS, undefined)).toBe('Up to ten free AI searches a day, subject to daily availability. Search, cases and comparisons never need this.');
    turnstile.release();
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/ai\/[0-9a-f-]{36}$/), SLOW);
    expect(await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(MOCK_EVIDENCE_QUESTIONS.carb);
    expect(turnstile.renders).toEqual(['always']);
    expect(turnstile.removed).toBe(1);
    // One AI search used; the page did not read page 1 again (the answer carried it).
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 9 of 10'), SLOW);
  });

  it('a refused token takes one more, visible check; any refusal resets the widget', async () => {
    freshApi({ aiStatus: { state: 'available', remaining: { kind: 'trial', left: 10, limit: 10, started: true } } });
    const turnstile = installTurnstile(30);
    let posts = 0;
    server.use(
      http.post('*/api/evidence', () => {
        posts += 1;
        if (posts === 1) return HttpResponse.json({ error: 'challenge_failed', message: 'Take a new check.' }, { status: 403 });
        if (posts === 3) return HttpResponse.json({ error: 'rate_limited', message: 'Slow down.', retryAfter: 12 }, { status: 429 });
        return undefined;
      }),
    );
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_EVIDENCE_QUESTIONS.seed } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*10 free$/ }));
    expect(await screen.findByRole('dialog', { name: LATER_CHECK_TITLE })).toBeTruthy();
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/ai\//), SLOW);
    expect(turnstile.renders).toEqual(['interaction-only', 'always']);
    expect(turnstile.removed).toBe(2);
    await act(() => router.navigate('/'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_EVIDENCE_QUESTIONS.seed } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI/ }));
    expect(await screen.findByText('Slow down a moment. Try again in 12 seconds.', {}, SLOW)).toBeTruthy();
    expect(turnstile.removed).toBe(3);
    expect(posts).toBe(3);
  });

  it('from Explore it sends the question alone, and the nudge says the filters set there stay behind (no generated explanation is promised)', async () => {
    freshApi();
    installTurnstile();
    const posts = recordPosts('/api/evidence');
    const { router } = renderApp('/explore?q=carb+icing&phase=approach');
    const nudge = (await screen.findByText(AI_NUDGE, { exact: false }, SLOW)).closest('div') as HTMLElement;
    expect(nudge.textContent).toContain(`${AI_NUDGE} ${AI_NUDGE_FILTERS}`);
    expect(document.body.textContent).not.toMatch(/grouped and explained/i);
    fireEvent.click(within(await screen.findByRole('search')).getByRole('button', { name: /^Ask AI\s*·\s*10 free$/ }));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/ai\//), SLOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'question', question: 'carb icing', turnstileToken: TOKEN });
    expect(Object.keys(posts[0] as object).sort()).toEqual(['idempotencyKey', 'kind', 'question', 'turnstileToken']);
  });

  it.each([
    [MOCK_EVIDENCE_QUESTIONS.outOfScope, 'scope'],
    [MOCK_EVIDENCE_QUESTIONS.operational, 'operational_advice'],
  ] as const)('nothing blocks a search: "%s" opens its results, with the fixed %s note above them and the notice', async (question, note) => {
    freshApi();
    installTurnstile(5);
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: question } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·\s*10 free$/ }));
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/ai\/[0-9a-f-]{36}$/), SLOW);
    const shown = await present(() => document.querySelector<HTMLElement>('[data-evidence-note]'));
    // The contract's fixed text, word for word: never model text, never about the question.
    expect(shown.getAttribute('data-evidence-note')).toBe(note);
    expect(shown.textContent).toBe(EVIDENCE_NOTE_TEXT[note]);
    // Calm: no alert, no live region, no warning colour; it prints; and above the results, which still come.
    expect(shown.closest('[role="alert"], [aria-live]')).toBeNull();
    expect(shown.closest('[data-print="hide"]')).toBeNull();
    expect(shown.className).not.toMatch(/magenta|red|amber|warn/);
    expect(shown.compareDocumentPosition(screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('article[data-card]').length).toBeGreaterThan(0);
    expect(screen.getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
    // A note comes with no suggestion; it was one AI search.
    expect(screen.queryByRole('region', { name: SUGGESTION_LABEL })).toBeNull();
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI searches left: 9 of 10'), SLOW);
  });

  it('a counting request gets its results and, above them, the dashboard hint', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.statistics);
    const hint = document.querySelector('[data-hint="corpus_statistics"]') as HTMLElement;
    expect(hint.textContent).toContain(STATISTICS_HINT);
    expect(within(hint).getByRole('link', { name: 'Open the dashboard' }).getAttribute('href')).toBe('/dashboard');
    expect(within(hint).getAllByRole('link')).toHaveLength(1);
    // Results still come, from the question, with no filter applied, and no note.
    expect(search.total).toBeGreaterThan(2);
    expect(document.querySelectorAll('article[data-card]').length).toBe(Math.min(10, search.total));
    expect(document.querySelector('[data-evidence-note]')).toBeNull();
    expect(hint.compareDocumentPosition(screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a comparison request gets its results and the compare hint: the cases found, Compare, and the numbers no case has; a case number alone gets no hint', async () => {
    freshApi();
    await openSearch(MOCK_EVIDENCE_QUESTIONS.comparison);
    const hint = document.querySelector('[data-hint="case_comparison"]') as HTMLElement;
    expect(hint.textContent).toContain(COMPARISON_HINT);
    expect(within(hint).getByRole('link', { name: 'Compare DFW08TA066, NYC08LA106 →' }).getAttribute('href')).toBe('/compare?cases=DFW08TA066,NYC08LA106');
    expect(within(hint).getByRole('link', { name: 'DFW08TA066' }).getAttribute('href')).toBe('/cases/DFW08TA066');
    expect(hint.textContent).toContain('Not found: ZZZ99ZZ999');
    expect(document.querySelectorAll('article[data-card]').length).toBeGreaterThan(0);
    freshApi();
    await openSearch(MOCK_EVIDENCE_QUESTIONS.single);
    await waitFor(() => expect(document.querySelectorAll('article[data-card]').length).toBeGreaterThan(10));
    expect(document.querySelectorAll('[data-hint]')).toHaveLength(1);
  });
});

describe('the results page', { timeout: 20_000 }, () => {
  it('the question as asked is what was searched; the AI’s suggestion stands beside it, labelled and not applied', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(MOCK_EVIDENCE_QUESTIONS.carb);
    // Your search: the question as asked, the cohort, no filter applied.
    const yours = screen.getByRole('region', { name: YOUR_SEARCH_LABEL });
    expect(yours.textContent).toContain(QUESTION_AS_ASKED);
    expect(within(yours).getByRole('button', { name: OWN_WORDS })).toBeTruthy();
    expect(within(yours).queryAllByRole('button', { name: /, remove$/ })).toHaveLength(0);
    // The suggestion: magenta, dashed, its filters as labels (not controls), its words in quotes.
    const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
    expect(suggestion.textContent).toContain(SUGGESTION_NOTE);
    expect(within(suggestion).getByRole('list', { name: 'Suggested filters' }).textContent).toBe('Phase: Approach');
    expect(within(suggestion).getByRole('heading', { level: 2 }).textContent).toBe('Suggested filters and terms — not applied');
    expect(within(suggestion).queryByRole('button', { name: /Phase: Approach/ })).toBeNull();
    expect(suggestion.textContent).toContain('“carb icing”');
    expect(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) })).toBeTruthy();
    expect(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_BOTH}\\s*·\\s*uses 1$`) })).toBeTruthy();
    // Not applied: the results are the question's, every case of the cohort, and no card claims the filter.
    expect(search.appliedFilters).toEqual({});
    expect(document.querySelector('[data-count-line]')?.textContent).toMatch(/^21 retrieved/);
    expect([...document.querySelectorAll('[data-relevance]')].some((r) => r.textContent?.includes('Phase: Approach'))).toBe(false);
    // No unchecked readings in this beta, anywhere; a case search has no capability note.
    expect(document.body.textContent).not.toMatch(/AirCase cannot check|Not applied|AI reading of your question/);
    expect(document.querySelector('[data-evidence-note]')).toBeNull();
  });

  it('a search whose scope stage failed shows the question’s results with no suggestion; the marks are the reader’s words', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.noSuggestion);
    expect(search.suggestion).toBeNull();
    expect(screen.queryByRole('region', { name: SUGGESTION_LABEL })).toBeNull();
    expect(document.querySelectorAll('article[data-card]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('yours');
    const counted = [...document.querySelectorAll('[data-relevance]')].map((r) => visibleText(r)).find((t) => t.includes('in these excerpts'));
    expect(counted).toMatch(/Your words in these excerpts: /);
  });

  it('the fixed heading and notice, a count that never claims every match, the marks explained, and when the search is deleted', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    const notice = screen.getByRole('note');
    expect(notice.textContent).toBe(EVIDENCE_NOTICE);
    expect(document.querySelector('[data-count-line]')?.textContent).toBe('21 retrieved · highest-ranked first · not every matching investigation');
    expect(countLine(100)).toBe('100 retrieved · highest-ranked first · the most one search ranks · not every matching investigation');
    // The marks are the suggested words, and the key says so.
    const legend = document.querySelector('[data-legend]') as HTMLElement;
    expect(legend.getAttribute('data-legend')).toBe('suggested');
    expect(visibleText(legend)).toBe(`Marked in the excerpts: ${LEGEND.suggested} · ${LEGEND.synonym}`);
    expect(screen.getByText(expiryLine(search.expiresAt))).toBeTruthy();
    expect(expiryLine('2026-10-25T22:13:00.000Z')).toBe('Only you can open this search. AirCase deletes it on 25 Oct 2026 at 22:13 UTC.');
  });

  it('a card: the facts as Explore shows them, every probable cause with its scope and the report link, whole paragraphs with literal and synonym matches told apart, and the relevance facts', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    // The first card whose excerpts mark both kinds of match.
    const marks = (c: EvidenceCase, match: 'literal' | 'synonym'): boolean => c.excerpts.some((e) => e.highlights.some((h) => h.match === match));
    const item = search.cases.find((c) => marks(c, 'literal') && marks(c, 'synonym')) as EvidenceCase;
    const card = cardOf(item.case.ntsbNo);
    // Named by its case number and aircraft, a heading of its own.
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe(`${item.case.ntsbNo}, ${aircraftSummary(item.case)}`);
    expect(card.textContent).toContain(rowMonoParts(item.case).map((p) => p.text).join(' · '));
    expect(card.textContent).toContain(placeShort(item.case.city, item.case.state, item.case.country));
    // The probable cause, verbatim, with the report link (here the labelled search fallback).
    const cause = card.querySelector('[data-probable-cause]') as HTMLElement;
    expect(cause.textContent).toContain(item.probableCauses[0]?.text.trim());
    expect(within(cause).getByRole('link', { name: /Search NTSB/ }).getAttribute('href')).toBe('https://my.ntsb.gov/aviation');
    // Whole paragraphs, each under its section label.
    const figures = [...card.querySelectorAll('figure')];
    expect(figures).toHaveLength(item.excerpts.length);
    figures.forEach((f, i) => {
      const e = item.excerpts[i] as EvidenceCase['excerpts'][number];
      expect(f.querySelector('figcaption')?.textContent).toBe(excerptLabel(item.case.ntsbNo, item.case.aircraft, e));
      expect(visibleText(f.querySelector('blockquote') as Element)).toBe(e.text);
    });
    // Literal and synonym marks differ by class (line and fill) and by words for screen readers.
    const synonym = card.querySelector('mark[data-match="synonym"]') as HTMLElement;
    expect(synonym.className).toBe('hit-synonym');
    expect(visibleText(synonym).toLowerCase()).toBe('carburetor');
    expect(synonym.textContent).toMatch(/\(synonym\)$/);
    // Heard, never copied with the text.
    expect(synonym.querySelector('.sr-only')?.className).toContain('select-none');
    const literal = card.querySelector('mark[data-match="literal"]') as HTMLElement;
    expect(literal.className).toBe('hit');
    expect(literal.textContent?.toLowerCase()).toBe('icing');
    // The relevance facts, as facts: occurrences of the suggested words, said as suggested; never "meaning match".
    const relevance = card.querySelector('[data-relevance]') as HTMLElement;
    expect(visibleText(relevance)).toBe(relevanceParts(item.relevance, relevanceContext(search)).join(' · '));
    expect(visibleText(relevance)).toMatch(/^Suggested terms in these excerpts: .*“icing” appears \d+ times.* · found by keyword, similarity and case-narrative keyword search$/);
    expect(termInWords({ term: 'carb', literal: 0, synonym: 9 })).toBe('synonyms of “carb” appear 9 times');
    expect(termInWords({ term: 'carb', literal: 2, synonym: 1 })).toBe('“carb” appears twice, its synonyms once');
    expect(termInWords({ term: 'maintenance', literal: 0, synonym: 0 })).toBe('“maintenance” does not appear');
    expect(document.body.textContent).not.toMatch(/meaning match/i);
    // Compare, by keyboard and screen reader.
    expect(within(card).getByRole('checkbox', { name: new RegExp(`^Compare\\s*${item.case.ntsbNo}$`) })).toBeTruthy();
  });

  it('multi-aircraft events list every aircraft and say whose text it is: the event, never one aircraft; two texts of a kind are numbered', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.midair);
    const item = search.cases.find((c) => c.case.ntsbNo === 'WPR15FA010') as EvidenceCase;
    const card = cardOf('WPR15FA010');
    for (const [i, a] of item.case.aircraft.entries()) expect(card.textContent).toContain(`${letterOf(item.case.ntsbNo, a, i)}${aircraftName(a)}${phaseEventShort(a)}`);
    const labels = [...card.querySelectorAll('figcaption')].map((c) => c.textContent);
    expect(labels).toEqual(['NTSB · ANALYSIS · EVENT, BOTH AIRCRAFT', 'NTSB · FACTUAL · EVENT, BOTH AIRCRAFT · TEXT 2', 'NTSB · FACTUAL · EVENT, BOTH AIRCRAFT · TEXT 1']);
    expect(numberedKinds(item.excerpts)).toEqual(new Set(['factual']));
    expect(card.querySelector('[data-probable-cause]')?.firstElementChild?.textContent).toMatch(/^NTSB · PROBABLE CAUSE · EVENT, BOTH AIRCRAFT/);
  });

  it('a case with no passage to quote keeps its facts and probable cause, says so, and claims no word counts', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.midair);
    const bare = search.cases.find((c) => c.excerpts.length === 0) as EvidenceCase;
    const card = cardOf(bare.case.ntsbNo);
    expect(card.querySelector('[data-no-excerpt]')?.textContent).toBe(`${NO_EXCERPT} Open ${bare.case.ntsbNo}`);
    expect(within(card).getByRole('link', { name: `Open ${bare.case.ntsbNo}` }).getAttribute('href')).toBe(`/cases/${bare.case.ntsbNo}`);
    expect(visibleText(card.querySelector('[data-relevance]') as Element)).toBe('found by similarity search');
    expect(card.querySelector('[data-probable-cause]')).toBeTruthy();
  });

  it('several probable-cause statements, each verbatim with its scope; a resolved report link (a synthetic page)', async () => {
    freshApi();
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.midair);
    const base = search.cases.find((c) => c.case.ntsbNo === 'WPR15FA010') as EvidenceCase;
    const first = base.probableCauses[0] as EvidenceCase['probableCauses'][number];
    const page = servePage({
      ...search,
      id: '00000000-0000-4000-9000-00000000c0de',
      cases: [
        {
          ...base,
          report: { kind: 'report', url: `${REPORT_URL_PREFIX}12345/pdf`, label: 'NTSB final report', capturedOn: '2026-10-16' },
          probableCauses: [first, { ...first, sectionKey: 'probable_cause/event-2', text: 'Synthetic second statement of probable cause, for this test only.' }],
        },
      ],
      total: 1,
      pages: 1,
    });
    renderApp(`/ai/${page.id}`);
    const card = await waitFor(() => cardOf('WPR15FA010'), SLOW);
    const causes = [...card.querySelectorAll('[data-probable-cause]')];
    expect(causes.map((c) => c.firstElementChild?.firstChild?.textContent)).toEqual([
      probableCauseLabel('WPR15FA010', base.case.aircraft, first, 0, 2),
      probableCauseLabel('WPR15FA010', base.case.aircraft, first, 1, 2),
    ]);
    expect(probableCauseLabel('WPR15FA010', base.case.aircraft, first, 1, 2)).toBe('NTSB · PROBABLE CAUSE · EVENT, BOTH AIRCRAFT · 2 OF 2');
    expect(causes[1]?.textContent).toContain('Synthetic second statement of probable cause, for this test only.');
    expect(within(card).getByRole('link', { name: 'NTSB report ↗' }).getAttribute('href')).toBe(`${REPORT_URL_PREFIX}12345/pdf`);
  });

  it('Show the full section: the section at the search’s generation (never the public case), opened at the paragraph, marked, with focus there', async () => {
    freshApi();
    const reads = recordReads();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const item = search.cases[0] as EvidenceCase;
    const excerpt = item.excerpts[0] as EvidenceCase['excerpts'][number];
    const card = cardOf(item.case.ntsbNo);
    // Each excerpt's control has a name of its own: the label, then its place among the card's excerpts.
    const toggle = within(card).getByRole('button', { name: new RegExp(`^${fullSectionLabel(excerpt)}\\s*, excerpt 1 of ${item.excerpts.length}$`) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBeTruthy();
    fireEvent.click(toggle);
    const marked = await present(() => card.querySelector<HTMLElement>('[data-excerpt-paragraph]'));
    await waitFor(() => expect(document.activeElement).toBe(marked));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(visibleText(toggle)).toBe('Show the excerpt only');
    expect(visibleText(marked)).toBe(excerpt.text);
    // Screen readers hear where the excerpt starts and ends in the section, words a selection never copies.
    expect(marked.textContent).toMatch(/^Start of the excerpt\. [\s\S]* End of the excerpt\.$/);
    for (const words of marked.querySelectorAll('.sr-only')) expect(words.className).toContain('select-none');
    // And the section's arrival is said, politely.
    const status = card.querySelector('[data-full-section-status]') as HTMLElement;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe(`The full ${excerpt.label.toLowerCase()} section is shown, with the excerpt marked.`);
    // The whole section, the paragraph in its place: the text before it and after it.
    const section = CASES[item.case.ntsbNo]?.sections.find((s) => s.key === excerpt.sectionKey)?.text ?? '';
    const region = card.querySelector('[data-full-section]') as HTMLElement;
    // (paragraphs are elements of their own: compare the words, not the line breaks between them)
    expect(visibleText(region).replace(/\s+/g, '')).toBe(section.replace(/\s+/g, ''));
    expect(reads).toContain(`/api/evidence/${search.id}/cases/${item.case.ntsbNo}`);
    expect(reads.some((r) => r.startsWith(`/api/cases/${item.case.ntsbNo}`))).toBe(false);
    fireEvent.click(toggle);
    expect(card.querySelector('[data-excerpt-paragraph]')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(status.textContent).toBe('');
  });

  it('a full section that does not load says so, politely, with Try again; focus stays where it was', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    server.use(http.get(`*/api/evidence/${search.id}/cases/:ntsbNo`, () => HttpResponse.json({ error: 'unavailable', message: 'Try later.' }, { status: 503 })));
    const item = search.cases[0] as EvidenceCase;
    const card = cardOf(item.case.ntsbNo);
    const toggle = within(card).getAllByRole('button', { name: /^Show the full .+ section\b/ })[0] as HTMLElement;
    toggle.focus();
    fireEvent.click(toggle);
    const status = card.querySelector('[data-full-section-status]') as HTMLElement;
    await waitFor(() => expect(status.textContent).toBe(FULL_SECTION_FAILED), { timeout: 8000 });
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(document.activeElement).toBe(toggle);
  }, 20_000);

  it('a paragraph keeps its line breaks and the heading line above it, as real narratives have', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    const pages = [search, ...(await Promise.all([2, 3].map((n) => queryPage(search.id, n))))];
    const headed = pages.flatMap((p) => p.cases).find((c) => c.excerpts.some((e) => e.text.includes('\n'))) as EvidenceCase;
    expect(headed).toBeDefined();
    const excerpt = headed.excerpts.find((e) => e.text.includes('\n')) as EvidenceCase['excerpts'][number];
    const page = servePage({ ...search, id: '00000000-0000-4000-9000-0000000ead01', cases: [{ ...headed, rank: 1 }], total: 1, pages: 1 });
    renderApp(`/ai/${page.id}`);
    const card = await waitFor(() => cardOf(headed.case.ntsbNo), SLOW);
    const paragraph = [...card.querySelectorAll('blockquote p')].find((p) => p.textContent?.includes('\n')) as HTMLElement;
    expect(paragraph.className).toContain('whitespace-pre-line');
    expect(visibleText(paragraph)).toBe(excerpt.text);
  });

  it('the full section is text, never markup; astral and multi-byte characters keep their marks (a synthetic page)', async () => {
    freshApi();
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const base = search.cases[0] as EvidenceCase;
    const before = 'The pilot’s statement <b>was</b> recorded.\n';
    const text = 'Wind 𝟏𝟐 knots, gusting 𝟏𝟗; the carburetor icing chart showed “serious” icing.';
    const after = '\nNo other anomalies <script>alert(1)</script> were found.';
    const at = (word: string, from = 0): { start: number; end: number } => {
      const start = text.indexOf(word, from);
      return { start, end: start + word.length };
    };
    const icing = at('icing');
    const highlights = [
      { ...at('carburetor'), match: 'synonym' as const },
      { ...icing, match: 'literal' as const },
      { ...at('icing', icing.end), match: 'literal' as const },
    ];
    const detail = structuredClone(CASES[base.case.ntsbNo] as CaseDetail);
    const section = detail.sections.find((s) => s.kind === 'analysis') as CaseDetail['sections'][number];
    section.text = `${before}${text}${after}`;
    const page = servePage(
      {
        ...search,
        id: '00000000-0000-4000-9000-00000000a57a',
        cases: [
          {
            ...base,
            excerpts: [
              {
                sectionKey: section.key,
                section: 'analysis',
                label: 'Analysis',
                scope: section.scope,
                aircraftKey: section.aircraftKey,
                revision: section.revision,
                paragraph: { start: before.length, end: before.length + text.length },
                seed: { start: 0, end: section.text.length },
                text,
                highlights,
              },
            ],
          },
        ],
        total: 1,
        pages: 1,
      },
      detail,
    );
    renderApp(`/ai/${page.id}`);
    const card = await waitFor(() => cardOf(base.case.ntsbNo), SLOW);
    // The marks are the excerpt's own words, though astral characters (two UTF-16 units each) come first.
    expect([...card.querySelectorAll('mark')].map((m) => visibleText(m))).toEqual(['carburetor', 'icing', 'icing']);
    fireEvent.click(within(card).getByRole('button', { name: 'Show the full analysis section' }));
    const region = await present(() => card.querySelector<HTMLElement>('[data-full-section]'));
    await present(() => region.querySelector('[data-excerpt-paragraph]'));
    expect(region.querySelector('b, script')).toBeNull();
    expect(region.textContent).toContain('The pilot’s statement <b>was</b> recorded.');
    expect(region.textContent).toContain('No other anomalies <script>alert(1)</script> were found.');
    // An offset inside a surrogate pair is widened to the whole character, never cutting it.
    expect(markRanges('a𝟏b', [{ start: 2, end: 3, match: 'literal' }])).toEqual([{ start: 1, end: 3, match: 'literal' }]);
  });

  it('a paragraph too long for a card is collapsed, never cut, and opens whole; print shows it whole (a synthetic page)', async () => {
    freshApi();
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const base = search.cases[0] as EvidenceCase;
    const excerpt = base.excerpts[0] as EvidenceCase['excerpts'][number];
    const long = `${'The pilot reported that the engine ran rough. '.repeat(80)}The end of the paragraph.`;
    expect(long.length).toBeGreaterThan(LONG_TEXT_CHARS);
    const page = servePage({
      ...search,
      id: '00000000-0000-4000-9000-0000000010ff',
      cases: [{ ...base, excerpts: [{ ...excerpt, text: long, paragraph: { start: excerpt.paragraph.start, end: excerpt.paragraph.start + long.length }, highlights: [] }] }],
      total: 1,
      pages: 1,
    });
    renderApp(`/ai/${page.id}`);
    const card = await waitFor(() => cardOf(base.case.ntsbNo), SLOW);
    const words = long.trim().split(/\s+/).length;
    const open = within(card).getByRole('button', { name: `Show the whole paragraph (${words} words)` });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    const box = document.getElementById(open.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(box.getAttribute('data-long-text')).toBe('closed');
    // All of it is in the page (a screen reader reads it whole), only its height is held.
    expect(box.textContent).toContain('The end of the paragraph.');
    fireEvent.click(open);
    expect(box.getAttribute('data-long-text')).toBe('open');
    expect(open.textContent).toBe('Show less of this paragraph');
  });

  it('Show more pages the pinned ranking for free, with the total; focus goes to the first new case', async () => {
    freshApi();
    const reads = recordReads();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    const posts = recordPosts('/api/evidence');
    expect(document.querySelectorAll('article[data-card]')).toHaveLength(10);
    const more = screen.getByRole('navigation', { name: 'More investigations' });
    expect(more.textContent).toContain(showingLine(10, 21));
    expect(showMoreLabel(10, 21, 10)).toBe('Show 10 more');
    fireEvent.click(within(more).getByRole('button', { name: /^Show 10 more\s*\(free\)$/ }));
    await waitFor(() => expect(document.querySelectorAll('article[data-card]')).toHaveLength(20), SLOW);
    await waitFor(() => expect(document.activeElement?.closest('article')?.getAttribute('data-rank')).toBe('11'));
    expect(currentUrl(router)).toBe(`/ai/${search.id}?pages=2`);
    expect(reads).toContain(`/api/evidence/${search.id}?page=2`);
    fireEvent.click(within(more).getByRole('button', { name: /^Show 1 more\s*\(free\)$/ }));
    await waitFor(() => expect(document.querySelectorAll('article[data-card]')).toHaveLength(21), SLOW);
    expect(more.textContent).toBe(allShownLine(21));
    // Paging asked the AI nothing.
    expect(posts).toHaveLength(0);
    // The ask seeds page 1 under the key the page reads it with.
    expect(evidencePageQuery(search.id, 1).queryKey).toEqual(evidencePageKey(search.id, 1));
  });

  it('a link with more pages shows them all again, read from the pinned ranking', async () => {
    freshApi();
    await openSearch(MOCK_EVIDENCE_QUESTIONS.seed, '?pages=3');
    await waitFor(() => expect(document.querySelectorAll('article[data-card]')).toHaveLength(21), SLOW);
    expect(screen.getByRole('navigation', { name: 'More investigations' }).textContent).toBe('That’s all 21 retrieved.');
  });

  it('an empty result shows its filters and words, and a free keyword search without filters', async () => {
    freshApi();
    await openApplied(MOCK_EVIDENCE_QUESTIONS.empty);
    const box = document.querySelector('[data-few-results]') as HTMLElement;
    expect(box.textContent).toContain(EMPTY_TITLE);
    expect(box.textContent).toContain(`Filters: Highest injury: Fatal · Aircraft: Balloon · Location: Alaska · ${QUESTION_AS_ASKED}`);
    const terms = MOCK_EVIDENCE_QUESTIONS.empty;
    const out = within(box).getByRole('link', { name: /without filters\s*\(free\)$/ });
    expect(out.textContent).toBe(`Keyword search for “${terms}”, without filters (free)`);
    expect(out.getAttribute('href')).toBe(`/explore?${new URLSearchParams({ q: terms }).toString()}`);
    // An empty result says nothing of counts or order.
    expect(document.querySelector('[data-count-line]')).toBeNull();
    // The notice stands on an empty result too.
    expect(screen.getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
    expect(document.querySelectorAll('article[data-card]')).toHaveLength(0);
  });

  it('a tiny result shows the same under its cards', async () => {
    freshApi();
    await openApplied(MOCK_EVIDENCE_QUESTIONS.tiny);
    expect(document.querySelectorAll('article[data-card]')).toHaveLength(2);
    const box = document.querySelector('[data-few-results]') as HTMLElement;
    expect(box.textContent).toContain('Only two investigations were retrieved.');
    expect(box.textContent).toContain('Filters: Aircraft: Helicopter · Location: Texas');
    expect(within(box).getByRole('link', { name: /without filters/ }).getAttribute('href')).toBe('/explore?q=Helicopter+power+loss+in+Texas');
    // The box says how many; no paging line repeats it.
    expect(screen.queryByRole('navigation', { name: 'More investigations' })).toBeNull();
  });

  it('a gone or unknown search says so plainly and offers to ask again; “Ask again” only from this page’s memory', async () => {
    freshApi();
    const id = '00000000-0000-4000-9000-00000000dead';
    renderApp(`/ai/${id}`);
    expect(await screen.findByRole('heading', { level: 1, name: EXPIRED_TITLE }, SLOW)).toBeTruthy();
    expect(screen.getByText(EXPIRED_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Ask AI/ })).toBeTruthy();
    expect(document.title).toBe('AI search expired · AirCase');
    // A malformed link is unknown too.
    renderApp('/ai/not-a-search');
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1, name: EXPIRED_TITLE })).toHaveLength(2), SLOW);
    // The question this page asked is offered back, never from browser storage.
    rememberQuestion(id, MOCK_EVIDENCE_QUESTIONS.carb);
    renderApp(`/ai/${id}`);
    const again = (await screen.findAllByRole('button', { name: 'Ask again' }, SLOW))[0] as HTMLElement;
    fireEvent.click(again);
    const boxes = screen.getAllByRole('textbox', { name: 'Search NTSB investigations' }) as HTMLTextAreaElement[];
    expect(boxes.some((b) => b.value === MOCK_EVIDENCE_QUESTIONS.carb)).toBe(true);
  });
});

describe('the suggestion is applied only by choice, and the reader edits the search', { timeout: 20_000 }, () => {
  it('“Apply these filters · uses 1” makes an edited search with exactly those filters and the question as asked, never the suggested terms', async () => {
    freshApi();
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const posts = recordPosts('/api/evidence');
    const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
    fireEvent.click(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) }));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'edited', from: search.id, filters: { phase: ['approach'] }, turnstileToken: TOKEN });
    expect(Object.keys(posts[0] as object).sort()).toEqual(['filters', 'from', 'idempotencyKey', 'kind', 'turnstileToken']);
    const edited = await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    // The question still as asked; the filter now the reader's own (blue), removable.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(MOCK_EVIDENCE_QUESTIONS.carb);
    expect(edited.textContent).toContain(QUESTION_AS_ASKED);
    expect(within(edited).getByRole('button', { name: /^Phase: Approach\s*, remove$/ }).className).toContain('border-blue');
    // An edited search carries no suggestion; its marks and counts are the reader's words.
    expect(screen.queryByRole('region', { name: SUGGESTION_LABEL })).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-count-line]')?.textContent).toMatch(/^7 retrieved/), SLOW);
    expect(document.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('yours');
    expect(visibleText(document.querySelector('[data-relevance]') as Element)).toMatch(/^Phase: Approach · Your words in these excerpts: /);
  });

  it('“Apply filters and terms · uses 1” takes the suggested terms too, said as an explicit choice', async () => {
    freshApi();
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const posts = recordPosts('/api/evidence');
    fireEvent.click(within(screen.getByRole('region', { name: SUGGESTION_LABEL })).getByRole('button', { name: new RegExp(`^${APPLY_BOTH}\\s*·\\s*uses 1$`) }));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts[0]).toMatchObject({ kind: 'edited', from: search.id, filters: { phase: ['approach'] }, terms: 'carb icing' });
    const edited = await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    expect(within(edited).getByRole('button', { name: /^carb icing\s*, edit the search words$/ })).toBeTruthy();
  });

  it('a filter removed stays removed: Search again · uses 1 sends the filters left and keeps the query; Undo restores', async () => {
    freshApi();
    installTurnstile();
    const { router, search } = await openApplied(MOCK_EVIDENCE_QUESTIONS.carb);
    const posts = recordPosts('/api/evidence');
    const yours = screen.getByRole('region', { name: EDITED_LABEL });
    expect(within(yours).queryByRole('button', { name: /Search again/ })).toBeNull();
    fireEvent.click(within(yours).getByRole('button', { name: /^Phase: Approach\s*, remove$/ }));
    expect(within(yours).queryByRole('button', { name: /^Phase: Approach\s*, remove$/ })).toBeNull();
    expect(document.activeElement?.textContent).toBe('+ Filter');
    // Free alternatives first: a keyword search with these words and filters, or undo.
    const keyword = within(yours).getByRole('link', { name: /^Show keyword results\s*with these words and filters \(free\)$/ });
    expect(keyword.getAttribute('href')).toBe(`/explore?${new URLSearchParams({ q: MOCK_EVIDENCE_QUESTIONS.carb }).toString()}`);
    fireEvent.click(within(yours).getByRole('button', { name: 'Undo changes' }));
    fireEvent.click(within(yours).getByRole('button', { name: /^Phase: Approach\s*, remove$/ }));
    fireEvent.click(within(yours).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'edited', from: search.id, filters: {} });
    expect('terms' in (posts[0] as object)).toBe(false);
    await waitFor(() => expect(document.querySelector('[data-count-line]')?.textContent).toMatch(/^21 retrieved/), SLOW);
    expect(within(screen.getByRole('region', { name: YOUR_SEARCH_LABEL })).queryAllByRole('button', { name: /, remove$/ })).toHaveLength(0);
  });

  it('the reader’s own words: ✎ opens the field, Enter keeps, Escape cancels, empty is refused; Search again sends them', async () => {
    freshApi();
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const posts = recordPosts('/api/evidence');
    const yours = screen.getByRole('region', { name: YOUR_SEARCH_LABEL });
    const opener = within(yours).getByRole('button', { name: OWN_WORDS });
    fireEvent.click(opener);
    const input = within(yours).getByRole('textbox', { name: 'Search words' }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(yours).getByRole('alert').textContent).toBe(EMPTY_WORDS);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain(OWN_WORDS));
    fireEvent.click(within(yours).getByRole('button', { name: OWN_WORDS }));
    fireEvent.change(within(yours).getByRole('textbox', { name: 'Search words' }), { target: { value: '  carburetor   heat ' } });
    fireEvent.keyDown(within(yours).getByRole('textbox', { name: 'Search words' }), { key: 'Enter' });
    // Typed, not searched yet: dashed, and said so.
    const words = await within(yours).findByRole('button', { name: /^carburetor heat\s*, not searched yet, edit the search words$/ });
    expect(words.className).toContain('border-blue');
    expect(words.className).toContain('border-dashed');
    expect(within(yours).getByRole('link', { name: /^Show keyword results/ }).getAttribute('href')).toBe('/explore?q=carburetor+heat');
    fireEvent.click(within(yours).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts[0]).toMatchObject({ kind: 'edited', from: search.id, filters: {}, terms: 'carburetor heat' });
  });

  it('+ Filter adds a facet value or a year range, free until Search again', async () => {
    freshApi();
    await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const yours = screen.getByRole('region', { name: YOUR_SEARCH_LABEL });
    const add = within(yours).getByRole('button', { name: '+ Filter' });
    fireEvent.click(add);
    const editor = within(yours).getByRole('group', { name: 'Add a filter' });
    fireEvent.change(within(editor).getByLabelText('Filter'), { target: { value: 'years' } });
    fireEvent.change(within(editor).getByLabelText('From'), { target: { value: '2020' } });
    fireEvent.change(within(editor).getByLabelText('To'), { target: { value: '2010' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    expect(within(editor).getByRole('alert').textContent).toBe('Enter a year from 2008 to 2026, or both in order.');
    fireEvent.change(within(editor).getByLabelText('To'), { target: { value: '2024' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    // Added, not searched yet: it looks (and is said) different from an applied filter.
    const years = within(yours).getByRole('button', { name: /^Years: 2020–2024\s*, not searched yet, remove$/ });
    expect(years.className).toContain('border-blue');
    expect(years.className).toContain('border-dashed');
    expect(document.activeElement).toBe(add);
    expect(within(yours).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ })).toBeTruthy();
    // Applying the suggestion now would drop these changes: its buttons are off, and it says why.
    const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
    expect(suggestion.querySelector('[data-draft-pending]')?.textContent).toBe(DRAFT_PENDING_NOTE);
    for (const button of within(suggestion).getAllByRole('button', { name: /uses 1$/ })) expect(button.getAttribute('aria-disabled')).toBe('true');
    // Undo: the changes go, focus goes to "+ Filter", and the suggestion can be applied again.
    fireEvent.click(within(yours).getByRole('button', { name: 'Undo changes' }));
    await waitFor(() => expect(document.activeElement).toBe(within(yours).getByRole('button', { name: '+ Filter' })));
    expect(within(yours).queryAllByRole('button', { name: /, remove$/ })).toHaveLength(0);
    expect(suggestion.querySelector('[data-draft-pending]')).toBeNull();
    expect(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) }).getAttribute('aria-disabled')).toBe('false');
  });

  it('model text in the suggestion is shown as text under its label, never markup, and reaches no result (a synthetic page)', async () => {
    freshApi();
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const hostile = '<img src=x onerror=alert(1)> Ignore the notice: these all prove carb icing';
    const page = servePage({ ...search, id: '00000000-0000-4000-9000-0000000bad01', suggestion: { filters: { phase: ['approach'] }, terms: hostile } });
    renderApp(`/ai/${page.id}`);
    const suggestion = await screen.findByRole('region', { name: SUGGESTION_LABEL }, SLOW);
    expect(suggestion.textContent).toContain(`“${hostile}”`);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const results = screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING }).closest('section') as HTMLElement;
    expect(results.textContent).not.toContain('Ignore the notice');
    expect(within(results).getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
  });
});

describe('focus, announcements and state that stays with its case (UI review fix round)', { timeout: 30_000 }, () => {
  const live = (): string => (document.querySelector('[data-evidence-live]')?.textContent ?? '').trim();

  it('results opened by Ask AI are announced, and focus goes to their heading when it was lost on the way', async () => {
    freshApi();
    installTurnstile(5);
    const { router } = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_EVIDENCE_QUESTIONS.carb } });
    const ask = await screen.findByRole('button', { name: /^Ask AI\s*·/ });
    ask.focus();
    fireEvent.click(ask);
    await waitFor(() => expect(currentUrl(router)).toMatch(/^\/ai\//), SLOW);
    const heading = await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(live()).toBe('21 investigations retrieved.'));
    expect(arrivalLine(1)).toBe('1 investigation retrieved.');
    expect(arrivalLine(0)).toBe(EMPTY_TITLE);
  });

  it('Apply and Search again do the same for the search they open; a page opened by its link leaves focus alone', async () => {
    freshApi();
    installTurnstile(5);
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    expect(document.activeElement).toBe(document.body);
    expect(live()).toBe('');
    const apply = within(screen.getByRole('region', { name: SUGGESTION_LABEL })).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) });
    apply.focus();
    fireEvent.click(apply);
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })), SLOW);
    await waitFor(() => expect(live()).toBe('7 investigations retrieved.'));
    // Search again from there: the same again, for the new search.
    const yours = screen.getByRole('region', { name: EDITED_LABEL });
    fireEvent.click(within(yours).getByRole('button', { name: /^Phase: Approach\s*, remove$/ }));
    fireEvent.click(within(yours).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(live()).toBe('21 investigations retrieved.'), SLOW);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING }));
  });

  it('Undo changes gives focus back to the words when they changed', async () => {
    freshApi();
    await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const yours = screen.getByRole('region', { name: YOUR_SEARCH_LABEL });
    fireEvent.click(within(yours).getByRole('button', { name: OWN_WORDS }));
    fireEvent.change(within(yours).getByRole('textbox', { name: 'Search words' }), { target: { value: 'carburetor heat' } });
    fireEvent.keyDown(within(yours).getByRole('textbox', { name: 'Search words' }), { key: 'Enter' });
    fireEvent.click(await within(yours).findByRole('button', { name: 'Undo changes' }));
    await waitFor(() => expect(document.activeElement).toBe(within(yours).getByRole('button', { name: OWN_WORDS })));
  });

  it('the drawer never carries an open section from one case to the next, nor pulls focus into it', async () => {
    freshApi();
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    // Two cases in a row whose first excerpts share a section key and offset: the keys that once collided.
    const key = (c: EvidenceCase | undefined): string | null => (c?.excerpts[0] ? `${c.excerpts[0].sectionKey}:${c.excerpts[0].paragraph.start}` : null);
    const at = search.cases.findIndex((c, i) => key(c) !== null && key(c) === key(search.cases[i + 1]));
    expect(at).toBeGreaterThanOrEqual(0);
    const [a, b] = [search.cases[at] as EvidenceCase, search.cases[at + 1] as EvidenceCase];
    const { router } = renderApp(`/ai/${search.id}?case=${a.case.ntsbNo}`);
    const sectionOf = async () => within(await screen.findByRole('dialog', {}, SLOW)).findByRole('region', { name: EVIDENCE_HEADING }, SLOW);
    await sectionOf();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next case' }));
    await waitFor(() => expect(currentUrl(router)).toContain(`case=${b.case.ntsbNo}`), SLOW);
    const inB = await sectionOf();
    fireEvent.click(within(inB).getAllByRole('button', { name: /^Show the full .+ section\b/ })[0] as HTMLElement);
    await waitFor(() => expect(within(inB).getAllByRole('button', { name: /^Show the excerpt only\b/ }).length).toBe(1), SLOW);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous case' }));
    await waitFor(() => expect(currentUrl(router)).toContain(`case=${a.case.ntsbNo}`), SLOW);
    await act(() => sleep(400));
    const inA = await sectionOf();
    expect(within(inA).queryAllByRole('button', { name: /^Show the excerpt only\b/ })).toHaveLength(0);
    expect(document.activeElement?.hasAttribute('data-excerpt-paragraph')).toBe(false);
  });

  it('every “Show the full … section” on a card has a name of its own', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    for (const c of search.cases.filter((x) => x.excerpts.length > 1)) {
      const names = within(cardOf(c.case.ntsbNo))
        .getAllByRole('button', { name: /^Show the full .+ section\b/ })
        .map((b) => b.textContent);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('Search again or Apply on a search that expired while the tab was open shows the expired state, not a failure', async () => {
    freshApi();
    installTurnstile(5);
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    // The server's answer to an edit of a search that is gone, and to reads of it from now on.
    server.use(
      http.post('*/api/evidence', () => HttpResponse.json({ error: 'not_found', message: 'No AI search with that link is available.' }, { status: 404 })),
      http.get(`*/api/evidence/${search.id}`, () => HttpResponse.json({ error: 'not_found', message: 'No AI search with that link is available.' }, { status: 404 })),
    );
    fireEvent.click(within(screen.getByRole('region', { name: SUGGESTION_LABEL })).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) }));
    expect(await screen.findByRole('heading', { level: 1, name: EXPIRED_TITLE }, SLOW)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/didn.t finish|went wrong/i);
    expect(live()).toBe(EXPIRED_TITLE);
  });

  it('an edit refused as gone while its page still reads says so in the box, never a generic failure', async () => {
    freshApi();
    installTurnstile(5);
    await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    server.use(http.post('*/api/evidence', () => HttpResponse.json({ error: 'not_found', message: 'No AI search with that link is available.' }, { status: 404 })));
    fireEvent.click(within(screen.getByRole('region', { name: SUGGESTION_LABEL })).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) }));
    expect(await screen.findByText(EXPIRED_TITLE, {}, SLOW)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/didn.t finish|went wrong/i);
  });

  it('Compare by link holds a strip’s place while the pages it names load, then shows the case', async () => {
    freshApi();
    const first = await makeSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    const target = (await queryPage(first.id, 3)).cases[0]?.case.ntsbNo as string;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('*/api/evidence/:id', async ({ request }) => {
        if (new URL(request.url).searchParams.get('page') !== '1') await held;
        return undefined;
      }),
    );
    renderApp(`/compare?cases=${target}&evidence=${first.id}&pages=3`);
    const row = await present(() => screen.queryByRole('article', { name: `${target}, strip 1` })?.querySelector<HTMLElement>('[data-strip-evidence]'));
    expect(row.getAttribute('data-strip-evidence')).toBe('loading');
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.textContent).not.toContain(NOT_IN_SEARCH);
    release();
    await waitFor(() => expect(row.getAttribute('data-strip-evidence')).toBe('found'), SLOW);
  });

  it('the singular reads as singular in the limits’ copy', () => {
    const one = { ...MOCK_AI_LIMITS, newAccountDaily: 1, newAccountDays: 1 };
    expect(welcomeText(one, undefined)).toBe('You have 1 AI search a day for your first day, then 50.');
    expect(trialUsedSignIn(one)).toBe('Sign in with Google to keep asking. New accounts start with 1 AI search a day, rising to 50 after one day.');
    expect(welcomeText(MOCK_AI_LIMITS, undefined)).toBe('You have 20 AI searches a day for your first three days, then 50.');
  });

  it('Explore’s Compare box prints as it did before the evidence view shared its row', async () => {
    freshApi();
    renderApp('/explore?q=carburetor+icing');
    const box = (await screen.findAllByRole('checkbox', { name: /^Compare/ }, SLOW))[0] as HTMLElement;
    expect(box.closest('[data-print="hide"]')).toBeNull();
  });
});

describe('the drawer, Compare and print show the same projection and the notice', { timeout: 20_000 }, () => {
  it('the drawer: under the heading and notice, how the case was found and its excerpts; ‹ n of N › follows the ranking and shows more past the last card', async () => {
    freshApi();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    const first = search.cases[0] as EvidenceCase;
    fireEvent.click(within(cardOf(first.case.ntsbNo)).getByRole('link', { name: first.case.ntsbNo }));
    const dialog = await screen.findByRole('dialog');
    const section = await within(dialog).findByRole('region', { name: EVIDENCE_HEADING }, SLOW);
    expect(within(section).getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
    expect(visibleText(section.querySelector('[data-relevance]') as Element)).toBe(relevanceParts(first.relevance, relevanceContext(search)).join(' · '));
    expect(section.querySelectorAll('figure')).toHaveLength(first.excerpts.length);
    expect(within(dialog).getByText('1 of 21')).toBeTruthy();
    // The tenth card, then Next: the next page comes, and the drawer moves on to its first case.
    const tenth = search.cases[9] as EvidenceCase;
    await act(() => router.navigate(`/ai/${search.id}?case=${tenth.case.ntsbNo}`));
    expect(await within(await screen.findByRole('dialog')).findByText('10 of 21')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next case' }));
    expect(await within(screen.getByRole('dialog')).findByText('11 of 21', {}, SLOW)).toBeTruthy();
    expect(currentUrl(router)).toMatch(/[?&]pages=2/);
  });

  it('Compare: the question, the heading and the notice, and each strip’s row of how the search found it and its best excerpt', async () => {
    freshApi();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const [a, b] = search.cases as [EvidenceCase, EvidenceCase];
    fireEvent.click(within(cardOf(a.case.ntsbNo)).getByRole('checkbox', { name: new RegExp(`^Compare\\s*${a.case.ntsbNo}$`) }));
    fireEvent.click(within(cardOf(b.case.ntsbNo)).getByRole('checkbox', { name: new RegExp(`^Compare\\s*${b.case.ntsbNo}$`) }));
    const tray = await screen.findByRole('complementary', { name: 'Compare tray' });
    fireEvent.click(within(tray).getByRole('link', { name: 'Compare →' }));
    await waitFor(() => expect(currentUrl(router)).toBe(`/compare?cases=${a.case.ntsbNo},${b.case.ntsbNo}&evidence=${search.id}&pages=1`));
    const top = await present(() => document.querySelector<HTMLElement>('[data-compare-evidence]'));
    expect(top.textContent).toContain(`From your search “${search.question}”`);
    expect(top.textContent).toContain(EVIDENCE_HEADING);
    expect(within(top).getByRole('note').textContent).toBe(EVIDENCE_NOTICE);
    // The strip once its case is read (a pending strip has the same name), with its evidence row.
    const row = await present(() => screen.queryByRole('article', { name: `${a.case.ntsbNo}, strip 1` })?.querySelector<HTMLElement>('[data-strip-evidence]'));
    expect(visibleText(row.querySelector('[data-relevance]') as Element)).toBe(relevanceParts(a.relevance, relevanceContext(search)).join(' · '));
    expect(visibleText(row.querySelector('blockquote') as Element)).toBe(a.excerpts[0]?.text);
    expect(a.excerpts.length).toBe(3);
    expect(row.textContent).toContain('2 more excerpts on the search’s page.');
    // The key to the marks: the suggested words.
    expect(top.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('suggested');
    // Back to the search (with the compare selection), not to Explore.
    expect(screen.getByRole('link', { name: '← Back to results' }).getAttribute('href')).toBe(`/ai/${search.id}?cases=${a.case.ntsbNo}%2C${b.case.ntsbNo}`);
  });

  it('Compare: a case the search did not show says so; a search that is gone shows the strips with a note', async () => {
    freshApi();
    const asked = await makeSearch(MOCK_EVIDENCE_QUESTIONS.tiny);
    const search = await makeEdit(asked, asked.suggestion?.filters ?? {});
    renderApp(`/compare?cases=DFW08TA066,NYC08LA106&evidence=${search.id}&pages=1`);
    const row = await present(() => screen.queryByRole('article', { name: 'NYC08LA106, strip 2' })?.querySelector<HTMLElement>('[data-strip-evidence]'));
    expect(row.textContent).toContain(NOT_IN_SEARCH);
    renderApp('/compare?cases=DFW08TA066,NYC08LA106&evidence=00000000-0000-4000-9000-00000000dead&pages=1');
    expect(await screen.findByText(EVIDENCE_GONE_PLURAL, {}, SLOW)).toBeTruthy();
  });

  it('print: the heading, the notice, what was searched and the cards print; the suggestion, the hint and the controls do not', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const hidden = (el: Element | null): boolean => el?.closest('[data-print="hide"]') !== null;
    expect(hidden(screen.getByRole('note'))).toBe(false);
    expect(hidden(screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING }))).toBe(false);
    expect(hidden(screen.getByRole('region', { name: YOUR_SEARCH_LABEL }))).toBe(false);
    expect(hidden(screen.getByRole('region', { name: SUGGESTION_LABEL }))).toBe(true);
    // Paper keeps the suggestion as one line under its label, so "Suggested terms in these excerpts" reads on its own.
    const printed = document.querySelector('[data-suggestion-print]') as HTMLElement;
    expect(printed.getAttribute('data-print')).toBe('only');
    expect(printed.textContent).toBe(suggestionInWords(search.suggestion as NonNullable<EvidencePage['suggestion']>));
    expect(printed.textContent).toBe('Suggested filters and terms — not applied: Phase: Approach · “carb icing”');
    expect(hidden(cardOf((search.cases[0] as EvidenceCase).case.ntsbNo))).toBe(false);
    expect(hidden(screen.getByRole('button', { name: '+ Filter' }))).toBe(true);
    expect(hidden(screen.getAllByRole('button', { name: /^Show the full .+ section\b/ })[0] as HTMLElement)).toBe(true);
    expect(hidden(screen.getByRole('navigation', { name: 'More investigations' }))).toBe(true);
    const header = document.querySelector('[data-print="only"]') as HTMLElement;
    expect(header.textContent).toContain(`AirCase · ${EVIDENCE_HEADING}`);
    expect(header.textContent).toContain(search.cases.map((c) => c.case.ntsbNo).join(' · '));
  });
});

describe('a result surface shows NTSB text, coded data, fixed copy and the reader’s own words only (gate G6)', { timeout: 20_000 }, () => {
  /** Every text node under `root`, trimmed, non-empty. */
  function texts(root: Element): string[] {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = (node.textContent ?? '').trim();
      if (t) out.push(t);
    }
    return out;
  }

  /** What a page may show: its NTSB fields and coded data, said by the deterministic display rules, and fixed copy. */
  function allowed(page: EvidencePage): string {
    const parts: string[] = [EVIDENCE_HEADING, EVIDENCE_NOTICE, countLine(page.total), showingLine(page.cases.length, page.total), allShownLine(page.total)];
    parts.push(showMoreLabel(page.cases.length, page.total, 10), '(free)', 'Marked in the excerpts:', page.suggestion ? LEGEND.suggested : LEGEND.yours, LEGEND.synonym, '; dotted:', '·', expiryLine(page.expiresAt));
    for (const c of page.cases) {
      const row = c.case;
      parts.push(row.ntsbNo, formatDate(row.date), aircraftSummary(row), placeShort(row.city, row.state, row.country), ...rowMonoParts(row).map((p) => p.text));
      row.aircraft.forEach((a, i) => parts.push(letterOf(row.ntsbNo, a, i), aircraftName(a), phaseEventShort(a)));
      parts.push('Compare', ',', 'How it was found:', relevanceParts(c.relevance, relevanceContext(page), c.excerpts.length > 0).join(' · '));
      c.probableCauses.forEach((p, i) => parts.push(probableCauseLabel(row.ntsbNo, row.aircraft, p, i, c.probableCauses.length), p.text));
      const numbered = numberedKinds(c.excerpts);
      for (const [i, e] of c.excerpts.entries()) {
        parts.push(excerptLabel(row.ntsbNo, row.aircraft, e, numbered.has(e.section)), e.text, fullSectionLabel(e), '(synonym)');
        if (c.excerpts.length > 1) parts.push(`, excerpt ${i + 1} of ${c.excerpts.length}`);
        if (e.text.length > LONG_TEXT_CHARS) parts.push(`Show the whole paragraph (${e.text.trim().split(/\s+/).length.toLocaleString('en-US')} words)`);
      }
      if (c.excerpts.length === 0) parts.push(NO_EXCERPT, `Open ${row.ntsbNo}`);
      parts.push(c.report.kind === 'report' ? 'NTSB report ↗' : `${c.report.note} ·`, 'Search NTSB ↗', `(a search page, not the report; look up ${row.ntsbNo})`);
    }
    return parts.join('\n');
  }

  it.each(['seed', 'carb', 'midair', 'multibyte', 'noSuggestion', 'statistics'] as const)('%s: every text node of the results comes from the page’s NTSB fields, coded data or fixed copy', async (name) => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS[name]);
    const results = screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING }).closest('section') as HTMLElement;
    const corpus = allowed(search);
    const strays = texts(results).filter((t) => !corpus.includes(t));
    expect(strays).toEqual([]);
  });

  it('the drawer’s search section too', async () => {
    freshApi();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    const first = search.cases[0] as EvidenceCase;
    fireEvent.click(within(cardOf(first.case.ntsbNo)).getByRole('link', { name: first.case.ntsbNo }));
    const section = await within(await screen.findByRole('dialog')).findByRole('region', { name: EVIDENCE_HEADING }, SLOW);
    const strays = texts(section).filter((t) => !allowed(search).includes(t) && t !== EVIDENCE_HEADING && t !== 'NTSB text');
    expect(strays).toEqual([]);
  });
});

describe('the AI counter and paid controls keep to the API’s limits', () => {
  it('a signed-in visitor: “AI left today: 48 of 50”, and Apply and Search again say they use one', async () => {
    window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
    try {
      freshApi({ googleEnabled: true });
      server.use(http.get('*/api/ai/status', () => HttpResponse.json(AI_STATUS_SAMPLES.signedIn)));
      await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
      await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('AI left today: 48 of 50'), SLOW);
      const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
      expect(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) }).getAttribute('aria-disabled')).toBe('false');
      const yours = screen.getByRole('region', { name: YOUR_SEARCH_LABEL });
      fireEvent.click(within(yours).getByRole('button', { name: '+ Filter' }));
      fireEvent.click(within(within(yours).getByRole('group', { name: 'Add a filter' })).getByRole('button', { name: 'Add' }));
      expect(within(yours).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ }).getAttribute('aria-disabled')).toBe('false');
    } finally {
      window.sessionStorage.clear();
    }
  });
});
