import { describe, it, expect } from 'vitest';
import { checkAllocation, type Totals } from '../../evals/search-quality/money.js';
const totals = (chargedMicros = 0, openMicros = 0): Totals => ({ chargedMicros, openMicros, open: Number(openMicros > 0), ledgerMicros: chargedMicros, reservations: Number(chargedMicros > 0) });
describe('Task 24 cumulative allocation, all phases and providers', () => {
  it('rejects crossing the task cap even when this phase has room', () => {
    expect(() => checkAllocation(totals(29_999_000), totals(), 'fields', 2413)).toThrow('$30');
  });
  it('rejects crossing the field cap even when the task has room', () => {
    expect(() => checkAllocation(totals(2_999_000), totals(2_999_000), 'fields', 2413)).toThrow('phase');
  });
  it('does not erase an open or uncertain liability on resume', () => {
    expect(() => checkAllocation(totals(0, 2413), totals(), 'selection', 1)).toThrow('Unresolved');
    expect(() => checkAllocation(totals(30_000_000), totals(3_000_000), 'fields', 1)).toThrow('$30');
  });
  it('refuses inconsistent or invalid accounting', () => {
    expect(() => checkAllocation({ ...totals(5), ledgerMicros: 0 }, totals(), 'fields', 2413)).toThrow('disagree');
    expect(() => checkAllocation(totals(), totals(), 'fields', 0)).toThrow('Invalid');
    expect(() => checkAllocation(totals(Number.NaN), totals(), 'fields', 1)).toThrow('Invalid');
  });
  it('admits the complete registered field block and respects exact boundary arithmetic', () => {
    expect(() => checkAllocation(totals(), totals(), 'fields', 1040 * 2413)).not.toThrow();
    expect(() => checkAllocation(totals(29_997_587), totals(2_997_587), 'fields', 2413)).not.toThrow();
  });
  it('keeps Part 5 caps separate while counting every earlier Task 24 charge', () => {
    expect(() => checkAllocation(totals(1_859_745), totals(), 'fields_c2', 1600 * 2413)).not.toThrow();
    expect(() => checkAllocation(totals(1_859_745), totals(), 'confirmation2', 7_728_000)).not.toThrow();
    expect(() => checkAllocation(totals(1_859_745), totals(), 'confirmation2', 8_000_001)).toThrow('phase');
    expect(() => checkAllocation(totals(1_859_745), totals(), 'fields_c2', 5_000_001)).toThrow('phase');
    expect(() => checkAllocation(totals(29_999_999), totals(), 'fields_c2', 2)).toThrow('$30');
  });
});
