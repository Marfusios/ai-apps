import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { utcDay } from '../../server/quota/buckets.js';
import {
  admitPaidRequest,
  aiStatus,
  canonicalRequestHash,
  createTrialIdentity,
  dailyAllowanceUsd,
  expireLeases,
  forgetIdempotency,
  pruneControls,
  quotaPolicy,
  recordAttempt,
  rejectionStatus,
  releaseQuota,
  remainingCategoryUsd,
  reserveSpend,
  setAiSwitch,
  setResultRef,
  settle,
  settleReservation,
  settleSpend,
  UnknownPrincipalError,
  type Admission,
  type AdmissionResult,
  type Principal,
  type QuotaPolicy,
  type SpendReservation,
} from '../../server/quota/index.js';
import { SPEND_LOCK_KEY, principalHash } from '../../server/quota/policy.js';
import { loadConfig } from '../../shared/config.js';
import { sqlState } from './corpus-helpers.js';
import { resetControls, testDb, testDbUrl, testPool } from './helpers.js';

const POLICY = quotaPolicy({
  ai: loadConfig({ env: {}, files: [] }).ai,
  auth: { identityHmacSecret: 'test-identity-hmac-secret-0123456789', ipHmacSecret: 'test-network-hmac-secret-0123456789' },
});
const BUDGETS = POLICY.budgets;
const RESERVATION = 0.14;
/** A fresh 30-day month: the paced allowance is 80 / 30 = $2.666666. */
const T0 = new Date('2026-11-01T10:00:00Z');
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let app: Db;
let wide: Db;
let ingest: Db;
let wideIngest: Db;
let migrator: Db;

beforeAll(() => {
  app = testDb('app');
  wide = createDb(testDbUrl('app'), { max: 10, applicationName: 'aviation-test-quota-wide' });
  ingest = testDb('ingest');
  wideIngest = createDb(testDbUrl('ingest'), { max: 6, applicationName: 'aviation-test-quota-wide' });
  migrator = testDb('migrator');
});

afterAll(async () => {
  await Promise.all([closeDb(app), closeDb(wide), closeDb(ingest), closeDb(wideIngest), closeDb(migrator)]);
});

beforeEach(async () => {
  await resetControls();
});

let keySeq = 0;
const newKey = () => `test-key-${++keySeq}`;
const bodyHash = (question: string) => canonicalRequestHash({ question });

async function newTrial(used = 0, now = T0): Promise<Extract<Principal, { kind: 'trial' }>> {
  const t = await createTrialIdentity(app, POLICY, randomBytes(32).toString('hex'), now);
  if (used > 0) await migrator.execute(sql`UPDATE trial_identities SET requests_used = ${used} WHERE id = ${t.id}::uuid`);
  return { kind: 'trial', id: t.id };
}

const account = (subject: string, createdAt = new Date('2026-01-01T00:00:00Z')): Principal => ({
  kind: 'account',
  issuer: 'https://accounts.google.com',
  subject,
  createdAt,
});

interface AdmitOptions {
  now?: Date;
  net?: string;
  key?: string;
  question?: string;
  db?: Db;
  policy?: QuotaPolicy;
}

function admit(principal: Principal, o: AdmitOptions = {}): Promise<AdmissionResult> {
  return admitPaidRequest(o.db ?? app, {
    policy: o.policy ?? POLICY,
    principal,
    networkId: o.net ?? 'net-a',
    idempotencyKey: o.key ?? newKey(),
    requestHash: bodyHash(o.question ?? 'carburetor icing in cruise'),
    reservationUsd: RESERVATION,
    now: o.now ?? T0,
  });
}

function admitted(r: AdmissionResult): Admission {
  if (!r.ok || r.replay) throw new Error(`expected a fresh admission, got ${JSON.stringify(r)}`);
  return r;
}

async function trialUsed(p: Principal): Promise<number> {
  if (p.kind !== 'trial') throw new Error('not a trial');
  const res = await migrator.execute(sql`SELECT requests_used FROM trial_identities WHERE id = ${p.id}::uuid`);
  return (res.rows[0] as { requests_used: number }).requests_used;
}

async function ledger(reservationId: number): Promise<{ stage: string; usd: string; uncertain: boolean }[]> {
  const res = await migrator.execute(
    sql`SELECT stage, usd::text AS usd, uncertain FROM cost_ledger WHERE reservation_id = ${reservationId} ORDER BY id`,
  );
  return res.rows as { stage: string; usd: string; uncertain: boolean }[];
}

/** Charge settled interactive spend on a given day (test setup for budgets). */
async function chargeInteractive(day: Date, usd: number, kind: 'trial' | 'account' = 'account'): Promise<void> {
  const res = await app.execute(sql`
    INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day, created_at)
    VALUES ('interactive', ${kind}, ${'a'.repeat(64)}, ${usd}, 'open', ${at(day, 90_000)}, ${utcDay(day)}::date, ${day})
    RETURNING id, fencing_token::text AS token`);
  const row = res.rows[0] as { id: number; token: string };
  const settled = await settleReservation(app, Number(row.id), usd, row.token, day);
  expect(settled.ok).toBe(true);
}

