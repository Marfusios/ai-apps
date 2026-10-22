-- Cost and abuse controls (Task 15): kill-switch seed, guard triggers, row-level
-- security, retention and least-privilege grants.
--
-- aviation_app runs interactive admission: it reads and writes buckets, leases,
-- idempotency records, trial identities, abuse records and reservations, and appends
-- to the ledger. aviation_ingest meters indexing and evaluation spend: it creates and
-- settles reservations and appends ledger lines of those categories only (row-level
-- security), reads all spend for the shared monthly totals, and operates the kill
-- switch. Neither role can update or delete ledger lines or delete reservations;
-- retention runs only through prune_controls(). The table owner bypasses row-level
-- security but not the guard triggers.

INSERT INTO "ai_switch" ("id", "enabled", "note") VALUES (1, true, NULL) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Reservations: born open; afterwards only the settlement columns change, once, and a
-- released quota unit cannot be taken again. Deletes only through prune_controls().
CREATE FUNCTION reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a new reservation starts open' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting('aviation.pruning_controls', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'reservations are deleted only by retention' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.category, NEW.principal_kind, NEW.principal_hash, NEW.usd, NEW.fencing_token,
      NEW.lease_expires_at, NEW.accounting_day, NEW.provider, NEW.model, NEW.stage, NEW.request_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.category, OLD.principal_kind, OLD.principal_hash, OLD.usd, OLD.fencing_token,
      OLD.lease_expires_at, OLD.accounting_day, OLD.provider, OLD.model, OLD.stage, OLD.request_id, OLD.created_at) THEN
    RAISE EXCEPTION 'reservation % is immutable except for its settlement', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'reservation % is already %', OLD.id, OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.quota_counted AND NOT OLD.quota_counted THEN
    RAISE EXCEPTION 'reservation % released its quota unit', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER reservations_guard BEFORE INSERT OR UPDATE OR DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservation_guard();
--> statement-breakpoint
-- Ledger: append-only. A line belongs to a closed reservation and copies its category,
-- principal and accounting day, so spend can never be filed under another category.
CREATE FUNCTION cost_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r reservations%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'cost_ledger is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting('aviation.pruning_controls', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'cost_ledger lines are deleted only by retention' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO r FROM reservations WHERE id = NEW.reservation_id;
  IF NOT FOUND OR r.status = 'open' THEN
    RAISE EXCEPTION 'ledger lines need a closed reservation' USING ERRCODE = '55000';
  END IF;
  IF (NEW.category, NEW.principal_kind, NEW.principal_hash, NEW.accounting_day)
     IS DISTINCT FROM (r.category, r.principal_kind, r.principal_hash, r.accounting_day) THEN
    RAISE EXCEPTION 'ledger line does not match reservation %', r.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cost_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON cost_ledger
  FOR EACH ROW EXECUTE FUNCTION cost_ledger_guard();
--> statement-breakpoint
ALTER TABLE "reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reservations_app ON "reservations" TO aviation_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY reservations_ingest_read ON "reservations" FOR SELECT TO aviation_ingest USING (true);
--> statement-breakpoint
CREATE POLICY reservations_ingest_insert ON "reservations" FOR INSERT TO aviation_ingest
  WITH CHECK (category IN ('indexing', 'evaluation'));
--> statement-breakpoint
CREATE POLICY reservations_ingest_update ON "reservations" FOR UPDATE TO aviation_ingest
  USING (category IN ('indexing', 'evaluation')) WITH CHECK (category IN ('indexing', 'evaluation'));
--> statement-breakpoint
ALTER TABLE "cost_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY cost_ledger_app ON "cost_ledger" TO aviation_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY cost_ledger_ingest_read ON "cost_ledger" FOR SELECT TO aviation_ingest USING (true);
--> statement-breakpoint
CREATE POLICY cost_ledger_ingest_insert ON "cost_ledger" FOR INSERT TO aviation_ingest
  WITH CHECK (category IN ('indexing', 'evaluation'));
--> statement-breakpoint
-- Retention (DESIGN §7): idempotency records 24 h, quota buckets and the anti-abuse
-- record through their window plus 7 days, trial identities 30 days, ledger lines and
-- closed reservations 90 days. Open reservations are never pruned.
CREATE FUNCTION prune_controls() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cutoff timestamptz := now() - interval '90 days';
  n_idempotency integer;
  n_buckets integer;
  n_trials integer;
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
    'abuseRecords', n_abuse, 'costLedger', n_ledger, 'leases', n_leases, 'reservations', n_reservations);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reservation_guard(), cost_ledger_guard(), prune_controls() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_controls() TO aviation_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "usage_buckets", "leases", "idempotency", "trial_identities", "abuse_records", "reservations"
  TO aviation_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "cost_ledger" TO aviation_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "ai_switch" TO aviation_app;
--> statement-breakpoint
REVOKE UPDATE ON TABLE "cost_ledger", "ai_switch" FROM aviation_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  "usage_buckets", "leases", "idempotency", "trial_identities", "abuse_records", "reservations",
  "cost_ledger", "ai_switch"
  FROM aviation_app;
--> statement-breakpoint
-- aviation_ingest never sees who used the AI.
REVOKE ALL ON TABLE "usage_buckets", "leases", "idempotency", "trial_identities", "abuse_records" FROM aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "reservations" TO aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "cost_ledger" TO aviation_ingest;
--> statement-breakpoint
GRANT SELECT ON TABLE "ai_switch" TO aviation_ingest;
--> statement-breakpoint
GRANT UPDATE ("enabled", "note", "updated_at") ON TABLE "ai_switch" TO aviation_ingest;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "reservations", "cost_ledger", "ai_switch"
  FROM aviation_ingest;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "reservations_id_seq", "cost_ledger_id_seq" TO aviation_app, aviation_ingest;
