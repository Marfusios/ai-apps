-- Sent by restore.sh after the dump, in the restore's transaction (docs/RUNBOOK.md, "Backups";
-- server/quota/hold.ts): a restored database never opens with paid operations allowed.
--
-- 1. Record the restore. drizzle.restores is the migrator's (runtime roles cannot read the
--    schema); migration 0020 creates it too, and on a database restored from a backup taken
--    before 0020 it starts the hold because a restore is recorded here.
-- 2. Hold paid operations when the backup has the hold table (taken after migration 0020),
--    whatever its row says: the database it names may even have this database's OID.
-- The backup's file name comes in `aviation.restored_from` (SET LOCAL by restore.sh).
CREATE TABLE IF NOT EXISTS drizzle.restores (
  restored_at timestamp with time zone DEFAULT now() NOT NULL,
  backup text
);
INSERT INTO drizzle.restores (backup) VALUES (nullif(current_setting('aviation.restored_from', true), ''));
DO $$
BEGIN
  IF to_regclass('public.paid_operations_hold') IS NOT NULL THEN
    INSERT INTO public.paid_operations_hold (id, database_oid, held_at, note, updated_at)
      SELECT 1, d.oid::bigint, now(), 'restored from a backup: run pnpm worker restore-reconcile', now()
      FROM pg_database d WHERE d.datname = current_database()
      ON CONFLICT (id) DO UPDATE SET held_at = now(), note = EXCLUDED.note, updated_at = now();
  END IF;
END $$;
