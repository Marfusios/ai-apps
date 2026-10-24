/**
 * The mock evidence searches (web/mock/evidence.ts) that the component and end-to-end tests of
 * the evidence view read: every page and response they can produce is valid under the contract
 * (`evidence.v1`), every excerpt is a verbatim slice of its fixture section at its paragraph
 * span, and between them the samples cover every state the interface shows.
 */
import { describe, expect, it } from 'vitest';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import {
  CreateEvidenceResponseSchema,
  EVIDENCE_PAGE_SIZE,
  EVIDENCE_TTL_MS,
  EvidencePageSchema,
  UNCHECKED_KINDS,
  type EvidenceCase,
  type EvidencePage,
} from '../../shared/contracts/evidence.js';
import casesJson from '../../web/mock/cases.json' with { type: 'json' };
import { MOCK_EVIDENCE_QUESTIONS, MockEvidence, evidenceCases, readQuestion, scopeReplyFor } from '../../web/mock/evidence.js';

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

describe('mock evidence pages are valid evidence.v1 and NTSB text only', () => {
  const searches = Object.entries(MOCK_EVIDENCE_QUESTIONS).filter(([, q]) => scopeReplyFor(q) === null);

  it.each(searches)('%s: every page validates, and every excerpt is the section text at its paragraph span', (_name, question) => {
    const server = new MockEvidence();
    const first = results(server, question);
    for (const c of readAll(server, first)) {
      const detail = CASES[c.case.ntsbNo] as CaseDetail;
      expect(detail, c.case.ntsbNo).toBeDefined();
      // Every probable-cause statement of the case, verbatim, in section order.
      expect(c.probableCauses.map((p) => p.text)).toEqual(detail.sections.filter((s) => s.kind === 'probable_cause').map((s) => s.text));
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
  });

  it('the samples cover the states the interface shows', () => {
    const server = new MockEvidence();
    let key = 500;
    const all = (q: string): EvidenceCase[] => readAll(server, results(server, q, (key += 1)));
    // Several pages of one pinned ranking.
    const seed = results(server, MOCK_EVIDENCE_QUESTIONS.seed, 101);
    expect(seed.pages).toBeGreaterThanOrEqual(3);
    expect(seed.cases).toHaveLength(EVIDENCE_PAGE_SIZE);
    // Multi-aircraft events, their text event-scoped.
    const midair = all(MOCK_EVIDENCE_QUESTIONS.midair).filter((c) => c.case.aircraft.length > 1);
    expect(midair.length).toBeGreaterThanOrEqual(2);
    expect(midair.flatMap((c) => c.excerpts).every((e) => e.scope === 'event' && e.aircraftKey === null)).toBe(true);
    // Literal and synonym highlights ("carburetor" for "carb"); a literal is the word itself, never a stem.
    const carb = all(MOCK_EVIDENCE_QUESTIONS.carb).flatMap((c) => c.excerpts);
    const marked = (match: 'literal' | 'synonym') => carb.flatMap((e) => e.highlights.filter((h) => h.match === match).map((h) => e.text.slice(h.start, h.end).toLowerCase()));
    expect(marked('synonym')).toContain('carburetor');
    expect(new Set(marked('literal'))).toEqual(new Set(['icing']));
    // A highlight after multi-byte characters: the offsets are UTF-16 code units.
    const multibyte = all(MOCK_EVIDENCE_QUESTIONS.multibyte).flatMap((c) => c.excerpts);
    const after = multibyte.find((e) => {
      const at = e.text.search(/[^\x00-\x7f]/);
      return at >= 0 && e.highlights.some((h) => h.start > at);
    });
    expect(after).toBeDefined();
    // Every unchecked kind, each quoting the question's own words.
    const unchecked = readQuestion(MOCK_EVIDENCE_QUESTIONS.unchecked).unchecked;
    expect(unchecked.map((u) => u.kind).sort()).toEqual([...UNCHECKED_KINDS].sort());
    for (const u of unchecked) expect(MOCK_EVIDENCE_QUESTIONS.unchecked).toContain(u.quote);
    // A tiny and an empty result.
    expect(results(server, MOCK_EVIDENCE_QUESTIONS.tiny, 201).total).toBe(2);
    const empty = results(server, MOCK_EVIDENCE_QUESTIONS.empty, 202);
    expect([empty.total, empty.pages, empty.cases.length]).toEqual([0, 0, 0]);
    // Cases found by similarity alone keep one excerpt, or none when no passage maps (a
    // multi-aircraft event here): the case stays, with its facts and probable causes.
    const similarityOnly = all(MOCK_EVIDENCE_QUESTIONS.carb).filter((c) => c.relevance.channels.join() === 'similarity');
    expect(similarityOnly.filter((c) => c.case.aircraft.length === 1).every((c) => c.excerpts.length === 1)).toBe(true);
    const bare = similarityOnly.find((c) => c.excerpts.length === 0);
    expect(bare?.case.aircraft.length).toBeGreaterThan(1);
    expect(bare?.probableCauses.length).toBeGreaterThan(0);
  });

  it('static scope replies come from the server templates, never a clarification round', () => {
    const server = new MockEvidence();
    const kinds = (['outOfScope', 'operational', 'statistics', 'comparison'] as const).map((name, i) => {
      const { reply, body } = ask(server, MOCK_EVIDENCE_QUESTIONS[name], 300 + i);
      expect(reply.status).toBe(200);
      return body.kind === 'scope_reply' ? body.reply.kind : body.kind;
    });
    expect(kinds).toEqual(['out_of_scope', 'operational_advice', 'corpus_statistics', 'case_comparison']);
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

  it('a key replays its search; the same key for another question is a conflict', () => {
    const server = new MockEvidence();
    const first = results(server, MOCK_EVIDENCE_QUESTIONS.seed, 7);
    const again = server.create({ kind: 'question', question: MOCK_EVIDENCE_QUESTIONS.seed, idempotencyKey: KEY(7), turnstileToken: 'token' });
    expect(again.replayed).toBe(true);
    expect((again.body as { search: EvidencePage }).search.id).toBe(first.id);
    expect(server.create({ kind: 'question', question: 'Another question', idempotencyKey: KEY(7), turnstileToken: 'token' }).status).toBe(409);
  });

  it('an edited search keeps the question and unchecked readings, takes filters and terms as given', () => {
    const server = new MockEvidence();
    const carb = results(server, MOCK_EVIDENCE_QUESTIONS.carb, 1);
    const reply = server.create({ kind: 'edited', from: carb.id, filters: {}, terms: 'carburetor heat', idempotencyKey: KEY(2), turnstileToken: 'token' });
    expect(reply.status).toBe(201);
    const edited = EvidencePageSchema.parse((reply.body as { search: EvidencePage }).search);
    expect(edited.id).not.toBe(carb.id);
    expect(edited.edited).toBe(true);
    expect(edited.question).toBe(carb.question);
    expect(edited.interpretation).toEqual({ filters: {}, terms: 'carburetor heat', unchecked: carb.interpretation.unchecked });
    // The removed phase filter stays removed: more cases than the approach phase had.
    expect(edited.total).toBeGreaterThan(carb.total);
    expect(evidenceCases(edited.interpretation).length).toBe(edited.total);
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
    const search = results(server, MOCK_EVIDENCE_QUESTIONS.tiny);
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
