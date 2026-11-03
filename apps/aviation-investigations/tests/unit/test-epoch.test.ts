import { describe, expect, it } from 'vitest';
import { testEpoch } from '../support/test-epoch.js';

const DAY = 86_400_000;
const epochOn = (iso: string) => testEpoch(new Date(iso)).toISOString();

/** The days `testEpoch` skips, checked without its own arithmetic. */
const lastOfMonth = (d: Date) => new Date(d.getTime() + DAY).getUTCDate() === 1;
const firstOf31DayMonth = (d: Date) => d.getUTCDate() === 1 && new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 31)).getUTCDate() === 31;
const skipped = (d: Date) => lastOfMonth(d) || firstOf31DayMonth(d);

describe('testEpoch: 10:00 UTC today, or on the next day that keeps the calendar assumptions', () => {
  it('an ordinary day, before and after 10:00 UTC', () => {
    expect(epochOn('2026-11-03T00:00:00.000Z')).toBe('2026-11-03T10:00:00.000Z');
    expect(epochOn('2026-11-03T09:59:59.999Z')).toBe('2026-11-03T10:00:00.000Z');
    expect(epochOn('2026-11-03T10:00:00.001Z')).toBe('2026-11-03T10:00:00.000Z');
    expect(epochOn('2026-11-03T23:59:59.999Z')).toBe('2026-11-03T10:00:00.000Z');
  });

  it('the 1st of a 31-day month moves to the 2nd; the 1st of a shorter month stays', () => {
    expect(epochOn('2026-12-01T00:00:00.000Z')).toBe('2026-12-02T10:00:00.000Z');
    expect(epochOn('2027-01-01T15:00:00.000Z')).toBe('2027-01-02T10:00:00.000Z');
    expect(epochOn('2026-11-01T00:00:00.000Z')).toBe('2026-11-01T10:00:00.000Z');
    expect(epochOn('2027-02-01T15:00:00.000Z')).toBe('2027-02-01T10:00:00.000Z');
  });

  it('the last day of a month moves on to the first day that is neither', () => {
    // November has 30 days: its 1st is kept.
    expect(epochOn('2026-10-31T12:00:00.000Z')).toBe('2026-11-01T10:00:00.000Z');
    // December has 31: its 1st is skipped too.
    expect(epochOn('2026-11-30T12:00:00.000Z')).toBe('2026-12-02T10:00:00.000Z');
    expect(epochOn('2027-01-31T12:00:00.000Z')).toBe('2027-02-01T10:00:00.000Z');
  });

  it('28 February is the last day in a common year, 29 February in a leap year', () => {
    expect(epochOn('2027-02-28T12:00:00.000Z')).toBe('2027-03-02T10:00:00.000Z');
    expect(epochOn('2028-02-28T12:00:00.000Z')).toBe('2028-02-28T10:00:00.000Z');
    expect(epochOn('2028-02-29T12:00:00.000Z')).toBe('2028-03-02T10:00:00.000Z');
  });

  it('31 December moves into the next year', () => {
    expect(epochOn('2026-12-31T23:30:00.000Z')).toBe('2027-01-02T10:00:00.000Z');
  });

  it('every day of 2026 to 2029: 10:00 UTC on the first day from today that is not skipped', () => {
    for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2030, 0, 1); day += DAY) {
      const t0 = testEpoch(new Date(day + 17 * 3_600_000));
      const label = new Date(day).toISOString().slice(0, 10);
      expect(t0.getTime() % DAY, label).toBe(10 * 3_600_000);
      expect(skipped(t0), label).toBe(false);
      const start = day + 10 * 3_600_000;
      expect(t0.getTime() >= start && t0.getTime() <= start + 2 * DAY, label).toBe(true);
      for (let earlier = start; earlier < t0.getTime(); earlier += DAY) expect(skipped(new Date(earlier)), label).toBe(true);
    }
  });
});
