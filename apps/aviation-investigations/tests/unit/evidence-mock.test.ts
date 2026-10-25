/**
 * The mock evidence searches (web/mock/evidence.ts) that the component and end-to-end tests of
 * the evidence view read: every page and response they can produce is valid under the contract
 * (`evidence.v2`), every excerpt is a verbatim slice of its fixture section at its paragraph
 * span, the suggestion never changes what is retrieved, and between them the samples cover
 * every state the interface shows.
 */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { CreateEvidenceResponseSchema, EVIDENCE_PAGE_SIZE, EVIDENCE_TTL_MS, EvidencePageSchema, type EvidenceCase, type EvidencePage } from '../../shared/contracts/evidence.js';
import casesJson from '../../web/mock/cases.json' with { type: 'json' };
import { MOCK_EVIDENCE_QUESTIONS, MockEvidence, evidenceCases, questionWords } from '../../web/mock/evidence.js';

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
function edit(server: MockEvidence, from: EvidencePage, filters: BriefFilters, terms: string | undefined, n: number): EvidencePage {
  const reply = server.create({ kind: 'edited', from: from.id, filters, ...(terms !== undefined ? { terms } : {}), idempotencyKey: KEY(n), turnstileToken: 'token' });
  expect(reply.status).toBe(201);
  const body = CreateEvidenceResponseSchema.parse(reply.body);
  if (body.kind !== 'results') throw new Error('expected results');
  return body.search;
}

/** Where each case's excerpts are: what retrieval chose, whatever words they mark. */
const placement = (cases: readonly EvidenceCase[]) => cases.map((c) => [c.rank, c.case.ntsbNo, c.excerpts.map((e) => `${e.sectionKey}@${e.paragraph.start}`)]);

describe('mock evidence pages are valid evidence.v2 and NTSB text only', () => {
  // Nothing blocks a search: every sample question gets results.
  const searches = Object.entries(MOCK_EVIDENCE_QUESTIONS);

  it.each(searches)('%s: every page validates, and every excerpt is the section text at its paragraph span', (_name, question) => {
    const server = new MockEvidence();
    const first = results(server, question);
    // With its suggestion applied too, filters and words (the edited pages the interface makes).
    const applied = first.suggestion ? [edit(server, first, first.suggestion.filters, undefined, 2), edit(server, first, first.suggestion.filters, first.suggestion.terms, 3)] : [];
    for (const page of [first, ...applied]) {
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
          // A whole paragraph: it starts after a line break (or at the start) and ends before one.
          expect(e.paragraph.start === 0 || section?.text[e.paragraph.start - 1] === '\n' || /\s/.test(section?.text[e.paragraph.start - 1] ?? '')).toBe(true);
          expect(e.text).not.toContain('\n');
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
    expect([seed.query, seed.appliedFilters, seed.hint, seed.note]).toEqual([{ source: 'question' }, {}, null, null]);
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
      { source: 'question' },
      { phase: ['approach'] },
      null,
      null,
    ]);
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
