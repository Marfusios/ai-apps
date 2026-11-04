import { describe, expect, it, vi } from 'vitest';
import { fieldAttempt } from '../../evals/search-quality/fields.js';
import { scoreFields } from '../../evals/search-quality/field-score.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { StageError, type LlmProvider } from '../../server/ai/provider.js';
import type { FieldQuestion, FieldDataset, FieldObservation } from '../../evals/search-quality/types.js';
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const question: FieldQuestion = { id: 'synthetic-state-1', field: 'state', role: 'positive', critical: false,
  wordingFamily: 'synthetic', aircraft: [],
  seed: { ntsb_no: 'SYNTHETIC', state: 'AK', ev_year: 2020, highest_injury: null,
    wx_cond_basic: null, light_cond: null, source_revision: 'synthetic' },
  question: 'Find investigations in Alaska or California.', gold: { state: ['AK', 'CA'] } };
const observation = { id: question.id, output: { intent: 'case_search', filters: { state: ['AK'] }, terms: 'investigations' },
  error: null, elapsedMs: 1, reservationId: '1', chargedUsd: 0, usage } as FieldObservation;

describe('field runner and exact-field scoring', () => {
  it('settles a successful call and never sends a second attempt', async () => {
    const call = vi.fn(async () => ({ output: { intent: 'case_search', filters: { state: ['AK', 'CA'] }, terms: 'investigations' },
      usage, provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'scope.e3', stopReason: 'end_turn', warnings: [] }));
    const gate = createMemorySpendGate(3), journal: any[] = [];
    await fieldAttempt(question, { evidenceScope: call } as unknown as LlmProvider, gate, .002413, r => journal.push(r));
    expect(call).toHaveBeenCalledTimes(1);
    expect(gate.records[0]!.status).toBe('settled');
    expect(gate.records[0]!.chargedUsd).toBeLessThan(.002413);
    expect(journal.map(r => r.event)).toEqual(['dispatch', 'result', 'settled']);
  });
  it('charges uncertain delivery in full without serializing exception details or retrying', async () => {
    const call = vi.fn(async () => { throw new Error('sensitive-example-value'); });
    const gate = createMemorySpendGate(3), journal: unknown[] = [];
    const r = await fieldAttempt(question, { evidenceScope: call } as unknown as LlmProvider, gate, .002413, v => journal.push(v));
    expect(r.chargedUsd).toBe(.002413);
    expect(gate.records[0]!.status).toBe('uncertain');
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(journal)).not.toContain('sensitive-example-value');
  });
  it('retains usage on a rejected structured response', async () => {
    const call = vi.fn(async () => { throw new StageError('invalid_output', { stage: 'scope', provider: 'anthropic', model: 'claude-haiku-5-5',
      promptVersion: 'scope.e3', billing: { kind: 'usage', usage } }); });
    const gate = createMemorySpendGate(3);
    const r = await fieldAttempt(question, { evidenceScope: call } as unknown as LlmProvider, gate, .002413, () => {});
    expect(r.output).toBeNull(); expect(r.usage).toEqual(usage);
    expect(r.error).toBe('invalid_output'); expect(gate.records[0]!.status).toBe('settled');
  });
  it('does not dispatch when the gate refuses', async () => {
    const call = vi.fn();
    await expect(fieldAttempt(question, { evidenceScope: call } as unknown as LlmProvider, createMemorySpendGate(0), .002413, () => {})).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it('partial OR is a raw FP and FN; the guard abstains and retains the FN', () => {
    const m = scoreFields({ questions: [question] } as FieldDataset, [observation]);
    expect(m.raw.state).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(m.guardedState).toMatchObject({ tp: 0, fp: 0, fn: 1 });
    expect(m.clearsState).toBe(false);
  });
  it('invalid output is an omission, never a precision success', () => {
    const m = scoreFields({ questions: [question] } as FieldDataset, [{ ...observation, error: 'invalid_output', output: null }]);
    expect(m.raw.state).toMatchObject({ fp: 0, fn: 1, precision: { rate: null }, failures: 1 });
  });
});