describe('admission is atomic', () => {
  it('two concurrent admissions with one trial search left: exactly one admitted', async () => {
    const trial = await newTrial(2);
    const results = await Promise.all([admit(trial, { db: wide }), admit(trial, { db: wide })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'concurrency' });
    expect(await trialUsed(trial)).toBe(3);
  });

  it('a request in flight is reported as concurrency, not as the quota it holds', async () => {
    const opts = { policy: POLICY, reservationUsd: RESERVATION };
    const trial = await newTrial(2);
    const last = admitted(await admit(trial));
    expect(await admit(trial, { now: at(T0, 5_000) })).toEqual({ ok: false, reason: 'concurrency' });
    expect(await aiStatus(app, trial, { ...opts, now: at(T0, 5_000) })).toEqual({
      state: 'available',
      remaining: { kind: 'trial', left: 0, limit: 3 },
    });
    // Off-topic: the search comes back.
    await releaseQuota(app, last, last.fencingToken, { policy: POLICY, now: at(T0, 6_000) });
    await settle(app, last, 0.0002, last.fencingToken, at(T0, 7_000));
    expect(await aiStatus(app, trial, { ...opts, now: at(T0, 8_000) })).toEqual({
      state: 'available',
      remaining: { kind: 'trial', left: 1, limit: 3 },
    });
    // Counted: only now is the trial used up.
    const counted = admitted(await admit(trial, { now: at(T0, MIN) }));
    expect(await aiStatus(app, trial, { ...opts, now: at(T0, MIN + 1_000) })).toMatchObject({ state: 'available' });
    await settle(app, counted, 0.09, counted.fencingToken, at(T0, MIN + 20_000));
    expect(await admit(trial, { now: at(T0, 2 * MIN) })).toEqual({ ok: false, reason: 'trial_exhausted' });
    expect(await aiStatus(app, trial, { ...opts, now: at(T0, 2 * MIN) })).toMatchObject({
      state: 'signed_in_only',
      reason: 'trial_used',
    });

    // The same for an account at its daily cap.
    const p = account('busy-new', at(T0, -DAY));
    for (let i = 0; i < 4; i++) {
      const a = admitted(await admit(p, { now: at(T0, i * MIN) }));
      await settle(app, a, 0.01, a.fencingToken, at(T0, i * MIN + 1_000));
    }
    const fifth = admitted(await admit(p, { now: at(T0, 4 * MIN) }));
    expect(await admit(p, { now: at(T0, 4 * MIN + 1_000) })).toEqual({ ok: false, reason: 'concurrency' });
    expect(await aiStatus(app, p, { ...opts, now: at(T0, 4 * MIN + 1_000) })).toMatchObject({ state: 'available' });
    await settle(app, fifth, 0.01, fifth.fencingToken, at(T0, 4 * MIN + 2_000));
    expect(await admit(p, { now: at(T0, 5 * MIN) })).toMatchObject({ ok: false, reason: 'daily_cap' });
    expect(await aiStatus(app, p, { ...opts, now: at(T0, 5 * MIN) })).toMatchObject({ state: 'paused', reason: 'daily_cap' });
  });

  it('the last trial search goes to one request even when concurrency limits would allow more', async () => {
    const loose: QuotaPolicy = {
      ...POLICY,
      limits: { ...POLICY.limits, principalInFlight: 8, anonymousInFlight: 8, globalInFlight: 8, anonymousPerMinute: 20 },
    };
    const trial = await newTrial(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => admit(trial, { db: wide, policy: loose })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.reason))).toEqual(Array(5).fill('trial_exhausted'));
    expect(await trialUsed(trial)).toBe(3);
  });

  it('concurrent admissions from many principals never exceed the in-flight limits', async () => {
    const principals = [
      ...(await Promise.all([newTrial(), newTrial(), newTrial()])),
      account('c1'),
      account('c2'),
      account('c3'),
    ];
    const results = await Promise.all(
      principals.flatMap((p, i) => [admit(p, { db: wide, net: `net-${i % 2}` }), admit(p, { db: wide, net: `net-${i % 2}` })]),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(2);
    const leases = await migrator.execute(
      sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE anonymous)::int AS anon FROM leases WHERE released_at IS NULL`,
    );
    const row = leases.rows[0] as { n: number; anon: number };
    expect(row.n).toBe(2);
    expect(row.anon).toBeLessThanOrEqual(1);
    for (const r of results) if (!r.ok) expect(r.reason).toBe('concurrency');
  });

  it('mixed concurrent admissions, releases, settlements and sweeps neither deadlock nor lose counts', async () => {
    const loose: QuotaPolicy = {
      ...POLICY,
      limits: { ...POLICY.limits, globalInFlight: 6, anonymousInFlight: 3, anonymousPerMinute: 50, accountPerMinute: 50 },
    };
    const principals: Principal[] = [
      ...(await Promise.all([newTrial(), newTrial(), newTrial()])),
      account('m1'),
      account('m2'),
      account('m3'),
    ];
    let released = 0;
    const run = async (p: Principal, i: number) => {
      let admittedCount = 0;
      for (let round = 0; round < 4; round++) {
        const now = at(T0, round * MIN + i * 1_000);
        const net = `net-${i % 2}`;
        const r = await admitPaidRequest(wide, {
          policy: loose,
          principal: p,
          networkId: net,
          idempotencyKey: newKey(),
          requestHash: bodyHash(`q${round}`),
          reservationUsd: RESERVATION,
          now,
        });
        if (!r.ok || r.replay) continue;
        admittedCount++;
        if (round % 2 === 1) {
          const release = await releaseQuota(wide, r, r.fencingToken, { policy: POLICY, now: at(now, 100) });
          expect(release).toEqual({ released: true });
          released++;
        }
        // Sweeps two minutes ahead race with settlements of the same and other reservations.
        const sweep = expireLeases(wide, at(now, 2 * MIN));
        const attempt = recordAttempt(wide, { policy: loose, principal: p, networkId: net, now });
        if (round === 2 && p.kind === 'account') {
          await Promise.all([sweep, attempt]); // abandoned: only a sweep closes it
          continue;
        }
        const settled = settle(wide, r, round === 3 ? 'uncertain' : 0.02, r.fencingToken, at(now, 200));
        const [result] = await Promise.all([settled, sweep, attempt]);
        if (!result.ok) expect(result).toMatchObject({ reason: 'not_open', status: 'expired_charged' });
      }
      return admittedCount;
    };
    const counts = await Promise.all(principals.map((p, i) => run(p, i)));
    await expireLeases(app, at(T0, HOUR));
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(principals.length);
    const state = await migrator.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE quota_counted)::int AS counted,
        count(*)::int AS reservations,
        (SELECT count(DISTINCT reservation_id)::int FROM cost_ledger) AS charged,
        (SELECT count(*)::int FROM leases WHERE released_at IS NULL) AS leases
      FROM reservations`);
    expect(state.rows[0]).toEqual({ open: 0, counted: total - released, reservations: total, charged: total, leases: 0 });
    // Each principal's quota counter equals its admissions that kept their unit.
    for (const p of principals) {
      const hash = principalHash(POLICY, p);
      const kept = await migrator.execute(
        sql`SELECT count(*)::int AS n FROM reservations WHERE quota_counted AND principal_hash = ${hash}`,
      );
      const n = (kept.rows[0] as { n: number }).n;
      if (p.kind === 'trial') {
        expect(await trialUsed(p)).toBe(n);
      } else {
        const day = await migrator.execute(
          sql`SELECT requests FROM usage_buckets WHERE scope = 'principal' AND period = 'day' AND subject = ${hash}`,
        );
        expect(day.rows).toEqual([{ requests: n }]);
      }
    }
  });

  it('global concurrency is 2 with at most 1 anonymous, and one in flight per principal', async () => {
    const [ta, tb] = await Promise.all([newTrial(), newTrial()]);
    const a = admitted(await admit(ta));
    expect(await admit(tb)).toEqual({ ok: false, reason: 'concurrency' });
    const x = admitted(await admit(account('x')));
    expect(await admit(account('y'))).toEqual({ ok: false, reason: 'concurrency' });

    expect((await settle(app, a, 0.05, a.fencingToken, at(T0, 5_000))).ok).toBe(true);
    const b = admitted(await admit(tb, { now: at(T0, 6_000) }));
    expect(await admit(account('y'), { now: at(T0, 7_000) })).toEqual({ ok: false, reason: 'concurrency' });

    await settle(app, x, 0.05, x.fencingToken, at(T0, 8_000));
    const y = admitted(await admit(account('y'), { now: at(T0, 9_000) }));
    expect(await admit(account('y'), { now: at(T0, 10_000) })).toEqual({ ok: false, reason: 'concurrency' });
    expect(rejectionStatus({ ok: false, reason: 'concurrency' })).toBe(429);
    await settle(app, b, 0.05, b.fencingToken, at(T0, 11_000));
    await settle(app, y, 0.05, y.fencingToken, at(T0, 11_000));
  });

  it('an expired lease frees its slot but not its money', async () => {
    const p = account('slow');
    const a = admitted(await admit(p));
    expect(await admit(p, { now: at(T0, 30_000) })).toEqual({ ok: false, reason: 'concurrency' });
    const later = at(a.leaseExpiresAt, 1);
    admitted(await admit(p, { now: later }));
    // Both reservations still count in full; nothing was swept or refunded.
    expect(await remainingCategoryUsd(app, 'interactive', later, BUDGETS)).toBeCloseTo(80 - 2 * RESERVATION, 6);
  });

  it('refuses an unknown or expired trial identity', async () => {
    await expect(admit({ kind: 'trial', id: randomUUID() })).rejects.toBeInstanceOf(UnknownPrincipalError);
    const trial = await newTrial(0, new Date('2026-09-01T00:00:00Z'));
    await expect(admit(trial, { now: T0 })).rejects.toBeInstanceOf(UnknownPrincipalError);
  });
});

