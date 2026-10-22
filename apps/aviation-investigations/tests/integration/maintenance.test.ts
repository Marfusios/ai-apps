import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { runControlMaintenance } from '../../server/quota/maintenance.js';
import { MAINTENANCE_LOCK_KEY } from '../../server/quota/policy.js';
import { admitPaidRequest, canonicalRequestHash, createTrialIdentity, quotaPolicy } from '../../server/quota/index.js';
import { loadConfig } from '../../shared/config.js';
import { resetControls, testDb, testPool } from './helpers.js';

const POLICY = quotaPolicy({
  ai: loadConfig({ env: {}, files: [] }).ai,
  auth: { identityHmacSecret: 'test-identity-hmac-secret-0123456789', ipHmacSecret: 'test-network-hmac-secret-0123456789' },
});
const DAY = 24 * 60 * 60_000;

let app: Db;
let migrator: Db;
let holder: pg.Pool;
const log = () => ({ info: vi.fn(), warn: vi.fn() });

beforeAll(() => {
  app = testDb('app');
  migrator = testDb('migrator');
  holder = testPool('app');
});
afterAll(async () => {
  await Promise.all([closeDb(app), closeDb(migrator), holder.end()]);
});
beforeEach(async () => {
  await resetControls();
});

describe('periodic control maintenance (as aviation_app)', () => {
  it('expires an unsettled lease and prunes what is past retention', async () => {
    const real = new Date();
    const old = new Date(real.getTime() - 200 * DAY);
    await createTrialIdentity(app, POLICY, randomBytes(32).toString('hex'), old);
    // A reservation whose lease ran out: the pass charges it in full.
    const trial = await createTrialIdentity(app, POLICY, randomBytes(32).toString('hex'), new Date(real.getTime() - 10 * 60_000));
    const admission = await admitPaidRequest(app, {
      policy: POLICY,
      principal: { kind: 'trial', id: trial.id },
      networkId: 'net-m',
      idempotencyKey: 'maintenance-key-1',
      requestHash: canonicalRequestHash({ question: 'carburetor icing' }),
      reservationUsd: 0.14,
      now: new Date(real.getTime() - 10 * 60_000),
    });
    expect(admission.ok).toBe(true);

    const l = log();
    const result = await runControlMaintenance(app, l, real);
    expect(result).toMatchObject({ ran: true, failed: [] });
    if (!result.ran) throw new Error('unreachable');
    expect(result.expired).toEqual({ expired: 1, chargedUsd: 0.14 });
    expect(result.pruned?.trialIdentities).toBe(1);
    expect(l.warn).not.toHaveBeenCalled();
    const open = (await migrator.execute(sql`SELECT count(*)::int AS n FROM reservations WHERE status = 'open'`)).rows[0] as { n: number };
    expect(open.n).toBe(0);
  });

  it('takes the advisory lock: a pass while another holds it does nothing, and the next one runs', async () => {
    const holderConn = await holder.connect();
    try {
      await holderConn.query('SELECT pg_advisory_lock($1)', [MAINTENANCE_LOCK_KEY]);
      expect(await runControlMaintenance(app, log())).toEqual({ ran: false, reason: 'lock_held' });
      await holderConn.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_KEY]);
    } finally {
      holderConn.release();
    }
    expect(await runControlMaintenance(app, log())).toMatchObject({ ran: true, failed: [] });
    // The lock is transaction-scoped: nothing is left held afterwards.
    const held = (await migrator.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${MAINTENANCE_LOCK_KEY % 2 ** 32}`)).rows[0] as { n: number };
    expect(held.n).toBe(0);
  });

  it('one step failing is logged and does not stop the other', async () => {
    const l = log();
    await migrator.execute(sql`REVOKE EXECUTE ON FUNCTION prune_controls() FROM aviation_app`);
    try {
      const result = await runControlMaintenance(app, l);
      expect(result).toMatchObject({ ran: true, failed: ['pruneControls'], pruned: null, expired: { expired: 0, chargedUsd: 0 } });
      expect(l.warn).toHaveBeenCalledTimes(1);
    } finally {
      await migrator.execute(sql`GRANT EXECUTE ON FUNCTION prune_controls() TO aviation_app`);
    }
    expect(await runControlMaintenance(app, log())).toMatchObject({ ran: true, failed: [] });
  });
});
