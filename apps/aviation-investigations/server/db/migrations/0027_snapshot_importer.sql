CREATE TABLE "import_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_reservation_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"reason" text,
	"generation_id" bigint,
	"baseline" jsonb,
	"certificate" jsonb,
	"publication" jsonb,
	"approved" jsonb,
	"canary" jsonb,
	"rollback" jsonb,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "import_artifact_identity" UNIQUE("environment","archive_sha256"),
	CONSTRAINT "import_artifact_environment" CHECK ("import_artifacts"."environment" in ('dev','live')),
	CONSTRAINT "import_artifact_digests" CHECK ("import_artifacts"."archive_sha256" ~ '^[0-9a-f]{64}$' and "import_artifacts"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_artifact_attempts" CHECK ("import_artifacts"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_control" (
	"id" smallint PRIMARY KEY NOT NULL,
	"fence" uuid,
	"owner_pid" integer,
	"restore_required" boolean DEFAULT false NOT NULL,
	"accepted" jsonb,
	"last_remote_fetch_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_control_singleton" CHECK ("import_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "import_index_refs" (
	"index_name" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"build_id" text NOT NULL,
	"generation_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "import_index_refs_index_name_artifact_id_pk" PRIMARY KEY("index_name","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" text NOT NULL,
	"source" jsonb,
	"step" text DEFAULT 'check' NOT NULL,
	"result" text DEFAULT 'running' NOT NULL,
	"reason" text,
	"source_check_succeeded" boolean DEFAULT false NOT NULL,
	"canary_passed" boolean DEFAULT false NOT NULL,
	"reported_cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"observed_sha256" text
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "import_artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "import_index_refs" ADD CONSTRAINT "import_index_refs_artifact_id_import_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."import_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_artifact_id_import_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."import_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_import_artifact_id_import_artifacts_id_fk" FOREIGN KEY ("import_artifact_id") REFERENCES "public"."import_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One import writer per database. A separate host flock spans environments.
INSERT INTO import_control (id, restore_required)
 SELECT 1, EXISTS (SELECT 1 FROM drizzle.restores);
--> statement-breakpoint
CREATE INDEX reservations_import_idx ON reservations(import_artifact_id) WHERE import_artifact_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION import_assert_fence(p_fence uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c import_control%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(7311905028); -- import lock, always before spend/lifecycle locks
 SELECT * INTO c FROM import_control WHERE id=1 FOR UPDATE;
 IF NOT FOUND OR c.restore_required OR c.fence IS DISTINCT FROM p_fence OR p_fence IS NULL
   OR NOT EXISTS (SELECT 1 FROM paid_operations_hold WHERE id=1 AND held_at IS NULL
     AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())) OR NOT EXISTS (
   SELECT 1 FROM pg_locks WHERE pid=c.owner_pid AND locktype='advisory' AND granted
     AND classid=1 AND objid=3016937731 AND objsubid=1
     AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
   RAISE EXCEPTION 'import fence or accounting unavailable' USING ERRCODE='55000';
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION import_claim() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := gen_random_uuid();
BEGIN
 PERFORM pg_advisory_xact_lock(7311905028);
 IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
    AND classid=1 AND objid=3016937731 AND objsubid=1) THEN
   RAISE EXCEPTION 'import session lock required' USING ERRCODE='55000';
 END IF;
 UPDATE import_control SET fence=f, owner_pid=pg_backend_pid(), updated_at=clock_timestamp()
   WHERE id=1 AND NOT restore_required AND EXISTS (SELECT 1 FROM paid_operations_hold WHERE id=1 AND held_at IS NULL
     AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()));
 IF NOT FOUND THEN RAISE EXCEPTION 'import accounting review required' USING ERRCODE='55000'; END IF;
 RETURN f;
END $$;
--> statement-breakpoint
CREATE FUNCTION import_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(nullif(current_setting('aviation.import_fence',true),'')::uuid);
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'import identity cannot be deleted' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='import_artifacts' AND TG_OP='UPDATE' THEN
   IF (NEW.id,NEW.environment,NEW.archive_sha256,NEW.content_sha256,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.environment,OLD.archive_sha256,OLD.content_sha256,OLD.created_at)
     OR (OLD.first_reservation_at IS NOT NULL AND NEW.first_reservation_at IS DISTINCT FROM OLD.first_reservation_at)
     OR NEW.attempts < OLD.attempts
     OR (OLD.generation_id IS NOT NULL AND NEW.generation_id IS DISTINCT FROM OLD.generation_id)
     OR NEW.baseline IS DISTINCT FROM OLD.baseline
     OR (OLD.publication IS NOT NULL AND NEW.publication IS DISTINCT FROM OLD.publication)
     OR (OLD.rollback IS NOT NULL AND NEW.rollback IS DISTINCT FROM OLD.rollback)
     OR (OLD.publication IS NOT NULL AND NEW.certificate IS DISTINCT FROM OLD.certificate)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
     RAISE EXCEPTION 'immutable import identity' USING ERRCODE='55000';
   END IF;
 END IF;
 IF TG_TABLE_NAME='import_runs' THEN
   IF NEW.mode NOT IN ('automatic','forced_dev')
     OR NEW.step NOT IN ('check','acquire','extract','load','verify','plan','index_cases','index_passages','validate','publish','canary','cleanup','complete')
     OR NEW.result NOT IN ('running','unchanged','published','needs_review','deferred','failed','skipped_dev_failed','cancelled','rolled_back')
     OR NEW.reported_cost_usd<0
     OR (NEW.observed_sha256 IS NOT NULL AND NEW.observed_sha256 !~ '^[0-9a-f]{64}$')
     OR ((NEW.result='running') <> (NEW.finished_at IS NULL))
     OR (NEW.canary_passed AND NEW.result<>'published') THEN
     RAISE EXCEPTION 'invalid import status' USING ERRCODE='55000';
   END IF;
   IF NEW.source IS NOT NULL AND (jsonb_typeof(NEW.source)<>'object'
     OR (NEW.source - 'advertisedAtLocal' - 'bytes')<>'{}'::jsonb
     OR jsonb_typeof(NEW.source->'advertisedAtLocal') IS DISTINCT FROM 'string'
     OR (NEW.source->>'advertisedAtLocal') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'
     OR jsonb_typeof(NEW.source->'bytes') IS DISTINCT FROM 'number'
     OR (NEW.source->>'bytes') !~ '^\d+$') THEN
     RAISE EXCEPTION 'invalid import source status' USING ERRCODE='55000';
   END IF;
   IF TG_OP='UPDATE' AND ((NEW.id,NEW.checked_at,NEW.mode) IS DISTINCT FROM (OLD.id,OLD.checked_at,OLD.mode)
     OR (OLD.artifact_id IS NOT NULL AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id)) THEN
     RAISE EXCEPTION 'immutable import run' USING ERRCODE='55000';
   END IF;
 END IF;
 IF NEW.reason IS NOT NULL AND NEW.reason NOT IN ('metadata_unchanged','same_archive','same_content','source_listing_changed',
   'source_reissued','source_changed_during_download','source_unavailable','source_retired','baseline_required','baseline_changed',
   'schema','integrity','verification','cohort_bounds','mapping','probe','import_cap','monthly_budget','restore_hold','accounting',
   'storage','alias_unknown','busy','backup_window','lock_lost','timeout','interrupted','dev_failed','configuration','cleanup') THEN
   RAISE EXCEPTION 'invalid import reason' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON import_artifacts
 FOR EACH ROW EXECUTE FUNCTION import_write_guard();
--> statement-breakpoint
CREATE TRIGGER import_run_guard BEFORE INSERT OR UPDATE ON import_runs
 FOR EACH ROW EXECUTE FUNCTION import_write_guard();
--> statement-breakpoint
CREATE FUNCTION import_check_budget(p_id uuid, p_fence uuid, p_micros bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a import_artifacts%ROWTYPE; charged bigint;
BEGIN
 PERFORM import_assert_fence(p_fence);
 SELECT * INTO a FROM import_artifacts WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR a.needs_review OR p_micros IS NULL OR p_micros < 0 OR (a.first_reservation_at IS NOT NULL
    AND clock_timestamp() >= a.first_reservation_at + interval '2160 hours') THEN
   RAISE EXCEPTION 'import accounting review required' USING ERRCODE='55000';
 END IF;
 IF EXISTS (SELECT 1 FROM reservations WHERE import_artifact_id=p_id
   AND (status NOT IN ('open','settled','expired_charged') OR (status<>'open' AND charged_usd IS NULL))) THEN
   RAISE EXCEPTION 'unknown import accounting' USING ERRCODE='55000';
 END IF;
 SELECT coalesce(sum(CASE WHEN status='open' THEN usd ELSE charged_usd END)*1000000,0)::bigint
   INTO charged FROM reservations WHERE import_artifact_id=p_id;
 IF charged + p_micros > 500000 THEN RAISE EXCEPTION 'import cap exhausted' USING ERRCODE='54000'; END IF;
 RETURN charged;
END $$;
--> statement-breakpoint
CREATE FUNCTION import_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.import_artifact_id IS DISTINCT FROM OLD.import_artifact_id THEN
     RAISE EXCEPTION 'immutable import tag' USING ERRCODE='55000';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.import_artifact_id IS NOT NULL THEN
   f := nullif(current_setting('aviation.import_fence',true),'')::uuid;
   IF NEW.category <> 'indexing' OR NEW.principal_kind <> 'system' THEN
     RAISE EXCEPTION 'invalid import reservation' USING ERRCODE='55000';
   END IF;
   -- Recheck with database time at INSERT too: crossing retention while planning cannot refund the cap.
   PERFORM import_check_budget(NEW.import_artifact_id,f,(NEW.usd*1000000)::bigint);
   UPDATE import_artifacts SET first_reservation_at=clock_timestamp()
     WHERE id=NEW.import_artifact_id AND first_reservation_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_reservation_guard BEFORE INSERT OR UPDATE ON reservations
 FOR EACH ROW EXECUTE FUNCTION import_reservation_guard();
--> statement-breakpoint
CREATE FUNCTION import_ref_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(nullif(current_setting('aviation.import_fence',true),'')::uuid);
 PERFORM pg_advisory_xact_lock(7311905022);
 IF TG_OP='INSERT' THEN
   IF NOT EXISTS (SELECT 1 FROM index_builds WHERE index_name=NEW.index_name AND build_id=NEW.build_id
      AND generation_id=NEW.generation_id AND deletion_requested_at IS NULL AND deleted_at IS NULL) THEN
     RAISE EXCEPTION 'candidate index unavailable' USING ERRCODE='55000';
   END IF;
 ELSIF (NEW.index_name,NEW.artifact_id,NEW.build_id,NEW.generation_id,NEW.created_at)
      IS DISTINCT FROM (OLD.index_name,OLD.artifact_id,OLD.build_id,OLD.generation_id,OLD.created_at)
      OR OLD.released_at IS NOT NULL THEN
   RAISE EXCEPTION 'immutable candidate reference' USING ERRCODE='55000';
 END IF;
 IF NEW.released_at IS NOT NULL AND EXISTS (SELECT 1 FROM index_switch_attempts WHERE index_name=NEW.index_name
   AND outcome IN ('pending','unknown')) THEN
   RAISE EXCEPTION 'unresolved alias' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_ref_guard BEFORE INSERT OR UPDATE ON import_index_refs
 FOR EACH ROW EXECUTE FUNCTION import_ref_guard();
--> statement-breakpoint
CREATE FUNCTION import_index_delete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.deletion_requested_at IS NOT NULL AND OLD.deletion_requested_at IS NULL THEN
   PERFORM pg_advisory_xact_lock(7311905022);
   IF EXISTS (SELECT 1 FROM import_index_refs WHERE index_name=NEW.index_name AND released_at IS NULL) THEN
     RAISE EXCEPTION 'protected import candidate' USING ERRCODE='55000';
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_index_delete_guard BEFORE UPDATE ON index_builds
 FOR EACH ROW EXECUTE FUNCTION import_index_delete_guard();
--> statement-breakpoint
CREATE FUNCTION import_restore_latch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.held_at IS NOT NULL OR (TG_OP='UPDATE' AND OLD.database_oid IS DISTINCT FROM NEW.database_oid) THEN
   UPDATE import_control SET restore_required=true, fence=NULL, owner_pid=NULL, updated_at=clock_timestamp() WHERE id=1;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_restore_latch AFTER INSERT OR UPDATE ON paid_operations_hold
 FOR EACH ROW EXECUTE FUNCTION import_restore_latch();
--> statement-breakpoint
-- The restore latch is deliberately NOT cleared by global restore-reconcile.
REVOKE ALL ON import_control,import_artifacts,import_runs,import_index_refs FROM PUBLIC,aviation_app,aviation_ingest;
GRANT SELECT ON import_control,import_artifacts,import_runs,import_index_refs TO aviation_ingest;
GRANT INSERT (environment,archive_sha256,content_sha256,baseline) ON import_artifacts TO aviation_ingest;
GRANT INSERT (mode) ON import_runs TO aviation_ingest;
GRANT INSERT (index_name,artifact_id,build_id,generation_id) ON import_index_refs TO aviation_ingest;
GRANT UPDATE (attempts,needs_review,reason,generation_id,baseline,certificate,publication,approved,canary,rollback,superseded_at) ON import_artifacts TO aviation_ingest;
GRANT UPDATE (artifact_id,finished_at,heartbeat_at,source,step,result,reason,source_check_succeeded,canary_passed,reported_cost_usd,observed_sha256) ON import_runs TO aviation_ingest;
GRANT UPDATE (released_at) ON import_index_refs TO aviation_ingest;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_assert_fence(uuid),import_claim(),import_write_guard(),import_check_budget(uuid,uuid,bigint),
 import_reservation_guard(),import_ref_guard(),import_index_delete_guard(),import_restore_latch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_assert_fence(uuid),import_claim(),import_check_budget(uuid,uuid,bigint) TO aviation_ingest;
--> statement-breakpoint
CREATE FUNCTION import_accept(p_fence uuid, p_accepted jsonb, p_fetched boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 UPDATE import_control SET accepted=coalesce(p_accepted,accepted),
   last_remote_fetch_at=CASE WHEN p_fetched THEN clock_timestamp() ELSE last_remote_fetch_at END,
   updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_accept(uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_accept(uuid,jsonb,boolean) TO aviation_ingest;
--> statement-breakpoint
CREATE FUNCTION import_status_rows() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.checked_at DESC),'[]'::jsonb) FROM (
   SELECT r.checked_at, jsonb_build_object(
     'public',jsonb_build_object('checkedAt',to_char(r.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'finishedAt',to_char(r.finished_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'mode',r.mode,
       'source',r.source,'archiveSha256',coalesce(r.observed_sha256,a.archive_sha256),'generationId',a.generation_id,
       'step',r.step,'result',r.result,'reason',r.reason,'costUsd',
       CASE WHEN a.first_reservation_at IS NOT NULL AND clock_timestamp() >= a.first_reservation_at+interval '2160 hours'
         THEN coalesce((SELECT rr.reported_cost_usd FROM import_runs rr WHERE rr.artifact_id=a.id ORDER BY rr.checked_at DESC LIMIT 1),0)
         ELSE coalesce((SELECT sum(CASE WHEN status='open' THEN usd ELSE charged_usd END) FROM reservations WHERE import_artifact_id=a.id),0) END),
     'sourceCheckSucceeded',r.source_check_succeeded,'canaryPassed',r.canary_passed,
     'unresolved',coalesce(a.needs_review,false) OR coalesce((SELECT restore_required FROM import_control WHERE id=1),true)
   ) AS value FROM import_runs r LEFT JOIN import_artifacts a ON a.id=r.artifact_id
   ORDER BY r.checked_at DESC LIMIT 2000
 ) x
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_status_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_status_rows() TO aviation_app,aviation_ingest;
--> statement-breakpoint
CREATE FUNCTION import_status_attention() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT restore_required FROM import_control WHERE id=1),true)
   OR EXISTS (SELECT 1 FROM import_artifacts WHERE needs_review)
   OR EXISTS (SELECT 1 FROM import_runs WHERE result='needs_review' AND artifact_id IS NULL)
   OR EXISTS (SELECT 1 FROM import_runs WHERE result='running' AND heartbeat_at<now()-interval '3 hours')
   OR EXISTS (SELECT 1 FROM import_index_refs r JOIN index_switch_attempts a ON a.index_name=r.index_name
     WHERE r.released_at IS NULL AND a.outcome IN ('pending','unknown'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_status_attention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_status_attention() TO aviation_app,aviation_ingest;
--> statement-breakpoint
CREATE FUNCTION import_prune_runs(p_fence uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 DELETE FROM import_runs WHERE finished_at IS NOT NULL AND id NOT IN (
   SELECT id FROM (SELECT id FROM import_runs ORDER BY checked_at DESC LIMIT 200) newest
   UNION SELECT id FROM (SELECT id FROM import_runs WHERE result='published' AND canary_passed ORDER BY checked_at DESC LIMIT 1) success
   UNION SELECT id FROM (SELECT id FROM import_runs WHERE source_check_succeeded AND finished_at IS NOT NULL ORDER BY checked_at DESC LIMIT 1) checked
   UNION SELECT id FROM (SELECT DISTINCT ON (artifact_id,reason) id FROM import_runs WHERE result='needs_review'
     ORDER BY artifact_id,reason,checked_at DESC) unresolved
   UNION SELECT id FROM (SELECT DISTINCT ON (artifact_id) id FROM import_runs WHERE artifact_id IS NOT NULL
     ORDER BY artifact_id,checked_at DESC) artifact_report
 );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_prune_runs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_prune_runs(uuid) TO aviation_ingest;
