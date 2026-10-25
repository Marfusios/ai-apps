/**
 * The mock evidence searches (web/mock/evidence.ts) that the component and end-to-end tests of
 * the evidence view read: every page and response they can produce, in every configuration the
 * mock stands in for, is valid under the contract (`evidence.v3`), every excerpt is a verbatim
 * slice of its fixture section at its paragraph span, an unapplied suggestion never changes what
 * is retrieved, what each configuration applies on its own is disclosed as the server discloses
 * it, the one free undo follows the server's rule, and between them the samples cover every state
 * the interface shows.
 */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { CreateEvidenceResponseSchema, EVIDENCE_PAGE_SIZE, EVIDENCE_TTL_MS, EvidencePageSchema, type EvidenceCase, type EvidencePage } from '../../shared/contracts/evidence.js';
import { isNarrativeHeading, wholeNarrativeParagraphs } from '../../shared/narrative-paragraphs.js';
import casesJson from '../../web/mock/cases.json' with { type: 'json' };
import {
  MOCK_EVIDENCE_BASELINE,
  MOCK_EVIDENCE_QUESTIONS,
  MOCK_EVIDENCE_RELEASE,
  MockEvidence,
  aiOrder,
  evidenceCases,
  parseMockEvidenceConfig,
  questionWords,
  type MockEvidenceConfig,
} from '../../web/mock/evidence.js';

const CASES = casesJson as unknown as Record<string, CaseDetail>;
const KEY = (n: number): string => `evidence-key-${String(n).padStart(4, '0')}`;

/** Every case of a search, read page by page through the mock server. */
function readAll(server: MockEvidence, first: EvidencePage): EvidenceCase[] {
  const cases = [...first.cases];
  for (let n = 2; n <= first.pages; n++) {
    const reply = server.read(first.id, n);
    expect(reply.status).toBe(200);
    const page = EvidencePageSchema.parse(reply.body);
    expect(page.page).toBe(n);
    cases.push(...page.cases);
  }
  return cases;
}

function ask(server: MockEvidence, question: string, n = 1) {
  const reply = server.create({ kind: 'question', question, idempotencyKey: KEY(n), turnstileToken: 'token' });
  return { reply, body: CreateEvidenceResponseSchema.parse(reply.body) };
}

function results(server: MockEvidence, question: string, n = 1): EvidencePage {
  const { body } = ask(server, question, n);
  if (body.kind !== 'results') throw new Error(`expected results for ${question}`);
  return body.search;
}

/** An edited search of `from`: exactly `filters`, and `terms` when given. */
function edit(server: MockEvidence, from: EvidencePage, filters: BriefFilters, terms: string | null | undefined, n: number): EvidencePage {
  const reply = server.create({ kind: 'edited', from: from.id, filters, ...(terms !== undefined && terms !== null ? { terms } : {}), idempotencyKey: KEY(n), turnstileToken: 'token' });
  expect(reply.status).toBe(201);
  const body = CreateEvidenceResponseSchema.parse(reply.body);
  if (body.kind !== 'results') throw new Error('expected results');
  return body.search;
}

/**
 * An edit of `from` that sends `filters` and, with `restore`, the question's own keywords (when
 * `from` added terms to keyword search): the reply and its page.
 */
function undoReply(server: MockEvidence, from: EvidencePage, filters: BriefFilters, restore: boolean, n: number) {
  const added = from.query.source === 'question' && from.query.keywords.kind !== 'question';
  const body = { kind: 'edited', from: from.id, filters, ...(restore && added ? { keywords: 'question' as const } : {}), idempotencyKey: KEY(n), turnstileToken: 'token' } as const;
  const exempt = server.quotaExempt(body);
  const reply = server.create(body);
  expect(reply.status).toBe(201);
  const answer = CreateEvidenceResponseSchema.parse(reply.body);
  return { reply, exempt, search: answer.search };
}

function undo(server: MockEvidence, from: EvidencePage, filters: BriefFilters, restore: boolean, n: number): EvidencePage {
  return undoReply(server, from, filters, restore, n).search;
}

/** The configurations the tests use: the server's defaults, what live runs, and the others the evaluation may pick. */
const CONFIGS: Record<string, MockEvidenceConfig> = {
  baseline: MOCK_EVIDENCE_BASELINE,
  release: MOCK_EVIDENCE_RELEASE,
  questionTermsAiOrderState: { ranking: 'er-qt-h50-v1', autoFilters: 'state-explicit.v1.3' },
  termsState: { ranking: 'er-t-v1', autoFilters: 'state-explicit.v1.3' },
  questionAiOrder: { ranking: 'er-q-h100-v1', autoFilters: 'none' },
};

