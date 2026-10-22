-- Pins are written only through these functions (gate G2b, fix round 2). They take
-- the lifecycle advisory lock first, like prune_generation, so a pin created or
-- renewed while pruning runs waits for it: either the pin lands before pruning plans
-- (and protects the generation) or pruning finishes first and the pin fails because
-- the generation no longer exists. Direct writes to generation_pins are revoked.

CREATE FUNCTION pin_generation(p_generation bigint, p_reason text, p_until timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  IF NOT EXISTS (SELECT 1 FROM dataset_generations WHERE id = p_generation) THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO generation_pins (generation_id, reason, pinned_until)
    VALUES (p_generation, p_reason, p_until)
    ON CONFLICT (generation_id, reason) DO UPDATE SET pinned_until = EXCLUDED.pinned_until;
END $$;
--> statement-breakpoint
CREATE FUNCTION unpin_generation(p_generation bigint, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  DELETE FROM generation_pins WHERE generation_id = p_generation AND reason = p_reason;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pin_generation(bigint, text, timestamptz), unpin_generation(bigint, text) FROM PUBLIC;
--> statement-breakpoint
-- The API role gets EXECUTE in the task that pins generations for live briefs.
GRANT EXECUTE ON FUNCTION pin_generation(bigint, text, timestamptz), unpin_generation(bigint, text) TO aviation_ingest;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "generation_pins"
  FROM aviation_ingest, aviation_app;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "generation_pins" FROM aviation_ingest, aviation_app';
  END IF;
END $$;
