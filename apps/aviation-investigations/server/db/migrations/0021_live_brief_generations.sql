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
--
-- This migration changed after the local test database had recorded its first version (no
-- shared environment ever ran it). Its statements therefore converge: run again over a
-- database that recorded an earlier version, they leave the schema this version creates, and
-- the migrator does exactly that (server/db/migrate.ts, REAPPLIED_MIGRATIONS).
CREATE OR REPLACE FUNCTION generations_cited_by_live_briefs() RETURNS SETOF bigint
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
CREATE TABLE IF NOT EXISTS "manifest_pairings" (
	"generation_id" bigint NOT NULL,
	"passages_index" text NOT NULL,
	"cases_index" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "manifest_pairings_pk" PRIMARY KEY("generation_id","passages_index")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_manifest_pairing() RETURNS trigger
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
DROP TRIGGER IF EXISTS dataset_manifests_pairing ON dataset_manifests;
--> statement-breakpoint
CREATE TRIGGER dataset_manifests_pairing AFTER INSERT OR UPDATE OR DELETE ON dataset_manifests
  FOR EACH ROW EXECUTE FUNCTION record_manifest_pairing();
--> statement-breakpoint
INSERT INTO manifest_pairings (generation_id, passages_index, cases_index, published_at)
  SELECT generation_id, passages_index, cases_index, coalesce(published_at, created_at)
  FROM dataset_manifests WHERE passages_index IS NOT NULL
  ON CONFLICT (generation_id, passages_index) DO NOTHING;
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
CREATE OR REPLACE FUNCTION indices_cited_by_live_briefs() RETURNS SETOF text
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
--> statement-breakpoint
-- An index deletion is recorded before Elasticsearch is asked (Task 22 fix round 3: the gate's
-- finding 2 of round 2). `index delete-unused` and a failed build's cleanup set
-- deletion_requested_at, and commit it, before they send the delete; deleted_at follows once
-- Elasticsearch confirmed it (or reports the index missing). Neither is ever cleared: from
-- the request on, the index is unavailable whatever became of the request (a lost response, a
-- failed write afterwards, the process killed). A new brief refuses it (claimBriefEvidence),
-- publication refuses it (in code and in publish_manifest below), an alias switch refuses it,
-- and the next `index delete-unused --yes` completes or confirms the deletion.
ALTER TABLE "index_builds" ADD COLUMN IF NOT EXISTS "deletion_requested_at" timestamp with time zone;
--> statement-breakpoint
-- As in migration 0010, and the request time is set once too.
CREATE OR REPLACE FUNCTION index_builds_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'index builds are never deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.build_id, NEW.index_name, NEW.alias, NEW.generation_id, NEW.created_at)
     IS DISTINCT FROM (OLD.build_id, OLD.index_name, OLD.alias, OLD.generation_id, OLD.created_at)
     OR (OLD.deletion_requested_at IS NOT NULL AND NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'index build % is immutable except for its deletion request and deletion times, each set once', OLD.build_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
GRANT UPDATE ("deletion_requested_at") ON TABLE "index_builds" TO aviation_ingest;
--> statement-breakpoint
-- As in migration 0011, and an index whose deletion was requested or done is refused: the
-- manifest would name an index that is gone, or about to be (the gate's finding 1 of round 2).
-- `pnpm worker publish` checks it as well, holding the lifecycle lock from its checks of the
-- indices to this call, so index cleanup cannot request a deletion in between.
CREATE OR REPLACE FUNCTION publish_manifest(p_generation bigint, p_cases_index text, p_passages_index text,
  p_verifier_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g dataset_generations%ROWTYPE;
  previous bigint;
  gone text;
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  IF p_cases_index IS NULL OR p_cases_index !~ '^[a-z0-9][a-z0-9._-]{0,254}$'
     OR (p_passages_index IS NOT NULL AND p_passages_index !~ '^[a-z0-9][a-z0-9._-]{0,254}$') THEN
    RAISE EXCEPTION 'invalid index name' USING ERRCODE = '22023';
  END IF;
  SELECT b.index_name INTO gone FROM index_builds b
    WHERE b.index_name IN (p_cases_index, p_passages_index)
      AND (b.deletion_requested_at IS NOT NULL OR b.deleted_at IS NOT NULL)
    ORDER BY b.index_name LIMIT 1;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'index % is deleted or being deleted', gone USING ERRCODE = '55000';
  END IF;
  SELECT * INTO g FROM dataset_generations WHERE id = p_generation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation USING ERRCODE = 'P0002';
  END IF;
  IF g.status NOT IN ('verified', 'published', 'retired') THEN
    RAISE EXCEPTION 'generation % is %; only a verified generation can be published', p_generation, g.status
      USING ERRCODE = '55000';
  END IF;
  IF g.verification_status IS DISTINCT FROM 'ok' OR g.verifier_version IS DISTINCT FROM p_verifier_version THEN
    RAISE EXCEPTION 'generation % has no current successful verification (latest %, verifier %)',
      p_generation, coalesce(g.verification_status, 'none'), coalesce(g.verifier_version, 'none')
      USING ERRCODE = '55000';
  END IF;
  FOR previous IN
    UPDATE dataset_manifests SET active = false WHERE active AND generation_id <> p_generation RETURNING generation_id
  LOOP
    UPDATE dataset_generations SET status = 'retired' WHERE id = previous AND status = 'published';
  END LOOP;
  INSERT INTO dataset_manifests (generation_id, cases_index, passages_index, published_at, active)
    VALUES (p_generation, p_cases_index, p_passages_index, clock_timestamp(), true)
    ON CONFLICT (generation_id) DO UPDATE
      SET cases_index = EXCLUDED.cases_index, passages_index = EXCLUDED.passages_index,
          published_at = EXCLUDED.published_at, active = true;
  IF g.status <> 'published' THEN
    UPDATE dataset_generations SET status = 'published' WHERE id = p_generation;
  END IF;
END $$;