/** Where each case's excerpts are: what retrieval chose, whatever words they mark. */
const placement = (cases: readonly EvidenceCase[]) => cases.map((c) => [c.rank, c.case.ntsbNo, c.excerpts.map((e) => `${e.sectionKey}@${e.paragraph.start}`)]);

describe('mock evidence pages are valid evidence.v3 and NTSB text only', () => {
  // Nothing blocks a search: every sample question gets results, in every configuration.
  const searches = Object.entries(CONFIGS).flatMap(([config, c]) => Object.entries(MOCK_EVIDENCE_QUESTIONS).map(([name, question]) => [`${config}, ${name}`, question, c] as const));

  it.each(searches)('%s: every page validates, and every excerpt is the section text at its paragraph span', (_name, question, config) => {
    const server = new MockEvidence({ config });
    const first = results(server, question);
    // With its suggestion applied too, filters and words (the edited pages the interface makes),
    // and with what AirCase added taken out again.
    const applied = first.suggestion ? [edit(server, first, first.suggestion.filters, undefined, 2), edit(server, first, first.suggestion.filters, first.suggestion.terms, 3)] : [];
    const undone = first.automaticFilters || (first.query.source === 'question' && first.query.keywords.kind !== 'question') ? [undo(server, first, {}, true, 4)] : [];
    for (const page of [first, ...applied, ...undone]) {
      for (const c of readAll(server, page)) {
        const detail = CASES[c.case.ntsbNo] as CaseDetail;
        expect(detail, c.case.ntsbNo).toBeDefined();
        // Every probable-cause statement of the case, verbatim, in section order.
        expect(c.probableCauses.map((p) => p.text)).toEqual(detail.sections.filter((s) => s.kind === 'probable_cause').map((s) => s.text));
        // As on the server, the relevance facts list only the marked words that occur in the excerpts.
        expect(c.relevance.terms.every((t) => t.literal + t.synonym > 0)).toBe(true);
        if (c.excerpts.length === 0) expect(c.relevance.terms).toEqual([]);
        for (const e of c.excerpts) {
          const section = detail.sections.find((s) => s.key === e.sectionKey);
          expect(section?.revision).toBe(e.revision);
          expect(section?.text.slice(e.paragraph.start, e.paragraph.end)).toBe(e.text);
          expect(e.seed.end).toBeLessThanOrEqual(section?.text.length ?? 0);
          // A whole paragraph, as the server cuts them (hard wraps joined, a heading kept with what follows).
          expect(wholeNarrativeParagraphs(section?.text ?? '')).toContainEqual({ start: e.paragraph.start, end: e.paragraph.end });
        }
      }
    }
  });

  it('the samples cover the states the interface shows', () => {
    const server = new MockEvidence();
    let key = 500;
    const all = (q: string): EvidenceCase[] => readAll(server, results(server, q, (key += 1)));
    // Several pages of one pinned ranking; a question search applies no filter.
    const seed = results(server, MOCK_EVIDENCE_QUESTIONS.seed, 101);
    expect(seed.pages).toBeGreaterThanOrEqual(3);
    expect(seed.cases).toHaveLength(EVIDENCE_PAGE_SIZE);
    expect([seed.query, seed.appliedFilters, seed.hint, seed.note]).toEqual([{ source: 'question', keywords: { kind: 'question' } }, {}, null, null]);
    // The baseline: nothing applied on its own, so nothing to undo; the match order, the suggested terms marked.
    expect([seed.automaticFilters, seed.order, seed.marks, seed.freeUndo, seed.undo]).toEqual([null, 'match', 'suggested_terms', false, 'none']);
    // A suggestion of filters and words, not applied: the question's results are every case of the cohort.
    const carb = results(server, MOCK_EVIDENCE_QUESTIONS.carb, 102);
    expect(carb.suggestion).toEqual({ filters: { phase: ['approach'] }, terms: 'carb icing' });
    expect(carb.total).toBe(seed.total);
    // Multi-aircraft events, their text event-scoped.
    const midair = all(MOCK_EVIDENCE_QUESTIONS.midair).filter((c) => c.case.aircraft.length > 1);
    expect(midair.length).toBeGreaterThanOrEqual(2);
    expect(midair.flatMap((c) => c.excerpts).every((e) => e.scope === 'event' && e.aircraftKey === null)).toBe(true);
    // The suggested words marked, literal and synonym ("carburetor" for "carb"); a literal is the word itself, never a stem.
    const carbExcerpts = all(MOCK_EVIDENCE_QUESTIONS.carb).flatMap((c) => c.excerpts);
    const marked = (match: 'literal' | 'synonym') => carbExcerpts.flatMap((e) => e.highlights.filter((h) => h.match === match).map((h) => e.text.slice(h.start, h.end).toLowerCase()));
    expect(marked('synonym')).toContain('carburetor');
    expect(marked('literal')).toContain('icing');
    expect(marked('literal').every((w) => w === 'carb' || w === 'icing')).toBe(true);
    // As on the server, a probable-cause statement is a passage too: a paragraph of it can be an
    // excerpt, beside the statement the card shows verbatim.
    const carbCases = all(MOCK_EVIDENCE_QUESTIONS.carb);
    const causeExcerpt = carbCases.find((c) => c.excerpts.some((e) => e.section === 'probable_cause'));
    expect(causeExcerpt).toBeDefined();
    const quoted = causeExcerpt?.excerpts.find((e) => e.section === 'probable_cause');
    expect(causeExcerpt?.probableCauses.find((p) => p.sectionKey === quoted?.sectionKey)?.text.slice(quoted?.paragraph.start, quoted?.paragraph.end)).toBe(quoted?.text);
    // A paragraph that keeps its heading line (and so a line break), as real narratives have.
    const headed = all(MOCK_EVIDENCE_QUESTIONS.seed)
      .flatMap((c) => c.excerpts)
      .find((e) => e.text.includes('\n') && isNarrativeHeading(e.text.split('\n')[0] ?? ''));
    expect(headed).toBeDefined();
    // A highlight after multi-byte characters: the offsets are UTF-16 code units.
    const multibyte = all(MOCK_EVIDENCE_QUESTIONS.multibyte).flatMap((c) => c.excerpts);
    const after = multibyte.find((e) => {
      const at = e.text.search(/[^\x00-\x7f]/);
      return at >= 0 && e.highlights.some((h) => h.start > at);
    });
    expect(after).toBeDefined();
    // Suggested filters that leave two cases, and none, once applied.
    const tiny = results(server, MOCK_EVIDENCE_QUESTIONS.tiny, 201);
    expect(tiny.suggestion?.filters).toEqual({ category: ['HELI'], state: ['TX'] });
    expect(edit(server, tiny, tiny.suggestion?.filters ?? {}, undefined, 202).total).toBe(2);
    const empty = results(server, MOCK_EVIDENCE_QUESTIONS.empty, 203);
    const none = edit(server, empty, empty.suggestion?.filters ?? {}, undefined, 204);
    expect([none.total, none.pages, none.cases.length]).toEqual([0, 0, 0]);
    // A failed scope stage: the question's results, no suggestion.
    const failed = results(server, MOCK_EVIDENCE_QUESTIONS.noSuggestion, 205);
    expect([failed.suggestion, failed.hint]).toEqual([null, null]);
    expect(failed.total).toBeGreaterThan(0);
    // Hints, with results: an explicit counting request (with the applied filters: none), an
    // explicit comparison request; a case number alone is neither.
    const statistics = results(server, MOCK_EVIDENCE_QUESTIONS.statistics, 206);
    expect(statistics.hint).toEqual({ kind: 'corpus_statistics' });
    expect(statistics.total).toBeGreaterThan(0);
    const comparison = results(server, MOCK_EVIDENCE_QUESTIONS.comparison, 207);
    expect(comparison.hint).toEqual({ kind: 'case_comparison', found: ['DFW08TA066', 'NYC08LA106'], notFound: ['ZZZ99ZZ999'] });
    expect(comparison.total).toBeGreaterThan(0);
    expect(results(server, MOCK_EVIDENCE_QUESTIONS.single, 208).hint).toBeNull();
    // Cases found by similarity alone keep one excerpt, or none when no passage maps (a
    // multi-aircraft event here): the case stays, with its facts and probable causes.
    const similarityOnly = all(MOCK_EVIDENCE_QUESTIONS.midair).filter((c) => c.relevance.channels.join() === 'similarity');
    expect(similarityOnly.filter((c) => c.case.aircraft.length === 1).every((c) => c.excerpts.length === 1)).toBe(true);
    const bare = similarityOnly.find((c) => c.excerpts.length === 0);
    expect(bare?.case.aircraft.length).toBeGreaterThan(1);
    expect(bare?.probableCauses.length).toBeGreaterThan(0);
  });

  it('nothing blocks a search: a question about something else, or asking for advice, gets its results and a fixed note', () => {
    const server = new MockEvidence();
    const notes = (['outOfScope', 'operational', 'statistics', 'comparison', 'carb'] as const).map((name, i) => {
      const page = results(server, MOCK_EVIDENCE_QUESTIONS[name], 300 + i);
      expect(ask(server, MOCK_EVIDENCE_QUESTIONS[name], 300 + i).reply.status).toBe(201);
      expect(page.total).toBeGreaterThan(0);
      return page.note;
    });
    expect(notes).toEqual(['scope', 'operational_advice', null, null, null]);
    // A note comes with no suggestion, and an edit carries no note.
    const operational = results(server, MOCK_EVIDENCE_QUESTIONS.operational, 320);
    expect(operational.suggestion).toBeNull();
    expect(edit(server, operational, {}, 'engine rough running', 321).note).toBeNull();
  });
});

