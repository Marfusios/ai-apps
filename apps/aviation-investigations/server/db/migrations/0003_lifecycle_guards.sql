-- Generation lifecycle enforced in the database (gate G2b, fix round 1).
--
-- A generation accepts corpus writes only while its status is 'loading', i.e. inside
-- the load transaction, which seals it before committing. After that its rows are
-- immutable for every role: statement triggers reject INSERT, UPDATE and DELETE on
-- rows of a sealed generation. Whole generations are removed only by
-- prune_generation(), which sets a transaction-local guard the delete trigger accepts.
-- Every status change goes through the SECURITY DEFINER functions below (owned by
-- the migrator); aviation_ingest cannot UPDATE or DELETE generations, manifests or
-- corpus rows directly. The functions share one advisory lock (key 7311905022) with
-- verification, so publication, pruning and verification never interleave.

CREATE FUNCTION corpus_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  blocked bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT n.generation_id INTO blocked FROM new_rows n
      LEFT JOIN dataset_generations g ON g.id = n.generation_id
      WHERE g.status IS DISTINCT FROM 'loading' LIMIT 1;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT o.generation_id INTO blocked FROM old_rows o
      LEFT JOIN dataset_generations g ON g.id = o.generation_id
      WHERE g.status IS DISTINCT FROM 'loading'
        AND o.generation_id::text IS DISTINCT FROM current_setting('aviation.pruning_generation', true)
      LIMIT 1;
  ELSE
    SELECT x.generation_id INTO blocked
      FROM (SELECT generation_id FROM old_rows UNION ALL SELECT generation_id FROM new_rows) x
      LEFT JOIN dataset_generations g ON g.id = x.generation_id
      WHERE g.status IS DISTINCT FROM 'loading' LIMIT 1;
  END IF;
  IF FOUND THEN
    RAISE EXCEPTION 'generation % is sealed: % on % rejected', blocked, TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- One check per statement (transition tables) rather than per row; a rejection
-- aborts the statement, so nothing it wrote survives.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cases', 'case_aircraft', 'case_engines', 'case_findings', 'case_sequence',
    'case_sections', 'case_section_sources', 'code_dictionary', 'quarantine'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION corpus_write_guard()', t || '_guard_insert', t);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION corpus_write_guard()', t || '_guard_update', t);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION corpus_write_guard()', t || '_guard_delete', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION generation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'loading' OR NEW.sealed_at IS NOT NULL OR NEW.verification_status IS NOT NULL
       OR NEW.verified_at IS NOT NULL OR NEW.verifier_version IS NOT NULL OR NEW.verification_report_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'a new generation starts loading, unsealed and unverified' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ingestion_runs WHERE id = NEW.ingestion_run_id AND status = 'running') THEN
      RAISE EXCEPTION 'generation needs a running ingestion run' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.ingestion_run_id, NEW.archive_sha256, NEW.extract_manifest, NEW.mapping_version,
      NEW.mapping_verified, NEW.citation_text_version, NEW.field_normalization_version, NEW.created_at, NEW.stats)
     IS DISTINCT FROM
     (OLD.id, OLD.ingestion_run_id, OLD.archive_sha256, OLD.extract_manifest, OLD.mapping_version,
      OLD.mapping_verified, OLD.citation_text_version, OLD.field_normalization_version, OLD.created_at, OLD.stats) THEN
    RAISE EXCEPTION 'generation % metadata is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('loading', 'loaded'), ('loaded', 'verified'), ('loaded', 'failed'), ('verified', 'failed'),
       ('failed', 'verified'), ('verified', 'published'), ('retired', 'published'), ('published', 'retired')) THEN
    RAISE EXCEPTION 'generation % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF NEW.sealed_at IS DISTINCT FROM OLD.sealed_at AND NOT (OLD.status = 'loading' AND NEW.status = 'loaded') THEN
    RAISE EXCEPTION 'generation % seal time is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dataset_generations_guard BEFORE INSERT OR UPDATE ON dataset_generations
  FOR EACH ROW EXECUTE FUNCTION generation_guard();
