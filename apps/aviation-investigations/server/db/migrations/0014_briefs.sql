CREATE TABLE "brief_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL,
	"n" smallint NOT NULL,
	"billing_principal" text NOT NULL,
	"billing_kind" text NOT NULL,
	"reservation_id" bigint NOT NULL,
	"request" jsonb NOT NULL,
	"stage" text DEFAULT 'scope' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"intent" jsonb,
	"result" jsonb,
	"evidence" jsonb,
	"provider" text,
	"model" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6),
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "brief_steps_n_key" UNIQUE("brief_id","n"),
	CONSTRAINT "brief_steps_n_check" CHECK ("brief_steps"."n" between 1 and 4),
	CONSTRAINT "brief_steps_billing_check" CHECK ("brief_steps"."billing_principal" ~ '^[0-9a-f]{64}$' and "brief_steps"."billing_kind" in ('trial', 'account')),
	CONSTRAINT "brief_steps_stage_check" CHECK ("brief_steps"."stage" in ('scope', 'retrieve', 'compose', 'validate', 'done', 'failed')),
	CONSTRAINT "brief_steps_status_check" CHECK ("brief_steps"."status" in ('running', 'answered', 'withheld', 'scope_reply', 'no_results', 'failed', 'cancelled')),
	CONSTRAINT "brief_steps_state_check" CHECK (("brief_steps"."status" = 'running') = ("brief_steps"."stage" in ('scope', 'retrieve', 'compose', 'validate'))
        and ("brief_steps"."stage" <> 'done' or "brief_steps"."status" in ('answered', 'withheld', 'scope_reply', 'no_results'))
        and ("brief_steps"."stage" <> 'failed' or "brief_steps"."status" in ('failed', 'cancelled'))
        and ("brief_steps"."status" = 'running') = ("brief_steps"."finished_at" is null)
        and ("brief_steps"."status" = 'running' or "brief_steps"."result" is not null)),
	CONSTRAINT "brief_steps_json_check" CHECK (jsonb_typeof("brief_steps"."request") = 'object' and jsonb_typeof("brief_steps"."checklist") = 'object' and jsonb_typeof("brief_steps"."meta") = 'object'),
	CONSTRAINT "brief_steps_cost_check" CHECK ("brief_steps"."cost_usd" is null or "brief_steps"."cost_usd" >= 0),
	CONSTRAINT "brief_steps_labels_check" CHECK (coalesce(length("brief_steps"."provider"), 0) <= 100 and coalesce(length("brief_steps"."model"), 0) <= 100)
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"read_owner" text NOT NULL,
	"read_owner_kind" text NOT NULL,
	"owner_moved_at" timestamp with time zone,
	"generation_id" bigint NOT NULL,
	"passages_index" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "briefs_owner_check" CHECK ("briefs"."read_owner" ~ '^[0-9a-f]{64}$' and "briefs"."read_owner_kind" in ('trial', 'account')),
	CONSTRAINT "briefs_moved_check" CHECK ("briefs"."owner_moved_at" is null or "briefs"."read_owner_kind" = 'account'),
	CONSTRAINT "briefs_expiry_check" CHECK ("briefs"."expires_at" > "briefs"."created_at" and "briefs"."expires_at" <= "briefs"."created_at" + interval '24 hours'),
	CONSTRAINT "briefs_index_check" CHECK ("briefs"."passages_index" ~ '^[a-z0-9][a-z0-9._-]{0,254}$')
);
--> statement-breakpoint
ALTER TABLE "brief_steps" ADD CONSTRAINT "brief_steps_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "briefs_expires_idx" ON "briefs" USING btree ("expires_at");--> statement-breakpoint
-- Hand-written below (Task 16): guard triggers, the read-owner handover, grants and
-- retention for AI briefs.
--
-- briefs: aviation_app creates and reads them and cannot update or delete them. The read
-- owner changes only through move_brief_read_owner(): a compare-and-set from the trial
-- that owns a live brief to an account, at most once (UI_DESIGN §5, "Signing in
-- mid-brief"). brief_steps: aviation_app creates steps and writes the pipeline's columns
-- while a step runs; the billing principal, the reservation and the request never
-- change, stages only move forward, and a finished step is immutable. aviation_ingest
-- gets no access (default privileges grant it SELECT on new tables). Rows are deleted
-- only by retention: prune_controls() removes expired briefs with their steps. The
-- guard triggers apply to the table owner too.
CREATE FUNCTION brief_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('aviation.pruning_controls', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'briefs are deleted only by retention' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.generation_id, NEW.passages_index, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.generation_id, OLD.passages_index, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'brief % is immutable except for its read owner', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.owner_moved_at IS NOT NULL OR OLD.read_owner_kind <> 'trial' OR NEW.read_owner_kind <> 'account'
     OR NEW.owner_moved_at IS NULL THEN
    RAISE EXCEPTION 'the read owner of brief % moves once, from a trial to an account', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER briefs_guard BEFORE UPDATE OR DELETE ON briefs
  FOR EACH ROW EXECUTE FUNCTION brief_guard();
--> statement-breakpoint
CREATE FUNCTION brief_step_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  stages text[] := ARRAY['scope', 'retrieve', 'compose', 'validate', 'done', 'failed'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('aviation.pruning_controls', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'brief steps are deleted only by retention' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.stage <> 'scope' THEN
      RAISE EXCEPTION 'a new brief step starts running at the scope stage' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.brief_id, NEW.n, NEW.billing_principal, NEW.billing_kind, NEW.reservation_id, NEW.request, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.brief_id, OLD.n, OLD.billing_principal, OLD.billing_kind, OLD.reservation_id, OLD.request, OLD.created_at) THEN
    RAISE EXCEPTION 'brief step % keeps its billing principal, reservation and request', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'brief step % is finished', OLD.id USING ERRCODE = '55000';
  END IF;
  IF array_position(stages, NEW.stage) < array_position(stages, OLD.stage) THEN
    RAISE EXCEPTION 'brief step % cannot move back from % to %', OLD.id, OLD.stage, NEW.stage USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER brief_steps_guard BEFORE INSERT OR UPDATE OR DELETE ON brief_steps
  FOR EACH ROW EXECUTE FUNCTION brief_step_guard();
--> statement-breakpoint
-- The sign-in handover (Task 20): move the read owner of a live brief from the trial
-- that owns it to an account, once. A second or concurrent call finds no matching row
-- and returns false. Billing principals, reservations and charges never move.
CREATE FUNCTION move_brief_read_owner(p_brief uuid, p_from text, p_to text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from !~ '^[0-9a-f]{64}$' OR p_to !~ '^[0-9a-f]{64}$' OR p_from = p_to THEN
    RAISE EXCEPTION 'invalid read owner' USING ERRCODE = '22023';
  END IF;
  UPDATE briefs SET read_owner = p_to, read_owner_kind = 'account', owner_moved_at = now()
    WHERE id = p_brief AND read_owner = p_from AND read_owner_kind = 'trial' AND owner_moved_at IS NULL
      AND expires_at > now();
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION brief_guard(), brief_step_guard(), move_brief_read_owner(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION move_brief_read_owner(uuid, text, text) TO aviation_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "briefs", "brief_steps" TO aviation_app;
--> statement-breakpoint
GRANT UPDATE ("stage", "status", "checklist", "intent", "result", "evidence", "provider", "model", "meta", "cost_usd",
  "cancel_requested_at", "updated_at", "finished_at") ON TABLE "brief_steps" TO aviation_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "briefs" FROM aviation_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "brief_steps" FROM aviation_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "briefs", "brief_steps" FROM aviation_ingest;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "briefs", "brief_steps" FROM aviation_app, aviation_ingest';
  END IF;
END $$;
--> statement-breakpoint
-- Same as migration 0013, plus expired briefs and their steps (24-hour temporary
-- processing, DESIGN §7). CREATE OR REPLACE keeps the owner, SECURITY DEFINER
-- (restated) and the EXECUTE grants.
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
  n_brief_steps integer;
  n_briefs integer;
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
  DELETE FROM brief_steps s USING briefs b WHERE s.brief_id = b.id AND b.expires_at < now();
  GET DIAGNOSTICS n_brief_steps = ROW_COUNT;
  DELETE FROM briefs WHERE expires_at < now();
  GET DIAGNOSTICS n_briefs = ROW_COUNT;
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
    'reservations', n_reservations, 'briefs', n_briefs, 'briefSteps', n_brief_steps);
END $$;
