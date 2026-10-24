/**
 * The corpus year range a dataset may serve (task 22 search review S-I1): every search,
 * dashboard and config response carries a year axis bounded by its contract (1900–2100, at
 * most 200 buckets). A cases index whose years fall outside it makes the dataset
 * unavailable once, at load (503 with a log line), instead of failing every response.
 */
import { describe, expect, it } from 'vitest';
import { CoverageSchema } from '../../shared/contracts/config.js';
import { SearchResponseSchema, YearBucketSchema } from '../../shared/contracts/search.js';
import { DatasetUnavailableError, servableYears } from '../../server/dataset.js';

describe('servableYears', () => {
  it('serves a range inside the contracts', () => {
    expect(servableYears(2008, 2026)).toEqual({ from: 2008, to: 2026 });
    expect(servableYears(1901, 2100)).toEqual({ from: 1901, to: 2100 });
    expect(servableYears(2024, 2024)).toEqual({ from: 2024, to: 2024 });
  });

  it('refuses an empty index or a range no response could carry', () => {
    for (const [from, to] of [
      [null, null],
      [undefined, 2026],
      [208, 2026],
      [2008, 20226],
      [1899, 2026],
      [1900, 2100],
      [2026, 2008],
      [2008.5, 2026],
    ] as const) {
      expect(() => servableYears(from as number | null, to as number | null), `${from}-${to}`).toThrow(DatasetUnavailableError);
    }
  });

  it('agrees with the contracts: what it serves they accept, the wider range they refuse', () => {
    const coverage = (from: number, to: number) => ({ defaultCohort: 1, otherRecords: 0, yearFrom: from, yearTo: to, provisional: true });
    const axis = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ year: from + i, completed: 0, other: 0 }));
    const years = SearchResponseSchema.shape.years;
    // The widest range it serves fits both contracts; one more year (1900–2100) does not.
    const served = servableYears(1901, 2100);
    expect(CoverageSchema.safeParse(coverage(served.from, served.to)).success).toBe(true);
    expect(years.safeParse(axis(served.from, served.to)).success).toBe(true);
    expect(years.safeParse(axis(1900, 2100)).success).toBe(false);
    // A year outside 1900–2100 fails a bucket and the coverage alike.
    expect(YearBucketSchema.safeParse({ year: 208, completed: 0, other: 0 }).success).toBe(false);
    expect(CoverageSchema.safeParse(coverage(208, 2026)).success).toBe(false);
  });
});
