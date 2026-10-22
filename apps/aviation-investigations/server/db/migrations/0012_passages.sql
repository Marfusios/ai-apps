CREATE TABLE "embedding_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"template_version" text NOT NULL,
	"vector" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_cache_key_check" CHECK ("embedding_cache"."cache_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "embedding_cache_vector_check" CHECK ("embedding_cache"."dims" between 1 and 4096 and octet_length("embedding_cache"."vector") = "embedding_cache"."dims" * 4),
	CONSTRAINT "embedding_cache_labels_check" CHECK ("embedding_cache"."model" ~ '^\S{1,100}$' and "embedding_cache"."template_version" ~ '^\S{1,100}$')
);
--> statement-breakpoint
CREATE TABLE "passages" (
	"generation_id" bigint NOT NULL,
	"passage_id" text NOT NULL,
	"chunker_version" text NOT NULL,
	"ntsb_no" text NOT NULL,
	"section_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"section_sha" text NOT NULL,
	"section_kind" text NOT NULL,
	"scope" text NOT NULL,
	"aircraft_key" integer,
	"aircraft_specific" boolean NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"part" integer NOT NULL,
	"parts" integer NOT NULL,
	"continuation" boolean NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passages_pk" PRIMARY KEY("generation_id","passage_id"),
	CONSTRAINT "passages_ids_check" CHECK ("passages"."passage_id" ~ '^[0-9a-f]{64}$' and "passages"."revision_id" ~ '^[0-9a-f]{64}$' and "passages"."section_sha" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "passages_section_check" CHECK (starts_with("passages"."section_id", "passages"."ntsb_no" || ':') and "passages"."chunker_version" ~ '^\S+$'),
	CONSTRAINT "passages_kind_check" CHECK ("passages"."section_kind" in ('factual', 'analysis', 'probable_cause')),
	CONSTRAINT "passages_scope_check" CHECK (("passages"."scope" = 'aircraft' and "passages"."aircraft_key" is not null and "passages"."aircraft_specific")
        or ("passages"."scope" = 'event' and "passages"."aircraft_key" is null and not "passages"."aircraft_specific")),
	CONSTRAINT "passages_span_check" CHECK ("passages"."start" >= 0 and "passages"."end" > "passages"."start" and "passages"."part" between 1 and "passages"."parts"
        and (not "passages"."continuation" or "passages"."part" > 1) and "passages"."token_count" between 1 and 8192)
);
--> statement-breakpoint
CREATE INDEX "passages_section_idx" ON "passages" USING btree ("section_id","generation_id");--> statement-breakpoint
-- Hand-written below: sealing and grants (drizzle-kit does not generate them).
--
-- passages is a projection of one verified generation's sections. Instead of foreign
-- keys (which would also tie the corpus tables to it for TRUNCATE), a statement
-- trigger checks every inserted row against its generation and section, rejects
-- updates, and allows deletes only of rows whose generation is gone. A trigger on
-- dataset_generations removes a generation's passages when prune_generation()
-- deletes the generation.
--
-- Pruning cannot race an insert: the insert trigger locks the referenced generation
-- rows FOR SHARE until the inserting transaction ends. prune_generation() locks the
-- generation row FOR UPDATE before deleting anything, so it waits for open inserts
-- (and then removes their committed rows with the generation); an insert that comes
-- after a prune waits for it and then finds the generation gone (READ COMMITTED), or
-- fails with a serialization error (REPEATABLE READ). Status changes of the
-- generation also wait, so the verified status checked here holds until commit.
-- The function is SECURITY DEFINER because row locks need UPDATE rights that
-- aviation_ingest does not have on dataset_generations.
CREATE FUNCTION passages_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  bad record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM dataset_generations g
      WHERE g.id IN (SELECT DISTINCT n.generation_id FROM new_rows n)
      ORDER BY g.id FOR SHARE;
    SELECT n.generation_id, g.status INTO bad FROM new_rows n
      LEFT JOIN dataset_generations g ON g.id = n.generation_id
      WHERE g.id IS NULL OR g.status NOT IN ('verified', 'published') OR g.verification_status IS DISTINCT FROM 'ok'
      LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'passages need a verified generation: generation % is %', bad.generation_id, coalesce(bad.status, 'missing')
        USING ERRCODE = '55000';
    END IF;
    -- Offsets are UTF-16 code units: characters plus one more for each astral character.
    WITH sec AS (
      SELECT s.generation_id, s.section_id, s.ntsb_no, s.revision_id, s.sha256, s.kind, s.scope, s.aircraft_key,
             char_length(s.text) + char_length(regexp_replace(s.text, '[^\U00010000-\U0010FFFF]', '', 'g')) AS units
        FROM case_sections s
       WHERE (s.generation_id, s.section_id) IN (SELECT DISTINCT n.generation_id, n.section_id FROM new_rows n)
    )
    SELECT n.generation_id, n.passage_id, n.section_id INTO bad FROM new_rows n
      LEFT JOIN sec s ON s.generation_id = n.generation_id AND s.section_id = n.section_id
      LEFT JOIN cases c ON c.generation_id = n.generation_id AND c.ntsb_no = n.ntsb_no
      WHERE s.section_id IS NULL OR c.ntsb_no IS NULL OR s.ntsb_no <> n.ntsb_no
         OR s.revision_id <> n.revision_id OR s.sha256 <> n.section_sha OR s.kind <> n.section_kind
         OR s.scope <> n.scope OR s.aircraft_key IS DISTINCT FROM n.aircraft_key
         OR n.start >= n."end" OR n."end" > s.units
         OR NOT c.is_us OR NOT c.answer_eligible
         OR (n.scope = 'aircraft' AND (SELECT count(*) FROM case_aircraft a
               WHERE a.generation_id = n.generation_id AND a.ntsb_no = n.ntsb_no) <> 1)
      LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'passage % does not match section % of an answer-eligible US case in generation %',
        bad.passage_id, bad.section_id, bad.generation_id USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'passages are immutable: UPDATE rejected' USING ERRCODE = '55000';
  END IF;
  SELECT o.generation_id INTO bad FROM old_rows o JOIN dataset_generations g ON g.id = o.generation_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'passages of generation % are deleted only with the generation', bad.generation_id USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER passages_guard_insert AFTER INSERT ON passages REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION passages_write_guard();
--> statement-breakpoint
CREATE TRIGGER passages_guard_update AFTER UPDATE ON passages REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION passages_write_guard();
--> statement-breakpoint
CREATE TRIGGER passages_guard_delete AFTER DELETE ON passages REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION passages_write_guard();
--> statement-breakpoint
CREATE FUNCTION passages_generation_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM passages p USING old_rows o WHERE p.generation_id = o.id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER dataset_generations_passages_cleanup AFTER DELETE ON dataset_generations
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION passages_generation_cleanup();
--> statement-breakpoint
REVOKE ALL ON FUNCTION passages_write_guard(), passages_generation_cleanup() FROM PUBLIC;
--> statement-breakpoint
-- aviation_ingest builds passages and fills the cache: insert and read only. REVOKE
-- ALL also covers MAINTAIN on PostgreSQL 17 and is valid on 16.
REVOKE ALL ON TABLE "passages", "embedding_cache" FROM aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "passages", "embedding_cache" TO aviation_ingest;
--> statement-breakpoint
-- aviation_app resolves citations through passages; it does not read cached vectors.
REVOKE ALL ON TABLE "passages", "embedding_cache" FROM aviation_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "passages" TO aviation_app;
