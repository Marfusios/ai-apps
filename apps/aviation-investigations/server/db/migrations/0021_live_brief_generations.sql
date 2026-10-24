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
--> statement-breakpoint
-- A brief keeps the indices it was made with (Task 22 fix round 2: gate finding 3). Publishing
-- a generation again with another passages index (passages-v2) replaces its manifest row, so
-- the pair a brief is pinned to, and the cases index retrieval.v2 reads with it, were lost:
-- the brief's later steps failed, and `index delete-unused` could delete the old passages
-- index. manifest_pairings keeps every pair a generation was published with and the cases
-- index of that publication; a trigger on dataset_manifests writes it (publish_manifest runs
-- as the owner) and removes a generation's pairs with its manifest row (prune_generation). No
-- foreign key: test resets truncate the corpus tables without it.
CREATE TABLE "manifest_pairings" (
	"generation_id" bigint NOT NULL,
	"passages_index" text NOT NULL,
	"cases_index" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "manifest_pairings_pk" PRIMARY KEY("generation_id","passages_index")
);
--> statement-breakpoint
CREATE FUNCTION record_manifest_pairing() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM manifest_pairings WHERE generation_id = OLD.generation_id;
    RETURN OLD;
  END IF;
  IF NEW.passages_index IS NOT NULL THEN
    INSERT INTO manifest_pairings (generation_id, passages_index, cases_index, published_at)
      VALUES (NEW.generation_id, NEW.passages_index, NEW.cases_index, coalesce(NEW.published_at, now()))
      ON CONFLICT (generation_id, passages_index) DO UPDATE
        SET cases_index = EXCLUDED.cases_index, published_at = EXCLUDED.published_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dataset_manifests_pairing AFTER INSERT OR UPDATE OR DELETE ON dataset_manifests
  FOR EACH ROW EXECUTE FUNCTION record_manifest_pairing();
--> statement-breakpoint
INSERT INTO manifest_pairings (generation_id, passages_index, cases_index, published_at)
  SELECT generation_id, passages_index, cases_index, coalesce(published_at, created_at)
  FROM dataset_manifests WHERE passages_index IS NOT NULL;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_manifest_pairing() FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON TABLE "manifest_pairings" TO aviation_app, aviation_ingest;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "manifest_pairings" FROM aviation_app, aviation_ingest;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "manifest_pairings" FROM aviation_app, aviation_ingest';
  END IF;
END $$;
--> statement-breakpoint
-- The indices unexpired briefs use: their passages indices and the cases indices those pairs
-- were published with. `index delete-unused` (aviation_ingest) refuses them; index names only.
CREATE FUNCTION indices_cited_by_live_briefs() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.passages_index FROM briefs b WHERE b.expires_at > now()
  UNION
  SELECT p.cases_index FROM briefs b
    JOIN manifest_pairings p ON p.generation_id = b.generation_id AND p.passages_index = b.passages_index
  WHERE b.expires_at > now()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION indices_cited_by_live_briefs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION indices_cited_by_live_briefs() TO aviation_ingest;
