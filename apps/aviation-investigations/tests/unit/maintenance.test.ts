import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../server/db/client.js';
import { runControlMaintenance, startControlMaintenance, type MaintenanceResult } from '../../server/quota/maintenance.js';

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

describe('control maintenance', () => {
  it('a pass that cannot reach the database is logged and returned, never thrown', async () => {
    const log = quietLog();
    const db = {
      transaction: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED db.internal:5432'), { name: 'ConnectionError' });
      },
    } as unknown as Db;
    expect(await runControlMaintenance(db, log)).toEqual({ ran: false, reason: 'failed' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    // The error's type is logged, never its message (which may hold an address).
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('db.internal');
  });

  describe('schedule', () => {
    function harness(run: () => Promise<MaintenanceResult>) {
      const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
      const log = quietLog();
      const job = startControlMaintenance({} as Db, log, {
        intervalMs: 600_000,
        jitter: 0.2,
        random: () => 1,
        run: async () => run(),
        setTimeout: (fn, ms) => {
          const t = { fn, ms, cancelled: false };
          timers.push(t);
          return t;
        },
        clearTimeout: (h) => {
          (h as { cancelled: boolean }).cancelled = true;
        },
      });
      return { timers, log, job };
    }
    const settle = () => new Promise((r) => setImmediate(r));

    it('runs every ~10 minutes with jitter and keeps going after a failure', async () => {
      let calls = 0;
      const { timers, job, log } = harness(async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { ran: false, reason: 'lock_held' };
      });
      // random() = 1 gives the top of the +-20% band.
      expect(timers.map((t) => t.ms)).toEqual([720_000]);
      timers[0]!.fn();
      await settle();
      expect(calls).toBe(1);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(timers).toHaveLength(2);
      timers[1]!.fn();
      await settle();
      expect(calls).toBe(2);
      expect(timers).toHaveLength(3);
      job.stop();
      expect(timers[2]!.cancelled).toBe(true);
    });

    it('moves on after a pass that never settles', async () => {
      const timers: { fn: () => void }[] = [];
      const log = quietLog();
      startControlMaintenance({} as Db, log, {
        passTimeoutMs: 20,
        run: () => new Promise<MaintenanceResult>(() => undefined),
        setTimeout: (fn) => {
          timers.push({ fn });
          return {};
        },
        clearTimeout: () => undefined,
      });
      timers[0]!.fn();
      await new Promise((r) => setTimeout(r, 80));
      expect(timers).toHaveLength(2);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('does not reschedule once stopped', async () => {
      const { timers, job } = harness(async () => ({ ran: false, reason: 'lock_held' }));
      timers[0]!.fn();
      job.stop();
      await settle();
      expect(timers).toHaveLength(1);
    });
  });
});
