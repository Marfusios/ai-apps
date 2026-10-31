/**
 * The one free undo, held to the server's rule (server/evidence/undo.ts `canUndo`) over the
 * parents and edits the rule tells apart: the web client's rule (web/src/features/evidence/undo.ts)
 * reading the page as the server projects it (`pageOf`, with its read-time `undo` hint), and the mock
 * API's (web/mock/evidence.ts, `quotaExempt` and its own `undo` hint), each exactly. A legacy v2
 * search offers no free undo in the interface.
 */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { CreateEvidenceRequestSchema, EvidencePageSchema, type CreateEvidenceRequest, type EvidenceAutomaticFilters, type EvidenceQuery } from '../../shared/contracts/evidence.js';
import { canUndo } from '../../server/evidence/undo.js';
import { pageOf, type EvidenceRow } from '../../server/evidence/store.js';
import { MockEvidence } from '../../web/mock/evidence.js';
import { addedTerms, forgetUndos, freeUndoRule, rememberCharged, undoWasCharged } from '../../web/src/features/evidence/undo.js';

const now = new Date('2026-10-25T12:00:00Z');
const ID = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
const question = 'Carb icing on approach in Texas';

interface Parent {
  name: string;
  version: 'evidence.v3' | 'evidence.v2';
  edited: boolean;
  query: EvidenceQuery;
  automaticFilters: EvidenceAutomaticFilters | null;
  appliedFilters: BriefFilters;
  freeUndo: boolean;
  claimed: boolean;
  expired: boolean;
}

function row(p: Parent): EvidenceRow {
  return {
    traceId: null, feedbackRating: null, feedbackDay: null, id: ID, readOwner: 'a'.repeat(64), readOwnerKind: 'trial', ownerMovedAt: null,
    billingPrincipal: 'a'.repeat(64), billingKind: 'trial', reservationId: 1, freeUndoReservationId: p.claimed ? 7 : null,
    generationId: 1, casesIndex: 'test-cases', passagesIndex: 'test-passages', status: 'results', createdAt: now,
    expiresAt: new Date(now.getTime() + (p.expired ? -1 : 86_400_000)),
    data: {
      question, edited: p.edited, version: p.version, query: p.query,
      context: { dataset: { revision: 'g1', snapshotDate: '2026-10-01' }, citationTextVersion: 'v1', fieldNormalizationVersion: 'v1', mappingVerified: false },
      automaticFilters: p.automaticFilters, appliedFilters: p.appliedFilters, suggestion: null, hint: null, note: null,
      marks: 'search_words', freeUndo: p.freeUndo, cases: [], ranking: [],
    },
  } as EvidenceRow;
}

const QUESTION: EvidenceQuery = { source: 'question', keywords: { kind: 'question' } };
const PLUS_TERMS: EvidenceQuery = { source: 'question', keywords: { kind: 'question+terms', terms: 'carb icing' } };
const TERMS: EvidenceQuery = { source: 'question', keywords: { kind: 'terms', terms: 'carb icing' } };
const OWN_WORDS: EvidenceQuery = { source: 'edited', terms: 'carburetor heat' };

