ALTER TABLE "evidence_searches" ADD COLUMN IF NOT EXISTS "free_undo_reservation_id" bigint;--> statement-breakpoint
-- Finished results remain immutable; the separate undo claim is write-once.
GRANT UPDATE (free_undo_reservation_id) ON evidence_searches TO aviation_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION evidence_search_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE automatic jsonb;
BEGIN
  IF (NEW.id, NEW.billing_principal, NEW.billing_kind, NEW.reservation_id, NEW.generation_id,
      NEW.cases_index, NEW.passages_index, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.billing_principal, OLD.billing_kind, OLD.reservation_id, OLD.generation_id,
      OLD.cases_index, OLD.passages_index, OLD.created_at, OLD.expires_at)
     OR (OLD.status <> 'running' AND (NEW.status, NEW.data) IS DISTINCT FROM (OLD.status, OLD.data))
     OR (NEW.data->'question', NEW.data->'edited', NEW.data->'context', NEW.data->'version', NEW.data->'freeUndo', NEW.data->'autoFilterPolicy') IS DISTINCT FROM
        (OLD.data->'question', OLD.data->'edited', OLD.data->'context', OLD.data->'version', OLD.data->'freeUndo', OLD.data->'autoFilterPolicy') THEN
    RAISE EXCEPTION 'evidence search is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.free_undo_reservation_id IS DISTINCT FROM OLD.free_undo_reservation_id THEN
    -- The route must distinguish clock-skew expiry from every other claim violation.
    -- Check it before the owner tie: an expired trial parent cannot be handed over.
    IF OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'evidence undo parent expired' USING ERRCODE = '55000',
        CONSTRAINT = 'evidence_undo_parent_unexpired';
    END IF;
    IF OLD.free_undo_reservation_id IS NOT NULL OR NEW.free_undo_reservation_id IS NULL
       OR OLD.status <> 'results' OR OLD.data->>'edited' IS DISTINCT FROM 'false'
       OR NOT EXISTS (SELECT 1 FROM reservations claim
         JOIN reservations paid ON paid.id = OLD.reservation_id
         WHERE claim.id = NEW.free_undo_reservation_id
         AND claim.category = 'interactive' AND claim.status = 'open' AND claim.quota_counted = false
         AND claim.principal_hash = OLD.read_owner AND claim.principal_kind = OLD.read_owner_kind
         AND paid.principal_hash = OLD.billing_principal AND paid.principal_kind = OLD.billing_kind) THEN
      RAISE EXCEPTION 'evidence undo claim is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF (NEW.data->'query', NEW.data->'appliedFilters', NEW.data->'automaticFilters') IS DISTINCT FROM
     (OLD.data->'query', OLD.data->'appliedFilters', OLD.data->'automaticFilters') THEN
    IF OLD.status <> 'running' OR NEW.status <> 'results' OR OLD.data->>'version' IS DISTINCT FROM 'evidence.v3'
       OR OLD.data->>'edited' IS DISTINCT FROM 'false'
       OR NEW.data->'query'->>'source' IS DISTINCT FROM 'question'
       OR OLD.data->'query'->>'source' IS DISTINCT FROM 'question' THEN
      RAISE EXCEPTION 'evidence query is immutable' USING ERRCODE = '55000';
    END IF;
    automatic := CASE WHEN jsonb_typeof(NEW.data->'automaticFilters') = 'object'
      THEN NEW.data->'automaticFilters' ELSE '{}'::jsonb END;
    IF automatic - 'state' <> '{}'::jsonb
       OR NEW.data->'appliedFilters' IS DISTINCT FROM ((OLD.data->'appliedFilters') || automatic) THEN
      RAISE EXCEPTION 'only automatic state may change evidence filters' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