describe('budgets', () => {
  it('anonymous share 25% of paced daily allowance', async () => {
    const allowance = dailyAllowanceUsd(T0, { settledUsd: 0, unsettledUsd: 0 }, BUDGETS);
    expect(allowance).toBe(2.666666);
    // 25% is $0.666666: four $0.14 trial requests fit ($0.56), a fifth ($0.70) does not.
    for (let i = 0; i < 4; i++) {
      const a = admitted(await admit(await newTrial(), { now: at(T0, i * MIN) }));
      expect(await settle(app, a, 'uncertain', a.fencingToken, at(T0, i * MIN + 1_000))).toEqual({
        ok: true,
        chargedUsd: RESERVATION,
        uncertain: true,
      });
    }
    const fifth = await newTrial();
    expect(await admit(fifth, { now: at(T0, 5 * MIN) })).toEqual({
      ok: false,
      reason: 'anonymous_share_exhausted',
      retryAt: new Date('2026-11-02T00:00:00Z'),
    });
    expect(await trialUsed(fifth)).toBe(0);
    // Signed-in users can still use the rest of the allowance.
    admitted(await admit(account('signed-in'), { now: at(T0, 5 * MIN) }));
    expect(await aiStatus(app, fifth, { policy: POLICY, reservationUsd: RESERVATION, now: at(T0, 6 * MIN) })).toEqual({
      state: 'signed_in_only',
      reason: 'anonymous_share',
      retryAt: new Date('2026-11-02T00:00:00Z'),
      remaining: { kind: 'trial', left: 3, limit: 3 },
    });
  });

  it('the anonymous share follows pacing after earlier spend', async () => {
    // Nov 16, 15 days left: (80 - 50) / 15 = $2.00, so anonymous spend is capped at $0.50.
    const now = new Date('2026-11-16T09:00:00Z');
    await chargeInteractive(new Date('2026-11-10T12:00:00Z'), 50);
    expect(dailyAllowanceUsd(now, { settledUsd: 50, unsettledUsd: 0 }, BUDGETS)).toBe(2);
    for (let i = 0; i < 3; i++) {
      const a = admitted(await admit(await newTrial(), { now: at(now, i * MIN) }));
      await settle(app, a, 'uncertain', a.fencingToken, at(now, i * MIN + 1_000));
    }
    expect(await admit(await newTrial(), { now: at(now, 4 * MIN) })).toMatchObject({
      ok: false,
      reason: 'anonymous_share_exhausted',
    });
  });

  it('pauses everyone for the day, then for the month', async () => {
    await chargeInteractive(T0, 2.6);
    const daily = await admit(account('u'), { now: at(T0, MIN) });
    expect(daily).toEqual({
      ok: false,
      reason: 'global_paused',
      pause: 'daily_budget',
      retryAt: new Date('2026-11-02T00:00:00Z'),
    });
    if (daily.ok) throw new Error('unreachable');
    expect(rejectionStatus(daily)).toBe(503);

    const late = new Date('2026-11-25T10:00:00Z');
    await chargeInteractive(new Date('2026-11-20T10:00:00Z'), 77.3);
    expect(await admit(account('u'), { now: late })).toEqual({
      ok: false,
      reason: 'global_paused',
      pause: 'monthly_budget',
      retryAt: new Date('2026-12-01T00:00:00Z'),
    });
  });

  it('kill switch pauses AI with reason maintenance', async () => {
    const trial = await newTrial();
    await setAiSwitch(ingest, false, 'provider incident');
    expect(await admit(trial)).toEqual({ ok: false, reason: 'global_paused', pause: 'maintenance' });
    expect(await trialUsed(trial)).toBe(0);
    const buckets = await migrator.execute(sql`SELECT count(*)::int AS n FROM usage_buckets`);
    expect((buckets.rows[0] as { n: number }).n).toBe(0);
    expect(await aiStatus(app, trial, { policy: POLICY, reservationUsd: RESERVATION, now: T0 })).toEqual({
      state: 'paused',
      reason: 'maintenance',
      remaining: { kind: 'trial', left: 3, limit: 3 },
    });
    // Only the operator role flips it.
    expect(await sqlState(setAiSwitch(app, true))).toBe('42501');
    await setAiSwitch(ingest, true);
    admitted(await admit(trial));
  });
});