/** Every v3 parent shape the rule distinguishes: originals with and without additions, edits that look like them, and the conditions that end an undo. */
function parents(): Parent[] {
  const out: Parent[] = [];
  const base = { version: 'evidence.v3' as const, freeUndo: false, claimed: false, expired: false };
  for (const query of [QUESTION, PLUS_TERMS, TERMS]) {
    for (const automaticFilters of [null, { state: ['TX'] }, { state: ['CA', 'NV'] }] as (EvidenceAutomaticFilters | null)[]) {
      const original: Parent = { name: `original ${JSON.stringify(query)} ${JSON.stringify(automaticFilters)}`, edited: false, query, automaticFilters, appliedFilters: automaticFilters ? { state: [...automaticFilters.state] } : {}, ...base };
      out.push(original, { ...original, name: `${original.name}, claimed`, claimed: true }, { ...original, name: `${original.name}, expired`, expired: true });
    }
    // Edits that kept the question: one with filters of the reader's, one with none left (it looks like an original), and an undo.
    out.push({ name: `edit with a filter ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: { phase: ['approach'] }, ...base });
    out.push({ name: `edit with no filter ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: {}, ...base });
    out.push({ name: `undo ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: {}, ...base, freeUndo: true });
  }
  out.push({ name: 'edit with words', edited: true, query: OWN_WORDS, automaticFilters: null, appliedFilters: {}, ...base });
  return out;
}

type Edit = Extract<CreateEvidenceRequest, { kind: 'edited' }>;

/** Every edit of `p` the rule tells apart: filters kept, a state taken out, all states out, one added; words, keywords or neither. */
function edits(p: Parent): Edit[] {
  const { state: _state, ...withoutState } = p.appliedFilters;
  const filters: BriefFilters[] = [p.appliedFilters, withoutState, { ...p.appliedFilters, injury: ['FATL'] }, {}];
  if ((p.appliedFilters.state ?? []).length > 1) filters.push({ ...p.appliedFilters, state: (p.appliedFilters.state ?? []).slice(1) });
  const out: Edit[] = [];
  for (const f of filters) {
    for (const change of [{}, { keywords: 'question' }, { terms: 'carb icing' }, { terms: 'carburetor heat' }]) {
      out.push(CreateEvidenceRequestSchema.parse({ kind: 'edited', from: ID, filters: f, ...change, idempotencyKey: 'undo-12345678' }) as Edit);
    }
  }
  return out;
}

const describeEdit = (e: Edit): string => JSON.stringify({ filters: e.filters, terms: e.terms, keywords: e.keywords });

describe('the client’s free-undo rule is the server’s', () => {
  it('on every parent the page can be read for, “free” exactly when the server would make the edit free', () => {
    let free = 0;
    let read = 0;
    for (const p of parents()) {
      const saved = row(p);
      const page = pageOf(saved, 1, now);
      if (p.expired) {
        // A search that is gone has no page (a 404), and no undo.
        expect(page, p.name).toBeNull();
        for (const e of edits(p)) expect(canUndo(saved, e, now), p.name).toBe(false);
        continue;
      }
      if (!page) throw new Error(`no page for ${p.name}`);
      read += 1;
      for (const e of edits(p)) {
        const server = canUndo(saved, e, now);
        expect(freeUndoRule(page, { filters: e.filters, terms: e.terms, keywords: e.keywords }), `${p.name}: ${describeEdit(e)}`).toBe(server);
        if (server) free += 1;
      }
    }
    // The matrix holds free undos of each kind (the state, the terms, both), and every readable parent.
    expect(free).toBeGreaterThanOrEqual(9);
    expect(read).toBe(parents().filter((p) => !p.expired).length);
  });

  it('the page’s undo hint: available on an original with something added until claimed, then used; none for edits and for nothing added', () => {
    for (const p of parents().filter((x) => !x.expired)) {
      const hint = pageOf(row(p), 1, now)?.undo;
      const additions = p.automaticFilters !== null || addedTerms(p.query) !== null;
      expect(hint, p.name).toBe(p.edited || !additions ? 'none' : p.claimed ? 'used' : 'available');
    }
  });

  it('a legacy v2 search offers no free undo in the interface, even with recorded added terms', () => {
    const legacy = row({ name: 'v2', version: 'evidence.v2', edited: false, query: PLUS_TERMS, automaticFilters: null, appliedFilters: {}, freeUndo: false, claimed: false, expired: false });
    const page = EvidencePageSchema.parse(pageOf(legacy, 1, now));
    expect(page.undo).toBe('none');
    for (const e of edits({ name: 'v2', version: 'evidence.v2', edited: false, query: PLUS_TERMS, automaticFilters: null, appliedFilters: {}, freeUndo: false, claimed: false, expired: false })) {
      expect(freeUndoRule(page, { filters: e.filters, terms: e.terms, keywords: e.keywords }), describeEdit(e)).toBe(false);
    }
  });

  it('only a question search with added terms has terms to take out', () => {
    expect(addedTerms(QUESTION)).toBeNull();
    expect(addedTerms(OWN_WORDS)).toBeNull();
    expect(addedTerms(PLUS_TERMS)).toEqual({ kind: 'question+terms', terms: 'carb icing' });
    expect(addedTerms(TERMS)).toEqual({ kind: 'terms', terms: 'carb icing' });
  });
});

describe('the mock API’s free undo is the server’s', () => {
  it('quotaExempt and the page’s undo hint agree with canUndo and pageOf on every parent and edit', () => {
    let n = 0;
    for (const p of parents()) {
      const mock = new MockEvidence({ now: () => now });
      const id = mock.seedForTests({ question, query: p.query, appliedFilters: p.appliedFilters, automaticFilters: p.automaticFilters, edited: p.edited, freeUndo: p.freeUndo, undoClaimed: p.claimed, expired: p.expired });
      const saved = row(p);
      // The same page, or the same 404.
      const read = mock.read(id, 1);
      const page = pageOf(saved, 1, now);
      if (page === null) expect(read.status, p.name).toBe(404);
      else expect((read.body as { undo: string }).undo, p.name).toBe(page.undo);
      for (const e of edits(p)) {
        n += 1;
        const body = { ...e, from: id, idempotencyKey: `mock-undo-${String(n).padStart(4, '0')}`, turnstileToken: 'token' };
        expect(mock.quotaExempt(body), `${p.name}: ${describeEdit(e)}`).toBe(canUndo(saved, e, now));
      }
    }
  });
});

describe('what the tab remembers', () => {
  it('a counted undo is said on the search it made, until the visitor changes', () => {
    forgetUndos();
    expect(undoWasCharged('child-1')).toBe(false);
    rememberCharged('child-1');
    expect(undoWasCharged('child-1')).toBe(true);
    forgetUndos();
    expect(undoWasCharged('child-1')).toBe(false);
  });
});
