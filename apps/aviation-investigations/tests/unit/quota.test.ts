import { describe, expect, it } from 'vitest';
import { bucketRef, nextMonthStart, nextUtcMidnight, utcDay, windowEnd, windowStart } from '../../server/quota/buckets.js';
import {
  budgetMicros,
  checkInteractiveBudget,
  dailyAllowanceUsd,
  microsToNumeric,
  remainingCategoryMicros,
  remainingDaysInMonth,
  toMicros,
  type SpendSnapshot,
} from '../../server/quota/pacing.js';
import {
  DEFAULT_RATE_LIMITS,
  LEASE_TTL_MS,
  PIPELINE_DEADLINE_MS,
  QuotaConfigError,
  QuotaInputError,
  accountIdentityHash,
  assertPolicy,
  canonicalRequestHash,
  networkHash,
  principalHash,
  quotaPolicy,
  type QuotaBudgets,
} from '../../server/quota/policy.js';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { STALE_STEP_MS } from '../../server/briefs/store.js';
import { loadConfig } from '../../shared/config.js';

const BUDGETS: QuotaBudgets = {
  monthlyUsd: 100,
  interactiveMonthlyUsd: 80,
  interactiveDailyUsd: 3,
  ingestionMonthlyUsd: 20,
  anonymousShare: 0.25,
};
const config = loadConfig({ env: {}, files: [] });
const policy = quotaPolicy({ ai: config.ai, auth: { identityHmacSecret: 'i'.repeat(32), ipHmacSecret: 'n'.repeat(32) } });
const TRIAL_ID = '6f1c2b8e-5d4a-4c3b-9a2f-1e0d9c8b7a65';

function snapshot(over: Partial<SpendSnapshot['interactive']> & { ingestionMonth?: number; totalMonth?: number } = {}): SpendSnapshot {
  const interactive = {
    settledBeforeToday: 0,
    openBeforeToday: 0,
    today: 0,
    anonymousToday: 0,
    month: 0,
    ...over,
  };
  return {
    interactive,
    ingestionMonth: over.ingestionMonth ?? 0,
    totalMonth: over.totalMonth ?? interactive.month + (over.ingestionMonth ?? 0),
  };
}

describe('money', () => {
  it('converts USD to whole micro-dollars, rounding charges up and budgets down', () => {
    expect(toMicros(0.14)).toBe(140_000);
    expect(toMicros(0.1 + 0.2)).toBe(300_000);
    expect(toMicros(0.0000001)).toBe(1);
    expect(toMicros(0)).toBe(0);
    expect(budgetMicros(80)).toBe(80_000_000);
    expect(budgetMicros(0.0000019)).toBe(1);
    expect(() => toMicros(-0.01)).toThrow(QuotaInputError);
    expect(() => toMicros(Number.NaN)).toThrow(QuotaInputError);
  });

  it('writes exact numeric literals', () => {
    expect(microsToNumeric(140_000)).toBe('0.140000');
    expect(microsToNumeric(80_000_000)).toBe('80.000000');
    expect(microsToNumeric(5)).toBe('0.000005');
    expect(microsToNumeric(0)).toBe('0.000000');
  });
});

describe('dailyAllowanceUsd', () => {
  const fresh = { settledUsd: 0, unsettledUsd: 0 };

  it('spreads $80 over a fresh 30-day month (about $2.67/day, DESIGN §7)', () => {
    expect(remainingDaysInMonth(new Date('2026-11-01T10:00:00Z'))).toBe(30);
    expect(dailyAllowanceUsd(new Date('2026-11-01T10:00:00Z'), fresh, BUDGETS)).toBe(2.666666);
    expect(dailyAllowanceUsd(new Date('2026-10-01T00:00:00Z'), fresh, BUDGETS)).toBe(2.580645);
  });

  it('never exceeds the $3 daily bound', () => {
    // Last day of the month with everything left: 80 / 1 day.
    expect(remainingDaysInMonth(new Date('2026-11-30T23:59:00Z'))).toBe(1);
    expect(dailyAllowanceUsd(new Date('2026-11-30T23:59:00Z'), fresh, BUDGETS)).toBe(3);
    expect(dailyAllowanceUsd(new Date('2026-11-16T00:00:00Z'), { settledUsd: 30, unsettledUsd: 0 }, BUDGETS)).toBe(3);
  });

  it('subtracts settled spend and the full amount of unsettled reservations', () => {
    // Nov 16: 15 days left. (80 - 44 - 6) / 15 = 2.
    expect(dailyAllowanceUsd(new Date('2026-11-16T08:00:00Z'), { settledUsd: 44, unsettledUsd: 6 }, BUDGETS)).toBe(2);
    expect(dailyAllowanceUsd(new Date('2026-11-16T08:00:00Z'), { settledUsd: 79.5, unsettledUsd: 1 }, BUDGETS)).toBe(0);
  });

  it('handles leap-year February', () => {
    expect(remainingDaysInMonth(new Date('2028-02-01T00:00:00Z'))).toBe(29);
    expect(remainingDaysInMonth(new Date('2027-02-28T12:00:00Z'))).toBe(1);
  });
});

