CREATE TABLE "generation_pins" (
	"generation_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"pinned_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_pins_pk" PRIMARY KEY("generation_id","reason"),
	CONSTRAINT "generation_pins_reason_check" CHECK ("generation_pins"."reason" ~ '\S' and length("generation_pins"."reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "case_section_sources" DROP CONSTRAINT "case_section_sources_case_check";--> statement-breakpoint
ALTER TABLE "cases" DROP CONSTRAINT "cases_location_check";--> statement-breakpoint
ALTER TABLE "dataset_generations" DROP CONSTRAINT "dataset_generations_status_check";--> statement-breakpoint
ALTER TABLE "case_section_sources" DROP CONSTRAINT "case_section_sources_section_fk";
--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD COLUMN "verification_status" text;--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD COLUMN "verifier_version" text;--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD COLUMN "verification_report_sha256" text;--> statement-breakpoint
ALTER TABLE "generation_pins" ADD CONSTRAINT "generation_pins_generation_id_dataset_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."dataset_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sections" ADD CONSTRAINT "case_sections_case_unique" UNIQUE("generation_id","section_id","ntsb_no");--> statement-breakpoint
ALTER TABLE "case_section_sources" ADD CONSTRAINT "case_section_sources_section_fk" FOREIGN KEY ("generation_id","section_id","ntsb_no") REFERENCES "public"."case_sections"("generation_id","section_id","ntsb_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sections" ADD CONSTRAINT "case_sections_key_scope_check" CHECK (("case_sections"."scope" = 'aircraft' and "case_sections"."section_key" = "case_sections"."kind" || '/aircraft-' || "case_sections"."aircraft_key")
        or ("case_sections"."scope" = 'event' and "case_sections"."section_key" ~ ('^' || "case_sections"."kind" || '/event-[1-9][0-9]*$')));--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_location_check" CHECK (("cases"."latitude" is null) = ("cases"."longitude" is null)
        and ("cases"."latitude" is null or "cases"."latitude" between -90 and 90)
        and ("cases"."longitude" is null or "cases"."longitude" between -180 and 180));--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD CONSTRAINT "dataset_generations_sealed_check" CHECK (("dataset_generations"."status" = 'loading') = ("dataset_generations"."sealed_at" is null));--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD CONSTRAINT "dataset_generations_verification_check" CHECK (("dataset_generations"."verification_status" is null) = ("dataset_generations"."verified_at" is null)
        and ("dataset_generations"."verification_status" is null) = ("dataset_generations"."verifier_version" is null)
        and ("dataset_generations"."verification_status" is null) = ("dataset_generations"."verification_report_sha256" is null)
        and ("dataset_generations"."verification_status" is null or "dataset_generations"."verification_status" in ('ok', 'failed'))
        and ("dataset_generations"."verification_report_sha256" is null or "dataset_generations"."verification_report_sha256" ~ '^[0-9a-f]{64}$')
        and ("dataset_generations"."status" <> 'verified' or "dataset_generations"."verification_status" = 'ok')
        and ("dataset_generations"."status" <> 'failed' or "dataset_generations"."verification_status" = 'failed')
        and ("dataset_generations"."status" not in ('loading', 'loaded') or "dataset_generations"."verification_status" is null));--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD CONSTRAINT "dataset_generations_status_check" CHECK ("dataset_generations"."status" in ('loading', 'loaded', 'verified', 'failed', 'published', 'retired'));