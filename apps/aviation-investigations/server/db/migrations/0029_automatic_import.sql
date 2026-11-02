-- Automatic policy v2. Old evidence and money remain; legacy reviews cease to authorize or block work.
CREATE TABLE IF NOT EXISTS import_processing (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), artifact_id uuid NOT NULL REFERENCES import_artifacts(id),
 code text NOT NULL, image text NOT NULL, archive_sha256 text NOT NULL, content_sha256 text NOT NULL,
 active boolean NOT NULL DEFAULT true, phase text NOT NULL DEFAULT 'building', reason text,
 generation_id bigint, baseline jsonb NOT NULL, certificate jsonb, publication jsonb, canary jsonb, rollback jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(code ~ '^[0-9a-f]{40}$' AND image ~ '^sha256:[0-9a-f]{64}$'),
 CHECK(archive_sha256 ~ '^[0-9a-f]{64}$' AND content_sha256 ~ '^[0-9a-f]{64}$'),
 CHECK(phase IN ('building','switching','published','rolling_back','restored','complete','abandoned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS import_processing_active ON import_processing(artifact_id) WHERE active;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS import_issues (
 key text PRIMARY KEY, run_id uuid REFERENCES import_runs(id), artifact_id uuid REFERENCES import_artifacts(id),
 code text NOT NULL, image text NOT NULL, archive_sha256 text, source jsonb,
 reason text NOT NULL, step text NOT NULL, origin text NOT NULL, origin_run_id uuid, fixed boolean NOT NULL,
 site_state text NOT NULL DEFAULT 'unchanged', post_success boolean NOT NULL DEFAULT false,
 failure_day text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 CHECK(key ~ '^[0-9a-f]{64}$'), CHECK(origin IN ('dev','live','host')),
 CHECK(site_state IN ('unchanged','restored','uncertain')),
 CHECK(code ~ '^[0-9a-f]{40}$' AND image ~ '^sha256:[0-9a-f]{64}$'),
 CHECK(archive_sha256 IS NULL OR archive_sha256 ~ '^[0-9a-f]{64}$'),
 CHECK(failure_day ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
ALTER TABLE import_control ADD COLUMN IF NOT EXISTS automatic_since timestamptz NOT NULL DEFAULT now();
ALTER TABLE import_control ADD COLUMN IF NOT EXISTS switch_hold jsonb;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS changes jsonb;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS restoration jsonb;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS good_check boolean NOT NULL DEFAULT false;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill once, preserving committed identities. No legacy review is converted to a new suppression.
INSERT INTO import_processing(artifact_id,code,image,archive_sha256,content_sha256,baseline,generation_id,
 certificate,publication,canary,rollback,phase)
 SELECT a.id,coalesce(a.certificate->>'code',a.canary->>'code',repeat('0',40)),
 coalesce(a.certificate->>'deployedCode',a.canary->>'deployedCode','sha256:'||repeat('0',64)),
 a.archive_sha256,a.content_sha256,a.baseline,a.generation_id,a.certificate,a.publication,a.canary,a.rollback,
 CASE WHEN a.rollback IS NOT NULL THEN 'restored' WHEN a.canary IS NOT NULL THEN 'complete'
 WHEN a.publication IS NOT NULL THEN 'published' ELSE 'building' END
 FROM import_artifacts a WHERE a.baseline IS NOT NULL AND NOT EXISTS(SELECT 1 FROM import_processing p WHERE p.artifact_id=a.id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_automatic_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(nullif(current_setting('aviation.import_fence',true),'')::uuid);
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable import history' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='import_processing' AND TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.artifact_id,NEW.code,NEW.image,NEW.archive_sha256,NEW.content_sha256,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.artifact_id,OLD.code,OLD.image,OLD.archive_sha256,OLD.content_sha256,OLD.created_at)
   OR (OLD.publication IS NOT NULL AND (NEW.publication IS DISTINCT FROM OLD.publication OR NEW.baseline IS DISTINCT FROM OLD.baseline))
   OR (OLD.generation_id IS NOT NULL AND NEW.generation_id IS DISTINCT FROM OLD.generation_id)
   OR (OLD.rollback IS NOT NULL AND NEW.rollback IS DISTINCT FROM OLD.rollback)
   OR (OLD.active AND NOT NEW.active AND OLD.publication IS NOT NULL AND OLD.phase NOT IN ('restored','complete','abandoned'))
  THEN RAISE EXCEPTION 'immutable import attempt' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_TABLE_NAME='import_processing' AND TG_OP='UPDATE' THEN NEW.updated_at=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS import_processing_guard ON import_processing;
CREATE TRIGGER import_processing_guard BEFORE INSERT OR UPDATE OR DELETE ON import_processing FOR EACH ROW EXECUTE FUNCTION import_automatic_guard();
DROP TRIGGER IF EXISTS import_issues_guard ON import_issues;
CREATE TRIGGER import_issues_guard BEFORE INSERT OR UPDATE OR DELETE ON import_issues FOR EACH ROW EXECUTE FUNCTION import_automatic_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_write_guard () RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM import_assert_fence (nullif (current_setting ('aviation.import_fence', true), '')::uuid);
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'import identity cannot be deleted' USING ERRCODE = '55000';
    END IF;
  IF TG_TABLE_NAME = 'import_artifacts' AND TG_OP = 'UPDATE' THEN
   IF (NEW.id, NEW.environment, NEW.archive_sha256, NEW.content_sha256, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.environment, OLD.archive_sha256, OLD.content_sha256, OLD.created_at)
     OR (OLD.first_reservation_at IS NOT NULL AND NEW.first_reservation_at IS DISTINCT FROM OLD.first_reservation_at)
     OR NEW.attempts < OLD.attempts
     OR (OLD.generation_id IS NOT NULL AND NEW.generation_id IS DISTINCT FROM OLD.generation_id)
     OR NEW.baseline IS DISTINCT FROM OLD.baseline
     OR (OLD.publication IS NOT NULL AND NEW.publication IS DISTINCT FROM OLD.publication)
     OR (OLD.rollback IS NOT NULL AND NEW.rollback IS DISTINCT FROM OLD.rollback)
     OR (OLD.publication IS NOT NULL AND NEW.certificate IS DISTINCT FROM OLD.certificate)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
     RAISE EXCEPTION 'immutable import identity' USING ERRCODE = '55000';
   END IF;
  END IF;
  IF TG_TABLE_NAME = 'import_runs' THEN
   IF TG_OP = 'UPDATE' AND ((OLD.pending_run_id IS NOT NULL AND NEW.pending_run_id IS DISTINCT FROM OLD.pending_run_id)
     OR (OLD.success_publication IS NOT NULL AND NEW.success_publication IS DISTINCT FROM OLD.success_publication)
     OR (OLD.attempt_started AND NOT NEW.attempt_started)
     OR (OLD.work_kind = 'recertification' AND NEW.work_kind <> 'recertification')
     OR (OLD.acknowledged_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)) THEN
     RAISE EXCEPTION 'immutable import run evidence' USING ERRCODE = '55000';
   END IF;
   IF NEW.work_kind NOT IN ('import', 'recertification')
     OR (NEW.attempt_started AND (NEW.artifact_id IS NULL OR NEW.work_kind <> 'import'))
     OR NEW.mode NOT IN ('automatic', 'forced_dev')
     OR NEW.step NOT IN ('check', 'acquire', 'extract', 'load', 'verify', 'plan', 'index_cases',
       'index_passages', 'validate', 'publish', 'canary', 'cleanup', 'complete')
     OR NEW.result NOT IN ('running', 'unchanged', 'published', 'needs_review', 'deferred', 'failed',
       'skipped_dev_failed', 'cancelled', 'rolled_back', 'waiting')
     OR NEW.reported_cost_usd < 0
     OR (NEW.observed_sha256 IS NOT NULL AND NEW.observed_sha256 !~ '^[0-9a-f]{64}$')
     OR ((NEW.result = 'running') <> (NEW.finished_at IS NULL))
     OR (NEW.canary_passed AND NEW.result <> 'published') THEN
     RAISE EXCEPTION 'invalid import status' USING ERRCODE = '55000';
   END IF;
   IF NEW.source IS NOT NULL AND (jsonb_typeof (NEW.source) <> 'object'
     OR (NEW.source - 'advertisedAtLocal' - 'bytes') <> '{}'::jsonb
     OR jsonb_typeof (NEW.source -> 'advertisedAtLocal') IS DISTINCT FROM 'string'
     OR (NEW.source ->> 'advertisedAtLocal') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'
     OR jsonb_typeof (NEW.source -> 'bytes') IS DISTINCT FROM 'number'
     OR (NEW.source ->> 'bytes') !~ '^\d+$') THEN
     RAISE EXCEPTION 'invalid import source status' USING ERRCODE = '55000';
   END IF;
   IF TG_OP = 'UPDATE' AND ((NEW.id, NEW.checked_at, NEW.mode) IS DISTINCT FROM (OLD.id, OLD.checked_at,
     OLD.mode)
     OR (OLD.artifact_id IS NOT NULL AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id)) THEN
     RAISE EXCEPTION 'immutable import run' USING ERRCODE = '55000';
   END IF;
  END IF;
  IF NEW.reason IS NOT NULL AND NEW.reason NOT IN ('metadata_unchanged', 'same_archive', 'same_content',
    'source_listing_changed',
   'source_reissued', 'source_changed_during_download', 'source_unavailable', 'source_retired',
     'baseline_required', 'baseline_changed',
   'schema', 'integrity', 'verification', 'cohort_bounds', 'mapping', 'probe', 'import_cap',
     'monthly_budget', 'cache_miss', 'restore_hold', 'accounting',
   'storage', 'alias_unknown', 'busy', 'backup_window', 'lock_lost', 'timeout', 'interrupted',
     'dev_failed', 'configuration', 'cleanup', 'shrunk', 'unclassified', 'site_check', 'rollback_failed', 'post_success', 'manual_rollback') THEN
   RAISE EXCEPTION 'invalid import reason' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_check_budget (p_id uuid, p_fence uuid, p_micros bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a import_artifacts%ROWTYPE;
  charged bigint;
BEGIN
  PERFORM import_assert_fence (p_fence);
  SELECT * INTO a FROM import_artifacts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR p_micros IS NULL OR p_micros < 0 OR (a.first_reservation_at
    IS NOT NULL
    AND clock_timestamp () >= a.first_reservation_at + interval '2136 hours') THEN
   RAISE EXCEPTION 'import accounting review required' USING ERRCODE = 'P2604';
  END IF;
  IF EXISTS (SELECT 1 FROM reservations WHERE import_artifact_id = p_id
   AND (status NOT IN ('open', 'settled', 'expired_charged') OR (status <> 'open' AND charged_usd IS NULL)))
     THEN
   RAISE EXCEPTION 'unknown import accounting' USING ERRCODE = 'P2604';
  END IF;
  SELECT coalesce (sum (CASE WHEN status = 'open' THEN usd ELSE charged_usd END) * 1000000, 0)::bigint
   INTO charged FROM reservations WHERE import_artifact_id = p_id;
  IF charged + p_micros > 2000000 THEN RAISE EXCEPTION 'import cap exhausted' USING ERRCODE = 'P2603'; END
    IF;
  RETURN charged;
END $$;
--> statement-breakpoint
-- Pending is acquisition state, not permission. Replacement cannot bypass unresolved publication recovery.
CREATE OR REPLACE FUNCTION import_set_pending(p_fence uuid,p_value jsonb,p_fetched boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
  IF p_value IS NULL OR octet_length (p_value::text) > 4096 OR jsonb_typeof (p_value) <> 'object'
   OR (p_value - 'archive' - 'observation' - 'fetchedAt' - 'runId' - 'artifactId' - 'content' -
     'attempts' - 'needsReview' - 'reason') <> '{}'::jsonb
   OR (p_value ->> 'archive') !~ '^[0-9a-f]{64}$' OR p_value ->> 'archive' IS NULL
   OR (p_value ->> 'attempts') !~ '^\d{1,9}$' OR p_value ->> 'attempts' IS NULL
   OR jsonb_typeof (p_value -> 'fetchedAt') IS DISTINCT FROM 'string'
   OR (p_value ->> 'fetchedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
   OR NOT (p_value ? 'reason')
   OR (p_value ->> 'reason' IS NOT NULL AND p_value ->> 'reason' NOT IN ('metadata_unchanged',
     'same_archive', 'same_content', 'source_listing_changed', 'source_reissued',
     'source_changed_during_download', 'source_unavailable', 'source_retired', 'baseline_required',
     'baseline_changed', 'schema', 'integrity', 'verification', 'cohort_bounds', 'mapping', 'probe',
     'import_cap', 'monthly_budget', 'cache_miss', 'restore_hold', 'accounting', 'storage',
     'alias_unknown', 'busy', 'backup_window', 'lock_lost', 'timeout', 'interrupted', 'dev_failed',
     'configuration', 'cleanup','shrunk','unclassified','site_check','rollback_failed','manual_rollback','post_success'))
   OR jsonb_typeof (p_value -> 'needsReview') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof (p_value -> 'observation') IS DISTINCT FROM 'object'
   OR NOT EXISTS (SELECT 1 FROM import_runs WHERE id = (p_value ->> 'runId')::uuid)
   OR (p_value ->> 'content' IS NOT NULL AND (p_value ->> 'content') !~ '^[0-9a-f]{64}$')
   OR (p_value ->> 'artifactId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_artifacts
     WHERE id = (p_value ->> 'artifactId')::uuid)) THEN
   RAISE EXCEPTION 'invalid pending import' USING ERRCODE = '55000';
  END IF;
  BEGIN
   IF NOT isfinite ((p_value ->> 'fetchedAt')::timestamptz) THEN
     RAISE EXCEPTION 'invalid pending fetched time' USING ERRCODE = '55000';
   END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'invalid pending fetched time' USING ERRCODE = '55000';
  END;
 IF (SELECT pending->>'archive' FROM import_control WHERE id=1)=p_value->>'archive'
  AND (SELECT (pending->>'attempts')::bigint FROM import_control WHERE id=1) > (p_value->>'attempts')::bigint
 THEN RAISE EXCEPTION 'attempt history cannot reset' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM import_processing WHERE active AND phase IN ('switching','published','rolling_back')
 AND (archive_sha256 IS DISTINCT FROM p_value->>'archive' OR artifact_id IS DISTINCT FROM (p_value->>'artifactId')::uuid))
 THEN RAISE EXCEPTION 'publication recovery required' USING ERRCODE='P2605'; END IF;
 UPDATE import_control SET pending=p_value||jsonb_build_object('needsReview',false),
 last_fetched=CASE WHEN p_fetched THEN p_value||jsonb_build_object('state','pending') ELSE last_fetched END,
 last_remote_fetch_at=CASE WHEN p_fetched THEN (p_value->>'fetchedAt')::timestamptz ELSE last_remote_fetch_at END,
 updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_accept(p_fence uuid,p_accepted jsonb,p_fetched boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 IF p_fetched THEN RAISE EXCEPTION 'use durable acquisition' USING ERRCODE='55000'; END IF;
 UPDATE import_control SET accepted=coalesce(p_accepted,accepted),
 last_fetched=CASE WHEN p_accepted IS NOT NULL AND pending IS NOT NULL THEN pending||jsonb_build_object('state','accepted') ELSE last_fetched END,
 pending=CASE WHEN p_accepted IS NOT NULL THEN NULL ELSE pending END,
 pending_observation=CASE WHEN p_accepted IS NOT NULL THEN NULL ELSE pending_observation END,
 updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
-- Adoption and recertification leave acquisition clocks, candidates and monetary identity untouched.
CREATE OR REPLACE FUNCTION import_adopt(p_fence uuid,p_accepted jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 PERFORM pg_advisory_xact_lock(7311905022);
 IF NOT EXISTS(SELECT 1 FROM dataset_manifests WHERE active
  AND generation_id=(p_accepted->'manifest'->>'generationId')::bigint
  AND cases_index=p_accepted->'manifest'->>'casesIndex' AND passages_index=p_accepted->'manifest'->>'passagesIndex'
  AND published_at=(p_accepted->'manifest'->>'publishedAt')::timestamptz)
 THEN RAISE EXCEPTION 'serving publication changed' USING ERRCODE='55000'; END IF;
 UPDATE import_control SET accepted=p_accepted,updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_switch_hold(p_fence uuid,p_value jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 UPDATE import_control SET switch_hold=p_value,updated_at=clock_timestamp() WHERE id=1;
END $$;
--> statement-breakpoint
-- Obsolete mutators have no callers under the automatic policy. Historical attestations remain.
DROP FUNCTION IF EXISTS import_approve_pending(uuid,uuid);
DROP FUNCTION IF EXISTS import_acknowledge_preartifact(uuid,uuid,text,text,boolean);
DROP FUNCTION IF EXISTS import_rebaseline(uuid,jsonb,text,uuid,uuid);
DROP FUNCTION IF EXISTS import_resolve_abandoned_fetch(uuid);
--> statement-breakpoint
-- Health is derived from durable incidents, not a truncated recent-run window.
CREATE OR REPLACE FUNCTION import_prune_runs(p_fence uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM import_assert_fence(p_fence);
 DELETE FROM import_runs WHERE finished_at IS NOT NULL AND id NOT IN (
 SELECT run_id FROM import_attestations WHERE run_id IS NOT NULL
 UNION SELECT run_id FROM import_issues WHERE run_id IS NOT NULL
 UNION SELECT id FROM import_runs WHERE acknowledged_at IS NOT NULL OR result='needs_review'
 UNION SELECT pending_run_id FROM import_runs WHERE pending_run_id IS NOT NULL
 UNION SELECT (pending->>'runId')::uuid FROM import_control WHERE pending IS NOT NULL
 UNION SELECT id FROM (SELECT id FROM import_runs ORDER BY checked_at DESC LIMIT 200) r
 UNION SELECT id FROM (SELECT id FROM import_runs WHERE good_check ORDER BY checked_at DESC LIMIT 1) r
 UNION SELECT id FROM (SELECT DISTINCT ON(artifact_id) id FROM import_runs WHERE artifact_id IS NOT NULL ORDER BY artifact_id,checked_at DESC) r);
END $$;
--> statement-breakpoint
REVOKE ALL ON import_processing,import_issues FROM PUBLIC,aviation_app,aviation_ingest;
GRANT SELECT,INSERT,UPDATE ON import_processing,import_issues TO aviation_ingest;
GRANT UPDATE(code,image,origin,changes,restoration,good_check,suppressed) ON import_runs TO aviation_ingest;
REVOKE ALL ON FUNCTION import_automatic_guard(),import_adopt(uuid,jsonb),import_switch_hold(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_adopt(uuid,jsonb),import_switch_hold(uuid,jsonb) TO aviation_ingest;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_attempt_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.result='running' AND NEW.attempt_started AND (NEW.result IN ('published','failed','cancelled','needs_review') OR (NEW.result='deferred' AND NEW.reason IN ('interrupted','timeout','lock_lost'))) THEN
  UPDATE import_artifacts SET attempts=attempts+1 WHERE id=NEW.artifact_id;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Narrow projections: the HTTP role still cannot SELECT the worker's tables or certificates.
CREATE OR REPLACE FUNCTION import_status_time(p_time timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT to_char(p_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_public_run(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'runId',r.id,'checkedAt',import_status_time(r.checked_at),'finishedAt',import_status_time(r.finished_at),
  'code',r.code,'image',r.image,'origin',r.origin,'workKind',r.work_kind,'suppressed',r.suppressed,
  'changes',r.changes,'restoration',CASE WHEN r.restoration IS NULL THEN NULL ELSE jsonb_build_object(
    'sourceDate',left(r.restoration->'source'->>'advertisedAtLocal',10),'restoredAt',r.restoration->>'checkedAt') END,
  'mode',r.mode,'source',r.source,'archiveSha256',coalesce(r.observed_sha256,a.archive_sha256),
  'generationId',coalesce((r.success_publication->>'generationId')::bigint,p.generation_id,a.generation_id),
  'step',r.step,'result',r.result,'reason',r.reason,'costUsd',
   CASE WHEN a.first_reservation_at IS NOT NULL AND clock_timestamp() >= a.first_reservation_at+interval '2136 hours'
    THEN coalesce((SELECT rr.reported_cost_usd FROM import_runs rr WHERE rr.artifact_id=a.id ORDER BY rr.checked_at DESC LIMIT 1),0)
    ELSE coalesce((SELECT sum(CASE WHEN status='open' THEN usd ELSE charged_usd END) FROM reservations WHERE import_artifact_id=a.id),0) END
 ) FROM import_runs r LEFT JOIN import_artifacts a ON a.id=r.artifact_id
 LEFT JOIN import_processing p ON p.artifact_id=a.id AND p.active WHERE r.id=p_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_status_rows() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(v.value ORDER BY v.checked_at DESC),'[]'::jsonb) FROM (
  SELECT r.checked_at,jsonb_build_object('public',import_public_run(r.id),'sourceCheckSucceeded',r.source_check_succeeded,
    'canaryPassed',r.canary_passed,'goodCheck',r.good_check,'recertification',r.work_kind='recertification') value
  FROM import_runs r ORDER BY r.checked_at DESC LIMIT 200
 ) v
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION import_status_health() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH latest AS (SELECT * FROM import_issues WHERE resolved_at IS NULL ORDER BY fixed DESC,last_at DESC LIMIT 1),
 serving AS (SELECT m.generation_id,m.published_at,
   CASE WHEN (c.accepted->'manifest'->>'generationId')::bigint=m.generation_id
     AND c.accepted->'manifest'->>'casesIndex'=m.cases_index AND c.accepted->'manifest'->>'passagesIndex'=m.passages_index
     AND (c.accepted->'manifest'->>'publishedAt')::timestamptz=m.published_at
    THEN left(c.accepted->'observation'->>'advertisedAtLocal',10) ELSE NULL END source_date,
   (SELECT r.restoration->>'checkedAt' FROM import_runs r WHERE (r.restoration->'publication'->>'publishedAt')::timestamptz=m.published_at
      AND (r.restoration->'publication'->>'generationId')::bigint=m.generation_id ORDER BY r.checked_at DESC LIMIT 1) restored_at
  FROM dataset_manifests m CROSS JOIN import_control c WHERE m.active AND c.id=1)
 SELECT jsonb_build_object(
   'automaticSince',import_status_time(c.automatic_since),
   'restoreHeld',c.restore_required OR coalesce((SELECT held_at IS NOT NULL FROM paid_operations_hold WHERE id=1),true),
   'switchHeld',c.switch_hold IS NOT NULL OR EXISTS(SELECT 1 FROM import_index_refs r JOIN index_switch_attempts a ON a.index_name=r.index_name
      WHERE r.released_at IS NULL AND a.outcome IN ('pending','unknown')),
   'temporaryDays',least(7,(SELECT count(distinct failure_day)::int FROM import_issues WHERE resolved_at IS NULL AND NOT fixed)),
   'lastGood',(SELECT import_public_run(id) FROM import_runs WHERE good_check ORDER BY checked_at DESC LIMIT 1),
   'serving',(SELECT jsonb_build_object('generationId',generation_id,'sourceDate',source_date,'importedAt',import_status_time(published_at),'restoredAt',restored_at) FROM serving),
   'waiting',CASE WHEN c.pending IS NULL THEN NULL ELSE jsonb_build_object('source',c.pending->'observation','since',c.pending->>'fetchedAt') END,
   'issue',(SELECT jsonb_build_object('reason',reason,'fixed',fixed,'since',import_status_time(created_at),'origin',origin,'originRunId',origin_run_id,
      'siteState',site_state,'postSuccess',post_success,'details',CASE WHEN run_id IS NULL THEN NULL ELSE import_public_run(run_id)||jsonb_build_object(
        'code',code,'image',image,'origin',origin,'source',source,'reason',reason,'step',step) END) FROM latest)
 ) FROM import_control c WHERE c.id=1
$$;
--> statement-breakpoint
-- Compatibility reader, with no historical review logic. No worker uses it for admission.
CREATE OR REPLACE FUNCTION import_status_attention() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT restore_required OR switch_hold IS NOT NULL FROM import_control WHERE id=1),true)
   OR EXISTS(SELECT 1 FROM import_issues WHERE resolved_at IS NULL AND fixed)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_status_time(timestamptz),import_public_run(uuid),import_status_health() FROM PUBLIC,aviation_app,aviation_ingest;
GRANT EXECUTE ON FUNCTION import_status_health() TO aviation_app,aviation_ingest;
