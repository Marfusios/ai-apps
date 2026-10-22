-- A keyword-only manifest (Task 8): the passages index may be absent. Search, case
-- pages and the dashboard read only the cases index; AI routes require a manifest
-- that names a passages index.
ALTER TABLE "dataset_manifests" ALTER COLUMN "passages_index" DROP NOT NULL;
--> statement-breakpoint
-- Same as migration 0003, except that a null passages index is accepted (and stored
-- as null); a non-null name is validated as before. CREATE OR REPLACE keeps the
-- owner, SECURITY DEFINER (restated) and the EXECUTE grants.
CREATE OR REPLACE FUNCTION publish_manifest(p_generation bigint, p_cases_index text, p_passages_index text,
  p_verifier_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g dataset_generations%ROWTYPE;
  previous bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  IF p_cases_index IS NULL OR p_cases_index !~ '^[a-z0-9][a-z0-9._-]{0,254}$'
     OR (p_passages_index IS NOT NULL AND p_passages_index !~ '^[a-z0-9][a-z0-9._-]{0,254}$') THEN
    RAISE EXCEPTION 'invalid index name' USING ERRCODE = '22023';
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
