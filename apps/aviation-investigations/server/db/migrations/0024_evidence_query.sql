-- The executed query and explicit user filters are immutable even while scope runs.
-- Older private rows keep their original version and expire normally; v2 never re-labels them.
CREATE OR REPLACE FUNCTION evidence_search_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.billing_principal, NEW.billing_kind, NEW.reservation_id, NEW.generation_id,
      NEW.cases_index, NEW.passages_index, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.billing_principal, OLD.billing_kind, OLD.reservation_id, OLD.generation_id,
      OLD.cases_index, OLD.passages_index, OLD.created_at, OLD.expires_at)
     OR (OLD.status <> 'running' AND (NEW.status, NEW.data) IS DISTINCT FROM (OLD.status, OLD.data))
     OR (NEW.data->'question', NEW.data->'edited', NEW.data->'context', NEW.data->'version', NEW.data->'query', NEW.data->'appliedFilters') IS DISTINCT FROM
        (OLD.data->'question', OLD.data->'edited', OLD.data->'context', OLD.data->'version', OLD.data->'query', OLD.data->'appliedFilters') THEN
    RAISE EXCEPTION 'evidence search is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
