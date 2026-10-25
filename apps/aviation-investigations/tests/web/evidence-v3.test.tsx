/**
 * The evidence view's `evidence.v3` disclosures over the mock API (web/mock/evidence.ts) in the
 * configurations the evaluation may pick (UI_DESIGN §4.9): a state AirCase applied because the
 * question names it, terms it added to keyword search, AI's order of the leading results and whose
 * words are marked, each said as such on every surface; the suggestion keeping only what was not
 * used; and "Search again · free", the one free undo of what AirCase added, when the page says it is
 * there (`undo: 'available'`) and the draft qualifies by the server's rule (positive cases and each
 * condition that makes an edit use one), at zero searches left, with the server's `freeUndo` as the
 * last word. The baseline configuration's states are in evidence.test.tsx.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiStatusResponse } from '../../shared/contracts/ai';
import type { BriefFilters } from '../../shared/contracts/briefs';
import { CreateEvidenceResponseSchema, EVIDENCE_BOUNDARY, EVIDENCE_HEADING, EVIDENCE_NOTICE, type EvidenceCase, type EvidencePage } from '../../shared/contracts/evidence';
import { AI_STATUS_SAMPLES } from '../../web/mock/ai-status';
import { MOCK_EVIDENCE_QUESTIONS, type MockEvidenceConfig } from '../../web/mock/evidence';
import type { TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { resetUnsettledForTests, unsettledId } from '../../web/src/features/ai/unsettled';
import {
  AI_TAG,
  ALSO_SEARCHED_LABEL,
  APPLY_BOTH,
  APPLY_FILTERS,
  EDITED_LABEL,
  EMPTY_TITLE,
  FROM_QUESTION,
  KEYWORDS_SEARCHED_LABEL,
  KEYWORDS_SEARCHED_NOTE,
  LEGEND,
  OWN_WORDS,
  QUESTION_AS_ASKED,
  SEARCH_SUGGESTED_TERMS,
  SUGGESTION_LABEL,
  SUGGESTION_NOTE,
  SUGGESTION_NOTE_AUTOMATIC,
  UNDO_CHARGED,
  YOUR_SEARCH_LABEL,
  allShownLine,
  countLine,
  excerptLabel,
  fullSectionLabel,
  isEditedSearch,
  numberedKinds,
  probableCauseLabel,
  relevanceContext,
  relevanceParts,
  searchedInWords,
  showMoreLabel,
  showingLine,
  suggestionInWords,
  filtersInWords,
} from '../../web/src/features/evidence/display';
import { foldProbableCauses } from '../../web/src/features/evidence/fold';
import { LONG_TEXT_CHARS } from '../../web/src/features/evidence/Excerpt';
import { createHandlers, type HandlerOptions } from '../../web/src/mocks/handlers';
import { AI_NUDGE, AI_NUDGE_FILTERS, AI_NUDGE_STATE, aiNudge } from '../../web/src/pages/Explore';
import { aircraftName, aircraftSummary, letterOf, phaseEventShort, placeShort, rowMonoParts } from '../../web/src/features/case/display';
import { formatDate } from '../../web/src/lib/format';
import { currentUrl, renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** A state applied automatically, the suggested terms searched beside the question, the leading results in AI order. */
const STATE_TERMS_AI: MockEvidenceConfig = { ranking: 'er-qt-h50-v1', autoFilters: 'state-explicit.v1.2' };
/** The suggested terms searched instead of the question in keyword search; nothing applied automatically. */
const TERMS_ONLY: MockEvidenceConfig = { ranking: 'er-t-v1', autoFilters: 'none' };

afterEach(() => {
  delete window.turnstile;
  resetUnsettledForTests();
  server.events.removeAllListeners();
});

function freshApi(options: HandlerOptions = {}): void {
  server.use(...createHandlers(options));
}

/** Cloudflare's widget stood in for: the test token after `delay` ms. */
function installTurnstile(delay = 5) {
  const state = { renders: 0 };
  const api: TurnstileApi = {
    render(host, params) {
      state.renders += 1;
      host.appendChild(document.createElement('div'));
      setTimeout(() => params.callback(TOKEN), delay);
      return `w${state.renders}`;
    },
    remove() {},
  };
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

async function post(body: Record<string, unknown>): Promise<EvidencePage> {
  const response = await fetch(new URL('/api/evidence', window.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID(), turnstileToken: TOKEN }),
  });
  return CreateEvidenceResponseSchema.parse(await response.json()).search;
}

/** A search made through the mock API (page 1 of it), as an anonymous request with a token would make it. */
const makeSearch = (question: string): Promise<EvidencePage> => post({ kind: 'question', question });

