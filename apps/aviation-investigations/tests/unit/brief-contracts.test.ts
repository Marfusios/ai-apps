import { describe, expect, it } from 'vitest';
import {
  BriefResultSchema,
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  ComposeOutputSchema,
  CreateBriefRequestSchema,
  RefinementRequestSchema,
  ScopeReplySchema,
  StartBriefResponseSchema,
} from '../../shared/contracts/briefs.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { matchQuote } from '../../server/briefs/validate.js';
import { MockBriefs, MOCK_SEED_QUESTION, RESULT_SAMPLES, SCOPE_REPLY_SAMPLES, seedAnswer } from '../../web/mock/briefs.js';
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
      summary: 'A [[case:DFW08TA066]].',
      groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }],
      cases: [{ ntsbNo: 'DFW08TA066', why: 'w', quotes: [{ passageId: 'p1', quote: 'q', speaker: 'pilot' }] }],
      gaps: [],
    };
    expect(ComposeOutputSchema.safeParse(ok).success).toBe(true);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [] }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, html: '<b>' }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], quotes: [] }] }).success).toBe(false);
    expect(ComposeOutputSchema.safeParse({ ...ok, cases: [{ ...ok.cases[0], timing: '5.1 FH' }] }).success).toBe(false);
  });

  it('the new error codes are part of ErrorResponse', () => {
    for (const error of ['ai_paused', 'trial_used', 'free_searches_paused', 'quota_exhausted', 'in_flight', 'conflict', 'refinement_limit']) {
      expect(ErrorResponseSchema.safeParse({ error, message: 'm' }).success, error).toBe(true);
    }
  });
});

describe('mock briefs (web/mock/briefs.ts)', () => {
  it('every sample satisfies the contracts', () => {
    for (const [name, r] of Object.entries(RESULT_SAMPLES)) expect(BriefResultSchema.safeParse(r).success, name).toBe(true);
    for (const [name, r] of Object.entries(SCOPE_REPLY_SAMPLES)) expect(ScopeReplySchema.safeParse(r).success, name).toBe(true);
  });

  it('every quote is its section text at its span, and passes the quote rule', () => {
    const answer = seedAnswer();
    for (const card of answer.cases) {
      for (const q of card.reading?.quotes ?? []) {
        const section = CASES[card.case.ntsbNo]!.sections.find((s) => `${card.case.ntsbNo}:${s.key}` === q.sectionId)!;
        expect(section.text.slice(q.span.start, q.span.end)).toBe(q.text);
        expect(q.sectionRevision).toBe(section.revision);
        const m = matchQuote(section.text, q.text);
        expect(m).toMatchObject({ ok: true, span: q.span });
      }
    }
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
      if (r.stage === 'done') {
        expect(r.checklist).toEqual({ question: 'in_scope', searched: { cases: 4, passages: 9 }, written: true, verified: 'passed' });
        expect(r.result?.kind).toBe('answer');
      }
    }
    expect(stages).toEqual(['retrieve', 'compose', 'validate', 'validate', 'done']);
    const context = CaseContextResponseSchema.parse(mock.context(s.briefId, 1, 'DEN08LA103').body);
    expect(context.lines.map((l) => l.label)).toEqual(['EVIDENCE', 'MAINTENANCE', 'SYMPTOM', 'TIMING', 'ACCOUNT']);
    expect(context.passages[0]!.highlights).toHaveLength(2);
  });

  it('offers every outcome: withheld, scope replies, refinements up to the limit, cancel', () => {
    const mock = new MockBriefs({ pollsToFinish: 1 });
    const withheld = StartBriefResponseSchema.parse(mock.create({ question: 'Show me a withheld summary', idempotencyKey: 'key-00000001' }).body);
    mock.read(withheld.briefId);
    expect(BriefStepResponseSchema.parse(mock.read(withheld.briefId).body).result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });

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
