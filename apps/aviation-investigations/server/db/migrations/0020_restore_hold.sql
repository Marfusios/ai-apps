-- Paid operations held after a restore (Task 22, gate finding 5; RUNBOOK, "Backups").
--
-- A restored ledger lacks the spend of the time between the backup and the restore, which
-- the providers still bill, so the same allowance could be spent twice. One row says whether
-- paid operations may start: they are held while `held_at` is set, and when the row is
-- missing. The restore sets it in its own transaction (docker/postgres/after-restore.sql),
-- `pnpm worker restore-check` sets it again, and only `pnpm worker restore-reconcile`
-- clears it, after charging the lost spend. `database_oid` (the database the row was
-- written in) holds them too when it differs, but nothing relies on it: a new cluster can
-- repeat an OID. Interactive admission, the AI status and the indexing and evaluation spend
-- gate read the row; only aviation_migrator, the owner, changes it.
--
-- Every restore is recorded in drizzle.restores (the migrator's; the runtime roles cannot
-- read that schema). A backup taken before this migration has no hold table, so its restore
-- only records itself; this migration, run on such a restored database, starts held.
--
-- The reconciliation charges lost interactive spend as an interactive reservation of
-- principal kind `system`, stage `restore_reconcile`: the money of no known visitor. The
-- principal check allows exactly that combination besides the existing ones.
--
-- This migration changed after the local test database had recorded its first version (no
-- shared environment ever ran it). Its statements therefore converge: run again over a
-- database that recorded an earlier version, they leave the schema this version creates, and
-- the migrator does exactly that (server/db/migrate.ts, REAPPLIED_MIGRATIONS).
CREATE TABLE IF NOT EXISTS "paid_operations_hold" (
	"id" smallint PRIMARY KEY NOT NULL,
	"database_oid" bigint NOT NULL,
	"held_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_operations_hold_single_row_check" CHECK ("paid_operations_hold"."id" = 1),
	CONSTRAINT "paid_operations_hold_note_check" CHECK ("paid_operations_hold"."note" is null or length("paid_operations_hold"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT IF EXISTS "reservations_principal_check";--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_principal_check" CHECK (("reservations"."principal_kind" = 'system') = ("reservations"."principal_hash" is null)
        and (("reservations"."category" = 'interactive') = ("reservations"."principal_kind" <> 'system')
          or ("reservations"."category" = 'interactive' and "reservations"."principal_kind" = 'system' and "reservations"."stage" = 'restore_reconcile'))
        and ("reservations"."principal_hash" is null or "reservations"."principal_hash" ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
-- Restores recorded by docker/postgres/after-restore.sql (which creates the table as well).
CREATE TABLE IF NOT EXISTS "drizzle"."restores" (
  "restored_at" timestamp with time zone DEFAULT now() NOT NULL,
  "backup" text
);
--> statement-breakpoint
-- An existing environment keeps its paid operations; a database restored from a backup taken
-- before this migration starts held. A row already there (an earlier version of this
-- migration wrote it) stays as it is.
INSERT INTO "paid_operations_hold" ("id", "database_oid", "held_at", "note")
  SELECT 1, d.oid::bigint, r.held_at, r.note
  FROM pg_database d,
    LATERAL (SELECT CASE WHEN EXISTS (SELECT 1 FROM "drizzle"."restores") THEN now() END AS held_at,
      CASE WHEN EXISTS (SELECT 1 FROM "drizzle"."restores")
        THEN 'restored from a backup taken before migration 0020: run pnpm worker restore-reconcile' END AS note) r
  WHERE d.datname = current_database()
  ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
GRANT SELECT ON TABLE "paid_operations_hold" TO aviation_app, aviation_ingest;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "paid_operations_hold" FROM aviation_app, aviation_ingest;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "paid_operations_hold" FROM aviation_app, aviation_ingest';
  END IF;
END $$;
