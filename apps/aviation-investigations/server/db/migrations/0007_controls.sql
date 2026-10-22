CREATE TABLE "abuse_records" (
	"identity_hash" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "abuse_records_hash_check" CHECK ("abuse_records"."identity_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "abuse_records_seen_check" CHECK ("abuse_records"."last_seen_at" >= "abuse_records"."first_seen_at" and "abuse_records"."retain_until" > "abuse_records"."last_seen_at")
);
--> statement-breakpoint
CREATE TABLE "ai_switch" (
	"id" smallint PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_switch_single_row_check" CHECK ("ai_switch"."id" = 1),
	CONSTRAINT "ai_switch_note_check" CHECK ("ai_switch"."note" is null or length("ai_switch"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cost_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"reservation_id" bigint NOT NULL,
	"category" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_hash" text,
	"provider" text,
	"model" text,
	"stage" text NOT NULL,
	"usd" numeric(12, 6) NOT NULL,
	"tokens" jsonb,
	"uncertain" boolean NOT NULL,
	"request_id" text,
	"accounting_day" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cost_ledger_category_check" CHECK ("cost_ledger"."category" in ('interactive', 'indexing', 'evaluation')),
	CONSTRAINT "cost_ledger_principal_kind_check" CHECK ("cost_ledger"."principal_kind" in ('trial', 'account', 'system')),
	CONSTRAINT "cost_ledger_principal_check" CHECK (("cost_ledger"."principal_kind" = 'system') = ("cost_ledger"."principal_hash" is null)
        and ("cost_ledger"."principal_hash" is null or "cost_ledger"."principal_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "cost_ledger_usd_check" CHECK ("cost_ledger"."usd" >= 0),
	CONSTRAINT "cost_ledger_tokens_check" CHECK ("cost_ledger"."tokens" is null or jsonb_typeof("cost_ledger"."tokens") = 'object'),
	CONSTRAINT "cost_ledger_labels_check" CHECK ("cost_ledger"."stage" ~ '^[a-z][a-z0-9_]{0,39}$'
        and coalesce(length("cost_ledger"."provider"), 0) <= 100 and coalesce(length("cost_ledger"."model"), 0) <= 100
        and coalesce(length("cost_ledger"."request_id"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "idempotency" (
	"principal_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reservation_id" bigint NOT NULL,
	"result_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_pk" PRIMARY KEY("principal_hash","idempotency_key"),
	CONSTRAINT "idempotency_values_check" CHECK ("idempotency"."principal_hash" ~ '^[0-9a-f]{64}$' and "idempotency"."request_hash" ~ '^[0-9a-f]{64}$'
        and "idempotency"."idempotency_key" ~ '^[A-Za-z0-9_-]{8,128}$'
        and coalesce(length("idempotency"."result_ref"), 0) <= 200 and "idempotency"."expires_at" > "idempotency"."created_at")
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"reservation_id" bigint PRIMARY KEY NOT NULL,
	"principal_hash" text NOT NULL,
	"anonymous" boolean NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "leases_hash_check" CHECK ("leases"."principal_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "leases_expiry_check" CHECK ("leases"."expires_at" > "leases"."acquired_at")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reservations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_hash" text,
	"usd" numeric(12, 6) NOT NULL,
	"status" text NOT NULL,
	"fencing_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"accounting_day" date NOT NULL,
	"quota_counted" boolean DEFAULT false NOT NULL,
	"provider" text,
	"model" text,
	"stage" text,
	"request_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"charged_usd" numeric(12, 6),
	"uncertain" boolean,
	CONSTRAINT "reservations_fencing_token_unique" UNIQUE("fencing_token"),
	CONSTRAINT "reservations_category_check" CHECK ("reservations"."category" in ('interactive', 'indexing', 'evaluation')),
	CONSTRAINT "reservations_principal_kind_check" CHECK ("reservations"."principal_kind" in ('trial', 'account', 'system')),
	CONSTRAINT "reservations_principal_check" CHECK (("reservations"."principal_kind" = 'system') = ("reservations"."principal_hash" is null)
        and ("reservations"."category" = 'interactive') = ("reservations"."principal_kind" <> 'system')
        and ("reservations"."principal_hash" is null or "reservations"."principal_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "reservations_usd_check" CHECK ("reservations"."usd" > 0),
	CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" in ('open', 'settled', 'expired_charged')),
	CONSTRAINT "reservations_settlement_check" CHECK (("reservations"."status" = 'open') = ("reservations"."settled_at" is null)
        and ("reservations"."status" = 'open') = ("reservations"."charged_usd" is null)
        and ("reservations"."status" = 'open') = ("reservations"."uncertain" is null)
        and ("reservations"."charged_usd" is null or "reservations"."charged_usd" >= 0)
        and ("reservations"."status" <> 'expired_charged' or ("reservations"."charged_usd" >= "reservations"."usd" and "reservations"."uncertain"))),
	CONSTRAINT "reservations_quota_check" CHECK (not "reservations"."quota_counted" or "reservations"."category" = 'interactive'),
	CONSTRAINT "reservations_lease_check" CHECK ("reservations"."lease_expires_at" > "reservations"."created_at"),
	CONSTRAINT "reservations_labels_check" CHECK (coalesce(length("reservations"."provider"), 0) <= 100 and coalesce(length("reservations"."model"), 0) <= 100
        and coalesce(length("reservations"."stage"), 0) <= 40 and coalesce(length("reservations"."request_id"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "trial_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trial_identities_used_check" CHECK ("trial_identities"."requests_used" >= 0),
	CONSTRAINT "trial_identities_expiry_check" CHECK ("trial_identities"."expires_at" > "trial_identities"."created_at")
);
--> statement-breakpoint
CREATE TABLE "usage_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"subject" text NOT NULL,
	"period" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_buckets_scope_check" CHECK ("usage_buckets"."scope" in ('principal', 'network', 'global')),
	CONSTRAINT "usage_buckets_period_check" CHECK ("usage_buckets"."period" in ('minute', 'hour', 'day', 'month')),
	CONSTRAINT "usage_buckets_counts_check" CHECK ("usage_buckets"."attempts" >= 0 and "usage_buckets"."requests" >= 0),
	CONSTRAINT "usage_buckets_subject_check" CHECK (length("usage_buckets"."subject") between 1 and 200),
	CONSTRAINT "usage_buckets_key_check" CHECK (length("usage_buckets"."bucket_key") <= 300 and "usage_buckets"."expires_at" > "usage_buckets"."period_start")
);
--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency" ADD CONSTRAINT "idempotency_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_records_retain_idx" ON "abuse_records" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "cost_ledger_day_idx" ON "cost_ledger" USING btree ("accounting_day","category");--> statement-breakpoint
CREATE INDEX "cost_ledger_reservation_idx" ON "cost_ledger" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_created_idx" ON "cost_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "leases_in_flight_idx" ON "leases" USING btree ("expires_at") WHERE "leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "reservations_open_idx" ON "reservations" USING btree ("lease_expires_at") WHERE "reservations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reservations_day_idx" ON "reservations" USING btree ("accounting_day","category");--> statement-breakpoint
CREATE INDEX "reservations_principal_idx" ON "reservations" USING btree ("principal_hash","accounting_day");--> statement-breakpoint
CREATE INDEX "trial_identities_expires_idx" ON "trial_identities" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "usage_buckets_expires_idx" ON "usage_buckets" USING btree ("expires_at");