describe('checkInteractiveBudget', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const r = 140_000;

  it('admits within the paced allowance and caps anonymous spend at 25% of it', () => {
    const ok = checkInteractiveBudget(snapshot({ today: 560_000, anonymousToday: 560_000, month: 560_000 }), r, BUDGETS, now);
    expect(ok).toEqual({ ok: true, allowanceMicros: 2_666_666, anonymousOk: false });
    const room = checkInteractiveBudget(snapshot({ today: 420_000, anonymousToday: 420_000, month: 420_000 }), r, BUDGETS, now);
    expect(room).toEqual({ ok: true, allowanceMicros: 2_666_666, anonymousOk: true });
  });

  it('pauses for the day when today would exceed the allowance', () => {
    const v = checkInteractiveBudget(snapshot({ today: 2_600_000, month: 2_600_000 }), r, BUDGETS, now);
    expect(v).toEqual({ ok: false, pause: 'daily_budget', retryAt: new Date('2026-11-02T00:00:00Z') });
  });

  it('pauses for the month on the interactive or the total budget', () => {
    const interactive = checkInteractiveBudget(
      snapshot({ settledBeforeToday: 79_900_000, month: 79_900_000 }),
      r,
      BUDGETS,
      new Date('2026-11-20T10:00:00Z'),
    );
    expect(interactive).toEqual({ ok: false, pause: 'monthly_budget', retryAt: new Date('2026-12-01T00:00:00Z') });
    const total = checkInteractiveBudget(snapshot({ ingestionMonth: 20_000_000, totalMonth: 99_900_000 }), r, BUDGETS, now);
    expect(total).toMatchObject({ ok: false, pause: 'monthly_budget' });
  });

  it('remaining per category stays within the total budget', () => {
    const snap = snapshot({ month: 10_000_000, ingestionMonth: 19_000_000 });
    expect(remainingCategoryMicros(snap, 'indexing', BUDGETS)).toBe(1_000_000);
    expect(remainingCategoryMicros(snap, 'evaluation', BUDGETS)).toBe(1_000_000);
    expect(remainingCategoryMicros(snap, 'interactive', BUDGETS)).toBe(70_000_000);
    expect(remainingCategoryMicros(snap, 'interactive', { ...BUDGETS, monthlyUsd: 35 })).toBe(6_000_000);
  });
});

