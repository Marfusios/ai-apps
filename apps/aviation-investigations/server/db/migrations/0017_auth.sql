CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_accounts_provider_account_key" UNIQUE("provider_id","account_id"),
	CONSTRAINT "auth_accounts_user_provider_key" UNIQUE("user_id","provider_id"),
	CONSTRAINT "auth_accounts_values_check" CHECK ("auth_accounts"."provider_id" = 'google' and "auth_accounts"."account_id" ~ '^[!-~]{1,255}$'
        and "auth_accounts"."access_token" is null and "auth_accounts"."refresh_token" is null and "auth_accounts"."id_token" is null
        and "auth_accounts"."access_token_expires_at" is null and "auth_accounts"."refresh_token_expires_at" is null
        and "auth_accounts"."scope" is null and "auth_accounts"."password" is null)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "auth_sessions_token_key" UNIQUE("token"),
	CONSTRAINT "auth_sessions_values_check" CHECK ("auth_sessions"."ip_address" is null and "auth_sessions"."user_agent" is null and length("auth_sessions"."token") between 16 and 255 and "auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_users_email_key" UNIQUE("email"),
	CONSTRAINT "auth_users_values_check" CHECK ("auth_users"."email_verified" and "auth_users"."image" is null and length("auth_users"."name") <= 200 and length("auth_users"."email") between 3 and 320)
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_verifications_values_check" CHECK (length("auth_verifications"."identifier") <= 200 and length("auth_verifications"."value") <= 8192)
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "auth_verifications_expires_idx" ON "auth_verifications" USING btree ("expires_at");--> statement-breakpoint
-- Hand-written below (Task 20): grants and account deletion for Google sign-in.
--
-- aviation_app runs Better Auth (server/auth/better-auth.ts) and the account routes. It
-- creates users, Google account links, sessions and OAuth state; deletes sessions
-- (sign-out, expiry), OAuth state (consumed or expired) and users (account deletion,
-- whose sessions and account links go with them by ON DELETE CASCADE). It updates
-- nothing: sessions have a fixed lifetime (no refresh), provider data is never rewritten
-- on sign-in and nothing changes a user. It cannot delete an account link on its own,
-- truncate, reference or add triggers. aviation_ingest gets no access (default
-- privileges grant it SELECT on new tables).
GRANT SELECT, INSERT, DELETE ON TABLE "auth_users", "auth_sessions", "auth_verifications" TO aviation_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "auth_accounts" TO aviation_app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "auth_users", "auth_sessions", "auth_accounts", "auth_verifications" FROM aviation_app;
--> statement-breakpoint
REVOKE DELETE ON TABLE "auth_accounts" FROM aviation_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "auth_users", "auth_sessions", "auth_accounts", "auth_verifications" FROM aviation_ingest;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "auth_users", "auth_sessions", "auth_accounts", "auth_verifications" FROM aviation_app, aviation_ingest';
  END IF;
END $$;
--> statement-breakpoint
-- Account deletion (DESIGN §7: "Account deletion ends sessions and removes saved
-- content"): the briefs an account reads, with all their steps (the question, answers,
-- evidence and diagnostics, including steps billed to the trial that signed in), and the
-- account's idempotency records (hashes of its requests). Called by aviation_app in the
-- same transaction that deletes the user (server/auth/deletion.ts). Charges, reservations,
-- usage buckets and the anti-abuse record are kept: they hold HMACs and amounts, no
-- content. The brief guards allow these deletes only under the retention flag, which this
-- function sets for its own statements.
CREATE FUNCTION delete_account_content(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_steps integer;
  n_briefs integer;
  n_idempotency integer;
BEGIN
  IF p_owner IS NULL OR p_owner !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid account' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('aviation.pruning_controls', 'on', true);
  DELETE FROM brief_steps s USING briefs b
    WHERE s.brief_id = b.id AND b.read_owner = p_owner AND b.read_owner_kind = 'account';
  GET DIAGNOSTICS n_steps = ROW_COUNT;
  DELETE FROM briefs WHERE read_owner = p_owner AND read_owner_kind = 'account';
  GET DIAGNOSTICS n_briefs = ROW_COUNT;
  PERFORM set_config('aviation.pruning_controls', '', true);
  DELETE FROM idempotency WHERE principal_hash = p_owner;
  GET DIAGNOSTICS n_idempotency = ROW_COUNT;
  RETURN jsonb_build_object('briefs', n_briefs, 'briefSteps', n_steps, 'idempotency', n_idempotency);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_account_content(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_account_content(text) TO aviation_app;
