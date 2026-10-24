/**
 * What the migrator makes of a database's recorded migrations (server/db/migrate.ts,
 * `planRecorded`; Task 22 fix round 3). Pure: the checkout's real migration list, invented
 * journal rows.
 */
import { describe, expect, it } from 'vitest';
import { REAPPLIED_MIGRATIONS, migrationFiles, planRecorded, type RecordedMigration } from '../../server/db/migrate.js';

const FILES = migrationFiles();
const file = (tag: string) => FILES.find((f) => f.tag === tag)!;
const recordedUpTo = (tag: string): RecordedMigration[] =>
  FILES.filter((f) => f.folderMillis <= file(tag).folderMillis).map((f) => ({ hash: f.hash, createdAt: f.folderMillis }));
const withHash = (rows: RecordedMigration[], tag: string, hash: string) => rows.map((r) => (r.createdAt === file(tag).folderMillis ? { ...r, hash } : r));
const [FIRST_0020] = REAPPLIED_MIGRATIONS['0020_restore_hold']!;
const [FIRST_0021] = REAPPLIED_MIGRATIONS['0021_live_brief_generations']!;
const LAST = FILES[FILES.length - 1]!.tag;

describe('planRecorded', () => {
  it('continues a database that recorded this checkout’s migrations, or none', () => {
    expect(planRecorded(FILES, [])).toEqual({ reapply: [], problems: [] });
    expect(planRecorded(FILES, recordedUpTo('0019_lock_order'))).toEqual({ reapply: [], problems: [] });
    expect(planRecorded(FILES, recordedUpTo(LAST))).toEqual({ reapply: [], problems: [] });
  });

  it('runs 0020 and 0021 again over a version listed as earlier', () => {
    const local = withHash(withHash(recordedUpTo('0021_live_brief_generations'), '0020_restore_hold', FIRST_0020!), '0021_live_brief_generations', FIRST_0021!);
    const plan = planRecorded(FILES, local);
    expect(plan.problems).toEqual([]);
    expect(plan.reapply.map((f) => f.tag)).toEqual(['0020_restore_hold', '0021_live_brief_generations']);
    // Below `upTo` only.
    expect(planRecorded(FILES, local, file('0020_restore_hold').folderMillis).reapply.map((f) => f.tag)).toEqual(['0020_restore_hold']);
  });

  it('refuses other content, a skipped migration, and a re-run below a migration it does not run again', () => {
    expect(planRecorded(FILES, withHash(recordedUpTo(LAST), '0019_lock_order', 'a'.repeat(64))).problems).toEqual([
      "0019_lock_order is recorded with other content than this checkout's (aaaaaaaaaaaa)",
    ]);
    expect(planRecorded(FILES, withHash(recordedUpTo(LAST), '0021_live_brief_generations', 'b'.repeat(64))).problems).toEqual([
      "0021_live_brief_generations is recorded with other content than this checkout's (bbbbbbbbbbbb)",
    ]);
    const later = file('0021_live_brief_generations').folderMillis + 60_000;
    const skipped = [...recordedUpTo('0019_lock_order'), { hash: 'c'.repeat(64), createdAt: later }];
    expect(planRecorded(FILES, skipped).problems).toEqual([
      '0020_restore_hold is not recorded, although later migrations are (another checkout migrated this database)',
      '0021_live_brief_generations is not recorded, although later migrations are (another checkout migrated this database)',
    ]);
    const below = [...withHash(recordedUpTo('0021_live_brief_generations'), '0021_live_brief_generations', FIRST_0021!), { hash: 'c'.repeat(64), createdAt: later }];
    expect(planRecorded(FILES, below).problems).toEqual([
      `a migration of ${later} this checkout does not have is recorded after 0021_live_brief_generations, which cannot be run again below it`,
    ]);
  });
});
