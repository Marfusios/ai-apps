import { describe, expect, it } from 'vitest';
import {
  BriefResultSchema,
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  ChecklistSchema,
  ComposeOutputSchema,
  FAILURE_TYPES,
  FAILURE_TYPE_LABELS,
  CreateBriefRequestSchema,
  RefinementRequestSchema,
  ScopeReplySchema,
  StartBriefResponseSchema,
} from '../../shared/contracts/briefs.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { FAILURE_TYPE_LABEL } from '../../server/briefs/clarify.js';
import { NO_MATCH_LINES } from '../../server/briefs/static-replies.js';
import { matchQuote } from '../../server/briefs/validate.js';
import { MockBriefs, MOCK_MIDAIR_QUESTION, MOCK_SEED_QUESTION, RESULT_SAMPLES, SCOPE_REPLY_SAMPLES, midairAnswer, seedAnswer } from '../../web/mock/briefs.js';
import cases from '../../web/mock/cases.json' with { type: 'json' };

const CASES = cases as unknown as Record<string, CaseDetail>;

describe('brief request contracts', () => {
  it('a question is bounded, non-blank and strict', () => {
    const base = { question: 'Power loss after maintenance', idempotencyKey: 'key-12345678', turnstileToken: 't' };
    expect(CreateBriefRequestSchema.safeParse(base).success).toBe(true);
    expect(CreateBriefRequestSchema.safeParse({ ...base, question: ' \n ' }).success).toBe(false);
    expect(CreateBriefRequestSchema.safeParse({ ...base, question: 'x'.repeat(1_501) }).success).toBe(false);
    expect(CreateBriefRequestSchema.safeParse({ ...base, history: ['earlier answer'] }).success).toBe(false);
    expect(CreateBriefRequestSchema.safeParse({ ...base, idempotencyKey: 'short' }).success).toBe(false);
    expect(CreateBriefRequestSchema.safeParse({ ...base, filters: { category: ['HELI'], completion: ['any'] } }).success).toBe(false);
    expect(CreateBriefRequestSchema.safeParse({ ...base, filters: { category: ['SUBMARINE'] } }).success).toBe(false);
    expect(CreateBriefRequestSchema.safeParse({ ...base, filters: { yearFrom: 2015, yearTo: 2010 } }).success).toBe(false);
  });

  it('RefinementRequest is a discriminated union of text, interpretation and filters', () => {
    const t = { turnstileToken: null, idempotencyKey: 'key-12345678' };
    expect(RefinementRequestSchema.parse({ kind: 'text', text: 'Only airplanes', ...t }).kind).toBe('text');
    expect(RefinementRequestSchema.parse({ kind: 'interpretation', field: 'timing_window', value: { days: 30, flightHours: 10 }, ...t }).kind).toBe('interpretation');
    expect(RefinementRequestSchema.parse({ kind: 'interpretation', field: 'first_flight_only', value: true, ...t }).kind).toBe('interpretation');
    expect(RefinementRequestSchema.parse({ kind: 'filters', filters: { phase: ['takeoff'] }, ...t }).kind).toBe('filters');
    for (const bad of [
      { kind: 'interpretation', field: 'timing_window', value: true },
      { kind: 'interpretation', field: 'first_flight_only', value: { days: 1, flightHours: null } },
      { kind: 'interpretation', field: 'timing_window', value: { days: null, flightHours: null } },
      { kind: 'interpretation', field: 'timing_window', value: { days: 400, flightHours: null } },
      { kind: 'interpretation', field: 'failure_type', value: 'explosion' },
      { kind: 'interpretation', field: 'system_prompt', value: 'x' },
      { kind: 'chat', text: 'hello' },
      { kind: 'text', text: 'ok', answer: 'previous answer' },
    ]) {
      expect(RefinementRequestSchema.safeParse({ ...bad, ...t }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the composition schema is strict and bounded', () => {
    const ok = {
      outcome: 'answer',
      summary: 'A [[case:DFW08TA066]].',
      groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }],
      cases: [{ ntsbNo: 'DFW08TA066', why: 'w', quotes: [{ passageId: 'p1', quote: 'q', speaker: 'pilot' }], evidencePassageIds: ['p1'] }],
      gaps: [],
    };
    expect(ComposeOutputSchema.safeParse(ok).success).toBe(true);
    // The explicit abstention is a valid shape; the validator enforces what it may hold.
    expect(ComposeOutputSchema.safeParse({ ...ok, outcome: 'no_supported_match', summary: '', groups: [], cases: [] }).success).toBe(true);
    expect(ComposeOutputSchema.safeParse({ ...ok, outcome: 'maybe' }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, html: '<b>' }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], quotes: [] }] }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], timing: '5.1 FH' }] }).success).toBe(false);
    // Chronology: independent typed facts, each with its passages.
    const chronology = { flightHours: { value: 20, bound: 'exact', passageIds: ['p1'] }, calendarDays: { value: 40, bound: 'exact', passageIds: ['p1'] } };
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], chronology }] }).success).toBe(true);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], chronology: { ...chronology, weeks: 6 } }] }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], chronology: { flight: { value: 2, passageIds: ['p1'] } } }] }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], maintenance: 'investigator_attributed' }] }).success).toBe(false);
  });

  it('the new error codes are part of ErrorResponse', () => {
    for (const error of ['ai_paused', 'trial_used', 'free_searches_paused', 'quota_exhausted', 'in_flight', 'conflict', 'refinement_limit']) {
      expect(ErrorResponseSchema.safeParse({ error, message: 'm' }).success, error).toBe(true);
    }
  });
});