describe('settlement', () => {
  it('uncertain settles at reservation and is never refunded on lease expiry', async () => {
    const p = account('u');
    const a = admitted(await admit(p));
    expect(await settle(app, a, 'uncertain', a.fencingToken, at(T0, 5_000))).toEqual({
      ok: true,
      chargedUsd: RESERVATION,
      uncertain: true,
    });
    expect(await expireLeases(app, at(T0, 10 * MIN))).toEqual({ expired: 0, chargedUsd: 0 });
    expect(await ledger(a.reservationId)).toEqual([{ stage: 'uncertain', usd: '0.140000', uncertain: true }]);

    // A lease that expires before settlement is charged in full and stays charged. (Another
    // account: one reservation of uncertain charges stops `p` for the day, gate 22 AI I1.)
    expect(await admit(p, { now: at(T0, MIN) })).toMatchObject({ ok: false, reason: 'uncertain_limit' });
    const b = admitted(await admit(account('u2'), { now: at(T0, MIN) }));
    expect(await expireLeases(app, b.leaseExpiresAt)).toEqual({ expired: 1, chargedUsd: RESERVATION });
    expect(await settle(app, b, 0.01, b.fencingToken, at(b.leaseExpiresAt, 1_000))).toEqual({
      ok: false,
      reason: 'not_open',
      status: 'expired_charged',
    });
    expect(await ledger(b.reservationId)).toEqual([{ stage: 'lease_expired', usd: '0.140000', uncertain: true }]);

    // A settlement arriving after the lease ran out (before any sweep) charges the full amount too.
    const c = admitted(await admit(account('u3'), { now: at(T0, 2 * MIN) }));
    expect(await settle(app, c, 0.01, c.fencingToken, c.leaseExpiresAt)).toEqual({
      ok: false,
      reason: 'lease_expired',
      status: 'expired_charged',
      chargedUsd: RESERVATION,
    });
    expect(await expireLeases(app, at(T0, HOUR))).toEqual({ expired: 0, chargedUsd: 0 });
    expect(await remainingCategoryUsd(app, 'interactive', at(T0, HOUR), BUDGETS)).toBeCloseTo(80 - 3 * RESERVATION, 6);
  });

  it('itemized usage marked uncertain keeps known lines and charges the rest of the reservation', async () => {
    const a = admitted(await admit(account('u')));
    const r = await settle(
      app,
      a,
      {
        lines: [
          {
            usd: 0.0002,
            provider: 'anthropic',
            model: 'claude-haiku-5-5',
            stage: 'scope',
            tokens: { input: 1300, output: 160, cacheWrite: 0, cacheRead: 0 },
          },
        ],
        uncertain: true,
      },
      a.fencingToken,
      at(T0, 30_000),
    );
    expect(r).toEqual({ ok: true, chargedUsd: RESERVATION, uncertain: true });
    expect(await ledger(a.reservationId)).toEqual([
      { stage: 'scope', usd: '0.000200', uncertain: false },
      { stage: 'uncertain', usd: '0.139800', uncertain: true },
    ]);
    const tokens = await migrator.execute(sql`SELECT tokens FROM cost_ledger WHERE stage = 'scope'`);
    expect((tokens.rows[0] as { tokens: unknown }).tokens).toEqual({ input: 1300, output: 160, cacheWrite: 0, cacheRead: 0 });
  });

  it('a call whose usage is not known is charged at its own worst case, never more than the reservation leaves (gate 22 AI I1)', async () => {
    const reservationRow = async (id: number) =>
      (await migrator.execute(sql`SELECT charged_usd::text AS charged, uncertain FROM reservations WHERE id = ${id}`)).rows[0];
    const known = { usd: 0.0002, provider: 'anthropic', model: 'claude-haiku-5-5', stage: 'scope' };
    const a = admitted(await admit(account('u')));
    const r = await settle(
      app,
      a,
      { lines: [known, { usd: 0.05, provider: 'anthropic', model: 'claude-opus-5-5', stage: 'compose', uncertain: true }] },
      a.fencingToken,
      at(T0, 30_000),
    );
    expect(r).toEqual({ ok: true, chargedUsd: 0.0502, uncertain: true });
    expect(await ledger(a.reservationId)).toEqual([
      { stage: 'scope', usd: '0.000200', uncertain: false },
      { stage: 'compose', usd: '0.050000', uncertain: true },
    ]);
    // Not charged in full, so the reservation itself is not marked uncertain (migration 0009
    // holds a reservation marked uncertain to at least its amount).
    expect(await reservationRow(a.reservationId)).toEqual({ charged: '0.050200', uncertain: false });

    // Uncertain lines never take the charge past the reservation: then it is charged in full.
    const b = admitted(await admit(account('v'), { now: at(T0, MIN) }));
    expect(
      await settle(
        app,
        b,
        { lines: [{ ...known, usd: 0.1 }, { usd: 0.03, stage: 'check', uncertain: true }, { usd: 0.03, stage: 'compose', uncertain: true }] },
        b.fencingToken,
        at(T0, MIN + 30_000),
      ),
    ).toEqual({ ok: true, chargedUsd: RESERVATION, uncertain: true });
    expect(await ledger(b.reservationId)).toEqual([
      { stage: 'scope', usd: '0.100000', uncertain: false },
      { stage: 'check', usd: '0.030000', uncertain: true },
      { stage: 'compose', usd: '0.010000', uncertain: true },
    ]);
    expect(await reservationRow(b.reservationId)).toEqual({ charged: '0.140000', uncertain: true });
  });

  it('a principal whose uncertain charges today reach one reservation is refused until UTC midnight (gate 22 AI I1)', async () => {
    const uncertainCall = (usd: number) => ({ lines: [{ usd, stage: 'compose', uncertain: true }] });
    const p = account('u');
    const first = admitted(await admit(p));
    await settle(app, first, uncertainCall(0.1), first.fencingToken, at(T0, 30_000));
    // Below one reservation ($0.14): admitted.
    const second = admitted(await admit(p, { now: at(T0, MIN) }));
    await settle(app, second, uncertainCall(0.05), second.fencingToken, at(T0, MIN + 30_000));
    // $0.15 of uncertain charges today: refused until midnight, as an exhausted daily quota.
    const refused = await admit(p, { now: at(T0, 2 * MIN) });
    expect(refused).toEqual({ ok: false, reason: 'uncertain_limit', retryAt: new Date('2026-11-02T00:00:00Z') });
    if (refused.ok) throw new Error('admitted');
    expect(rejectionStatus(refused)).toBe(429);
    // A refusal counts the attempt but takes no search and reserves nothing.
    expect((await migrator.execute(sql`SELECT count(*)::int AS n FROM reservations`)).rows).toEqual([{ n: 2 }]);
    // Known charges do not count, nor do other principals.
    const q = account('v');
    const known = admitted(await admit(q, { now: at(T0, 3 * MIN) }));
    await settle(app, known, { lines: [{ usd: 0.13, stage: 'compose' }] }, known.fencingToken, at(T0, 3 * MIN + 30_000));
    const again = admitted(await admit(q, { now: at(T0, 4 * MIN) }));
    await settle(app, again, 0, again.fencingToken, at(T0, 4 * MIN + 1_000));
    // Lease expiry (a server failure, not the request's outcome) still costs the budget in full but does not count here.
    const r = account('w');
    const lost = admitted(await admit(r, { now: at(T0, 5 * MIN) }));
    expect(await expireLeases(app, lost.leaseExpiresAt)).toMatchObject({ expired: 1 });
    admitted(await admit(r, { now: at(lost.leaseExpiresAt, MIN) }));
    // Trials too.
    const trial = await newTrial(0, at(T0, 10 * MIN));
    const t = admitted(await admit(trial, { now: at(T0, 10 * MIN), net: 'net-t' }));
    await settle(app, t, uncertainCall(0.14), t.fencingToken, at(T0, 10 * MIN + 30_000));
    expect(await admit(trial, { now: at(T0, 11 * MIN), net: 'net-t' })).toMatchObject({ ok: false, reason: 'uncertain_limit' });
    // The next UTC day starts afresh.
    admitted(await admit(p, { now: new Date('2026-11-02T00:00:01Z') }));
  });

  it('giving a search back and counting an attempt wait at most 2 s for a lock, then answer busy (task 22 AI M2)', async () => {
    const p = account('u');
    const a = admitted(await admit(p));
    // Another transaction holds every bucket row (an admission stuck behind its precondition, a maintenance pass).
    const holder = await wide.$client.connect();
    const within = <T>(work: Promise<T>) =>
      Promise.race([work, new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 5_000))]);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM usage_buckets FOR UPDATE');
      let started = performance.now();
      expect(await within(releaseQuota(app, a, a.fencingToken, { policy: POLICY, now: at(T0, 1_000) }))).toEqual({ released: false, reason: 'busy' });
      expect(performance.now() - started).toBeLessThan(4_000);
      started = performance.now();
      expect(await within(recordAttempt(app, { policy: POLICY, principal: p, networkId: 'net-a', now: at(T0, 2_000) }))).toEqual({ ok: false, reason: 'busy' });
      expect(performance.now() - started).toBeLessThan(4_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // Nothing changed meanwhile: the search is still counted, and can be given back now.
    expect(await releaseQuota(app, a, a.fencingToken, { policy: POLICY, now: at(T0, 3_000) })).toEqual({ released: true });
    expect(await recordAttempt(app, { policy: POLICY, principal: p, networkId: 'net-a', now: at(T0, 4_000) })).toEqual({ ok: true });
  });

  it('stale fencing token cannot settle', async () => {
    const p = account('u');
    const key = newKey();
    const a = admitted(await admit(p, { key }));
    expect(await settle(app, a, 0.05, randomUUID(), at(T0, 5_000))).toEqual({
      ok: false,
      reason: 'stale_token',
      status: 'open',
    });
    expect(await releaseQuota(app, a, randomUUID(), { policy: POLICY, now: at(T0, 5_000) })).toEqual({
      released: false,
      reason: 'stale_token',
    });
    // A replay of the same request never carries the token.
    const replay = await admit(p, { key, now: at(T0, 6_000) });
    expect(replay).toMatchObject({ ok: true, replay: true, reservationId: a.reservationId });
    expect(replay).not.toHaveProperty('fencingToken');
    expect(await settle(app, a, 0.05, a.fencingToken, at(T0, 7_000))).toEqual({
      ok: true,
      chargedUsd: 0.05,
      uncertain: false,
    });
    expect(await settle(app, a, 0.01, a.fencingToken, at(T0, 8_000))).toEqual({
      ok: false,
      reason: 'not_open',
      status: 'settled',
    });
    expect(await ledger(a.reservationId)).toEqual([{ stage: 'request', usd: '0.050000', uncertain: false }]);
  });
});

