/**
 * DESIGN §9 "Budget": how many briefs the shipped budgets admit, reproduced with the real
 * admission rule (`checkInteractiveBudget`, `toMicros`) and the shipped reservations. A
 * fresh 30-day month in which every brief settles at the estimated typical cost before the
 * next is admitted; unspent allowance rolls into later days. Change the table in DESIGN §9
 * together with this test.
 */
import { describe, expect, it } from 'vitest';
import { RESERVATIONS } from '../../server/ai/pricing.js';
import { checkInteractiveBudget, toMicros, type SpendSnapshot } from '../../server/quota/pacing.js';
import { loadConfig } from '../../shared/config.js';

const budgets = loadConfig({ env: { NODE_ENV: 'test' }, files: [] }).ai.budgets;

/** Briefs admitted on each day of a fresh 30-day month (November 2026). */
function admittedPerDay(reservationUsd: number, typicalUsd: number, who: 'signed-in' | 'anonymous'): number[] {
  const reservation = toMicros(reservationUsd);
  const typical = toMicros(typicalUsd);
  let settledBefore = 0;
  const perDay: number[] = [];
  for (let day = 1; day <= 30; day += 1) {
    const now = new Date(Date.UTC(2026, 10, day, 12));
    let today = 0;
    let n = 0;
    for (;;) {
      const snap: SpendSnapshot = {
        interactive: {
          settledBeforeToday: settledBefore,
          openBeforeToday: 0,
          today,
          anonymousToday: who === 'anonymous' ? today : 0,
          month: settledBefore + today,
        },
        ingestionMonth: 0,
        totalMonth: settledBefore + today,
      };
      const r = checkInteractiveBudget(snap, reservation, budgets, now);
      if (!r.ok || (who === 'anonymous' && !r.anonymousOk)) break;
      today += typical;
      n += 1;
    }
    perDay.push(n);
    settledBefore += today;
  }
  return perDay;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('budget capacity (DESIGN §9)', () => {
  it('ships the budgets the table assumes', () => {
    expect(budgets).toEqual({ monthlyUsd: 100, interactiveMonthlyUsd: 80, interactiveDailyUsd: 3, ingestionMonthlyUsd: 20, anonymousShare: 0.25 });
  });

  it('Opus 5.5 answer model: about 22 a day rising to 25, about 708 a month, 4 to 5 anonymous searches a day', () => {
    const days = admittedPerDay(RESERVATIONS['claude-opus-5-5']!, 0.11, 'signed-in');
    expect([days[0], days.at(-1), Math.min(...days), Math.max(...days)]).toEqual([22, 25, 22, 25]);
    expect(sum(days)).toBe(708);
    const anonymous = admittedPerDay(RESERVATIONS['claude-opus-5-5']!, 0.11, 'anonymous');
    expect([Math.min(...anonymous), Math.max(...anonymous)]).toEqual([4, 5]);
  });

  it('Sonnet 5.5 answer model: about 47 a day rising to 53, about 1,474 a month, 10 to 11 anonymous searches a day', () => {
    const days = admittedPerDay(RESERVATIONS['claude-sonnet-5-5']!, 0.054, 'signed-in');
    expect([days[0], days.at(-1), Math.min(...days), Math.max(...days)]).toEqual([47, 53, 47, 53]);
    expect(sum(days)).toBe(1_474);
    const anonymous = admittedPerDay(RESERVATIONS['claude-sonnet-5-5']!, 0.054, 'anonymous');
    expect([Math.min(...anonymous), Math.max(...anonymous)]).toEqual([10, 11]);
  });

  it('a whole reservation of headroom: nine at once under $3, eight under a fresh month’s paced $2.67', () => {
    const opus = toMicros(RESERVATIONS['claude-opus-5-5']!);
    expect(Math.floor(toMicros(3) / opus)).toBe(9);
    expect(Math.floor(Math.floor(toMicros(80) / 30) / opus)).toBe(8);
  });
});
