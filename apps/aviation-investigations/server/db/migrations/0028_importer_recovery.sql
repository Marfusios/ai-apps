CREATE TABLE "import_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"artifact_id" uuid,
	"kind" text NOT NULL,
	"publication" jsonb,
	"accepted" jsonb,
	"canary" jsonb,
	"evidence_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_attestations_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "import_attestation_kind" CHECK ("import_attestations"."kind" in ('legacy','publication','recertification','rebaseline','abandon')),
	CONSTRAINT "import_attestation_digest" CHECK ("import_attestations"."evidence_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "import_artifacts" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_control" ADD COLUMN "last_fetched" jsonb;--> statement-breakpoint
ALTER TABLE "import_control" ADD COLUMN "pending" jsonb;--> statement-breakpoint
ALTER TABLE "import_control" ADD COLUMN "pending_observation" jsonb;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "pending_run_id" uuid;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "success_publication" jsonb;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "acknowledgement_sha256" text;--> statement-breakpoint
ALTER TABLE "import_attestations" ADD CONSTRAINT "import_attestations_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_attestations" ADD CONSTRAINT "import_attestations_artifact_id_import_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."import_artifacts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Keep the current accepted source observation for rollback/manual-publication recovery.
INSERT INTO import_attestations(kind,publication,accepted,evidence_sha256)
 SELECT 'legacy',accepted->'manifest',accepted,encode(sha256(convert_to(accepted::text,'UTF8')),'hex')
 FROM import_control WHERE accepted IS NOT NULL;
--> statement-breakpoint
-- Preserve earlier acceptance evidence before later code/image re-certification.
INSERT INTO import_attestations(artifact_id,kind,publication,canary,evidence_sha256)
 SELECT id,'legacy',publication,canary,encode(sha256(convert_to(canary::text,'UTF8')),'hex')
 FROM import_artifacts WHERE canary IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_assert_fence(p_fence uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c import_control%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(7311905028);
 SELECT * INTO c FROM import_control WHERE id=1 FOR UPDATE;
 IF NOT FOUND OR c.restore_required OR NOT EXISTS (
   SELECT 1 FROM paid_operations_hold WHERE id=1 AND held_at IS NULL
     AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
   RAISE EXCEPTION 'import restore review required' USING ERRCODE='P2602';
 END IF;
 IF c.fence IS DISTINCT FROM p_fence OR p_fence IS NULL OR NOT EXISTS (
   SELECT 1 FROM pg_locks WHERE pid=c.owner_pid AND locktype='advisory' AND granted
     AND classid=1 AND objid=3016937731 AND objsubid=1
     AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
   RAISE EXCEPTION 'import fence lost' USING ERRCODE='P2601';
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_claim() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := gen_random_uuid();
BEGIN
 PERFORM pg_advisory_xact_lock(7311905028);
 IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
    AND classid=1 AND objid=3016937731 AND objsubid=1) THEN
   RAISE EXCEPTION 'import session lock required' USING ERRCODE='P2601';
 END IF;
 UPDATE import_control SET fence=f, owner_pid=pg_backend_pid(), updated_at=clock_timestamp()
   WHERE id=1 AND NOT restore_required AND EXISTS (SELECT 1 FROM paid_operations_hold WHERE id=1 AND held_at IS NULL
     AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()));
 IF NOT FOUND THEN RAISE EXCEPTION 'import accounting review required' USING ERRCODE='P2602'; END IF;
 RETURN f;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_check_budget(p_id uuid, p_fence uuid, p_micros bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a import_artifacts%ROWTYPE; charged bigint;
BEGIN
 PERFORM import_assert_fence(p_fence);
 SELECT * INTO a FROM import_artifacts WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR a.needs_review OR a.resolved_at IS NOT NULL OR p_micros IS NULL OR p_micros < 0 OR (a.first_reservation_at IS NOT NULL
    AND clock_timestamp() >= a.first_reservation_at + interval '2136 hours') THEN
   RAISE EXCEPTION 'import accounting review required' USING ERRCODE='P2604';
 END IF;
 IF EXISTS (SELECT 1 FROM reservations WHERE import_artifact_id=p_id
   AND (status NOT IN ('open','settled','expired_charged') OR (status<>'open' AND charged_usd IS NULL))) THEN
   RAISE EXCEPTION 'unknown import accounting' USING ERRCODE='P2604';
 END IF;
 SELECT coalesce(sum(CASE WHEN status='open' THEN usd ELSE charged_usd END)*1000000,0)::bigint
   INTO charged FROM reservations WHERE import_artifact_id=p_id;
 IF charged + p_micros > 500000 THEN RAISE EXCEPTION 'import cap exhausted' USING ERRCODE='P2603'; END IF;
 RETURN charged;
END $$;
--> statement-breakpoint
CREATE FUNCTION import_attestation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(nullif(current_setting('aviation.import_fence',true),'')::uuid);
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable import attestation' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_attestation_guard BEFORE INSERT OR UPDATE OR DELETE ON import_attestations
 FOR EACH ROW EXECUTE FUNCTION import_attestation_guard();
--> statement-breakpoint
REVOKE ALL ON import_attestations FROM PUBLIC,aviation_app,aviation_ingest;
GRANT SELECT ON import_attestations TO aviation_ingest;
GRANT INSERT(run_id,artifact_id,kind,publication,accepted,canary,evidence_sha256) ON import_attestations TO aviation_ingest;
GRANT UPDATE(success_publication,pending_run_id) ON import_runs TO aviation_ingest;
REVOKE ALL ON FUNCTION import_attestation_guard() FROM PUBLIC;
--> statement-breakpoint
-- The original candidate survives the extraction/registration gap. Updates cannot replace it,
-- reset its retry history, or clear a review; acceptance or an audited operator decision does that.
CREATE FUNCTION import_set_pending(p_fence uuid,p_value jsonb,p_fetched boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior jsonb;
BEGIN
 PERFORM import_assert_fence(p_fence);
 SELECT pending INTO prior FROM import_control WHERE id=1;
 IF p_value IS NULL OR octet_length(p_value::text)>4096 OR jsonb_typeof(p_value)<>'object'
   OR (p_value - 'archive' - 'observation' - 'fetchedAt' - 'runId' - 'artifactId' - 'content' - 'attempts' - 'needsReview' - 'reason')<>'{}'::jsonb
   OR (p_value->>'archive') !~ '^[0-9a-f]{64}$' OR p_value->>'archive' IS NULL
   OR (p_value->>'attempts') !~ '^[0-4]$' OR p_value->>'attempts' IS NULL
   OR jsonb_typeof(p_value->'needsReview') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_value->'observation') IS DISTINCT FROM 'object'
   OR NOT EXISTS (SELECT 1 FROM import_runs WHERE id=(p_value->>'runId')::uuid)
   OR (p_value->>'content' IS NOT NULL AND (p_value->>'content') !~ '^[0-9a-f]{64}$')
   OR (p_value->>'artifactId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_artifacts
     WHERE id=(p_value->>'artifactId')::uuid AND content_sha256=p_value->>'content')) THEN
   RAISE EXCEPTION 'invalid pending import' USING ERRCODE='55000';
 END IF;
 IF prior IS NOT NULL AND (
   (prior->'archive',prior->'observation',prior->'fetchedAt',prior->'runId')
      IS DISTINCT FROM (p_value->'archive',p_value->'observation',p_value->'fetchedAt',p_value->'runId')
   OR (prior->>'attempts')::integer>(p_value->>'attempts')::integer
   OR (prior->>'needsReview')::boolean AND NOT (p_value->>'needsReview')::boolean
   OR prior->>'artifactId' IS NOT NULL AND prior->>'artifactId' IS DISTINCT FROM p_value->>'artifactId'
   OR prior->>'content' IS NOT NULL AND prior->>'content' IS DISTINCT FROM p_value->>'content'
   OR p_fetched) THEN
   RAISE EXCEPTION 'immutable pending import identity' USING ERRCODE='55000';
 END IF;
 UPDATE import_control SET pending=p_value,
   last_fetched=CASE WHEN p_fetched OR last_fetched->>'runId'=p_value->>'runId' THEN
     p_value || jsonb_build_object('state',CASE WHEN (p_value->>'needsReview')::boolean THEN 'needs_review' ELSE 'pending' END)
     ELSE last_fetched END,
   last_remote_fetch_at=CASE WHEN p_fetched AND prior IS NULL THEN clock_timestamp() ELSE last_remote_fetch_at END,
   updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
CREATE FUNCTION import_observe_pending(p_fence uuid,p_observation jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 IF p_observation IS NULL OR octet_length(p_observation::text)>512
   OR jsonb_typeof(p_observation)<>'object'
   OR (p_observation - 'advertisedAtLocal' - 'bytes')<>'{}'::jsonb
   OR p_observation->>'advertisedAtLocal' IS NULL
   OR (p_observation->>'advertisedAtLocal') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'
   OR p_observation->>'bytes' IS NULL OR (p_observation->>'bytes') !~ '^\d+$' THEN
   RAISE EXCEPTION 'invalid pending observation' USING ERRCODE='55000';
 END IF;
 UPDATE import_control SET pending_observation=p_observation,updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_accept(p_fence uuid,p_accepted jsonb,p_fetched boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate jsonb;
BEGIN
 PERFORM import_assert_fence(p_fence);
 SELECT pending INTO candidate FROM import_control WHERE id=1;
 -- A remote timestamp may only advance together with its durable fetched identity.
 IF p_fetched THEN RAISE EXCEPTION 'use durable pending acquisition' USING ERRCODE='55000'; END IF;
 IF p_accepted IS NOT NULL AND candidate IS NOT NULL AND (
   (candidate->>'needsReview')::boolean OR candidate->>'content' IS DISTINCT FROM p_accepted->>'content') THEN
   RAISE EXCEPTION 'unresolved pending import' USING ERRCODE='55000';
 END IF;
 UPDATE import_control SET accepted=coalesce(p_accepted,accepted),
   last_fetched=CASE WHEN p_accepted IS NOT NULL AND candidate IS NOT NULL AND last_fetched->>'runId'=candidate->>'runId'
     THEN jsonb_set(last_fetched,'{state}','"accepted"') ELSE last_fetched END,
   pending=CASE WHEN p_accepted IS NOT NULL THEN NULL ELSE pending END,
   pending_observation=CASE WHEN p_accepted IS NOT NULL THEN NULL ELSE pending_observation END,
   updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
CREATE FUNCTION import_approve_pending(p_fence uuid,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_check_budget(p_id,p_fence,0);
 IF NOT EXISTS (SELECT 1 FROM import_artifacts WHERE id=p_id AND approved IS NOT NULL AND NOT needs_review) THEN
   RAISE EXCEPTION 'named approval required' USING ERRCODE='55000';
 END IF;
 UPDATE import_control SET pending=jsonb_set(jsonb_set(pending,'{needsReview}','false'),'{reason}','null'),
   updated_at=clock_timestamp() WHERE id=1 AND pending->>'artifactId'=p_id::text;
END $$;
--> statement-breakpoint
-- Acknowledgement is intentionally conservative: this command covers a setup failure
-- before any artifact existed. Later ambiguous failures require a separate reviewed repair.
CREATE FUNCTION import_acknowledge_preartifact(p_fence uuid,p_run uuid,p_original text,p_evidence text,p_apply boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r import_runs%ROWTYPE; fingerprint text;
BEGIN
 PERFORM import_assert_fence(p_fence);
 PERFORM pg_advisory_xact_lock(7311905022);
 SELECT * INTO r FROM import_runs WHERE id=p_run FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown preartifact failure' USING ERRCODE='55000'; END IF;
 fingerprint:=encode(sha256(convert_to((to_jsonb(r)-'acknowledged_at'-'acknowledgement_sha256')::text,'UTF8')),'hex');
 IF p_original IS DISTINCT FROM fingerprint OR p_evidence IS NULL OR p_evidence !~ '^[0-9a-f]{64}$'
   OR r.finished_at IS NULL OR r.result<>'needs_review' OR r.artifact_id IS NOT NULL
   OR r.canary_passed OR r.source_check_succeeded OR r.success_publication IS NOT NULL OR r.pending_run_id IS NOT NULL
   OR r.reason NOT IN ('configuration','interrupted','cleanup','storage')
   OR r.step NOT IN ('check','acquire','extract','cleanup')
   OR EXISTS (SELECT 1 FROM import_control WHERE pending IS NOT NULL)
   OR EXISTS (SELECT 1 FROM import_artifacts WHERE created_at<=r.finished_at)
   OR EXISTS (SELECT 1 FROM ingestion_runs WHERE status='running' OR started_at BETWEEN r.checked_at AND r.finished_at
     OR finished_at BETWEEN r.checked_at AND r.finished_at)
   OR EXISTS (SELECT 1 FROM dataset_generations WHERE created_at BETWEEN r.checked_at AND r.finished_at)
   OR EXISTS (SELECT 1 FROM index_builds WHERE created_at BETWEEN r.checked_at AND r.finished_at)
   OR EXISTS (SELECT 1 FROM reservations WHERE category='indexing' AND
     (status='open' OR created_at BETWEEN r.checked_at AND r.finished_at))
   OR EXISTS (SELECT 1 FROM dataset_manifests WHERE published_at BETWEEN r.checked_at AND r.finished_at)
   OR EXISTS (SELECT 1 FROM index_switch_attempts WHERE outcome IN ('pending','unknown')
     OR created_at BETWEEN r.checked_at AND r.finished_at)
   OR (r.acknowledgement_sha256 IS NOT NULL AND r.acknowledgement_sha256<>p_evidence) THEN
   RAISE EXCEPTION 'preartifact acknowledgement not proved' USING ERRCODE='55000';
 END IF;
 IF p_apply AND r.acknowledged_at IS NULL THEN
   UPDATE import_runs SET acknowledged_at=clock_timestamp(),acknowledgement_sha256=p_evidence WHERE id=p_run;
 END IF;
 RETURN true;
END $$;
--> statement-breakpoint
-- Rebaseline adopts only the exact serving manifest. A reviewed abandoned candidate
-- keeps its immutable identity, ledger, reason and attempts and can never resume.
CREATE FUNCTION import_rebaseline(p_fence uuid,p_attestation uuid,p_artifact uuid,p_pending_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE proof import_attestations%ROWTYPE; current_publication jsonb; a import_artifacts%ROWTYPE; pending_value jsonb;
BEGIN
 PERFORM import_assert_fence(p_fence);
 PERFORM pg_advisory_xact_lock(7311905022);
 SELECT * INTO proof FROM import_attestations WHERE id=p_attestation AND kind='rebaseline';
 SELECT jsonb_build_object('generationId',generation_id,'casesIndex',cases_index,'passagesIndex',passages_index,
   'publishedAt',to_char(published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
   INTO current_publication FROM dataset_manifests WHERE active AND passages_index IS NOT NULL;
 IF proof.id IS NULL OR current_publication IS NULL OR proof.publication IS DISTINCT FROM current_publication
   OR proof.accepted->'manifest' IS DISTINCT FROM current_publication
   OR NOT EXISTS(SELECT 1 FROM dataset_generations g WHERE g.id=(current_publication->>'generationId')::bigint
     AND g.archive_sha256=proof.accepted->>'archive' AND g.verification_status='ok'
     AND g.verification_report_sha256=proof.accepted->'validation'->>'genericReport'
     AND g.verifier_version=proof.accepted->'validation'->>'verifier')
   OR coalesce(proof.accepted->'validation'->>'probes','') !~ '^[0-9a-f]{64}$'
   OR EXISTS (SELECT 1 FROM index_switch_attempts WHERE outcome IN ('pending','unknown')) THEN
   RAISE EXCEPTION 'rebaseline identity unavailable' USING ERRCODE='55000';
 END IF;
 IF EXISTS (SELECT 1 FROM import_artifacts WHERE needs_review AND resolved_at IS NULL
    AND (p_artifact IS NULL OR id<>p_artifact)) THEN
   RAISE EXCEPTION 'another unresolved import review' USING ERRCODE='55000';
 END IF;
 IF p_artifact IS NOT NULL THEN
   SELECT * INTO a FROM import_artifacts WHERE id=p_artifact FOR UPDATE;
   IF NOT FOUND OR NOT a.needs_review OR a.resolved_at IS NOT NULL
     OR a.reason IN ('accounting','restore_hold','import_cap')
     OR a.publication=current_publication AND a.rollback IS NULL
     OR a.first_reservation_at<=clock_timestamp()-interval '2136 hours' THEN
     RAISE EXCEPTION 'candidate resolution unavailable' USING ERRCODE='P2604';
   END IF;
   -- Check the complete accounting history without waiving or permanently clearing its review.
   UPDATE import_artifacts SET needs_review=false WHERE id=p_artifact;
   PERFORM import_check_budget(p_artifact,p_fence,0);
   UPDATE import_artifacts SET needs_review=true,resolved_at=clock_timestamp() WHERE id=p_artifact;
 END IF;
 SELECT pending INTO pending_value FROM import_control WHERE id=1;
 IF pending_value IS NOT NULL AND (pending_value->>'runId' IS DISTINCT FROM p_pending_run::text
   OR (pending_value->>'artifactId' IS NOT NULL AND pending_value->>'artifactId' IS DISTINCT FROM p_artifact::text)) THEN
   RAISE EXCEPTION 'pending resolution identity changed' USING ERRCODE='55000';
 END IF;
 UPDATE import_control SET accepted=proof.accepted,
   last_fetched=CASE WHEN pending_value IS NOT NULL AND last_fetched->>'runId'=pending_value->>'runId'
     THEN jsonb_set(last_fetched,'{state}','"reviewed_abandoned"') ELSE last_fetched END,
   pending=NULL,pending_observation=NULL,updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_set_pending(uuid,jsonb,boolean),import_observe_pending(uuid,jsonb),
 import_approve_pending(uuid,uuid),import_acknowledge_preartifact(uuid,uuid,text,text,boolean),
 import_rebaseline(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_set_pending(uuid,jsonb,boolean),import_observe_pending(uuid,jsonb),
 import_approve_pending(uuid,uuid),import_acknowledge_preartifact(uuid,uuid,text,text,boolean),
 import_rebaseline(uuid,uuid,uuid,uuid) TO aviation_ingest;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_status_rows() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.checked_at DESC),'[]'::jsonb) FROM (
   SELECT r.checked_at, jsonb_build_object(
     'public',jsonb_build_object('checkedAt',to_char(r.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'finishedAt',to_char(r.finished_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'mode',r.mode,
       'source',r.source,'archiveSha256',coalesce(r.observed_sha256,a.archive_sha256),'generationId',coalesce((r.success_publication->>'generationId')::bigint,a.generation_id),
       'step',r.step,'result',r.result,'reason',r.reason,'costUsd',
       CASE WHEN a.first_reservation_at IS NOT NULL AND clock_timestamp() >= a.first_reservation_at+interval '2136 hours'
         THEN coalesce((SELECT rr.reported_cost_usd FROM import_runs rr WHERE rr.artifact_id=a.id ORDER BY rr.checked_at DESC LIMIT 1),0)
         ELSE coalesce((SELECT sum(CASE WHEN status='open' THEN usd ELSE charged_usd END) FROM reservations WHERE import_artifact_id=a.id),0) END),
     'sourceCheckSucceeded',r.source_check_succeeded,'canaryPassed',r.canary_passed,
     'unresolved',coalesce(a.needs_review AND a.resolved_at IS NULL,false) OR coalesce((SELECT restore_required FROM import_control WHERE id=1),true)
   ) AS value FROM import_runs r LEFT JOIN import_artifacts a ON a.id=r.artifact_id
   ORDER BY r.checked_at DESC LIMIT 2000
 ) x
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_status_attention() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT restore_required FROM import_control WHERE id=1),true)
   OR EXISTS (SELECT 1 FROM import_artifacts WHERE needs_review AND resolved_at IS NULL)
   OR EXISTS (SELECT 1 FROM import_runs WHERE result='needs_review' AND artifact_id IS NULL AND acknowledged_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM import_attestations t WHERE t.kind='rebaseline' AND t.accepted->>'resolvedPendingRun' IN (import_runs.id::text,import_runs.pending_run_id::text)))
   OR EXISTS (SELECT 1 FROM import_control WHERE (pending->>'needsReview')::boolean)
   OR EXISTS (SELECT 1 FROM import_runs WHERE result='running' AND heartbeat_at<now()-interval '3 hours')
   OR EXISTS (SELECT 1 FROM import_index_refs r JOIN index_switch_attempts a ON a.index_name=r.index_name
     WHERE r.released_at IS NULL AND a.outcome IN ('pending','unknown'))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_prune_runs(p_fence uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 DELETE FROM import_runs WHERE finished_at IS NOT NULL AND id NOT IN (
   SELECT run_id FROM import_attestations WHERE run_id IS NOT NULL
   UNION SELECT id FROM import_runs WHERE acknowledged_at IS NOT NULL
   UNION SELECT pending_run_id FROM import_runs WHERE pending_run_id IS NOT NULL
   UNION SELECT (pending->>'runId')::uuid FROM import_control WHERE pending IS NOT NULL
   UNION SELECT id FROM (SELECT id FROM import_runs ORDER BY checked_at DESC LIMIT 200) newest
   UNION SELECT id FROM (SELECT id FROM import_runs WHERE result='published' AND canary_passed ORDER BY checked_at DESC LIMIT 1) success
   UNION SELECT id FROM (SELECT id FROM import_runs WHERE source_check_succeeded AND finished_at IS NOT NULL ORDER BY checked_at DESC LIMIT 1) checked
   UNION SELECT id FROM (SELECT DISTINCT ON (artifact_id,reason) id FROM import_runs WHERE result='needs_review'
     ORDER BY artifact_id,reason,checked_at DESC) unresolved
   UNION SELECT id FROM (SELECT DISTINCT ON (artifact_id) id FROM import_runs WHERE artifact_id IS NOT NULL
     ORDER BY artifact_id,checked_at DESC) artifact_report
 );
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_write_guard() RETURNS trigger
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
   IF TG_OP='UPDATE' AND ((OLD.pending_run_id IS NOT NULL AND NEW.pending_run_id IS DISTINCT FROM OLD.pending_run_id)
     OR (OLD.success_publication IS NOT NULL AND NEW.success_publication IS DISTINCT FROM OLD.success_publication)
     OR (OLD.acknowledged_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)) THEN
     RAISE EXCEPTION 'immutable import run evidence' USING ERRCODE='55000';
   END IF;
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
