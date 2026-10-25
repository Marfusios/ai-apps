import { ScopeReplySchema } from '../../shared/contracts/briefs.js';
/**
 * The evidence view's contract (`evidence.v3`, shared/contracts/evidence.ts): what a page of a
 * stored search may carry, and the refusals that keep generated text and clarification rounds out.
 */
import { describe, expect, it } from 'vitest';
import {
  CreateEvidenceRequestSchema,
  CreateEvidenceResponseSchema,
  EVIDENCE_NOTICE,
  EVIDENCE_BOUNDARY,
  EvidenceExcerptSchema,
  EvidencePageSchema,
  EvidenceHintSchema,
  EvidenceQuerySchema,
  EVIDENCE_SUGGESTION_LABEL,
  EVIDENCE_NOTE_KINDS,
  EVIDENCE_NOTE_TEXT,
} from '../../shared/contracts/evidence.js';

const SHA = 'a'.repeat(64);
const excerpt = {
  sectionKey: 'analysis/event-1',
  section: 'analysis',
  label: 'Analysis',
  scope: 'event',
  aircraftKey: null,
  revision: SHA,
  paragraph: { start: 120, end: 175 },
  seed: { start: 130, end: 170 },
  text: 'The pilot applied carburetor heat, and the engine lost power.',
  highlights: [
    { start: 18, end: 29, match: 'literal' },
    { start: 34, end: 38, match: 'literal' },
    { start: 44, end: 59, match: 'synonym' },
  ],
} as const;

const page = {
  version: 'evidence.v3',
  id: '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f',
  question: 'carburetor icing on approach',
  query: { source: 'question', keywords: { kind: 'question' } },
  automaticFilters: null, order: 'match', marks: 'suggested_terms', freeUndo: false, undo: 'none',
  appliedFilters: {},
  suggestion: { filters: { phase: ['approach'] }, terms: 'carburetor icing' },
  hint: null,
  note: null,
  generation: 'g1',
  createdAt: '2026-10-24T22:00:00.000Z',
  expiresAt: '2026-10-25T22:00:00.000Z',
  total: 0,
  page: 1,
  pages: 0,
  cases: [],
};