describe('the suggestion is advisory only', () => {
  it('retrieval, ranking, cohort and excerpt choice come from the question, whatever the suggestion is', () => {
    const server = new MockEvidence();
    for (const [i, question] of [MOCK_EVIDENCE_QUESTIONS.carb, MOCK_EVIDENCE_QUESTIONS.tiny, MOCK_EVIDENCE_QUESTIONS.statistics].entries()) {
      const page = results(server, question, 600 + i);
      const cases = readAll(server, page);
      // The same ranking and excerpts as with no suggestion at all, or any other suggested words.
      expect(placement(cases)).toEqual(placement(evidenceCases({}, questionWords(question))));
      expect(placement(cases)).toEqual(placement(evidenceCases({}, questionWords(question), 'unrelated words entirely')));
      // No filter applied: the relevance facts name none.
      expect(cases.every((c) => c.relevance.filters.length === 0)).toBe(true);
      // The marks and counts are the suggested words'.
      const suggested = new Set((page.suggestion?.terms ?? '').split(' '));
      expect(cases.flatMap((c) => c.relevance.terms.map((t) => t.term)).every((t) => suggested.has(t))).toBe(true);
    }
  });

  it('applying the suggested filters keeps the question as the query; words are taken only when sent', () => {
    const server = new MockEvidence();
    const carb = results(server, MOCK_EVIDENCE_QUESTIONS.carb, 1);
    const filtersOnly = edit(server, carb, { phase: ['approach'] }, undefined, 2);
    expect([filtersOnly.question, filtersOnly.query, filtersOnly.appliedFilters, filtersOnly.suggestion, filtersOnly.hint]).toEqual([
      carb.question,
      { source: 'question', keywords: { kind: 'question' } },
      { phase: ['approach'] },
      null,
      null,
    ]);
    // An edit has no suggestion, so it marks its own words; it applies nothing on its own, is no undo and has none.
    expect([filtersOnly.marks, filtersOnly.automaticFilters, filtersOnly.freeUndo, filtersOnly.undo]).toEqual(['search_words', null, false, 'none']);
    // Ranked by the question's words within the filter, the excerpts marking them.
    expect(placement(readAll(server, filtersOnly))).toEqual(placement(evidenceCases({ phase: ['approach'] }, questionWords(carb.question))));
    expect(filtersOnly.cases.every((c) => c.relevance.filters.join() === 'phase')).toBe(true);
    const withWords = edit(server, carb, { phase: ['approach'] }, 'carb icing', 3);
    expect(withWords.query).toEqual({ source: 'edited', terms: 'carb icing' });
    // A filter cleared stays cleared, and the edited words carry on when none are sent.
    const cleared = edit(server, withWords, {}, undefined, 4);
    expect([cleared.query, cleared.appliedFilters]).toEqual([{ source: 'edited', terms: 'carb icing' }, {}]);
    expect(cleared.total).toBeGreaterThan(withWords.total);
  });
});

