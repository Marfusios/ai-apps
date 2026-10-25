/**
 * The web client's free-undo rule (web/src/features/evidence/undo.ts) held to the server's
 * (server/evidence/undo.ts `canUndo`): over the parents and edits the rule tells apart, the
 * button says "· free" exactly when the server would make the edit without using one of the
 * visitor's searches, reading the page as the server projects it (`pageOf`) and what the tab
 * remembers (whether it made the search by editing another, whether that search's undo is used).
 * With the page alone, it never says "uses 1" for an undo the server would make free, and says
 * "free" wrongly only where the page cannot tell: an edit that kept the question and only removed
 * filters, or a search whose undo was used in another tab.
 */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { CreateEvidenceRequestSchema, type CreateEvidenceRequest, type EvidenceAutomaticFilters, type EvidenceQuery } from '../../shared/contracts/evidence.js';
import { canUndo } from '../../server/evidence/undo.js';
import { pageOf, type EvidenceRow } from '../../server/evidence/store.js';
import { addedTerms, freeUndoRule, mayBeOriginal, rememberEdit, undoMemoryOf, undoWasCharged, forgetUndos } from '../../web/src/features/evidence/undo.js';

const now = new Date('2026-10-25T12:00:00Z');
const ID = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
const question = 'Carb icing on approach in Texas';

interface Parent {
  name: string;
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
    id: ID, readOwner: 'a'.repeat(64), readOwnerKind: 'trial', ownerMovedAt: null,
    billingPrincipal: 'a'.repeat(64), billingKind: 'trial', reservationId: 1, freeUndoReservationId: p.claimed ? 7 : null,
    generationId: 1, casesIndex: 'test-cases', passagesIndex: 'test-passages', status: 'results', createdAt: now,
    expiresAt: new Date(now.getTime() + (p.expired ? -1 : 86_400_000)),
    data: {
      question, edited: p.edited, version: 'evidence.v3', query: p.query,
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

/** Every parent shape the rule distinguishes: originals with and without additions, edits that look like them, and the conditions that end an undo. */
function parents(): Parent[] {
  const out: Parent[] = [];
  const base = { freeUndo: false, claimed: false, expired: false };
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

describe('the client’s free-undo rule is the server’s', () => {
  it('with what the tab remembers, it agrees with the server on every parent and edit', () => {
    let free = 0;
    for (const p of parents()) {
      const saved = row(p);
      const page = pageOf(saved, 1);
      if (!page) throw new Error(`no page for ${p.name}`);
      for (const e of edits(p)) {
        const server = canUndo(saved, e, now);
        const client = freeUndoRule(page, { filters: e.filters, terms: e.terms, keywords: e.keywords }, { edited: p.edited, used: p.claimed }, now.getTime());
        expect(client, `${p.name}: ${JSON.stringify({ filters: e.filters, terms: e.terms, keywords: e.keywords })}`).toBe(server);
        if (server) free += 1;
      }
    }
    // The matrix holds free undos of each kind: the state, the terms, both.
    expect(free).toBeGreaterThanOrEqual(9);
  });

  it('with the page alone, it never says "uses 1" for a free undo, and says "free" wrongly only where the page cannot tell', () => {
    for (const p of parents()) {
      const saved = row(p);
      const page = pageOf(saved, 1);
      if (!page) throw new Error(`no page for ${p.name}`);
      for (const e of edits(p)) {
        const server = canUndo(saved, e, now);
        const client = freeUndoRule(page, { filters: e.filters, terms: e.terms, keywords: e.keywords }, { edited: false, used: false }, now.getTime());
        if (server) expect(client, p.name).toBe(true);
        if (client && !server) expect((p.edited && mayBeOriginal(page)) || p.claimed, p.name).toBe(true);
      }
    }
  });

  it('only a question search with added terms has terms to take out', () => {
    expect(addedTerms(QUESTION)).toBeNull();
    expect(addedTerms(OWN_WORDS)).toBeNull();
    expect(addedTerms(PLUS_TERMS)).toEqual({ kind: 'question+terms', terms: 'carb icing' });
    expect(addedTerms(TERMS)).toEqual({ kind: 'terms', terms: 'carb icing' });
  });
});

describe('what the tab remembers', () => {
  it('an edit’s search is never a parent; a used undo, or one the server counted, ends the parent’s; a counted undo is said once made', () => {
    forgetUndos();
    const parent = 'parent-1';
    // A charged edit uses no undo.
    rememberEdit(parent, { id: 'child-1', freeUndo: false }, false);
    expect(undoMemoryOf(parent)).toEqual({ edited: false, used: false });
    expect(undoMemoryOf('child-1')).toEqual({ edited: true, used: false });
    // A free undo uses it.
    rememberEdit(parent, { id: 'child-2', freeUndo: true }, true);
    expect(undoMemoryOf(parent).used).toBe(true);
    expect(undoWasCharged('child-2')).toBe(false);
    // Shown as free, counted by the server: said on the search it made, and the parent's undo is over.
    rememberEdit('parent-2', { id: 'child-3', freeUndo: false }, true);
    expect([undoMemoryOf('parent-2').used, undoWasCharged('child-3')]).toEqual([true, true]);
    forgetUndos();
    expect([undoMemoryOf(parent), undoMemoryOf('child-1'), undoWasCharged('child-3')]).toEqual([{ edited: false, used: false }, { edited: false, used: false }, false]);
  });
});
