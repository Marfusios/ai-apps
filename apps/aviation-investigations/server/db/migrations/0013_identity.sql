CREATE TABLE "turnstile_redemptions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"redeemed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "turnstile_redemptions_values_check" CHECK ("turnstile_redemptions"."token_hash" ~ '^[0-9a-f]{64}$' and "turnstile_redemptions"."expires_at" > "turnstile_redemptions"."redeemed_at")
);
--> statement-breakpoint
ALTER TABLE "ai_switch" ADD COLUMN "anonymous_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Hand-written: trial identities made before this migration have no cookie hash, and no
-- cookie can ever reach them (none was issued before Task 19); remove them so the
-- column can be NOT NULL. Reservations and buckets refer to principals by HMAC only.
DELETE FROM "trial_identities";--> statement-breakpoint
ALTER TABLE "trial_identities" ADD COLUMN "cookie_hash" text NOT NULL;--> statement-breakpoint
CREATE INDEX "turnstile_redemptions_expires_idx" ON "turnstile_redemptions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "trial_identities" ADD CONSTRAINT "trial_identities_cookie_hash_key" UNIQUE("cookie_hash");--> statement-breakpoint
ALTER TABLE "trial_identities" ADD CONSTRAINT "trial_identities_cookie_hash_check" CHECK ("trial_identities"."cookie_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
-- Hand-written below (Task 19): grants and retention for the anonymous gate.
--
-- turnstile_redemptions: aviation_app claims tokens (SELECT, INSERT); nothing updates
-- or deletes them except prune_controls(). aviation_ingest gets no access (default
-- privileges grant it SELECT on new tables). The login-required emergency mode is a
-- column of the kill switch, operated like it by aviation_ingest (pnpm worker ai-switch).
GRANT SELECT, INSERT ON TABLE "turnstile_redemptions" TO aviation_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "turnstile_redemptions" FROM aviation_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "turnstile_redemptions" FROM aviation_ingest;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "turnstile_redemptions" FROM aviation_app, aviation_ingest';
  END IF;
END $$;
--> statement-breakpoint
GRANT UPDATE ("anonymous_enabled") ON TABLE "ai_switch" TO aviation_ingest;
--> statement-breakpoint
-- Same as migration 0008, plus Turnstile redemptions once expired. CREATE OR REPLACE
-- keeps the owner, SECURITY DEFINER (restated) and the EXECUTE grants.
CREATE OR REPLACE FUNCTION prune_controls() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cutoff timestamptz := now() - interval '90 days';
  n_idempotency integer;
  n_buckets integer;
  n_trials integer;
  n_redemptions integer;
  n_abuse integer;
  n_ledger integer;
  n_leases integer;
  n_reservations integer;
BEGIN
  DELETE FROM idempotency WHERE expires_at < now();
  GET DIAGNOSTICS n_idempotency = ROW_COUNT;
  DELETE FROM usage_buckets WHERE expires_at < now();
  GET DIAGNOSTICS n_buckets = ROW_COUNT;
  DELETE FROM trial_identities WHERE expires_at < now();
  GET DIAGNOSTICS n_trials = ROW_COUNT;
  DELETE FROM turnstile_redemptions WHERE expires_at < now();
  GET DIAGNOSTICS n_redemptions = ROW_COUNT;
  DELETE FROM abuse_records WHERE retain_until < now();
  GET DIAGNOSTICS n_abuse = ROW_COUNT;
  PERFORM set_config('aviation.pruning_controls', 'on', true);
  DELETE FROM cost_ledger WHERE created_at < cutoff;
  GET DIAGNOSTICS n_ledger = ROW_COUNT;
  DELETE FROM leases l USING reservations r
    WHERE l.reservation_id = r.id AND r.status <> 'open' AND r.settled_at < cutoff
      AND NOT EXISTS (SELECT 1 FROM cost_ledger c WHERE c.reservation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM idempotency i WHERE i.reservation_id = r.id);
  GET DIAGNOSTICS n_leases = ROW_COUNT;
  DELETE FROM reservations r
    WHERE r.status <> 'open' AND r.settled_at < cutoff
      AND NOT EXISTS (SELECT 1 FROM cost_ledger c WHERE c.reservation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM idempotency i WHERE i.reservation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.reservation_id = r.id);
  GET DIAGNOSTICS n_reservations = ROW_COUNT;
  PERFORM set_config('aviation.pruning_controls', '', true);
  RETURN jsonb_build_object('idempotency', n_idempotency, 'usageBuckets', n_buckets, 'trialIdentities', n_trials,
    'turnstileRedemptions', n_redemptions, 'abuseRecords', n_abuse, 'costLedger', n_ledger, 'leases', n_leases,
    'reservations', n_reservations);
END $$;