describe('the mock evidence server', () => {
  it('pages read the pinned ranking: free, in rank order, never past the last page', () => {
    const server = new MockEvidence();
    const first = results(server, MOCK_EVIDENCE_QUESTIONS.seed);
    const cases = readAll(server, first);
    expect(cases.map((c) => c.rank)).toEqual(cases.map((_c, i) => i + 1));
    expect(new Set(cases.map((c) => c.case.ntsbNo)).size).toBe(first.total);
    expect(server.read(first.id, first.pages + 1).status).toBe(404);
  });

  it('a key replays its search; the same key for another request is a conflict', () => {
    const server = new MockEvidence();
    const first = results(server, MOCK_EVIDENCE_QUESTIONS.seed, 7);
    const again = server.create({ kind: 'question', question: MOCK_EVIDENCE_QUESTIONS.seed, idempotencyKey: KEY(7), turnstileToken: 'token' });
    expect(again.replayed).toBe(true);
    expect((again.body as { search: EvidencePage }).search.id).toBe(first.id);
    expect(server.create({ kind: 'question', question: 'Another question', idempotencyKey: KEY(7), turnstileToken: 'token' }).status).toBe(409);
    // An edit with words and one without are different requests.
    edit(server, first, {}, 'engine', 8);
    expect(server.create({ kind: 'edited', from: first.id, filters: {}, idempotencyKey: KEY(8), turnstileToken: 'token' }).status).toBe(409);
  });

  it('a search is read only by its owner until it expires; signing in from it moves it to the account', () => {
    let visitor: 'trial' | 'account' = 'trial';
    let now = new Date('2026-10-24T10:00:00.000Z');
    const server = new MockEvidence({ visitor: () => visitor, now: () => now });
    const search = results(server, MOCK_EVIDENCE_QUESTIONS.seed);
    expect(search.createdAt).toBe('2026-10-24T10:00:00.000Z');
    expect(search.expiresAt).toBe('2026-10-25T10:00:00.000Z');
    visitor = 'account';
    expect(server.read(search.id, 1).status).toBe(404);
    server.handOver(search.id);
    expect(server.read(search.id, 1).status).toBe(200);
    visitor = 'trial';
    expect(server.read(search.id, 1).status).toBe(404);
    visitor = 'account';
    now = new Date(now.getTime() + EVIDENCE_TTL_MS);
    expect(server.read(search.id, 1).status).toBe(404);
  });

  it('the full case of a ranked case comes from the search, for its owner only (GET /api/evidence/:id/cases/:ntsbNo)', () => {
    let visitor: 'trial' | 'account' = 'trial';
    const server = new MockEvidence({ visitor: () => visitor });
    const question = results(server, MOCK_EVIDENCE_QUESTIONS.tiny);
    const search = edit(server, question, question.suggestion?.filters ?? {}, undefined, 2);
    const ranked = search.cases[0]?.case.ntsbNo as string;
    const reply = server.caseOf(search.id, ranked);
    expect(reply.status).toBe(200);
    const detail = reply.body as CaseDetail;
    // Its sections are the revisions the excerpts name.
    for (const e of search.cases[0]?.excerpts ?? []) expect(detail.sections.find((s) => s.key === e.sectionKey)?.revision).toBe(e.revision);
    // A case the search did not rank, or another visitor, gets nothing.
    expect(server.caseOf(search.id, 'NYC08LA106').status).toBe(404);
    visitor = 'account';
    expect(server.caseOf(search.id, ranked).status).toBe(404);
  });

  it('"expire" makes a search whose reads are gone; failures play once per question', () => {
    const server = new MockEvidence();
    const gone = results(server, 'Engine power loss, expired already');
    expect(server.read(gone.id, 1).status).toBe(404);
    const first = server.create({ kind: 'question', question: 'Power loss, unavailable', idempotencyKey: KEY(9), turnstileToken: 'token' });
    expect(first.status).toBe(503);
    expect(server.create({ kind: 'question', question: 'Power loss, unavailable', idempotencyKey: KEY(9), turnstileToken: 'token' }).status).toBe(409);
    expect(server.create({ kind: 'question', question: 'Power loss, unavailable', idempotencyKey: KEY(10), turnstileToken: 'token' }).status).toBe(201);
    const lost = server.create({ kind: 'question', question: 'Power loss, lost response', idempotencyKey: KEY(11), turnstileToken: 'token' });
    expect(lost.lost).toBe(true);
    const replay = server.create({ kind: 'question', question: 'Power loss, lost response', idempotencyKey: KEY(11), turnstileToken: 'token' });
    expect([replay.status, replay.replayed]).toEqual([201, true]);
  });
});