describe('idempotency', () => {
  it('an admission that made nothing can be forgotten, so the same request is admitted afresh; one with a result never is (task 22 AI M3)', async () => {
    const p = account('u');
    const key = newKey();
    const a = admitted(await admit(p, { key }));
    await releaseQuota(app, a, a.fencingToken, { policy: POLICY, now: at(T0, 500) });
    await settle(app, a, 0, a.fencingToken, at(T0, 600));
    // At the instant it was made (a frozen clock): it still expires, after its creation.
    await forgetIdempotency(app, a, T0);
    const again = admitted(await admit(p, { key, now: at(T0, 1_000) }));
    expect(again.reservationId).not.toBe(a.reservationId);
    await settle(app, again, 0, again.fencingToken, at(T0, 1_500));
    // A record that points at a result stays: the same request replays it.
    const other = newKey();
    const b = admitted(await admit(p, { key: other, now: at(T0, MIN) }));
    await setResultRef(app, b, 'brief-step:00000000-0000-4000-8000-000000000000');
    await settle(app, b, 0.01, b.fencingToken, at(T0, MIN + 500));
    await forgetIdempotency(app, b, at(T0, MIN + 600));
    expect(await admit(p, { key: other, now: at(T0, MIN + 1_000) })).toMatchObject({ ok: true, replay: true, reservationId: b.reservationId });
  });

  it('idempotent retry returns same admission, different body same key is 409', async () => {
    const trial = await newTrial();
    const key = newKey();
    const first = admitted(await admit(trial, { key, question: 'carb icing' }));
    const retry = await admit(trial, { key, question: 'carb icing', now: at(T0, 1_000) });
    expect(retry).toEqual({
      ok: true,
      replay: true,
      reservationId: first.reservationId,
      status: 'open',
      resultRef: null,
      leaseExpiresAt: first.leaseExpiresAt,
    });
    expect(await trialUsed(trial)).toBe(1);
    const attempts = await migrator.execute(
      sql`SELECT attempts FROM usage_buckets WHERE scope = 'principal' AND period = 'minute'`,
    );
    expect(attempts.rows).toEqual([{ attempts: 1 }]);

    const conflict = await admit(trial, { key, question: 'stall spin accidents', now: at(T0, 2_000) });
    expect(conflict).toEqual({ ok: false, reason: 'idempotency_conflict' });
    if (conflict.ok) throw new Error('unreachable');
    expect(rejectionStatus(conflict)).toBe(409);

    // Keys are scoped to the principal: the same key and body from someone else is their own request.
    const other = admitted(await admit(account('other'), { key, question: 'carb icing', now: at(T0, 3_000) }));
    expect(other.reservationId).not.toBe(first.reservationId);

    // A retry after the work finished returns its state and result, never a second run.
    await setResultRef(app, first, 'brief-step:41');
    await settle(app, first, 0.09, first.fencingToken, at(T0, 20_000));
    expect(await admit(trial, { key, question: 'carb icing', now: at(T0, 2 * MIN) })).toMatchObject({
      ok: true,
      replay: true,
      reservationId: first.reservationId,
      status: 'settled',
      resultRef: 'brief-step:41',
    });
    const reservations = await migrator.execute(sql`SELECT count(*)::int AS n FROM reservations`);
    expect((reservations.rows[0] as { n: number }).n).toBe(2);

    // After 24 hours the key is free again.
    const reused = admitted(await admit(trial, { key, question: 'stall spin accidents', now: at(T0, 25 * HOUR) }));
    expect(reused.reservationId).not.toBe(first.reservationId);
  });
});

