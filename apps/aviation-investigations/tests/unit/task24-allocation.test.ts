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
});
