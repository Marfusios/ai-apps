-- Generations that live AI briefs cite are kept by pruning (Task 22, data review D-M3;
-- amendment A6, "kept for live citations").
--
-- A brief (migration 0014) is bound to its generation and passages index for its 24 hours:
-- its later steps read that generation's manifest row and case rows. Pruning keeps the
-- active generation and the two most recently published ones, so two publications within a
-- brief's life would otherwise let `prune-generations` delete the generation it cites.
-- Instead of a pin per brief (a lifecycle-locked write on every AI request), pruning
-- (server/db/generations.ts) asks this function and keeps those generations until their
-- briefs expire. It returns generation ids only: aviation_ingest, which prunes, cannot read
-- briefs. Migration 0004 expected the API role to pin generations for live briefs; it never
-- does, and gets no EXECUTE on pin_generation.
CREATE FUNCTION generations_cited_by_live_briefs() RETURNS SETOF bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT generation_id FROM briefs WHERE expires_at > now() ORDER BY 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION generations_cited_by_live_briefs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION generations_cited_by_live_briefs() TO aviation_ingest;
