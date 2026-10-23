CREATE TABLE "auth_deletion_confirmations" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_deletion_confirmations_expiry_check" CHECK ("auth_deletion_confirmations"."expires_at" > "auth_deletion_confirmations"."created_at" and "auth_deletion_confirmations"."expires_at" <= "auth_deletion_confirmations"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE "auth_state_uses" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_state_uses_values_check" CHECK ("auth_state_uses"."state_hash" ~ '^[0-9a-f]{64}$' and "auth_state_uses"."expires_at" > "auth_state_uses"."used_at")
);
--> statement-breakpoint
ALTER TABLE "ai_switch" ADD COLUMN "account_check" text DEFAULT 'suspicious' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_deletion_confirmations" ADD CONSTRAINT "auth_deletion_confirmations_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_deletion_confirmations" ADD CONSTRAINT "auth_deletion_confirmations_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_deletion_confirmations_user_idx" ON "auth_deletion_confirmations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_deletion_confirmations_expires_idx" ON "auth_deletion_confirmations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_state_uses_expires_idx" ON "auth_state_uses" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "ai_switch" ADD CONSTRAINT "ai_switch_account_check_check" CHECK ("ai_switch"."account_check" in ('suspicious', 'always'));--> statement-breakpoint
-- Hand-written below (Task 20, review fixes): grants for the two new sign-in tables, the
-- operator's switch for signed-in Turnstile checks, the brief lock, and account deletion
-- that locks before it deletes.
--
-- aviation_app records each OAuth state a callback brings back (auth_state_uses) and the
-- confirmations of a recent sign-in before deleting an account
-- (auth_deletion_confirmations); it deletes them when they are used or expire. It updates
-- neither. aviation_ingest gets no access (default privileges grant it SELECT).
GRANT SELECT, INSERT, DELETE ON TABLE "auth_state_uses", "auth_deletion_confirmations" TO aviation_app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "auth_state_uses", "auth_deletion_confirmations" FROM aviation_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "auth_state_uses", "auth_deletion_confirmations" FROM aviation_ingest;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "auth_state_uses", "auth_deletion_confirmations" FROM aviation_app, aviation_ingest';
  END IF;
END $$;
--> statement-breakpoint
-- Operators set when signed-in AI requests take a Turnstile check with
-- `pnpm worker ai-switch --account-check` (aviation_ingest), like the other switches.
GRANT UPDATE ("account_check") ON TABLE "ai_switch" TO aviation_ingest;
--> statement-breakpoint
-- A change to a brief (a refinement's new step, a cancel) locks the brief and reads its
-- read owner in the same statement, then checks that owner before it writes anything. The
-- handover's compare-and-set (move_brief_read_owner, an UPDATE of the same row) and account
-- deletion (which locks the account's briefs first) wait for it, and it for them, so an
-- owner checked here cannot change before the transaction ends. aviation_app cannot update
-- briefs, which SELECT ... FOR NO KEY UPDATE would need, hence this function. It locks the
-- row whatever its expiry; the caller checks the expiry with the application's clock.
CREATE FUNCTION lock_brief(p_brief uuid) RETURNS TABLE (read_owner text, read_owner_kind text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.read_owner, b.read_owner_kind, b.expires_at FROM briefs b WHERE b.id = p_brief FOR NO KEY UPDATE OF b
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_brief(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lock_brief(uuid) TO aviation_app;
--> statement-breakpoint
-- Same as migration 0017, except that the account's briefs are locked first, in id order,
-- before their steps are deleted (the order lock_brief callers use: brief, then steps), and
-- that the ids of the steps still running are returned so the caller can stop them.
-- CREATE OR REPLACE keeps the owner, SECURITY DEFINER (restated) and the EXECUTE grant.
CREATE OR REPLACE FUNCTION delete_account_content(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_steps integer;
  n_briefs integer;
  n_idempotency integer;
  running jsonb;
BEGIN
  IF p_owner IS NULL OR p_owner !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid account' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM briefs WHERE read_owner = p_owner AND read_owner_kind = 'account' ORDER BY id FOR UPDATE;
  PERFORM set_config('aviation.pruning_controls', 'on', true);
  WITH gone AS (
    DELETE FROM brief_steps s USING briefs b
      WHERE s.brief_id = b.id AND b.read_owner = p_owner AND b.read_owner_kind = 'account'
      RETURNING s.id, s.status
  )
  SELECT count(*)::integer, coalesce(jsonb_agg(gone.id::text) FILTER (WHERE gone.status = 'running'), '[]'::jsonb)
    INTO n_steps, running FROM gone;
  DELETE FROM briefs WHERE read_owner = p_owner AND read_owner_kind = 'account';
  GET DIAGNOSTICS n_briefs = ROW_COUNT;
  PERFORM set_config('aviation.pruning_controls', '', true);
  DELETE FROM idempotency WHERE principal_hash = p_owner;
  GET DIAGNOSTICS n_idempotency = ROW_COUNT;
  RETURN jsonb_build_object('briefs', n_briefs, 'briefSteps', n_steps, 'idempotency', n_idempotency, 'running', running);
END $$;