describe('every configuration says what it applied on its own (evidence.v3)', () => {
  it('the baseline searches the question alone, in match order, and marks the suggested terms while there are some', () => {
    const server = new MockEvidence();
    const carb = results(server, MOCK_EVIDENCE_QUESTIONS.carb);
    expect(carb.query).toEqual({ source: 'question', keywords: { kind: 'question' } });
    expect([carb.automaticFilters, carb.order, carb.marks, carb.freeUndo]).toEqual([null, 'match', 'suggested_terms', false]);
    // A named state is only suggested: nothing is applied without the guarded policy.
    const texas = results(server, MOCK_EVIDENCE_QUESTIONS.stateTerms, 2);
    expect([texas.automaticFilters, texas.appliedFilters]).toEqual([null, {}]);
    expect(texas.suggestion).toEqual({ filters: { phase: ['approach'], state: ['TX'] }, terms: 'carb icing' });
    // No suggestion: the question's own words are marked.
    expect(results(server, MOCK_EVIDENCE_QUESTIONS.noSuggestion, 3).marks).toBe('search_words');
  });

  it('a state the question names is applied by the guarded policy, searched with the added terms, in AI order; what was used is not suggested again', () => {
    const server = new MockEvidence({ config: CONFIGS.questionTermsAiOrderState });
    const page = results(server, MOCK_EVIDENCE_QUESTIONS.stateTerms);
    expect(page.automaticFilters).toEqual({ state: ['TX'] });
    expect(page.appliedFilters).toEqual({ state: ['TX'] });
    expect(page.query).toEqual({ source: 'question', keywords: { kind: 'question+terms', terms: 'carb icing' } });
    expect([page.order, page.marks, page.freeUndo, page.undo]).toEqual(['ai_relevance', 'search_words', false, 'available']);
    // The phase stays a suggestion; the state and the terms were used, so they are not suggested.
    expect(page.suggestion).toEqual({ filters: { phase: ['approach'] }, terms: null });
    // Every case meets the state, and its relevance facts say so.
    const cases = readAll(server, page);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.case.state?.code === 'TX' && c.relevance.filters.includes('state'))).toBe(true);
    // Two states named together are applied as one filter, either state.
    const two = results(server, MOCK_EVIDENCE_QUESTIONS.twoStates, 2);
    expect(two.automaticFilters).toEqual({ state: ['CA', 'NV'] });
    expect(readAll(server, two).every((c) => ['CA', 'NV'].includes(c.case.state?.code ?? ''))).toBe(true);
    // A suggestion with nothing left is no suggestion.
    expect(results(server, MOCK_EVIDENCE_QUESTIONS.seed, 3).suggestion).toBeNull();
  });

  it('terms instead of the question in keyword search, and a guard that abstains', () => {
    const server = new MockEvidence({ config: CONFIGS.termsState });
    const carb = results(server, MOCK_EVIDENCE_QUESTIONS.carb);
    expect(carb.query).toEqual({ source: 'question', keywords: { kind: 'terms', terms: 'carb icing' } });
    expect([carb.automaticFilters, carb.order, carb.marks]).toEqual([null, 'match', 'search_words']);
    expect(carb.suggestion).toEqual({ filters: { phase: ['approach'] }, terms: null });
    // "Georgia" alone is ambiguous (the server's guard): suggested, never applied.
    const georgia = results(server, 'Engine failure in Georgia', 2);
    expect(georgia.automaticFilters).toBeNull();
    expect(georgia.suggestion?.filters.state).toEqual(['GA']);
  });

  it('AI order reorders only the leading cases, by a fixed stand-in for the grades, and keeps every case', () => {
    const server = new MockEvidence({ config: CONFIGS.questionAiOrder });
    const page = results(server, MOCK_EVIDENCE_QUESTIONS.seed);
    expect(page.order).toBe('ai_relevance');
    const ai = readAll(server, page);
    const match = evidenceCases({}, questionWords(MOCK_EVIDENCE_QUESTIONS.seed), MOCK_EVIDENCE_QUESTIONS.seed);
    expect(ai.map((c) => c.rank)).toEqual(ai.map((_c, i) => i + 1));
    expect(new Set(ai.map((c) => c.case.ntsbNo))).toEqual(new Set(match.map((c) => c.case.ntsbNo)));
    expect(ai.map((c) => c.case.ntsbNo)).not.toEqual(match.map((c) => c.case.ntsbNo));
    // Past the depth the match order stands.
    const deep = aiOrder(match, 'engine', 5);
    expect(deep.slice(5).map((c) => c.case.ntsbNo)).toEqual(match.slice(5).map((c) => c.case.ntsbNo));
    // Nothing to grade: the match order.
    expect(results(server, 'Engine power loss, nothing found', 2).order).toBe('match');
    // An edit is ordered by AI too.
    expect(edit(server, page, { phase: ['approach'] }, undefined, 3).order).toBe('ai_relevance');
  });

  it('session storage names a configuration as JSON; anything else is the baseline', () => {
    expect(parseMockEvidenceConfig(JSON.stringify(CONFIGS.questionTermsAiOrderState))).toEqual(CONFIGS.questionTermsAiOrderState);
    expect(parseMockEvidenceConfig(null)).toEqual(MOCK_EVIDENCE_BASELINE);
    expect(parseMockEvidenceConfig('{"ranking":"er-x","autoFilters":"state-explicit.v1"}')).toEqual(MOCK_EVIDENCE_BASELINE);
    expect(parseMockEvidenceConfig('not json')).toEqual(MOCK_EVIDENCE_BASELINE);
  });
});

