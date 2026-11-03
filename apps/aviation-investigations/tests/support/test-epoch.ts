/**
 * The clock integration tests inject (T0): 10:00 UTC today, so what they write at it (a
 * brief lives 24 hours) is also live by PostgreSQL's own now(). It moves on a day while the
 * month has 31 days left, which would put the paced allowance (server/quota/pacing.ts) below
 * the one the tests were written with (30 days left on 1 November), or while T0 + 24 hours,
 * a brief's expiry, would fall in the next month.
 */
export function testEpoch(now: Date = new Date()): Date {
  const t0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10));
  while (daysLeftInMonth(t0) === 31 || daysLeftInMonth(t0) === 1) t0.setUTCDate(t0.getUTCDate() + 1);
  return t0;
}

/** Days left in the UTC month of `d`, its own day included. */
function daysLeftInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1;
}