describe('principal quotas and rate limits', () => {
  /** Admit and settle `n` requests a minute apart; returns the rejection that follows, if any. */
  async function useRequests(p: Principal, start: Date, n: number): Promise<AdmissionResult> {
    for (let i = 0; i < n; i++) {
      const a = admitted(await admit(p, { now: at(start, i * MIN) }));
      await settle(app, a, 0.01, a.fencingToken, at(start, i * MIN + 1_000));
    }
    return admit(p, { now: at(start, n * MIN) });
  }

  it('new account 5/day for first 3 days', async () => {
    const created = new Date('2026-11-03T10:00:00Z');
    const p = account('new-user', created);
    const day1 = await useRequests(p, new Date('2026-11-03T11:00:00Z'), 5);
    expect(day1).toEqual({ ok: false, reason: 'daily_cap', retryAt: new Date('2026-11-04T00:00:00Z') });
    const day3 = await useRequests(p, new Date('2026-11-05T08:00:00Z'), 5);
    expect(day3).toEqual({ ok: false, reason: 'daily_cap', retryAt: new Date('2026-11-06T00:00:00Z') });
    const status = await aiStatus(app, p, { policy: POLICY, reservationUsd: RESERVATION, now: new Date('2026-11-05T09:00:00Z') });
    expect(status).toEqual({
      state: 'paused',
      reason: 'daily_cap',
      retryAt: new Date('2026-11-06T00:00:00Z'),
      remaining: { kind: 'account', leftToday: 0, limitToday: 5, leftThisMonth: 140, limitThisMonth: 150 },
    });
    // Still inside its first 72 hours the next morning; the allowance rises at 10:00, before midnight.
    const early = await useRequests(p, new Date('2026-11-06T08:00:00Z'), 5);
    expect(early).toEqual({ ok: false, reason: 'daily_cap', retryAt: new Date('2026-11-06T10:00:00Z') });
    const sixth = admitted(await admit(p, { now: new Date('2026-11-06T10:30:00Z') }));
    await settle(app, sixth, 0.01, sixth.fencingToken, new Date('2026-11-06T10:30:01Z'));
    expect(
      (await aiStatus(app, p, { policy: POLICY, reservationUsd: RESERVATION, now: new Date('2026-11-06T10:31:00Z') })).remaining,
    ).toEqual({ kind: 'account', leftToday: 14, limitToday: 20, leftThisMonth: 134, limitThisMonth: 150 });
  });

  it('an account older than 3 days gets 20 a day and 150 a month', async () => {
    const p = account('aged', new Date('2026-10-01T00:00:00Z'));
    const start = new Date('2026-11-02T08:00:00Z');
    expect(await useRequests(p, start, 20)).toEqual({
      ok: false,
      reason: 'daily_cap',
      retryAt: new Date('2026-11-03T00:00:00Z'),
    });
    await migrator.execute(sql`UPDATE usage_buckets SET requests = 150 WHERE scope = 'principal' AND period = 'month'`);
    expect(await admit(p, { now: new Date('2026-11-04T08:00:00Z') })).toEqual({
      ok: false,
      reason: 'monthly_cap',
      retryAt: new Date('2026-12-01T00:00:00Z'),
    });
  });

  it('a trial has three searches', async () => {
    const trial = await newTrial();
    expect(await useRequests(trial, T0, 3)).toEqual({ ok: false, reason: 'trial_exhausted' });
    expect(await aiStatus(app, trial, { policy: POLICY, reservationUsd: RESERVATION, now: T0 })).toEqual({
      state: 'signed_in_only',
      reason: 'trial_used',
      remaining: { kind: 'trial', left: 0, limit: 3 },
    });
  });

  it('recordAttempt counts toward rate limits but never the trial; releaseQuota returns the trial search', async () => {
    const trial = await newTrial();
    expect(await recordAttempt(app, { policy: POLICY, principal: trial, networkId: 'net-a', now: T0 })).toEqual({ ok: true });
    expect(await recordAttempt(app, { policy: POLICY, principal: trial, networkId: 'net-a', now: at(T0, 1_000) })).toEqual({
      ok: true,
    });
    const minuteEnd = new Date('2026-11-01T10:01:00Z');
    expect(await recordAttempt(app, { policy: POLICY, principal: trial, networkId: 'net-a', now: at(T0, 2_000) })).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAt: minuteEnd,
    });
    expect(await admit(trial, { now: at(T0, 3_000) })).toEqual({ ok: false, reason: 'rate_limited', retryAt: minuteEnd });
    expect(await trialUsed(trial)).toBe(0);

    // Off-topic reply: the admission took a search; releasing gives it back, the attempt stays.
    const a = admitted(await admit(trial, { now: minuteEnd }));
    expect(await trialUsed(trial)).toBe(1);
    expect(await releaseQuota(app, a, a.fencingToken, { policy: POLICY, now: at(minuteEnd, 2_000) })).toEqual({ released: true });
    expect(await releaseQuota(app, a, a.fencingToken, { policy: POLICY, now: at(minuteEnd, 2_500) })).toEqual({
      released: false,
      reason: 'already_released',
    });
    expect(await trialUsed(trial)).toBe(0);
    const attempts = await migrator.execute(
      sql`SELECT attempts FROM usage_buckets WHERE scope = 'principal' AND period = 'minute' ORDER BY period_start`,
    );
    expect(attempts.rows).toEqual([{ attempts: 2 }, { attempts: 1 }]);
    // The scope call still cost money.
    expect(await settle(app, a, 0.0002, a.fencingToken, at(minuteEnd, 3_000))).toMatchObject({ ok: true });
    expect(await releaseQuota(app, a, a.fencingToken, { policy: POLICY, now: at(minuteEnd, 4_000) })).toEqual({
      released: false,
      reason: 'not_open',
    });

    // An account's release restores its daily and monthly count.
    const p = account('released');
    const b = admitted(await admit(p, { now: at(T0, HOUR) }));
    await releaseQuota(app, b, b.fencingToken, { policy: POLICY, now: at(T0, HOUR + 1_000) });
    await settle(app, b, 0.0002, b.fencingToken, at(T0, HOUR + 2_000));
    const status = await aiStatus(app, p, { policy: POLICY, reservationUsd: RESERVATION, now: at(T0, HOUR + 3_000) });
    expect(status.remaining).toEqual({ kind: 'account', leftToday: 20, limitToday: 20, leftThisMonth: 150, limitThisMonth: 150 });
  });

  it('releaseQuota refuses an admission whose principal does not match its reservation', async () => {
    const [mine, other] = await Promise.all([newTrial(), newTrial(1)]);
    const a = admitted(await admit(mine));
    const opts = { policy: POLICY, now: at(T0, 1_000) };
    // Another trial's id under this reservation's hash, or the wrong principal kind.
    await expect(releaseQuota(app, { ...a, principal: other }, a.fencingToken, opts)).rejects.toThrow(/does not match/);
    await expect(
      releaseQuota(app, { ...a, principal: account('x') }, a.fencingToken, opts),
    ).rejects.toThrow(/does not match/);
    await expect(
      releaseQuota(app, { ...a, principal: other, principalHash: principalHash(POLICY, other) }, a.fencingToken, opts),
    ).rejects.toThrow(/does not match/);
    expect(await trialUsed(other)).toBe(1);
    expect(await trialUsed(mine)).toBe(1);
    expect(await releaseQuota(app, a, a.fencingToken, opts)).toEqual({ released: true });
    expect(await trialUsed(mine)).toBe(0);
  });

  it('network backstop: 10 anonymous attempts an hour per network, signed-in users counted apart', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await recordAttempt(app, { policy: POLICY, principal: null, networkId: 'net-school', now: at(T0, i * MIN) })).toEqual({
        ok: true,
      });
    }
    expect(await recordAttempt(app, { policy: POLICY, principal: null, networkId: 'net-school', now: at(T0, 10 * MIN) })).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAt: new Date('2026-11-01T11:00:00Z'),
    });
    expect(await admit(await newTrial(), { net: 'net-school', now: at(T0, 11 * MIN) })).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    admitted(await admit(account('teacher'), { net: 'net-school', now: at(T0, 12 * MIN) }));
    expect(await recordAttempt(app, { policy: POLICY, principal: null, networkId: 'net-other', now: at(T0, 13 * MIN) })).toEqual({
      ok: true,
    });
  });
});

