-- Index builds and alias switch attempts (Task 7, gate G3): see server/db/schema/search.ts.
CREATE TABLE "index_builds" (
	"build_id" text PRIMARY KEY NOT NULL,
	"index_name" text NOT NULL,
	"alias" text NOT NULL,
	"generation_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "index_builds_index_unique" UNIQUE("index_name"),
	CONSTRAINT "index_builds_build_id_check" CHECK ("index_builds"."build_id" ~ '^[a-z0-9]{4,32}$'),
	CONSTRAINT "index_builds_names_check" CHECK ("index_builds"."index_name" ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and "index_builds"."alias" ~ '^[a-z0-9][a-z0-9._-]{0,254}$')
);
--> statement-breakpoint
CREATE TABLE "index_switch_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "index_switch_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"alias" text NOT NULL,
	"index_name" text NOT NULL,
	"build_id" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"declared_abandoned_at" timestamp with time zone,
	"declared_reason" text,
	CONSTRAINT "index_switch_attempts_outcome_check" CHECK ("index_switch_attempts"."outcome" in ('pending', 'committed', 'rejected', 'unknown')),
	CONSTRAINT "index_switch_attempts_resolved_check" CHECK (("index_switch_attempts"."outcome" = 'pending') = ("index_switch_attempts"."resolved_at" is null)),
	CONSTRAINT "index_switch_attempts_declared_check" CHECK (("index_switch_attempts"."declared_abandoned_at" is null) = ("index_switch_attempts"."declared_reason" is null)
        and ("index_switch_attempts"."declared_reason" is null or ("index_switch_attempts"."declared_reason" ~ '\S' and length("index_switch_attempts"."declared_reason") <= 500))
        and ("index_switch_attempts"."declared_abandoned_at" is null or "index_switch_attempts"."outcome" in ('unknown', 'committed'))),
	CONSTRAINT "index_switch_attempts_names_check" CHECK ("index_switch_attempts"."index_name" ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and "index_switch_attempts"."alias" ~ '^[a-z0-9][a-z0-9._-]{0,254}$')
);
--> statement-breakpoint
CREATE INDEX "index_switch_attempts_alias_idx" ON "index_switch_attempts" USING btree ("alias","outcome");--> statement-breakpoint
CREATE INDEX "index_switch_attempts_index_idx" ON "index_switch_attempts" USING btree ("index_name");--> statement-breakpoint
-- Switch attempts are append-only and resolve once: pending -> committed | rejected |
-- unknown, and unknown -> committed (a read-back showed the index as a target).
-- Committed and rejected are final. A declaration (operator, with a reason) is set
-- once, only on an unknown attempt, and never changes the outcome.
CREATE FUNCTION index_switch_attempts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'index switch attempts are never deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.alias, NEW.index_name, NEW.build_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.alias, OLD.index_name, OLD.build_id, OLD.created_at) THEN
    RAISE EXCEPTION 'index switch attempt % identity is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND (OLD.outcome, NEW.outcome) NOT IN (
       ('pending', 'committed'), ('pending', 'rejected'), ('pending', 'unknown'), ('unknown', 'committed')) THEN
    RAISE EXCEPTION 'index switch attempt % cannot go from % to %', OLD.id, OLD.outcome, NEW.outcome USING ERRCODE = '55000';
  END IF;
  IF NEW.outcome = OLD.outcome AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'index switch attempt % resolution time is immutable', OLD.id USING ERRCODE = '55000';
  END IF;
  IF (NEW.declared_abandoned_at, NEW.declared_reason) IS DISTINCT FROM (OLD.declared_abandoned_at, OLD.declared_reason)
     AND NOT (OLD.declared_abandoned_at IS NULL AND OLD.outcome = 'unknown' AND NEW.outcome = 'unknown') THEN
    RAISE EXCEPTION 'index switch attempt % can be declared abandoned only once, while unknown', OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER index_switch_attempts_guard BEFORE UPDATE OR DELETE ON index_switch_attempts
  FOR EACH ROW EXECUTE FUNCTION index_switch_attempts_guard();
--> statement-breakpoint
-- A build row is written once; only its deletion time is set later, once.
CREATE FUNCTION index_builds_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'index builds are never deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.build_id, NEW.index_name, NEW.alias, NEW.generation_id, NEW.created_at)
     IS DISTINCT FROM (OLD.build_id, OLD.index_name, OLD.alias, OLD.generation_id, OLD.created_at)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'index build % is immutable except for its deletion time, set once', OLD.build_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER index_builds_guard BEFORE UPDATE OR DELETE ON index_builds
  FOR EACH ROW EXECUTE FUNCTION index_builds_guard();
--> statement-breakpoint
-- Workers record builds and attempts; the API role only reads (default privileges
-- grant SELECT). Revoking table-level UPDATE also drops column grants, so the column
-- grants come after it.
GRANT SELECT, INSERT ON TABLE "index_builds", "index_switch_attempts" TO aviation_ingest;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "index_builds", "index_switch_attempts" FROM aviation_ingest;
--> statement-breakpoint
GRANT UPDATE ("deleted_at") ON TABLE "index_builds" TO aviation_ingest;
--> statement-breakpoint
GRANT UPDATE ("outcome", "resolved_at", "declared_abandoned_at", "declared_reason") ON TABLE "index_switch_attempts" TO aviation_ingest;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "index_switch_attempts_id_seq" TO aviation_ingest;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "index_builds", "index_switch_attempts" FROM aviation_app;