describe('bucket windows and keys', () => {
  const now = new Date('2026-12-31T23:59:30.500Z');

  it('aligns fixed UTC windows', () => {
    expect(windowStart('minute', now).toISOString()).toBe('2026-12-31T23:59:00.000Z');
    expect(windowStart('hour', now).toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(windowStart('day', now).toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(windowStart('month', now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(windowEnd('month', windowStart('month', now)).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextUtcMidnight(now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextMonthStart(now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(utcDay(now)).toBe('2026-12-31');
  });

  it('keeps buckets until their window ends plus 7 days', () => {
    expect(bucketRef('principal', 'p', 'day', now).expiresAt.toISOString()).toBe('2027-01-08T00:00:00.000Z');
  });

  it('orders lock keys principal, then network, then global', () => {
    const keys = [
      bucketRef('global', 'interactive', 'day', now).key,
      bucketRef('network', 'anonymous:ffff', 'hour', now).key,
      bucketRef('principal', 'ffff', 'minute', now).key,
    ].sort();
    expect(keys.map((k) => k.split('|')[1])).toEqual(['principal', 'network', 'global']);
    for (const k of keys) expect(k).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('policy and hashing', () => {
  it('builds the policy from configuration with the DESIGN §7 defaults', () => {
    expect(policy.limits).toEqual({
      ...DEFAULT_RATE_LIMITS,
      trialRequests: 10,
      accountDailyRequests: 50,
      accountMonthlyRequests: 600,
      newAccountDailyRequests: 20,
      newAccountDays: 3,
      globalInFlight: 2,
    });
    expect(policy.budgets).toEqual(BUDGETS);
    expect(policy.leaseTtlMs).toBe(120_000);
  });

  it('refuses to build without HMAC secrets', () => {
    expect(() => quotaPolicy({ ai: config.ai, auth: {} })).toThrow(QuotaConfigError);
    expect(() => quotaPolicy({ ai: config.ai, auth: { identityHmacSecret: 'short', ipHmacSecret: 'n'.repeat(32) } })).toThrow(
      /IDENTITY_HMAC_SECRET/,
    );
    expect(() => quotaPolicy({ ai: config.ai, auth: { identityHmacSecret: 'i'.repeat(32) } })).toThrow(/IP_HMAC_SECRET/);
  });

  it('fails closed on empty or short secrets, also in policies built by hand', () => {
    for (const secrets of [
      { identity: '', network: 'n'.repeat(32) },
      { identity: 'i'.repeat(32), network: 'n'.repeat(31) },
    ]) {
      const handBuilt = { ...policy, secrets };
      expect(() => assertPolicy(handBuilt)).toThrow(QuotaConfigError);
    }
    const emptyIdentity = { ...policy, secrets: { ...policy.secrets, identity: '' } };
    expect(() => principalHash(emptyIdentity, { kind: 'trial', id: TRIAL_ID })).toThrow(QuotaConfigError);
    const emptyNetwork = { ...policy, secrets: { ...policy.secrets, network: '' } };
    expect(() => networkHash(emptyNetwork, '203.0.113.0')).toThrow(QuotaConfigError);
    expect(() => accountIdentityHash('', 'https://accounts.google.com', '1')).toThrow(QuotaConfigError);
    expect(() => assertPolicy(policy)).not.toThrow();
  });

  it('hashes principals and networks with keyed HMACs', () => {
    const trial = principalHash(policy, { kind: 'trial', id: TRIAL_ID });
    expect(trial).toMatch(/^[0-9a-f]{64}$/);
    expect(trial).not.toContain(TRIAL_ID.replaceAll('-', ''));
    const account = principalHash(policy, {
      kind: 'account',
      issuer: 'https://accounts.google.com',
      subject: '1234567890',
      createdAt: new Date(),
    });
    expect(account).toBe(accountIdentityHash('i'.repeat(32), 'https://accounts.google.com', '1234567890'));
    expect(account).not.toBe(accountIdentityHash('j'.repeat(32), 'https://accounts.google.com', '1234567890'));
    expect(networkHash(policy, '203.0.113.0')).not.toBe(networkHash(policy, '203.0.113.1'));
    expect(() => principalHash(policy, { kind: 'trial', id: 'not-a-uuid' })).toThrow(QuotaInputError);
  });

  it('hashes requests canonically', () => {
    const a = canonicalRequestHash({ question: 'carb icing', filters: { yearFrom: 2010, phase: ['cruise'] } });
    const b = canonicalRequestHash({ filters: { phase: ['cruise'], yearFrom: 2010 }, question: 'carb icing' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalRequestHash({ question: 'carb icing', filters: { phase: ['cruise'], yearFrom: 2011 } })).not.toBe(a);
    expect(canonicalRequestHash({ q: 'x', skip: undefined })).toBe(canonicalRequestHash({ q: 'x' }));
    expect(() => canonicalRequestHash({ n: Number.NaN })).toThrow(QuotaInputError);
    expect(() => canonicalRequestHash({ d: new Date() })).toThrow(QuotaInputError);
  });
});

describe('the pipeline deadline (16c review M7, 16d gate condition 4)', () => {
  it('covers every stage timeout added up, with room for the writes between them, inside the lease and the stale-step limit', () => {
    const { scope, retrieve, compose, check, total } = STAGE_TIMEOUTS;
    expect(total).toBe(PIPELINE_DEADLINE_MS);
    // The check, the calibrated stage, always gets its whole timeout after slow earlier stages.
    expect(scope + retrieve + compose + check).toBeLessThanOrEqual(PIPELINE_DEADLINE_MS - 2_000);
    expect(check).toBe(45_000);
    expect(LEASE_TTL_MS).toBeGreaterThan(PIPELINE_DEADLINE_MS);
    expect(STALE_STEP_MS).toBeGreaterThan(LEASE_TTL_MS);
  });
});
