CREATE TABLE "evidence_feedback_daily" (
	"day" date NOT NULL,
	"ranking" text NOT NULL,
	"rating" text NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "evidence_feedback_daily_day_ranking_rating_pk" PRIMARY KEY("day","ranking","rating"),
	CONSTRAINT "feedback_values" CHECK ("evidence_feedback_daily"."count" >= 0 and "evidence_feedback_daily"."rating" in ('useful','not_useful') and "evidence_feedback_daily"."ranking" ~ '^[a-zA-Z0-9._-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "evidence_searches" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "evidence_searches" ADD COLUMN "feedback_rating" text;--> statement-breakpoint
ALTER TABLE "evidence_searches" ADD COLUMN "feedback_day" date;--> statement-breakpoint
-- Provisioning grants SELECT by default: aggregates are app-readable, never ingestion data.
REVOKE ALL ON evidence_feedback_daily FROM PUBLIC, aviation_ingest, aviation_app;
GRANT SELECT ON evidence_feedback_daily TO aviation_app;
GRANT UPDATE (trace_id, feedback_rating) ON evidence_searches TO aviation_app;
--> statement-breakpoint
-- No public identifiers or content in the aggregate. The first rating fixes its UTC day;
-- subsequent changes move one count between ratings on that day, even across midnight.
CREATE FUNCTION evidence_feedback_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE version text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.feedback_rating IS NOT NULL OR NEW.feedback_day IS NOT NULL THEN
      RAISE EXCEPTION 'rating requires a completed search' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF NEW.trace_id IS DISTINCT FROM OLD.trace_id AND (OLD.trace_id IS NOT NULL OR OLD.status <> 'running') THEN
      RAISE EXCEPTION 'search trace is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.feedback_day IS DISTINCT FROM OLD.feedback_day THEN
      RAISE EXCEPTION 'rating day is server owned' USING ERRCODE = '55000';
    END IF;
    IF NEW.feedback_rating IS DISTINCT FROM OLD.feedback_rating THEN
      IF OLD.status <> 'results' OR OLD.expires_at <= clock_timestamp() OR NEW.feedback_rating IS NULL THEN
        RAISE EXCEPTION 'rating requires an unexpired result' USING ERRCODE = '55000';
      END IF;
      IF NEW.feedback_rating NOT IN ('useful','not_useful') THEN
        RAISE EXCEPTION 'invalid rating' USING ERRCODE = '22023';
      END IF;
      NEW.feedback_day := coalesce(OLD.feedback_day, (clock_timestamp() AT TIME ZONE 'UTC')::date);
      version := coalesce(OLD.data->'rankingConfig'->>'version', 'legacy');
      -- Consistent aggregate lock order for simultaneous opposite changes.
      PERFORM pg_advisory_xact_lock(7311905061);
      IF OLD.feedback_rating IS NOT NULL THEN
        UPDATE evidence_feedback_daily SET count = count - 1
          WHERE day = OLD.feedback_day AND ranking = version AND rating = OLD.feedback_rating;
      END IF;
      INSERT INTO evidence_feedback_daily(day, ranking, rating, count) VALUES (NEW.feedback_day, version, NEW.feedback_rating, 1)
        ON CONFLICT (day,ranking,rating) DO UPDATE SET count = evidence_feedback_daily.count + 1;
    END IF;
  END IF;
  IF NEW.trace_id IS NOT NULL AND NEW.trace_id !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'invalid trace id' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION evidence_feedback_guard() FROM PUBLIC;
CREATE TRIGGER evidence_feedback_guard BEFORE INSERT OR UPDATE ON evidence_searches
FOR EACH ROW EXECUTE FUNCTION evidence_feedback_guard();

--> statement-breakpoint
CREATE TABLE "evidence_usage" (
	"reservation_id" bigint PRIMARY KEY NOT NULL,
	"free_undo" boolean NOT NULL,
	"outcome" text,
	CONSTRAINT "evidence_usage_outcome" CHECK ("evidence_usage"."outcome" is null or "evidence_usage"."outcome" in ('results','failed'))
);
--> statement-breakpoint
ALTER TABLE "evidence_usage" ADD CONSTRAINT "evidence_usage_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON evidence_usage FROM PUBLIC, aviation_ingest, aviation_app;
GRANT SELECT ON evidence_usage TO aviation_app;
--> statement-breakpoint
-- Reservations have no original-quota flag after a failed search refunds its quota.
-- Capture the exemption before that can happen; this never writes money or quota rows.
CREATE FUNCTION record_evidence_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'reservations' THEN
    IF NEW.category = 'interactive' AND NEW.request_id LIKE 'evidence:%' THEN
      INSERT INTO evidence_usage(reservation_id,free_undo) VALUES (NEW.id, NOT NEW.quota_counted);
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE evidence_usage SET outcome = 'failed' WHERE reservation_id = OLD.reservation_id AND outcome IS NULL;
    RETURN OLD;
  END IF;
  IF NEW.status IN ('results','failed') THEN
    UPDATE evidence_usage SET outcome = NEW.status WHERE reservation_id = NEW.reservation_id AND outcome IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_evidence_usage() FROM PUBLIC;
CREATE TRIGGER record_evidence_admission AFTER INSERT ON reservations FOR EACH ROW EXECUTE FUNCTION record_evidence_usage();
CREATE TRIGGER record_evidence_outcome AFTER UPDATE OR DELETE ON evidence_searches FOR EACH ROW EXECUTE FUNCTION record_evidence_usage();
--> statement-breakpoint
-- Existing private searches provide an exact backfill for their remaining 24-hour window.
INSERT INTO evidence_usage(reservation_id, free_undo, outcome)
SELECT e.reservation_id, coalesce(e.data->>'freeUndo','false') = 'true', CASE WHEN e.status IN ('results','failed') THEN e.status ELSE NULL END
FROM evidence_searches e JOIN reservations r ON r.id = e.reservation_id ON CONFLICT DO NOTHING;
