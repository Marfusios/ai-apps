/**
 * The evidence view's contract (`evidence.v1`, shared/contracts/evidence.ts): what a page of a
 * stored search may carry, and the refusals that keep generated text and clarification rounds out.
 */
import { describe, expect, it } from 'vitest';
import {
  CreateEvidenceRequestSchema,
  CreateEvidenceResponseSchema,
  EVIDENCE_NOTICE,
  EvidenceExcerptSchema,
  EvidencePageSchema,
  UNCHECKED_KINDS,
  UNCHECKED_LABEL,
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
  version: 'evidence.v1',
  id: '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f',
  question: 'carburetor icing on approach',
  interpretation: { filters: { phase: ['approach'] }, terms: 'carburetor icing', unchecked: [] },
  edited: false,
  generation: 'g1',
  createdAt: '2026-10-24T22:00:00',
  expiresAt: '2026-10-25T22:00:00',
  total: 0,
  page: 1,
  pages: 0,
  cases: [],
};

describe('evidence.v1 contract', () => {
  it('accepts a page and an excerpt that is exactly its paragraph, with sorted highlights', () => {
    expect(EvidencePageSchema.safeParse(page).success).toBe(true);
    const fixed = { ...excerpt, paragraph: { start: 120, end: 120 + excerpt.text.length } };
    expect(EvidenceExcerptSchema.safeParse(fixed).success).toBe(true);
  });

  it('refuses an excerpt whose text is not the whole paragraph span, or whose highlights overlap', () => {
    expect(EvidenceExcerptSchema.safeParse(excerpt).success).toBe(false);
    const fixed = { ...excerpt, paragraph: { start: 120, end: 120 + excerpt.text.length } };
    const overlapping = { ...fixed, highlights: [{ start: 10, end: 20, match: 'literal' }, { start: 15, end: 25, match: 'literal' }] };
    expect(EvidenceExcerptSchema.safeParse(overlapping).success).toBe(false);
  });

  it('never carries a clarification round: ambiguity is an unchecked reading', () => {
    const clarification = {
      kind: 'scope_reply',
      reply: { kind: 'needs_clarification', label: 'Which?', line: 'Pick one', readings: [] },
    };
    expect(CreateEvidenceResponseSchema.safeParse(clarification).success).toBe(false);
    expect(UNCHECKED_KINDS).toContain('ambiguous');
  });

  it('an edited search sends filters and terms, never a question', () => {
    const edited = { kind: 'edited', from: page.id, filters: {}, terms: 'carburetor icing', idempotencyKey: 'key-12345678' };
    expect(CreateEvidenceRequestSchema.safeParse(edited).success).toBe(true);
    expect(CreateEvidenceRequestSchema.safeParse({ ...edited, question: 'x' }).success).toBe(false);
  });

  it('labels every unchecked kind, and the notice names timing, causes and absences', () => {
    for (const kind of UNCHECKED_KINDS) expect(UNCHECKED_LABEL[kind]).toMatch(/\S/);
    expect(EVIDENCE_NOTICE).toMatch(/timing/);
    expect(EVIDENCE_NOTICE).toMatch(/causes/);
    expect(EVIDENCE_NOTICE).toMatch(/did not happen/);
  });
});