describe('aiStatus', () => {
  it('reports coarse states and the principal’s own remaining searches, never amounts', async () => {
    const opts = { policy: POLICY, reservationUsd: RESERVATION, now: T0 };
    const fresh = await aiStatus(app, null, opts);
    expect(fresh).toEqual({ state: 'available', remaining: { kind: 'trial', left: 3, limit: 3 } });
    expect(await aiStatus(app, await newTrial(1), opts)).toEqual({
      state: 'available',
      remaining: { kind: 'trial', left: 2, limit: 3 },
    });
    expect(await aiStatus(app, account('new', at(T0, -DAY)), opts)).toEqual({
      state: 'available',
      remaining: { kind: 'account', leftToday: 5, limitToday: 5, leftThisMonth: 150, limitThisMonth: 150 },
    });

    await chargeInteractive(T0, 2.6);
    const daily = await aiStatus(app, null, { ...opts, now: at(T0, MIN) });
    expect(daily).toEqual({
      state: 'paused',
      reason: 'daily_budget',
      retryAt: new Date('2026-11-02T00:00:00Z'),
      remaining: { kind: 'trial', left: 3, limit: 3 },
    });
    expect(JSON.stringify(daily)).not.toMatch(/usd|allowance|budgetUsd/i);

    await chargeInteractive(new Date('2026-11-20T10:00:00Z'), 77.3);
    expect(await aiStatus(app, account('x'), { ...opts, now: new Date('2026-11-25T10:00:00Z') })).toMatchObject({
      state: 'paused',
      reason: 'monthly_budget',
      retryAt: new Date('2026-12-01T00:00:00Z'),
    });
  });
});

describe('indexing and evaluation spend', () => {
  const request = { provider: 'openai', model: 'text-embedding-3-small', stage: 'embed', requestId: 'batch-1' };

  function spendOk(r: Awaited<ReturnType<typeof reserveSpend>>): SpendReservation {
    if (!r.ok) throw new Error(`expected a reservation, got ${JSON.stringify(r)}`);
    return r;
  }

  it('reserve/settle cycle for indexing, including uncertain and expiry', async () => {
    const r = spendOk(await reserveSpend(ingest, { category: 'indexing', usd: 0.5, request, budgets: BUDGETS, now: T0 }));
    expect(await remainingCategoryUsd(ingest, 'indexing', T0, BUDGETS)).toBeCloseTo(19.5, 6);
    expect(await settleSpend(ingest, r, 0.1, randomUUID(), T0)).toEqual({ ok: false, reason: 'stale_token', status: 'open' });
    expect(
      await settleSpend(ingest, r, { lines: [{ usd: 0.31, tokens: { input: 15_500_000 } }] }, r.fencingToken, at(T0, 10_000)),
    ).toEqual({ ok: true, chargedUsd: 0.31, uncertain: false });
    expect(await remainingCategoryUsd(ingest, 'indexing', T0, BUDGETS)).toBeCloseTo(19.69, 6);

    // Evaluation shares the allowance; an uncertain call is charged in full.
    const e = spendOk(
      await reserveSpend(ingest, {
        category: 'evaluation',
        usd: 1,
        request: { provider: 'anthropic', model: 'claude-opus-5-5', stage: 'compose' },
        budgets: BUDGETS,
        now: T0,
      }),
    );
    expect(await settleSpend(ingest, e, 'uncertain', e.fencingToken, at(T0, 20_000))).toEqual({
      ok: true,
      chargedUsd: 1,
      uncertain: true,
    });
    expect(await remainingCategoryUsd(ingest, 'indexing', T0, BUDGETS)).toBeCloseTo(18.69, 6);

    // A retry attempt is its own reservation; an abandoned one expires at its full amount.
    const lost = spendOk(await reserveSpend(ingest, { category: 'indexing', usd: 0.2, request, budgets: BUDGETS, now: T0 }));
    expect(await expireLeases(ingest, lost.leaseExpiresAt)).toEqual({ expired: 1, chargedUsd: 0.2 });
    expect(await settleSpend(ingest, lost, 0.01, lost.fencingToken, lost.leaseExpiresAt)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(await remainingCategoryUsd(ingest, 'evaluation', T0, BUDGETS)).toBeCloseTo(18.49, 6);

    const lines = await migrator.execute(sql`
      SELECT category, principal_kind, principal_hash, provider, model, stage, usd::text AS usd, tokens, uncertain, request_id
      FROM cost_ledger ORDER BY id`);
    expect(lines.rows).toEqual([
      {
        category: 'indexing',
        principal_kind: 'system',
        principal_hash: null,
        provider: 'openai',
        model: 'text-embedding-3-small',
        stage: 'embed',
        usd: '0.310000',
        tokens: { input: 15_500_000 },
        uncertain: false,
        request_id: 'batch-1',
      },
      {
        category: 'evaluation',
        principal_kind: 'system',
        principal_hash: null,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        stage: 'uncertain',
        usd: '1.000000',
        tokens: null,
        uncertain: true,
        request_id: null,
      },
      {
        category: 'indexing',
        principal_kind: 'system',
        principal_hash: null,
        provider: 'openai',
        model: 'text-embedding-3-small',
        stage: 'lease_expired',
        usd: '0.200000',
        tokens: null,
        uncertain: true,
        request_id: 'batch-1',
      },
    ]);
    // Interactive money is untouched.
    expect(await remainingCategoryUsd(app, 'interactive', T0, BUDGETS)).toBe(80);
  });

  it('the indexing category cap is enforced, also under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveSpend(wideIngest, { category: 'indexing', usd: 5, request, budgets: BUDGETS, now: T0 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      reason: 'category_cap',
      remainingUsd: 0,
      retryAt: new Date('2026-12-01T00:00:00Z'),
    });
    for (const r of results) if (r.ok) await settleSpend(ingest, r, 4.9, r.fencingToken, at(T0, 1_000));
    // $0.40 left of the shared $20, for evaluation too.
    expect(await reserveSpend(ingest, { category: 'evaluation', usd: 0.5, request, budgets: BUDGETS, now: T0 })).toMatchObject({
      ok: false,
      reason: 'category_cap',
      remainingUsd: 0.4,
    });
    spendOk(await reserveSpend(ingest, { category: 'evaluation', usd: 0.4, request, budgets: BUDGETS, now: T0 }));
    // The cap is monthly.
    spendOk(
      await reserveSpend(ingest, { category: 'indexing', usd: 5, request, budgets: BUDGETS, now: new Date('2026-12-01T00:00:00Z') }),
    );
    // Interactive admission is separate.
    admitted(await admit(account('u')));
  });

  it('the total monthly budget also bounds indexing', async () => {
    const tight = { ...BUDGETS, monthlyUsd: 10 };
    await chargeInteractive(T0, 2);
    expect(await reserveSpend(ingest, { category: 'indexing', usd: 8.5, request, budgets: tight, now: T0 })).toEqual({
      ok: false,
      reason: 'monthly_budget',
      remainingUsd: 8,
      retryAt: new Date('2026-12-01T00:00:00Z'),
    });
  });
});