describe('checklist interpretation (UI_DESIGN §4.4: the chips stay on top while the step runs)', () => {
  it('is optional, strict, and carries server chips and validated filters only', () => {
    expect(ChecklistSchema.safeParse({ question: 'in_scope' }).success).toBe(true);
    const interpretation = {
      interpretations: [{ field: 'timing_window', value: { days: 30, flightHours: 10 }, label: 'Within 30 days or 10 flight hours', pinned: false }],
      filters: { category: ['HELI'] },
    };
    expect(ChecklistSchema.safeParse({ question: 'in_scope', interpretation }).success).toBe(true);
    expect(ChecklistSchema.safeParse({ question: 'in_scope', interpretation: { ...interpretation, text: 'free text' } }).success).toBe(false);
    expect(ChecklistSchema.safeParse({ question: 'in_scope', interpretation: { ...interpretation, filters: { completion: ['any'] } } }).success).toBe(false);
  });

  it('the failure-type words in the contract are the server templates', () => {
    for (const f of FAILURE_TYPES) expect(FAILURE_TYPE_LABELS[f]).toBe(FAILURE_TYPE_LABEL[f]);
  });
});

describe('mock briefs (web/mock/briefs.ts)', () => {
  it('every sample satisfies the contracts', () => {
    for (const [name, r] of Object.entries(RESULT_SAMPLES)) expect(BriefResultSchema.safeParse(r).success, name).toBe(true);
    for (const [name, r] of Object.entries(SCOPE_REPLY_SAMPLES)) expect(ScopeReplySchema.safeParse(r).success, name).toBe(true);
  });

  it('every quote is its section text at its span, and passes the quote rule', () => {
    for (const card of [...seedAnswer().cases, ...midairAnswer().cases]) {
      for (const q of card.reading?.quotes ?? []) {
        const section = CASES[card.case.ntsbNo]!.sections.find((s) => `${card.case.ntsbNo}:${s.key}` === q.sectionId)!;
        expect(section.text.slice(q.span.start, q.span.end)).toBe(q.text);
        expect(q.sectionRevision).toBe(section.revision);
        const m = matchQuote(section.text, q.text);
        expect(m).toMatchObject({ ok: true, span: q.span });
      }
    }
  });

  it('a two-aircraft answer: event-scoped evidence, no glyph, and two adjacent citations', () => {
    const mock = new MockBriefs({ pollsToFinish: 1 });
    const started = StartBriefResponseSchema.parse(mock.create({ question: MOCK_MIDAIR_QUESTION, idempotencyKey: 'key-midair-1' }).body);
    mock.read(started.briefId);
    const result = BriefStepResponseSchema.parse(mock.read(started.briefId).body).result;
    expect(result).toMatchObject({ kind: 'answer', grouping: 'examples', interpretations: [], groups: [{ kind: 'examples' }] });
    if (result?.kind !== 'answer') throw new Error('expected an answer');
    expect(result.summary.slice(0, 3).map((x) => x.kind)).toEqual(['text', 'case', 'case']);
    for (const card of result.cases) {
      expect(card.case.aircraft).toHaveLength(2);
      expect(card.reading).toMatchObject({ glyph: null, evidence: { scope: 'event', multiAircraft: true } });
      for (const q of card.reading?.quotes ?? []) expect(q).toMatchObject({ scope: 'event', aircraftKey: null });
    }
    const context = CaseContextResponseSchema.parse(mock.context(started.briefId, 1, 'SEA08LA057').body);
    expect(context.passages[0]!.highlights).toHaveLength(2);
  });

  it('a running brief moves one checklist row per poll, then answers', () => {
    const mock = new MockBriefs();
    const started = mock.create({ question: MOCK_SEED_QUESTION, idempotencyKey: 'key-12345678' });
    expect(started.status).toBe(202);
    const s = StartBriefResponseSchema.parse(started.body);
    const stages: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = BriefStepResponseSchema.parse(mock.read(s.briefId).body);
      stages.push(r.stage);
      // The scope row is done on every read, so the readings and filters ride along.
      expect(r.checklist.interpretation).toEqual({ interpretations: seedAnswer().interpretations, filters: {} });
      if (r.stage === 'done') {
        expect(r.checklist).toMatchObject({ question: 'in_scope', searched: { cases: 4, passages: 9 }, written: true, verified: 'passed' });
        expect(r.result?.kind).toBe('answer');
      }
    }
    expect(stages).toEqual(['retrieve', 'compose', 'validate', 'validate', 'done']);
    const context = CaseContextResponseSchema.parse(mock.context(s.briefId, 1, 'DEN08LA103').body);
    expect(context.lines.map((l) => l.label)).toEqual(['EVIDENCE', 'MAINTENANCE', 'SYMPTOM', 'TIMING', 'CRITERIA', 'ACCOUNT']);
    // An unconfirmed criterion says so first, with the passage set its claim was checked on.
    expect(context.lines.find((l) => l.label === 'CRITERIA')).toEqual({
      label: 'CRITERIA',
      text: 'Unconfirmed: the passages do not establish your timing window',
      passageIds: ['mock-DEN08LA103-analysis', 'mock-DEN08LA103-probable_cause'],
    });
    expect(context.passages[0]!.highlights).toHaveLength(2);
    // Each line links to its own passages; a gap-only case has a context too.
    expect(context.lines.find((l) => l.label === 'EVIDENCE')!.passageIds).toEqual(['mock-DEN08LA103-analysis', 'mock-DEN08LA103-probable_cause']);
    const gapCase = CaseContextResponseSchema.parse(mock.context(s.briefId, 1, 'NYC08LA106').body);
    expect(gapCase).toMatchObject({ reading: null, lines: [], gaps: [{ ntsbNo: 'NYC08LA106', passageIds: ['mock-NYC08LA106-analysis'] }] });
  });

  it('offers every outcome: withheld, scope replies, refinements up to the limit, cancel', () => {
    const mock = new MockBriefs({ pollsToFinish: 1 });
    const withheld = StartBriefResponseSchema.parse(mock.create({ question: 'Show me a withheld summary', idempotencyKey: 'key-00000001' }).body);
    mock.read(withheld.briefId);
    expect(BriefStepResponseSchema.parse(mock.read(withheld.briefId).body).result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });

    const abstained = StartBriefResponseSchema.parse(mock.create({ question: 'Show me no match', idempotencyKey: 'key-00000009' }).body);
    mock.read(abstained.briefId);
    expect(BriefStepResponseSchema.parse(mock.read(abstained.briefId).body).result).toMatchObject({
      kind: 'no_match',
      lines: [...NO_MATCH_LINES],
      gaps: [{ ntsbNo: 'NYC08LA106' }],
    });

    for (const [question, kind] of [
      ['Write a poem about clouds', 'out_of_scope'],
      ['My engine is rough, what should I do?', 'operational_advice'],
      ['How many helicopter accidents per year?', 'corpus_statistics'],
      ['Compare DFW08TA066 and NYC08LA106', 'case_comparison'],
      ['Engine failure soon after maintenance', 'needs_clarification'],
    ] as const) {
      const r = mock.create({ question, idempotencyKey: `key-${kind}` });
      expect(r.status).toBe(200);
      expect(StartBriefResponseSchema.parse(r.body)).toMatchObject({ kind: 'scope_reply', reply: { kind } });
    }

    const brief = StartBriefResponseSchema.parse(mock.create({ question: MOCK_SEED_QUESTION, idempotencyKey: 'key-00000002' }).body);
    mock.read(brief.briefId);
    for (let n = 2; n <= 4; n++) {
      const r = mock.refine(brief.briefId, { kind: 'text', text: `Refinement ${n}`, idempotencyKey: `key-refine-${n}` });
      expect(r.status).toBe(202);
      mock.read(brief.briefId);
    }
    const limit = mock.refine(brief.briefId, { kind: 'text', text: 'One more', idempotencyKey: 'key-refine-5' });
    expect([limit.status, ErrorResponseSchema.parse(limit.body).error]).toEqual([409, 'refinement_limit']);
    expect(BriefStepResponseSchema.parse(mock.read(brief.briefId).body)).toMatchObject({ step: 4, steps: 4, refinementsLeft: 0 });

    const running = StartBriefResponseSchema.parse(new MockBriefs().create({ question: MOCK_SEED_QUESTION, idempotencyKey: 'key-00000003' }).body);
    expect(running.kind).toBe('started');
  });
});