/** A search made through the mock API, then opened. */
async function openSearch(question: string) {
  const search = await makeSearch(question);
  const app = renderApp(`/ai/${search.id}`);
  await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
  return { ...app, search };
}

const yours = (edited = false): HTMLElement => screen.getByRole('region', { name: edited ? EDITED_LABEL : YOUR_SEARCH_LABEL });
const live = (): string => (document.querySelector('[data-evidence-live]')?.textContent ?? '').trim();
const banner = (): string => screen.getByRole('banner').textContent ?? '';
const visibleText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return clone.textContent ?? '';
};
const hidden = (el: Element | null): boolean => el?.closest('[data-print="hide"]') !== null;

/** "Search again · free" or "Search again · uses 1". */
const searchAgain = (counter: 'free' | 'uses 1'): HTMLElement => within(yours()).getByRole('button', { name: new RegExp(`^Search again\\s*·\\s*${counter}$`) });
const removeTexas = (panel = yours()): void => {
  fireEvent.click(within(panel).getByRole('button', { name: /^Location: Texas\s*, added automatically from your question, remove$/ }));
};
const removeTerms = (panel = yours()): void => {
  fireEvent.click(within(panel).getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ }));
};

describe('what AirCase added on its own is said as such (contract evidence.v3)', { timeout: 20_000 }, () => {
  it('a state the question names is a blue chip “from your question”; terms searched beside the question are “Also searched” with the AI tag; the count line names AI order', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    expect(search.automaticFilters).toEqual({ state: ['TX'] });
    // An original question search, though it has a filter.
    const panel = yours();
    expect(panel.textContent).toContain(QUESTION_AS_ASKED);
    // The automatic state: a normal applied chip (blue, solid, removable), with its tag, said for screen readers.
    const chip = within(panel).getByRole('button', { name: /^Location: Texas\s*, added automatically from your question, remove$/ });
    expect(chip.className).toContain('border-blue');
    expect(chip.className).not.toContain('border-dashed');
    expect(chip.getAttribute('data-automatic')).toBe('true');
    const tag = chip.querySelector('[data-automatic-tag]') as HTMLElement;
    expect(tag.textContent).toBe(FROM_QUESTION);
    expect(tag.getAttribute('aria-hidden')).toBe('true');
    expect(visibleText(chip)).toBe(`Location: Texas${FROM_QUESTION}`);
    // The added terms: their own row, quoted, tagged AI (magenta), removable like a filter.
    const row = (panel.querySelector('[data-added-terms]') as HTMLElement).closest('div') as HTMLElement;
    expect(row.querySelector('dt')?.textContent).toBe(ALSO_SEARCHED_LABEL);
    const terms = within(panel).getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ });
    expect(terms.getAttribute('data-added-terms')).toBe('question+terms');
    const ai = terms.querySelector('[data-ai-tag]') as HTMLElement;
    expect([ai.textContent, ai.className.includes('text-magenta'), ai.getAttribute('aria-hidden')]).toEqual([AI_TAG, true, 'true']);
    expect(panel.querySelector('[data-keywords-note]')).toBeNull();
    // AI put the leading results in order: the count line says so, in fixed words.
    expect(search.order).toBe('ai_relevance');
    expect(document.querySelector('[data-count-line]')?.textContent).toBe(`${search.total} retrieved · leading results ordered by AI for relevance · not every matching investigation`);
    expect(countLine(search.total, 'ai_relevance')).toBe(document.querySelector('[data-count-line]')?.textContent);
    expect(countLine(100, 'ai_relevance')).toBe('100 retrieved · leading results ordered by AI for relevance · the most one search ranks · not every matching investigation');
    // The marks: the words searched (question and added terms), never "your words".
    const legend = document.querySelector('[data-legend]') as HTMLElement;
    expect(legend.getAttribute('data-legend')).toBe('searched');
    expect(visibleText(legend)).toBe(`Marked in the excerpts: ${LEGEND.searched} · ${LEGEND.synonym}`);
    const lines = [...document.querySelectorAll('[data-relevance]')].map((r) => visibleText(r));
    expect(lines.every((l) => l.startsWith('Location: Texas · '))).toBe(true);
    expect(lines.some((l) => l.includes('Words searched in these excerpts: '))).toBe(true);
    expect(document.body.textContent).not.toMatch(/Your words in these excerpts|Suggested terms in these excerpts/);
  });

  it('the suggestion keeps only what was not used, with its note for a search AirCase added to; Apply adds its filters and keeps the state', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const posts = recordPosts('/api/evidence');
    expect(search.suggestion).toEqual({ filters: { phase: ['approach'] }, terms: null });
    const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
    expect(suggestion.querySelector('[data-suggestion-note]')?.textContent).toBe(SUGGESTION_NOTE_AUTOMATIC);
    expect(within(suggestion).getByRole('list', { name: 'Suggested filters' }).textContent).toBe('Phase: Approach');
    // No terms left to suggest: no terms row and no term actions.
    expect(suggestion.textContent).not.toContain('“carb icing”');
    expect([...suggestion.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Filters']);
    expect(within(suggestion).queryByRole('button', { name: new RegExp(`^${APPLY_BOTH}`) })).toBeNull();
    expect(within(suggestion).queryByRole('button', { name: new RegExp(`^${SEARCH_SUGGESTED_TERMS}`) })).toBeNull();
    // Paper keeps it as one line, without terms.
    expect(document.querySelector('[data-suggestion-print]')?.textContent).toBe('Suggested filters and terms — not applied: Phase: Approach');
    expect(suggestionInWords({ filters: { phase: ['approach'] }, terms: null })).toBe('Suggested filters and terms — not applied: Phase: Approach');
    // Apply these filters: the search's own filters, the state AirCase applied among them, plus the suggested ones.
    fireEvent.click(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}\\s*·\\s*uses 1$`) }));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'edited', from: search.id, filters: { phase: ['approach'], state: ['TX'] } });
    expect(Object.keys(posts[0] as object).sort()).toEqual(['filters', 'from', 'idempotencyKey', 'kind', 'turnstileToken']);
    const edited = await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    // The state is the search's own filter now (an edit applies nothing on its own), and the added terms carried on.
    expect(within(edited).getByRole('button', { name: /^Location: Texas\s*, remove$/ })).toBeTruthy();
    expect(within(edited).getByRole('button', { name: /^Phase: Approach\s*, remove$/ })).toBeTruthy();
    expect(within(edited).getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ })).toBeTruthy();
  });

  it('terms instead of the question in keyword search: “Keywords searched”, with a note that similarity search still used the question', async () => {
    freshApi({ evidence: TERMS_ONLY });
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    expect(search.query).toEqual({ source: 'question', keywords: { kind: 'terms', terms: 'carb icing' } });
    const panel = yours();
    const terms = within(panel).getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ });
    expect(terms.getAttribute('data-added-terms')).toBe('terms');
    expect(terms.closest('div')?.querySelector('dt')?.textContent).toBe(KEYWORDS_SEARCHED_LABEL);
    expect(panel.querySelector('[data-keywords-note]')?.textContent).toBe(KEYWORDS_SEARCHED_NOTE);
    // Nothing applied automatically, but terms were added: the suggestion's note is the one for a search
    // AirCase added to, and only the filter is left to suggest.
    expect(within(panel).queryByRole('button', { name: /added automatically/ })).toBeNull();
    const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
    expect(suggestion.querySelector('[data-suggestion-note]')?.textContent).toBe(SUGGESTION_NOTE_AUTOMATIC);
    expect(search.suggestion).toEqual({ filters: { phase: ['approach'] }, terms: null });
    expect(document.querySelector('[data-count-line]')?.textContent).toBe(countLine(search.total, 'match'));
    expect(document.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('searched');
  });

  it('a suggestion with nothing left is not shown', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    expect(search.suggestion).toBeNull();
    expect(screen.queryByRole('region', { name: SUGGESTION_LABEL })).toBeNull();
    expect(document.querySelector('[data-suggestion-print]')).toBeNull();
  });

  it('with nothing added, the suggestion keeps today’s note and its terms, whatever order AI gave', async () => {
    freshApi({ evidence: { ranking: 'er-q-h50-v1', autoFilters: 'state-explicit.v1.2' } });
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    expect([search.automaticFilters, search.query, search.order, search.marks]).toEqual([null, { source: 'question', keywords: { kind: 'question' } }, 'ai_relevance', 'search_words']);
    const suggestion = screen.getByRole('region', { name: SUGGESTION_LABEL });
    expect(suggestion.querySelector('[data-suggestion-note]')?.textContent).toBe(SUGGESTION_NOTE);
    expect(suggestion.textContent).toContain('“carb icing”');
    expect(within(suggestion).getByRole('button', { name: new RegExp(`^${APPLY_BOTH}\\s*·\\s*uses 1$`) })).toBeTruthy();
    // Not the baseline: the marks are the words searched, which are the reader's question here.
    expect(document.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('yours');
    expect(document.querySelector('[data-count-line]')?.textContent).toBe(countLine(search.total, 'ai_relevance'));
    // Nothing AirCase added, so nothing to undo for free.
    expect(yours().querySelector('[data-added-terms], [data-automatic]')).toBeNull();
  });

  it('the drawer, Compare and print say whose words are marked as the sheet does', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const first = search.cases.find((c) => c.excerpts.some((e) => e.highlights.length > 0)) as EvidenceCase;
    expect(first).toBeDefined();
    renderApp(`/ai/${search.id}?case=${first.case.ntsbNo}`);
    const section = await within(await screen.findByRole('dialog', {}, SLOW)).findByRole('region', { name: EVIDENCE_HEADING }, SLOW);
    expect(section.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('searched');
    expect(visibleText(section.querySelector('[data-relevance]') as Element)).toBe(relevanceParts(first.relevance, relevanceContext(search)).join(' · '));
    expect(relevanceContext(search).marked).toBe('searched');
    renderApp(`/compare?cases=${first.case.ntsbNo}&evidence=${search.id}&pages=1`);
    const top = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-compare-evidence]');
      if (!found) throw new Error('not yet');
      return found;
    }, SLOW);
    expect(top.querySelector('[data-legend]')?.getAttribute('data-legend')).toBe('searched');
    // An edit with words of the reader's own marks "your words"; the baseline marks the suggested terms (evidence.test.tsx).
    expect(relevanceContext({ ...search, query: { source: 'edited', terms: 'carb heat' } }).marked).toBe('yours');
    expect(relevanceContext({ ...search, query: { source: 'question', keywords: { kind: 'question' } } }).marked).toBe('yours');
    expect(relevanceContext({ ...search, marks: 'suggested_terms' }).marked).toBe('suggested');
  });

  it('print: the state’s tag, the added terms with their AI tag and the order line print; the controls do not', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const panel = yours();
    expect(hidden(panel)).toBe(false);
    expect(hidden(panel.querySelector('[data-automatic-tag]'))).toBe(false);
    expect(hidden(panel.querySelector('[data-added-terms]'))).toBe(false);
    expect(hidden(panel.querySelector('[data-ai-tag]'))).toBe(false);
    expect(hidden(document.querySelector('[data-count-line]'))).toBe(false);
    expect(hidden(within(panel).getByRole('button', { name: '+ Filter' }))).toBe(true);
    expect(hidden(screen.getByRole('region', { name: SUGGESTION_LABEL }))).toBe(true);
    expect(document.querySelector('[data-suggestion-print]')?.getAttribute('data-print')).toBe('only');
  });

  it('an empty or tiny result sums up what was searched: the state tagged, the added terms said', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const tiny = await openSearch(MOCK_EVIDENCE_QUESTIONS.empty);
    expect(tiny.search.automaticFilters).toEqual({ state: ['AK'] });
    const box = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-few-results-search]');
      if (!found) throw new Error('not yet');
      return found;
    }, SLOW);
    expect(box.textContent).toBe(`Filters: Location: Alaska (${FROM_QUESTION}) · ${QUESTION_AS_ASKED} · ${ALSO_SEARCHED_LABEL} (added by AI): “${(tiny.search.query as { keywords: { terms: string } }).keywords.terms}”`);
    expect(filtersInWords({ state: ['AK'], phase: ['approach'] }, { state: ['AK'] })).toEqual(['Phase: Approach', 'Location: Alaska (from your question)']);
    expect(searchedInWords({ question: 'Q', query: { source: 'question', keywords: { kind: 'terms', terms: 'carb icing' } } })).toEqual([QUESTION_AS_ASKED, `${KEYWORDS_SEARCHED_LABEL} (added by AI): “carb icing”`]);
    expect(searchedInWords({ question: 'Q', query: { source: 'question', keywords: { kind: 'question+terms', terms: 'carb icing' } } })).toEqual([QUESTION_AS_ASKED, 'Also searched (added by AI): “carb icing”']);
    expect(searchedInWords({ question: 'Q', query: { source: 'edited', terms: 'carb heat' } })).toEqual(['Search words: “carb heat”']);
    // Nothing in the state the question names: the empty result says the same.
    cleanup();
    await openSearch('Engine power loss in Vermont');
    const empty = await waitFor(() => {
      const all = [...document.querySelectorAll<HTMLElement>('[data-few-results]')];
      const found = all.find((b) => b.textContent?.includes(EMPTY_TITLE));
      if (!found) throw new Error('not yet');
      return found;
    }, SLOW);
    expect(empty.textContent).toContain(`Filters: Location: Vermont (${FROM_QUESTION}) · ${QUESTION_AS_ASKED} · ${ALSO_SEARCHED_LABEL} (added by AI): “engine power loss”`);
  });
});

describe('Search again is free only for the one undo of what AirCase added (server/evidence/undo.ts)', { timeout: 30_000 }, () => {
  it.each([
    ['the automatic state', () => removeTexas(), { filters: {} }],
    ['the added terms', () => removeTerms(), { filters: { state: ['TX'] }, keywords: 'question' }],
    ['both', () => (removeTexas(), removeTerms()), { filters: {}, keywords: 'question' }],
  ] as const)('removing %s: “Search again · free”, an edit that sends no words; the new search used none of the visitor’s', async (_name, remove, sent) => {
    freshApi({ evidence: STATE_TERMS_AI });
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    await waitFor(() => expect(banner()).toContain('AI searches left: 9 of 10'), SLOW);
    const posts = recordPosts('/api/evidence');
    remove();
    const again = searchAgain('free');
    expect(again.getAttribute('aria-disabled')).toBe('false');
    again.focus();
    fireEvent.click(again);
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ kind: 'edited', from: search.id, ...sent, idempotencyKey: expect.any(String), turnstileToken: TOKEN });
    // The undo: an edit, with nothing AirCase applied on its own; announced, focus on the results.
    const edited = await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    expect(within(edited).queryByRole('button', { name: /added automatically/ })).toBeNull();
    if ('keywords' in sent) expect(edited.querySelector('[data-added-terms]')).toBeNull();
    await waitFor(() => expect(live()).toMatch(/^\d+ investigations? retrieved\.$/), SLOW);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING })));
    expect(document.querySelector('[data-undo-charged]')).toBeNull();
    // It used none of the visitor's searches.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(banner()).toContain('AI searches left: 9 of 10');
  });

  it('two states named together: removing both is free; removing one narrows the search and uses one', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    await openSearch(MOCK_EVIDENCE_QUESTIONS.twoStates);
    const panel = yours();
    fireEvent.click(within(panel).getByRole('button', { name: /^Location: California\s*, added automatically from your question, remove$/ }));
    expect(searchAgain('uses 1')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /^Location: Nevada\s*, added automatically from your question, remove$/ }));
    expect(searchAgain('free')).toBeTruthy();
  });

  it('anything else uses one: a filter added, words of the reader’s own (which replace the added terms), or nothing removed', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const panel = yours();
    expect(within(panel).queryByRole('button', { name: /^Search again/ })).toBeNull();
    // The state removed and a filter added.
    removeTexas();
    expect(document.activeElement?.textContent).toBe('+ Filter');
    fireEvent.click(within(panel).getByRole('button', { name: '+ Filter' }));
    fireEvent.click(within(within(panel).getByRole('group', { name: 'Add a filter' })).getByRole('button', { name: 'Add' }));
    expect(searchAgain('uses 1')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Undo changes' }));
    // Words of the reader's own: the added terms are no longer searched, and the edit uses one.
    fireEvent.click(within(panel).getByRole('button', { name: OWN_WORDS }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Search words' }), { target: { value: 'carb icing' } });
    fireEvent.keyDown(within(panel).getByRole('textbox', { name: 'Search words' }), { key: 'Enter' });
    await within(panel).findByRole('button', { name: /^carb icing\s*, not searched yet, edit the search words$/ });
    expect(panel.querySelector('[data-added-terms]')).toBeNull();
    expect(searchAgain('uses 1')).toBeTruthy();
    // Undo changes brings back the terms and the state, and focus goes back to the words.
    fireEvent.click(within(panel).getByRole('button', { name: 'Undo changes' }));
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole('button', { name: OWN_WORDS })));
    expect(within(panel).getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^Location: Texas\s*, added automatically from your question, remove$/ })).toBeTruthy();
    // Removing the terms moves focus to the words, and Undo restores both again.
    removeTerms();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: OWN_WORDS }));
    removeTexas();
    fireEvent.click(within(panel).getByRole('button', { name: 'Undo changes' }));
    expect(panel.querySelectorAll('[data-added-terms], [data-automatic]')).toHaveLength(2);
  });

  it('once per search: after the free undo, the same search’s next undo uses one, and the undo’s own search has none', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    removeTexas();
    fireEvent.click(searchAgain('free'));
    const edited = await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    // The undo's search kept the added terms (it removed only the state), but it is an edit: no undo of its own.
    fireEvent.click(within(edited).getByRole('button', { name: /^“carb icing”\s*,\s*added by AI\s*,\s*remove$/ }));
    expect(within(edited).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ })).toBeTruthy();
    // Back on the first search: its page says its undo is used now.
    await act(() => router.navigate(`/ai/${search.id}`));
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    removeTerms();
    expect(await within(yours()).findByRole('button', { name: /^Search again\s*·\s*uses 1$/ }, SLOW)).toBeTruthy();
  });

  it('a search whose page says its undo is used, or that it has none, offers no free search', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const parent = await makeSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    expect(parent.undo).toBe('available');
    // Its undo used elsewhere (another tab, before this page was opened).
    const undone = await post({ kind: 'edited', from: parent.id, filters: {} });
    expect(undone.freeUndo).toBe(true);
    renderApp(`/ai/${parent.id}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    removeTexas();
    expect(searchAgain('uses 1')).toBeTruthy();
    // An original question search with nothing added has none: a filter added and removed again is no undo either.
    cleanup();
    freshApi({ evidence: { ranking: 'er-q-v1', autoFilters: 'none' } });
    const plain = await openSearch(MOCK_EVIDENCE_QUESTIONS.carb);
    expect(plain.search.undo).toBe('none');
    expect(yours().querySelector('[data-added-terms], [data-automatic]')).toBeNull();
  });

  it('an edit has no undo of its own, even one that kept the question and its added terms with no filter left (its page says none)', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.seed);
    expect(search.query).toMatchObject({ keywords: { kind: 'question+terms' } });
    // Add a filter (uses one), then take it out again (uses one): the page looks like the question's.
    let panel = yours();
    fireEvent.click(within(panel).getByRole('button', { name: '+ Filter' }));
    fireEvent.click(within(within(panel).getByRole('group', { name: 'Add a filter' })).getByRole('button', { name: 'Add' }));
    fireEvent.click(searchAgain('uses 1'));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    panel = await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    const firstEdit = currentUrl(router);
    fireEvent.click(within(panel).getByRole('button', { name: /^Phase: .+\s*, remove$/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ }));
    await waitFor(() => expect(currentUrl(router)).not.toBe(firstEdit), SLOW);
    // Its page says it has no undo, though it kept the added terms: it is an edit, without an undo of its own.
    await waitFor(() => {
      const shown = screen.getByRole('region', { name: EDITED_LABEL });
      expect(within(shown).queryAllByRole('button', { name: /, remove$/ }).map((b) => b.getAttribute('data-added-terms'))).toEqual(['question+terms']);
    }, SLOW);
    panel = screen.getByRole('region', { name: EDITED_LABEL });
    fireEvent.click(within(panel).getByRole('button', { name: /added by AI\s*,\s*remove$/ }));
    expect(within(panel).getByRole('button', { name: /^Search again\s*·\s*uses 1$/ })).toBeTruthy();
  });

  it('the server’s word stands: an undo shown as free that it counted says it used one, on the search it made and aloud', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    installTurnstile();
    const { router, search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    // Its free undo used elsewhere (another tab), so this tab does not know.
    expect((await post({ kind: 'edited', from: search.id, filters: {} })).freeUndo).toBe(true);
    removeTexas();
    fireEvent.click(searchAgain('free'));
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    const note = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-undo-charged]');
      if (!found) throw new Error('not yet');
      return found;
    }, SLOW);
    expect(note.textContent).toBe(UNDO_CHARGED);
    expect(hidden(note)).toBe(true);
    await waitFor(() => expect(live()).toMatch(new RegExp(`^\\d+ investigations? retrieved\\. ${UNDO_CHARGED}$`)), SLOW);
    // Back on the first search, read again: its undo is no longer offered as free.
    await act(() => router.navigate(`/ai/${search.id}`));
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    removeTerms();
    expect(await within(yours()).findByRole('button', { name: /^Search again\s*·\s*uses 1$/ }, SLOW)).toBeTruthy();
  });

  it('with no searches left the free undo still runs, with the usual check, and charged actions stay off', async () => {
    freshApi({ evidence: STATE_TERMS_AI, aiStatus: AI_STATUS_SAMPLES.oneLeft });
    const turnstile = installTurnstile();
    const posts = recordPosts('/api/evidence');
    // The last search of the day.
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const { router } = renderApp(`/ai/${search.id}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    await waitFor(() => expect(banner()).toContain('Free AI searches used'), SLOW);
    // A charged action: off, with the counter's words.
    const apply = within(screen.getByRole('region', { name: SUGGESTION_LABEL })).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}`) });
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    removeTexas();
    const again = searchAgain('free');
    expect(again.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(again);
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(turnstile.renders).toBe(1);
    expect(posts.at(-1)).toMatchObject({ kind: 'edited', from: search.id, filters: {}, turnstileToken: TOKEN });
    await screen.findByRole('region', { name: EDITED_LABEL }, SLOW);
    expect(document.querySelector('[data-undo-charged]')).toBeNull();
    // Anything else still uses one, and is still off.
    removeTerms(yours(true));
    expect(within(yours(true)).getByRole('button', { name: /^Search again/ }).getAttribute('aria-disabled')).toBe('true');
  });

  it('an account at its daily limit: the free undo runs; Apply waits for tomorrow', async () => {
    window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
    const capped: AiStatusResponse = { state: 'paused', reason: 'daily_cap', retryAt: '2026-10-26T00:00:00.000Z', remaining: { kind: 'account', leftToday: 0, limitToday: 50, leftThisMonth: 500, limitThisMonth: 600 } };
    freshApi({ evidence: STATE_TERMS_AI, googleEnabled: true });
    const search = await makeSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    server.use(http.get('*/api/ai/status', () => HttpResponse.json(capped)));
    const posts = recordPosts('/api/evidence');
    const { router } = renderApp(`/ai/${search.id}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    const apply = within(screen.getByRole('region', { name: SUGGESTION_LABEL })).getByRole('button', { name: new RegExp(`^${APPLY_FILTERS}`) });
    await waitFor(() => expect(apply.getAttribute('aria-disabled')).toBe('true'), SLOW);
    removeTerms();
    const again = searchAgain('free');
    expect(again.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(again);
    await waitFor(() => expect(currentUrl(router)).not.toBe(`/ai/${search.id}`), SLOW);
    expect(posts.at(-1)).toMatchObject({ kind: 'edited', from: search.id, filters: { state: ['TX'] }, keywords: 'question' });
  });

  it('a failed free undo offers “Try again · free”; a search that expired while open shows the expired state', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    installTurnstile();
    const { search } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    server.use(http.post('*/api/evidence', () => HttpResponse.json({ error: 'unavailable', message: 'The service is temporarily unavailable. Try again shortly.' }, { status: 503 })));
    removeTexas();
    fireEvent.click(searchAgain('free'));
    expect(await screen.findByText("AirCase couldn't finish this AI search.", {}, SLOW)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Try again\s*·\s*free$/ })).toBeTruthy();
    // An old link: the search is gone by now.
    server.use(
      http.post('*/api/evidence', () => HttpResponse.json({ error: 'not_found', message: 'No AI search with that link is available.' }, { status: 404 })),
      http.get(`*/api/evidence/${search.id}`, () => HttpResponse.json({ error: 'not_found', message: 'No AI search with that link is available.' }, { status: 404 })),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Try again\s*·\s*free$/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'This AI search is no longer available.' }, SLOW)).toBeTruthy();
  });

  it('“Your edited search” from what the page says: words, an undo, filters of the reader’s, or added terms without an undo', () => {
    const question = { source: 'question', keywords: { kind: 'question' } } as const;
    const added = { source: 'question', keywords: { kind: 'question+terms', terms: 'carb icing' } } as const;
    const page = { query: question, appliedFilters: {}, automaticFilters: null, freeUndo: false, undo: 'none' } as const;
    // Original question searches: nothing added, or something added (whose undo is there or used).
    expect(isEditedSearch(page)).toBe(false);
    expect(isEditedSearch({ ...page, appliedFilters: { state: ['TX'] }, automaticFilters: { state: ['TX'] }, undo: 'available' })).toBe(false);
    expect(isEditedSearch({ ...page, query: added, undo: 'used' })).toBe(false);
    // Edits.
    expect(isEditedSearch({ ...page, query: { source: 'edited', terms: 'carb heat' } })).toBe(true);
    expect(isEditedSearch({ ...page, freeUndo: true })).toBe(true);
    expect(isEditedSearch({ ...page, appliedFilters: { phase: ['approach'] } })).toBe(true);
    expect(isEditedSearch({ ...page, query: added })).toBe(true);
  });

  it('the retry key of an undo is its own: restoring the question’s keywords is another request than keeping them', async () => {
    const from = '00000000-0000-4000-9000-000000000001';
    const filters: BriefFilters = { state: ['TX'] };
    expect(await unsettledId({ kind: 'evidence-edited', from, filters, keywords: 'question' })).not.toBe(await unsettledId({ kind: 'evidence-edited', from, filters }));
    expect(await unsettledId({ kind: 'evidence-edited', from, filters, keywords: 'question' })).toBe(await unsettledId({ kind: 'evidence-edited', from, filters: { state: ['TX'] }, keywords: 'question' }));
  });
});

describe('a v3 result surface still shows NTSB text, coded data, fixed copy and the words searched only (gate G6)', { timeout: 20_000 }, () => {
  function texts(root: Element): string[] {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = (node.textContent ?? '').trim();
      if (t) out.push(t);
    }
    return out;
  }

  it('every text node of the results comes from the page’s NTSB fields, coded data or fixed copy', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const { search: page } = await openSearch(MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const parts: string[] = [EVIDENCE_HEADING, EVIDENCE_NOTICE, EVIDENCE_BOUNDARY, countLine(page.total, page.order), showingLine(page.cases.length, page.total), allShownLine(page.total)];
    parts.push(showMoreLabel(page.cases.length, page.total, 10), '(free)', 'Marked in the excerpts:', LEGEND.searched, LEGEND.synonym, '; dotted:', '·');
    for (const c of page.cases) {
      const row = c.case;
      parts.push(row.ntsbNo, formatDate(row.date), aircraftSummary(row), placeShort(row.city, row.state, row.country), ...rowMonoParts(row).map((p) => p.text));
      row.aircraft.forEach((a, i) => parts.push(letterOf(row.ntsbNo, a, i), aircraftName(a), phaseEventShort(a)));
      parts.push('Compare', ',', 'How it was found:', relevanceParts(c.relevance, relevanceContext(page), c.excerpts.length > 0).join(' · '));
      c.probableCauses.forEach((p, i) => parts.push(probableCauseLabel(row.ntsbNo, row.aircraft, p, i, c.probableCauses.length), p.text));
      const shown = foldProbableCauses(c.probableCauses.map((p) => ({ key: p.sectionKey, text: p.text })), c.excerpts).shown;
      const numbered = numberedKinds(shown);
      for (const [i, e] of shown.entries()) {
        parts.push(excerptLabel(row.ntsbNo, row.aircraft, e, numbered.has(e.section)), e.text, fullSectionLabel(e), '(synonym)');
        if (shown.length > 1) parts.push(`, excerpt ${i + 1} of ${shown.length}`);
        if (e.text.length > LONG_TEXT_CHARS) parts.push(`Show the whole paragraph (${e.text.trim().split(/\s+/).length.toLocaleString('en-US')} words)`);
      }
      parts.push(c.report.kind === 'report' ? 'NTSB report ↗' : `${c.report.note} ·`, 'Search NTSB ↗', `(a search page, not the report; look up ${row.ntsbNo})`);
    }
    parts.push(`Only you can open this search.`);
    const corpus = parts.join('\n');
    const results = screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING }).closest('section') as HTMLElement;
    const strays = texts(results).filter((t) => !corpus.includes(t) && !t.startsWith('Only you can open this search.'));
    expect(strays).toEqual([]);
  });
});

describe('the AI nudge on Explore follows the server’s automatic-filter policy (`aiAutomaticFilters`)', { timeout: 20_000 }, () => {
  /** The nudge under Explore's results, once they are there. */
  async function nudgeWith(text: string): Promise<HTMLElement> {
    renderApp('/explore?q=carburetor+icing&phase=approach');
    return (await screen.findByText(text, { exact: false }, SLOW)).closest('div') as HTMLElement;
  }

  it('none applied on their own: the AI only suggests filters', async () => {
    freshApi();
    const nudge = await nudgeWith(AI_NUDGE);
    expect(nudge.textContent).toContain(`${AI_NUDGE} ${AI_NUDGE_FILTERS}`);
    expect(document.body.textContent).not.toContain(AI_NUDGE_STATE);
  });

  it('states applied: a US state the question names explicitly is applied and can be removed; the rest stays a suggestion', async () => {
    freshApi({ evidence: STATE_TERMS_AI });
    const nudge = await nudgeWith(AI_NUDGE_STATE);
    expect(nudge.textContent).toContain(`${AI_NUDGE_STATE} ${AI_NUDGE_FILTERS}`);
    expect(document.body.textContent).not.toContain(AI_NUDGE);
  });

  it('the configuration decides, and while it is unknown the nudge claims nothing applied', async () => {
    freshApi({ evidence: STATE_TERMS_AI, aiAutomaticFilters: [] });
    await nudgeWith(AI_NUDGE);
    expect(document.body.textContent).not.toContain(AI_NUDGE_STATE);
    expect([aiNudge(undefined), aiNudge([]), aiNudge(['state'])]).toEqual([AI_NUDGE, AI_NUDGE, AI_NUDGE_STATE]);
  });
});
