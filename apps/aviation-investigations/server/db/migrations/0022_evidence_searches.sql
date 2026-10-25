CREATE TABLE "evidence_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"read_owner" text NOT NULL,
	"read_owner_kind" text NOT NULL,
	"owner_moved_at" timestamp with time zone,
	"billing_principal" text NOT NULL,
	"billing_kind" text NOT NULL,
	"reservation_id" bigint NOT NULL,
	"generation_id" bigint NOT NULL,
	"cases_index" text NOT NULL,
	"passages_index" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evidence_owner_check" CHECK ("evidence_searches"."read_owner" ~ '^[0-9a-f]{64}$' and "evidence_searches"."billing_principal" ~ '^[0-9a-f]{64}$' and "evidence_searches"."read_owner_kind" in ('trial','account') and "evidence_searches"."billing_kind" in ('trial','account')),
	CONSTRAINT "evidence_expiry_check" CHECK ("evidence_searches"."expires_at" > "evidence_searches"."created_at" and "evidence_searches"."expires_at" <= "evidence_searches"."created_at" + interval '24 hours'),
	CONSTRAINT "evidence_status_check" CHECK ("evidence_searches"."status" in ('running','results','scope_reply','failed')),
	CONSTRAINT "evidence_data_check" CHECK (jsonb_typeof("evidence_searches"."data") = 'object'),
	CONSTRAINT "evidence_indices_check" CHECK ("evidence_searches"."cases_index" ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and "evidence_searches"."passages_index" ~ '^[a-z0-9][a-z0-9._-]{0,254}$')
);
--> statement-breakpoint
CREATE INDEX "evidence_expires_idx" ON "evidence_searches" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "evidence_owner_idx" ON "evidence_searches" USING btree ("read_owner","read_owner_kind");
--> statement-breakpoint
-- No ingest access; app writers may finish a running search, never change identity or pins.
REVOKE ALL ON evidence_searches FROM PUBLIC, aviation_app, aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT ON evidence_searches TO aviation_app;
--> statement-breakpoint
GRANT UPDATE (status, data) ON evidence_searches TO aviation_app;
--> statement-breakpoint
CREATE FUNCTION evidence_search_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.billing_principal, NEW.billing_kind, NEW.reservation_id, NEW.generation_id,
      NEW.cases_index, NEW.passages_index, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.billing_principal, OLD.billing_kind, OLD.reservation_id, OLD.generation_id,
      OLD.cases_index, OLD.passages_index, OLD.created_at, OLD.expires_at)
     OR (OLD.status <> 'running' AND (NEW.status, NEW.data) IS DISTINCT FROM (OLD.status, OLD.data))
     OR (NEW.data->'question', NEW.data->'edited', NEW.data->'context') IS DISTINCT FROM
        (OLD.data->'question', OLD.data->'edited', OLD.data->'context') THEN
    RAISE EXCEPTION 'evidence search is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER evidence_search_guard BEFORE UPDATE ON evidence_searches FOR EACH ROW EXECUTE FUNCTION evidence_search_guard();
--> statement-breakpoint
REVOKE ALL ON FUNCTION evidence_search_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION move_evidence_owner(p_id uuid, p_trial text, p_account text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_account !~ '^[0-9a-f]{64}$' OR p_trial !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid owner' USING ERRCODE = '22023';
  END IF;
  UPDATE evidence_searches SET read_owner = p_account, read_owner_kind = 'account', owner_moved_at = clock_timestamp()
    WHERE id = p_id AND read_owner = p_trial AND read_owner_kind = 'trial' AND owner_moved_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION move_evidence_owner(uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION move_evidence_owner(uuid,text,text) TO aviation_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION generations_cited_by_live_briefs() RETURNS SETOF bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT generation_id FROM briefs WHERE expires_at > now()
 UNION SELECT generation_id FROM evidence_searches WHERE expires_at > now()
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION indices_cited_by_live_briefs() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT b.passages_index FROM briefs b WHERE b.expires_at > now()
 UNION SELECT p.cases_index FROM briefs b JOIN manifest_pairings p
   ON p.generation_id = b.generation_id AND p.passages_index = b.passages_index WHERE b.expires_at > now()
 UNION SELECT passages_index FROM evidence_searches WHERE expires_at > now()
 UNION SELECT cases_index FROM evidence_searches WHERE expires_at > now()
$$;

--> statement-breakpoint
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
  n_evidence integer;
BEGIN
  PERFORM set_config('aviation.pruning_controls', 'on', true);
  PERFORM 1 FROM briefs WHERE expires_at < now() ORDER BY id FOR UPDATE;
  DELETE FROM brief_steps s USING briefs b WHERE s.brief_id = b.id AND b.expires_at < now();
  GET DIAGNOSTICS n_brief_steps = ROW_COUNT;
  DELETE FROM briefs WHERE expires_at < now();
  GET DIAGNOSTICS n_briefs = ROW_COUNT;
  DELETE FROM evidence_searches WHERE id IN (SELECT id FROM evidence_searches WHERE expires_at <= now() ORDER BY id FOR UPDATE);
  GET DIAGNOSTICS n_evidence = ROW_COUNT;
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
    'reservations', n_reservations, 'briefs', n_briefs, 'briefSteps', n_brief_steps, 'evidenceSearches', n_evidence);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_account_content(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_steps integer;
  n_briefs integer;
  n_idempotency integer;
  running jsonb;
BEGIN
  IF p_owner IS NULL OR p_owner !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid account' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM briefs WHERE read_owner = p_owner AND read_owner_kind = 'account' ORDER BY id FOR UPDATE;
  PERFORM set_config('aviation.pruning_controls', 'on', true);
  WITH gone AS (
    DELETE FROM brief_steps s USING briefs b
      WHERE s.brief_id = b.id AND b.read_owner = p_owner AND b.read_owner_kind = 'account'
      RETURNING s.id, s.status
  )
  SELECT count(*)::integer, coalesce(jsonb_agg(gone.id::text) FILTER (WHERE gone.status = 'running'), '[]'::jsonb)
    INTO n_steps, running FROM gone;
  DELETE FROM briefs WHERE read_owner = p_owner AND read_owner_kind = 'account';
  GET DIAGNOSTICS n_briefs = ROW_COUNT;
  PERFORM set_config('aviation.pruning_controls', '', true);
  PERFORM 1 FROM evidence_searches WHERE read_owner = p_owner AND read_owner_kind = 'account' ORDER BY id FOR UPDATE;
  SELECT running || coalesce(jsonb_agg(id::text), '[]'::jsonb) INTO running FROM evidence_searches
    WHERE read_owner = p_owner AND read_owner_kind = 'account' AND status = 'running';
  DELETE FROM idempotency WHERE result_ref IN (SELECT 'evidence:' || id::text FROM evidence_searches WHERE read_owner = p_owner AND read_owner_kind = 'account');
  DELETE FROM evidence_searches WHERE id IN (SELECT id FROM evidence_searches WHERE read_owner = p_owner AND read_owner_kind = 'account' ORDER BY id FOR UPDATE);
  DELETE FROM idempotency WHERE principal_hash = p_owner;
  GET DIAGNOSTICS n_idempotency = ROW_COUNT;
  RETURN jsonb_build_object('briefs', n_briefs, 'briefSteps', n_steps, 'idempotency', n_idempotency, 'running', running);
END $$;