--> statement-breakpoint
CREATE FUNCTION ingestion_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new ingestion run starts running' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'ingestion run % is finished (%)', OLD.id, OLD.status USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.started_at, NEW.archive_sha256, NEW.mapping_version, NEW.text_normalization_version,
      NEW.field_normalization_version)
     IS DISTINCT FROM
     (OLD.id, OLD.started_at, OLD.archive_sha256, OLD.mapping_version, OLD.text_normalization_version,
      OLD.field_normalization_version) THEN
    RAISE EXCEPTION 'ingestion run % identity is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ingestion_runs_guard BEFORE INSERT OR UPDATE ON ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION ingestion_run_guard();
--> statement-breakpoint
-- Seal at the end of the load transaction, after the run is marked succeeded.
CREATE FUNCTION seal_generation(p_generation bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE dataset_generations g SET status = 'loaded', sealed_at = clock_timestamp()
    WHERE g.id = p_generation AND g.status = 'loading'
      AND EXISTS (SELECT 1 FROM ingestion_runs r WHERE r.id = g.ingestion_run_id AND r.status = 'succeeded');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'generation % is not loading or its run has not succeeded', p_generation USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
-- Record a verification outcome. The caller passes the status it verified against;
-- any other current status is a conflict (SQLSTATE 40001).
CREATE FUNCTION record_verification(p_generation bigint, p_expected_status text, p_ok boolean,
  p_verifier_version text, p_report_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  current_status text;
  next_status text;
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  SELECT status INTO current_status FROM dataset_generations WHERE id = p_generation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation USING ERRCODE = 'P0002';
  END IF;
  IF current_status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'verification conflict: generation % is % (verified as %)', p_generation, current_status, p_expected_status
      USING ERRCODE = '40001';
  END IF;
  IF current_status = 'loading' THEN
    RAISE EXCEPTION 'generation % is still loading', p_generation USING ERRCODE = '55000';
  END IF;
  next_status := CASE WHEN current_status IN ('loaded', 'verified', 'failed')
    THEN CASE WHEN p_ok THEN 'verified' ELSE 'failed' END ELSE current_status END;
  UPDATE dataset_generations
    SET status = next_status, verification_status = CASE WHEN p_ok THEN 'ok' ELSE 'failed' END,
        verified_at = clock_timestamp(), verifier_version = p_verifier_version,
        verification_report_sha256 = p_report_sha256
    WHERE id = p_generation AND status = current_status;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'verification conflict: generation % changed', p_generation USING ERRCODE = '40001';
  END IF;
  RETURN next_status;
END $$;
--> statement-breakpoint
-- Activate a generation's manifest. Requires its latest verification to be ok and
-- made by the given (current) verifier version, also when rolling back.
CREATE FUNCTION publish_manifest(p_generation bigint, p_cases_index text, p_passages_index text,
  p_verifier_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g dataset_generations%ROWTYPE;
  previous bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  IF p_cases_index !~ '^[a-z0-9][a-z0-9._-]{0,254}$' OR p_passages_index !~ '^[a-z0-9][a-z0-9._-]{0,254}$' THEN
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
--> statement-breakpoint
-- Delete one whole generation. Refuses a loading, active or pinned generation;
-- retention policy (which generations to prune) is the caller's.
CREATE FUNCTION prune_generation(p_generation bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET enable_seqscan = off AS $$
DECLARE
  g dataset_generations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(7311905022);
  SELECT * INTO g FROM dataset_generations WHERE id = p_generation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation USING ERRCODE = 'P0002';
  END IF;
  IF g.status = 'loading' THEN
    RAISE EXCEPTION 'generation % is loading', p_generation USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM dataset_manifests WHERE generation_id = p_generation AND active) THEN
    RAISE EXCEPTION 'generation % is active', p_generation USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM generation_pins
             WHERE generation_id = p_generation AND (pinned_until IS NULL OR pinned_until > now())) THEN
    RAISE EXCEPTION 'generation % is pinned', p_generation USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('aviation.pruning_generation', p_generation::text, true);
  DELETE FROM case_section_sources WHERE generation_id = p_generation;
  DELETE FROM case_sections WHERE generation_id = p_generation;
  DELETE FROM case_engines WHERE generation_id = p_generation;
  DELETE FROM case_findings WHERE generation_id = p_generation;
  DELETE FROM case_sequence WHERE generation_id = p_generation;
  DELETE FROM case_aircraft WHERE generation_id = p_generation;
  DELETE FROM cases WHERE generation_id = p_generation;
  DELETE FROM code_dictionary WHERE generation_id = p_generation;
  DELETE FROM quarantine WHERE generation_id = p_generation;
  PERFORM set_config('aviation.pruning_generation', '', true);
  DELETE FROM generation_pins WHERE generation_id = p_generation;
  DELETE FROM dataset_manifests WHERE generation_id = p_generation;
  DELETE FROM dataset_generations WHERE id = p_generation;
END $$;
--> statement-breakpoint
-- Refresh planner statistics after a load (a new generation_id is unknown to them).
CREATE FUNCTION analyze_corpus() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  ANALYZE dataset_generations, cases, case_aircraft, case_engines, case_findings, case_sequence,
    case_sections, case_section_sources, code_dictionary, quarantine;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION corpus_write_guard(), generation_guard(), ingestion_run_guard(), seal_generation(bigint),
  record_verification(bigint, text, boolean, text, text), publish_manifest(bigint, text, text, text),
  prune_generation(bigint), analyze_corpus() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION seal_generation(bigint), record_verification(bigint, text, boolean, text, text),
  publish_manifest(bigint, text, text, text), prune_generation(bigint), analyze_corpus() TO aviation_ingest;
--> statement-breakpoint
-- aviation_ingest: append-only corpus while loading; no direct changes to generations,
-- manifests or finished runs; MAINTAIN replaced by analyze_corpus().
REVOKE ALL ON TABLE
  "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence",
  "case_sections", "case_section_sources", "code_dictionary", "quarantine",
  "dataset_generations", "dataset_manifests", "ingestion_runs"
  FROM aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence",
  "case_sections", "case_section_sources", "code_dictionary", "quarantine",
  "dataset_generations", "ingestion_runs"
  TO aviation_ingest;
--> statement-breakpoint
GRANT SELECT ON TABLE "dataset_manifests" TO aviation_ingest;
--> statement-breakpoint
GRANT UPDATE (status, finished_at, counts, error) ON TABLE "ingestion_runs" TO aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "generation_pins" TO aviation_ingest;
--> statement-breakpoint
-- aviation_app: no internal event ids, quarantine values or run errors.
REVOKE ALL ON TABLE "cases", "quarantine", "ingestion_runs", "generation_pins" FROM aviation_app;
--> statement-breakpoint
GRANT SELECT (
  generation_id, ntsb_no, country, is_us, latitude, longitude, ev_type, ev_date, ev_dow, ev_time, ev_tmzn,
  city, state, ev_year, ev_month, light_cond, sky_cond_nonceil, sky_nonceil_ht, sky_ceil_ht, sky_cond_ceil,
  vis_sm, wx_temp, wx_dew_pt, wind_dir_deg, wind_dir_ind, wind_vel_kts, wind_vel_ind, gust_ind, gust_kts,
  altimeter, wx_dens_alt, wx_int_precip, wx_cond_basic, metar, highest_injury, inj_f_grnd, inj_m_grnd,
  inj_s_grnd, inj_tot_f, inj_tot_m, inj_tot_n, inj_tot_s, inj_tot_t, last_changed_at, raw_status,
  approval_date, admin_last_changed_at, completion_class, completion_mapping_version, has_probable_cause,
  completed_with_cause, answer_eligible, defining_phase_groups, sequence_phase_groups, source_revision
) ON TABLE "cases" TO aviation_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "generation_pins" TO aviation_app;
