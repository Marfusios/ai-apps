-- Paid operations held after a restore (Task 22, gate finding 5; RUNBOOK, "Backups").
--
-- A restored ledger lacks the spend of the time between the backup and the restore, which
-- the providers still bill, so the same allowance could be spent twice. One row says whether
-- paid operations may start: they are held while `held_at` is set (the restore check sets
-- it), while `database_oid` is not this database's OID (a restore or copy into another
-- database brings the old row along, so a restore holds them even before the check runs),
-- and when the row is missing. Interactive admission, the AI status and the indexing and
-- evaluation spend gate read it; only aviation_migrator, the owner, changes it
-- (`pnpm worker restore-check` holds, `pnpm worker restore-reconcile` charges the lost
-- spend and releases).
--
-- The reconciliation charges lost interactive spend as an interactive reservation of
-- principal kind `system`, stage `restore_reconcile`: the money of no known visitor. The
-- principal check allows exactly that combination besides the existing ones.
CREATE TABLE "paid_operations_hold" (
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
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_principal_check";--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_principal_check" CHECK (("reservations"."principal_kind" = 'system') = ("reservations"."principal_hash" is null)
        and (("reservations"."category" = 'interactive') = ("reservations"."principal_kind" <> 'system')
          or ("reservations"."category" = 'interactive' and "reservations"."principal_kind" = 'system' and "reservations"."stage" = 'restore_reconcile'))
        and ("reservations"."principal_hash" is null or "reservations"."principal_hash" ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
-- The database this ledger belongs to: the one being migrated, so an existing environment
-- keeps its paid operations.
INSERT INTO "paid_operations_hold" ("id", "database_oid")
  SELECT 1, d.oid::bigint FROM pg_database d WHERE d.datname = current_database();
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
