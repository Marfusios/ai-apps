CREATE TABLE "case_aircraft" (
	"generation_id" bigint NOT NULL,
	"ntsb_no" text NOT NULL,
	"aircraft_key" integer NOT NULL,
	"aircraft_ntsb_no" text,
	"regis_no" text,
	"make" text,
	"model" text,
	"series" text,
	"category" text,
	"far_part" text,
	"purpose" text,
	"damage" text,
	"homebuilt" boolean,
	"num_engines" integer,
	"date_last_insp" date,
	"afm_hrs" double precision,
	"afm_hrs_last_insp" double precision,
	"afm_hrs_since" boolean,
	"acft_year" integer,
	"last_changed_at" timestamp,
	"defining_occurrence_no" integer,
	"defining_phase_group" text,
	"defining_event_conflict" boolean NOT NULL,
	"sequence_phase_groups" text[] NOT NULL,
	CONSTRAINT "case_aircraft_pk" PRIMARY KEY("generation_id","ntsb_no","aircraft_key"),
	CONSTRAINT "case_aircraft_key_check" CHECK ("case_aircraft"."aircraft_key" >= 0),
	CONSTRAINT "case_aircraft_defining_check" CHECK (("case_aircraft"."defining_occurrence_no" is null) = ("case_aircraft"."defining_phase_group" is null) and not ("case_aircraft"."defining_event_conflict" and "case_aircraft"."defining_occurrence_no" is not null))
);
--> statement-breakpoint
CREATE TABLE "case_engines" (
	"generation_id" bigint NOT NULL,
	"ntsb_no" text NOT NULL,
	"aircraft_key" integer NOT NULL,
	"eng_no" integer NOT NULL,
	"eng_type" text,
	"carb_fuel_injection" text,
	"last_changed_at" timestamp,
	CONSTRAINT "case_engines_pk" PRIMARY KEY("generation_id","ntsb_no","aircraft_key","eng_no")
);
--> statement-breakpoint
CREATE TABLE "case_findings" (
	"generation_id" bigint NOT NULL,
	"ntsb_no" text NOT NULL,
	"aircraft_key" integer NOT NULL,
	"finding_no" integer NOT NULL,
	"code" text,
	"description" text,
	"in_probable_cause" boolean,
	"cause_factor" text,
	"category_no" text,
	"subcategory_no" text,
	"section_no" text,
	"subsection_no" text,
	"modifier_no" text,
	"last_changed_at" timestamp,
	CONSTRAINT "case_findings_pk" PRIMARY KEY("generation_id","ntsb_no","aircraft_key","finding_no")
);
--> statement-breakpoint
CREATE TABLE "case_section_sources" (
	"generation_id" bigint NOT NULL,
	"section_id" text NOT NULL,
	"ntsb_no" text NOT NULL,
	"source_aircraft_key" integer NOT NULL,
	"source_sha256" text NOT NULL,
	"match" text NOT NULL,
	"transformed_from_html" boolean NOT NULL,
	"source_form" text NOT NULL,
	"source_text" text,
	"last_changed_at" timestamp,
	CONSTRAINT "case_section_sources_pk" PRIMARY KEY("generation_id","section_id","source_aircraft_key"),
	CONSTRAINT "case_section_sources_case_check" CHECK (left("case_section_sources"."section_id", length("case_section_sources"."ntsb_no") + 1) = "case_section_sources"."ntsb_no" || ':'),
	CONSTRAINT "case_section_sources_match_check" CHECK ("case_section_sources"."match" in ('exact', 'whitespace')),
	CONSTRAINT "case_section_sources_form_check" CHECK ("case_section_sources"."source_form" in ('canonical', 'canonical_crlf', 'stored') and ("case_section_sources"."source_form" = 'stored') = ("case_section_sources"."source_text" is not null)),
	CONSTRAINT "case_section_sources_sha_check" CHECK ("case_section_sources"."source_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "case_sections" (
	"generation_id" bigint NOT NULL,
	"section_id" text NOT NULL,
	"ntsb_no" text NOT NULL,
	"section_key" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"aircraft_key" integer,
	"text" text NOT NULL,
	"sha256" text NOT NULL,
	"citation_text_version" text NOT NULL,
	"transformed_from_html" boolean NOT NULL,
	"source_aircraft_keys" integer[] NOT NULL,
	"revision_id" text NOT NULL,
	"last_changed_at" timestamp,
	CONSTRAINT "case_sections_pk" PRIMARY KEY("generation_id","section_id"),
	CONSTRAINT "case_sections_revision_unique" UNIQUE("revision_id","generation_id"),
	CONSTRAINT "case_sections_id_check" CHECK ("case_sections"."section_id" = "case_sections"."ntsb_no" || ':' || "case_sections"."section_key"),
	CONSTRAINT "case_sections_key_check" CHECK ("case_sections"."section_key" ~ '^(factual|analysis|probable_cause)/(aircraft|event)-[0-9]+$' and split_part("case_sections"."section_key", '/', 1) = "case_sections"."kind"),
	CONSTRAINT "case_sections_kind_check" CHECK ("case_sections"."kind" in ('factual', 'analysis', 'probable_cause')),
	CONSTRAINT "case_sections_scope_check" CHECK (("case_sections"."scope" = 'aircraft' and "case_sections"."aircraft_key" is not null and "case_sections"."source_aircraft_keys" = array["case_sections"."aircraft_key"]) or ("case_sections"."scope" = 'event' and "case_sections"."aircraft_key" is null and cardinality("case_sections"."source_aircraft_keys") >= 1)),
	CONSTRAINT "case_sections_text_check" CHECK ("case_sections"."text" ~ '\S'),
	CONSTRAINT "case_sections_sha_check" CHECK ("case_sections"."sha256" ~ '^[0-9a-f]{64}$' and "case_sections"."revision_id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "case_sequence" (
	"generation_id" bigint NOT NULL,
	"ntsb_no" text NOT NULL,
	"aircraft_key" integer NOT NULL,
	"occurrence_no" integer NOT NULL,
	"phase_no" integer,
	"phase_group" text NOT NULL,
	"event_code" text,
	"occurrence_code" text,
	"description" text,
	"is_defining" boolean,
	"last_changed_at" timestamp,
	CONSTRAINT "case_sequence_pk" PRIMARY KEY("generation_id","ntsb_no","aircraft_key","occurrence_no")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"generation_id" bigint NOT NULL,
	"ntsb_no" text NOT NULL,
	"ev_id" text NOT NULL,
	"country" text,
	"is_us" boolean NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"ev_type" text,
	"ev_date" date,
	"ev_dow" text,
	"ev_time" integer,
	"ev_tmzn" text,
	"city" text,
	"state" text,
	"ev_year" integer,
	"ev_month" integer,
	"light_cond" text,
	"sky_cond_nonceil" text,
	"sky_nonceil_ht" double precision,
	"sky_ceil_ht" double precision,
	"sky_cond_ceil" text,
	"vis_sm" double precision,
	"wx_temp" double precision,
	"wx_dew_pt" double precision,
	"wind_dir_deg" double precision,
	"wind_dir_ind" text,
	"wind_vel_kts" double precision,
	"wind_vel_ind" text,
	"gust_ind" text,
	"gust_kts" double precision,
	"altimeter" double precision,
	"wx_dens_alt" double precision,
	"wx_int_precip" text,
	"wx_cond_basic" text,
	"metar" text,
	"highest_injury" text,
	"inj_f_grnd" integer,
	"inj_m_grnd" integer,
	"inj_s_grnd" integer,
	"inj_tot_f" integer,
	"inj_tot_m" integer,
	"inj_tot_n" integer,
	"inj_tot_s" integer,
	"inj_tot_t" integer,
	"last_changed_at" timestamp,
	"raw_status" text,
	"approval_date" date,
	"admin_last_changed_at" timestamp,
	"completion_class" text NOT NULL,
	"completion_mapping_version" text NOT NULL,
	"has_probable_cause" boolean NOT NULL,
	"completed_with_cause" boolean NOT NULL,
	"answer_eligible" boolean NOT NULL,
	"defining_phase_groups" text[] NOT NULL,
	"sequence_phase_groups" text[] NOT NULL,
	"source_revision" text NOT NULL,
	CONSTRAINT "cases_pk" PRIMARY KEY("generation_id","ntsb_no"),
	CONSTRAINT "cases_ev_id_unique" UNIQUE("ev_id","generation_id"),
	CONSTRAINT "cases_ntsb_no_check" CHECK ("cases"."ntsb_no" <> '' and "cases"."ntsb_no" !~ '^\s|\s$'),
	CONSTRAINT "cases_ev_id_check" CHECK ("cases"."ev_id" <> '' and "cases"."ev_id" !~ '^\s|\s$'),
	CONSTRAINT "cases_is_us_check" CHECK ("cases"."is_us" = coalesce("cases"."country" = 'USA', false)),
	CONSTRAINT "cases_location_check" CHECK (("cases"."latitude" is null) = ("cases"."longitude" is null)),
	CONSTRAINT "cases_completion_class_check" CHECK ("cases"."completion_class" in ('completed', 'in_progress', 'status_unknown', 'other_status')),
	CONSTRAINT "cases_completed_with_cause_check" CHECK ("cases"."completed_with_cause" = ("cases"."completion_class" = 'completed' and "cases"."has_probable_cause")),
	CONSTRAINT "cases_answer_eligible_check" CHECK ("cases"."answer_eligible" = ("cases"."is_us" and "cases"."completed_with_cause")),
	CONSTRAINT "cases_source_revision_check" CHECK ("cases"."source_revision" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "code_dictionary" (
	"generation_id" bigint NOT NULL,
	"entry_no" integer NOT NULL,
	"source" text NOT NULL,
	"table_name" text,
	"column_name" text,
	"code" text NOT NULL,
	"meaning" text,
	CONSTRAINT "code_dictionary_pk" PRIMARY KEY("generation_id","entry_no"),
	CONSTRAINT "code_dictionary_source_check" CHECK ("code_dictionary"."source" in ('eadmspub_datadictionary', 'ct_seqevt'))
);
--> statement-breakpoint
CREATE TABLE "dataset_generations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dataset_generations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ingestion_run_id" bigint NOT NULL,
	"archive_sha256" text NOT NULL,
	"extract_manifest" jsonb NOT NULL,
	"mapping_version" text NOT NULL,
	"mapping_verified" boolean NOT NULL,
	"citation_text_version" text NOT NULL,
	"field_normalization_version" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"stats" jsonb NOT NULL,
	CONSTRAINT "dataset_generations_run_unique" UNIQUE("ingestion_run_id"),
	CONSTRAINT "dataset_generations_status_check" CHECK ("dataset_generations"."status" in ('loading', 'verified', 'failed', 'published', 'retired')),
	CONSTRAINT "dataset_generations_archive_check" CHECK ("dataset_generations"."archive_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "dataset_manifests" (
	"generation_id" bigint PRIMARY KEY NOT NULL,
	"cases_index" text NOT NULL,
	"passages_index" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dataset_manifests_active_published_check" CHECK (not "dataset_manifests"."active" or "dataset_manifests"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingestion_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"archive_sha256" text,
	"mapping_version" text NOT NULL,
	"text_normalization_version" text NOT NULL,
	"field_normalization_version" text NOT NULL,
	"counts" jsonb,
	"error" text,
	CONSTRAINT "ingestion_runs_status_check" CHECK ("ingestion_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "ingestion_runs_finished_check" CHECK (("ingestion_runs"."status" = 'running') = ("ingestion_runs"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "quarantine" (
	"generation_id" bigint NOT NULL,
	"entry_no" integer NOT NULL,
	"run_id" bigint NOT NULL,
	"table_name" text NOT NULL,
	"key" text NOT NULL,
	"column_name" text,
	"reason" text NOT NULL,
	"action" text NOT NULL,
	"value" text,
	"detail" text NOT NULL,
	CONSTRAINT "quarantine_pk" PRIMARY KEY("generation_id","entry_no"),
	CONSTRAINT "quarantine_action_check" CHECK ("quarantine"."action" in ('row_excluded', 'value_nulled', 'value_kept'))
);
--> statement-breakpoint
ALTER TABLE "case_aircraft" ADD CONSTRAINT "case_aircraft_case_fk" FOREIGN KEY ("generation_id","ntsb_no") REFERENCES "public"."cases"("generation_id","ntsb_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_engines" ADD CONSTRAINT "case_engines_aircraft_fk" FOREIGN KEY ("generation_id","ntsb_no","aircraft_key") REFERENCES "public"."case_aircraft"("generation_id","ntsb_no","aircraft_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_findings" ADD CONSTRAINT "case_findings_aircraft_fk" FOREIGN KEY ("generation_id","ntsb_no","aircraft_key") REFERENCES "public"."case_aircraft"("generation_id","ntsb_no","aircraft_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_section_sources" ADD CONSTRAINT "case_section_sources_section_fk" FOREIGN KEY ("generation_id","section_id") REFERENCES "public"."case_sections"("generation_id","section_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_section_sources" ADD CONSTRAINT "case_section_sources_aircraft_fk" FOREIGN KEY ("generation_id","ntsb_no","source_aircraft_key") REFERENCES "public"."case_aircraft"("generation_id","ntsb_no","aircraft_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sections" ADD CONSTRAINT "case_sections_case_fk" FOREIGN KEY ("generation_id","ntsb_no") REFERENCES "public"."cases"("generation_id","ntsb_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sections" ADD CONSTRAINT "case_sections_aircraft_fk" FOREIGN KEY ("generation_id","ntsb_no","aircraft_key") REFERENCES "public"."case_aircraft"("generation_id","ntsb_no","aircraft_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sequence" ADD CONSTRAINT "case_sequence_aircraft_fk" FOREIGN KEY ("generation_id","ntsb_no","aircraft_key") REFERENCES "public"."case_aircraft"("generation_id","ntsb_no","aircraft_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_generation_id_dataset_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."dataset_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_dictionary" ADD CONSTRAINT "code_dictionary_generation_id_dataset_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."dataset_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_generations" ADD CONSTRAINT "dataset_generations_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_manifests" ADD CONSTRAINT "dataset_manifests_generation_id_dataset_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."dataset_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_generation_id_dataset_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."dataset_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_section_sources_aircraft_idx" ON "case_section_sources" USING btree ("ntsb_no","source_aircraft_key","generation_id");--> statement-breakpoint
CREATE INDEX "case_sections_case_idx" ON "case_sections" USING btree ("ntsb_no","aircraft_key","generation_id");--> statement-breakpoint
CREATE INDEX "code_dictionary_lookup_idx" ON "code_dictionary" USING btree ("table_name","column_name","code","generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_manifests_single_active" ON "dataset_manifests" USING btree ("active") WHERE active;