describe('evidence.v3 contract', () => {
  it('accepts a page and an excerpt that is exactly its paragraph, with sorted highlights', () => {
    expect(EvidencePageSchema.safeParse(page).success).toBe(true);
    const fixed = { ...excerpt, paragraph: { start: 120, end: 120 + excerpt.text.length } };
    expect(EvidenceExcerptSchema.safeParse(fixed).success).toBe(true);
  });

  it('requires unambiguous UTC instants for search creation and expiry', () => {
    expect(EvidencePageSchema.safeParse({ ...page, expiresAt: '2026-10-25T22:00:00' }).success).toBe(false);
  });

  it('refuses an excerpt whose text is not the whole paragraph span, or whose highlights overlap', () => {
    expect(EvidenceExcerptSchema.safeParse(excerpt).success).toBe(false);
    const fixed = { ...excerpt, paragraph: { start: 120, end: 120 + excerpt.text.length } };
    const overlapping = { ...fixed, highlights: [{ start: 10, end: 20, match: 'literal' }, { start: 15, end: 25, match: 'literal' }] };
    expect(EvidenceExcerptSchema.safeParse(overlapping).success).toBe(false);
  });

  it('never blocks a search: there is no scope reply of any kind, only results', () => {
    const replies = [
      { kind: 'needs_clarification', label: 'Which?', line: 'Pick one', readings: [] },
      { kind: 'out_of_scope', lines: ['AirCase searches NTSB investigations.'], keywordSearchLabel: 'Search' },
    ];
    for (const reply of replies) expect(CreateEvidenceResponseSchema.safeParse({ kind: 'scope_reply', reply }).success).toBe(false);
    expect(CreateEvidenceResponseSchema.safeParse({ kind: 'results', search: page }).success).toBe(true);
  });

  it('a capability note is one of two fixed reminders, never free text (gate answer 2)', () => {
    expect([...EVIDENCE_NOTE_KINDS]).toEqual(['scope', 'operational_advice']);
    for (const note of EVIDENCE_NOTE_KINDS) {
      expect(EVIDENCE_NOTE_TEXT[note]).toMatch(/\S/);
      expect(EvidencePageSchema.safeParse({ ...page, note }).success).toBe(true);
    }
    expect(EVIDENCE_NOTE_TEXT.operational_advice).toContain('not a source of operational flight or maintenance advice');
    expect(EvidencePageSchema.safeParse({ ...page, note: 'This question is unsafe.' }).success).toBe(false);
  });

  it('edited filters and terms are independent, never a new question', () => {
    const edited = { kind: 'edited', from: page.id, filters: {}, terms: 'carburetor icing', idempotencyKey: 'key-12345678' };
    expect(CreateEvidenceRequestSchema.safeParse(edited).success).toBe(true);
    const { terms: _terms, ...filtersOnly } = edited;
    expect(CreateEvidenceRequestSchema.safeParse(filtersOnly).success).toBe(true);
    expect(CreateEvidenceRequestSchema.safeParse({ ...edited, terms: '' }).success).toBe(false);
    expect(CreateEvidenceRequestSchema.safeParse({ ...edited, question: 'x' }).success).toBe(false);
  });

  it('keeps a long whole paragraph rather than cropping it for a card', () => {
    const text = 'NTSB text. '.repeat(3000);
    expect(EvidenceExcerptSchema.safeParse({ ...excerpt, paragraph: { start: 0, end: text.length }, seed: { start: 0, end: 100 }, text, highlights: [] }).success).toBe(true);
  });

  it('labels suggestions as unapplied, and keeps the general notice', () => {
    expect(EVIDENCE_SUGGESTION_LABEL).toContain('not applied');
    expect(EVIDENCE_NOTICE).toMatch(/timing/);
    expect(EVIDENCE_NOTICE).toMatch(/causes/);
    expect(EVIDENCE_NOTICE).toMatch(/did not happen/);
    // The research-only boundary is fixed text too, shown with the notice whatever the note.
    expect(EVIDENCE_BOUNDARY).toContain('research tool');
    expect(EVIDENCE_BOUNDARY).toContain('not a source of operational flight or maintenance advice');
  });
});

it('distinguishes executed query from suggestions and rejects the old contract', () => {
  expect(EvidencePageSchema.safeParse({ ...page, interpretation: page.suggestion }).success).toBe(false);
  expect(EvidencePageSchema.safeParse({ ...page, edited: false }).success).toBe(false);
  expect(EvidencePageSchema.safeParse({ ...page, suggestion: { ...page.suggestion, unchecked: [] } }).success).toBe(false);
  expect(EvidencePageSchema.safeParse({ ...page, suggestion: null }).success).toBe(true);
  expect(EvidenceQuerySchema.safeParse({ source: 'question', terms: 'silent rewrite' }).success).toBe(false);
  expect(EvidenceQuerySchema.safeParse({ source: 'edited', terms: 'power loss' }).success).toBe(true);
});
it('keeps statistics and comparison as bounded, non-blocking hints', () => {
  const stats = { kind: 'corpus_statistics' };
  const compare = { kind: 'case_comparison', found: ['SEA08LA057'], notFound: [] };
  for (const hint of [stats, compare]) expect(EvidenceHintSchema.safeParse(hint).success).toBe(true);
  expect(EvidenceHintSchema.safeParse({ ...stats, filters: {} }).success).toBe(false);
  expect(EvidenceHintSchema.safeParse({ ...compare, found: Array(5).fill('SEA08LA057') }).success).toBe(false);
  for (const reply of [{ kind: 'corpus_statistics', filters: {}, lines: ['Use the dashboard'] }, compare]) {
    expect(ScopeReplySchema.safeParse(reply).success).toBe(true);
    expect(CreateEvidenceResponseSchema.safeParse({ kind: 'scope_reply', reply }).success).toBe(false);
  }
});