describe('lock timeouts', () => {
  /** Run `fn` while another session holds a lock taken by `lockSql` (released afterwards). */
  async function whileLocked<T>(lockSql: string, params: unknown[], fn: () => Promise<T>): Promise<T> {
    const pool = testPool('migrator');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(lockSql, params);
      return await fn();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end();
    }
  }

  it('a lock wait over 2 s fails closed as busy and changes nothing', async () => {
    const trial = await newTrial();
    const request = { provider: 'openai', model: 'text-embedding-3-small', stage: 'embed' };
    const started = Date.now();
    const [admission, spend] = await whileLocked('SELECT pg_advisory_xact_lock($1)', [SPEND_LOCK_KEY], () =>
      Promise.all([
        admit(trial),
        reserveSpend(ingest, { category: 'indexing', usd: 0.5, request, budgets: BUDGETS, now: T0 }),
      ]),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(admission).toEqual({ ok: false, reason: 'busy' });
    if (admission.ok) throw new Error('unreachable');
    expect(rejectionStatus(admission)).toBe(503);
    expect(spend).toEqual({ ok: false, reason: 'busy' });
    // Rolled back: no reservation, no attempt, no search used.
    const counts = await migrator.execute(sql`
      SELECT (SELECT count(*)::int FROM reservations) AS reservations,
        (SELECT coalesce(sum(attempts), 0)::int FROM usage_buckets) AS attempts`);
    expect(counts.rows).toEqual([{ reservations: 0, attempts: 0 }]);
    expect(await trialUsed(trial)).toBe(0);
    admitted(await admit(trial));
  });

  it('settlement waiting on a locked reservation returns busy and leaves it open', async () => {
    const a = admitted(await admit(account('u')));
    const r = await whileLocked('SELECT 1 FROM reservations WHERE id = $1 FOR UPDATE', [a.reservationId], () =>
      settle(app, a, 0.05, a.fencingToken, at(T0, 5_000)),
    );
    expect(r).toEqual({ ok: false, reason: 'busy' });
    expect(await ledger(a.reservationId)).toEqual([]);
    expect(await settle(app, a, 0.05, a.fencingToken, at(T0, 6_000))).toMatchObject({ ok: true, chargedUsd: 0.05 });
  });
});

describe('roles and guards', () => {
  it('the ledger is append-only and each role writes only its own spend', async () => {
    const a = admitted(await admit(account('u')));
    await settle(app, a, 0.05, a.fencingToken, at(T0, 1_000));
    // aviation_app: no update or delete of spend, no kill switch.
    expect(await sqlState(app.execute(sql`UPDATE cost_ledger SET usd = 0`))).toBe('42501');
    expect(await sqlState(app.execute(sql`DELETE FROM cost_ledger`))).toBe('42501');
    expect(await sqlState(app.execute(sql`DELETE FROM reservations`))).toBe('42501');
    expect(await sqlState(app.execute(sql`DELETE FROM usage_buckets`))).toBe('42501');
    expect(await sqlState(app.execute(sql`UPDATE ai_switch SET enabled = false`))).toBe('42501');
    // aviation_ingest: no user quota data, no interactive spend.
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM usage_buckets`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM trial_identities`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM idempotency`))).toBe('42501');
    expect(
      await sqlState(
        ingest.execute(sql`INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at,
          accounting_day, created_at) VALUES ('interactive', 'account', ${'b'.repeat(64)}, 1, 'open', now() + interval '1 minute',
          current_date, now())`),
      ),
    ).toBe('42501');
    const b = admitted(await admit(account('v'), { now: at(T0, 2_000) }));
    await expect(settleReservation(ingest, b.reservationId, 0, b.fencingToken, at(T0, 3_000))).rejects.toThrow(
      /Unknown reservation/,
    );
    // aviation_ingest sees no interactive rows (principal HMACs, fencing tokens), only sums.
    expect(
      (await ingest.execute(sql`SELECT count(*)::int AS n FROM reservations WHERE category = 'interactive'`)).rows,
    ).toEqual([{ n: 0 }]);
    expect((await ingest.execute(sql`SELECT count(*)::int AS n FROM cost_ledger`)).rows).toEqual([{ n: 0 }]);
    expect(await remainingCategoryUsd(ingest, 'interactive', T0, BUDGETS)).toBeCloseTo(80 - 0.05 - RESERVATION, 6);
    expect(await sqlState(ingest.execute(sql`SELECT spend_totals(current_date)`))).toBeUndefined();
    // An uncertain settlement can never charge less than the reservation.
    expect(
      await sqlState(
        app.execute(sql`UPDATE reservations SET status = 'settled', settled_at = now(), charged_usd = 0.01, uncertain = true
          WHERE id = ${b.reservationId}`),
      ),
    ).toBe('23514');
    // Even the schema owner cannot rewrite spend or reopen a reservation.
    expect(await sqlState(migrator.execute(sql`UPDATE cost_ledger SET usd = 0`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`DELETE FROM cost_ledger`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`UPDATE reservations SET status = 'open' WHERE id = ${a.reservationId}`))).toBe(
      '55000',
    );
    expect(await sqlState(migrator.execute(sql`UPDATE reservations SET usd = 0.01 WHERE id = ${b.reservationId}`))).toBe(
      '55000',
    );
    // Ledger lines need a closed reservation of the same category and principal.
    expect(
      await sqlState(
        app.execute(sql`INSERT INTO cost_ledger (reservation_id, category, principal_kind, principal_hash, stage, usd, uncertain,
          accounting_day, created_at) SELECT id, category, principal_kind, principal_hash, 'request', 0, false, accounting_day, now()
          FROM reservations WHERE id = ${b.reservationId}`),
      ),
    ).toBe('55000');
    expect(
      await sqlState(
        app.execute(sql`INSERT INTO cost_ledger (reservation_id, category, principal_kind, principal_hash, stage, usd, uncertain,
          accounting_day, created_at) SELECT id, 'indexing', 'system', NULL, 'request', 0, false, accounting_day, now()
          FROM reservations WHERE id = ${a.reservationId}`),
      ),
    ).toBe('55000');
  });

  it('retention prunes expired control rows and keeps current ones', async () => {
    // Retention runs on the database clock, so this test uses real time.
    const now = new Date();
    const old = at(now, -200 * DAY);
    const trial = await newTrial(0, old);
    const a = admitted(await admit(trial, { now: old }));
    await settle(app, a, 0.05, a.fencingToken, at(old, 1_000));
    const current = admitted(await admit(account('now'), { now }));
    const report = await pruneControls(app);
    expect(report).toEqual({
      idempotency: 1,
      // The trial's minute, network hour and day, and global day and month buckets.
      usageBuckets: 5,
      trialIdentities: 1,
      turnstileRedemptions: 0,
      abuseRecords: 0,
      costLedger: 1,
      leases: 1,
      reservations: 1,
      briefs: 0,
      briefSteps: 0,
    });
    const left = await migrator.execute(sql`SELECT id::int AS id FROM reservations`);
    expect(left.rows).toEqual([{ id: current.reservationId }]);
  });
});