describe('what live runs: the question alone, in match order, the suggested terms marked, a named state applied', () => {
  it('discloses the state only; the suggestion keeps the rest and its terms', () => {
    const server = new MockEvidence({ config: MOCK_EVIDENCE_RELEASE });
    const page = results(server, MOCK_EVIDENCE_QUESTIONS.stateTerms);
    expect([page.automaticFilters, page.appliedFilters, page.query]).toEqual([{ state: ['TX'] }, { state: ['TX'] }, { source: 'question', keywords: { kind: 'question' } }]);
    expect([page.order, page.marks, page.freeUndo, page.undo]).toEqual(['match', 'suggested_terms', false, 'available']);
    expect(page.suggestion).toEqual({ filters: { phase: ['approach'] }, terms: 'carb icing' });
    // The suggested terms are marked where the excerpts hold them.
    const marked = results(server, MOCK_EVIDENCE_QUESTIONS.stateMarked, 3);
    expect([marked.automaticFilters, marked.marks]).toEqual([{ state: ['MO'] }, 'suggested_terms']);
    expect(marked.cases.length).toBeGreaterThan(0);
    expect(marked.cases.every((c) => c.relevance.terms.some((t) => t.term === 'carb' || t.term === 'icing'))).toBe(true);
    // The state-only undo: free, once.
    const undone = undoReply(server, page, {}, false, 2);
    expect([undone.exempt, undone.reply.quotaExempt, undone.search.freeUndo, undone.search.query]).toEqual([true, true, true, page.query]);
    expect((server.read(page.id, 1).body as EvidencePage).undo).toBe('used');
  });

  it('“undo fails”: the free undo is admitted, takes the claim and fails; a replay fails the same; trying again uses one', () => {
    const server = new MockEvidence({ config: MOCK_EVIDENCE_RELEASE });
    const page = results(server, `${MOCK_EVIDENCE_QUESTIONS.stateTerms}, undo fails`);
    expect(page.undo).toBe('available');
    const body = { kind: 'edited', from: page.id, filters: {}, idempotencyKey: KEY(2), turnstileToken: 'token' } as const;
    expect(server.quotaExempt(body)).toBe(true);
    const failed = server.create(body);
    expect([failed.status, (failed.body as { error: string }).error]).toEqual([503, 'unavailable']);
    // The server keeps the claim: the search's undo is used.
    expect((server.read(page.id, 1).body as EvidencePage).undo).toBe('used');
    expect(server.create(body).status).toBe(503);
    const again = { ...body, idempotencyKey: KEY(3) };
    expect(server.quotaExempt(again)).toBe(false);
    const charged = server.create(again);
    expect([charged.status, charged.quotaExempt, CreateEvidenceResponseSchema.parse(charged.body).search.freeUndo]).toEqual([201, false, false]);
  });
});

describe('the one free undo follows the server’s rule (server/evidence/undo.ts)', () => {
  const v3 = () => new MockEvidence({ config: CONFIGS.questionTermsAiOrderState });

  it('removing the whole automatic state, the added terms, or both is free, once per search', () => {
    for (const [filters, restore] of [
      [{}, false],
      [{ state: ['TX'] }, true],
      [{}, true],
    ] as [BriefFilters, boolean][]) {
      const server = v3();
      const parent = results(server, MOCK_EVIDENCE_QUESTIONS.stateTerms);
      expect(parent.undo).toBe('available');
      const first = undoReply(server, parent, filters, restore, 2);
      expect([first.exempt, first.reply.quotaExempt, first.search.freeUndo]).toEqual([true, true, true]);
      // Read again, the search says its undo is used; the undo's own search has none.
      expect((server.read(parent.id, 1).body as EvidencePage).undo).toBe('used');
      expect(first.search.undo).toBe('none');
      // What it searched: the question's own keywords once restored, else the parent's; nothing automatic.
      expect(first.search.query).toEqual(restore ? { source: 'question', keywords: { kind: 'question' } } : parent.query);
      expect([first.search.automaticFilters, first.search.appliedFilters]).toEqual([null, filters]);
      // A replay of its key is the same search, and spends nothing.
      const replay = server.create({ kind: 'edited', from: parent.id, filters, ...(restore ? { keywords: 'question' as const } : {}), idempotencyKey: KEY(2), turnstileToken: 'token' });
      expect([replay.replayed, (replay.body as { search: EvidencePage }).search.id]).toEqual([true, first.search.id]);
      // Any later undo of the same search uses one.
      const again = undoReply(server, parent, filters, restore, 3);
      expect([again.exempt, again.reply.quotaExempt, again.search.freeUndo]).toEqual([false, false, false]);
    }
  });

  it('every other edit uses one: a narrower state, a no-op, keywords with no added terms, words of their own, another filter, an edit’s edit', () => {
    const server = v3();
    const two = results(server, MOCK_EVIDENCE_QUESTIONS.twoStates, 1);
    // One of two states left narrows the search.
    expect(undoReply(server, two, { state: ['NV'] }, false, 2).search.freeUndo).toBe(false);
    const parent = results(server, MOCK_EVIDENCE_QUESTIONS.stateTerms, 3);
    const charged = (body: Record<string, unknown>, n: number) => {
      const request = { kind: 'edited', from: parent.id, idempotencyKey: KEY(n), turnstileToken: 'token', ...body } as Parameters<MockEvidence['create']>[0];
      expect(server.quotaExempt(request)).toBe(false);
      const reply = server.create(request);
      expect([reply.status, reply.quotaExempt]).toEqual([201, false]);
      return CreateEvidenceResponseSchema.parse(reply.body).search;
    };
    // Nothing removed.
    charged({ filters: { state: ['TX'] } }, 4);
    // The parent's own terms sent as words, even the same ones.
    charged({ filters: {}, terms: 'carb icing' }, 5);
    // A filter added beside the removal.
    charged({ filters: { phase: ['approach'] } }, 6);
    charged({ filters: { state: ['TX'], phase: ['approach'] }, keywords: 'question' }, 7);
    // Still free after all of those: none of them was an undo.
    expect((server.read(parent.id, 1).body as EvidencePage).undo).toBe('available');
    const free = undoReply(server, parent, {}, false, 8).search;
    expect(free.freeUndo).toBe(true);
    // An edit is never an undo's parent, even one that kept the question and its added terms.
    expect(free.query).toEqual(parent.query);
    expect(undoReply(server, free, {}, true, 9).search.freeUndo).toBe(false);
    // Keywords restored when the question added no terms: nothing to remove.
    const baseline = new MockEvidence({ config: { ranking: 'er-q-v1', autoFilters: 'state-explicit.v1.3' } });
    const texas = results(baseline, MOCK_EVIDENCE_QUESTIONS.stateTerms, 10);
    expect(texas.query).toEqual({ source: 'question', keywords: { kind: 'question' } });
    const noTerms = baseline.create({ kind: 'edited', from: texas.id, filters: { state: ['TX'] }, keywords: 'question', idempotencyKey: KEY(11), turnstileToken: 'token' });
    expect(noTerms.quotaExempt).toBe(false);
    // …and the state removed with it is still an undo only without them.
    expect(baseline.create({ kind: 'edited', from: texas.id, filters: {}, keywords: 'question', idempotencyKey: KEY(12), turnstileToken: 'token' }).quotaExempt).toBe(false);
    expect(baseline.create({ kind: 'edited', from: texas.id, filters: {}, idempotencyKey: KEY(13), turnstileToken: 'token' }).quotaExempt).toBe(true);
  });

  it('a search that is gone, or someone else’s, cannot be undone', () => {
    let visitor: 'trial' | 'account' = 'trial';
    let now = new Date('2026-10-25T10:00:00.000Z');
    const server = new MockEvidence({ config: CONFIGS.questionTermsAiOrderState, visitor: () => visitor, now: () => now });
    const parent = results(server, MOCK_EVIDENCE_QUESTIONS.stateTerms);
    const body = { kind: 'edited', from: parent.id, filters: {}, keywords: 'question', idempotencyKey: KEY(2), turnstileToken: 'token' } as const;
    visitor = 'account';
    expect(server.quotaExempt(body)).toBe(false);
    expect(server.create(body).status).toBe(404);
    visitor = 'trial';
    now = new Date(now.getTime() + EVIDENCE_TTL_MS);
    expect(server.quotaExempt({ ...body, idempotencyKey: KEY(3) })).toBe(false);
    expect(server.create({ ...body, idempotencyKey: KEY(3) }).status).toBe(404);
  });
});
